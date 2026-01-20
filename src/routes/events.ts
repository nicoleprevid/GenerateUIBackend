import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db';
import { v4 as uuid } from 'uuid';

type EventPayload = {
  event:
    | 'first_run'
    | 'login'
    | 'generate'
    | 'angular'
    | 'help'
    | 'command_run'
    | string;
  installationId: string;
  deviceId?: string;
  os?: string;
  arch?: string;
  email?: string;
  cliVersion?: string;
  deviceCreatedAt?: string;
};

export async function eventsRoutes(app: FastifyInstance) {
  app.post('/events', async (req: FastifyRequest<{ Body: EventPayload }>, reply) => {
    const body = req.body;
    const ip = req.ip;

    if (body.event && body.installationId && body.deviceId) {
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
          null,
          body.email ?? null,
          body.cliVersion ?? null,
          deviceCreatedAt,
          ip,
          null,
          null
        ]
      );
    }

    return reply.send({ ok: true });
  });
}
