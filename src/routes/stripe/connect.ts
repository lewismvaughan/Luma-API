import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query, transaction } from '../../db';
import { StripeConnectedAccount, ConnectOnboardingState } from '../../db/models';
import { stripe, stripeService } from '../../services/stripe';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { socketService, SocketEvents } from '../../services/socket';
import { emailService } from '../../services/email';
import { queueService, QueueName } from '../../services/queue';
import { getImageUrl } from '../../services/images';
import { cacheService } from '../../services/redis/cache';
import { getOrgCurrency, formatCurrency as formatCurrencyUtil, fromSmallestUnit, toSmallestUnit } from '../../utils/currency';
import Stripe from 'stripe';

const app = new OpenAPIHono();

// Helper function to derive onboarding state from Stripe account
function deriveOnboardingState(account: Stripe.Account): ConnectOnboardingState {
  if (!account.details_submitted) {
    return 'not_started';
  }

  if (account.requirements?.disabled_reason) {
    return 'disabled';
  }

  if (account.requirements?.past_due && account.requirements.past_due.length > 0) {
    return 'restricted';
  }

  if (account.charges_enabled && account.payouts_enabled) {
    if (account.requirements?.currently_due && account.requirements.currently_due.length > 0) {
      return 'pending_verification';
    }
    return 'active';
  }

  if (account.requirements?.currently_due && account.requirements.currently_due.length > 0) {
    return 'incomplete';
  }

  return 'pending_verification';
}

// Helper function to update local DB from Stripe account
async function syncAccountFromStripe(account: Stripe.Account, organizationId: string) {
  const onboardingState = deriveOnboardingState(account);
  const isComplete = onboardingState === 'active';

  // Get external account info if available
  let externalAccountLast4: string | null = null;
  let externalAccountBankName: string | null = null;
  let externalAccountType: string | null = null;
  let externalAccountStatus: string | null = null;

  if (account.external_accounts?.data && account.external_accounts.data.length > 0) {
    const externalAccount = account.external_accounts.data[0];
    if (externalAccount.object === 'bank_account') {
      externalAccountLast4 = externalAccount.last4 || null;
      externalAccountBankName = externalAccount.bank_name || null;
      externalAccountType = 'bank_account';
      externalAccountStatus = (externalAccount as any).status || null;
    } else if (externalAccount.object === 'card') {
      externalAccountLast4 = externalAccount.last4 || null;
      externalAccountBankName = externalAccount.brand || null;
      externalAccountType = 'card';
    }
  }

  // Check for recent failed payouts to determine payout status
  // Only mark as undeliverable if the MOST RECENT payout failed AND was to the current bank account
  let payoutStatus: string | null = 'active';
  let payoutFailureCode: string | null = null;
  let payoutFailureMessage: string | null = null;

  try {
    const recentPayouts = await stripe.payouts.list(
      { limit: 1 },
      { stripeAccount: account.id }
    );

    // Only check the most recent payout - if it failed, there's likely still an issue
    const mostRecentPayout = recentPayouts.data[0];
    if (mostRecentPayout && mostRecentPayout.status === 'failed') {
      // Check if the failed payout was to the current external account
      // If user changed bank accounts, don't show warning for old bank's failure
      const failedDestination = mostRecentPayout.destination as string | null;
      const currentExternalAccountId = account.external_accounts?.data[0]?.id;

      // Only show warning if the failed payout was to the current bank account
      // or if we can't determine the destination (be safe and show warning)
      if (!failedDestination || !currentExternalAccountId || failedDestination === currentExternalAccountId) {
        payoutStatus = 'undeliverable';
        payoutFailureCode = mostRecentPayout.failure_code || null;
        payoutFailureMessage = mostRecentPayout.failure_message || null;
      }
    }
  } catch (error) {
    logger.warn('Failed to check payout status', { accountId: account.id, error });
  }

  const queryParams = [
    organizationId,
    account.id,
    account.type || 'standard',
    account.charges_enabled,
    account.payouts_enabled,
    account.details_submitted,
    JSON.stringify(account.requirements?.currently_due || []),
    JSON.stringify(account.requirements?.eventually_due || []),
    JSON.stringify(account.requirements?.past_due || []),
    account.requirements?.disabled_reason || null,
    onboardingState,
    account.country || 'US',
    account.default_currency || 'usd',
    account.business_type || null,
    account.business_profile?.name || (account as any).company?.name || null,
    externalAccountLast4,
    externalAccountBankName,
    externalAccountType,
    externalAccountStatus,
    payoutStatus,
    payoutFailureCode,
    payoutFailureMessage,
    isComplete,
  ];

  logger.info('syncAccountFromStripe query params', {
    params: queryParams.map((p, i) => ({ [`$${i + 1}`]: p, type: typeof p })),
  });

  await transaction(async (client) => {
    // Upsert the stripe_connected_accounts record
    await client.query(
      `INSERT INTO stripe_connected_accounts (
        organization_id,
        stripe_account_id,
        account_type,
        charges_enabled,
        payouts_enabled,
        details_submitted,
        requirements_currently_due,
        requirements_eventually_due,
        requirements_past_due,
        requirements_disabled_reason,
        onboarding_state,
        country,
        default_currency,
        business_type,
        business_name,
        external_account_last4,
        external_account_bank_name,
        external_account_type,
        external_account_status,
        payout_status,
        payout_failure_code,
        payout_failure_message,
        onboarding_completed_at,
        last_stripe_sync_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, CASE WHEN $23 THEN NOW() ELSE NULL END, NOW())
      ON CONFLICT (organization_id) DO UPDATE SET
        charges_enabled = $4,
        payouts_enabled = $5,
        details_submitted = $6,
        requirements_currently_due = $7::jsonb,
        requirements_eventually_due = $8::jsonb,
        requirements_past_due = $9::jsonb,
        requirements_disabled_reason = $10,
        onboarding_state = $11,
        country = $12,
        default_currency = $13,
        business_type = $14,
        business_name = $15,
        external_account_last4 = $16,
        external_account_bank_name = $17,
        external_account_type = $18,
        external_account_status = $19,
        payout_status = $20,
        payout_failure_code = $21,
        payout_failure_message = $22,
        onboarding_completed_at = CASE WHEN $23 AND stripe_connected_accounts.onboarding_completed_at IS NULL THEN NOW() ELSE stripe_connected_accounts.onboarding_completed_at END,
        last_stripe_sync_at = NOW(),
        updated_at = NOW()`,
      queryParams
    );

    // Also update the organization's stripe fields and currency for backward compatibility
    await client.query(
      `UPDATE organizations SET
        stripe_account_id = $1,
        stripe_onboarding_completed = $2,
        currency = COALESCE(NULLIF($4, ''), currency),
        updated_at = NOW()
      WHERE id = $3`,
      [account.id, isComplete, organizationId, account.default_currency || null]
    );
  });

  return onboardingState;
}

// ============================================
// GET /stripe/connect/status - Check onboarding status
// ============================================
const getConnectStatusRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/status',
  summary: 'Get Stripe Connect onboarding status',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Connect status retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            hasConnectedAccount: z.boolean(),
            onboardingComplete: z.boolean(),
            onboardingState: z.enum(['not_started', 'incomplete', 'pending_verification', 'active', 'restricted', 'disabled']),
            chargesEnabled: z.boolean(),
            payoutsEnabled: z.boolean(),
            detailsSubmitted: z.boolean(),
            requirementsCurrentlyDue: z.array(z.string()),
            requirementsPastDue: z.array(z.string()),
            disabledReason: z.string().nullable(),
            businessName: z.string().nullable(),
            externalAccountLast4: z.string().nullable(),
            externalAccountBankName: z.string().nullable(),
            externalAccountStatus: z.string().nullable(),
            payoutStatus: z.string().nullable(),
            payoutFailureCode: z.string().nullable(),
            payoutFailureMessage: z.string().nullable(),
            defaultCurrency: z.string().optional(),
            country: z.string().optional(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(getConnectStatusRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Check if we have a connected account record
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      // No connected account yet
      return c.json({
        hasConnectedAccount: false,
        onboardingComplete: false,
        onboardingState: 'not_started' as ConnectOnboardingState,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        disabledReason: null,
        businessName: null,
        externalAccountLast4: null,
        externalAccountBankName: null,
        externalAccountStatus: null,
        payoutStatus: null,
        payoutFailureCode: null,
        payoutFailureMessage: null,
        defaultCurrency: 'usd',
        country: 'US',
      });
    }

    const connectedAccount = rows[0];

    // Force refresh if pending_stripe_sync flag is set (user returned from Stripe)
    // Otherwise, optionally refresh if last sync was more than 5 minutes ago
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const shouldRefresh = connectedAccount.pending_stripe_sync ||
                          !connectedAccount.last_stripe_sync_at ||
                          connectedAccount.last_stripe_sync_at < fiveMinutesAgo;

    if (shouldRefresh) {
      try {
        const stripeAccount = await stripeService.retrieveAccount(connectedAccount.stripe_account_id);
        await syncAccountFromStripe(stripeAccount, payload.organizationId);

        // Clear the pending_stripe_sync flag if it was set
        if (connectedAccount.pending_stripe_sync) {
          await query(
            'UPDATE stripe_connected_accounts SET pending_stripe_sync = FALSE WHERE organization_id = $1',
            [payload.organizationId]
          );
        }

        // Re-fetch updated data
        const updatedRows = await query<StripeConnectedAccount>(
          'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
          [payload.organizationId]
        );
        if (updatedRows.length > 0) {
          const updated = updatedRows[0];
          return c.json({
            hasConnectedAccount: true,
            onboardingComplete: updated.onboarding_state === 'active',
            onboardingState: updated.onboarding_state,
            chargesEnabled: updated.charges_enabled,
            payoutsEnabled: updated.payouts_enabled,
            detailsSubmitted: updated.details_submitted,
            requirementsCurrentlyDue: updated.requirements_currently_due,
            requirementsPastDue: updated.requirements_past_due,
            disabledReason: updated.requirements_disabled_reason,
            businessName: updated.business_name,
            externalAccountLast4: updated.external_account_last4,
            externalAccountBankName: updated.external_account_bank_name,
            externalAccountStatus: updated.external_account_status,
            payoutStatus: updated.payout_status,
            payoutFailureCode: updated.payout_failure_code,
            payoutFailureMessage: updated.payout_failure_message,
            defaultCurrency: updated.default_currency || 'usd',
            country: updated.country || 'US',
          });
        }
      } catch (error) {
        logger.warn('Failed to refresh Stripe account status', { error, accountId: connectedAccount.stripe_account_id });
      }
    }

    return c.json({
      hasConnectedAccount: true,
      onboardingComplete: connectedAccount.onboarding_state === 'active',
      onboardingState: connectedAccount.onboarding_state,
      chargesEnabled: connectedAccount.charges_enabled,
      payoutsEnabled: connectedAccount.payouts_enabled,
      detailsSubmitted: connectedAccount.details_submitted,
      requirementsCurrentlyDue: connectedAccount.requirements_currently_due,
      requirementsPastDue: connectedAccount.requirements_past_due,
      disabledReason: connectedAccount.requirements_disabled_reason,
      businessName: connectedAccount.business_name,
      externalAccountLast4: connectedAccount.external_account_last4,
      externalAccountBankName: connectedAccount.external_account_bank_name,
      externalAccountStatus: connectedAccount.external_account_status,
      payoutStatus: connectedAccount.payout_status,
      payoutFailureCode: connectedAccount.payout_failure_code,
      payoutFailureMessage: connectedAccount.payout_failure_message,
      defaultCurrency: connectedAccount.default_currency || 'usd',
      country: connectedAccount.country || 'US',
    });
  } catch (error) {
    logger.error('Error getting connect status', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to get connect status' }, 500);
  }
});

// ============================================
// POST /stripe/connect/create-account - Create a new connected account
// ============================================
const createConnectedAccountRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/create-account',
  summary: 'Create a new Stripe Connect account and start onboarding',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            country: z.string().length(2).optional().default('US'),
            businessType: z.enum(['individual', 'company']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Account created and onboarding link generated',
      content: {
        'application/json': {
          schema: z.object({
            accountId: z.string(),
            onboardingUrl: z.string(),
          }),
        },
      },
    },
    400: { description: 'Account already exists' },
    401: { description: 'Unauthorized' },
    403: { description: 'Only owners can create connected accounts' },
  },
});

app.openapi(createConnectedAccountRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Only owners can create connected accounts
    if (payload.role !== 'owner') {
      return c.json({ error: 'Only organization owners can set up payment accounts' }, 403);
    }

    // Check if account already exists
    const existingRows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (existingRows.length > 0) {
      // Account exists, just generate a new onboarding link
      const existingAccount = existingRows[0];
      const accountLink = await stripeService.createAccountLink(
        existingAccount.stripe_account_id,
        `${config.email.dashboardUrl}/banking`,
        `${config.email.dashboardUrl}/banking`
      );

      // Set flag so next status check will force refresh from Stripe
      await query(
        'UPDATE stripe_connected_accounts SET pending_stripe_sync = TRUE WHERE organization_id = $1',
        [payload.organizationId]
      );

      return c.json({
        accountId: existingAccount.stripe_account_id,
        onboardingUrl: accountLink.url,
      });
    }

    const body = await c.req.json();

    // Get user email for the connected account
    const userRows = await query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [payload.userId]
    );

    if (userRows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Create new Stripe connected account
    const account = await stripeService.createConnectedAccount({
      type: 'standard',
      country: body.country || 'US',
      email: userRows[0].email,
      business_type: body.businessType,
      metadata: {
        organization_id: payload.organizationId,
        user_id: payload.userId,
      },
    });

    // Sync the new account to our database
    await syncAccountFromStripe(account, payload.organizationId);

    // Create onboarding link
    const accountLink = await stripeService.createAccountLink(
      account.id,
      `${config.email.dashboardUrl}/banking`,
      `${config.email.dashboardUrl}/banking`
    );

    // Set flag so next status check will force refresh from Stripe
    await query(
      'UPDATE stripe_connected_accounts SET pending_stripe_sync = TRUE WHERE organization_id = $1',
      [payload.organizationId]
    );

    logger.info('Created new connected account', {
      accountId: account.id,
      organizationId: payload.organizationId,
      userId: payload.userId,
    });

    return c.json({
      accountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    logger.error('Error creating connected account', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to create connected account' }, 500);
  }
});

// ============================================
// POST /stripe/connect/onboarding-link - Generate a new onboarding link
// ============================================
const createOnboardingLinkRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/onboarding-link',
  summary: 'Generate a new Stripe Connect onboarding link',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Onboarding link generated',
      content: {
        'application/json': {
          schema: z.object({
            onboardingUrl: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(createOnboardingLinkRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get existing connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found. Create one first.' }, 404);
    }

    const connectedAccount = rows[0];

    // Always use account_onboarding - account_update is not supported for all account types
    const linkType = 'account_onboarding' as const;

    const accountLink = await stripeService.createAccountLink(
      connectedAccount.stripe_account_id,
      `${config.email.dashboardUrl}/banking`,
      `${config.email.dashboardUrl}/banking`,
      linkType
    );

    // Set flag so next status check will force refresh from Stripe
    await query(
      'UPDATE stripe_connected_accounts SET pending_stripe_sync = TRUE WHERE organization_id = $1',
      [payload.organizationId]
    );

    logger.info('Generated onboarding link', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      linkType,
    });

    return c.json({
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    logger.error('Error creating onboarding link', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to create onboarding link' }, 500);
  }
});

// ============================================
// POST /stripe/connect/refresh-status - Manually refresh status from Stripe
// ============================================
const refreshStatusRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/refresh-status',
  summary: 'Manually refresh connected account status from Stripe',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Status refreshed successfully',
      content: {
        'application/json': {
          schema: z.object({
            onboardingState: z.enum(['not_started', 'incomplete', 'pending_verification', 'active', 'restricted', 'disabled']),
            chargesEnabled: z.boolean(),
            payoutsEnabled: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(refreshStatusRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get existing connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // Fetch fresh data from Stripe
    const stripeAccount = await stripeService.retrieveAccount(connectedAccount.stripe_account_id);
    const onboardingState = await syncAccountFromStripe(stripeAccount, payload.organizationId);

    logger.info('Refreshed connected account status', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      newState: onboardingState,
    });

    return c.json({
      onboardingState,
      chargesEnabled: stripeAccount.charges_enabled,
      payoutsEnabled: stripeAccount.payouts_enabled,
    });
  } catch (error) {
    logger.error('Error refreshing status', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to refresh status' }, 500);
  }
});

// ============================================
// GET /stripe/connect/balance - Get connected account balance
// ============================================
const getBalanceRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/balance',
  summary: 'Get Stripe Connect account balance',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Balance retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            available: z.array(z.object({
              amount: z.number(),
              currency: z.string(),
            })),
            pending: z.array(z.object({
              amount: z.number(),
              currency: z.string(),
            })),
            instantAvailable: z.array(z.object({
              amount: z.number(),
              currency: z.string(),
            })).optional(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
    403: { description: 'Payouts not enabled for this account' },
  },
});

app.openapi(getBalanceRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    if (!connectedAccount.payouts_enabled) {
      return c.json({ error: 'Payouts are not enabled for this account' }, 403);
    }

    // Get balance from Stripe
    const balance = await stripeService.getConnectedAccountBalance(connectedAccount.stripe_account_id);

    // Convert amounts from smallest unit to base unit
    const formatBalance = (balanceItems: Array<{ amount: number; currency: string }>) =>
      balanceItems.map((item) => ({
        amount: fromSmallestUnit(item.amount, item.currency || 'usd'),
        currency: item.currency,
      }));

    // Log raw balance from Stripe for debugging
    logger.info('Retrieved connected account balance', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      rawAvailable: balance.available,
      rawPending: balance.pending,
      rawInstantAvailable: balance.instant_available,
    });

    return c.json({
      available: formatBalance(balance.available),
      pending: formatBalance(balance.pending),
      instantAvailable: balance.instant_available ? formatBalance(balance.instant_available) : undefined,
    });
  } catch (error) {
    logger.error('Error getting balance', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to get balance' }, 500);
  }
});

// ============================================
// GET /stripe/connect/payouts - List payouts for connected account
// ============================================
const listPayoutsRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/payouts',
  summary: 'List payouts for connected account',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(['pending', 'paid', 'failed', 'canceled']).optional(),
      limit: z.string().transform(Number).optional(),
      starting_after: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Payouts retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              currency: z.string(),
              status: z.string(),
              method: z.string(),
              arrivalDate: z.number(),
              created: z.number(),
              description: z.string().nullable(),
              failureCode: z.string().nullable(),
              failureMessage: z.string().nullable(),
              automatic: z.boolean(),
              destination: z.object({
                last4: z.string().nullable(),
                bankName: z.string().nullable(),
                type: z.string(),
              }).nullable(),
            })),
            hasMore: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(listPayoutsRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];
    const queryParams = c.req.query();

    // Get payouts from Stripe
    const payouts = await stripeService.listConnectedAccountPayouts(
      connectedAccount.stripe_account_id,
      {
        status: queryParams.status as any,
        limit: queryParams.limit ? parseInt(queryParams.limit) : 10,
        starting_after: queryParams.starting_after,
      }
    );

    // Format the response
    const formattedPayouts = payouts.data.map((payout) => {
      let destination = null;
      if (payout.destination && typeof payout.destination === 'object') {
        const dest = payout.destination as any;
        destination = {
          last4: dest.last4 || null,
          bankName: dest.bank_name || dest.brand || null,
          type: dest.object || 'unknown',
        };
      }

      return {
        id: payout.id,
        amount: fromSmallestUnit(payout.amount, payout.currency || 'usd'),
        currency: payout.currency,
        status: payout.status,
        method: payout.method || 'standard',
        arrivalDate: payout.arrival_date,
        created: payout.created,
        description: payout.description,
        failureCode: payout.failure_code,
        failureMessage: payout.failure_message,
        automatic: payout.automatic ?? true,
        destination,
      };
    });

    logger.info('Retrieved connected account payouts', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      count: formattedPayouts.length,
    });

    return c.json({
      data: formattedPayouts,
      hasMore: payouts.has_more,
    });
  } catch (error) {
    logger.error('Error listing payouts', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to list payouts' }, 500);
  }
});

