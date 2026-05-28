import { query } from '../../db';
import { logger } from '../../utils/logger';
import { runLeaderTask } from './leader-lock';
import { cognitoService } from '../auth/cognito';
import { emailService } from '../email';
import { cacheService, CacheKeys } from '../redis/cache';
import { config } from '../../config';
import { stripe } from '../stripe';
import { sendTemplatedEmail } from '../email/template-sender';

const SIX_HOURS = 6 * 60 * 60 * 1000;

const intervals: ReturnType<typeof setInterval>[] = [];

// --- 7-day reminder emails ---

interface ReminderCandidate {
  id: string;
  email: string;
  first_name: string | null;
  deletion_requested_at: Date;
}

async function sendDeletionReminders() {
  try {
    // Find users 23-30 days into the deletion window who haven't received a reminder
    const candidates = await query<ReminderCandidate>(
      `SELECT id, email, first_name, deletion_requested_at
       FROM users
       WHERE deletion_requested_at IS NOT NULL
         AND deletion_requested_at < NOW() - INTERVAL '23 days'
         AND deletion_requested_at > NOW() - INTERVAL '30 days'
         AND deletion_reminder_sent = false
         AND is_active = false`,
    );

    if (candidates.length === 0) return;

    logger.info('Sending deletion reminder emails', { count: candidates.length });

    for (const user of candidates) {
      try {
        const deletionDate = new Date(user.deletion_requested_at);
        deletionDate.setDate(deletionDate.getDate() + 30);
        const formattedDate = deletionDate.toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        });

        await sendTemplatedEmail(user.email, {
          subject: 'Reminder: Your Luma Account Will Be Deleted Soon',
          preheader_text: `Your account will be permanently deleted on ${formattedDate}`,
          email_title: 'Account Deletion Reminder',
          email_content: `
            Hi ${user.first_name || 'there'},<br><br>
            This is a reminder that your Luma account is scheduled for permanent deletion on <strong>${formattedDate}</strong>.<br><br>
            If you've changed your mind, you can cancel the deletion by logging back into the Luma app before that date.<br><br>
            If you still want your account deleted, no action is needed — it will be removed automatically.<br><br>
            If you have any questions, contact us at <a href="mailto:support@lumapos.co">support@lumapos.co</a>.
          `,
          security_notice: true,
        });

        await query(
          `UPDATE users SET deletion_reminder_sent = true WHERE id = $1`,
          [user.id]
        );
        // Invalidate both user cache keys (CLAUDE.md requirement on every users UPDATE).
        await cacheService.del(CacheKeys.user(user.id));
        if (user.email) await cacheService.del(CacheKeys.userByEmail(user.email));

        logger.info('Sent deletion reminder email', {
          userId: user.id,
          email: user.email,
          deletionDate: formattedDate,
        });
      } catch (userError) {
        logger.error('Failed to send deletion reminder', {
          userId: user.id,
          email: user.email,
          error: userError,
        });
      }
    }
  } catch (error) {
    logger.error('Failed to process deletion reminders', { error });
  }
}

// --- Process actual deletions ---

interface DeletionCandidate {
  id: string;
  email: string;
  first_name: string | null;
  cognito_user_id: string | null;
  stripe_customer_id: string | null;
  organization_id: string;
  stripe_account_id: string | null;
}

