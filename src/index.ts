import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { testConnection, pool, query } from './db';
import { initializeDatabase } from './db/migrate';
import { logger as winstonLogger } from './utils/logger';
import { redisService } from './services/redis';
import { registerAllWorkers } from './services/queue/workers';
import { queueService } from './services/queue';
import { socketService } from './services/socket';
import { startScheduledCleanups, stopScheduledCleanups } from './services/scheduled/ticket-lock-cleanup';
import { startReferralPayouts, stopReferralPayouts } from './services/scheduled/referral-payouts';
import { startAccountDeletionJob, stopAccountDeletionJob } from './services/scheduled/account-deletion';
import authRoutes from './routes/auth';
import organizationRoutes from './routes/organizations';
import stripeWebhookRoutes from './routes/stripe/webhooks';
import stripeConnectWebhookRoutes from './routes/stripe/connect-webhooks';
import appleWebhookRoutes from './routes/apple-webhooks';
import googleWebhookRoutes from './routes/google-webhooks';
import stripeConnectRoutes from './routes/stripe/connect';
import stripeTerminalRoutes from './routes/stripe/terminal';
import contactRoutes from './routes/contact';
import marketingRoutes from './routes/marketing';
import { billingRoutes } from './routes/billing';
import catalogRoutes from './routes/catalogs';
import catalogProductRoutes from './routes/catalog-products';
import productRoutes from './routes/products';
import categoryRoutes from './routes/categories';
import imageRoutes from './routes/images';
import customerRoutes from './routes/customers';
import orderRoutes from './routes/orders';
import tipsRoutes from './routes/tips';
import staffRoutes from './routes/staff';
import splitsRoutes from './routes/splits';
import eventRoutes from './routes/events';
import menuRoutes from './routes/menu';
import preorderRoutes from './routes/preorders';
import invoiceRoutes from './routes/invoices';
import disputeRoutes from './routes/disputes';
import referralRoutes from './routes/referrals';
import adminErrorRoutes from './routes/admin/errors';

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      winstonLogger.error('[OpenAPI Validation Error]', {
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

// Register security scheme
app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT Authorization header using the Bearer scheme',
});

// Skip request logging for successful health checks — they spam the logs
app.use('*', async (c, next) => {
  if (c.req.path === '/health' || c.req.path === '/') {
    await next();
    if (c.res.status >= 400) {
      winstonLogger.error(`Health check failed with status ${c.res.status}`);
    }
    return;
  }
  return logger()(c, next);
});
app.use('*', requestId());
// Baseline security headers (HSTS, X-Content-Type-Options: nosniff,
// X-Frame-Options, Referrer-Policy, etc.). Safe for a JSON API — no CSP that
// could break the separate Next.js frontends, which serve their own headers.
app.use('*', secureHeaders());
// Debug CORS
const corsOrigins = config.cors.origin.split(',').map(origin => origin.trim());
winstonLogger.info('CORS Origins configured:', corsOrigins);

app.use('*', cors({
  origin: corsOrigins,
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Version'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use('*', prettyJSON());

app.get('/', (c) => {
  return c.json({
    name: 'Luma API',
    version: '1.0.0',
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (c) => {
  try {
    await query('SELECT 1');
    const redisOk = await redisService.get('health:ping').then(() => true).catch(() => false);

    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: 'ok',
        redis: redisOk ? 'ok' : 'degraded',
      },
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: 'down',
        redis: 'unknown',
      },
    }, 503);
  }
});

// Serve static files from public/ directory (wallet badges, etc.)
app.use('/public/*', serveStatic({ root: './' }));

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Luma API',
    version: '1.0.0',
    description: 'Backend API for Luma - Stripe-integrated POS system for mobile bars and events',
  },
  servers: [
    {
      url: config.api.url,
      description: 'API Server',
    },
  ],
});

app.get('/swagger', swaggerUI({ url: '/openapi.json' }));

// Mount routes
app.route('/', orderRoutes);
app.route('/', authRoutes);
app.route('/', organizationRoutes);
app.route('/', stripeWebhookRoutes);
app.route('/', stripeConnectWebhookRoutes);
app.route('/', appleWebhookRoutes);
app.route('/', googleWebhookRoutes);
app.route('/', stripeConnectRoutes);
app.route('/', stripeTerminalRoutes);
app.route('/contact', contactRoutes);
app.route('/marketing', marketingRoutes);
app.route('/', billingRoutes);
app.route('/', catalogRoutes);
app.route('/', catalogProductRoutes);
app.route('/', productRoutes);
app.route('/', categoryRoutes);
app.route('/', imageRoutes);
app.route('/', customerRoutes);
app.route('/', tipsRoutes);
app.route('/', staffRoutes);
app.route('/', splitsRoutes);
app.route('/', eventRoutes);
app.route('/', menuRoutes);
app.route('/', preorderRoutes);
app.route('/', invoiceRoutes);
app.route('/', disputeRoutes);
app.route('/', referralRoutes);
app.route('/admin/errors', adminErrorRoutes);

app.onError(errorHandler);

const port = config.server.port;

// Module-scoped so gracefulShutdown can close it and drain in-flight requests.
let server: ReturnType<typeof serve> | undefined;

async function startServer() {
  try {
    await testConnection();
    await initializeDatabase();
    await redisService.connect();
    registerAllWorkers();
    startScheduledCleanups();
    startReferralPayouts();
    startAccountDeletionJob();

    // Create HTTP server and initialize Socket.IO
    server = serve({
      fetch: app.fetch,
      port,
    });

    // Initialize Socket.IO with the HTTP server (async for Redis adapter setup)
    await socketService.initialize(server as any);

    winstonLogger.info(`Server is running on port ${port}`);
    winstonLogger.info(`Socket.IO initialized on path ${config.socketio.path}`);
  } catch (error) {
    winstonLogger.error('Failed to start server', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown — clean up connections on SIGTERM/SIGINT
async function gracefulShutdown(signal: string) {
  winstonLogger.info(`${signal} received, starting graceful shutdown...`);
  try {
    // Stop accepting new HTTP connections and let in-flight requests finish
    // before tearing down the DB pool / Redis (prevents dropped requests on
    // every rolling deploy).
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
        // Safety timeout so a hung keep-alive connection can't block shutdown
        // past the pod's terminationGracePeriod.
        setTimeout(resolve, 10000).unref();
      });
    }
    await socketService.close();
    stopScheduledCleanups();
    stopReferralPayouts();
    stopAccountDeletionJob();
    await queueService.closeAll();
    await redisService.disconnect();
    await pool.end();
    winstonLogger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    winstonLogger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  winstonLogger.error('Unhandled Promise Rejection', { reason, promise });
});