import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db';
import { v4 as uuid } from 'uuid';
import { getBearerToken } from '../lib/auth';
import { verifyToken } from '../lib/jwt';

type TelemetryPayload = {
  event: string;
  installationId: string;
  deviceId: string;
  email?: string;
  cliVersion?: string;
  deviceCreatedAt?: string;
};

type GeoResult = {
  country: string | null;
  city: string | null;
};

function isPrivateIp(ip: string) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function resolveGeo(ip: string): Promise<GeoResult> {
  if (!ip || isPrivateIp(ip)) {
    return { country: null, city: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: controller.signal
    });
    if (!response.ok) {
      return { country: null, city: null };
    }
    const data = (await response.json()) as {
      country?: string;
      city?: string;
    };
    return { country: data.country ?? null, city: data.city ?? null };
  } catch {
    return { country: null, city: null };
  } finally {
    clearTimeout(timeout);
  }
}

function getRequestIp(req: FastifyRequest) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip;
}

export async function telemetryRoutes(app: FastifyInstance) {
  app.post(
    '/telemetry',
    async (req: FastifyRequest<{ Body: TelemetryPayload }>, reply) => {
      const body = req.body;
      if (!body?.event || !body.installationId || !body.deviceId) {
        return reply.status(400).send({ error: 'invalid payload' });
      }

      const token = getBearerToken(req);
      let userId: string | null = null;
      let email: string | null = body.email ?? null;
      if (token) {
        const payload = verifyToken(token);
        if (!payload || typeof payload.sub !== 'string') {
          return reply.status(401).send({ error: 'invalid token' });
        }
        userId = payload.sub;
        email = null;
      }

      const ip = getRequestIp(req);
      const geo = await resolveGeo(ip);

      const deviceCreatedAt = body.deviceCreatedAt
        ? new Date(body.deviceCreatedAt)
        : null;

      await db.query(
        `
        INSERT INTO telemetry_events (
          id, event, installation_id, device_id, user_id, email,
          cli_version, device_created_at, ip, country, city, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        `,
        [
          uuid(),
          body.event,
          body.installationId,
          body.deviceId,
          userId,
          email,
          body.cliVersion ?? null,
          deviceCreatedAt,
          ip,
          geo.country,
          geo.city
        ]
      );

      return reply.send({ ok: true });
    }
  );
}
