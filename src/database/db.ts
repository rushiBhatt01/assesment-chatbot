import pg from 'pg';
import { config } from 'dotenv';

// Ensure .env is loaded
config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is missing.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err: any) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    // Optional: Log query statistics for telemetry
    return result;
  } catch (error) {
    console.error('Database query execution error:', { text, error });
    throw error;
  }
}

export async function closePool() {
  await pool.end();
}
