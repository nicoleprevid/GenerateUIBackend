import { db } from './db';

export async function initDb() {
  const client = await db.connect();
  try {
    await client.query('SELECT 1');
    await client.query(
      'ALTER TABLE IF EXISTS generations DROP CONSTRAINT IF EXISTS generations_installation_id_fkey'
    );
    await client.query('DROP TABLE IF EXISTS logins');
    await client.query('DROP TABLE IF EXISTS installations');
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id UUID PRIMARY KEY,
        event TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        user_id TEXT,
        email TEXT,
        cli_version TEXT,
        device_created_at TIMESTAMP,
        ip TEXT,
        country TEXT,
        city TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
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
