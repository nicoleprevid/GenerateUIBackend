import { FastifyRequest } from 'fastify';
import { verifyToken } from './jwt';

const AUTH_COOKIE_NAME = 'generateui_token';

function parseCookies(cookieHeader: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    cookies[key] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

export function getBearerToken(req: FastifyRequest) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

export function getAuthenticatedUserId(req: FastifyRequest): string | null {
  let token = getBearerToken(req);
  if (!token) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies[AUTH_COOKIE_NAME] || '';
  }
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || typeof payload.sub !== 'string') return null;
  return payload.sub;
}

export function getAuthCookieName() {
  return AUTH_COOKIE_NAME;
}
