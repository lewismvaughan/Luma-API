import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { authService } from '../../services/auth';
import { cognitoService } from '../../services/auth/cognito';
import { staffService } from '../../services/staff';
import { deviceService } from '../../services/device';
import { logger } from '../../utils/logger';
import { query } from '../../db';
import { config } from '../../config';
import signupRoutes from './signup';
import { sendPasswordResetEmail, sendTemplatedEmail } from '../../services/email/template-sender';
import { emailService } from '../../services/email';
import { cacheService, CacheKeys } from '../../services/redis/cache';
import { imageService } from '../../services/images';
import { stripe } from '../../services/stripe';
import { loginRateLimit, forgotPasswordRateLimit, resetPasswordRateLimit, checkRateLimit } from '../../middleware/rate-limit';
import { getComputedRates } from '../../config/stripe-rates';

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      logger.error('[Auth OpenAPI Validation Error]', {
        path: c.req.path,
        method: c.req.method,
        errors: result.error.issues,
        errorFlat: result.error.flatten(),
      });
      return c.json(
        {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.issues,
        },
        400
      );
    }
    return undefined;
  },
});

// Mount signup routes
app.route('/', signupRoutes);

// Rate limiting on public auth endpoints
app.use('/auth/login', loginRateLimit);
app.use('/auth/forgot-password', forgotPasswordRateLimit);
app.use('/auth/reset-password', resetPasswordRateLimit);
app.use('/auth/validate-reset-token', resetPasswordRateLimit);
app.use('/auth/check-email', checkRateLimit);
app.use('/auth/check-password', checkRateLimit);

const DeviceInfoSchema = z.object({
  name: z.string().max(255).optional(),
  model: z.string().max(255).optional(),
  os: z.string().max(255).optional(),
  osVersion: z.string().max(255).optional(),
  appVersion: z.string().max(50).optional(),
});

const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  source: z.enum(['app', 'web']).optional().default('web'),
  // Device tracking fields (for mobile app)
  deviceId: z.string().max(255).optional(),
  deviceInfo: DeviceInfoSchema.optional(),
});

const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    organizationId: z.string(),
    role: z.string(),
    emailAlerts: z.boolean(),
    marketingEmails: z.boolean(),
    weeklyReports: z.boolean(),
    avatarUrl: z.string().nullable(),
    onboardingCompleted: z.boolean(),
  }),
  tokens: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
  }),
  sessionVersion: z.number(), // For single session enforcement
});

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  summary: 'Login to account',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: LoginRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: {
        'application/json': {
          schema: LoginResponseSchema,
        },
      },
    },
    401: {
      description: 'Invalid credentials',
    },
  },
});

