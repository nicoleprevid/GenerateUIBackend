import { Pool } from 'pg';
console.log('DATABASE_URL FROM ENV:', process.env.DATABASE_URL);

export const db = new Pool({
  connectionString: process.env.DATABASE_URL
});
