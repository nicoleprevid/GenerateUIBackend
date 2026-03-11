import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { getAuthenticatedUserId } from '../lib/auth';
import { entitlementsFromSubscriptionStatus } from '../billing/entitlements';
import { createCheckoutSessionForUser } from '../billing/stripeCheckout';

type CheckoutRequest = {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
};

type CancelSubscriptionRequest = {
  immediately?: boolean;
};

type CustomerPortalRequest = {
  returnUrl?: string;
};

type StripeEvent = {
  id?: string;
  type?: string;
  created?: number;
  data?: {
    object?: Record<string, unknown>;
  };
};

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PORTAL_RETURN_URL =
  process.env.STRIPE_PORTAL_RETURN_URL || process.env.LOGIN_STRIPE_SUCCESS_URL || '';
const LOG_ENTITLEMENTS = process.env.LOG_ENTITLEMENTS === 'true';

function toDateFromUnix(value: unknown) {
  if (typeof value !== 'number') return null;
  return new Date(value * 1000);
}

function constantTimeEquals(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string) {
  if (!STRIPE_WEBHOOK_SECRET) return false;

  const pairs = signatureHeader.split(',').map((item) => item.trim());
  const timestamp = pairs
    .find((pair) => pair.startsWith('t='))
    ?.slice('t='.length);
  const signatures = pairs
    .filter((pair) => pair.startsWith('v1='))
    .map((pair) => pair.slice('v1='.length));

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > 300) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  return signatures.some((signature) => constantTimeEquals(signature, expected));
}

async function getUserIdByCustomerId(customerId: string | null) {
  if (!customerId) return null;

  const user = await db.query<{ id: string }>(
    `
    SELECT id
    FROM users
    WHERE stripe_customer_id = $1
    LIMIT 1
    `,
    [customerId]
  );

  if (user.rows[0]?.id) {
    return user.rows[0].id;
  }

  const subscription = await db.query<{ user_id: string }>(
    `
    SELECT user_id
    FROM subscriptions
    WHERE stripe_customer_id = $1
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [customerId]
  );

  return subscription.rows[0]?.user_id ?? null;
}

async function getCustomerIdByUserId(userId: string) {
  const fromUser = await db.query<{ stripe_customer_id: string | null }>(
    `
    SELECT stripe_customer_id
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (fromUser.rows[0]?.stripe_customer_id) {
    return fromUser.rows[0].stripe_customer_id;
  }

  const fromSubscription = await db.query<{ stripe_customer_id: string | null }>(
    `
    SELECT stripe_customer_id
    FROM subscriptions
    WHERE user_id = $1
      AND stripe_customer_id IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return fromSubscription.rows[0]?.stripe_customer_id ?? null;
}

async function upsertEntitlements(userId: string, subscriptionStatus: string | null) {
  const effective = entitlementsFromSubscriptionStatus(subscriptionStatus);
  await db.query(
    `
    INSERT INTO entitlements (
      user_id,
      subscription_status,
      intelligent_generation,
      safe_regeneration,
      ui_overrides,
      max_generations,
      reason,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      subscription_status = EXCLUDED.subscription_status,
      intelligent_generation = EXCLUDED.intelligent_generation,
      safe_regeneration = EXCLUDED.safe_regeneration,
      ui_overrides = EXCLUDED.ui_overrides,
      max_generations = EXCLUDED.max_generations,
      reason = EXCLUDED.reason,
      updated_at = NOW()
    `,
    [
      userId,
      effective.status,
      effective.features.intelligentGeneration,
      effective.features.safeRegeneration,
      effective.features.uiOverrides,
      effective.features.maxGenerations,
      effective.reason
    ]
  );
}

async function handleCheckoutCompleted(dataObject: Record<string, unknown>) {
  const customerId =
    typeof dataObject.customer === 'string' ? dataObject.customer : null;
  const subscriptionId =
    typeof dataObject.subscription === 'string' ? dataObject.subscription : null;

  const metadata = (dataObject.metadata as Record<string, unknown> | undefined) || {};
  const clientReferenceId =
    typeof dataObject.client_reference_id === 'string'
      ? dataObject.client_reference_id
      : null;

  const userIdFromMetadata =
    typeof metadata.user_id === 'string' ? metadata.user_id : null;
  const userId = userIdFromMetadata || clientReferenceId;

  if (!userId) {
    return;
  }

  if (customerId) {
    await db.query(
      `
      UPDATE users
      SET stripe_customer_id = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId, customerId]
    );
  }

  if (subscriptionId) {
    await db.query(
      `
      INSERT INTO subscriptions (
        id,
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
      ON CONFLICT (stripe_subscription_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        updated_at = NOW()
      `,
      [uuid(), userId, customerId, subscriptionId, 'incomplete']
    );

    await upsertEntitlements(userId, 'incomplete');
  }
}