app.openapi(loginRoute, async (c) => {
  const body = await c.req.json();
  const validated = LoginRequestSchema.parse(body);

  try {
    // First get the user to check if they're staff and verify subscription
    const user = await authService.getUserByEmail(validated.email);

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Check if this is a staff member (has invited_by set)
    if (user.invited_by) {
      // Check if organization has active subscription AND tier that allows staff
      const subscriptionResult = await query<{ status: string; tier: string }>(
        `SELECT status, tier FROM subscriptions
         WHERE organization_id = $1 AND status IN ('active', 'trialing')
         LIMIT 1`,
        [user.organization_id]
      );

      if (subscriptionResult.length === 0) {
        logger.warn('Staff login blocked - no active subscription', {
          userId: user.id,
          email: user.email,
          organizationId: user.organization_id,
        });
        return c.json({
          error: 'Your account has been temporarily disabled because your organization\'s subscription is no longer active. Please contact your organization administrator.',
          code: 'SUBSCRIPTION_INACTIVE'
        }, 403);
      }

      // Check if tier allows staff access (starter/free tier does not allow staff)
      const subscription = subscriptionResult[0];
      if (subscription.tier === 'starter' || subscription.tier === 'free') {
        logger.warn('Staff login blocked - free tier does not allow staff', {
          userId: user.id,
          email: user.email,
          organizationId: user.organization_id,
          tier: subscription.tier,
        });
        return c.json({
          error: 'Your account has been temporarily disabled because your organization is on the free plan. Staff accounts require a Pro subscription. Please contact your organization administrator.',
          code: 'TIER_STAFF_NOT_ALLOWED'
        }, 403);
      }
    }

    const tokens = await authService.login(validated.email, validated.password, validated.source);

    // Fetch organization data
    const orgRows = await query<{ id: string; name: string; settings: any; currency: string | null }>(
      'SELECT id, name, settings, currency FROM organizations WHERE id = $1',
      [user.organization_id]
    );
    const org = orgRows[0];

    // Fetch subscription tier for the organization
    // Include all statuses to get the most recent subscription, then check if it's still valid
    const loginSubscriptionResult = await query<{ tier: string; status: string; current_period_end: Date | null }>(
      `SELECT tier, status, current_period_end FROM subscriptions
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [user.organization_id]
    );

    let subscription = { tier: 'starter', status: 'none' };
    if (loginSubscriptionResult.length > 0) {
      const sub = loginSubscriptionResult[0];
      const isActive = sub.status === 'active' || sub.status === 'trialing';
      // Also check if canceled but still within billing period
      const isCanceledButValid = sub.status === 'canceled' &&
        sub.current_period_end &&
        new Date(sub.current_period_end) > new Date();

      if (isActive || isCanceledButValid) {
        subscription = { tier: sub.tier, status: sub.status };
      }
    }

    // If no local subscription found, check Stripe directly as fallback
    if (subscription.tier === 'starter' && subscription.status === 'none' && user.stripe_customer_id) {
      try {
        const stripeSubscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: 'all',
          limit: 1,
        });

        if (stripeSubscriptions.data.length > 0) {
          const stripeSub = stripeSubscriptions.data[0] as any;
          const isActive = stripeSub.status === 'active' || stripeSub.status === 'trialing';
          const periodEnd = stripeSub.current_period_end as number | undefined;
          const periodStart = stripeSub.current_period_start as number | undefined;
          const isCanceledButValid = stripeSub.status === 'canceled' &&
            periodEnd &&
            periodEnd > Math.floor(Date.now() / 1000);

          if (isActive || isCanceledButValid) {
            const priceId = stripeSub.items?.data?.[0]?.price?.id;
            const tier = priceId === config.stripe.proPriceId ? 'pro' :
                        priceId === config.stripe.enterprisePriceId ? 'enterprise' : 'pro';
            subscription = { tier, status: stripeSub.status };

            logger.info('Subscription found in Stripe but not in local DB, syncing...', {
              userId: user.id,
              stripeSubscriptionId: stripeSub.id,
              tier,
              status: stripeSub.status,
            });

            // Sync to local DB (fire and forget)
            query(
              `INSERT INTO subscriptions (user_id, organization_id, stripe_subscription_id, stripe_customer_id, tier, status, current_period_start, current_period_end, platform)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'stripe')
               ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                 tier = EXCLUDED.tier,
                 status = EXCLUDED.status,
                 current_period_start = EXCLUDED.current_period_start,
                 current_period_end = EXCLUDED.current_period_end,
                 updated_at = NOW()`,
              [
                user.id,
                user.organization_id,
                stripeSub.id,
                user.stripe_customer_id,
                tier,
                stripeSub.status,
                periodStart ? new Date(periodStart * 1000) : null,
                periodEnd ? new Date(periodEnd * 1000) : null,
              ]
            ).catch(err => logger.error('Failed to sync subscription to local DB', { error: err }));
          }
        }
      } catch (stripeError) {
        logger.warn('Failed to check Stripe for subscription on login', { error: stripeError });
      }
    }

    // Register device if deviceId provided (mobile app logins)
    if (validated.deviceId && validated.source === 'app') {
      try {
        await deviceService.registerDeviceOnLogin(
          user.organization_id,
          user.id,
          {
            deviceId: validated.deviceId,
            name: validated.deviceInfo?.name,
            model: validated.deviceInfo?.model,
            os: validated.deviceInfo?.os,
            osVersion: validated.deviceInfo?.osVersion,
            appVersion: validated.deviceInfo?.appVersion,
          }
        );
      } catch (deviceError) {
        // Log but don't fail login if device registration fails
        logger.error('Failed to register device on login', {
          error: deviceError,
          deviceId: validated.deviceId,
          userId: user.id,
        });
      }
    }

    logger.info('User logged in', { userId: user.id, email: user.email, sessionVersion: tokens.sessionVersion, isStaff: !!user.invited_by, tier: subscription.tier, deviceId: validated.deviceId });

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name || undefined,
        lastName: user.last_name || undefined,
        phone: user.phone || undefined,
        organizationId: user.organization_id,
        role: user.role,
        emailAlerts: user.email_alerts,
        marketingEmails: user.marketing_emails,
        weeklyReports: user.weekly_reports,
        avatarUrl: imageService.getUrl(user.avatar_image_id),
        onboardingCompleted: user.onboarding_completed ?? false,
        currency: org?.currency || 'usd',
      },
      organization: org ? {
        id: org.id,
        name: org.name,
      } : null,
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
      sessionVersion: tokens.sessionVersion, // For single session enforcement
      subscription, // Include subscription info so frontend has it immediately
    });
  } catch (error: any) {
    logger.error('Login error', { error, email: validated.email });

    if (error.message === 'Invalid credentials') {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    return c.json({ error: 'Login failed' }, 500);
  }
});

const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string(),
  username: z.string().optional(), // Optional username for SECRET_HASH
});

const EmailCheckRequestSchema = z.object({
  email: z.string().email(),
});

const EmailCheckResponseSchema = z.object({
  inUse: z.boolean(),
});

const checkEmailRoute = createRoute({
  method: 'post',
  path: '/auth/check-email',
  summary: 'Check if email is already in use',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: EmailCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Email check result',
      content: {
        'application/json': {
          schema: EmailCheckResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(checkEmailRoute, async (c) => {
  const body = await c.req.json();
  const validated = EmailCheckRequestSchema.parse(body);

  try {
    const inUse = await authService.isEmailInUse(validated.email);
    
    return c.json({ inUse }, 200);
  } catch (error) {
    logger.error('Email check error', error);
    return c.json({ error: 'Email check failed' }, 500);
  }
});

const PasswordCheckRequestSchema = z.object({
  password: z.string(),
});

const PasswordCheckResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});

const checkPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/check-password',
  summary: 'Check if password meets policy requirements',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: PasswordCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password validation result',
      content: {
        'application/json': {
          schema: PasswordCheckResponseSchema,
        },
      },
    },
  },
});

app.openapi(checkPasswordRoute, async (c) => {
  const body = await c.req.json();
  const validated = PasswordCheckRequestSchema.parse(body);
  const { password } = validated;

  const errors: string[] = [];

  // Check minimum length
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  // Check for number
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least 1 number');
  }

  // Check for special character
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    errors.push('Password must contain at least 1 special character');
  }

  // Check for lowercase letter
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least 1 lowercase letter');
  }

  // Check for uppercase letter
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least 1 uppercase letter');
  }

  return c.json({ valid: errors.length === 0, errors }, 200);
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/auth/refresh',
  summary: 'Refresh access token',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Tokens refreshed',
      content: {
        'application/json': {
          schema: z.object({
            accessToken: z.string(),
            refreshToken: z.string(),
            expiresIn: z.number(),
          }),
        },
      },
    },
    401: {
      description: 'Invalid refresh token',
    },
  },
});

app.openapi(refreshRoute, async (c) => {
  const body = await c.req.json();
  const validated = RefreshTokenRequestSchema.parse(body);

  logger.info('Token refresh request received', {
    hasRefreshToken: !!validated.refreshToken,
    hasUsername: !!validated.username,
    username: validated.username,
    refreshTokenPreview: validated.refreshToken?.substring(0, 50) + '...'
  });

  try {
    const tokens = await authService.refreshTokens(validated.refreshToken, validated.username);
    
    logger.info('Token refresh successful', {
      hasAccessToken: !!tokens.accessToken,
      hasRefreshToken: !!tokens.refreshToken,
      expiresIn: tokens.expiresIn
    });
    
    return c.json(tokens);
  } catch (error: any) {
    logger.error('Token refresh error', { 
      error: error.message || error,
      stack: error.stack,
      name: error.name
    });
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  summary: 'Logout from account',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Logged out successfully',
    },
  },
});

app.openapi(logoutRoute, async (c) => {
  const body = await c.req.json();
  const validated = RefreshTokenRequestSchema.parse(body);

  try {
    await authService.logout(validated.refreshToken);
    return c.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', error);
    return c.json({ message: 'Logged out successfully' }); // Always return success
  }
});

const ChangePasswordRequestSchema = z.object({
  newPassword: z.string().min(8).regex(
    /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])(?=.*[a-z])(?=.*[A-Z]).+$/,
    'Password must contain at least 1 number, 1 special character, 1 uppercase letter, and 1 lowercase letter'
  ),
});

const changePasswordRoute = createRoute({
  method: 'post',
  path: '/auth/change-password',
  summary: 'Change password',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ChangePasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password changed successfully',
    },
    400: {
      description: 'Invalid current password',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

// Get current user endpoint
const getCurrentUserRoute = createRoute({
  method: 'get',
  path: '/auth/me',
  summary: 'Get current user information',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Current user information',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            email: z.string(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            phone: z.string().optional(),
            organizationId: z.string(),
            role: z.string(),
            emailAlerts: z.boolean(),
            marketingEmails: z.boolean(),
            weeklyReports: z.boolean(),
            avatarUrl: z.string().nullable(),
            onboardingCompleted: z.boolean(),
            createdAt: z.string(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(getCurrentUserRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);

    const dbUser = await authService.getUserById(payload.userId);

    if (!dbUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Fetch subscription tier for the organization
    // Include all statuses to get the most recent subscription, then check if it's still valid
    const subscriptionResult = await query<{ tier: string; status: string; current_period_end: Date | null }>(
      `SELECT tier, status, current_period_end FROM subscriptions
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [dbUser.organization_id]
    );

    let subscription = { tier: 'starter', status: 'none' };
    if (subscriptionResult.length > 0) {
      const sub = subscriptionResult[0];
      const isActive = sub.status === 'active' || sub.status === 'trialing';
      // Also check if canceled but still within billing period
      const isCanceledButValid = sub.status === 'canceled' &&
        sub.current_period_end &&
        new Date(sub.current_period_end) > new Date();

      if (isActive || isCanceledButValid) {
        subscription = { tier: sub.tier, status: sub.status };
      }
    }

    // If no local subscription found, check Stripe directly as fallback
    // This handles cases where webhook failed to create local record
    if (subscription.tier === 'starter' && subscription.status === 'none' && dbUser.stripe_customer_id) {
      try {
        const stripeSubscriptions = await stripe.subscriptions.list({
          customer: dbUser.stripe_customer_id,
          status: 'all',
          limit: 1,
        });

        if (stripeSubscriptions.data.length > 0) {
          const stripeSub = stripeSubscriptions.data[0] as any;
          const isActive = stripeSub.status === 'active' || stripeSub.status === 'trialing';
          const periodEnd = stripeSub.current_period_end as number | undefined;
          const periodStart = stripeSub.current_period_start as number | undefined;
          const isCanceledButValid = stripeSub.status === 'canceled' &&
            periodEnd &&
            periodEnd > Math.floor(Date.now() / 1000);

          if (isActive || isCanceledButValid) {
            // Determine tier from price ID
            const priceId = stripeSub.items?.data?.[0]?.price?.id;
            const tier = priceId === config.stripe.proPriceId ? 'pro' :
                        priceId === config.stripe.enterprisePriceId ? 'enterprise' : 'pro';
            subscription = { tier, status: stripeSub.status };

            logger.info('Subscription found in Stripe but not in local DB, syncing...', {
              userId: dbUser.id,
              stripeSubscriptionId: stripeSub.id,
              tier,
              status: stripeSub.status,
            });

            // Sync to local DB for future queries (fire and forget)
            query(
              `INSERT INTO subscriptions (user_id, organization_id, stripe_subscription_id, stripe_customer_id, tier, status, current_period_start, current_period_end, platform)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'stripe')
               ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                 tier = EXCLUDED.tier,
                 status = EXCLUDED.status,
                 current_period_start = EXCLUDED.current_period_start,
                 current_period_end = EXCLUDED.current_period_end,
                 updated_at = NOW()`,
              [
                dbUser.id,
                dbUser.organization_id,
                stripeSub.id,
                dbUser.stripe_customer_id,
                tier,
                stripeSub.status,
                periodStart ? new Date(periodStart * 1000) : null,
                periodEnd ? new Date(periodEnd * 1000) : null,
              ]
            ).catch(err => logger.error('Failed to sync subscription to local DB', { error: err }));
          }
        }
      } catch (stripeError) {
        logger.warn('Failed to check Stripe for subscription', { error: stripeError });
      }
    }

    logger.debug('Current user fetched', { userId: payload.userId, tier: subscription.tier });

    return c.json({
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.first_name || undefined,
      lastName: dbUser.last_name || undefined,
      phone: dbUser.phone || undefined,
      organizationId: dbUser.organization_id,
      role: dbUser.role,
      emailAlerts: dbUser.email_alerts,
      marketingEmails: dbUser.marketing_emails,
      weeklyReports: dbUser.weekly_reports,
      avatarUrl: imageService.getUrl(dbUser.avatar_image_id),
      onboardingCompleted: dbUser.onboarding_completed ?? false,
      // Handle both Date object (from DB) and string (from cache)
      createdAt: typeof dbUser.created_at === 'string'
        ? dbUser.created_at
        : dbUser.created_at.toISOString(),
      // Include subscription info so frontend has it immediately
      subscription,
      ...await (async () => {
        const orgResult = await query<{ tap_to_pay_device_ids: string[] | null; currency: string }>(
          'SELECT tap_to_pay_device_ids, currency FROM organizations WHERE id = $1',
          [dbUser.organization_id]
        );
        const currency = orgResult[0]?.currency || 'usd';
        return {
          tapToPayDeviceIds: orgResult.length > 0 && Array.isArray(orgResult[0].tap_to_pay_device_ids)
            ? orgResult[0].tap_to_pay_device_ids
            : [],
          currency,
          rates: getComputedRates(currency),
        };
      })(),
    });
  } catch (error: any) {
    logger.error('Get current user error', {
      errorMessage: error?.message,
      errorName: error?.name,
      errorCode: error?.code,
      tokenPreview: token?.substring(0, 50) + '...',
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }
});

app.openapi(changePasswordRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    
    const body = await c.req.json();
    const validated = ChangePasswordRequestSchema.parse(body);

    // Since user is authenticated, directly set the new password
    await authService.setNewPassword(
      payload.userId,
      validated.newPassword
    );

    logger.info('Password changed', { userId: payload.userId });

    return c.json({ message: 'Password changed successfully' });
  } catch (error: any) {
    logger.error('Password change error', { error });
    
    if (error.issues) {
      return c.json({ error: 'Invalid password format', details: error.issues }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to change password' }, 500);
  }
});

// Update user profile endpoint
const UpdateProfileRequestSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().regex(/^\d{10}$/, 'Phone must be 10 digits').nullable().optional(),
});

