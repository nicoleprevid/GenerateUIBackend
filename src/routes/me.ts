import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';

const JWT_SECRET =
  process.env.GENERATEUI_JWT_SECRET || 'dev-secret-change-in-production';

type TokenPayload = {
  sub?: string;
  plan?: 'free' | 'dev';
  exp?: number;
};

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

function verifyToken(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = signHmac(`${header}.${body}`);
  if (expected !== signature) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf-8'
      )
    ) as TokenPayload;
    const exp = payload.exp;
    if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;
    if (typeof payload.sub !== 'string' || !payload.sub.length) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req: FastifyRequest, reply) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length)
      : '';
    if (!token) {
      return reply.status(401).send({ error: 'missing token' });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return reply.status(401).send({ error: 'invalid token' });
    }

    const plan = payload.plan === 'free' ? 'free' : 'dev';

    return reply.status(200).send({
      plan,
      features: {
        intelligentGeneration: true,
        safeRegeneration: true,
        uiOverrides: true,
        maxGenerations: -1
      }
    });
  });
}
