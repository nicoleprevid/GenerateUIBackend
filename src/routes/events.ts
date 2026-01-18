import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db';
import { v4 as uuid } from 'uuid';

type EventPayload = {
  event: 'first_run' | 'login';
  installationId: string;
  deviceId?: string;
  os?: string;
  arch?: string;
  email?: string;
  cliVersion?: string;
};

export async function eventsRoutes(app: FastifyInstance) {
  app.post('/events', async (req: FastifyRequest<{ Body: EventPayload }>, reply) => {
    const body = req.body;
    const ip = req.ip;

    if (body.event === 'first_run') {
      await db.query(
        `
        INSERT INTO installations (
          id, device_id, os, arch, ip,
          first_seen_at, last_seen_at
        )
        VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
        ON CONFLICT (id)
        DO UPDATE SET last_seen_at = NOW()
        `,
        [body.installationId, body.deviceId, body.os, body.arch, ip]
      );
    }

    if (body.event === 'login') {
      await db.query(
        `
        INSERT INTO logins (
          id, installation_id, email, cli_version, created_at
        )
        VALUES ($1,$2,$3,$4,NOW())
        `,
        [uuid(), body.installationId, body.email, body.cliVersion]
      );
    }

    return reply.send({ ok: true });
  });
}
