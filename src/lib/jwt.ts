import crypto from 'crypto';

const JWT_SECRET =
  process.env.GENERATEUI_JWT_SECRET || 'dev-secret-change-in-production';

export type JwtPayload = {
  sub?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
};

function base64Url(input: Buffer | string) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64Url(input: string) {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
    'utf-8'
  );
}

function signHmac(input: string) {
  return base64Url(
    crypto.createHmac('sha256', JWT_SECRET).update(input).digest()
  );
}

export function signToken(
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

export function verifyToken(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = signHmac(`${header}.${body}`);
  if (expected !== signature) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(body)) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
      return null;
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function signState(payload: Record<string, unknown>) {
  const body = base64Url(JSON.stringify(payload));
  const signature = signHmac(body);
  return `${body}.${signature}`;
}

export function verifyState(state: string): Record<string, unknown> | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;

  const [body, signature] = parts;
  const expected = signHmac(body);
  if (expected !== signature) return null;

  try {
    return JSON.parse(decodeBase64Url(body)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
