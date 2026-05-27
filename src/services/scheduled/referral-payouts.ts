import { query, transaction } from '../../db';
import { logger } from '../../utils/logger';
import { runLeaderTask } from './leader-lock';
import { stripeService } from '../stripe';
import { socketService, SocketEvents } from '../socket';
import { sendTemplatedEmail } from '../email/template-sender';

const ONE_HOUR = 60 * 60 * 1000;

const intervals: ReturnType<typeof setInterval>[] = [];

// --- Mark matured earnings as available: every hour ---

async function markMaturedEarnings() {
  try {
    const result = await query<{ count: string }>(
      `WITH updated AS (
        UPDATE referral_earnings
        SET status = 'available'
        WHERE status = 'pending' AND available_at <= NOW()
        RETURNING id
      ) SELECT COUNT(*) AS count FROM updated`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('[Referral Payouts] Marked matured earnings as available', { count });
    }
  } catch (error) {
    logger.error('[Referral Payouts] Failed to mark matured earnings', { error });
  }
}

// --- Process payouts for users with available balance: every hour ---

async function processReferralPayouts() {
  try {
    // Find all referrers with available earnings >= $1.00
    const eligibleUsers = await query<{
      referrer_user_id: string;
      total_available: string;
      currency: string;
    }>(
      `SELECT referrer_user_id, SUM(earning_amount) AS total_available, currency
       FROM referral_earnings
       WHERE status = 'available'
       GROUP BY referrer_user_id, currency
       HAVING SUM(earning_amount) >= 1.00`
    );

    if (eligibleUsers.length === 0) return;

    logger.info('[Referral Payouts] Found eligible users for payout', { count: eligibleUsers.length });

    for (const user of eligibleUsers) {
      try {
        await processPayoutForUser(user.referrer_user_id, parseFloat(user.total_available), user.currency);
      } catch (err) {
        logger.error('[Referral Payouts] Failed to process payout for user', {
          userId: user.referrer_user_id,
          error: err,
        });
      }
    }
  } catch (error) {
    logger.error('[Referral Payouts] Failed to process referral payouts', { error });
  }
}

async function processPayoutForUser(userId: string, _totalAmount: number, currency: string) {
  // Look up user's organization Stripe connected account
  const accountResult = await query<{
    stripe_account_id: string;
    email: string;
    first_name: string;
    organization_id: string;
  }>(
    `SELECT sca.stripe_account_id, u.email, u.first_name, u.organization_id
     FROM users u
     JOIN stripe_connected_accounts sca ON sca.organization_id = u.organization_id
     WHERE u.id = $1 AND sca.charges_enabled = true
     LIMIT 1`,
    [userId]
  );

  if (accountResult.length === 0) {
    logger.warn('[Referral Payouts] No connected account found for user, skipping', { userId });
    return;
  }

  const { stripe_account_id: stripeAccountId, email, first_name: firstName } = accountResult[0];

  await transaction(async (client) => {
    // Lock and fetch the available earnings
    const earningsResult = await client.query(
      `SELECT id, earning_amount
       FROM referral_earnings
       WHERE referrer_user_id = $1 AND status = 'available' AND currency = $2
       ORDER BY created_at ASC
       FOR UPDATE`,
      [userId, currency]
    );

    if (earningsResult.rows.length === 0) return;

    const earningIds = earningsResult.rows.map((e: any) => e.id);
    const actualTotal = earningsResult.rows.reduce(
      (sum: number, e: any) => sum + parseFloat(e.earning_amount), 0
    );

    if (actualTotal < 1.00) return;

    // Create Stripe Transfer
    let transfer;
    try {
      transfer = await stripeService.createTransfer({
        amount: actualTotal,
        currency,
        destination: stripeAccountId,
        description: 'Luma Referral Earnings',
        metadata: { user_id: userId },
      });
    } catch (stripeErr: any) {
      // Record failed payout
      await client.query(
        `INSERT INTO referral_payouts (user_id, amount, currency, earning_ids, status, failed_reason)
         VALUES ($1, $2, $3, $4, 'failed', $5)`,
        [userId, actualTotal, currency, earningIds, stripeErr?.message || 'Stripe transfer failed']
      );

      logger.error('[Referral Payouts] Stripe transfer failed', {
        userId,
        amount: actualTotal,
        error: stripeErr?.message,
      });
      return;
    }

    // Create payout record
    const payoutResult = await client.query(
      `INSERT INTO referral_payouts (user_id, amount, currency, stripe_transfer_id, earning_ids, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
       RETURNING id`,
      [userId, actualTotal, currency, transfer.id, earningIds]
    );
    const payoutId = payoutResult.rows[0].id;

    // Mark earnings as paid
    await client.query(
      `UPDATE referral_earnings
       SET status = 'paid', paid_at = NOW(), stripe_transfer_id = $1
       WHERE id = ANY($2)`,
      [transfer.id, earningIds]
    );

    logger.info('[Referral Payouts] Payout completed', {
      payoutId,
      userId,
      amount: actualTotal,
      currency,
      transferId: transfer.id,
      earningCount: earningIds.length,
    });

    // Notify user via socket
    socketService.emitToUser(userId, SocketEvents.REFERRAL_PAYOUT, {
      payoutId,
      amount: actualTotal,
      currency,
      timestamp: new Date(),
    });

    // Send email notification (non-blocking)
    try {
      await sendTemplatedEmail(email, {
        subject: `Referral earnings payout: $${actualTotal.toFixed(2)}`,
        email_title: 'Referral Earnings Paid',
        email_content: `
          <p>Hi ${firstName},</p>
          <p>Your referral earnings of <strong>$${actualTotal.toFixed(2)}</strong> have been transferred to your connected Stripe account.</p>
          <p>Thank you for referring others to Luma!</p>
        `,
      });
    } catch (emailErr) {
      logger.error('[Referral Payouts] Failed to send payout email', { userId, error: emailErr });
    }
  });
}

// --- Start / Stop ---

export function startReferralPayouts() {
  // Each tick runs on only one replica (Redis leader lock) so Stripe transfers
  // aren't issued N times. 10-min TTL covers replica tick-spread, well under 1h.
  const markTick = () => runLeaderTask('referral:mark-matured', 600, markMaturedEarnings);
  const payoutTick = () => runLeaderTask('referral:process-payouts', 600, processReferralPayouts);

  // Run once shortly after startup (still guarded by the leader lock).
  markTick();
  payoutTick();

  intervals.push(
    setInterval(markTick, ONE_HOUR),
    setInterval(payoutTick, ONE_HOUR),
  );

  logger.info('Referral payout scheduler started', {
    markMatured: '1h',
    processPayouts: '1h',
  });
}

export function stopReferralPayouts() {
  intervals.forEach(clearInterval);
  intervals.length = 0;
}
