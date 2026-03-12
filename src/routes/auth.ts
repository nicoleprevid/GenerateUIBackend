import { FastifyInstance, FastifyReply } from 'fastify';
import { URL } from 'url';
import * as oauth from 'oauth4webapi';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { signState, signToken, verifyState } from '../lib/jwt';
import { getAuthCookieName } from '../lib/auth';
import { createCheckoutSessionForUser } from '../billing/stripeCheckout';

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const LOGIN_AUTO_CHECKOUT = process.env.LOGIN_AUTO_CHECKOUT === 'true';
const LOGIN_STRIPE_PRICE_ID = process.env.LOGIN_STRIPE_PRICE_ID || '';
const LOGIN_STRIPE_SUCCESS_URL = process.env.LOGIN_STRIPE_SUCCESS_URL || '';
const LOGIN_STRIPE_CANCEL_URL = process.env.LOGIN_STRIPE_CANCEL_URL || '';

type Provider = 'github' | 'google';

type AuthRedirectOptions = {
  redirectUri?: string;
  startCheckout: boolean;
  priceId?: string;
  successUrl?: string;
  cancelUrl?: string;
};

type LoginPayload = {
  redirectUri?: string;
  startCheckout?: boolean;
  priceId?: string;
  successUrl?: string;
  cancelUrl?: string;
};

const LOGIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GenerateUI Login</title>
    <style>
      :root {
        --bg-1: #f9f5ea;
        --bg-2: #eef7f4;
        --card: #ffffff;
        --text: #39455f;
        --muted: #76819a;
        --accent: #6fd3c0;
        --accent-2: #9fd8ff;
        --border: #e1e7f2;
        --shadow: rgba(76, 88, 120, 0.14);
      }
      * {
        box-sizing: border-box;
        font-family: "Manrope", "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 15% 0%, #fff3c8 0%, var(--bg-1) 36%, transparent 60%),
          radial-gradient(circle at 85% 0%, #e6f7ff 0%, var(--bg-2) 40%, transparent 70%),
          linear-gradient(135deg, #fdfbf6, #f3f7fb);
        color: var(--text);
      }
      main {
        background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(255,255,255,0.98));
        padding: 44px;
        border-radius: 28px;
        border: 1px solid var(--border);
        box-shadow: 0 24px 60px var(--shadow);
        width: min(520px, 92vw);
        text-align: left;
        position: relative;
        overflow: hidden;
      }
      main::before {
        content: "";
        position: absolute;
        inset: -40% 25% auto auto;
        width: 280px;
        height: 280px;
        background: radial-gradient(circle, rgba(111,211,192,0.35), transparent 70%);
        pointer-events: none;
      }
      .label {
        letter-spacing: 0.22em;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
      }
      h1 {
        margin: 10px 0 12px;
        font-size: 30px;
        letter-spacing: 0.02em;
      }
      p {
        margin: 0 0 28px;
        color: var(--muted);
        line-height: 1.5;
      }
      .buttons {
        display: grid;
        gap: 12px;
      }
      a.button {
        display: flex;
        align-items: center;
        justify-content: space-between;
        text-decoration: none;
        padding: 14px 18px;
        border-radius: 14px;
        font-weight: 600;
        border: 1px solid var(--border);
        color: var(--text);
        background: #f9fbff;
        transition: transform 0.15s ease, box-shadow 0.2s ease;
      }
      a.button.primary {
        background: linear-gradient(120deg, var(--accent), var(--accent-2));
        border-color: transparent;
        color: #ffffff;
      }
      a.button:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 24px rgba(33, 61, 94, 0.12);
      }
      .footer {
        margin-top: 22px;
        font-size: 13px;
        color: var(--muted);
      }
      .pill {
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.65);
        border: 1px solid var(--border);
        font-size: 12px;
        color: var(--muted);
      }
      @media (max-width: 520px) {
        main {
          padding: 32px 24px;
          text-align: center;
        }
        a.button {
          justify-content: center;
          gap: 10px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="label">Generated UI</div>
      <h1>Sign in to continue</h1>
      <p>Access dev features and manage your subscription.</p>
      <div class="buttons">
        <a class="button primary" id="github" href="#">
          Continue with GitHub
          <span class="pill">Recommended</span>
        </a>
        <a class="button" id="google" href="#">
          Continue with Google
          <span class="pill">Fast</span>
        </a>
      </div>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const redirectUri = params.get('redirect_uri') || '';
      const apiBase = params.get('api_base') || window.location.origin;
      const startCheckout = params.get('start_checkout') === '1';
      const priceId = params.get('price_id') || '';
      const successUrl = params.get('success_url') || '';
      const cancelUrl = params.get('cancel_url') || '';

      const github = document.getElementById('github');
      const google = document.getElementById('google');

      if (redirectUri) {
        github.href =
          apiBase +
          '/auth/github?redirect_uri=' +
          encodeURIComponent(redirectUri);
        google.href =
          apiBase +
          '/auth/google?redirect_uri=' +
          encodeURIComponent(redirectUri);
      } else if (startCheckout) {
        const common =
          '?start_checkout=1' +
          (priceId ? '&price_id=' + encodeURIComponent(priceId) : '') +
          (successUrl ? '&success_url=' + encodeURIComponent(successUrl) : '') +
          (cancelUrl ? '&cancel_url=' + encodeURIComponent(cancelUrl) : '');

        github.href = apiBase + '/auth/github' + common;
        google.href = apiBase + '/auth/google' + common;
      } else {
        github.href = apiBase + '/auth/github';
        google.href = apiBase + '/auth/google';
      }
    </script>
  </body>
</html>
`;

function getDefaultCheckoutConfig() {
  return {
    priceId: LOGIN_STRIPE_PRICE_ID,
    successUrl: LOGIN_STRIPE_SUCCESS_URL,
    cancelUrl: LOGIN_STRIPE_CANCEL_URL
  };
}

async function getAuthRedirect(provider: Provider, options: AuthRedirectOptions) {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const nonce = provider === 'google' ? oauth.generateRandomNonce() : undefined;

  const state = signState({
    provider,
    redirectUri: options.redirectUri,
    startCheckout: options.startCheckout,
    priceId: options.priceId,
    successUrl: options.successUrl,
    cancelUrl: options.cancelUrl,
    codeVerifier,
    nonce,
    state: oauth.generateRandomState()
  });

  if (provider === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${BASE_URL}/auth/github/callback`);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${BASE_URL}/auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  if (nonce) {
    url.searchParams.set('nonce', nonce);
  }
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function getGitHubAuthorizationServer(): oauth.AuthorizationServer {
  return {
    issuer: 'https://github.com',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token'
  };
}

function getGoogleAuthorizationServer(): oauth.AuthorizationServer {
  return {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token'
  };
}

function getGitHubClient(): oauth.Client {
  return {
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET
  };
}

function getGoogleClient(): oauth.Client {
  return {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET
  };
}

async function exchangeGitHubCode(
  params: URLSearchParams,
  codeVerifier: string,
  redirectUri: string
) {
  const as = getGitHubAuthorizationServer();
  const client = getGitHubClient();

  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    oauth.ClientSecretPost(GITHUB_CLIENT_SECRET),
    params,
    redirectUri,
    codeVerifier
  );

  const result = await oauth.processAuthorizationCodeResponse(as, client, response);

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${result.access_token}`,
      'User-Agent': 'GenerateUI'
    }
  });
  const user = (await userResponse.json()) as { id?: number };

  return {
    providerUserId: user.id ? `github:${user.id}` : 'github:unknown'
  };
}

async function exchangeGoogleCode(
  params: URLSearchParams,
  codeVerifier: string,
  redirectUri: string,
  nonce: string | undefined
) {
  const as = getGoogleAuthorizationServer();
  const client = getGoogleClient();

  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    oauth.ClientSecretPost(GOOGLE_CLIENT_SECRET),
    params,
    redirectUri,
    codeVerifier
  );

  const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
    expectedNonce: nonce || oauth.expectNoNonce,
    requireIdToken: true
  });

  if (!result.id_token) {
    throw new Error('Google id_token missing');
  }
  const payload = result.id_token.split('.')[1];
  const decoded = JSON.parse(
    Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf-8'
    )
  ) as { sub?: string };

  return {
    providerUserId: decoded.sub ? `google:${decoded.sub}` : 'google:unknown'
  };
}

async function findOrCreateUser(provider: Provider, providerUserId: string) {
  const existing = await db.query<{ user_id: string }>(
    `
    SELECT user_id
    FROM auth_identities
    WHERE provider = $1 AND provider_user_id = $2
    LIMIT 1
    `,
    [provider, providerUserId]
  );

  if (existing.rows[0]?.user_id) {
    return existing.rows[0].user_id;
  }

  const userId = uuid();
  await db.query(
    `
    INSERT INTO users (id, created_at, updated_at)
    VALUES ($1, NOW(), NOW())
    ON CONFLICT DO NOTHING
    `,
    [userId]
  );

  await db.query(
    `
    INSERT INTO auth_identities (provider, provider_user_id, user_id, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (provider, provider_user_id) DO NOTHING
    `,
    [provider, providerUserId, userId]
  );

  const resolved = await db.query<{ user_id: string }>(
    `
    SELECT user_id
    FROM auth_identities
    WHERE provider = $1 AND provider_user_id = $2
    LIMIT 1
    `,
    [provider, providerUserId]
  );

  if (!resolved.rows[0]?.user_id) {
    throw new Error('failed to resolve authenticated user');
  }

  return resolved.rows[0].user_id;
}

async function hasActiveEntitlement(userId: string) {
  const result = await db.query<{ subscription_status: string }>(
    `
    SELECT subscription_status
    FROM entitlements
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId]
  );
  const status = result.rows[0]?.subscription_status;
  return status === 'active' || status === 'trialing';
}

