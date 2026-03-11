import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db';
import { getAuthenticatedUserId } from '../lib/auth';
import { entitlementsFromSubscriptionStatus } from '../billing/entitlements';

type MeRow = {
  subscription_status: string | null;
  intelligent_generation: boolean | null;
  safe_regeneration: boolean | null;
  ui_overrides: boolean | null;
  max_generations: number | null;
  reason: string | null;
};

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req: FastifyRequest, reply) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return reply.status(401).send({ error: 'invalid token' });
    }

    const entitlementResult = await db.query<MeRow>(
      `
      SELECT
        e.subscription_status,
        e.intelligent_generation,
        e.safe_regeneration,
        e.ui_overrides,
        e.max_generations,
        e.reason
      FROM entitlements e
      WHERE e.user_id = $1
      LIMIT 1
      `,
      [userId]
    );

    const row = entitlementResult.rows[0];
    const fallback = entitlementsFromSubscriptionStatus(row?.subscription_status ?? null);
    const status = row?.subscription_status ?? fallback.status;
    const reason =
      status === 'active' || status === 'trialing'
        ? null
        : (row?.reason ?? fallback.reason);

    return reply.status(200).send({
      subscription: {
        status,
        reason
      },
      features: {
        intelligentGeneration:
          row?.intelligent_generation ?? fallback.features.intelligentGeneration,
        safeRegeneration: row?.safe_regeneration ?? fallback.features.safeRegeneration,
        uiOverrides: row?.ui_overrides ?? fallback.features.uiOverrides,
        maxGenerations: row?.max_generations ?? fallback.features.maxGenerations
      }
    });
  });
}
