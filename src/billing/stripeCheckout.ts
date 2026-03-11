import { db } from '../db';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

export type CreateCheckoutSessionInput = {
  userId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
};

export type CreateCheckoutSessionResult = {
  checkoutSessionId: string;
  checkoutUrl: string;
};

export async function createCheckoutSessionForUser(
  input: CreateCheckoutSessionInput
): Promise<CreateCheckoutSessionResult> {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('stripe not configured');
  }

  const user = await db.query<{ stripe_customer_id: string | null }>(
    `
    SELECT stripe_customer_id
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [input.userId]
  );

  const customerId = user.rows[0]?.stripe_customer_id ?? null;

  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', input.priceId);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', input.successUrl);
  form.set('cancel_url', input.cancelUrl);
  form.set('client_reference_id', input.userId);
  form.set('metadata[user_id]', input.userId);
  if (customerId) {
    form.set('customer', customerId);
  }

  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  const responseBody = (await stripeResponse.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };

  if (!stripeResponse.ok || !responseBody.id || !responseBody.url) {
    throw new Error(
      responseBody.error?.message || 'failed to create checkout session'
    );
  }

  return {
    checkoutSessionId: responseBody.id,
    checkoutUrl: responseBody.url
  };
}