// ============================================
// POST /stripe/connect/payouts - Create a new payout
// ============================================
const createPayoutRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/payouts',
  summary: 'Create a new payout for connected account',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().optional(), // If not provided, payout full available balance
            method: z.enum(['standard', 'instant']).optional().default('standard'),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Payout created successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            amount: z.number(),
            currency: z.string(),
            status: z.string(),
            method: z.string(),
            arrivalDate: z.number(),
            created: z.number(),
            fee: z.number().optional(),
          }),
        },
      },
    },
    400: { description: 'Bad request (e.g., insufficient balance)' },
    401: { description: 'Unauthorized' },
    403: { description: 'Payouts not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(createPayoutRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    if (!connectedAccount.payouts_enabled) {
      return c.json({ error: 'Payouts are not enabled for this account' }, 403);
    }

    const body = await c.req.json();

    // Get current balance to validate
    const orgCurrency = connectedAccount.default_currency || await getOrgCurrency(payload.organizationId);
    const balance = await stripeService.getConnectedAccountBalance(connectedAccount.stripe_account_id);
    const availableBal = balance.available.find((b) => b.currency === orgCurrency) || balance.available[0];
    const availableAmount = availableBal ? fromSmallestUnit(availableBal.amount, orgCurrency) : 0;

    // Determine payout amount
    let payoutAmount = body.amount || availableAmount;

    if (payoutAmount <= 0) {
      return c.json({ error: 'No available balance to payout' }, 400);
    }

    if (payoutAmount > availableAmount) {
      return c.json({
        error: `Insufficient balance. Available: ${formatCurrencyUtil(availableAmount, orgCurrency)}, Requested: ${formatCurrencyUtil(payoutAmount, orgCurrency)}`
      }, 400);
    }

    // For instant payouts, check if instant balance is available
    if (body.method === 'instant') {
      const instantAvailable = balance.instant_available?.find((b) => b.currency === orgCurrency) || balance.instant_available?.[0];
      const instantAmount = instantAvailable ? fromSmallestUnit(instantAvailable.amount, orgCurrency) : 0;

      if (payoutAmount > instantAmount) {
        return c.json({
          error: `Insufficient instant payout balance. Available for instant: ${formatCurrencyUtil(instantAmount, orgCurrency)}`
        }, 400);
      }
    }

    // Create the payout
    const payout = await stripeService.createConnectedAccountPayout(
      connectedAccount.stripe_account_id,
      {
        amount: payoutAmount,
        currency: orgCurrency,
        method: body.method || 'standard',
        description: body.description || `Manual payout - ${new Date().toLocaleDateString()}`,
        metadata: {
          organization_id: payload.organizationId,
          user_id: payload.userId,
          initiated_by: 'dashboard',
        },
      }
    );

    // Record the payout in our database
    await query(
      `INSERT INTO payouts (
        organization_id, stripe_payout_id, amount, status, type, description, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        payload.organizationId,
        payout.id,
        payoutAmount,
        payout.status === 'in_transit' ? 'processing' : payout.status,
        'manual_payout',
        body.description || 'Manual payout from dashboard',
      ]
    );

    logger.info('Created payout', {
      payoutId: payout.id,
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      amount: payoutAmount,
      method: body.method || 'standard',
    });

    // Calculate estimated fee for instant payouts (typically 1%)
    const fee = body.method === 'instant' ? payoutAmount * 0.01 : 0;

    return c.json({
      id: payout.id,
      amount: fromSmallestUnit(payout.amount, payout.currency || 'usd'),
      currency: payout.currency,
      status: payout.status,
      method: payout.method || 'standard',
      arrivalDate: payout.arrival_date,
      created: payout.created,
      fee: fee > 0 ? fee : undefined,
    });
  } catch (error: any) {
    logger.error('Error creating payout', { error });

    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Handle Stripe-specific errors
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message || 'Invalid payout request' }, 400);
    }

    return c.json({ error: 'Failed to create payout' }, 500);
  }
});

// ============================================
// GET /stripe/connect/transactions - List transactions for connected account
// ============================================
const listTransactionsRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/transactions',
  summary: 'List transactions (charges) for connected account',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.string().transform(Number).optional(),
      offset: z.string().transform(Number).optional(),
      starting_after: z.string().optional(),
      ending_before: z.string().optional(),
      source: z.enum(['all', 'orders', 'preorders', 'tickets', 'invoices']).optional(),
      catalog_id: z.string().uuid().optional(),
      customer_email: z.string().optional(),
      device_id: z.string().optional(),
      date_from: z.string().transform(Number).optional(),
      date_to: z.string().transform(Number).optional(),
      amount_min: z.string().transform(Number).optional(),
      amount_max: z.string().transform(Number).optional(),
      sort_by: z.enum(['date', 'amount', 'email']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional(),
      status: z.enum(['all', 'succeeded', 'refunded', 'failed', 'pending', 'cancelled']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Transactions retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              amountRefunded: z.number(),
              currency: z.string(),
              status: z.enum(['succeeded', 'pending', 'failed', 'refunded', 'partially_refunded', 'cancelled']),
              description: z.string().nullable(),
              customerEmail: z.string().nullable(),
              customerName: z.string().nullable(),
              paymentMethod: z.object({
                type: z.string(),
                brand: z.string().nullable(),
                last4: z.string().nullable(),
              }).nullable(),
              receiptUrl: z.string().nullable(),
              created: z.number(),
              metadata: z.record(z.string()).optional(),
              fees: z.object({
                processingFee: z.number(),
                netAmount: z.number(),
              }).optional(),
              sourceType: z.enum(['order', 'preorder', 'ticket', 'invoice']),
              catalogName: z.string().nullable().optional(),
              eventName: z.string().nullable().optional(),
              eventId: z.string().nullable().optional(),
              tierName: z.string().nullable().optional(),
              dailyNumber: z.number().nullable().optional(),
              itemCount: z.number().optional(),
            })),
            hasMore: z.boolean(),
            total: z.number().optional(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(listTransactionsRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    const queryParams = c.req.query();
    const source = (queryParams.source || 'all') as string;
    const catalogIdFilter = queryParams.catalog_id || null;
    const customerEmailFilter = queryParams.customer_email?.toLowerCase() || null;
    const deviceIdFilter = queryParams.device_id || null;
    const dateFrom = queryParams.date_from ? parseInt(queryParams.date_from) : null;
    const dateTo = queryParams.date_to ? parseInt(queryParams.date_to) : null;
    const amountMin = queryParams.amount_min ? parseInt(queryParams.amount_min) : null;
    const amountMax = queryParams.amount_max ? parseInt(queryParams.amount_max) : null;
    const sortBy = queryParams.sort_by || 'date';
    const sortOrder = queryParams.sort_order || 'desc';
    // Cap page size — each item in this list also fans out to Stripe API
    // calls below, so an uncapped limit can burn the Stripe per-account quota.
    const requestedLimit = Math.min(50, Math.max(1, (queryParams.limit ? parseInt(queryParams.limit) : 25) || 25));
    const requestedOffset = Math.max(0, (queryParams.offset ? parseInt(queryParams.offset) : 0) || 0);
    const statusFilter = queryParams.status || 'all';
    const startingAfter = queryParams.starting_after || null;

    // Run connected account fetch + cursor resolution in parallel
    const needsCursor = !!(startingAfter && !queryParams.offset);
    const [accountRows, cursorResult] = await Promise.all([
      query<StripeConnectedAccount>(
        'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
        [payload.organizationId]
      ),
      needsCursor
        ? query<{ created_at: Date }>(
            `SELECT created_at FROM (
              SELECT id, created_at FROM orders WHERE organization_id = $1 AND id = $2
              UNION ALL
              SELECT id, created_at FROM preorders WHERE organization_id = $1 AND id = $2
              UNION ALL
              SELECT id, purchased_at as created_at FROM tickets WHERE organization_id = $1 AND id = $2
              UNION ALL
              SELECT id, paid_at as created_at FROM invoices WHERE organization_id = $1 AND id = $2 AND status = 'paid'
            ) as cursor_lookup LIMIT 1`,
            [payload.organizationId, startingAfter]
          )
        : Promise.resolve([]),
    ]);
    const connectedAccount = accountRows.length > 0 ? accountRows[0] : null;
    const cursorCreatedAt: Date | null = cursorResult.length > 0 ? cursorResult[0].created_at : null;

    // Build UNION ALL query across orders, preorders, tickets, and invoices
    const includeOrders = source === 'all' || source === 'orders';
    const includePreorders = source === 'all' || source === 'preorders';
    // Exclude tickets when device_id is present (mobile POS app doesn't show ticket sales)
    const includeTickets = (source === 'all' || source === 'tickets') && !deviceIdFilter;
    const includeInvoices = (source === 'all' || source === 'invoices') && !deviceIdFilter;

    const subqueries: string[] = [];
    const params: any[] = [payload.organizationId]; // $1
    let paramIdx = 2;
    const addParam = (val: any): string => {
      params.push(val);
      return `$${paramIdx++}`;
    };

    // Add cursor params once (shared across all subqueries)
    let cursorTsParam: string | null = null;
    let cursorIdParam: string | null = null;
    if (cursorCreatedAt && startingAfter) {
      cursorTsParam = addParam(cursorCreatedAt);
      cursorIdParam = addParam(startingAfter);
    }

    // --- Orders subquery ---
    if (includeOrders && statusFilter !== 'pending' && statusFilter !== 'cancelled') {
      const conds: string[] = ['o.organization_id = $1'];
      if (statusFilter === 'succeeded') conds.push("o.status = 'completed'");
      else if (statusFilter === 'refunded') conds.push("o.status = 'refunded'");
      else if (statusFilter === 'failed') conds.push("o.status = 'failed'");
      else conds.push("o.status IN ('completed', 'refunded')");
      if (catalogIdFilter) conds.push(`o.catalog_id = ${addParam(catalogIdFilter)}`);
      if (deviceIdFilter) conds.push(`o.device_id = ${addParam(deviceIdFilter)}`);
      if (customerEmailFilter) conds.push(`LOWER(o.customer_email) LIKE ${addParam(`%${customerEmailFilter}%`)}`);
      if (dateFrom) conds.push(`o.created_at >= to_timestamp(${addParam(dateFrom)})`);
      if (dateTo) conds.push(`o.created_at <= to_timestamp(${addParam(dateTo)})`);
      if (amountMin !== null) conds.push(`o.total_amount >= ${addParam(amountMin)}`);
      if (amountMax !== null) conds.push(`o.total_amount <= ${addParam(amountMax)}`);
      if (cursorTsParam) conds.push(`(o.created_at, o.id) < (${cursorTsParam}, ${cursorIdParam})`);

      subqueries.push(`
        SELECT o.id, 'order'::text as source_type, o.order_number as display_number,
               o.status::text as raw_status, o.total_amount, o.tip_amount,
               o.customer_email, NULL::varchar as customer_name,
               o.payment_method::text as payment_method, o.stripe_charge_id, o.stripe_payment_intent_id,
               c.name as catalog_name, NULL::varchar as event_name, NULL::varchar as event_id, NULL::varchar as tier_name,
               NULL::integer as daily_number, o.device_id,
               o.metadata, o.created_at,
               (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) as item_count
        FROM orders o
        LEFT JOIN catalogs c ON o.catalog_id = c.id
        WHERE ${conds.join(' AND ')}
      `);
    }

    // --- Preorders subquery ---
    if (includePreorders && statusFilter !== 'failed') {
      const conds: string[] = ['p.organization_id = $1'];
      if (statusFilter === 'succeeded') conds.push("p.status = 'picked_up'");
      else if (statusFilter === 'refunded') conds.push("p.status = 'cancelled' AND p.stripe_charge_id IS NOT NULL");
      else if (statusFilter === 'pending') conds.push("p.status IN ('pending', 'preparing', 'ready')");
      else if (statusFilter === 'cancelled') conds.push("p.status = 'cancelled' AND p.stripe_charge_id IS NULL");
      if (catalogIdFilter) conds.push(`p.catalog_id = ${addParam(catalogIdFilter)}`);
      if (customerEmailFilter) conds.push(`LOWER(p.customer_email) LIKE ${addParam(`%${customerEmailFilter}%`)}`);
      if (dateFrom) conds.push(`p.created_at >= to_timestamp(${addParam(dateFrom)})`);
      if (dateTo) conds.push(`p.created_at <= to_timestamp(${addParam(dateTo)})`);
      if (amountMin !== null) conds.push(`p.total_amount >= ${addParam(amountMin)}`);
      if (amountMax !== null) conds.push(`p.total_amount <= ${addParam(amountMax)}`);
      if (cursorTsParam) conds.push(`(p.created_at, p.id) < (${cursorTsParam}, ${cursorIdParam})`);

      subqueries.push(`
        SELECT p.id, 'preorder'::text as source_type, p.order_number as display_number,
               p.status::text as raw_status, p.total_amount, p.tip_amount,
               p.customer_email, p.customer_name,
               p.payment_type::text as payment_method, p.stripe_charge_id, p.stripe_payment_intent_id,
               c.name as catalog_name, NULL::varchar as event_name, NULL::varchar as event_id, NULL::varchar as tier_name,
               p.daily_number, NULL::varchar as device_id,
               NULL::jsonb as metadata, p.created_at,
               (SELECT COUNT(*)::int FROM preorder_items pi WHERE pi.preorder_id = p.id) as item_count
        FROM preorders p
        LEFT JOIN catalogs c ON p.catalog_id = c.id
        WHERE ${conds.join(' AND ')}
      `);
    }

    // --- Tickets subquery ---
    if (includeTickets && statusFilter !== 'pending' && statusFilter !== 'cancelled' && statusFilter !== 'failed') {
      const conds: string[] = ['t.organization_id = $1'];
      if (statusFilter === 'succeeded') conds.push("t.status IN ('valid', 'used')");
      else if (statusFilter === 'refunded') conds.push("t.status = 'refunded'");
      else conds.push("t.status IN ('valid', 'used', 'refunded')");

      if (customerEmailFilter) conds.push(`LOWER(t.customer_email) LIKE ${addParam(`%${customerEmailFilter}%`)}`);
      if (dateFrom) conds.push(`t.purchased_at >= to_timestamp(${addParam(dateFrom)})`);
      if (dateTo) conds.push(`t.purchased_at <= to_timestamp(${addParam(dateTo)})`);
      if (amountMin !== null) conds.push(`t.amount_paid >= ${addParam(amountMin)}`);
      if (amountMax !== null) conds.push(`t.amount_paid <= ${addParam(amountMax)}`);
      if (cursorTsParam) conds.push(`(t.purchased_at, t.id) < (${cursorTsParam}, ${cursorIdParam})`);

      subqueries.push(`
        SELECT t.id, 'ticket'::text as source_type, t.qr_code as display_number,
               t.status::text as raw_status, t.amount_paid as total_amount, 0::decimal(10,2) as tip_amount,
               t.customer_email, t.customer_name,
               'online'::text as payment_method, t.stripe_charge_id, t.stripe_payment_intent_id,
               NULL::varchar as catalog_name, e.name as event_name, e.id::varchar as event_id, tt.name as tier_name,
               NULL::integer as daily_number, NULL::varchar as device_id,
               NULL::jsonb as metadata, t.purchased_at as created_at,
               1::int as item_count
        FROM tickets t
        JOIN events e ON t.event_id = e.id
        JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
        WHERE ${conds.join(' AND ')}
      `);
    }

    // --- Invoices subquery ---
    if (includeInvoices && statusFilter !== 'pending' && statusFilter !== 'cancelled' && statusFilter !== 'failed') {
      const conds: string[] = ['i.organization_id = $1', "i.status = 'paid'"];
      if (statusFilter === 'refunded') {
        // Invoices don't have a refunded status — skip
      } else {
        if (customerEmailFilter) conds.push(`LOWER(i.customer_email) LIKE ${addParam(`%${customerEmailFilter}%`)}`);
        if (dateFrom) conds.push(`i.paid_at >= to_timestamp(${addParam(dateFrom)})`);
        if (dateTo) conds.push(`i.paid_at <= to_timestamp(${addParam(dateTo)})`);
        if (amountMin !== null) conds.push(`i.total_amount >= ${addParam(amountMin)}`);
        if (amountMax !== null) conds.push(`i.total_amount <= ${addParam(amountMax)}`);
        if (cursorTsParam) conds.push(`(i.paid_at, i.id) < (${cursorTsParam}, ${cursorIdParam})`);

        subqueries.push(`
          SELECT i.id, 'invoice'::text as source_type, i.invoice_number as display_number,
                 'paid'::text as raw_status, i.total_amount, 0::decimal(10,2) as tip_amount,
                 i.customer_email, i.customer_name,
                 'invoice'::text as payment_method, i.stripe_charge_id, i.stripe_payment_intent_id,
                 NULL::varchar as catalog_name, NULL::varchar as event_name, NULL::varchar as event_id, NULL::varchar as tier_name,
                 NULL::integer as daily_number, NULL::varchar as device_id,
                 NULL::jsonb as metadata, i.paid_at as created_at,
                 (SELECT COUNT(*)::int FROM invoice_items ii WHERE ii.invoice_id = i.id) as item_count
          FROM invoices i
          WHERE ${conds.join(' AND ')}
        `);
      }
    }

    // If no subqueries match the filters, return empty result
    if (subqueries.length === 0) {
      return c.json({ data: [], hasMore: false, total: 0 } as any);
    }

    const unionQuery = subqueries.join('\nUNION ALL\n');

    // Build ORDER BY clause
    let orderByClause = 'created_at DESC';
    if (sortBy === 'amount') {
      orderByClause = sortOrder === 'asc' ? 'total_amount ASC' : 'total_amount DESC';
    } else if (sortBy === 'email') {
      orderByClause = sortOrder === 'asc' ? 'customer_email ASC NULLS LAST' : 'customer_email DESC NULLS LAST';
    } else if (sortOrder === 'asc') {
      orderByClause = 'created_at ASC';
    }

    // Run count + data queries in parallel
    const countParams = [...params];
    const dataParams = [...params];
    const limitParamIdx = dataParams.length + 1;
    const offsetParamIdx = dataParams.length + 2;
    dataParams.push(requestedLimit, requestedOffset);

    const [countResult, unifiedRows] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*) as total FROM (${unionQuery}) as combined`,
        countParams
      ),
      query<{
        id: string;
        source_type: string;
        display_number: string;
        raw_status: string;
        total_amount: string;
        tip_amount: string;
        customer_email: string | null;
        customer_name: string | null;
        payment_method: string | null;
        stripe_charge_id: string | null;
        stripe_payment_intent_id: string | null;
        catalog_name: string | null;
        event_name: string | null;
        event_id: string | null;
        tier_name: string | null;
        daily_number: number | null;
        device_id: string | null;
        metadata: any;
        created_at: Date;
        item_count: number;
      }>(
        `SELECT * FROM (${unionQuery}) as combined ORDER BY ${orderByClause} LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
        dataParams
      ),
    ]);

    const total = parseInt(countResult[0]?.total || '0');
    const hasMore = requestedOffset + unifiedRows.length < total;
    const orders = unifiedRows;

    // Batch-fetch Stripe charge details and order_payments lookups in parallel
    const chargeIds = [...new Set(
      orders.map(o => o.stripe_charge_id).filter((id): id is string => id !== null)
    )];
    const ordersNeedingPaymentLookup = connectedAccount
      ? orders.filter(o => o.source_type === 'order' && !o.stripe_charge_id && (o.payment_method === 'split' || o.payment_method === 'card'))
      : [];

    const chargeMap = new Map<string, Stripe.Charge>();
    const orderChargeMap = new Map<string, Stripe.Charge>();

    // Run both enrichment paths in parallel (they're independent)
    await Promise.all([
      // Path 1: Direct charge lookups
      (async () => {
        if (chargeIds.length > 0 && connectedAccount) {
          try {
            const charges = await Promise.all(
              chargeIds.map(id =>
                stripeService.retrieveConnectedAccountCharge(
                  connectedAccount.stripe_account_id,
                  id
                ).catch(err => {
                  logger.warn('Failed to fetch Stripe charge', { chargeId: id, error: err.message });
                  return null;
                })
              )
            );
            charges.forEach((charge) => {
              if (charge) chargeMap.set(charge.id, charge);
            });
          } catch (err) {
            logger.warn('Failed to batch-fetch Stripe charges', { error: err });
          }
        }
      })(),
      // Path 2: Order payments → PaymentIntent → Charge lookups
      (async () => {
        if (ordersNeedingPaymentLookup.length > 0 && connectedAccount) {
          try {
            const orderIds = ordersNeedingPaymentLookup.map(o => o.id);
            const paymentRows = await query<{
              order_id: string;
              stripe_payment_intent_id: string;
            }>(
              `SELECT order_id, stripe_payment_intent_id FROM order_payments
               WHERE order_id = ANY($1) AND stripe_payment_intent_id IS NOT NULL
               AND payment_method IN ('card', 'tap_to_pay')`,
              [orderIds]
            );

            await Promise.all(paymentRows.map(async (row) => {
              try {
                const pi = await stripe.paymentIntents.retrieve(
                  row.stripe_payment_intent_id,
                  { stripeAccount: connectedAccount!.stripe_account_id }
                );
                if (pi.latest_charge) {
                  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id;
                  const charge = await stripeService.retrieveConnectedAccountCharge(
                    connectedAccount!.stripe_account_id,
                    chargeId
                  );
                  if (charge) orderChargeMap.set(row.order_id, charge);
                }
              } catch (err: any) {
                logger.warn('Failed to fetch charge from order_payment', { orderId: row.order_id, error: err.message });
              }
            }));
          } catch (err) {
            logger.warn('Failed to lookup order_payments charges', { error: err });
          }
        }
      })(),
    ]);

    // Format response: merge DB data with Stripe charge details
    const txCurrency = connectedAccount?.default_currency || 'usd';
    const formattedTransactions = orders.map((order) => {
      const charge = order.stripe_charge_id
        ? chargeMap.get(order.stripe_charge_id) || null
        : (order.source_type === 'order' ? orderChargeMap.get(order.id) || null : null);
      const totalAmount = toSmallestUnit(parseFloat(order.total_amount), txCurrency);

      // Determine status based on source type
      let status: 'succeeded' | 'pending' | 'failed' | 'refunded' | 'partially_refunded' | 'cancelled' = 'succeeded';
      if (order.source_type === 'order') {
        if (order.raw_status === 'failed') status = 'failed';
        else if (order.raw_status === 'refunded') status = 'refunded';
        else status = 'succeeded';
        if (charge) {
          if (charge.refunded) status = 'refunded';
          else if (charge.amount_refunded > 0) status = 'partially_refunded';
        }
      } else if (order.source_type === 'preorder') {
        if (order.raw_status === 'picked_up') status = 'succeeded';
        else if (order.raw_status === 'cancelled') {
          // 'refunded' if payment was collected (has a stripe charge), regardless of payment type
          status = order.stripe_charge_id ? 'refunded' : 'cancelled';
        }
        else status = 'pending';
      } else if (order.source_type === 'invoice') {
        status = 'succeeded'; // Only paid invoices are in the list
      } else {
        // ticket
        if (order.raw_status === 'refunded') status = 'refunded';
        else status = 'succeeded';
      }

      // Payment method: from Stripe charge or from DB payment_method
      let paymentMethod: { type: string; brand: string | null; last4: string | null } | null = null;
      if (charge?.payment_method_details) {
        const pm = charge.payment_method_details;
        if (pm.card) {
          paymentMethod = { type: 'card', brand: pm.card.brand, last4: pm.card.last4 };
        } else if (pm.card_present) {
          paymentMethod = { type: 'card_present', brand: pm.card_present.brand, last4: pm.card_present.last4 };
        } else if (pm.type) {
          paymentMethod = { type: pm.type, brand: null, last4: null };
        }
      } else if (order.payment_method) {
        paymentMethod = { type: order.payment_method, brand: null, last4: null };
      }

      // Calculate fees (only for Stripe charges)
      let fees: { processingFee: number; netAmount: number } | undefined;
      if (charge) {
        const appFeeAmount = (charge as any).application_fee_amount;
        const metadataFee = charge.metadata?.platform_fee_cents ? parseInt(charge.metadata.platform_fee_cents) : 0;
        const platformFee = appFeeAmount || metadataFee;
        const isCardPresent = charge.payment_method_details?.type === 'card_present';
        const stripeFeePercent = isCardPresent ? 0.027 : 0.029;
        const stripeFeeFixed = isCardPresent ? 15 : 30;
        const stripeFee = Math.round(charge.amount * stripeFeePercent) + stripeFeeFixed;
        const processingFee = stripeFee + platformFee;
        fees = {
          processingFee,
          netAmount: charge.amount - processingFee - charge.amount_refunded,
        };
      } else {
        fees = { processingFee: 0, netAmount: totalAmount };
      }

      return {
        id: order.id,
        amount: totalAmount,
        amountRefunded: charge?.amount_refunded || 0,
        currency: charge?.currency || connectedAccount?.default_currency || 'usd',
        status,
        description: charge?.description || null,
        customerEmail: order.customer_email || charge?.billing_details?.email || charge?.receipt_email || null,
        customerName: order.customer_name || charge?.billing_details?.name || null,
        paymentMethod,
        receiptUrl: charge?.receipt_url || null,
        created: Math.floor(new Date(order.created_at).getTime() / 1000),
        metadata: charge?.metadata || (order.metadata && typeof order.metadata === 'object' ? order.metadata : undefined),
        fees,
        sourceType: order.source_type as 'order' | 'preorder' | 'ticket' | 'invoice',
        catalogName: order.catalog_name || null,
        eventName: order.event_name || null,
        eventId: order.event_id || null,
        tierName: order.tier_name || null,
        dailyNumber: order.daily_number || null,
        itemCount: order.item_count || 0,
      };
    });

    logger.info('Retrieved unified transactions', {
      organizationId: payload.organizationId,
      source,
      count: formattedTransactions.length,
      total,
      hasMore,
    });

    return c.json({
      data: formattedTransactions,
      hasMore,
      total,
    });
  } catch (error) {
    logger.error('Error listing transactions', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to list transactions' }, 500);
  }
});

// ============================================
// GET /stripe/connect/transactions/:id - Get a single transaction
// ============================================
const getTransactionRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/transactions/{transactionId}',
  summary: 'Get a single transaction by ID',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      transactionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Transaction retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            amount: z.number(),
            amountRefunded: z.number(),
            currency: z.string(),
            status: z.string(),
            description: z.string().nullable(),
            customerEmail: z.string().nullable(),
            customerName: z.string().nullable(),
            billingAddress: z.object({
              line1: z.string().nullable(),
              line2: z.string().nullable(),
              city: z.string().nullable(),
              state: z.string().nullable(),
              postalCode: z.string().nullable(),
              country: z.string().nullable(),
            }).nullable(),
            paymentMethod: z.object({
              type: z.string(),
              brand: z.string().nullable(),
              last4: z.string().nullable(),
            }).nullable(),
            receiptUrl: z.string().nullable(),
            created: z.number(),
            metadata: z.record(z.string()).optional(),
            refunds: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              status: z.string(),
              reason: z.string().nullable(),
              created: z.number(),
            })),
            fees: z.object({
              processingFee: z.number(),
              netAmount: z.number(),
            }),
            orderItems: z.array(z.object({
              id: z.string(),
              productId: z.string().nullable(),
              name: z.string(),
              quantity: z.number(),
              unitPrice: z.number(),
            })).optional(),
            isQuickCharge: z.boolean().optional(),
            tipAmount: z.number().optional(),
            taxAmount: z.number().optional(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Transaction not found' },
  },
});

app.openapi(getTransactionRoute, async (c) => {
  const { transactionId } = c.req.param();
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account (needed for Stripe lookups)
    const accountRows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (accountRows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = accountRows[0];
    const detailCurrency = connectedAccount.default_currency || 'usd';

    // Look up order by ID (transaction IDs are now order IDs)
    const orderRows = await query<{
      id: string;
      order_number: string;
      status: string;
      payment_method: string | null;
      subtotal: string;
      tax_amount: string;
      tip_amount: string;
      total_amount: string;
      stripe_charge_id: string | null;
      stripe_payment_intent_id: string | null;
      customer_email: string | null;
      metadata: any;
      created_at: Date;
    }>(
      'SELECT id, order_number, status, payment_method, subtotal, tax_amount, tip_amount, total_amount, stripe_charge_id, stripe_payment_intent_id, customer_email, metadata, created_at FROM orders WHERE id = $1 AND organization_id = $2',
      [transactionId, payload.organizationId]
    );

    if (orderRows.length === 0) {
      // Not in orders table — check preorders
      const preorderRows = await query<{
        id: string;
        order_number: string;
        daily_number: number;
        status: string;
        payment_type: string;
        subtotal: string;
        tax_amount: string;
        tip_amount: string;
        total_amount: string;
        stripe_charge_id: string | null;
        stripe_payment_intent_id: string | null;
        customer_name: string;
        customer_email: string;
        customer_phone: string | null;
        catalog_id: string;
        created_at: Date;
        updated_at: Date;
        picked_up_at: Date | null;
        order_notes: string | null;
      }>(
        'SELECT id, order_number, daily_number, status, payment_type, subtotal, tax_amount, tip_amount, total_amount, stripe_charge_id, stripe_payment_intent_id, customer_name, customer_email, customer_phone, catalog_id, created_at, updated_at, picked_up_at, order_notes FROM preorders WHERE id = $1 AND organization_id = $2',
        [transactionId, payload.organizationId]
      );

      if (preorderRows.length === 0) {
        // Also check tickets
        const ticketRows = await query<{
          id: string;
          status: string;
          amount_paid: string;
          customer_name: string;
          customer_email: string;
          stripe_charge_id: string | null;
          purchased_at: Date;
          event_name: string;
          event_id: string;
          tier_name: string;
        }>(
          `SELECT t.id, t.status, t.amount_paid, t.customer_name, t.customer_email, t.stripe_charge_id, t.purchased_at,
                  e.name as event_name, e.id as event_id, tt.name as tier_name
           FROM tickets t
           JOIN events e ON t.event_id = e.id
           JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
           WHERE t.id = $1 AND t.organization_id = $2`,
          [transactionId, payload.organizationId]
        );

        if (ticketRows.length === 0) {
          // Also check invoices
          const invoiceRows = await query<{
            id: string;
            invoice_number: string;
            status: string;
            subtotal: string;
            tax_amount: string;
            total_amount: string;
            amount_paid: string;
            stripe_charge_id: string | null;
            stripe_payment_intent_id: string | null;
            customer_name: string;
            customer_email: string;
            customer_phone: string | null;
            memo: string | null;
            due_date: string | null;
            paid_at: Date | null;
            created_at: Date;
          }>(
            `SELECT id, invoice_number, status, subtotal, tax_amount, total_amount, amount_paid,
                    stripe_charge_id, stripe_payment_intent_id, customer_name, customer_email,
                    customer_phone, memo, due_date, paid_at, created_at
             FROM invoices WHERE id = $1 AND organization_id = $2`,
            [transactionId, payload.organizationId]
          );

          if (invoiceRows.length === 0) {
            return c.json({ error: 'Transaction not found' }, 404);
          }

          // Format invoice as transaction detail
          const invoice = invoiceRows[0];
          const invoiceAmount = toSmallestUnit(parseFloat(invoice.total_amount), detailCurrency);
          const invoiceTax = toSmallestUnit(parseFloat(invoice.tax_amount || '0'), detailCurrency);

          let invoiceCharge: Stripe.Charge | null = null;
          if (invoice.stripe_charge_id) {
            try {
              invoiceCharge = await stripeService.retrieveConnectedAccountCharge(
                connectedAccount.stripe_account_id,
                invoice.stripe_charge_id
              );
            } catch (err: any) {
              logger.warn('Failed to fetch Stripe charge for invoice', { error: err.message });
            }
          }

          const invoiceRefunds = invoiceCharge
            ? (invoiceCharge.refunds?.data || []).map((r) => ({
                id: r.id, amount: r.amount, status: r.status || 'unknown', reason: r.reason, created: r.created,
              }))
            : [];

          let invoiceFees = { processingFee: 0, netAmount: invoiceAmount };
          if (invoiceCharge) {
            const platformFee = (invoiceCharge as any).application_fee_amount ||
              (invoiceCharge.metadata?.platform_fee_cents ? parseInt(invoiceCharge.metadata.platform_fee_cents) : 0);
            const stripeFeePercent = 0.029;
            const stripeFeeFixed = 30;
            const stripeFee = Math.round(invoiceCharge.amount * stripeFeePercent) + stripeFeeFixed;
            const processingFee = stripeFee + platformFee;
            invoiceFees = { processingFee, netAmount: invoiceCharge.amount - processingFee - invoiceCharge.amount_refunded };
          }

          // Fetch invoice line items
          const invoiceItemRows = await query<{
            id: string;
            product_id: string | null;
            description: string;
            quantity: number;
            unit_price: string;
          }>(
            'SELECT id, product_id, description, quantity, unit_price FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
            [invoice.id]
          );

          const invoiceItems = invoiceItemRows.map((item) => ({
            id: item.id,
            productId: item.product_id,
            name: item.description,
            quantity: item.quantity,
            unitPrice: toSmallestUnit(parseFloat(item.unit_price), detailCurrency),
          }));

          return c.json({
            id: invoice.id,
            amount: invoiceAmount,
            amountRefunded: invoiceCharge?.amount_refunded || 0,
            currency: invoiceCharge?.currency || connectedAccount?.default_currency || 'usd',
            status: invoice.status === 'paid' ? 'succeeded' : invoice.status,
            description: `Invoice #${invoice.invoice_number}`,
            customerEmail: invoice.customer_email || null,
            customerName: invoice.customer_name || null,
            billingAddress: null,
            paymentMethod: invoiceCharge?.payment_method_details?.card
              ? { type: 'card', brand: invoiceCharge.payment_method_details.card.brand, last4: invoiceCharge.payment_method_details.card.last4 }
              : { type: 'invoice', brand: null, last4: null },
            receiptUrl: invoiceCharge?.receipt_url || null,
            created: Math.floor(new Date(invoice.paid_at || invoice.created_at).getTime() / 1000),
            metadata: {},
            refunds: invoiceRefunds,
            fees: invoiceFees,
            orderItems: invoiceItems,
            isQuickCharge: false,
            tipAmount: 0,
            taxAmount: invoiceTax,
            sourceType: 'invoice',
            invoiceNumber: invoice.invoice_number,
          });
        }

        // Format ticket as transaction detail
        const ticket = ticketRows[0];
        const ticketAmount = toSmallestUnit(parseFloat(ticket.amount_paid), detailCurrency);
        let ticketStatus: string = 'succeeded';
        if (ticket.status === 'refunded') ticketStatus = 'refunded';

        let ticketCharge: Stripe.Charge | null = null;
        if (ticket.stripe_charge_id) {
          try {
            ticketCharge = await stripeService.retrieveConnectedAccountCharge(
              connectedAccount.stripe_account_id,
              ticket.stripe_charge_id
            );
          } catch (err: any) {
            logger.warn('Failed to fetch Stripe charge for ticket', { error: err.message });
          }
        }

        const ticketRefunds = ticketCharge
          ? (ticketCharge.refunds?.data || []).map((r) => ({
              id: r.id, amount: r.amount, status: r.status || 'unknown', reason: r.reason, created: r.created,
            }))
          : [];

        return c.json({
          id: ticket.id,
          amount: ticketAmount,
          amountRefunded: ticketCharge?.amount_refunded || 0,
          currency: ticketCharge?.currency || connectedAccount?.default_currency || 'usd',
          status: ticketStatus,
          description: `${ticket.event_name} — ${ticket.tier_name}`,
          customerEmail: ticket.customer_email || null,
          customerName: ticket.customer_name || null,
          billingAddress: null,
          paymentMethod: ticketCharge?.payment_method_details?.card
            ? { type: 'card', brand: ticketCharge.payment_method_details.card.brand, last4: ticketCharge.payment_method_details.card.last4 }
            : { type: 'online', brand: null, last4: null },
          receiptUrl: ticketCharge?.receipt_url || null,
          created: Math.floor(new Date(ticket.purchased_at).getTime() / 1000),
          metadata: {},
          refunds: ticketRefunds,
          fees: { processingFee: 0, netAmount: ticketAmount },
          sourceType: 'ticket',
          eventId: ticket.event_id,
        });
      }

      // Format preorder as transaction detail
      const preorder = preorderRows[0];
      const preorderTotal = toSmallestUnit(parseFloat(preorder.total_amount), detailCurrency);
      const preorderTip = toSmallestUnit(parseFloat(preorder.tip_amount || '0'), detailCurrency);
      const preorderTax = toSmallestUnit(parseFloat(preorder.tax_amount || '0'), detailCurrency);

      let preorderStatus: string = 'succeeded';
      if (preorder.status === 'picked_up') preorderStatus = 'succeeded';
      else if (preorder.status === 'cancelled') {
        // 'refunded' if payment was collected (has a stripe charge), regardless of payment type
        preorderStatus = preorder.stripe_charge_id ? 'refunded' : 'cancelled';
      }
      else preorderStatus = 'pending';

      // Fetch Stripe charge if available
      let preorderCharge: Stripe.Charge | null = null;
      if (preorder.stripe_charge_id) {
        try {
          preorderCharge = await stripeService.retrieveConnectedAccountCharge(
            connectedAccount.stripe_account_id,
            preorder.stripe_charge_id
          );
        } catch (err: any) {
          logger.warn('Failed to fetch Stripe charge for preorder', { error: err.message });
        }
      }

      const preorderRefunds = preorderCharge
        ? (preorderCharge.refunds?.data || []).map((r) => ({
            id: r.id, amount: r.amount, status: r.status || 'unknown', reason: r.reason, created: r.created,
          }))
        : [];

      if (preorderCharge) {
        if (preorderCharge.refunded) preorderStatus = 'refunded';
        else if (preorderCharge.amount_refunded > 0) preorderStatus = 'partially_refunded';
      }

      // Fetch preorder items
      const preorderItemRows = await query<{
        id: string;
        product_id: string | null;
        name: string;
        quantity: number;
        unit_price: string;
      }>(
        'SELECT id, product_id, name, quantity, unit_price FROM preorder_items WHERE preorder_id = $1',
        [preorder.id]
      );

      const preorderItems = preorderItemRows.map((item) => ({
        id: item.id,
        productId: item.product_id,
        name: item.name,
        quantity: item.quantity,
        unitPrice: toSmallestUnit(parseFloat(item.unit_price), detailCurrency),
      }));

      // Catalog name
      const catalogRows = await query<{ name: string }>(
        'SELECT name FROM catalogs WHERE id = $1',
        [preorder.catalog_id]
      );

      let preorderFees = { processingFee: 0, netAmount: preorderTotal };
      if (preorderCharge) {
        const platformFee = (preorderCharge as any).application_fee_amount ||
          (preorderCharge.metadata?.platform_fee_cents ? parseInt(preorderCharge.metadata.platform_fee_cents) : 0);
        const stripeFeePercent = 0.029;
        const stripeFeeFixed = 30;
        const stripeFee = Math.round(preorderCharge.amount * stripeFeePercent) + stripeFeeFixed;
        const processingFee = stripeFee + platformFee;
        preorderFees = { processingFee, netAmount: preorderCharge.amount - processingFee - preorderCharge.amount_refunded };
      }

      return c.json({
        id: preorder.id,
        amount: preorderTotal,
        amountRefunded: preorderCharge?.amount_refunded || 0,
        currency: preorderCharge?.currency || connectedAccount?.default_currency || 'usd',
        status: preorderStatus,
        description: `Preorder #${preorder.order_number}${preorder.daily_number ? ` (#${preorder.daily_number})` : ''}`,
        customerEmail: preorder.customer_email || null,
        customerName: preorder.customer_name || null,
        billingAddress: null,
        paymentMethod: preorderCharge?.payment_method_details?.card
          ? { type: 'card', brand: preorderCharge.payment_method_details.card.brand, last4: preorderCharge.payment_method_details.card.last4 }
          : { type: preorder.payment_type === 'pay_now' ? 'online' : 'pay_at_pickup', brand: null, last4: null },
        receiptUrl: preorderCharge?.receipt_url || null,
        created: Math.floor(new Date(preorder.created_at).getTime() / 1000),
        metadata: {},
        refunds: preorderRefunds,
        fees: preorderFees,
        orderItems: preorderItems,
        isQuickCharge: false,
        tipAmount: preorderTip,
        taxAmount: preorderTax,
        sourceType: 'preorder',
        catalogName: catalogRows.length > 0 ? catalogRows[0].name : null,
        dailyNumber: preorder.daily_number || null,
      });
    }

    const order = orderRows[0];
    const totalAmount = toSmallestUnit(parseFloat(order.total_amount), detailCurrency);
    const orderMetadata = typeof order.metadata === 'string' ? JSON.parse(order.metadata) : (order.metadata || {});

    // Fetch Stripe charge — from order directly, or from order_payments for split payments
    let charge: Stripe.Charge | null = null;
    let stripeChargeId = order.stripe_charge_id;

    if (!stripeChargeId && (order.payment_method === 'split' || order.payment_method === 'card' || order.payment_method === 'tap_to_pay')) {
      // For split/card/tap payments without a direct charge, find from order_payments
      const cardPayments = await query<{ stripe_payment_intent_id: string | null }>(
        `SELECT stripe_payment_intent_id FROM order_payments
         WHERE order_id = $1 AND payment_method IN ('card', 'tap_to_pay') AND stripe_payment_intent_id IS NOT NULL
         ORDER BY created_at ASC LIMIT 1`,
        [order.id]
      );
      if (cardPayments.length > 0 && cardPayments[0].stripe_payment_intent_id) {
        // Retrieve the payment intent to get the charge ID
        try {
          const pi = await stripe.paymentIntents.retrieve(
            cardPayments[0].stripe_payment_intent_id,
            { stripeAccount: connectedAccount.stripe_account_id }
          );
          if (pi.latest_charge && typeof pi.latest_charge === 'string') {
            stripeChargeId = pi.latest_charge;
          } else if (pi.latest_charge && typeof pi.latest_charge === 'object') {
            stripeChargeId = (pi.latest_charge as any).id;
          }
        } catch (err: any) {
          logger.warn('Failed to fetch payment intent for split payment', { error: err.message });
        }
      }
    }

    if (stripeChargeId) {
      try {
        charge = await stripeService.retrieveConnectedAccountCharge(
          connectedAccount.stripe_account_id,
          stripeChargeId
        );
      } catch (err: any) {
        logger.warn('Failed to fetch Stripe charge for transaction detail', {
          chargeId: stripeChargeId,
          error: err.message,
        });
      }
    }

    // Determine status
    let status: string = 'succeeded';
    if (order.status === 'failed') {
      status = 'failed';
    } else if (order.status === 'refunded') {
      status = 'refunded';
    } else if (charge) {
      if (charge.refunded) {
        status = 'refunded';
      } else if (charge.amount_refunded > 0) {
        status = 'partially_refunded';
      } else {
        status = charge.status;
      }
    }

    // Payment method
    let paymentMethod: { type: string; brand: string | null; last4: string | null } | null = null;
    if (charge?.payment_method_details) {
      const pm = charge.payment_method_details;
      if (pm.card) {
        paymentMethod = { type: 'card', brand: pm.card.brand, last4: pm.card.last4 };
      } else if (pm.card_present) {
        paymentMethod = { type: 'card_present', brand: pm.card_present.brand, last4: pm.card_present.last4 };
      } else if (pm.type) {
        paymentMethod = { type: pm.type, brand: null, last4: null };
      }
    } else if (order.payment_method) {
      paymentMethod = { type: order.payment_method, brand: null, last4: null };
    }

    // Billing address
    let billingAddress = null;
    if (charge?.billing_details?.address) {
      const addr = charge.billing_details.address;
      billingAddress = {
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        state: addr.state,
        postalCode: addr.postal_code,
        country: addr.country,
      };
    }

    // Refunds from Stripe
    const refunds = charge
      ? (charge.refunds?.data || []).map((refund) => ({
          id: refund.id,
          amount: refund.amount,
          status: refund.status || 'unknown',
          reason: refund.reason,
          created: refund.created,
        }))
      : [];

    // Fees
    let processingFee = 0;
    let netAmount = totalAmount;
    if (charge) {
      const platformFee = (charge as any).application_fee_amount ||
        (charge.metadata?.platform_fee_cents ? parseInt(charge.metadata.platform_fee_cents) : 0);
      const isCardPresent = charge.payment_method_details?.type === 'card_present';
      const stripeFeePercent = isCardPresent ? 0.027 : 0.029;
      const stripeFeeFixed = isCardPresent ? 15 : 30;
      const stripeFee = Math.round(charge.amount * stripeFeePercent) + stripeFeeFixed;
      processingFee = stripeFee + platformFee;
      netAmount = charge.amount - processingFee - charge.amount_refunded;
    }

    // Order items
    const itemRows = await query<{
      id: string;
      product_id: string | null;
      name: string;
      quantity: number;
      unit_price: string;
    }>(
      'SELECT id, product_id, name, quantity, unit_price FROM order_items WHERE order_id = $1',
      [order.id]
    );

    const orderItems = itemRows.length > 0
      ? itemRows.map((item) => ({
          id: item.id,
          productId: item.product_id,
          name: item.name,
          quantity: item.quantity,
          unitPrice: toSmallestUnit(parseFloat(item.unit_price), detailCurrency),
        }))
      : undefined;

    // Fetch all order payments (for split breakdown and cash details)
    const allPaymentRows = await query<{
      id: string;
      payment_method: string;
      amount: string;
      tip_amount: string;
      status: string;
      cash_tendered: string | null;
      cash_change: string | null;
      stripe_payment_intent_id: string | null;
      created_at: Date;
    }>(
      'SELECT id, payment_method, amount, tip_amount, status, cash_tendered, cash_change, stripe_payment_intent_id, created_at FROM order_payments WHERE order_id = $1 ORDER BY created_at ASC',
      [order.id]
    );

    // Cash payment details (for standalone cash orders)
    let cashTendered: number | null = null;
    let cashChange: number | null = null;
    if (order.payment_method === 'cash') {
      const cashRow = allPaymentRows.find(p => p.payment_method === 'cash');
      if (cashRow) {
        cashTendered = cashRow.cash_tendered ? parseInt(cashRow.cash_tendered) : null;
        cashChange = cashRow.cash_change ? parseInt(cashRow.cash_change) : null;
      }
    }

    // Payment breakdown (for split payments or any order with multiple payments)
    const orderPayments = allPaymentRows.length > 0
      ? allPaymentRows.map(p => ({
          id: p.id,
          paymentMethod: p.payment_method,
          amount: parseInt(p.amount),
          tipAmount: parseInt(p.tip_amount),
          status: p.status,
          cashTendered: p.cash_tendered ? parseInt(p.cash_tendered) : null,
          cashChange: p.cash_change ? parseInt(p.cash_change) : null,
          stripePaymentIntentId: p.stripe_payment_intent_id,
          created: Math.floor(new Date(p.created_at).getTime() / 1000),
        }))
      : undefined;

    const isQuickCharge = orderMetadata?.isQuickCharge || false;
    const tipAmount = toSmallestUnit(parseFloat(order.tip_amount || '0'), detailCurrency);
    const taxAmount = toSmallestUnit(parseFloat(order.tax_amount || '0'), detailCurrency);

    return c.json({
      id: order.id,
      amount: totalAmount,
      amountRefunded: charge?.amount_refunded || 0,
      currency: charge?.currency || connectedAccount?.default_currency || 'usd',
      status,
      description: charge?.description || null,
      customerEmail: order.customer_email || charge?.billing_details?.email || charge?.receipt_email || null,
      customerName: charge?.billing_details?.name || null,
      billingAddress,
      paymentMethod,
      receiptUrl: charge?.receipt_url || null,
      created: Math.floor(new Date(order.created_at).getTime() / 1000),
      metadata: charge?.metadata || orderMetadata,
      refunds,
      fees: { processingFee, netAmount },
      orderItems,
      isQuickCharge,
      tipAmount,
      taxAmount,
      cashTendered,
      cashChange,
      orderPayments,
      sourceType: 'order',
    });
  } catch (error: any) {
    logger.error('Error getting transaction', { error, transactionId });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to get transaction' }, 500);
  }
});

