import { db } from './db';

export async function initDb() {
  const client = await db.connect();
  try {
    await client.query('SELECT 1');
    await client.query(`
      CREATE TABLE IF NOT EXISTS installations (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        os TEXT,
        arch TEXT,
        ip TEXT,
        first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS logins (
        id UUID PRIMARY KEY,
        installation_id TEXT REFERENCES installations(id),
        email TEXT,
        cli_version TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}
