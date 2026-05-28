import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  // Per-replica cap (PG_POOL_MAX, default 25). Keep N_replicas × max under
  // Postgres max_connections (default 100) — e.g. 2 replicas × 25 = 50.
  max: config.database.poolMax,
  idleTimeoutMillis: 30000,
  // 2s was too tight: under a brief burst, the 26th request would 500 in 2s
  // instead of waiting a moment for a pool slot to free.
  connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: result.rowCount });
    return result.rows;
  } catch (error) {
    logger.error('Database query error', { text, error });
    throw error;
  }
}

export async function getClient() {
  return await pool.connect();
}

export async function transaction<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    await query('SELECT NOW()');
    logger.info('Database connection established successfully');
    return true;
  } catch (error) {
    logger.error('Failed to connect to database', error);
    return false;
  }
}