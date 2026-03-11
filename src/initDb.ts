import { db } from './db';

export async function initDb() {
  const client = await db.connect();
  try {
    await client.query('SELECT 1');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        stripe_customer_id TEXT UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_identities (
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, provider_user_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT UNIQUE,
        stripe_price_id TEXT,
        status TEXT NOT NULL,
        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        current_period_end TIMESTAMP,
        trial_end TIMESTAMP,
        last_event_created_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
      ON subscriptions(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS subscriptions_customer_idx
      ON subscriptions(stripe_customer_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS entitlements (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        subscription_status TEXT NOT NULL,
        intelligent_generation BOOLEAN NOT NULL DEFAULT FALSE,
        safe_regeneration BOOLEAN NOT NULL DEFAULT FALSE,
        ui_overrides BOOLEAN NOT NULL DEFAULT FALSE,
        max_generations INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS billing_events (
        id UUID PRIMARY KEY,
        stripe_event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        payload JSONB NOT NULL,
        processed_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS billing_events_type_idx
      ON billing_events(event_type)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS billing_events_subscription_idx
      ON billing_events(stripe_subscription_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id UUID PRIMARY KEY,
        event TEXT NOT NULL,
        installation_id TEXT,
        device_id TEXT,
        user_id TEXT,
        email TEXT,
        cli_version TEXT,
        npm_user_agent TEXT,
        device_created_at TIMESTAMP,
        ip TEXT,
        country TEXT,
        city TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      'ALTER TABLE IF EXISTS telemetry_events ALTER COLUMN installation_id DROP NOT NULL'
    );
    await client.query(
      'ALTER TABLE IF EXISTS telemetry_events ALTER COLUMN device_id DROP NOT NULL'
    );
    await client.query(
      'ALTER TABLE IF EXISTS telemetry_events ADD COLUMN IF NOT EXISTS npm_user_agent TEXT'
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_event_idx
      ON telemetry_events(event)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_installation_idx
      ON telemetry_events(installation_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_device_idx
      ON telemetry_events(device_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_user_idx
      ON telemetry_events(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_email_idx
      ON telemetry_events(email)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_created_at_idx
      ON telemetry_events(created_at)
    `);
  } finally {
    client.release();
  }
}