const updateProfileRoute = createRoute({
  method: 'patch',
  path: '/auth/profile',
  summary: 'Update user profile',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpdateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile updated successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            email: z.string(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            phone: z.string().optional(),
            organizationId: z.string(),
            role: z.string(),
            emailAlerts: z.boolean(),
            marketingEmails: z.boolean(),
            weeklyReports: z.boolean(),
            avatarUrl: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid request data',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(updateProfileRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const body = await c.req.json();
    const validated = UpdateProfileRequestSchema.parse(body);

    // Update user in database
    const updates: Record<string, any> = {};
    const params: any[] = [];
    let paramIndex = 1;

    if (validated.firstName !== undefined) {
      updates.first_name = `$${paramIndex++}`;
      params.push(validated.firstName);
    }

    if (validated.lastName !== undefined) {
      updates.last_name = `$${paramIndex++}`;
      params.push(validated.lastName);
    }

    if (validated.phone !== undefined) {
      updates.phone = `$${paramIndex++}`;
      params.push(validated.phone);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    // Add updated_at
    updates.updated_at = 'NOW()';

    // Build UPDATE query
    const setClause = Object.entries(updates)
      .map(([field, placeholder]) => `${field} = ${placeholder}`)
      .join(', ');

    params.push(payload.userId);

    const result = await query<any>(
      `UPDATE users SET ${setClause} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (!result[0]) {
      return c.json({ error: 'User not found' }, 404);
    }

    const updatedUser = result[0];

    // Update Cognito attributes if configured
    if (config.aws.cognito.userPoolId) {
      const cognitoAttributes: Record<string, string> = {};
      
      if (validated.firstName !== undefined) {
        cognitoAttributes.given_name = validated.firstName;
      }
      
      if (validated.lastName !== undefined) {
        cognitoAttributes.family_name = validated.lastName;
      }
      
      if (validated.phone !== undefined && validated.phone !== null) {
        cognitoAttributes.phone_number = `+1${validated.phone}`;
      }

      if (Object.keys(cognitoAttributes).length > 0) {
        await cognitoService.updateUserAttributes(updatedUser.email, cognitoAttributes);
      }
    }

    // Invalidate user cache to ensure fresh data on next request
    await cacheService.del(CacheKeys.user(payload.userId));
    await cacheService.del(CacheKeys.userByEmail(updatedUser.email));

    logger.info('User profile updated', {
      userId: payload.userId,
      updatedFields: Object.keys(validated)
    });

    return c.json({
      id: updatedUser.id,
      email: updatedUser.email,
      firstName: updatedUser.first_name || undefined,
      lastName: updatedUser.last_name || undefined,
      phone: updatedUser.phone || undefined,
      organizationId: updatedUser.organization_id,
      role: updatedUser.role,
      emailAlerts: updatedUser.email_alerts,
      marketingEmails: updatedUser.marketing_emails,
      weeklyReports: updatedUser.weekly_reports,
      avatarUrl: imageService.getUrl(updatedUser.avatar_image_id),
    });
  } catch (error: any) {
    logger.error('Update profile error', { error });
    
    if (error.issues) {
      return c.json({ error: 'Invalid request data', details: error.issues }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// Forgot password endpoint
const ForgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/forgot-password',
  summary: 'Request password reset',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ForgotPasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset email sent if email exists',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid request',
    },
  },
});

app.openapi(forgotPasswordRoute, async (c) => {
  const body = await c.req.json();
  const validated = ForgotPasswordRequestSchema.parse(body);

  try {
    // Create password reset token (returns null if user doesn't exist).
    // This is the raw secret — never log it.
    const resetToken = await authService.createPasswordResetToken(validated.email);

    logger.info('Password reset token creation result', {
      email: validated.email,
      tokenCreated: !!resetToken,
    });

    if (resetToken) {
      // Send password reset email
      await sendPasswordResetEmail(validated.email, resetToken);
    }
    
    // Always return success to prevent email enumeration
    logger.info('Password reset requested', {
      email: validated.email,
      tokenCreated: !!resetToken
    });
    
    return c.json({ 
      message: 'If an account exists with this email, a password reset link has been sent.' 
    });
  } catch (error) {
    logger.error('Forgot password error', { error, email: validated.email });
    
    // Still return success even on error to prevent enumeration
    return c.json({ 
      message: 'If an account exists with this email, a password reset link has been sent.' 
    });
  }
});

// Reset password endpoint
const ResetPasswordRequestSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid token'),
  password: z.string().min(8).regex(
    /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])(?=.*[a-z])(?=.*[A-Z]).+$/,
    'Password must contain at least 1 number, 1 special character, 1 uppercase letter, and 1 lowercase letter'
  ),
});

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/reset-password',
  summary: 'Reset password using token',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ResetPasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset successful',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid or expired token',
    },
  },
});

app.openapi(resetPasswordRoute, async (c) => {
  const body = await c.req.json();
  const validated = ResetPasswordRequestSchema.parse(body);

  try {
    const success = await authService.resetPassword(validated.token, validated.password);
    
    if (!success) {
      return c.json({ 
        error: 'Invalid or expired reset token' 
      }, 400);
    }
    
    logger.info('Password reset completed');

    return c.json({
      message: 'Password has been reset successfully'
    });
  } catch (error: any) {
    logger.error('Reset password error', { error });
    
    if (error.issues) {
      return c.json({ 
        error: 'Invalid password format', 
        details: error.issues 
      }, 400);
    }
    
    return c.json({ 
      error: 'Failed to reset password' 
    }, 500);
  }
});

// Validate reset token endpoint (optional - for frontend to check if token is valid)
const ValidateResetTokenRequestSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid token'),
});

const validateResetTokenRoute = createRoute({
  method: 'post',
  path: '/auth/validate-reset-token',
  summary: 'Check if password reset token is valid',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ValidateResetTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Token is valid',
      content: {
        'application/json': {
          schema: z.object({
            valid: z.boolean(),
            email: z.string().optional(),
          }),
        },
      },
    },
  },
});

app.openapi(validateResetTokenRoute, async (c) => {
  const body = await c.req.json();
  const validated = ValidateResetTokenRequestSchema.parse(body);

  try {
    const user = await authService.validatePasswordResetToken(validated.token);

    return c.json({
      valid: !!user,
      email: user?.email
    });
  } catch (error) {
    logger.error('Validate reset token error', { error });

    return c.json({
      valid: false
    });
  }
});

// Staff invite validation endpoint
const ValidateInviteTokenSchema = z.object({
  token: z.string(),
});

const validateInviteRoute = createRoute({
  method: 'get',
  path: '/auth/validate-invite',
  summary: 'Validate staff invite token',
  tags: ['Authentication'],
  request: {
    query: ValidateInviteTokenSchema,
  },
  responses: {
    200: {
      description: 'Invite validation result',
      content: {
        'application/json': {
          schema: z.object({
            valid: z.boolean(),
            email: z.string().optional(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            organizationName: z.string().optional(),
            inviterName: z.string().optional(),
          }),
        },
      },
    },
  },
});

app.openapi(validateInviteRoute, async (c) => {
  const { token } = c.req.query();

  try {
    const result = await staffService.validateInviteToken(token);

    if (!result.valid || !result.user) {
      return c.json({ valid: false });
    }

    return c.json({
      valid: true,
      email: result.user.email,
      firstName: result.user.first_name || undefined,
      lastName: result.user.last_name || undefined,
      organizationName: result.organizationName,
      inviterName: result.inviterName,
    });
  } catch (error) {
    logger.error('Validate invite token error', { error, token });
    return c.json({ valid: false });
  }
});

// Accept staff invite endpoint
const AcceptInviteRequestSchema = z.object({
  token: z.string(),
  password: z.string().min(8).regex(
    /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])(?=.*[a-z])(?=.*[A-Z]).+$/,
    'Password must contain at least 1 number, 1 special character, 1 uppercase letter, and 1 lowercase letter'
  ),
});

const acceptInviteRoute = createRoute({
  method: 'post',
  path: '/auth/accept-invite',
  summary: 'Accept staff invite and set password',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: AcceptInviteRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Invite accepted, user can now login',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
            email: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid or expired token',
    },
  },
});

app.openapi(acceptInviteRoute, async (c) => {
  const body = await c.req.json();
  const validated = AcceptInviteRequestSchema.parse(body);

  try {
    const user = await staffService.acceptInvite(validated.token, validated.password);

    logger.info('Staff invite accepted', { userId: user.id, email: user.email });

    return c.json({
      message: 'Your account has been set up successfully. You can now log in with the Luma app.',
      email: user.email,
    });
  } catch (error: any) {
    logger.error('Accept invite error', { error, token: validated.token });

    if (error.issues) {
      return c.json({ error: 'Invalid password format', details: error.issues }, 400);
    }

    if (error.message === 'Invalid or expired invite token') {
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to accept invite' }, 500);
  }
});

// Notification preferences endpoint
const NotificationPreferencesSchema = z.object({
  emailAlerts: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  weeklyReports: z.boolean().optional(),
});

const updateNotificationPreferencesRoute = createRoute({
  method: 'patch',
  path: '/auth/notification-preferences',
  summary: 'Update notification preferences',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: NotificationPreferencesSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Notification preferences updated',
      content: {
        'application/json': {
          schema: z.object({
            emailAlerts: z.boolean(),
            marketingEmails: z.boolean(),
            weeklyReports: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid request data',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(updateNotificationPreferencesRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const body = await c.req.json();
    const validated = NotificationPreferencesSchema.parse(body);

    // Build update query
    const updates: Record<string, any> = {};
    const params: any[] = [];
    let paramIndex = 1;

    if (validated.emailAlerts !== undefined) {
      updates.email_alerts = `$${paramIndex++}`;
      params.push(validated.emailAlerts);
    }

    if (validated.marketingEmails !== undefined) {
      updates.marketing_emails = `$${paramIndex++}`;
      params.push(validated.marketingEmails);
    }

    if (validated.weeklyReports !== undefined) {
      updates.weekly_reports = `$${paramIndex++}`;
      params.push(validated.weeklyReports);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No preferences to update' }, 400);
    }

    // Add updated_at
    updates.updated_at = 'NOW()';

    // Build UPDATE query
    const setClause = Object.entries(updates)
      .map(([field, placeholder]) => `${field} = ${placeholder}`)
      .join(', ');

    params.push(payload.userId);

    const result = await query<any>(
      `UPDATE users SET ${setClause} WHERE id = $${paramIndex} 
       RETURNING email_alerts, marketing_emails, weekly_reports`,
      params
    );

    if (!result[0]) {
      return c.json({ error: 'User not found' }, 404);
    }

    const prefs = result[0];

    // Invalidate user cache to ensure fresh data on next request
    await cacheService.del(CacheKeys.user(payload.userId));
    
    // Also get user email to invalidate email-based cache
    const user = await authService.getUserById(payload.userId);
    if (user) {
      await cacheService.del(CacheKeys.userByEmail(user.email));
    }

    logger.info('Notification preferences updated', {
      userId: payload.userId,
      preferences: validated
    });

    return c.json({
      emailAlerts: prefs.email_alerts,
      marketingEmails: prefs.marketing_emails,
      weeklyReports: prefs.weekly_reports,
    });
  } catch (error: any) {
    logger.error('Update notification preferences error', { error });
    
    if (error.issues) {
      return c.json({ error: 'Invalid request data', details: error.issues }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to update notification preferences' }, 500);
  }
});

// Complete onboarding endpoint
const completeOnboardingRoute = createRoute({
  method: 'post',
  path: '/auth/complete-onboarding',
  summary: 'Mark onboarding as complete',
  description: 'Marks the user onboarding (e.g., Tap to Pay setup) as complete so it is not shown again',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Onboarding marked as complete',
      content: {
        'application/json': {
          schema: z.object({
            onboardingCompleted: z.boolean(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
    500: {
      description: 'Internal server error',
    },
  },
});

app.openapi(completeOnboardingRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);

    // Update the user's onboarding_completed flag
    await query(
      `UPDATE users SET onboarding_completed = TRUE, updated_at = NOW() WHERE id = $1`,
      [payload.userId]
    );

    // Invalidate user cache
    await cacheService.del(CacheKeys.user(payload.userId));
    const user = await authService.getUserById(payload.userId);
    if (user) {
      await cacheService.del(CacheKeys.userByEmail(user.email));
    }

    logger.info('Onboarding completed', { userId: payload.userId });

    return c.json({ onboardingCompleted: true });
  } catch (error: any) {
    logger.error('Complete onboarding error', { error });

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to complete onboarding' }, 500);
  }
});

// Upload profile picture endpoint
const uploadAvatarRoute = createRoute({
  method: 'post',
  path: '/auth/avatar',
  summary: 'Upload or replace profile picture',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any().openapi({ type: 'string', format: 'binary' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile picture uploaded successfully',
      content: {
        'application/json': {
          schema: z.object({
            avatarUrl: z.string(),
            avatarImageId: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid file or file too large',
    },
    401: {
      description: 'Unauthorized',
    },
    503: {
      description: 'Image service not configured',
    },
  },
});

app.openapi(uploadAvatarRoute, async (c) => {
  logger.info('Avatar upload request received', {
    method: c.req.method,
    path: c.req.path,
    contentType: c.req.header('Content-Type'),
    contentLength: c.req.header('Content-Length'),
  });

  // Check if image service is configured
  if (!imageService.isConfigured()) {
    logger.warn('Avatar upload attempted but image service not configured');
    return c.json({ error: 'Image upload service not available' }, 503);
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Avatar upload: missing or invalid auth header');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    logger.info('Avatar upload: verifying token...');
    const payload = await authService.verifyToken(token);
    logger.info('Avatar upload: token verified', { userId: payload.userId });

    // Get the uploaded file from multipart form data
    logger.info('Avatar upload: parsing form data...');
    const formData = await c.req.formData();
    const file = formData.get('file');
    // Check if file is a File-like object (has arrayBuffer method and type property)
    // Note: We use duck typing instead of instanceof File because File is not available in Node.js
    const isFileLike = file && typeof file === 'object' && 'arrayBuffer' in file && 'type' in file;
    logger.info('Avatar upload: form data parsed', { hasFile: !!file, isFileLike, fileType: typeof file });

    if (!isFileLike) {
      return c.json({ error: 'No file provided' }, 400);
    }

    // Type assertion - we've verified it has the required properties
    const uploadedFile = file as Blob;

    // Validate content type
    const contentType = uploadedFile.type;
    if (!imageService.allowedTypes.includes(contentType)) {
      return c.json({
        error: `Invalid file type: ${contentType}. Allowed types: ${imageService.allowedTypes.join(', ')}`
      }, 400);
    }

    // Get file buffer
    const buffer = await uploadedFile.arrayBuffer();

    // Validate file size
    if (buffer.byteLength > imageService.maxSizeBytes) {
      const maxMB = Math.round(imageService.maxSizeBytes / 1024 / 1024);
      return c.json({
        error: `File too large. Maximum size: ${maxMB}MB`
      }, 400);
    }

    // Get current user to check for existing avatar
    const currentUser = await authService.getUserById(payload.userId);
    if (!currentUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Delete old avatar if it exists
    const existingAvatarId = currentUser.avatar_image_id;
    if (existingAvatarId) {
      try {
        await imageService.delete(existingAvatarId);
      } catch {
        logger.warn('Failed to delete old avatar', { userId: payload.userId, existingAvatarId });
      }
    }

    logger.info('Avatar upload: starting image upload', {
      userId: payload.userId,
      existingAvatarId,
      contentType,
      bufferSize: buffer.byteLength,
    });

    // Upload as a new image (new ID = new URL, avoids browser cache)
    const uploadResult = await imageService.upload(buffer, contentType, {
      imageType: 'avatar',
    });
    logger.info('Avatar upload: image uploaded successfully', { uploadResult });

    // Update user's avatar_image_id in database
    await query(
      `UPDATE users SET avatar_image_id = $1, updated_at = NOW() WHERE id = $2`,
      [uploadResult.id, payload.userId]
    );

    // Invalidate user cache
    await cacheService.del(CacheKeys.user(payload.userId));
    await cacheService.del(CacheKeys.userByEmail(currentUser.email));

    logger.info('Profile picture uploaded', {
      userId: payload.userId,
      avatarImageId: uploadResult.id,
      sizeBytes: uploadResult.sizeBytes,
      wasReplacement: !!existingAvatarId,
    });

    return c.json({
      avatarUrl: uploadResult.url,
      avatarImageId: uploadResult.id,
    });
  } catch (error: any) {
    logger.error('Upload avatar error', {
      error,
      errorMessage: error?.message,
      errorStack: error?.stack,
      errorCode: error?.code,
    });

    if (error.code === 'INVALID_TYPE') {
      return c.json({ error: error.message }, 400);
    }

    if (error.code === 'FILE_TOO_LARGE') {
      return c.json({ error: error.message }, 400);
    }

    if (error.code === 'STORAGE_ERROR') {
      return c.json({ error: 'Failed to save image' }, 500);
    }

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to upload profile picture' }, 500);
  }
});

// Delete profile picture endpoint
const deleteAvatarRoute = createRoute({
  method: 'delete',
  path: '/auth/avatar',
  summary: 'Delete profile picture',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Profile picture deleted successfully',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
    404: {
      description: 'No profile picture to delete',
    },
  },
});

app.openapi(deleteAvatarRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);

    // Get current user
    const currentUser = await authService.getUserById(payload.userId);
    if (!currentUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Check if user has an avatar
    if (!currentUser.avatar_image_id) {
      return c.json({ error: 'No profile picture to delete' }, 404);
    }

    // Delete the image file (if image service is configured)
    if (imageService.isConfigured()) {
      try {
        await imageService.delete(currentUser.avatar_image_id);
      } catch (error) {
        // Log but don't fail - the file might already be deleted
        logger.warn('Failed to delete avatar file', {
          avatarImageId: currentUser.avatar_image_id,
          error
        });
      }
    }

    // Update user's avatar_image_id to null in database
    await query(
      `UPDATE users SET avatar_image_id = NULL, updated_at = NOW() WHERE id = $1`,
      [payload.userId]
    );

    // Invalidate user cache
    await cacheService.del(CacheKeys.user(payload.userId));
    await cacheService.del(CacheKeys.userByEmail(currentUser.email));

    logger.info('Profile picture deleted', {
      userId: payload.userId,
      deletedAvatarId: currentUser.avatar_image_id,
    });

    return c.json({ message: 'Profile picture deleted successfully' });
  } catch (error: any) {
    logger.error('Delete avatar error', { error });

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to delete profile picture' }, 500);
  }
});

// Link IAP purchase to subscription endpoint
// This is called after IAP purchase succeeds to store the purchase token
// so that webhooks can find the subscription
const LinkIapPurchaseRequestSchema = z.object({
  platform: z.enum(['ios', 'android']),
  purchaseToken: z.string().min(1),
  transactionId: z.string().optional(),
  productId: z.string().optional(),
});

const linkIapPurchaseRoute = createRoute({
  method: 'post',
  path: '/auth/link-iap-purchase',
  summary: 'Link IAP purchase token to subscription',
  description: 'After an IAP purchase succeeds, call this endpoint to link the purchase token to the user subscription so webhooks can find it',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: LinkIapPurchaseRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Purchase linked successfully',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
            subscriptionId: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'No subscription found or invalid request',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(linkIapPurchaseRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const body = await c.req.json();
    const validated = LinkIapPurchaseRequestSchema.parse(body);

    logger.info('[LinkIapPurchase] Linking purchase token to subscription', {
      userId: payload.userId,
      platform: validated.platform,
      productId: validated.productId,
      purchaseTokenPreview: validated.purchaseToken.substring(0, 20) + '...',
    });

    // Get the user to find their organization
    const user = await authService.getUserById(payload.userId);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Find or create the subscription for this user/organization
    const existingSub = await query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.organization_id]
    );

    if (existingSub.length === 0) {
      logger.warn('[LinkIapPurchase] No subscription found', {
        userId: payload.userId,
        organizationId: user.organization_id,
      });
      return c.json({ error: 'No subscription found for this account' }, 400);
    }

    const subscriptionId = existingSub[0].id;

    // Update the subscription with the purchase token AND activate the Pro plan
    // Since we can't validate the receipt without Google Play API credentials,
    // we trust the purchase and set a default 30-day period (webhooks will update it)
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

    if (validated.platform === 'android') {
      await query(
        `UPDATE subscriptions
         SET google_purchase_token = $1,
             google_product_id = $2,
             platform = 'google',
             tier = 'pro',
             status = 'active',
             current_period_end = $3,
             monthly_price = 2999,
             transaction_fee_rate = 0.028,
             updated_at = NOW()
         WHERE id = $4`,
        [validated.purchaseToken, validated.productId || null, periodEnd, subscriptionId]
      );
    } else {
      // iOS
      await query(
        `UPDATE subscriptions
         SET apple_original_transaction_id = $1,
             apple_product_id = $2,
             platform = 'apple',
             tier = 'pro',
             status = 'active',
             current_period_end = $3,
             monthly_price = 2999,
             transaction_fee_rate = 0.028,
             updated_at = NOW()
         WHERE id = $4`,
        [validated.transactionId || validated.purchaseToken, validated.productId || null, periodEnd, subscriptionId]
      );
    }

    logger.info('[LinkIapPurchase] Purchase token linked successfully', {
      userId: payload.userId,
      subscriptionId,
      platform: validated.platform,
    });

    // Invalidate user cache since subscription data changed
    await cacheService.del(CacheKeys.user(user.id));
    await cacheService.del(CacheKeys.userByEmail(user.email));

    return c.json({
      message: 'Purchase linked successfully',
      subscriptionId,
    });
  } catch (error: any) {
    logger.error('[LinkIapPurchase] Error', { error: error.message, stack: error.stack });

    if (error.issues) {
      return c.json({ error: 'Invalid request data', details: error.issues }, 400);
    }

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to link purchase' }, 500);
  }
});

// Register Tap to Pay device endpoint
const TapToPayDeviceRequestSchema = z.object({
  deviceId: z.string().min(1),
});

const registerTapToPayDeviceRoute = createRoute({
  method: 'post',
  path: '/auth/tap-to-pay-device',
  summary: 'Register a device where Tap to Pay has been enabled',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: TapToPayDeviceRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Device registered',
      content: {
        'application/json': {
          schema: z.object({
            tapToPayDeviceIds: z.array(z.string()),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(registerTapToPayDeviceRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const body = await c.req.json();
    const validated = TapToPayDeviceRequestSchema.parse(body);

    // Get current user to find their organization
    const dbUser = await authService.getUserById(payload.userId);
    if (!dbUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Get organization's current device IDs
    const orgRows = await query<{ tap_to_pay_device_ids: string[] | null }>(
      'SELECT tap_to_pay_device_ids FROM organizations WHERE id = $1',
      [dbUser.organization_id]
    );

    if (orgRows.length === 0) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    // Append device ID if not already present
    const currentIds: string[] = Array.isArray(orgRows[0].tap_to_pay_device_ids)
      ? orgRows[0].tap_to_pay_device_ids
      : [];

    if (!currentIds.includes(validated.deviceId)) {
      currentIds.push(validated.deviceId);
    }

    // Update organization record
    await query(
      `UPDATE organizations SET tap_to_pay_device_ids = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(currentIds), dbUser.organization_id]
    );

    logger.info('Tap to Pay device registered', {
      userId: payload.userId,
      organizationId: dbUser.organization_id,
      deviceId: validated.deviceId,
      totalDevices: currentIds.length,
    });

    return c.json({ tapToPayDeviceIds: currentIds });
  } catch (error: any) {
    logger.error('Register Tap to Pay device error', { error });

    if (error.issues) {
      return c.json({ error: 'Invalid request data', details: error.issues }, 400);
    }

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to register device' }, 500);
  }
});