// ============================================
// POST /stripe/connect/transactions/:id/refund - Refund a transaction
// ============================================
const refundTransactionRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/transactions/{transactionId}/refund',
  summary: 'Refund a transaction (full or partial)',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      transactionId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().optional(), // If not provided, full refund
            reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Refund created successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            amount: z.number(),
            status: z.string(),
            reason: z.string().nullable(),
            created: z.number(),
          }),
        },
      },
    },
    400: { description: 'Bad request (e.g., already refunded)' },
    401: { description: 'Unauthorized' },
    403: { description: 'Only owners can issue refunds' },
    404: { description: 'Transaction not found' },
  },
});

app.openapi(refundTransactionRoute, async (c) => {
  const { transactionId } = c.req.param();
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Only owners can issue refunds
    if (payload.role !== 'owner') {
      return c.json({ error: 'Only organization owners can issue refunds' }, 403);
    }

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];
    const body = await c.req.json();

    // Get organization branding for email notifications
    const brandingRows = await query<{ name: string; branding_logo_id: string | null }>(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const vendorBranding = {
      organizationName: brandingRows[0]?.name || '',
      brandingLogoUrl: getImageUrl(brandingRows[0]?.branding_logo_id || null),
    };

    // transactionId is now an order ID — look up the order
    const orderLookup = await query<{ id: string; order_number: string; stripe_charge_id: string | null; payment_method: string | null; total_amount: string }>(
      'SELECT id, order_number, stripe_charge_id, payment_method, total_amount FROM orders WHERE id = $1 AND organization_id = $2',
      [transactionId, payload.organizationId]
    );

    // If not found in orders, check preorders
    if (orderLookup.length === 0) {
      const preorderLookup = await query<{
        id: string; order_number: string; daily_number: number | null; stripe_charge_id: string | null;
        stripe_payment_intent_id: string | null; payment_type: string; total_amount: string; status: string;
        customer_name: string; customer_email: string; catalog_id: string;
      }>(
        'SELECT id, order_number, daily_number, stripe_charge_id, stripe_payment_intent_id, payment_type, total_amount, status, customer_name, customer_email, catalog_id FROM preorders WHERE id = $1 AND organization_id = $2',
        [transactionId, payload.organizationId]
      );

      if (preorderLookup.length === 0) {
        // If not found in preorders, check tickets
        const ticketLookup = await query<{
          id: string; event_id: string; ticket_tier_id: string;
          stripe_charge_id: string | null; amount_paid: string;
          status: string; customer_email: string; customer_name: string;
          tier_name: string; event_name: string; starts_at: string; timezone: string;
        }>(
          `SELECT t.id, t.event_id, t.ticket_tier_id, t.stripe_charge_id,
                  t.amount_paid, t.status, t.customer_email, t.customer_name,
                  tt.name as tier_name, e.name as event_name, e.starts_at, e.timezone
           FROM tickets t
           JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
           JOIN events e ON t.event_id = e.id
           WHERE t.id = $1 AND t.organization_id = $2`,
          [transactionId, payload.organizationId]
        );

        if (ticketLookup.length === 0) {
          return c.json({ error: 'Transaction not found' }, 404);
        }

        const ticket = ticketLookup[0];

        if (ticket.status === 'refunded') {
          return c.json({ error: 'Ticket has already been refunded' }, 400);
        }

        if (ticket.status === 'cancelled') {
          return c.json({ error: 'Cannot refund a cancelled ticket' }, 400);
        }

        const amountPaid = parseFloat(ticket.amount_paid);
        const ticketCurrency = await getOrgCurrency(payload.organizationId);
        const refundAmountDollars = body.amount ? fromSmallestUnit(body.amount, ticketCurrency) : amountPaid;

        if (refundAmountDollars > amountPaid) {
          return c.json({ error: `Refund amount cannot exceed amount paid (${formatCurrencyUtil(amountPaid, ticketCurrency)})` }, 400);
        }

        // Stripe refund if charge exists
        let stripeRefundId: string | null = null;
        let refundAmountCents = toSmallestUnit(refundAmountDollars, ticketCurrency);

        if (ticket.stripe_charge_id) {
          const refund = await stripeService.createConnectedAccountRefund(
            connectedAccount.stripe_account_id,
            {
              charge: ticket.stripe_charge_id,
              amount: body.amount || undefined,
              reason: body.reason,
              metadata: {
                organization_id: payload.organizationId,
                user_id: payload.userId,
                initiated_by: 'dashboard',
                ticket_id: ticket.id,
                event_id: ticket.event_id,
              },
            }
          );
          stripeRefundId = refund.id;
          refundAmountCents = refund.amount;
        }

        // Update ticket status
        const isFullRefund = refundAmountDollars >= amountPaid;
        if (isFullRefund) {
          await query(
            `UPDATE tickets SET status = 'refunded' WHERE id = $1`,
            [ticket.id]
          );
        }

        // Update customer total_spent
        await query(
          `UPDATE customers
           SET total_spent = GREATEST(0, total_spent - $1), updated_at = NOW()
           WHERE organization_id = $2 AND email = $3`,
          [refundAmountDollars, payload.organizationId, ticket.customer_email.toLowerCase()]
        );

        // Emit socket event
        socketService.emitToOrganization(payload.organizationId, SocketEvents.TICKET_REFUNDED, {
          eventId: ticket.event_id,
          ticketId: ticket.id,
          refundAmount: fromSmallestUnit(refundAmountCents, ticketCurrency),
          isFullRefund,
          timestamp: new Date().toISOString(),
        });

        // Queue refund notification email
        const eventDate = new Date(ticket.starts_at);
        const eventTimezone = ticket.timezone || 'America/New_York';
        await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
          type: 'ticket_refund',
          to: ticket.customer_email,
          currency: ticketCurrency,
          vendorBranding,
          data: {
            customerName: ticket.customer_name || ticket.customer_email,
            eventName: ticket.event_name,
            eventDate: eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: eventTimezone }),
            tierName: ticket.tier_name,
            refundAmount: refundAmountDollars,
            isFullRefund,
            reason: body.reason,
          },
        });

        logger.info('Created ticket refund via transactions endpoint', {
          ticketId: ticket.id,
          eventId: ticket.event_id,
          refundAmount: refundAmountCents,
          isFullRefund,
          stripeRefundId,
          organizationId: payload.organizationId,
        });

        return c.json({
          id: stripeRefundId || `ticket_refund_${ticket.id}`,
          amount: refundAmountCents,
          status: 'succeeded',
          reason: body.reason || null,
          created: Math.floor(Date.now() / 1000),
        });
      }

      const preorder = preorderLookup[0];

      if (preorder.status === 'cancelled') {
        return c.json({ error: 'Preorder is already cancelled/refunded' }, 400);
      }

      // Get catalog name for cancellation email
      const cancelCatalogs = await query<{ name: string }>(
        `SELECT name FROM catalogs WHERE id = $1`,
        [preorder.catalog_id]
      );

      // Resolve the charge ID — may need to look up from payment intent
      let chargeId = preorder.stripe_charge_id;
      if (!chargeId && preorder.stripe_payment_intent_id) {
        try {
          const pi = await stripe.paymentIntents.retrieve(
            preorder.stripe_payment_intent_id,
            { stripeAccount: connectedAccount.stripe_account_id }
          );
          if (pi.latest_charge) {
            chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id;
            // Backfill stripe_charge_id for future lookups
            await query(
              `UPDATE preorders SET stripe_charge_id = $1 WHERE id = $2`,
              [chargeId, preorder.id]
            );
          }
        } catch (err) {
          logger.warn('Failed to retrieve charge from payment intent for preorder refund', {
            preorderId: preorder.id,
            paymentIntentId: preorder.stripe_payment_intent_id,
            error: (err as Error).message,
          });
        }
      }

      if (!chargeId) {
        // Pay-at-pickup preorder with no payment collected — just mark cancelled
        await query(
          `UPDATE preorders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
          [preorder.id]
        );

        socketService.emitToOrganization(payload.organizationId, SocketEvents.PREORDER_CANCELLED, {
          preorderId: preorder.id,
          orderNumber: preorder.order_number,
          timestamp: new Date().toISOString(),
        });

        socketService.emitToPreorder(preorder.id, SocketEvents.PREORDER_CANCELLED, {
          preorderId: preorder.id,
          status: 'cancelled',
        });

        // Queue cancellation email
        const preorderCurrency = connectedAccount?.default_currency || 'usd';
        await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
          type: 'preorder_cancelled',
          to: preorder.customer_email,
          currency: preorderCurrency,
          vendorBranding,
          data: {
            orderNumber: preorder.order_number,
            dailyNumber: preorder.daily_number,
            customerName: preorder.customer_name,
            catalogName: cancelCatalogs[0]?.name || 'Your order',
            cancellationReason: body.reason || 'Order cancelled by vendor',
            paymentType: preorder.payment_type,
            refundIssued: false,
            totalAmount: parseFloat(preorder.total_amount),
          },
        });
        const totalCents = toSmallestUnit(parseFloat(preorder.total_amount), preorderCurrency);
        return c.json({
          id: `preorder_refund_${preorder.id}`,
          amount: totalCents,
          status: 'succeeded',
          reason: body.reason || null,
          created: Math.floor(Date.now() / 1000),
        });
      }

      // Stripe refund — charge exists (pay_now or completed pay_at_pickup)
      const refund = await stripeService.createConnectedAccountRefund(
        connectedAccount.stripe_account_id,
        {
          charge: chargeId,
          amount: body.amount || undefined,
          reason: body.reason,
          metadata: {
            organization_id: payload.organizationId,
            user_id: payload.userId,
            initiated_by: 'app',
            preorder_id: preorder.id,
          },
        }
      );

      await query(
        `UPDATE preorders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [preorder.id]
      );

      socketService.emitToOrganization(payload.organizationId, SocketEvents.PREORDER_CANCELLED, {
        preorderId: preorder.id,
        orderNumber: preorder.order_number,
        refundAmount: fromSmallestUnit(refund.amount, refund.currency || 'usd'),
        timestamp: new Date().toISOString(),
      });

      socketService.emitToPreorder(preorder.id, SocketEvents.PREORDER_CANCELLED, {
        preorderId: preorder.id,
        status: 'cancelled',
      });

      // Queue cancellation email
      await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
        type: 'preorder_cancelled',
        to: preorder.customer_email,
        currency: connectedAccount?.default_currency || 'usd',
        vendorBranding,
        data: {
          orderNumber: preorder.order_number,
          dailyNumber: preorder.daily_number,
          customerName: preorder.customer_name,
          catalogName: cancelCatalogs[0]?.name || 'Your order',
          cancellationReason: body.reason || 'Order cancelled by vendor',
          paymentType: preorder.payment_type,
          refundIssued: true,
          totalAmount: parseFloat(preorder.total_amount),
        },
      });

      logger.info('Created preorder refund', {
        refundId: refund.id,
        preorderId: preorder.id,
        chargeId: preorder.stripe_charge_id,
        amount: refund.amount,
        organizationId: payload.organizationId,
      });

      return c.json({
        id: refund.id,
        amount: refund.amount,
        status: refund.status || 'succeeded',
        reason: refund.reason,
        created: refund.created,
      });
    }

    const order = orderLookup[0];

    // Cash payments: refund via DB only (no Stripe charge to refund)
    if (!order.stripe_charge_id) {
      const refundCurrency = connectedAccount?.default_currency || 'usd';
      const orderTotalCents = toSmallestUnit(parseFloat(order.total_amount), refundCurrency);
      const refundAmount = body.amount || orderTotalCents;
      const isFullRefund = refundAmount >= orderTotalCents;
      const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

      await query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, order.id]
      );

      socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_REFUNDED, {
        orderId: order.id,
        orderNumber: order.order_number,
        refundAmount: fromSmallestUnit(refundAmount, refundCurrency),
        isFullRefund,
        timestamp: new Date().toISOString(),
      });

      logger.info('Created cash refund', {
        orderId: order.id,
        amount: refundAmount,
        organizationId: payload.organizationId,
      });

      return c.json({
        id: `cash_refund_${order.id}`,
        amount: refundAmount,
        status: 'succeeded',
        reason: body.reason || null,
        created: Math.floor(Date.now() / 1000),
      });
    }

    // Stripe refund using the order's charge ID
    const refund = await stripeService.createConnectedAccountRefund(
      connectedAccount.stripe_account_id,
      {
        charge: order.stripe_charge_id,
        amount: body.amount,
        reason: body.reason,
        metadata: {
          organization_id: payload.organizationId,
          user_id: payload.userId,
          initiated_by: 'dashboard',
        },
      }
    );

    // Retrieve the charge to check if it's fully refunded
    const charge = await stripeService.retrieveConnectedAccountCharge(
      connectedAccount.stripe_account_id,
      order.stripe_charge_id
    );

    const isFullRefund = charge.refunded === true;
    const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

    // Update order status in database
    await query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, order.id]
    );

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_REFUNDED, {
      orderId: order.id,
      orderNumber: order.order_number,
      refundAmount: fromSmallestUnit(refund.amount, refund.currency || 'usd'),
      isFullRefund,
      timestamp: new Date().toISOString(),
    });

    logger.info('Created refund', {
      refundId: refund.id,
      orderId: order.id,
      chargeId: order.stripe_charge_id,
      amount: refund.amount,
      organizationId: payload.organizationId,
    });

    return c.json({
      id: refund.id,
      amount: refund.amount,
      status: refund.status || 'succeeded',
      reason: refund.reason,
      created: refund.created,
    });
  } catch (error: any) {
    logger.error('Error creating refund', { error, transactionId });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message || 'Invalid refund request' }, 400);
    }
    return c.json({ error: 'Failed to create refund' }, 500);
  }
});