async function processAccountDeletions() {
  try {
    // Find users where deletion was requested more than 30 days ago
    // Join with organizations to get Stripe Connect account ID
    const candidates = await query<DeletionCandidate>(
      `SELECT u.id, u.email, u.first_name, u.cognito_user_id, u.stripe_customer_id,
              u.organization_id, o.stripe_account_id
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.deletion_requested_at IS NOT NULL
         AND u.deletion_requested_at < NOW() - INTERVAL '30 days'
         AND u.is_active = false`,
    );

    if (candidates.length === 0) return;

    logger.info('Processing account deletions', { count: candidates.length });

    for (const user of candidates) {
      try {
        // 1. Cancel any active Stripe subscriptions
        if (user.stripe_customer_id) {
          try {
            const subscriptions = await stripe.subscriptions.list({
              customer: user.stripe_customer_id,
              status: 'active',
            });
            for (const sub of subscriptions.data) {
              await stripe.subscriptions.cancel(sub.id);
              logger.info('Canceled Stripe subscription for deleted user', {
                userId: user.id,
                subscriptionId: sub.id,
              });
            }
          } catch (stripeError) {
            logger.error('Failed to cancel Stripe subscriptions', {
              userId: user.id,
              error: stripeError,
            });
          }
        }

        // 2. Deactivate Stripe Connect account (reject charges & payouts, keep for tax records)
        if (user.stripe_account_id) {
          try {
            await stripe.accounts.update(user.stripe_account_id, {
              settings: {
                payouts: { schedule: { interval: 'manual' as const } },
              },
            });
            // Reject the account with reason 'other' — prevents new charges/payouts
            await stripe.accounts.reject(user.stripe_account_id, { reason: 'other' });
            logger.info('Deactivated Stripe Connect account for deleted user', {
              userId: user.id,
              stripeAccountId: user.stripe_account_id,
            });
          } catch (stripeConnectError) {
            logger.error('Failed to deactivate Stripe Connect account', {
              userId: user.id,
              stripeAccountId: user.stripe_account_id,
              error: stripeConnectError,
            });
          }
        }

        // 3. Delete from Cognito
        if (user.cognito_user_id && config.aws.cognito.userPoolId) {
          try {
            await cognitoService.deleteUser(user.cognito_user_id);
          } catch (cognitoError: any) {
            if (cognitoError.name !== 'UserNotFoundException') {
              logger.error('Failed to delete user from Cognito', {
                userId: user.id,
                error: cognitoError,
              });
            }
          }
        }

        // 3. Delete subscriptions for the org
        await query(
          `DELETE FROM subscriptions WHERE organization_id = $1`,
          [user.organization_id]
        );

        // 4. Delete the user (cascades to sessions, password_reset_tokens, etc.)
        await query(`DELETE FROM users WHERE id = $1`, [user.id]);

        // 5. Invalidate cache
        await cacheService.del(CacheKeys.user(user.id));
        await cacheService.del(CacheKeys.userByEmail(user.email));

        logger.info('Account permanently deleted', {
          userId: user.id,
          email: user.email,
          organizationId: user.organization_id,
        });

        // 6. Send final confirmation email to user
        try {
          await sendTemplatedEmail(user.email, {
            subject: 'Your Luma Account Has Been Deleted',
            preheader_text: 'Your account and data have been permanently removed',
            email_title: 'Account Deleted',
            email_content: `
              Hi ${user.first_name || 'there'},<br><br>
              Your Luma account and all associated data have been permanently deleted as requested.<br><br>
              If you'd like to use Luma again in the future, you're welcome to create a new account at any time.<br><br>
              Thank you for being a Luma customer.
            `,
          });
        } catch (emailError) {
          // Non-critical — account is already deleted
          logger.warn('Failed to send deletion confirmation email', {
            email: user.email,
            error: emailError,
          });
        }

        // 7. Notify support that deletion was processed
        try {
          const supportEmail = process.env.SUPPORT_EMAIL || 'support@lumapos.co';
          await emailService.sendEmail({
            to: supportEmail,
            subject: `Account Deleted — ${user.email}`,
            html: `
              <h2>Account Permanently Deleted</h2>
              <p>The following account has been permanently deleted by the scheduled deletion job.</p>
              <table style="border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">User ID:</td><td>${user.id}</td></tr>
                <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Email:</td><td>${user.email}</td></tr>
                <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Organization ID:</td><td>${user.organization_id}</td></tr>
                <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Stripe Connect:</td><td>${user.stripe_account_id ? 'Rejected' : 'N/A'}</td></tr>
              </table>
            `,
          });
        } catch (emailError) {
          logger.warn('Failed to send support deletion notification', { error: emailError });
        }
      } catch (userError) {
        logger.error('Failed to delete user account', {
          userId: user.id,
          email: user.email,
          error: userError,
        });
        // Continue with next user
      }
    }

    logger.info('Account deletion batch complete', {
      processed: candidates.length,
    });
  } catch (error) {
    logger.error('Failed to process account deletions', { error });
  }
}

export function startAccountDeletionJob() {
  // One replica per tick (Redis leader lock) — otherwise every replica issues
  // the Stripe cancel/reject + deletion emails. 30-min TTL, well under 6h.
  const reminderTick = () => runLeaderTask('acct:deletion-reminders', 1800, sendDeletionReminders);
  const deletionTick = () => runLeaderTask('acct:process-deletions', 1800, processAccountDeletions);

  // Run once on startup (still leader-guarded)
  reminderTick();
  deletionTick();

  // Then every 6 hours
  intervals.push(
    setInterval(reminderTick, SIX_HOURS),
    setInterval(deletionTick, SIX_HOURS),
  );

  logger.info('Account deletion job started', { interval: '6h', reminders: '6h' });
}

export function stopAccountDeletionJob() {
  intervals.forEach(clearInterval);
  intervals.length = 0;
}
