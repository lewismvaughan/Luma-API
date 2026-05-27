import { redisService } from '../redis';
import { logger } from '../../utils/logger';

/**
 * Runs `fn` only if this replica wins a short-lived Redis lock for `key`.
 *
 * Every API replica registers the same setInterval jobs, so without coordination
 * they all fire on each tick → N× Stripe transfers / account deletions / emails.
 * This lets exactly one replica run a given tick. The TTL only needs to be long
 * enough to cover the spread between replicas firing the "same" tick (a few
 * minutes) and MUST be well under the job interval so the key has expired before
 * the next tick and replicas re-contend fresh.
 *
 * Fails CLOSED: if the lock can't be acquired (held by a peer) OR Redis errors,
 * this replica skips the run. Skipping one tick of an hourly/6-hourly
 * maintenance job is harmless; double-firing Stripe payouts/cancellations is not.
 */
export async function runLeaderTask(
  key: string,
  lockTtlSeconds: number,
  fn: () => Promise<void>
): Promise<void> {
  let acquired = false;
  try {
    acquired = await redisService.setNX(`luma:leader:${key}`, String(Date.now()), lockTtlSeconds);
  } catch (error) {
    logger.warn('Leader lock check errored, skipping task this tick', { key, error });
    return;
  }
  if (!acquired) {
    logger.debug('Leader lock held by another replica, skipping task', { key });
    return;
  }
  await fn();
}