// ============================================
// POST /stripe/connect/transactions/:transactionId/send-receipt - Send receipt email
// ============================================
const sendReceiptRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/transactions/{transactionId}/send-receipt',
  summary: 'Send receipt email for a transaction',
  description: 'Sends a receipt email to the specified email address for a completed transaction',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      transactionId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Receipt sent successfully',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
    },
    400: { description: 'Invalid request or transaction not completed' },
    401: { description: 'Unauthorized' },
    404: { description: 'Transaction not found' },
  },
});

app.openapi(sendReceiptRoute, async (c) => {
  try {
    const { transactionId } = c.req.param();
    const { email } = await c.req.json();

    // Verify auth and get payload
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const token = authHeader.replace('Bearer ', '');

    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // transactionId is now an order ID — look up the order
    const orderRows = await query<{
      id: string;
      order_number: string;
      status: string;
      payment_method: string | null;
      total_amount: string;
      stripe_charge_id: string | null;
      customer_email: string | null;
      created_at: Date;
    }>(
      'SELECT id, order_number, status, payment_method, total_amount, stripe_charge_id, customer_email, created_at FROM orders WHERE id = $1 AND organization_id = $2',
      [transactionId, payload.organizationId]
    );

    // Get organization name for merchant name
    const orgRows = await query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const merchantName = orgRows[0]?.name || undefined;

    // Helper to get card details from a Stripe charge
    const getChargeDetails = async (chargeId: string) => {
      const charge = await stripe.charges.retrieve(
        chargeId,
        { expand: ['payment_intent'] },
        { stripeAccount: connectedAccount.stripe_account_id }
      );

      if (charge.status !== 'succeeded') {
        return null;
      }

      let cardBrand: string | undefined;
      let cardLast4: string | undefined;
      const paymentMethodDetails = charge.payment_method_details;
      if (paymentMethodDetails?.type === 'card_present' && paymentMethodDetails.card_present) {
        cardBrand = paymentMethodDetails.card_present.brand || undefined;
        cardLast4 = paymentMethodDetails.card_present.last4 || undefined;
      } else if (paymentMethodDetails?.type === 'card' && paymentMethodDetails.card) {
        cardBrand = paymentMethodDetails.card.brand || undefined;
        cardLast4 = paymentMethodDetails.card.last4 || undefined;
      }

      return {
        receiptUrl: charge.receipt_url || null,
        amountRefunded: charge.amount_refunded || 0,
        cardBrand,
        cardLast4,
      };
    };

    if (orderRows.length > 0) {
      const order = orderRows[0];

      let receiptUrl: string | null = null;
      let cardBrand: string | undefined;
      let cardLast4: string | undefined;
      const receiptCurrency = connectedAccount?.default_currency || 'usd';
      let amount = toSmallestUnit(parseFloat(order.total_amount), receiptCurrency);
      let amountRefunded = 0;

      if (order.stripe_charge_id) {
        const details = await getChargeDetails(order.stripe_charge_id);
        if (!details) {
          return c.json({ error: 'Transaction must be completed before sending receipt' }, 400);
        }
        receiptUrl = details.receiptUrl;
        amountRefunded = details.amountRefunded;
        cardBrand = details.cardBrand;
        cardLast4 = details.cardLast4;
      }

      logger.info('Sending receipt email for order', {
        transactionId, email, amount, orderNumber: order.order_number,
        cardBrand, cardLast4, merchantName, paymentMethod: order.payment_method,
      });

      await emailService.sendReceipt(email, {
        amount,
        amountRefunded: amountRefunded || undefined,
        orderNumber: order.order_number,
        cardBrand,
        cardLast4,
        date: new Date(order.created_at),
        receiptUrl: receiptUrl || undefined,
        merchantName,
      }, receiptCurrency);

      logger.info('Receipt email sent successfully', {
        transactionId, email, organizationId: payload.organizationId,
        amount, amountRefunded, paymentMethod: order.payment_method,
      });

      return c.json({
        success: true,
        message: `Receipt sent to ${email}`,
      });
    }

    // Check preorders
    const preorderRows = await query<{
      id: string; order_number: string; status: string; payment_type: string;
      total_amount: string; stripe_charge_id: string | null; created_at: Date;
    }>(
      'SELECT id, order_number, status, payment_type, total_amount, stripe_charge_id, created_at FROM preorders WHERE id = $1 AND organization_id = $2',
      [transactionId, payload.organizationId]
    );

    if (preorderRows.length > 0) {
      const preorder = preorderRows[0];

      const receiptCurrency = connectedAccount?.default_currency || 'usd';
      let receiptUrl: string | null = null;
      let cardBrand: string | undefined;
      let cardLast4: string | undefined;
      let amount = toSmallestUnit(parseFloat(preorder.total_amount), receiptCurrency);
      let amountRefunded = 0;

      if (preorder.stripe_charge_id) {
        const details = await getChargeDetails(preorder.stripe_charge_id);
        if (!details) {
          return c.json({ error: 'Transaction must be completed before sending receipt' }, 400);
        }
        receiptUrl = details.receiptUrl;
        amountRefunded = details.amountRefunded;
        cardBrand = details.cardBrand;
        cardLast4 = details.cardLast4;
      }

      logger.info('Sending receipt email for preorder', {
        transactionId, email, amount, orderNumber: preorder.order_number, merchantName,
      });

      await emailService.sendReceipt(email, {
        amount,
        amountRefunded: amountRefunded || undefined,
        orderNumber: preorder.order_number,
        cardBrand,
        cardLast4,
        date: new Date(preorder.created_at),
        receiptUrl: receiptUrl || undefined,
        merchantName,
      }, receiptCurrency);

      logger.info('Preorder receipt email sent successfully', {
        transactionId, email, organizationId: payload.organizationId, amount,
      });

      return c.json({
        success: true,
        message: `Receipt sent to ${email}`,
      });
    }

    // Check tickets
    const ticketRows = await query<{
      id: string; event_id: string; stripe_charge_id: string | null;
      amount_paid: string; status: string; customer_name: string;
      purchased_at: Date; tier_name: string; event_name: string;
    }>(
      `SELECT t.id, t.event_id, t.stripe_charge_id, t.amount_paid, t.status,
              t.customer_name, t.purchased_at, tt.name as tier_name, e.name as event_name
       FROM tickets t
       JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
       JOIN events e ON t.event_id = e.id
       WHERE t.id = $1 AND t.organization_id = $2`,
      [transactionId, payload.organizationId]
    );

    if (ticketRows.length === 0) {
      return c.json({ error: 'Transaction not found' }, 404);
    }

    const ticket = ticketRows[0];

    const receiptCurrency = connectedAccount?.default_currency || 'usd';
    let receiptUrl: string | null = null;
    let cardBrand: string | undefined;
    let cardLast4: string | undefined;
    let amount = toSmallestUnit(parseFloat(ticket.amount_paid), receiptCurrency);
    let amountRefunded = 0;

    if (ticket.stripe_charge_id) {
      const details = await getChargeDetails(ticket.stripe_charge_id);
      if (!details) {
        return c.json({ error: 'Transaction must be completed before sending receipt' }, 400);
      }
      receiptUrl = details.receiptUrl;
      amountRefunded = details.amountRefunded;
      cardBrand = details.cardBrand;
      cardLast4 = details.cardLast4;
    }

    const ticketOrderNumber = `${ticket.event_name} - ${ticket.tier_name}`;

    logger.info('Sending receipt email for ticket', {
      transactionId, email, amount, ticketId: ticket.id, eventName: ticket.event_name, merchantName,
    });

    await emailService.sendReceipt(email, {
      amount,
      amountRefunded: amountRefunded || undefined,
      orderNumber: ticketOrderNumber,
      cardBrand,
      cardLast4,
      date: new Date(ticket.purchased_at),
      receiptUrl: receiptUrl || undefined,
      merchantName,
    }, receiptCurrency);

    logger.info('Ticket receipt email sent successfully', {
      transactionId, email, organizationId: payload.organizationId, amount,
    });

    return c.json({
      success: true,
      message: `Receipt sent to ${email}`,
    });
  } catch (error: any) {
    // Get transactionId safely - it might not be in scope if error occurred early
    const txnId = c.req.param('transactionId');
    logger.error('Error sending receipt', {
      error: error?.message || error,
      stack: error?.stack,
      name: error?.name,
      type: error?.type,
      transactionId: txnId,
    });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message || 'Transaction not found' }, 404);
    }
    return c.json({ error: error?.message || 'Failed to send receipt' }, 500);
  }
});