// Account deletion request endpoint
const requestAccountDeletionRoute = createRoute({
  method: 'post',
  path: '/auth/request-account-deletion',
  summary: 'Request account deletion (scheduled for 30 days)',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Account flagged for deletion',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            deletionDate: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    409: { description: 'Deletion already requested' },
    500: { description: 'Failed to process request' },
  },
});

app.openapi(requestAccountDeletionRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const dbUser = await authService.getUserById(payload.userId);

    if (!dbUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Check if deletion already requested
    if (dbUser.deletion_requested_at) {
      const deletionDate = new Date(dbUser.deletion_requested_at);
      deletionDate.setDate(deletionDate.getDate() + 30);
      return c.json({
        error: 'Account deletion already requested',
        deletionDate: deletionDate.toISOString(),
      }, 409);
    }

    const now = new Date();
    const deletionDate = new Date(now);
    deletionDate.setDate(deletionDate.getDate() + 30);

    // 1. Flag account for deletion and deactivate
    await query(
      `UPDATE users SET deletion_requested_at = $1, is_active = false, updated_at = NOW() WHERE id = $2`,
      [now.toISOString(), dbUser.id]
    );

    // 2. Increment session version to kick user out of all sessions
    await query(
      `UPDATE users SET session_version = session_version + 1 WHERE id = $1`,
      [dbUser.id]
    );

    // 3. Invalidate cache
    await cacheService.del(CacheKeys.user(dbUser.id));
    await cacheService.del(CacheKeys.userByEmail(dbUser.email));

    // 4. Send confirmation email to user
    const formattedDate = deletionDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    await sendTemplatedEmail(dbUser.email, {
      subject: 'Your Luma Account Deletion Request',
      preheader_text: `Your account is scheduled for deletion on ${formattedDate}`,
      email_title: 'Account Deletion Scheduled',
      email_content: `
        Hi ${dbUser.first_name || 'there'},<br><br>
        We've received your request to delete your Luma account. Your account has been deactivated and is scheduled for permanent deletion on <strong>${formattedDate}</strong>.<br><br>
        If you change your mind, you can contact us at <a href="mailto:support@lumapos.co">support@lumapos.co</a> before that date to cancel the deletion.<br><br>
        Once your account is deleted, all your data — including your profile, organization, payment history, and any associated content — will be permanently removed and cannot be recovered.
      `,
      security_notice: true,
    });

    // 5. Notify support team
    const supportEmail = process.env.SUPPORT_EMAIL || 'support@lumapos.co';
    const escapeHtml = (str: string) =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    await emailService.sendEmail({
      to: supportEmail,
      subject: `Account Deletion Scheduled — ${dbUser.email}`,
      html: `
        <h2>Account Deletion Scheduled</h2>
        <p>A user has requested account deletion. The account will be permanently deleted on <strong>${formattedDate}</strong>.</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">User ID:</td><td>${escapeHtml(dbUser.id)}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Email:</td><td>${escapeHtml(dbUser.email)}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Name:</td><td>${escapeHtml(dbUser.first_name || '')} ${escapeHtml(dbUser.last_name || '')}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Organization ID:</td><td>${escapeHtml(dbUser.organization_id || '')}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Deletion Date:</td><td>${formattedDate}</td></tr>
        </table>
        <p>To cancel this deletion, clear the <code>deletion_requested_at</code> field and set <code>is_active = true</code> before the deletion date.</p>
      `,
      replyTo: dbUser.email,
    });

    logger.info('Account deletion scheduled', {
      userId: dbUser.id,
      email: dbUser.email,
      organizationId: dbUser.organization_id,
      deletionDate: deletionDate.toISOString(),
    });

    return c.json({
      success: true,
      message: 'Account scheduled for deletion',
      deletionDate: deletionDate.toISOString(),
    });
  } catch (error: any) {
    logger.error('Account deletion request error', { error });

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to process deletion request' }, 500);
  }
});

export default app;