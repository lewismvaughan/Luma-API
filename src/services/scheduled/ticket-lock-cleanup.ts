import { query } from '../../db';
import { logger } from '../../utils/logger';
import { runLeaderTask } from './leader-lock';
import { deleteOldResolvedErrors } from '../error-logging';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

const intervals: ReturnType<typeof setInterval>[] = [];

// --- Ticket Locks: every 15 minutes ---

async function cleanExpiredTicketLocks() {
  try {
    const result = await query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM ticket_locks WHERE expires_at < NOW() RETURNING id
      ) SELECT COUNT(*) AS count FROM deleted`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('Cleaned expired ticket locks', { count });
    }
  } catch (error) {
    logger.error('Failed to clean expired ticket locks', { error });
  }
}

// --- Sessions: every hour ---

async function cleanExpiredSessions() {
  try {
    const result = await query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM sessions WHERE expires_at < NOW() RETURNING id
      ) SELECT COUNT(*) AS count FROM deleted`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('Cleaned expired sessions', { count });
    }
  } catch (error) {
    logger.error('Failed to clean expired sessions', { error });
  }
}

// --- Password Reset Tokens: every hour ---
// Deletes used tokens and tokens expired for more than 24 hours

async function cleanPasswordResetTokens() {
  try {
    const result = await query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM password_reset_tokens
        WHERE used_at IS NOT NULL
          OR expires_at < NOW() - INTERVAL '24 hours'
        RETURNING id
      ) SELECT COUNT(*) AS count FROM deleted`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('Cleaned password reset tokens', { count });
    }
  } catch (error) {
    logger.error('Failed to clean password reset tokens', { error });
  }
}

// --- Resolved API errors: every 6 hours ---
// api_errors rows are large (full request body+headers); without GC the table
// grows unboundedly. Delete resolved errors older than 30 days cluster-wide.

async function cleanResolvedApiErrors() {
  try {
    const deleted = await deleteOldResolvedErrors(null, 30);
    if (deleted && deleted > 0) {
      logger.info('Cleaned resolved api_errors', { count: deleted });
    }
  } catch (error) {
    logger.error('Failed to clean resolved api_errors', { error });
  }
}

// --- Start / Stop ---

export function startScheduledCleanups() {
  // One replica per tick (Redis leader lock) to avoid N× redundant cleanups.
  const ticketLocksTick = () => runLeaderTask('cleanup:ticket-locks', 300, cleanExpiredTicketLocks);
  const sessionsTick = () => runLeaderTask('cleanup:sessions', 600, cleanExpiredSessions);
  const resetTokensTick = () => runLeaderTask('cleanup:reset-tokens', 600, cleanPasswordResetTokens);
  const apiErrorsTick = () => runLeaderTask('cleanup:api-errors', 1800, cleanResolvedApiErrors);

  // Run all once immediately on startup (still leader-guarded)
  ticketLocksTick();
  sessionsTick();
  resetTokensTick();
  apiErrorsTick();

  intervals.push(
    setInterval(ticketLocksTick, FIFTEEN_MINUTES),
    setInterval(sessionsTick, ONE_HOUR),
    setInterval(resetTokensTick, ONE_HOUR),
    setInterval(apiErrorsTick, SIX_HOURS),
  );

  logger.info('Scheduled cleanups started', {
    ticketLocks: '15m',
    sessions: '1h',
    passwordResetTokens: '1h',
    apiErrors: '6h',
  });
}

export function stopScheduledCleanups() {
  intervals.forEach(clearInterval);
  intervals.length = 0;
}