function isLocalRedirect(redirectUri: string) {
  try {
    const url = new URL(redirectUri);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function redirectWithToken(reply: FastifyReply, redirectUri: string, userId: string) {
  const token = signToken({ sub: userId });
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const cookie = buildAuthCookie(token, expiresAt);
  reply.header('Set-Cookie', cookie);
  if (isLocalRedirect(redirectUri)) {
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('access_token', token);
    redirectUrl.searchParams.set('expires_at', expiresAt.toISOString());
    return reply.redirect(redirectUrl.toString());
  }
  return reply.redirect(redirectUri);
}

function isSecureRequest() {
  return BASE_URL.startsWith('https://');
}

function buildAuthCookie(token: string, expiresAt: Date) {
  const sameSite = isSecureRequest() ? 'None' : 'Lax';
  const parts = [
    `${getAuthCookieName()}=${encodeURIComponent(token)}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    `SameSite=${sameSite}`
  ];
  if (isSecureRequest()) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

async function completeLogin(
  provider: Provider,
  providerUserId: string,
  payload: LoginPayload,
  reply: FastifyReply
) {
  const userId = await findOrCreateUser(provider, providerUserId);

  if (payload.startCheckout) {
    const alreadyEntitled = await hasActiveEntitlement(userId);
    const defaults = getDefaultCheckoutConfig();
    const priceId = payload.priceId || defaults.priceId;
    const successUrl = payload.successUrl || defaults.successUrl;
    const cancelUrl = payload.cancelUrl || defaults.cancelUrl;

    if (alreadyEntitled) {
      if (successUrl) {
        const redirectUrl = new URL(successUrl);
        const token = signToken({ sub: userId });
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const cookie = buildAuthCookie(token, expiresAt);
        reply.header('Set-Cookie', cookie);
        redirectUrl.searchParams.set('already_subscribed', '1');
        return reply.redirect(redirectUrl.toString());
      }
      if (payload.redirectUri) {
        return redirectWithToken(reply, payload.redirectUri, userId);
      }
      throw new Error('already subscribed and missing success redirect');
    }

    if (!priceId || !successUrl || !cancelUrl) {
      throw new Error('missing checkout configuration');
    }

    const session = await createCheckoutSessionForUser({
      userId,
      priceId,
      successUrl: buildCheckoutSuccessUrl(successUrl),
      cancelUrl
    });

    return reply.redirect(session.checkoutUrl);
  }

  if (!payload.redirectUri) {
    throw new Error('redirect_uri required');
  }

  return redirectWithToken(reply, payload.redirectUri, userId);
}

function buildCheckoutSuccessUrl(successUrl: string) {
  const finishUrl = new URL(`${BASE_URL}/billing/checkout/finish`);
  finishUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  finishUrl.searchParams.set('return_url', successUrl);
  return finishUrl.toString();
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(LOGIN_HTML);
  });

  app.get('/auth/github', async (req, reply) => {
    const query = req.query as {
      redirect_uri?: string;
      start_checkout?: string;
      price_id?: string;
      success_url?: string;
      cancel_url?: string;
    };

    const startCheckout =
      query.start_checkout === '1' ||
      (LOGIN_AUTO_CHECKOUT && !query.redirect_uri);
    if (!query.redirect_uri && !startCheckout) {
      return reply.status(400).send({ error: 'redirect_uri required' });
    }
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return reply.status(500).send({ error: 'GitHub OAuth not configured' });
    }

    const location = await getAuthRedirect('github', {
      redirectUri: query.redirect_uri,
      startCheckout,
      priceId: query.price_id,
      successUrl: query.success_url,
      cancelUrl: query.cancel_url
    });
    return reply.redirect(location);
  });

  app.get('/auth/google', async (req, reply) => {
    const query = req.query as {
      redirect_uri?: string;
      start_checkout?: string;
      price_id?: string;
      success_url?: string;
      cancel_url?: string;
    };

    const startCheckout =
      query.start_checkout === '1' ||
      (LOGIN_AUTO_CHECKOUT && !query.redirect_uri);
    if (!query.redirect_uri && !startCheckout) {
      return reply.status(400).send({ error: 'redirect_uri required' });
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reply.status(500).send({ error: 'Google OAuth not configured' });
    }

    const location = await getAuthRedirect('google', {
      redirectUri: query.redirect_uri,
      startCheckout,
      priceId: query.price_id,
      successUrl: query.success_url,
      cancelUrl: query.cancel_url
    });
    return reply.redirect(location);
  });

  app.get('/auth/github/callback', async (req, reply) => {
    const requestUrl = new URL(req.url, BASE_URL);
    const state = requestUrl.searchParams.get('state') || '';
    const payload = verifyState(state) as (LoginPayload & { codeVerifier?: string }) | null;

    if (!payload?.codeVerifier) {
      return reply.status(400).send({ error: 'Invalid callback' });
    }

    let params: URLSearchParams;
    try {
      params = oauth.validateAuthResponse(
        getGitHubAuthorizationServer(),
        getGitHubClient(),
        requestUrl,
        state
      );
    } catch {
      return reply.status(400).send({ error: 'Invalid auth response' });
    }

    try {
      const { providerUserId } = await exchangeGitHubCode(
        params,
        payload.codeVerifier,
        `${BASE_URL}/auth/github/callback`
      );

      await completeLogin('github', providerUserId, payload, reply);
      return;
    } catch {
      return reply.status(500).send({ error: 'OAuth failed' });
    }
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const requestUrl = new URL(req.url, BASE_URL);
    const state = requestUrl.searchParams.get('state') || '';
    const payload = verifyState(state) as (LoginPayload & {
      codeVerifier?: string;
      nonce?: string;
    }) | null;

    if (!payload?.codeVerifier) {
      return reply.status(400).send({ error: 'Invalid callback' });
    }

    let params: URLSearchParams;
    try {
      params = oauth.validateAuthResponse(
        getGoogleAuthorizationServer(),
        getGoogleClient(),
        requestUrl,
        state
      );
    } catch {
      return reply.status(400).send({ error: 'Invalid auth response' });
    }

    try {
      const { providerUserId } = await exchangeGoogleCode(
        params,
        payload.codeVerifier,
        `${BASE_URL}/auth/google/callback`,
        payload.nonce
      );

      await completeLogin('google', providerUserId, payload, reply);
      return;
    } catch {
      return reply.status(500).send({ error: 'OAuth failed' });
    }
  });
}
