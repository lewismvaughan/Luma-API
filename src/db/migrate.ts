import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pool, query } from './index';
import { logger } from '../utils/logger';

// Constant key for the Postgres session-level advisory lock that serialises
// migrations. When several API replicas boot at once (rolling update) they all
// call runMigrations(); without a lock two pods can see the same file as un-run
// and execute the same DDL concurrently → duplicate/partial migrations and
// crash-looping pods. The lock makes the second pod wait, after which it sees
// the migrations already recorded and does nothing.
const MIGRATION_ADVISORY_LOCK_KEY = 778421; // arbitrary, stable across deploys

export async function runMigrations() {
  // Hold the advisory lock on a single dedicated connection for the whole run.
  // pg_advisory_lock is session-scoped, so lock+unlock must happen on the same
  // client — not via the pooled query() helper, which may switch connections.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);

    // Create migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get list of migration files
    const migrationsDir = join(__dirname, '../../db/migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Ensure they run in order

    for (const file of migrationFiles) {
      // Check if migration has already been run
      const result = await client.query(
        'SELECT id FROM migrations WHERE filename = $1',
        [file]
      );

      if (result.rows.length === 0) {
        logger.info(`Running migration: ${file}`);

        // Read and execute migration
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        await client.query(sql);

        // Record migration as completed
        await client.query(
          'INSERT INTO migrations (filename) VALUES ($1)',
          [file]
        );

        logger.info(`Migration completed: ${file}`);
      } else {
        logger.info(`Migration already executed: ${file}`);
      }
    }

    logger.info('All migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch (unlockError) {
      logger.warn('Failed to release migration advisory lock (auto-released on disconnect)', { unlockError });
    }
    client.release();
  }
}

// Run init.sql if tables don't exist
export async function initializeDatabase() {
  try {
    // Check if users table exists (as a proxy for whether DB is initialized)
    const result = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);

    if (!result[0].exists) {
      logger.info('Database not initialized, running init.sql...');
      const initSql = readFileSync(join(__dirname, '../../db/init.sql'), 'utf8');
      await query(initSql);
      logger.info('Database initialized successfully');
    }

    // Run migrations after ensuring base schema exists
    await runMigrations();
  } catch (error) {
    logger.error('Database initialization failed:', error);
    throw error;
  }
}