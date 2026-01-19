import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { URL } from 'url';
import * as oauth from 'oauth4webapi';

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET =
  process.env.GENERATEUI_JWT_SECRET || 'dev-secret-change-in-production';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

type Provider = 'github' | 'google';

const LOGIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GenerateUI Login</title>
    <style>
      :root {
        --bg: #f3e8ff;
        --card: #ffffff;
        --text: #2a1b3d;
        --muted: #6b5b7a;
        --primary: #7c3aed;
        --secondary: #a855f7;
        --glow: rgba(124, 58, 237, 0.22);
      }
      * {
        box-sizing: border-box;
        font-family: "IBM Plex Serif", "Georgia", serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top, #f5ebff, #e9d5ff);
        color: var(--text);
      }
      main {
        background: var(--card);
        padding: 48px;
        border-radius: 24px;
        box-shadow: 0 24px 70px var(--glow);
        width: min(420px, 90vw);
        text-align: center;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 0 0 32px;
        color: var(--muted);
      }
      a.button {
        display: block;
        text-decoration: none;
        padding: 14px 18px;
        border-radius: 14px;
        margin-bottom: 12px;
        font-weight: 600;
        border: 1px solid transparent;
      }
      a.button.primary {
        background: var(--primary);
        color: white;
      }
      a.button.secondary {
        background: #f5e9ff;
        color: #5b21b6;
        border-color: #e9d5ff;
      }
      .footer {
        margin-top: 24px;
        font-size: 14px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>GenerateUI Login</h1>
      <p>Continue with your preferred provider.</p>
      <a class="button primary" id="github" href="#">Continue with GitHub</a>
      <a class="button secondary" id="google" href="#">Continue with Google</a>
      <div class="footer">After login you can close this window.</div>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const redirectUri = params.get('redirect_uri') || '';
      const apiBase = params.get('api_base') || '';

      const github = document.getElementById('github');
      const google = document.getElementById('google');

      if (redirectUri && apiBase) {
        github.href =
          apiBase +
          '/auth/github?redirect_uri=' +
          encodeURIComponent(redirectUri);
        google.href =
          apiBase +
          '/auth/google?redirect_uri=' +
          encodeURIComponent(redirectUri);
      } else {
        github.href = '#';
        google.href = '#';
      }
    </script>
  </body>
</html>
`;

function base64Url(input: Buffer | string) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signHmac(input: string) {
  return base64Url(
    crypto.createHmac('sha256', JWT_SECRET).update(input).digest()
  );
}

function signToken(
  payload: Record<string, unknown>,
  expiresInSec = 30 * 24 * 60 * 60
) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec
  };
  const body = base64Url(JSON.stringify(fullPayload));
  const signature = signHmac(`${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

function signState(payload: Record<string, unknown>) {
  const body = base64Url(JSON.stringify(payload));
  const signature = signHmac(body);
  return `${body}.${signature}`;
}

function verifyState(state: string) {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = signHmac(body);
  if (expected !== signature) return null;
  try {
    return JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf-8'
      )
    );
  } catch {
    return null;
  }
}

async function getAuthRedirect(provider: Provider, redirectUri: string) {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const nonce = provider === 'google' ? oauth.generateRandomNonce() : undefined;

  const state = signState({
    provider,
    redirectUri,
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

export async function authRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(LOGIN_HTML);
  });

  app.get('/auth/github', async (req, reply) => {
    const redirectUri = (req.query as { redirect_uri?: string }).redirect_uri || '';
    if (!redirectUri) {
      return reply.status(400).send({ error: 'redirect_uri required' });
    }
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return reply.status(500).send({ error: 'GitHub OAuth not configured' });
    }
    const location = await getAuthRedirect('github', redirectUri);
    return reply.redirect(location);
  });

  app.get('/auth/google', async (req, reply) => {
    const redirectUri = (req.query as { redirect_uri?: string }).redirect_uri || '';
    if (!redirectUri) {
      return reply.status(400).send({ error: 'redirect_uri required' });
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reply.status(500).send({ error: 'Google OAuth not configured' });
    }
    const location = await getAuthRedirect('google', redirectUri);
    return reply.redirect(location);
  });

  app.get('/auth/github/callback', async (req, reply) => {
    const requestUrl = new URL(req.url, BASE_URL);
    const state = requestUrl.searchParams.get('state') || '';
    const payload = verifyState(state) as
      | { redirectUri?: string; codeVerifier?: string }
      | null;

    if (!payload?.redirectUri || !payload.codeVerifier) {
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
      const token = signToken({ sub: providerUserId, plan: 'dev' });
      const expiresAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString();
      const redirectUrl = new URL(payload.redirectUri);
      redirectUrl.searchParams.set('access_token', token);
      redirectUrl.searchParams.set('expires_at', expiresAt);
      return reply.redirect(redirectUrl.toString());
    } catch {
      return reply.status(500).send({ error: 'OAuth failed' });
    }
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const requestUrl = new URL(req.url, BASE_URL);
    const state = requestUrl.searchParams.get('state') || '';
    const payload = verifyState(state) as
      | { redirectUri?: string; codeVerifier?: string; nonce?: string }
      | null;

    if (!payload?.redirectUri || !payload.codeVerifier) {
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
      const token = signToken({ sub: providerUserId, plan: 'dev' });
      const expiresAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString();
      const redirectUrl = new URL(payload.redirectUri);
      redirectUrl.searchParams.set('access_token', token);
      redirectUrl.searchParams.set('expires_at', expiresAt);
      return reply.redirect(redirectUrl.toString());
    } catch {
      return reply.status(500).send({ error: 'OAuth failed' });
    }
  });
}