// Pro subscription check for analytics features
async function requirePro(organizationId: string): Promise<{ tier: string } | null> {
  const rows = await query<{ tier: string; status: string }>(
    `SELECT tier, status FROM subscriptions
     WHERE organization_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
    [organizationId]
  );
  if (rows.length === 0) return null;
  const { tier } = rows[0];
  if (tier !== 'pro' && tier !== 'enterprise') return null;
  return { tier };
}

// Dashboard metrics endpoint
const dashboardRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/dashboard',
  tags: ['Stripe Connect'],
  summary: 'Get dashboard metrics',
  description: 'Returns aggregated metrics for the vendor dashboard including sales, orders, and balance',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Dashboard metrics',
      content: {
        'application/json': {
          schema: z.object({
            today: z.object({
              sales: z.number(),
              orders: z.number(),
              averageOrderValue: z.number(),
              customers: z.number(),
            }),
            yesterday: z.object({
              sales: z.number(),
              orders: z.number(),
              averageOrderValue: z.number(),
              customers: z.number(),
            }),
            balance: z.object({
              available: z.number(),
              pending: z.number(),
              currency: z.string(),
            }),
            recentTransactions: z.array(z.object({
              id: z.string(),
              orderNumber: z.string().nullable(),
              amount: z.number(),
              currency: z.string(),
              status: z.string(),
              type: z.enum(['order', 'preorder', 'ticket', 'invoice']),
              customerName: z.string().nullable(),
              customerEmail: z.string().nullable(),
              created: z.number(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
    500: { description: 'Internal server error' },
  },
});

app.openapi(dashboardRoute, async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      `SELECT * FROM stripe_connected_accounts WHERE organization_id = $1`,
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // Calculate time boundaries
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

    // Run all 14 independent queries in parallel
    const [
      todayRows,
      yesterdayRows,
      todayPreorderRows,
      yesterdayPreorderRows,
      todayTicketRows,
      yesterdayTicketRows,
      todayInvoiceRows,
      yesterdayInvoiceRows,
      recentRows,
      recentPreorderRows,
      recentTicketRows,
      recentInvoiceRows,
      balance,
    ] = await Promise.all([
      // Today's orders
      query<{ total_amount: string; customer_email: string | null; status: string }>(
        `SELECT total_amount, customer_email, status FROM orders
         WHERE organization_id = $1 AND status IN ('completed', 'refunded')
         AND created_at >= $2`,
        [payload.organizationId, todayStart.toISOString()]
      ),
      // Yesterday's orders
      query<{ total_amount: string; customer_email: string | null; status: string }>(
        `SELECT total_amount, customer_email, status FROM orders
         WHERE organization_id = $1 AND status IN ('completed', 'refunded')
         AND created_at >= $2 AND created_at < $3`,
        [payload.organizationId, yesterdayStart.toISOString(), todayStart.toISOString()]
      ),
      // Today's preorders
      query<{ total_amount: string; customer_email: string | null }>(
        `SELECT total_amount, customer_email FROM preorders
         WHERE organization_id = $1 AND status NOT IN ('cancelled', 'pending')
         AND created_at >= $2`,
        [payload.organizationId, todayStart.toISOString()]
      ),
      // Yesterday's preorders
      query<{ total_amount: string; customer_email: string | null }>(
        `SELECT total_amount, customer_email FROM preorders
         WHERE organization_id = $1 AND status NOT IN ('cancelled', 'pending')
         AND created_at >= $2 AND created_at < $3`,
        [payload.organizationId, yesterdayStart.toISOString(), todayStart.toISOString()]
      ),
      // Today's ticket sales
      query<{ amount_paid: string; customer_email: string | null }>(
        `SELECT amount_paid, customer_email FROM tickets
         WHERE organization_id = $1 AND status != 'refunded'
         AND purchased_at >= $2`,
        [payload.organizationId, todayStart.toISOString()]
      ),
      // Yesterday's ticket sales
      query<{ amount_paid: string; customer_email: string | null }>(
        `SELECT amount_paid, customer_email FROM tickets
         WHERE organization_id = $1 AND status != 'refunded'
         AND purchased_at >= $2 AND purchased_at < $3`,
        [payload.organizationId, yesterdayStart.toISOString(), todayStart.toISOString()]
      ),
      // Today's paid invoices
      query<{ total_amount: string; customer_email: string | null }>(
        `SELECT total_amount, customer_email FROM invoices
         WHERE organization_id = $1 AND status = 'paid'
         AND paid_at >= $2`,
        [payload.organizationId, todayStart.toISOString()]
      ),
      // Yesterday's paid invoices
      query<{ total_amount: string; customer_email: string | null }>(
        `SELECT total_amount, customer_email FROM invoices
         WHERE organization_id = $1 AND status = 'paid'
         AND paid_at >= $2 AND paid_at < $3`,
        [payload.organizationId, yesterdayStart.toISOString(), todayStart.toISOString()]
      ),
      // Recent orders (last 6)
      query<{ id: string; order_number: string | null; total_amount: string; status: string; payment_method: string | null; customer_email: string | null; created_at: Date }>(
        `SELECT id, order_number, total_amount, status, payment_method, customer_email, created_at FROM orders
         WHERE organization_id = $1 AND status IN ('completed', 'refunded')
         ORDER BY created_at DESC LIMIT 6`,
        [payload.organizationId]
      ),
      // Recent preorders (last 6)
      query<{ id: string; order_number: string | null; total_amount: string; status: string; customer_name: string | null; customer_email: string | null; created_at: Date }>(
        `SELECT id, order_number, total_amount, status, customer_name, customer_email, created_at FROM preorders
         WHERE organization_id = $1 AND status NOT IN ('cancelled', 'pending')
         ORDER BY created_at DESC LIMIT 6`,
        [payload.organizationId]
      ),
      // Recent ticket sales (last 6)
      query<{ id: string; amount_paid: string; status: string; customer_name: string | null; customer_email: string | null; event_id: string; purchased_at: Date }>(
        `SELECT t.id, t.amount_paid, t.status, t.customer_name, t.customer_email, t.event_id, t.purchased_at
         FROM tickets t
         WHERE t.organization_id = $1 AND t.status != 'refunded'
         ORDER BY t.purchased_at DESC LIMIT 6`,
        [payload.organizationId]
      ),
      // Recent paid invoices (last 6)
      query<{ id: string; invoice_number: string; total_amount: string; customer_name: string | null; customer_email: string | null; paid_at: Date }>(
        `SELECT id, invoice_number, total_amount, customer_name, customer_email, paid_at FROM invoices
         WHERE organization_id = $1 AND status = 'paid'
         ORDER BY paid_at DESC LIMIT 6`,
        [payload.organizationId]
      ),
      // Stripe balance
      stripeService.getConnectedAccountBalance(connectedAccount.stripe_account_id),
    ]);

    // Get org's currency for conversions
    const dashCurrency = connectedAccount.default_currency || 'usd';

    // Calculate today's metrics (orders + preorders + tickets + invoices)
    const todayOrderSalesCents = todayRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.total_amount), dashCurrency), 0);
    const todayPreorderSalesCents = todayPreorderRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.total_amount), dashCurrency), 0);
    const todayTicketSalesCents = todayTicketRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.amount_paid), dashCurrency), 0);
    const todayInvoiceSalesCents = todayInvoiceRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.total_amount), dashCurrency), 0);
    const todaySales = fromSmallestUnit(todayOrderSalesCents + todayPreorderSalesCents + todayTicketSalesCents + todayInvoiceSalesCents, dashCurrency);
    const todayOrders = todayRows.length + todayPreorderRows.length + todayTicketRows.length + todayInvoiceRows.length;
    const todayAvgOrder = todayOrders > 0 ? todaySales / todayOrders : 0;
    const todayCustomerEmails = new Set([
      ...todayRows.map(o => o.customer_email).filter((e): e is string => !!e),
      ...todayPreorderRows.map(o => o.customer_email).filter((e): e is string => !!e),
      ...todayTicketRows.map(o => o.customer_email).filter((e): e is string => !!e),
      ...todayInvoiceRows.map(o => o.customer_email).filter((e): e is string => !!e),
    ]);
    const todayCustomers = todayCustomerEmails.size;

    // Calculate yesterday's metrics (orders + preorders + tickets + invoices)
    const yesterdayOrderSalesCents = yesterdayRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.total_amount), dashCurrency), 0);
    const yesterdayPreorderSalesCents = yesterdayPreorderRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.total_amount), dashCurrency), 0);
    const yesterdayTicketSalesCents = yesterdayTicketRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.amount_paid), dashCurrency), 0);
    const yesterdayInvoiceSalesCents = yesterdayInvoiceRows.reduce((sum, o) => sum + toSmallestUnit(parseFloat(o.total_amount), dashCurrency), 0);
    const yesterdaySales = fromSmallestUnit(yesterdayOrderSalesCents + yesterdayPreorderSalesCents + yesterdayTicketSalesCents + yesterdayInvoiceSalesCents, dashCurrency);
    const yesterdayOrders = yesterdayRows.length + yesterdayPreorderRows.length + yesterdayTicketRows.length + yesterdayInvoiceRows.length;
    const yesterdayCustomerEmails = new Set([
      ...yesterdayRows.map(o => o.customer_email).filter((e): e is string => !!e),
      ...yesterdayPreorderRows.map(o => o.customer_email).filter((e): e is string => !!e),
      ...yesterdayTicketRows.map(o => o.customer_email).filter((e): e is string => !!e),
      ...yesterdayInvoiceRows.map(o => o.customer_email).filter((e): e is string => !!e),
    ]);
    const yesterdayCustomers = yesterdayCustomerEmails.size;

    // Get balance amounts using org's currency
    const availableBalance = balance.available?.length > 0
      ? (balance.available.find(b => b.currency === dashCurrency) || balance.available[0])
      : null;
    const pendingBalance = balance.pending?.length > 0
      ? (balance.pending.find(b => b.currency === dashCurrency) || balance.pending[0])
      : null;

    // Format and merge recent transactions from all sources
    const recentTransactions = [
      ...recentRows.map(order => ({
        id: order.id,
        orderNumber: order.order_number || null,
        amount: Math.round(parseFloat(order.total_amount) * 100) / 100,
        currency: dashCurrency,
        status: order.status === 'completed' ? 'succeeded' : order.status,
        type: 'order' as const,
        customerName: null as string | null,
        customerEmail: order.customer_email || null,
        created: Math.floor(new Date(order.created_at).getTime() / 1000),
      })),
      ...recentPreorderRows.map(preorder => ({
        id: preorder.id,
        orderNumber: preorder.order_number || null,
        amount: Math.round(parseFloat(preorder.total_amount) * 100) / 100,
        currency: dashCurrency,
        status: preorder.status === 'picked_up' ? 'succeeded' : preorder.status,
        type: 'preorder' as const,
        customerName: preorder.customer_name || null,
        customerEmail: preorder.customer_email || null,
        created: Math.floor(new Date(preorder.created_at).getTime() / 1000),
      })),
      ...recentTicketRows.map(ticket => ({
        id: ticket.id,
        orderNumber: null as string | null,
        amount: Math.round(parseFloat(ticket.amount_paid) * 100) / 100,
        currency: dashCurrency,
        status: 'succeeded' as string,
        type: 'ticket' as const,
        customerName: ticket.customer_name || null,
        customerEmail: ticket.customer_email || null,
        created: Math.floor(new Date(ticket.purchased_at).getTime() / 1000),
      })),
      ...recentInvoiceRows.map(inv => ({
        id: inv.id,
        orderNumber: inv.invoice_number || null,
        amount: Math.round(parseFloat(inv.total_amount) * 100) / 100,
        currency: dashCurrency,
        status: 'succeeded' as string,
        type: 'invoice' as const,
        customerName: inv.customer_name || null,
        customerEmail: inv.customer_email || null,
        created: Math.floor(new Date(inv.paid_at).getTime() / 1000),
      })),
    ]
      .sort((a, b) => b.created - a.created)
      .slice(0, 6);

    return c.json({
      today: {
        sales: todaySales,
        orders: todayOrders,
        averageOrderValue: Math.round(todayAvgOrder * 100) / 100,
        customers: todayCustomers,
      },
      yesterday: {
        sales: yesterdaySales,
        orders: yesterdayOrders,
        averageOrderValue: yesterdayOrders > 0 ? Math.round((yesterdaySales / yesterdayOrders) * 100) / 100 : 0,
        customers: yesterdayCustomers,
      },
      balance: {
        available: availableBalance ? fromSmallestUnit(availableBalance.amount, dashCurrency) : 0,
        pending: pendingBalance ? fromSmallestUnit(pendingBalance.amount, dashCurrency) : 0,
        currency: availableBalance?.currency || pendingBalance?.currency || dashCurrency,
      },
      recentTransactions,
    });
  } catch (error: any) {
    logger.error('Error fetching dashboard metrics', {
      error: error.message || error,
      stack: error.stack,
      type: error.type,
      code: error.code,
    });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to fetch dashboard metrics', details: error.message }, 500);
  }
});

// Analytics endpoint
const analyticsRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/analytics',
  tags: ['Stripe Connect'],
  summary: 'Get analytics data',
  description: 'Returns analytics data for the specified time range',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      range: z.enum(['today', 'week', 'month', 'custom']).default('week'),
      offset: z.string().transform(Number).optional(), // Negative number to go back in time (e.g., -1 = previous period)
      startDate: z.string().optional(), // ISO date string for custom range (YYYY-MM-DD)
      endDate: z.string().optional(), // ISO date string for custom range (YYYY-MM-DD)
    }),
  },
  responses: {
    200: {
      description: 'Analytics data',
      content: {
        'application/json': {
          schema: z.object({
            metrics: z.object({
              revenue: z.number(),
              transactions: z.number(),
              averageTransaction: z.number(),
              previousRevenue: z.number(),
              previousTransactions: z.number(),
            }),
            revenueData: z.array(z.object({
              label: z.string(),
              revenue: z.number(),
            })),
            transactionData: z.array(z.object({
              label: z.string(),
              count: z.number(),
            })),
            paymentMethods: z.array(z.object({
              method: z.string(),
              percentage: z.number(),
              count: z.number(),
            })),
            peakHours: z.array(z.object({
              hour: z.string(),
              count: z.number(),
              percentage: z.number(),
            })),
            topProducts: z.array(z.object({
              productId: z.string().nullable(),
              name: z.string(),
              description: z.string().nullable(),
              imageUrl: z.string().nullable(),
              quantity: z.number(),
              revenue: z.number(),
              percentage: z.number(),
            })),
            catalogBreakdown: z.array(z.object({
              catalogId: z.string().nullable(),
              catalogName: z.string(),
              description: z.string().nullable(),
              location: z.string().nullable(),
              date: z.string().nullable(),
              createdAt: z.string().nullable(),
              productCount: z.number(),
              orderCount: z.number(),
              revenue: z.number(),
              percentage: z.number(),
            })),
            categoryBreakdown: z.array(z.object({
              categoryId: z.string().nullable(),
              categoryName: z.string(),
              quantity: z.number(),
              revenue: z.number(),
              percentage: z.number(),
            })),
            quickCharge: z.object({
              orders: z.number(),
              revenue: z.number(),
              percentage: z.number(),
            }),
            dayOfWeekHeatmap: z.array(z.object({
              day: z.number(),
              hour: z.number(),
              orderCount: z.number(),
              revenue: z.number(),
            })),
            avgOrderData: z.array(z.object({
              label: z.string(),
              value: z.number(),
            })),
            refunds: z.object({
              count: z.number(),
              amount: z.number(),
              rate: z.number(),
            }),
            customerMetrics: z.object({
              newCustomers: z.number(),
              returningCustomers: z.number(),
              repeatRate: z.number(),
            }),
            revenueVelocity: z.array(z.object({
              label: z.string(),
              cumulative: z.number(),
            })),
            tipStats: z.object({
              totalTips: z.number(),
              avgTip: z.number(),
              tippedOrders: z.number(),
              tipRate: z.number(),
            }),
            staffBreakdown: z.array(z.object({
              userId: z.string(),
              name: z.string(),
              avatarUrl: z.string().nullable(),
              orderCount: z.number(),
              revenue: z.number(),
              avgOrder: z.number(),
              percentage: z.number(),
            })),
            deviceBreakdown: z.array(z.object({
              deviceId: z.string(),
              deviceName: z.string().nullable(),
              modelName: z.string().nullable(),
              osName: z.string().nullable(),
              orderCount: z.number(),
              revenue: z.number(),
              avgOrder: z.number(),
              percentage: z.number(),
              lastUsed: z.string().nullable(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
    500: { description: 'Internal server error' },
  },
});

app.openapi(analyticsRoute, async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Analytics require a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const range = c.req.query('range') || 'week';
    const offset = parseInt(c.req.query('offset') || '0') || 0; // Offset for navigating to previous periods
    const customStartDate = c.req.query('startDate'); // ISO date string for custom range
    const customEndDate = c.req.query('endDate'); // ISO date string for custom range
    const now = new Date();
    let currentStart: Date;
    let currentEnd: Date;
    let previousStart: Date;
    let previousEnd: Date;

    switch (range) {
      case 'today':
        // Apply offset (negative = go back in days)
        currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        currentEnd = new Date(currentStart.getTime() + 24 * 60 * 60 * 1000 - 1);
        previousStart = new Date(currentStart.getTime() - 24 * 60 * 60 * 1000);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      case 'week': {
        // Start of current week (Monday)
        const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to days since Monday
        // Apply offset (negative = go back weeks)
        currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday + (offset * 7));
        currentEnd = new Date(currentStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
        // Previous week is the 7 days before current week start
        previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      }
      case 'month':
        // Single month with offset
        currentStart = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        currentEnd = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59);
        previousStart = new Date(now.getFullYear(), now.getMonth() + offset - 1, 1);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      case 'custom': {
        // Custom date range from query parameters
        if (!customStartDate || !customEndDate) {
          return c.json({ error: 'startDate and endDate required for custom range' }, 400);
        }
        currentStart = new Date(customStartDate);
        currentStart.setHours(0, 0, 0, 0);
        currentEnd = new Date(customEndDate);
        currentEnd.setHours(23, 59, 59, 999);
        // Previous period is same duration before the custom range
        const customDuration = currentEnd.getTime() - currentStart.getTime();
        previousEnd = new Date(currentStart.getTime() - 1);
        previousStart = new Date(currentStart.getTime() - customDuration - 1);
        break;
      }
      default: {
        // Default to week
        const defaultDayOfWeek = now.getDay();
        const defaultDaysFromMonday = defaultDayOfWeek === 0 ? 6 : defaultDayOfWeek - 1;
        currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - defaultDaysFromMonday);
        currentEnd = new Date(currentStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
        previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      }
    }

    // Use bounded query when viewing past periods (offset != 0) or custom date range
    const useBoundedQuery = offset !== 0 || range === 'custom';

    // Check Redis cache (5-minute TTL)
    const analyticsCacheKey = `analytics:${payload.organizationId}:${range}:${offset}:${currentStart.getTime()}:${currentEnd.getTime()}`;
    const cached = await cacheService.get<Record<string, any>>(analyticsCacheKey);
    if (cached) {
      return c.json(cached);
    }

    // ── Pre-compute conditions used by all queries ──
    const dateCondition = useBoundedQuery
      ? 'AND created_at >= $2 AND created_at <= $3'
      : 'AND created_at >= $2';
    const dateParams = useBoundedQuery
      ? [payload.organizationId, currentStart.toISOString(), currentEnd.toISOString()]
      : [payload.organizationId, currentStart.toISOString()];
    const orderDateCondition = useBoundedQuery
      ? 'AND o.created_at >= $2 AND o.created_at <= $3'
      : 'AND o.created_at >= $2';

    // Determine time series bucketing BEFORE running queries
    let timeSeriesBucketType: 'hourly' | 'daily' | 'monthly' = 'daily';
    if (range === 'today') {
      timeSeriesBucketType = 'hourly';
    } else if (range === 'custom') {
      const daysDiff = Math.ceil((currentEnd.getTime() - currentStart.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff <= 1) timeSeriesBucketType = 'hourly';
      else if (daysDiff > 90) timeSeriesBucketType = 'monthly';
    }

    // Build time series bucket expressions based on bucket type
    const orderTsBucket = timeSeriesBucketType === 'hourly'
      ? 'EXTRACT(HOUR FROM created_at)::text'
      : timeSeriesBucketType === 'monthly'
        ? "TO_CHAR(created_at, 'YYYY-MM')"
        : 'DATE(created_at)::text';
    const preorderTsBucket = orderTsBucket; // same column
    const ticketTsBucket = timeSeriesBucketType === 'hourly'
      ? 'EXTRACT(HOUR FROM purchased_at)::text'
      : timeSeriesBucketType === 'monthly'
        ? "TO_CHAR(purchased_at, 'YYYY-MM')"
        : 'DATE(purchased_at)::text';

    // Preorder/ticket helper conditions
    const preorderSuccessCond = (alias: string = '') => {
      const p = alias ? `${alias}.` : '';
      return `AND ((${p}payment_type = 'pay_now' AND ${p}status NOT IN ('cancelled', 'pending')) OR (${p}status = 'picked_up'))`;
    };
    const preorderDateCondition = useBoundedQuery
      ? 'AND created_at >= $2 AND created_at <= $3'
      : 'AND created_at >= $2';
    const preorderJoinDateCondition = useBoundedQuery
      ? 'AND po.created_at >= $2 AND po.created_at <= $3'
      : 'AND po.created_at >= $2';
    const ticketDateCondition = useBoundedQuery
      ? 'AND purchased_at >= $2 AND purchased_at <= $3'
      : 'AND purchased_at >= $2';

    // Invoice helper conditions
    const invoiceDateCondition = useBoundedQuery
      ? 'AND paid_at >= $2 AND paid_at <= $3'
      : 'AND paid_at >= $2';
    const invoiceTsBucket = timeSeriesBucketType === 'hourly'
      ? 'EXTRACT(HOUR FROM paid_at)::text'
      : timeSeriesBucketType === 'monthly'
        ? "TO_CHAR(paid_at, 'YYYY-MM')"
        : 'DATE(paid_at)::text';

    // ── Run ALL queries in parallel (27 queries) ──
    const [
      combinedMetricsResult,
      previousMetricsResult,
      orderTimeSeriesResult,
      paymentMethodResult,
      heatmapResult,
      topProductsResult,
      catalogBreakdownResult,
      categoryBreakdownResult,
      customerResult,
      staffResult,
      deviceResult,
      preorderCurrentAggResult,
      preorderPreviousAggResult,
      ticketCurrentAggResult,
      ticketPreviousAggResult,
      preorderTSResult,
      ticketTSResult,
      preorderTopProductsResult,
      preorderCatalogResult,
      preorderHeatmapResult,
      ticketHeatmapResult,
      cancelledPreordersResult,
      refundedTicketsResult,
      invoiceCurrentAggResult,
      invoicePreviousAggResult,
      invoiceTSResult,
      voidedInvoicesResult,
    ] = await Promise.all([
      // 0: Combined current-period order metrics (revenue + transactions + tips + quick charge + refunds)
      query<{
        revenue: string; transactions: string;
        total_tips: string; tipped_orders: string;
        qc_count: string; qc_revenue: string;
        refund_count: string; refund_amount: string;
      }>(
        `SELECT
          COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount END), 0)::text as revenue,
          COUNT(CASE WHEN status = 'completed' THEN 1 END)::text as transactions,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN tip_amount END), 0)::text as total_tips,
          COUNT(CASE WHEN status = 'completed' AND tip_amount > 0 THEN 1 END)::text as tipped_orders,
          COUNT(CASE WHEN status = 'completed' AND (metadata->>'isQuickCharge')::boolean = true THEN 1 END)::text as qc_count,
          COALESCE(SUM(CASE WHEN status = 'completed' AND (metadata->>'isQuickCharge')::boolean = true THEN total_amount END), 0)::text as qc_revenue,
          COUNT(CASE WHEN status = 'refunded' THEN 1 END)::text as refund_count,
          COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_amount END), 0)::text as refund_amount
        FROM orders
        WHERE organization_id = $1
          AND status IN ('completed', 'refunded')
          ${dateCondition}`,
        dateParams
      ),

      // 1: Previous period order metrics
      query<{ revenue: string; transactions: string }>(
        `SELECT
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as transactions
        FROM orders
        WHERE organization_id = $1
          AND status = 'completed'
          AND created_at >= $2
          AND created_at <= $3`,
        [payload.organizationId, previousStart.toISOString(), previousEnd.toISOString()]
      ),

      // 2: Order time series (dynamic bucketing based on range)
      query<{ bucket: string; revenue: string; order_count: string }>(
        `SELECT
          ${orderTsBucket} as bucket,
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as order_count
        FROM orders
        WHERE organization_id = $1
          AND status = 'completed'
          ${dateCondition}
        GROUP BY ${orderTsBucket}
        ORDER BY ${orderTsBucket}`,
        dateParams
      ),

      // 3: Payment method breakdown
      query<{ method: string | null; count: string; revenue: string }>(
        `SELECT
          payment_method::text as method,
          COUNT(*)::text as count,
          COALESCE(SUM(total_amount), 0)::text as revenue
        FROM orders
        WHERE organization_id = $1
          AND status = 'completed'
          ${dateCondition}
        GROUP BY payment_method
        ORDER BY COUNT(*) DESC`,
        dateParams
      ),

      // 4: Order heatmap (day × hour — also used to derive peak hours)
      query<{ day_of_week: string; hour: string; order_count: string; revenue: string }>(
        `SELECT
          EXTRACT(DOW FROM created_at)::text as day_of_week,
          EXTRACT(HOUR FROM created_at)::text as hour,
          COUNT(*)::text as order_count,
          COALESCE(SUM(total_amount), 0)::text as revenue
        FROM orders
        WHERE organization_id = $1
          AND status = 'completed'
          ${dateCondition}
        GROUP BY EXTRACT(DOW FROM created_at), EXTRACT(HOUR FROM created_at)
        ORDER BY EXTRACT(DOW FROM created_at), EXTRACT(HOUR FROM created_at)`,
        dateParams
      ),

      // 5: Top products from order_items
      query<{ product_id: string | null; name: string; description: string | null; image_url: string | null; quantity: string; revenue: string }>(
        `SELECT
          oi.product_id,
          COALESCE(oi.name, p.name, 'Unknown Product') as name,
          p.description,
          p.image_url,
          SUM(oi.quantity)::text as quantity,
          SUM(oi.quantity * oi.unit_price)::text as revenue
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE o.organization_id = $1
          AND o.status = 'completed'
          ${orderDateCondition}
        GROUP BY oi.product_id, COALESCE(oi.name, p.name, 'Unknown Product'), p.description, p.image_url
        ORDER BY SUM(oi.quantity) DESC
        LIMIT 10`,
        dateParams
      ),

      // 6: Catalog breakdown (uses subquery for product count to avoid GROUP BY interference)
      query<{
        catalog_id: string | null; catalog_name: string | null;
        catalog_description: string | null; catalog_location: string | null;
        catalog_date: string | null; catalog_created_at: string | null;
        product_count: string; order_count: string; revenue: string;
      }>(
        `SELECT
          o.catalog_id,
          c.name as catalog_name,
          c.description as catalog_description,
          c.location as catalog_location,
          c.date as catalog_date,
          c.created_at::text as catalog_created_at,
          COALESCE(cp_counts.cnt, 0)::text as product_count,
          COUNT(o.id)::text as order_count,
          SUM(o.total_amount)::text as revenue
        FROM orders o
        LEFT JOIN catalogs c ON o.catalog_id = c.id
        LEFT JOIN (
          SELECT cp.catalog_id, COUNT(*)::bigint as cnt FROM catalog_products cp
          JOIN catalogs cat ON cp.catalog_id = cat.id
          WHERE cat.organization_id = $1
          GROUP BY cp.catalog_id
        ) cp_counts ON cp_counts.catalog_id = c.id
        WHERE o.organization_id = $1
          AND o.status = 'completed'
          AND o.catalog_id IS NOT NULL
          AND (o.metadata->>'isQuickCharge')::boolean IS NOT TRUE
          ${orderDateCondition}
        GROUP BY o.catalog_id, c.name, c.description, c.location, c.date, c.created_at, c.id, cp_counts.cnt
        ORDER BY COUNT(o.id) DESC`,
        dateParams
      ),

      // 7: Category breakdown
      query<{ category_id: string | null; category_name: string | null; quantity: string; revenue: string }>(
        `SELECT
          oi.category_id,
          cat.name as category_name,
          SUM(oi.quantity)::text as quantity,
          SUM(oi.quantity * oi.unit_price)::text as revenue
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN categories cat ON oi.category_id = cat.id
        WHERE o.organization_id = $1
          AND o.status = 'completed'
          ${orderDateCondition}
        GROUP BY oi.category_id, cat.name
        ORDER BY SUM(oi.quantity) DESC
        LIMIT 10`,
        dateParams
      ),

      // 8: Customer metrics
      query<{ new_customers: string; returning_customers: string }>(
        `SELECT
          COUNT(CASE WHEN created_at >= $2 ${useBoundedQuery ? 'AND created_at <= $3' : ''} THEN 1 END)::text as new_customers,
          COUNT(CASE WHEN created_at < $2 THEN 1 END)::text as returning_customers
        FROM customers
        WHERE organization_id = $1
          AND total_orders > 0
          AND last_order_at >= $2
          ${useBoundedQuery ? 'AND last_order_at <= $3' : ''}`,
        dateParams
      ),

      // 9: Staff breakdown
      query<{
        user_id: string; first_name: string | null; last_name: string | null;
        avatar_image_id: string | null; order_count: string; revenue: string;
      }>(
        `SELECT
          o.user_id,
          u.first_name,
          u.last_name,
          u.avatar_image_id,
          COUNT(*)::text as order_count,
          COALESCE(SUM(o.total_amount), 0)::text as revenue
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        WHERE o.organization_id = $1
          AND o.status = 'completed'
          AND o.user_id IS NOT NULL
          ${orderDateCondition}
        GROUP BY o.user_id, u.first_name, u.last_name, u.avatar_image_id
        ORDER BY SUM(o.total_amount) DESC
        LIMIT 20`,
        dateParams
      ),

      // 10: Device breakdown
      query<{
        device_id: string; device_name: string | null; model_name: string | null;
        os_name: string | null; order_count: string; revenue: string; last_used: string | null;
      }>(
        `SELECT
          o.device_id,
          d.device_name,
          d.model_name,
          d.os_name,
          COUNT(*)::text as order_count,
          COALESCE(SUM(o.total_amount), 0)::text as revenue,
          MAX(o.created_at)::text as last_used
        FROM orders o
        LEFT JOIN devices d ON d.device_id = o.device_id
        WHERE o.organization_id = $1
          AND o.status = 'completed'
          AND o.device_id IS NOT NULL
          ${orderDateCondition}
        GROUP BY o.device_id, d.device_name, d.model_name, d.os_name
        ORDER BY SUM(o.total_amount) DESC
        LIMIT 20`,
        dateParams
      ),

      // 11: Preorder current period aggregate
      query<{ revenue: string; count: string; tips: string; tipped_count: string }>(
        `SELECT
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as count,
          COALESCE(SUM(tip_amount), 0)::text as tips,
          COUNT(CASE WHEN tip_amount > 0 THEN 1 END)::text as tipped_count
        FROM preorders
        WHERE organization_id = $1 ${preorderSuccessCond()}
          ${preorderDateCondition}`,
        dateParams
      ),

      // 12: Preorder previous period aggregate
      query<{ revenue: string; count: string; tips: string; tipped_count: string }>(
        `SELECT
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as count,
          COALESCE(SUM(tip_amount), 0)::text as tips,
          COUNT(CASE WHEN tip_amount > 0 THEN 1 END)::text as tipped_count
        FROM preorders
        WHERE organization_id = $1 ${preorderSuccessCond()}
          AND created_at >= $2 AND created_at <= $3`,
        [payload.organizationId, previousStart.toISOString(), previousEnd.toISOString()]
      ),

      // 13: Ticket current period aggregate
      query<{ revenue: string; count: string }>(
        `SELECT
          COALESCE(SUM(amount_paid), 0)::text as revenue,
          COUNT(*)::text as count
        FROM tickets
        WHERE organization_id = $1 AND status IN ('valid', 'used')
          ${ticketDateCondition}`,
        dateParams
      ),

      // 14: Ticket previous period aggregate
      query<{ revenue: string; count: string }>(
        `SELECT
          COALESCE(SUM(amount_paid), 0)::text as revenue,
          COUNT(*)::text as count
        FROM tickets
        WHERE organization_id = $1 AND status IN ('valid', 'used')
          AND purchased_at >= $2 AND purchased_at <= $3`,
        [payload.organizationId, previousStart.toISOString(), previousEnd.toISOString()]
      ),

      // 15: Preorder time series (only the needed bucket type)
      query<{ bucket: string; revenue: string; order_count: string }>(
        `SELECT
          ${preorderTsBucket} as bucket,
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as order_count
        FROM preorders
        WHERE organization_id = $1 ${preorderSuccessCond()}
          ${preorderDateCondition}
        GROUP BY ${preorderTsBucket}
        ORDER BY ${preorderTsBucket}`,
        dateParams
      ),

      // 16: Ticket time series (only the needed bucket type)
      query<{ bucket: string; revenue: string; order_count: string }>(
        `SELECT
          ${ticketTsBucket} as bucket,
          COALESCE(SUM(amount_paid), 0)::text as revenue,
          COUNT(*)::text as order_count
        FROM tickets
        WHERE organization_id = $1 AND status IN ('valid', 'used')
          ${ticketDateCondition}
        GROUP BY ${ticketTsBucket}
        ORDER BY ${ticketTsBucket}`,
        dateParams
      ),

      // 17: Preorder top products
      query<{ product_id: string | null; name: string; description: string | null; image_url: string | null; quantity: string; revenue: string }>(
        `SELECT
          pi.product_id,
          pi.name,
          p.description,
          p.image_url,
          SUM(pi.quantity)::text as quantity,
          SUM(pi.quantity * pi.unit_price)::text as revenue
        FROM preorder_items pi
        JOIN preorders po ON pi.preorder_id = po.id
        LEFT JOIN products p ON pi.product_id = p.id
        WHERE po.organization_id = $1 ${preorderSuccessCond('po')}
          ${preorderJoinDateCondition}
        GROUP BY pi.product_id, pi.name, p.description, p.image_url
        ORDER BY SUM(pi.quantity) DESC
        LIMIT 20`,
        dateParams
      ),

      // 18: Preorder catalog breakdown
      query<{ catalog_id: string | null; catalog_name: string | null; order_count: string; revenue: string }>(
        `SELECT
          p.catalog_id,
          c.name as catalog_name,
          COUNT(*)::text as order_count,
          COALESCE(SUM(p.total_amount), 0)::text as revenue
        FROM preorders p
        LEFT JOIN catalogs c ON p.catalog_id = c.id
        WHERE p.organization_id = $1 ${preorderSuccessCond('p')}
          ${preorderJoinDateCondition.replace(/po\./g, 'p.')}
        GROUP BY p.catalog_id, c.name`,
        dateParams
      ),

      // 19: Preorder heatmap (also used to derive preorder peak hours)
      query<{ day_of_week: string; hour: string; order_count: string; revenue: string }>(
        `SELECT
          EXTRACT(DOW FROM created_at)::text as day_of_week,
          EXTRACT(HOUR FROM created_at)::text as hour,
          COUNT(*)::text as order_count,
          COALESCE(SUM(total_amount), 0)::text as revenue
        FROM preorders
        WHERE organization_id = $1 ${preorderSuccessCond()}
          ${preorderDateCondition}
        GROUP BY EXTRACT(DOW FROM created_at), EXTRACT(HOUR FROM created_at)`,
        dateParams
      ),

      // 20: Ticket heatmap (also used to derive ticket peak hours)
      query<{ day_of_week: string; hour: string; order_count: string; revenue: string }>(
        `SELECT
          EXTRACT(DOW FROM purchased_at)::text as day_of_week,
          EXTRACT(HOUR FROM purchased_at)::text as hour,
          COUNT(*)::text as order_count,
          COALESCE(SUM(amount_paid), 0)::text as revenue
        FROM tickets
        WHERE organization_id = $1 AND status IN ('valid', 'used')
          ${ticketDateCondition}
        GROUP BY EXTRACT(DOW FROM purchased_at), EXTRACT(HOUR FROM purchased_at)`,
        dateParams
      ),

      // 21: Cancelled preorders (for refund stats)
      query<{ count: string; amount: string }>(
        `SELECT
          COUNT(*)::text as count,
          COALESCE(SUM(total_amount), 0)::text as amount
        FROM preorders
        WHERE organization_id = $1 AND status = 'cancelled' AND payment_type = 'pay_now'
          ${preorderDateCondition}`,
        dateParams
      ),

      // 22: Refunded tickets (for refund stats)
      query<{ count: string; amount: string }>(
        `SELECT
          COUNT(*)::text as count,
          COALESCE(SUM(amount_paid), 0)::text as amount
        FROM tickets
        WHERE organization_id = $1 AND status = 'refunded'
          ${ticketDateCondition}`,
        dateParams
      ),

      // 23: Invoice current period aggregate (paid invoices by paid_at)
      query<{ revenue: string; count: string }>(
        `SELECT
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as count
        FROM invoices
        WHERE organization_id = $1 AND status = 'paid'
          ${invoiceDateCondition}`,
        dateParams
      ),

      // 24: Invoice previous period aggregate
      query<{ revenue: string; count: string }>(
        `SELECT
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as count
        FROM invoices
        WHERE organization_id = $1 AND status = 'paid'
          AND paid_at >= $2 AND paid_at <= $3`,
        [payload.organizationId, previousStart.toISOString(), previousEnd.toISOString()]
      ),

      // 25: Invoice time series (by paid_at)
      query<{ bucket: string; revenue: string; order_count: string }>(
        `SELECT
          ${invoiceTsBucket} as bucket,
          COALESCE(SUM(total_amount), 0)::text as revenue,
          COUNT(*)::text as order_count
        FROM invoices
        WHERE organization_id = $1 AND status = 'paid'
          ${invoiceDateCondition}
        GROUP BY ${invoiceTsBucket}
        ORDER BY ${invoiceTsBucket}`,
        dateParams
      ),

      // 26: Voided invoices (for refund/void stats)
      query<{ count: string; amount: string }>(
        `SELECT
          COUNT(*)::text as count,
          COALESCE(SUM(total_amount), 0)::text as amount
        FROM invoices
        WHERE organization_id = $1 AND status = 'void'
          AND voided_at >= $2 ${useBoundedQuery ? 'AND voided_at <= $3' : ''}`,
        dateParams
      ),
    ]);

    // ── Process combined order metrics ──
    const cm = combinedMetricsResult[0];
    const currentRevenue = parseFloat(cm?.revenue || '0');
    const currentTransactions = parseInt(cm?.transactions || '0');
    const totalTips = Math.round(parseFloat(cm?.total_tips || '0') * 100) / 100;
    const tippedOrders = parseInt(cm?.tipped_orders || '0');
    const quickChargeOrders = parseInt(cm?.qc_count || '0');
    const quickChargeRevenue = parseFloat(cm?.qc_revenue || '0');
    const refundCount = parseInt(cm?.refund_count || '0');
    const refundAmount = Math.round(parseFloat(cm?.refund_amount || '0') * 100) / 100;

    const previousRevenue = parseFloat(previousMetricsResult[0]?.revenue || '0');
    const previousTransactions = parseInt(previousMetricsResult[0]?.transactions || '0');

    // ── Process order time series into labeled arrays ──
    let revenueData: Array<{ label: string; revenue: number }> = [];
    let transactionData: Array<{ label: string; count: number }> = [];

    const tsMap: Record<string, { revenue: number; count: number }> = {};
    orderTimeSeriesResult.forEach(row => {
      tsMap[row.bucket] = {
        revenue: parseFloat(row.revenue),
        count: parseInt(row.order_count),
      };
    });

    if (timeSeriesBucketType === 'hourly') {
      // Determine hour range
      const hoursWithTSData = Object.keys(tsMap).map(k => parseInt(k));
      let minHourTS = 9, maxHourTS = 21;
      if (hoursWithTSData.length > 0) {
        minHourTS = Math.min(minHourTS, Math.min(...hoursWithTSData));
        maxHourTS = Math.max(maxHourTS, Math.max(...hoursWithTSData));
      }
      if (range === 'custom') {
        // Full 24h for custom single-day
        minHourTS = 0;
        maxHourTS = 23;
      }
      for (let h = minHourTS; h <= maxHourTS; h++) {
        const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const label = `${hour12}${ampm}`;
        const bucket = String(h);
        revenueData.push({ label, revenue: Math.round((tsMap[bucket]?.revenue || 0) * 100) / 100 });
        transactionData.push({ label, count: tsMap[bucket]?.count || 0 });
      }
    } else if (timeSeriesBucketType === 'monthly') {
      // Monthly bucketing (custom > 90 days)
      const current = new Date(currentStart.getFullYear(), currentStart.getMonth(), 1);
      const endMonth = new Date(currentEnd.getFullYear(), currentEnd.getMonth(), 1);
      while (current <= endMonth) {
        const yearMonth = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
        const label = current.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        revenueData.push({ label, revenue: Math.round((tsMap[yearMonth]?.revenue || 0) * 100) / 100 });
        transactionData.push({ label, count: tsMap[yearMonth]?.count || 0 });
        current.setMonth(current.getMonth() + 1);
      }
    } else {
      // Daily bucketing
      if (range === 'week') {
        const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        for (let i = 0; i < 7; i++) {
          const date = new Date(currentStart.getTime() + i * 24 * 60 * 60 * 1000);
          const dateStr = date.toISOString().split('T')[0];
          revenueData.push({ label: dayNames[i], revenue: Math.round((tsMap[dateStr]?.revenue || 0) * 100) / 100 });
          transactionData.push({ label: dayNames[i], count: tsMap[dateStr]?.count || 0 });
        }
      } else if (range === 'month') {
        const daysInMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() + 1, 0).getDate();
        for (let i = 0; i < daysInMonth; i++) {
          const date = new Date(currentStart.getFullYear(), currentStart.getMonth(), i + 1);
          const dateStr = date.toISOString().split('T')[0];
          revenueData.push({ label: (i + 1).toString(), revenue: Math.round((tsMap[dateStr]?.revenue || 0) * 100) / 100 });
          transactionData.push({ label: (i + 1).toString(), count: tsMap[dateStr]?.count || 0 });
        }
      } else {
        // Custom daily (≤90 days)
        const current = new Date(currentStart);
        while (current <= currentEnd) {
          const dateStr = current.toISOString().split('T')[0];
          const label = current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          revenueData.push({ label, revenue: Math.round((tsMap[dateStr]?.revenue || 0) * 100) / 100 });
          transactionData.push({ label, count: tsMap[dateStr]?.count || 0 });
          current.setDate(current.getDate() + 1);
        }
      }
    }

    // ── Process payment methods ──
    const totalPaymentMethods = paymentMethodResult.reduce((sum, p) => sum + parseInt(p.count || '0'), 0);
    const paymentMethods = paymentMethodResult.map(p => {
      let displayMethod = 'Other';
      if (p.method === 'tap_to_pay') displayMethod = 'Tap to Pay';
      else if (p.method === 'card') displayMethod = 'Card';
      else if (p.method === 'cash') displayMethod = 'Cash';
      else if (p.method === 'split') displayMethod = 'Split Payment';
      else if (p.method) displayMethod = p.method.charAt(0).toUpperCase() + p.method.slice(1).replace(/_/g, ' ');

      return {
        method: displayMethod,
        count: parseInt(p.count || '0'),
        revenue: Math.round(parseFloat(p.revenue || '0') * 100) / 100,
        percentage: totalPaymentMethods > 0 ? Math.round((parseInt(p.count || '0') / totalPaymentMethods) * 100) : 0,
      };
    }).slice(0, 5);

    // ── Process heatmap & derive peak hours from it ──
    const dayOfWeekHeatmap = heatmapResult.map(row => ({
      day: parseInt(row.day_of_week),
      hour: parseInt(row.hour),
      orderCount: parseInt(row.order_count),
      revenue: Math.round(parseFloat(row.revenue) * 100) / 100,
    }));

    // Derive order peak hours from heatmap (sum across days for each hour)
    const hourCountMap: Record<number, number> = {};
    dayOfWeekHeatmap.forEach(entry => {
      hourCountMap[entry.hour] = (hourCountMap[entry.hour] || 0) + entry.orderCount;
    });

    const hoursWithData = Object.keys(hourCountMap).map(Number);
    let minHour = 9;
    let maxHour = 21;
    if (hoursWithData.length > 0) {
      minHour = Math.max(0, Math.min(...hoursWithData) - 1);
      maxHour = Math.min(23, Math.max(...hoursWithData) + 1);
      if (maxHour - minHour < 4) {
        minHour = Math.max(0, minHour - 2);
        maxHour = Math.min(23, maxHour + 2);
      }
    }

    // ── Process top products ──
    const totalProductQuantity = topProductsResult.reduce((sum, p) => sum + parseInt(p.quantity || '0'), 0);
    const topProducts = topProductsResult.map(p => ({
      productId: p.product_id,
      name: p.name,
      description: p.description,
      imageUrl: p.image_url,
      quantity: parseInt(p.quantity || '0'),
      revenue: parseFloat(p.revenue || '0'),
      percentage: totalProductQuantity > 0 ? Math.round((parseInt(p.quantity || '0') / totalProductQuantity) * 100) : 0,
    }));

    // ── Process catalog breakdown ──
    const totalCatalogOrders = catalogBreakdownResult.reduce((sum, c) => sum + parseInt(c.order_count || '0'), 0);
    const catalogBreakdown = catalogBreakdownResult.map(c => ({
      catalogId: c.catalog_id,
      catalogName: c.catalog_name || 'Unknown Catalog',
      description: c.catalog_description,
      location: c.catalog_location,
      date: c.catalog_date,
      createdAt: c.catalog_created_at,
      productCount: parseInt(c.product_count || '0'),
      orderCount: parseInt(c.order_count || '0'),
      revenue: parseFloat(c.revenue || '0'),
      percentage: totalCatalogOrders > 0 ? Math.round((parseInt(c.order_count || '0') / totalCatalogOrders) * 100) : 0,
    }));

    // ── Process category breakdown ──
    const totalCategoryQuantity = categoryBreakdownResult.reduce((sum, c) => sum + parseInt(c.quantity || '0'), 0);
    const categoryBreakdown = categoryBreakdownResult.map(c => ({
      categoryId: c.category_id,
      categoryName: c.category_name || 'Uncategorized',
      quantity: parseInt(c.quantity || '0'),
      revenue: parseFloat(c.revenue || '0'),
      percentage: totalCategoryQuantity > 0 ? Math.round((parseInt(c.quantity || '0') / totalCategoryQuantity) * 100) : 0,
    }));

    // ── Process customer metrics ──
    const newCustomers = parseInt(customerResult[0]?.new_customers || '0');
    const returningCustomers = parseInt(customerResult[0]?.returning_customers || '0');
    const totalCustomers = newCustomers + returningCustomers;
    const repeatRate = totalCustomers > 0 ? Math.round((returningCustomers / totalCustomers) * 1000) / 10 : 0;

    // ── Process staff breakdown ──
    const totalStaffOrders = staffResult.reduce((sum, s) => sum + parseInt(s.order_count || '0'), 0);
    const staffBreakdown = staffResult.map(s => {
      const orderCount = parseInt(s.order_count || '0');
      const revenue = Math.round(parseFloat(s.revenue || '0') * 100) / 100;
      return {
        userId: s.user_id,
        name: [s.first_name, s.last_name].filter(Boolean).join(' ') || 'Unknown',
        avatarUrl: s.avatar_image_id && config.images.fileServerUrl
          ? `${config.images.fileServerUrl}/images/${s.avatar_image_id}`
          : null,
        orderCount,
        revenue,
        avgOrder: orderCount > 0 ? Math.round((revenue / orderCount) * 100) / 100 : 0,
        percentage: totalStaffOrders > 0 ? Math.round((orderCount / totalStaffOrders) * 100) : 0,
      };
    });

    // ── Process device breakdown ──
    const totalDeviceOrders = deviceResult.reduce((sum, d) => sum + parseInt(d.order_count || '0'), 0);
    const deviceBreakdown = deviceResult.map(d => {
      const orderCount = parseInt(d.order_count || '0');
      const revenue = Math.round(parseFloat(d.revenue || '0') * 100) / 100;
      return {
        deviceId: d.device_id,
        deviceName: d.device_name || null,
        modelName: d.model_name || null,
        osName: d.os_name || null,
        orderCount,
        revenue,
        avgOrder: orderCount > 0 ? Math.round((revenue / orderCount) * 100) / 100 : 0,
        percentage: totalDeviceOrders > 0 ? Math.round((orderCount / totalDeviceOrders) * 100) : 0,
        lastUsed: d.last_used,
      };
    });

    // ── Merge preorder & ticket data ──

    // 1. Core metrics — add preorder + ticket revenue/count
    const preorderCurrentAgg = preorderCurrentAggResult[0];
    const ticketCurrentAgg = ticketCurrentAggResult[0];
    const preorderPreviousAgg = preorderPreviousAggResult[0];
    const ticketPreviousAgg = ticketPreviousAggResult[0];

    const preorderRevenue = parseFloat(preorderCurrentAgg?.revenue || '0');
    const preorderCount = parseInt(preorderCurrentAgg?.count || '0');
    const ticketRevenue = parseFloat(ticketCurrentAgg?.revenue || '0');
    const ticketCount = parseInt(ticketCurrentAgg?.count || '0');
    const invoiceRevenue = parseFloat(invoiceCurrentAggResult[0]?.revenue || '0');
    const invoiceCount = parseInt(invoiceCurrentAggResult[0]?.count || '0');

    const mergedCurrentRevenue = currentRevenue + preorderRevenue + ticketRevenue + invoiceRevenue;
    const mergedCurrentTransactions = currentTransactions + preorderCount + ticketCount + invoiceCount;
    const mergedCurrentAvg = mergedCurrentTransactions > 0 ? mergedCurrentRevenue / mergedCurrentTransactions : 0;

    // 2. Previous period metrics
    const prevPreorderRevenue = parseFloat(preorderPreviousAgg?.revenue || '0');
    const prevPreorderCount = parseInt(preorderPreviousAgg?.count || '0');
    const prevTicketRevenue = parseFloat(ticketPreviousAgg?.revenue || '0');
    const prevTicketCount = parseInt(ticketPreviousAgg?.count || '0');
    const prevInvoiceRevenue = parseFloat(invoicePreviousAggResult[0]?.revenue || '0');
    const prevInvoiceCount = parseInt(invoicePreviousAggResult[0]?.count || '0');

    const mergedPreviousRevenue = previousRevenue + prevPreorderRevenue + prevTicketRevenue + prevInvoiceRevenue;
    const mergedPreviousTransactions = previousTransactions + prevPreorderCount + prevTicketCount + prevInvoiceCount;

    // 3. Merge time series — add preorder/ticket values into each time bucket
    const preorderTSMap: Record<string, { revenue: number; count: number }> = {};
    preorderTSResult.forEach(row => {
      preorderTSMap[row.bucket] = {
        revenue: parseFloat(row.revenue || '0'),
        count: parseInt(row.order_count || '0'),
      };
    });
    const ticketTSMap: Record<string, { revenue: number; count: number }> = {};
    ticketTSResult.forEach(row => {
      ticketTSMap[row.bucket] = {
        revenue: parseFloat(row.revenue || '0'),
        count: parseInt(row.order_count || '0'),
      };
    });
    const invoiceTSMap: Record<string, { revenue: number; count: number }> = {};
    invoiceTSResult.forEach(row => {
      invoiceTSMap[row.bucket] = {
        revenue: parseFloat(row.revenue || '0'),
        count: parseInt(row.order_count || '0'),
      };
    });

    if (timeSeriesBucketType === 'hourly') {
      const hourLabels: Record<string, number> = {};
      for (let h = 0; h <= 23; h++) {
        const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const ampm = h >= 12 ? 'PM' : 'AM';
        hourLabels[`${hour12}${ampm}`] = h;
        hourLabels[`${hour12} ${ampm}`] = h;
      }
      revenueData = revenueData.map(rd => {
        const h = hourLabels[rd.label];
        if (h !== undefined) {
          const hStr = String(h);
          const preorderVal = preorderTSMap[hStr]?.revenue || 0;
          const ticketVal = ticketTSMap[hStr]?.revenue || 0;
          const invoiceVal = invoiceTSMap[hStr]?.revenue || 0;
          return { label: rd.label, revenue: Math.round((rd.revenue + preorderVal + ticketVal + invoiceVal) * 100) / 100 };
        }
        return rd;
      });
      transactionData = transactionData.map(td => {
        const h = hourLabels[td.label];
        if (h !== undefined) {
          const hStr = String(h);
          const preorderVal = preorderTSMap[hStr]?.count || 0;
          const ticketVal = ticketTSMap[hStr]?.count || 0;
          const invoiceVal = invoiceTSMap[hStr]?.count || 0;
          return { label: td.label, count: td.count + preorderVal + ticketVal + invoiceVal };
        }
        return td;
      });
    } else if (timeSeriesBucketType === 'daily') {
      for (let i = 0; i < revenueData.length; i++) {
        const date = new Date(currentStart.getTime() + i * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().split('T')[0];
        const preorderVal = preorderTSMap[dateStr];
        const ticketVal = ticketTSMap[dateStr];
        const invoiceVal = invoiceTSMap[dateStr];
        if (preorderVal || ticketVal || invoiceVal) {
          revenueData[i] = {
            label: revenueData[i].label,
            revenue: Math.round((revenueData[i].revenue + (preorderVal?.revenue || 0) + (ticketVal?.revenue || 0) + (invoiceVal?.revenue || 0)) * 100) / 100,
          };
          transactionData[i] = {
            label: transactionData[i].label,
            count: transactionData[i].count + (preorderVal?.count || 0) + (ticketVal?.count || 0) + (invoiceVal?.count || 0),
          };
        }
      }
    } else {
      // Monthly
      for (let i = 0; i < revenueData.length; i++) {
        const monthDate = new Date(currentStart.getFullYear(), currentStart.getMonth() + i, 1);
        const yearMonth = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
        const preorderVal = preorderTSMap[yearMonth];
        const ticketVal = ticketTSMap[yearMonth];
        const invoiceVal = invoiceTSMap[yearMonth];
        if (preorderVal || ticketVal || invoiceVal) {
          revenueData[i] = {
            label: revenueData[i].label,
            revenue: Math.round((revenueData[i].revenue + (preorderVal?.revenue || 0) + (ticketVal?.revenue || 0) + (invoiceVal?.revenue || 0)) * 100) / 100,
          };
          transactionData[i] = {
            label: transactionData[i].label,
            count: transactionData[i].count + (preorderVal?.count || 0) + (ticketVal?.count || 0) + (invoiceVal?.count || 0),
          };
        }
      }
    }

    // 4. Payment methods — add "Preorder" and "Ticket Sale" entries
    const mergedPaymentMethods = [...paymentMethods];
    if (preorderCount > 0) {
      mergedPaymentMethods.push({
        method: 'Preorder',
        count: preorderCount,
        revenue: Math.round(preorderRevenue * 100) / 100,
        percentage: 0,
      });
    }
    if (ticketCount > 0) {
      mergedPaymentMethods.push({
        method: 'Ticket Sale',
        count: ticketCount,
        revenue: Math.round(ticketRevenue * 100) / 100,
        percentage: 0,
      });
    }
    if (invoiceCount > 0) {
      mergedPaymentMethods.push({
        method: 'Invoice',
        count: invoiceCount,
        revenue: Math.round(invoiceRevenue * 100) / 100,
        percentage: 0,
      });
    }
    const mergedTotalPayments = mergedPaymentMethods.reduce((sum, p) => sum + p.count, 0);
    mergedPaymentMethods.forEach(p => {
      p.percentage = mergedTotalPayments > 0 ? Math.round((p.count / mergedTotalPayments) * 100) : 0;
    });

    // 5. Peak hours — derive preorder/ticket peak hours from their heatmap data
    const preorderPeakMap: Record<number, number> = {};
    preorderHeatmapResult.forEach(row => {
      const hour = parseInt(row.hour);
      preorderPeakMap[hour] = (preorderPeakMap[hour] || 0) + parseInt(row.order_count);
    });
    const ticketPeakMap: Record<number, number> = {};
    ticketHeatmapResult.forEach(row => {
      const hour = parseInt(row.hour);
      ticketPeakMap[hour] = (ticketPeakMap[hour] || 0) + parseInt(row.order_count);
    });

    const allPeakHoursWithData = new Set([
      ...Object.keys(hourCountMap).map(Number),
      ...Object.keys(preorderPeakMap).map(Number),
      ...Object.keys(ticketPeakMap).map(Number),
    ]);

    let mergedMinHour = minHour;
    let mergedMaxHour = maxHour;
    if (allPeakHoursWithData.size > 0) {
      const allHoursArr = [...allPeakHoursWithData];
      mergedMinHour = Math.max(0, Math.min(mergedMinHour, Math.min(...allHoursArr) - 1));
      mergedMaxHour = Math.min(23, Math.max(mergedMaxHour, Math.max(...allHoursArr) + 1));
      if (mergedMaxHour - mergedMinHour < 4) {
        mergedMinHour = Math.max(0, mergedMinHour - 2);
        mergedMaxHour = Math.min(23, mergedMaxHour + 2);
      }
    }

    let mergedTotalHourTransactions = 0;
    const mergedPeakHoursData: Array<{ hour: string; count: number; percentage: number }> = [];
    for (let h = mergedMinHour; h <= mergedMaxHour; h++) {
      const count = (hourCountMap[h] || 0) + (preorderPeakMap[h] || 0) + (ticketPeakMap[h] || 0);
      mergedTotalHourTransactions += count;
      const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      const ampm = h >= 12 ? 'PM' : 'AM';
      mergedPeakHoursData.push({
        hour: `${hour12} ${ampm}`,
        count,
        percentage: 0,
      });
    }
    mergedPeakHoursData.forEach(ph => {
      ph.percentage = mergedTotalHourTransactions > 0 ? Math.round((ph.count / mergedTotalHourTransactions) * 100) : 0;
    });

    // 6. Heatmap — merge preorder/ticket data into same day/hour grid
    const heatmapMergeMap: Record<string, { orderCount: number; revenue: number }> = {};
    dayOfWeekHeatmap.forEach(entry => {
      const key = `${entry.day}-${entry.hour}`;
      heatmapMergeMap[key] = { orderCount: entry.orderCount, revenue: entry.revenue };
    });
    preorderHeatmapResult.forEach(row => {
      const key = `${parseInt(row.day_of_week)}-${parseInt(row.hour)}`;
      if (!heatmapMergeMap[key]) {
        heatmapMergeMap[key] = { orderCount: 0, revenue: 0 };
      }
      heatmapMergeMap[key].orderCount += parseInt(row.order_count);
      heatmapMergeMap[key].revenue += parseFloat(row.revenue);
    });
    ticketHeatmapResult.forEach(row => {
      const key = `${parseInt(row.day_of_week)}-${parseInt(row.hour)}`;
      if (!heatmapMergeMap[key]) {
        heatmapMergeMap[key] = { orderCount: 0, revenue: 0 };
      }
      heatmapMergeMap[key].orderCount += parseInt(row.order_count);
      heatmapMergeMap[key].revenue += parseFloat(row.revenue);
    });
    const mergedHeatmap = Object.entries(heatmapMergeMap).map(([key, val]) => {
      const [day, hour] = key.split('-').map(Number);
      return {
        day,
        hour,
        orderCount: val.orderCount,
        revenue: Math.round(val.revenue * 100) / 100,
      };
    }).sort((a, b) => a.day !== b.day ? a.day - b.day : a.hour - b.hour);

    // 7. Top products — merge preorder items, re-sort, take top 10
    const productMergeMap: Record<string, { productId: string | null; name: string; description: string | null; imageUrl: string | null; quantity: number; revenue: number }> = {};
    topProducts.forEach(p => {
      const key = p.productId || `unnamed:${p.name}`;
      productMergeMap[key] = { ...p };
    });
    preorderTopProductsResult.forEach(p => {
      const key = p.product_id || `unnamed:${p.name}`;
      if (productMergeMap[key]) {
        productMergeMap[key].quantity += parseInt(p.quantity || '0');
        productMergeMap[key].revenue += parseFloat(p.revenue || '0');
      } else {
        productMergeMap[key] = {
          productId: p.product_id,
          name: p.name,
          description: p.description,
          imageUrl: p.image_url,
          quantity: parseInt(p.quantity || '0'),
          revenue: parseFloat(p.revenue || '0'),
        };
      }
    });
    const mergedTopProductsList = Object.values(productMergeMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10);
    const mergedTotalProductQty = mergedTopProductsList.reduce((sum, p) => sum + p.quantity, 0);
    const mergedTopProducts = mergedTopProductsList.map(p => ({
      ...p,
      percentage: mergedTotalProductQty > 0 ? Math.round((p.quantity / mergedTotalProductQty) * 100) : 0,
    }));

    // 8. Catalog breakdown — merge preorder catalog counts
    const catalogMergeMap: Record<string, typeof catalogBreakdown[0]> = {};
    catalogBreakdown.forEach(c => {
      catalogMergeMap[c.catalogId || 'null'] = { ...c };
    });
    preorderCatalogResult.forEach(pc => {
      const key = pc.catalog_id || 'null';
      if (catalogMergeMap[key]) {
        catalogMergeMap[key].orderCount += parseInt(pc.order_count || '0');
        catalogMergeMap[key].revenue += parseFloat(pc.revenue || '0');
      } else {
        catalogMergeMap[key] = {
          catalogId: pc.catalog_id,
          catalogName: pc.catalog_name || 'Unknown Catalog',
          description: null,
          location: null,
          date: null,
          createdAt: null,
          productCount: 0,
          orderCount: parseInt(pc.order_count || '0'),
          revenue: parseFloat(pc.revenue || '0'),
          percentage: 0,
        };
      }
    });
    const mergedCatalogList = Object.values(catalogMergeMap).sort((a, b) => b.orderCount - a.orderCount);
    const mergedTotalCatalogOrders = mergedCatalogList.reduce((sum, c) => sum + c.orderCount, 0);
    const mergedCatalogBreakdown = mergedCatalogList.map(c => ({
      ...c,
      percentage: mergedTotalCatalogOrders > 0 ? Math.round((c.orderCount / mergedTotalCatalogOrders) * 100) : 0,
    }));

    // 9. Tip stats — add preorder tips
    const preorderTips = parseFloat(preorderCurrentAgg?.tips || '0');
    const preorderTippedCount = parseInt(preorderCurrentAgg?.tipped_count || '0');
    const mergedTotalTips = Math.round((totalTips + preorderTips) * 100) / 100;
    const mergedTippedOrders = tippedOrders + preorderTippedCount;
    const mergedAvgTip = mergedTippedOrders > 0
      ? Math.round(((totalTips + preorderTips) / mergedTippedOrders) * 100) / 100
      : 0;
    const mergedTipRate = mergedCurrentTransactions > 0
      ? Math.round((mergedTippedOrders / mergedCurrentTransactions) * 1000) / 10
      : 0;

    // 10. Refund stats — add cancelled preorders + refunded tickets
    const cancelledPreorderCount = parseInt(cancelledPreordersResult[0]?.count || '0');
    const cancelledPreorderAmount = Math.round(parseFloat(cancelledPreordersResult[0]?.amount || '0') * 100) / 100;
    const refundedTicketCount = parseInt(refundedTicketsResult[0]?.count || '0');
    const refundedTicketAmount = Math.round(parseFloat(refundedTicketsResult[0]?.amount || '0') * 100) / 100;

    const voidedInvoiceCount = parseInt(voidedInvoicesResult[0]?.count || '0');
    const voidedInvoiceAmount = Math.round(parseFloat(voidedInvoicesResult[0]?.amount || '0') * 100) / 100;

    const mergedRefundCount = refundCount + cancelledPreorderCount + refundedTicketCount + voidedInvoiceCount;
    const mergedRefundAmount = Math.round((refundAmount + cancelledPreorderAmount + refundedTicketAmount + voidedInvoiceAmount) * 100) / 100;
    const mergedTotalOrdersForRate = mergedCurrentTransactions + mergedRefundCount;
    const mergedRefundRate = mergedTotalOrdersForRate > 0
      ? Math.round((mergedRefundCount / mergedTotalOrdersForRate) * 1000) / 10
      : 0;

    // Recompute average order data from merged revenue/transaction data
    const mergedAvgOrderData = revenueData.map((rd, i) => {
      const count = transactionData[i]?.count || 0;
      return {
        label: rd.label,
        value: count > 0 ? Math.round((rd.revenue / count) * 100) / 100 : 0,
      };
    });

    // Recompute revenue velocity from merged revenueData
    let mergedCumulativeSum = 0;
    const mergedRevenueVelocity = revenueData.map(rd => {
      mergedCumulativeSum += rd.revenue;
      return { label: rd.label, cumulative: Math.round(mergedCumulativeSum * 100) / 100 };
    });

    // Recompute quick charge percentage against merged total
    const mergedQuickChargePercentage = mergedCurrentTransactions > 0
      ? Math.round((quickChargeOrders / mergedCurrentTransactions) * 100)
      : 0;

    const analyticsResponse = {
      metrics: {
        revenue: Math.round(mergedCurrentRevenue * 100) / 100,
        transactions: mergedCurrentTransactions,
        averageTransaction: Math.round(mergedCurrentAvg * 100) / 100,
        previousRevenue: Math.round(mergedPreviousRevenue * 100) / 100,
        previousTransactions: mergedPreviousTransactions,
      },
      revenueData,
      transactionData,
      paymentMethods: mergedPaymentMethods,
      peakHours: mergedPeakHoursData,
      topProducts: mergedTopProducts,
      catalogBreakdown: mergedCatalogBreakdown,
      categoryBreakdown,
      quickCharge: {
        orders: quickChargeOrders,
        revenue: Math.round(quickChargeRevenue * 100) / 100,
        percentage: mergedQuickChargePercentage,
      },
      dayOfWeekHeatmap: mergedHeatmap,
      avgOrderData: mergedAvgOrderData,
      refunds: {
        count: mergedRefundCount,
        amount: mergedRefundAmount,
        rate: mergedRefundRate,
      },
      customerMetrics: {
        newCustomers,
        returningCustomers,
        repeatRate,
      },
      revenueVelocity: mergedRevenueVelocity,
      tipStats: {
        totalTips: mergedTotalTips,
        avgTip: mergedAvgTip,
        tippedOrders: mergedTippedOrders,
        tipRate: mergedTipRate,
      },
      staffBreakdown,
      deviceBreakdown,
    };

    // Cache for 5 minutes
    await cacheService.set(analyticsCacheKey, analyticsResponse, { ttl: 300 });

    return c.json(analyticsResponse);
  } catch (error: any) {
    logger.error('Error fetching analytics', {
      error: error.message || error,
      stack: error.stack,
    });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to fetch analytics', details: error.message }, 500);
  }
});

// ============================================
// POST /stripe/connect/account-session - Create an Account Session for embedded onboarding
// ============================================
const createAccountSessionRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/account-session',
  summary: 'Create an Account Session for embedded onboarding',
  description: 'Creates an Account Session that allows the embedded onboarding component to collect account information',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Account session created successfully',
      content: {
        'application/json': {
          schema: z.object({
            clientSecret: z.string(),
            expiresAt: z.number(),
            stripeAccountId: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(createAccountSessionRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get the connected account for this organization
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // Create an Account Session for embedded onboarding
    const accountSession = await stripe.accountSessions.create({
      account: connectedAccount.stripe_account_id,
      components: {
        account_onboarding: {
          enabled: true,
          features: {
            external_account_collection: true,
          },
        },
      },
    });

    logger.info('Account session created for embedded onboarding', {
      organizationId: payload.organizationId,
      stripeAccountId: connectedAccount.stripe_account_id,
      expiresAt: accountSession.expires_at,
    });

    return c.json({
      clientSecret: accountSession.client_secret,
      expiresAt: accountSession.expires_at,
      stripeAccountId: connectedAccount.stripe_account_id,
    });
  } catch (error: any) {
    logger.error('Error creating account session', {
      error: error.message || error,
      stack: error.stack,
    });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to create account session' }, 500);
  }
});

export default app;

// Export the sync function for use in webhooks
export { syncAccountFromStripe, deriveOnboardingState };
