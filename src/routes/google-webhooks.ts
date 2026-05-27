import { Hono } from 'hono';
import { google, androidpublisher_v3 } from 'googleapis';
import { logger } from '../utils/logger';
import { query } from '../db';
import { config } from '../config';
import { DEFAULT_FEATURES_BY_TIER, PRICING_BY_TIER } from '../db/models/subscription';
import { staffService } from '../services/staff';
import { socketService, SocketEvents } from '../services/socket';
import { cacheService, CacheKeys } from '../services/redis/cache';
import { redisService } from '../services/redis';
import { clawbackSubscriptionEarnings } from '../services/referrals';

const app = new Hono();

/**
 * Google Play Developer Notifications (Real-Time Developer Notifications - RTDN)
 *
 * This endpoint receives push notifications from Google Cloud Pub/Sub.
 * Google sends subscription events as base64-encoded messages.
 *
 * Environment handling:
 * - Development: Only processes test/sandbox purchases (from License Testers)
 * - Production: Only processes real purchases
 *
 * See: https://developer.android.com/google/play/billing/rtdn-reference
 */

// ============================================================================
// Google Play API Client
// ============================================================================

let playClient: androidpublisher_v3.Androidpublisher | null = null;

function getPlayClient(): androidpublisher_v3.Androidpublisher | null {
  if (playClient) return playClient;

  const credentialsRaw = config.googlePlay.credentials;

  logger.info('[GoogleWebhook] Checking Google Play credentials', {
    hasCredentials: !!credentialsRaw,
    credentialsLength: credentialsRaw?.length || 0,
    credentialsPreview: credentialsRaw ? credentialsRaw.substring(0, 50) + '...' : 'EMPTY',
    packageName: config.googlePlay.packageName,
  });

  if (!credentialsRaw) {
    logger.warn('[GoogleWebhook] GOOGLE_PLAY_CREDENTIALS not configured - cannot validate purchases');
    return null;
  }

  try {
    logger.info('[GoogleWebhook] Parsing credentials JSON...');
    const credentials = JSON.parse(credentialsRaw);

    logger.info('[GoogleWebhook] Credentials parsed successfully', {
      type: credentials.type,
      projectId: credentials.project_id,
      clientEmail: credentials.client_email,
      hasPrivateKey: !!credentials.private_key,
      privateKeyLength: credentials.private_key?.length || 0,
    });

    logger.info('[GoogleWebhook] Creating GoogleAuth...');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    logger.info('[GoogleWebhook] Creating androidpublisher client...');
    playClient = google.androidpublisher({ version: 'v3', auth });
    logger.info('[GoogleWebhook] Google Play API client initialized successfully');
    return playClient;
  } catch (error: any) {
    logger.error('[GoogleWebhook] Failed to initialize Google Play API client', {
      errorMessage: error?.message || 'Unknown error',
      errorName: error?.name || 'Unknown',
      errorStack: error?.stack?.substring(0, 500) || 'No stack',
    });
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

interface GooglePubSubMessage {
  message: {
    attributes?: Record<string, string>;
    data: string; // base64-encoded
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

interface GoogleDeveloperNotification {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: GoogleSubscriptionNotification;
  oneTimeProductNotification?: GoogleOneTimeProductNotification;
  testNotification?: GoogleTestNotification;
}

interface GoogleSubscriptionNotification {
  version: string;
  notificationType: GoogleSubscriptionNotificationType;
  purchaseToken: string;
  subscriptionId: string;
}

interface GoogleOneTimeProductNotification {
  version: string;
  notificationType: number;
  purchaseToken: string;
  sku: string;
}

interface GoogleTestNotification {
  version: string;
}

// Google Subscription Notification Types
// Reference: https://developer.android.com/google/play/billing/rtdn-reference
enum GoogleSubscriptionNotificationType {
  SUBSCRIPTION_RECOVERED = 1,             // Recovered from account hold or resumed from pause
  SUBSCRIPTION_RENEWED = 2,               // Active subscription renewed
  SUBSCRIPTION_CANCELED = 3,              // Subscription canceled (voluntarily or involuntarily)
  SUBSCRIPTION_PURCHASED = 4,             // New subscription purchased
  SUBSCRIPTION_ON_HOLD = 5,               // Subscription entered account hold (payment issue)
  SUBSCRIPTION_IN_GRACE_PERIOD = 6,       // Subscription entered grace period
  SUBSCRIPTION_RESTARTED = 7,             // User restored subscription from Play Store
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED = 8, // Price change confirmed (deprecated)
  SUBSCRIPTION_DEFERRED = 9,              // Subscription deferred
  SUBSCRIPTION_PAUSED = 10,               // Subscription paused
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED = 11, // Pause schedule changed
  SUBSCRIPTION_REVOKED = 12,              // Subscription revoked (refunded)
  SUBSCRIPTION_EXPIRED = 13,              // Subscription expired
  SUBSCRIPTION_PENDING_PURCHASE_CANCELED = 20, // Pending purchase canceled
}

// Map notification type to readable name for logging
const NOTIFICATION_TYPE_NAMES: Record<number, string> = {
  1: 'SUBSCRIPTION_RECOVERED',
  2: 'SUBSCRIPTION_RENEWED',
  3: 'SUBSCRIPTION_CANCELED',
  4: 'SUBSCRIPTION_PURCHASED',
  5: 'SUBSCRIPTION_ON_HOLD',
  6: 'SUBSCRIPTION_IN_GRACE_PERIOD',
  7: 'SUBSCRIPTION_RESTARTED',
  8: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED',
  9: 'SUBSCRIPTION_DEFERRED',
  10: 'SUBSCRIPTION_PAUSED',
  11: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED',
  12: 'SUBSCRIPTION_REVOKED',
  13: 'SUBSCRIPTION_EXPIRED',
  20: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED',
};

// ============================================================================
// Purchase Validation
// ============================================================================

interface PurchaseValidation {
  isValid: boolean;
  isTestPurchase: boolean;
  expiryTimeMillis?: string;
  startTimeMillis?: string;
  autoRenewing?: boolean;
  paymentState?: number;
  cancelReason?: number;
  userCancellationTimeMillis?: string;
  error?: string;
}

/**
 * Validate a subscription purchase with Google Play API
 * Also determines if it's a test purchase (from License Testers)
 */
async function validateSubscriptionPurchase(
  packageName: string,
  subscriptionId: string,
  purchaseToken: string
): Promise<PurchaseValidation> {
  const client = getPlayClient();

  if (!client) {
    logger.warn('[GoogleWebhook] Cannot validate purchase - API client not configured');
    return { isValid: false, isTestPurchase: false, error: 'API client not configured' };
  }

  try {
    logger.debug('[GoogleWebhook] Validating subscription purchase', {
      packageName,
      subscriptionId,
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });

    // Use subscriptionsv2 API for better information
    const response = await client.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    const purchase = response.data;

    logger.info('[GoogleWebhook] Purchase validation response', {
      acknowledgementState: purchase.acknowledgementState,
      subscriptionState: purchase.subscriptionState,
      testPurchase: purchase.testPurchase,
      lineItems: purchase.lineItems?.length,
    });

    // testPurchase is present (even if empty object) for License Tester purchases
    const isTestPurchase = purchase.testPurchase !== undefined && purchase.testPurchase !== null;

    // Get expiry from line items (new API structure)
    const lineItem = purchase.lineItems?.[0];
    const expiryTimeMillis = lineItem?.expiryTime ?? undefined; // Convert null to undefined
    const autoRenewing = lineItem?.autoRenewingPlan !== undefined;

    return {
      isValid: true,
      isTestPurchase,
      expiryTimeMillis,
      autoRenewing,
    };
  } catch (error: any) {
    logger.error('[GoogleWebhook] Purchase validation failed', {
      error: error.message,
      code: error.code,
      packageName,
      subscriptionId,
    });

    return {
      isValid: false,
      isTestPurchase: false,
      error: error.message || 'Validation failed',
    };
  }
}

// ============================================================================
// Webhook Handler
// ============================================================================

app.post('/google/webhook', async (c) => {
  const rawBody = await c.req.text();
  const isProd = config.env === 'production';

  // Authenticate the Pub/Sub push request via the shared token appended to the
  // subscription's push endpoint URL (?token=...). Enforced only when the token
  // is configured, so enabling it is a deliberate step (set the env AND add the
  // token to the Pub/Sub subscription) that won't silently break billing sync.
  const expectedToken = config.googlePlay.pubsubVerificationToken;
  if (expectedToken) {
    if (c.req.query('token') !== expectedToken) {
      logger.warn('[GoogleWebhook] Rejected: missing/invalid verification token');
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } else if (isProd) {
    logger.warn('[GoogleWebhook] GOOGLE_PUBSUB_VERIFICATION_TOKEN not set — endpoint is UNAUTHENTICATED. Set it and add ?token= to the Pub/Sub push URL.');
  }

  logger.info('[GoogleWebhook] ========== NOTIFICATION RECEIVED ==========');
  logger.info('[GoogleWebhook] Environment', {
    env: config.env,
    isProd,
    contentLength: rawBody.length,
  });

  try {
    const pubsubMessage: GooglePubSubMessage = JSON.parse(rawBody);

    logger.debug('[GoogleWebhook] Pub/Sub message', {
      messageId: pubsubMessage.message?.messageId,
      subscription: pubsubMessage.subscription,
    });

    if (!pubsubMessage.message?.data) {
      logger.error('[GoogleWebhook] No data in Pub/Sub message');
      return c.json({ error: 'Missing message data' }, 400);
    }

    // Decode base64 message data
    const decodedData = Buffer.from(pubsubMessage.message.data, 'base64').toString('utf-8');
    const notification: GoogleDeveloperNotification = JSON.parse(decodedData);

    logger.info('[GoogleWebhook] Notification decoded', {
      packageName: notification.packageName,
      eventTime: notification.eventTimeMillis,
      hasSubscriptionNotification: !!notification.subscriptionNotification,
      hasOneTimeNotification: !!notification.oneTimeProductNotification,
      hasTestNotification: !!notification.testNotification,
    });

    // Idempotency check: skip if we've already processed this message
    const isNew = await redisService.setNX(`luma:webhook:google:${pubsubMessage.message.messageId}`, '1', 86400);
    if (!isNew) {
      logger.info('Google webhook already processed, skipping', { messageId: pubsubMessage.message.messageId });
      return c.json({ received: true });
    }

    // Handle test notification (from Play Console "Send test notification" button)
    if (notification.testNotification) {
      logger.info('[GoogleWebhook] Test notification received (Play Console verification)', {
        version: notification.testNotification.version,
        env: config.env,
      });
      return c.json({ received: true, type: 'test_notification' });
    }

    // Handle subscription notification
    if (notification.subscriptionNotification) {
      const subNotification = notification.subscriptionNotification;
      const notificationTypeName = NOTIFICATION_TYPE_NAMES[subNotification.notificationType] || 'UNKNOWN';

      logger.info('[GoogleWebhook] Subscription notification', {
        type: subNotification.notificationType,
        typeName: notificationTypeName,
        subscriptionId: subNotification.subscriptionId,
        purchaseToken: subNotification.purchaseToken.substring(0, 20) + '...',
      });

      // Validate purchase and check if it's a test purchase
      const validation = await validateSubscriptionPurchase(
        notification.packageName,
        subNotification.subscriptionId,
        subNotification.purchaseToken
      );

      logger.info('[GoogleWebhook] Purchase validation result', {
        isValid: validation.isValid,
        isTestPurchase: validation.isTestPurchase,
        error: validation.error,
      });

      // Environment filtering
      if (isProd && validation.isTestPurchase) {
        logger.info('[GoogleWebhook] Ignoring TEST purchase in PRODUCTION environment', {
          typeName: notificationTypeName,
          subscriptionId: subNotification.subscriptionId,
        });
        return c.json({ received: true, skipped: true, reason: 'test_purchase_in_prod' });
      }

      if (!isProd && !validation.isTestPurchase && validation.isValid) {
        logger.info('[GoogleWebhook] Ignoring REAL purchase in DEVELOPMENT environment', {
          typeName: notificationTypeName,
          subscriptionId: subNotification.subscriptionId,
        });
        return c.json({ received: true, skipped: true, reason: 'real_purchase_in_dev' });
      }

      // Process the notification
      logger.info('[GoogleWebhook] Processing notification', {
        typeName: notificationTypeName,
        isTestPurchase: validation.isTestPurchase,
        env: config.env,
      });

      await handleGoogleSubscriptionNotification(subNotification, validation);

      logger.info('[GoogleWebhook] ========== NOTIFICATION PROCESSED ==========');
    }

    // Handle one-time product notification (not used for subscriptions)
    if (notification.oneTimeProductNotification) {
      logger.info('[GoogleWebhook] One-time product notification received (not processed)', {
        sku: notification.oneTimeProductNotification.sku,
      });
    }

    return c.json({ received: true });

  } catch (error: any) {
    logger.error('[GoogleWebhook] ========== ERROR PROCESSING WEBHOOK ==========', {
      error: error.message,
      stack: error.stack,
    });
    // Return 200 to prevent Google from retrying — idempotency key is already set,
    // and retries after TTL expiry could cause duplicate processing
    return c.json({ received: true });
  }
});

// ============================================================================
// Notification Handlers
// ============================================================================

async function handleGoogleSubscriptionNotification(
  notification: GoogleSubscriptionNotification,
  validation: PurchaseValidation
) {
  const { notificationType, purchaseToken, subscriptionId } = notification;
  const typeName = NOTIFICATION_TYPE_NAMES[notificationType] || 'UNKNOWN';

  logger.info('[GoogleWebhook] Processing subscription notification', {
    notificationType,
    typeName,
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  switch (notificationType) {
    case GoogleSubscriptionNotificationType.SUBSCRIPTION_PURCHASED:
      await handleGoogleSubscribed(purchaseToken, subscriptionId, validation);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_RENEWED:
      await handleGoogleRenewed(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_RECOVERED:
      await handleGoogleRecovered(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_RESTARTED:
      await handleGoogleRestarted(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_CANCELED:
      await handleGoogleCanceled(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_EXPIRED:
      await handleGoogleExpired(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_ON_HOLD:
      await handleGoogleOnHold(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_IN_GRACE_PERIOD:
      await handleGoogleGracePeriod(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_PAUSED:
      await handleGooglePaused(purchaseToken, subscriptionId);
      break;

    case GoogleSubscriptionNotificationType.SUBSCRIPTION_REVOKED:
      await handleGoogleRevoked(purchaseToken, subscriptionId);
      break;

    default:
      logger.info('[GoogleWebhook] Unhandled notification type', {
        notificationType,
        typeName,
        subscriptionId,
      });
  }
}

async function handleGoogleSubscribed(
  purchaseToken: string,
  subscriptionId: string,
  validation: PurchaseValidation
) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_PURCHASED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
    isTestPurchase: validation.isTestPurchase,
  });

  // Find subscription by Google purchase token
  const subRows = await query(
    `SELECT s.*, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  if (subRows.length === 0) {
    // Subscription should have been created during purchase validation in the app
    logger.warn('[GoogleWebhook] Subscription not found for purchase token', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
      subscriptionId,
    });
    return;
  }

  const sub = subRows[0];

  logger.info('[GoogleWebhook] Found subscription to update', {
    subscriptionId: sub.id,
    organizationId: sub.organization_id,
    currentTier: sub.tier,
    currentStatus: sub.status,
  });

  await query(
    `UPDATE subscriptions
     SET status = 'active',
         tier = 'pro',
         monthly_price = $1,
         transaction_fee_rate = $2,
         features = $3,
         cancel_at = NULL,
         canceled_at = NULL,
         updated_at = NOW()
     WHERE id = $4`,
    [
      1900, // $19.00
      PRICING_BY_TIER.pro.transaction_fee_rate,
      DEFAULT_FEATURES_BY_TIER.pro,
      sub.id,
    ]
  );

  // Invalidate user cache since subscription data is included in /auth/me
  await cacheService.del(CacheKeys.user(sub.user_id));
  if (sub.user_email) {
    await cacheService.del(CacheKeys.userByEmail(sub.user_email));
  }

  logger.info('[GoogleWebhook] Subscription updated to Pro', {
    subscriptionId: sub.id,
    organizationId: sub.organization_id,
  });

  // Emit socket event for real-time updates
  socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
    status: 'active',
    tier: 'pro',
    platform: 'google',
  });

  // Enable staff accounts
  try {
    await staffService.enableAllStaff(sub.organization_id);
    logger.info('[GoogleWebhook] Staff accounts enabled', { organizationId: sub.organization_id });
  } catch (error) {
    logger.error('[GoogleWebhook] Failed to enable staff accounts', {
      error,
      organizationId: sub.organization_id,
    });
  }
}

async function handleGoogleRenewed(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_RENEWED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  // Get subscription info before update
  const subRows = await query(
    `SELECT s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  const rows = await query(
    `UPDATE subscriptions
     SET status = 'active',
         updated_at = NOW()
     WHERE google_purchase_token = $1
     RETURNING id, organization_id`,
    [purchaseToken]
  );

  if (rows.length > 0) {
    // Invalidate user cache since subscription data is included in /auth/me
    if (subRows.length > 0) {
      await cacheService.del(CacheKeys.user(subRows[0].user_id));
      if (subRows[0].user_email) {
        await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
      }
    }

    logger.info('[GoogleWebhook] Subscription renewed', {
      subscriptionId: rows[0].id,
      organizationId: rows[0].organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(rows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'active',
      tier: 'pro',
      platform: 'google',
    });
  } else {
    logger.warn('[GoogleWebhook] No subscription found to renew', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGoogleRecovered(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_RECOVERED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  const subRows = await query(
    `SELECT s.*, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  if (subRows.length > 0) {
    const sub = subRows[0];

    await query(
      `UPDATE subscriptions
       SET status = 'active',
           tier = 'pro',
           features = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [DEFAULT_FEATURES_BY_TIER.pro, sub.id]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }

    logger.info('[GoogleWebhook] Subscription recovered', {
      subscriptionId: sub.id,
      organizationId: sub.organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'active',
      tier: 'pro',
      platform: 'google',
    });

    // Re-enable staff accounts
    try {
      await staffService.enableAllStaff(sub.organization_id);
      logger.info('[GoogleWebhook] Staff accounts re-enabled', { organizationId: sub.organization_id });
    } catch (error) {
      logger.error('[GoogleWebhook] Failed to enable staff accounts', {
        error,
        organizationId: sub.organization_id,
      });
    }
  } else {
    logger.warn('[GoogleWebhook] No subscription found to recover', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGoogleRestarted(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_RESTARTED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });
  // Same handling as recovered
  await handleGoogleRecovered(purchaseToken, subscriptionId);
}

async function handleGoogleCanceled(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_CANCELED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  // Get subscription info before update
  const subRows = await query(
    `SELECT s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  // Get expiration date from Google Play API
  const client = getPlayClient();
  let expiryTime: Date | null = null;

  if (client && config.googlePlay.packageName) {
    try {
      const response = await client.purchases.subscriptionsv2.get({
        packageName: config.googlePlay.packageName,
        token: purchaseToken,
      });

      const lineItem = response.data.lineItems?.[0];
      if (lineItem?.expiryTime) {
        expiryTime = new Date(lineItem.expiryTime);
        logger.info('[GoogleWebhook] Got expiry time from Google Play API', {
          expiryTime: expiryTime.toISOString(),
        });
      }
    } catch (error: any) {
      logger.warn('[GoogleWebhook] Could not get expiry time from Google Play API', {
        error: error.message,
      });
    }
  }

  // User canceled but subscription remains active until period ends
  const rows = await query(
    `UPDATE subscriptions
     SET canceled_at = NOW(),
         cancel_at = $2,
         updated_at = NOW()
     WHERE google_purchase_token = $1
     RETURNING id, organization_id, current_period_end`,
    [purchaseToken, expiryTime]
  );

  if (rows.length > 0) {
    // Invalidate user cache since subscription data is included in /auth/me
    if (subRows.length > 0) {
      await cacheService.del(CacheKeys.user(subRows[0].user_id));
      if (subRows[0].user_email) {
        await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
      }
    }

    logger.info('[GoogleWebhook] Subscription marked as canceled', {
      subscriptionId: rows[0].id,
      organizationId: rows[0].organization_id,
      activeUntil: expiryTime?.toISOString() || rows[0].current_period_end,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(rows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'active', // Still active until period ends
      tier: 'pro',
      platform: 'google',
      canceledAt: new Date().toISOString(),
      cancelAt: expiryTime?.toISOString() || null,
    });
  } else {
    logger.warn('[GoogleWebhook] No subscription found to cancel', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGoogleExpired(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_EXPIRED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  const subRows = await query(
    `SELECT s.*, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  if (subRows.length > 0) {
    const sub = subRows[0];

    await query(
      `UPDATE subscriptions
       SET status = 'canceled',
           tier = 'starter',
           features = $1,
           canceled_at = COALESCE(canceled_at, NOW()),
           updated_at = NOW()
       WHERE id = $2`,
      [DEFAULT_FEATURES_BY_TIER.starter, sub.id]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }

    logger.info('[GoogleWebhook] Subscription expired and downgraded to Starter', {
      subscriptionId: sub.id,
      organizationId: sub.organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'canceled',
      tier: 'starter',
      platform: 'google',
    });

    // Disable staff accounts
    try {
      await staffService.disableAllStaff(sub.organization_id);
      logger.info('[GoogleWebhook] Staff accounts disabled', { organizationId: sub.organization_id });
    } catch (error) {
      logger.error('[GoogleWebhook] Failed to disable staff accounts', {
        error,
        organizationId: sub.organization_id,
      });
    }
  } else {
    logger.warn('[GoogleWebhook] No subscription found to expire', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGoogleOnHold(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_ON_HOLD', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  // Get subscription info before update
  const subRows = await query(
    `SELECT s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  // Account hold due to payment issue
  const rows = await query(
    `UPDATE subscriptions
     SET status = 'past_due',
         updated_at = NOW()
     WHERE google_purchase_token = $1
     RETURNING id, organization_id`,
    [purchaseToken]
  );

  if (rows.length > 0) {
    // Invalidate user cache since subscription data is included in /auth/me
    if (subRows.length > 0) {
      await cacheService.del(CacheKeys.user(subRows[0].user_id));
      if (subRows[0].user_email) {
        await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
      }
    }

    logger.info('[GoogleWebhook] Subscription placed on hold', {
      subscriptionId: rows[0].id,
      organizationId: rows[0].organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(rows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'past_due',
      tier: 'pro',
      platform: 'google',
    });
  } else {
    logger.warn('[GoogleWebhook] No subscription found for on-hold', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGoogleGracePeriod(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_IN_GRACE_PERIOD', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  // Get subscription info before update
  const subRows = await query(
    `SELECT s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  // Grace period - subscription still active but payment failing
  const rows = await query(
    `UPDATE subscriptions
     SET status = 'past_due',
         updated_at = NOW()
     WHERE google_purchase_token = $1
     RETURNING id, organization_id`,
    [purchaseToken]
  );

  if (rows.length > 0) {
    // Invalidate user cache since subscription data is included in /auth/me
    if (subRows.length > 0) {
      await cacheService.del(CacheKeys.user(subRows[0].user_id));
      if (subRows[0].user_email) {
        await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
      }
    }

    logger.info('[GoogleWebhook] Subscription in grace period', {
      subscriptionId: rows[0].id,
      organizationId: rows[0].organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(rows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'past_due',
      tier: 'pro',
      platform: 'google',
    });
  } else {
    logger.warn('[GoogleWebhook] No subscription found for grace period', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGooglePaused(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_PAUSED', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  const subRows = await query(
    `SELECT s.*, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  if (subRows.length > 0) {
    const sub = subRows[0];

    await query(
      `UPDATE subscriptions
       SET status = 'paused',
           tier = 'starter',
           features = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [DEFAULT_FEATURES_BY_TIER.starter, sub.id]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }

    logger.info('[GoogleWebhook] Subscription paused and downgraded to Starter', {
      subscriptionId: sub.id,
      organizationId: sub.organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'paused',
      tier: 'starter',
      platform: 'google',
    });

    // Disable staff accounts during pause
    try {
      await staffService.disableAllStaff(sub.organization_id);
      logger.info('[GoogleWebhook] Staff accounts disabled', { organizationId: sub.organization_id });
    } catch (error) {
      logger.error('[GoogleWebhook] Failed to disable staff accounts', {
        error,
        organizationId: sub.organization_id,
      });
    }
  } else {
    logger.warn('[GoogleWebhook] No subscription found to pause', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

async function handleGoogleRevoked(purchaseToken: string, subscriptionId: string) {
  logger.info('[GoogleWebhook] Processing SUBSCRIPTION_REVOKED (refunded)', {
    purchaseToken: purchaseToken.substring(0, 20) + '...',
    subscriptionId,
  });

  const subRows = await query(
    `SELECT s.*, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.google_purchase_token = $1`,
    [purchaseToken]
  );

  if (subRows.length > 0) {
    const sub = subRows[0];

    await query(
      `UPDATE subscriptions
       SET status = 'canceled',
           tier = 'starter',
           features = $1,
           canceled_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [DEFAULT_FEATURES_BY_TIER.starter, sub.id]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }

    logger.info('[GoogleWebhook] Subscription revoked (refunded) and downgraded to Starter', {
      subscriptionId: sub.id,
      organizationId: sub.organization_id,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'canceled',
      tier: 'starter',
      platform: 'google',
    });

    // Disable staff accounts
    try {
      await staffService.disableAllStaff(sub.organization_id);
      logger.info('[GoogleWebhook] Staff accounts disabled', { organizationId: sub.organization_id });
    } catch (error) {
      logger.error('[GoogleWebhook] Failed to disable staff accounts', {
        error,
        organizationId: sub.organization_id,
      });
    }

    // Clawback any pending/available referral earnings for this user
    try {
      await clawbackSubscriptionEarnings(sub.user_id, 'Google subscription revoked');
    } catch (err) {
      logger.error('[GoogleWebhook] Failed to clawback referral earnings', { error: err, userId: sub.user_id });
    }
  } else {
    logger.warn('[GoogleWebhook] No subscription found to revoke', {
      purchaseToken: purchaseToken.substring(0, 20) + '...',
    });
  }
}

export default app;