async function handleSubscriptionEvent(
  dataObject: Record<string, unknown>,
  eventCreated: number | undefined
) {
  const subscriptionId = typeof dataObject.id === 'string' ? dataObject.id : null;
  const customerId =
    typeof dataObject.customer === 'string' ? dataObject.customer : null;
  const status = typeof dataObject.status === 'string' ? dataObject.status : null;
  const cancelAtPeriodEnd = Boolean(dataObject.cancel_at_period_end);
  const currentPeriodEnd = toDateFromUnix(dataObject.current_period_end);
  const trialEnd = toDateFromUnix(dataObject.trial_end);

  const items = (dataObject.items as { data?: Array<{ price?: { id?: string } }> } | null)
    ?.data;
  const priceId = items?.[0]?.price?.id ?? null;

  let userId = await getUserIdByCustomerId(customerId);
  if (!userId && subscriptionId) {
    const existingBySubscription = await db.query<{ user_id: string }>(
      `
      SELECT user_id
      FROM subscriptions
      WHERE stripe_subscription_id = $1
      LIMIT 1
      `,
      [subscriptionId]
    );
    userId = existingBySubscription.rows[0]?.user_id ?? null;
  }

  if (!userId || !subscriptionId) {
    return;
  }

  if (customerId) {
    await db.query(
      `
      UPDATE users
      SET stripe_customer_id = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId, customerId]
    );
  }

  await db.query(
    `
    INSERT INTO subscriptions (
      id,
      user_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      status,
      cancel_at_period_end,
      current_period_end,
      trial_end,
      last_event_created_at,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      status = EXCLUDED.status,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      current_period_end = EXCLUDED.current_period_end,
      trial_end = EXCLUDED.trial_end,
      last_event_created_at = EXCLUDED.last_event_created_at,
      updated_at = NOW()
    `,
    [
      uuid(),
      userId,
      customerId,
      subscriptionId,
      priceId,
      status ?? 'incomplete',
      cancelAtPeriodEnd,
      currentPeriodEnd,
      trialEnd,
      eventCreated ? new Date(eventCreated * 1000) : null
    ]
  );

  await upsertEntitlements(userId, status);
}

async function processStripeEvent(event: StripeEvent) {
  const eventId = typeof event.id === 'string' ? event.id : null;
  const eventType = typeof event.type === 'string' ? event.type : null;
  const dataObject = event.data?.object;

  if (!eventId || !eventType || !dataObject) {
    return { processed: false, reason: 'invalid_event' };
  }

  const auditInsert = await db.query(
    `
    INSERT INTO billing_events (
      id,
      stripe_event_id,
      event_type,
      stripe_customer_id,
      stripe_subscription_id,
      payload,
      processed_at
    )
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
    ON CONFLICT (stripe_event_id) DO NOTHING
    `,
    [
      uuid(),
      eventId,
      eventType,
      typeof dataObject.customer === 'string' ? dataObject.customer : null,
      typeof dataObject.id === 'string' && dataObject.object === 'subscription'
        ? dataObject.id
        : typeof dataObject.subscription === 'string'
          ? dataObject.subscription
          : null,
      JSON.stringify(event)
    ]
  );

  if (auditInsert.rowCount === 0) {
    return { processed: true, duplicate: true };
  }

  if (eventType === 'checkout.session.completed') {
    await handleCheckoutCompleted(dataObject);
  }

  if (
    eventType === 'customer.subscription.created' ||
    eventType === 'customer.subscription.updated' ||
    eventType === 'customer.subscription.deleted'
  ) {
    await handleSubscriptionEvent(dataObject, event.created);
  }

  if (LOG_ENTITLEMENTS) {
    const latest = await db.query<{
      user_id: string;
      subscription_status: string;
      reason: string;
      updated_at: string;
    }>(
      `
      SELECT user_id, subscription_status, reason, updated_at
      FROM entitlements
      ORDER BY updated_at DESC
      LIMIT 5
      `
    );
    console.log('ENTITLEMENTS (latest 5):', latest.rows);
  }

  return { processed: true };
}

export async function billingRoutes(app: FastifyInstance) {
  app.get('/billing/dev-plan', async (_req, reply) => {
    const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Plano Dev</title>
    <style>
      :root {
        --bg: #f6f7fb;
        --card: #ffffff;
        --text: #152238;
        --muted: #5d6b82;
        --primary: #1d4ed8;
        --primary-2: #173fa9;
        --border: #d7deea;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 10% 0%, #e6eefc, var(--bg));
        color: var(--text);
        min-height: 100vh;
      }
      .wrap {
        max-width: 900px;
        margin: 0 auto;
        padding: 32px 20px 60px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 14px 30px rgba(21, 34, 56, 0.08);
      }
      h1 { margin: 0 0 6px; font-size: 30px; }
      .subtitle { margin: 0 0 18px; color: var(--muted); }
      .grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        margin: 20px 0;
      }
      .feature {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px;
        background: #f9fbff;
      }
      .feature strong { display: block; margin-bottom: 4px; }
      .cta {
        margin-top: 14px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button {
        border: 0;
        background: var(--primary);
        color: white;
        border-radius: 10px;
        padding: 10px 14px;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover { background: var(--primary-2); }
      .mutedBtn {
        background: #e8edf9;
        color: #13316c;
      }
      .msg { margin-top: 10px; color: var(--muted); min-height: 20px; }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <h1>Plano Dev</h1>
        <p class="subtitle">
          Recursos para geração avançada. Você pode gerenciar e cancelar sua assinatura no portal oficial da Stripe.
        </p>

        <div class="grid">
          <article class="feature">
            <strong>Intelligent Generation</strong>
            Geração avançada baseada em contexto.
          </article>
          <article class="feature">
            <strong>Safe Regeneration</strong>
            Regeração com proteções para evitar regressões.
          </article>
          <article class="feature">
            <strong>UI Overrides</strong>
            Personalização de saídas e comportamento visual.
          </article>
          <article class="feature">
            <strong>Uso</strong>
            Sem limite de gerações para assinatura ativa.
          </article>
        </div>

        <div class="cta">
          <button id="manage">Gerenciar / Cancelar na Stripe</button>
          <button id="check" class="mutedBtn">Revalidar status</button>
        </div>
        <p id="message" class="msg"></p>
      </section>
    </main>

    <script>
      function getToken() {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = params.get('access_token');
        if (fromQuery) return fromQuery;
        const fromStorage =
          localStorage.getItem('generateui_access_token') ||
          localStorage.getItem('access_token');
        return fromStorage || '';
      }

      async function callApi(path, options = {}) {
        const token = getToken();
        if (!token) {
          throw new Error('Faça login primeiro para gerenciar assinatura.');
        }
        const response = await fetch(path, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            ...(options.headers || {})
          }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Falha na requisição.');
        }
        return data;
      }

      const message = document.getElementById('message');
      document.getElementById('manage').addEventListener('click', async () => {
        message.textContent = 'Abrindo portal da Stripe...';
        try {
          const data = await callApi('/billing/customer-portal-session', {
            method: 'POST',
            body: JSON.stringify({})
          });
          window.location.href = data.url;
        } catch (error) {
          message.textContent = error.message;
        }
      });

      document.getElementById('check').addEventListener('click', async () => {
        message.textContent = 'Consultando status...';
        try {
          const data = await callApi('/me', { method: 'GET' });
          message.textContent =
            'Status atual: ' + data.subscription?.status + (data.subscription?.reason ? ' (' + data.subscription.reason + ')' : '');
        } catch (error) {
          message.textContent = error.message;
        }
      });
    </script>
  </body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      if (req.url.startsWith('/billing/webhook')) {
        done(null, body);
        return;
      }

      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(new Error('invalid json body'));
      }
    }
  );

  app.post(
    '/billing/checkout-session',
    async (req: FastifyRequest<{ Body: CheckoutRequest }>, reply) => {
      const userId = getAuthenticatedUserId(req);
      if (!userId) {
        return reply.status(401).send({ error: 'invalid token' });
      }

      const body = req.body;
      if (!body?.priceId || !body.successUrl || !body.cancelUrl) {
        return reply.status(400).send({ error: 'priceId, successUrl and cancelUrl are required' });
      }

      try {
        const session = await createCheckoutSessionForUser({
          userId,
          priceId: body.priceId,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl
        });
        return reply.send(session);
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : 'failed to create checkout session'
        });
      }
    }
  );

  app.post(
    '/billing/customer-portal-session',
    async (req: FastifyRequest<{ Body: CustomerPortalRequest }>, reply) => {
      const userId = getAuthenticatedUserId(req);
      if (!userId) {
        return reply.status(401).send({ error: 'invalid token' });
      }
      if (!STRIPE_SECRET_KEY) {
        return reply.status(500).send({ error: 'stripe not configured' });
      }

      const customerId = await getCustomerIdByUserId(userId);
      if (!customerId) {
        return reply.status(404).send({ error: 'no stripe customer found for user' });
      }

      const returnUrl = req.body?.returnUrl || STRIPE_PORTAL_RETURN_URL;
      if (!returnUrl) {
        return reply.status(400).send({ error: 'returnUrl is required' });
      }

      const body = new URLSearchParams();
      body.set('customer', customerId);
      body.set('return_url', returnUrl);

      const stripeResponse = await fetch(
        'https://api.stripe.com/v1/billing_portal/sessions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body
        }
      );

      const responseBody = (await stripeResponse.json()) as {
        url?: string;
        error?: { message?: string };
      };

      if (!stripeResponse.ok || !responseBody.url) {
        return reply.status(400).send({
          error: responseBody.error?.message || 'failed to create portal session'
        });
      }

      return reply.send({ url: responseBody.url });
    }
  );

  app.post(
    '/billing/subscription/cancel',
    async (req: FastifyRequest<{ Body: CancelSubscriptionRequest }>, reply) => {
      const userId = getAuthenticatedUserId(req);
      if (!userId) {
        return reply.status(401).send({ error: 'invalid token' });
      }

      if (!STRIPE_SECRET_KEY) {
        return reply.status(500).send({ error: 'stripe not configured' });
      }

      const latest = await db.query<{
        stripe_subscription_id: string;
        status: string;
      }>(
        `
        SELECT stripe_subscription_id, status
        FROM subscriptions
        WHERE user_id = $1
          AND stripe_subscription_id IS NOT NULL
          AND status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete')
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [userId]
      );

      const activeSubscription = latest.rows[0];
      if (!activeSubscription?.stripe_subscription_id) {
        return reply.status(404).send({ error: 'no active subscription found' });
      }

      const immediately = Boolean(req.body?.immediately);
      const stripePath = immediately
        ? `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(activeSubscription.stripe_subscription_id)}/cancel`
        : `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(activeSubscription.stripe_subscription_id)}`;

      const body = new URLSearchParams();
      if (!immediately) {
        body.set('cancel_at_period_end', 'true');
      }

      const stripeResponse = await fetch(stripePath, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: immediately ? undefined : body
      });

      const responseBody = (await stripeResponse.json()) as {
        status?: string;
        cancel_at_period_end?: boolean;
        current_period_end?: number;
        trial_end?: number;
        error?: { message?: string };
      };

      if (!stripeResponse.ok) {
        return reply.status(400).send({
          error: responseBody.error?.message || 'failed to cancel subscription'
        });
      }

      const status =
        typeof responseBody.status === 'string'
          ? responseBody.status
          : immediately
            ? 'canceled'
            : activeSubscription.status;

      const cancelAtPeriodEnd =
        typeof responseBody.cancel_at_period_end === 'boolean'
          ? responseBody.cancel_at_period_end
          : true;

      await db.query(
        `
        UPDATE subscriptions
        SET status = $2,
            cancel_at_period_end = $3,
            current_period_end = COALESCE($4, current_period_end),
            trial_end = COALESCE($5, trial_end),
            updated_at = NOW()
        WHERE stripe_subscription_id = $1
        `,
        [
          activeSubscription.stripe_subscription_id,
          status,
          cancelAtPeriodEnd,
          toDateFromUnix(responseBody.current_period_end),
          toDateFromUnix(responseBody.trial_end)
        ]
      );

      await upsertEntitlements(userId, status);

      return reply.send({
        ok: true,
        subscription: {
          id: activeSubscription.stripe_subscription_id,
          status,
          cancelAtPeriodEnd
        }
      });
    }
  );

  app.post(
    '/billing/webhook',
    async (req: FastifyRequest<{ Body: string }>, reply) => {
      const signatureHeader = req.headers['stripe-signature'];
      const rawBody = typeof req.body === 'string' ? req.body : '';
      if (typeof signatureHeader !== 'string') {
        return reply.status(400).send({ error: 'missing stripe-signature' });
      }

      if (!verifyStripeWebhookSignature(rawBody, signatureHeader)) {
        return reply.status(400).send({ error: 'invalid stripe signature' });
      }

      let event: StripeEvent;
      try {
        event = JSON.parse(rawBody) as StripeEvent;
      } catch {
        return reply.status(400).send({ error: 'invalid payload' });
      }

      await processStripeEvent(event);
      return reply.send({ ok: true });
    }
  );
}
