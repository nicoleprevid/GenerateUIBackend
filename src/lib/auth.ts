import { FastifyRequest } from 'fastify';
import { verifyToken } from './jwt';

export function getBearerToken(req: FastifyRequest) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

export function getAuthenticatedUserId(req: FastifyRequest): string | null {
  const token = getBearerToken(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || typeof payload.sub !== 'string') return null;
  return payload.sub;
}
