import { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';
import { config } from '../config';
import { logApiError } from '../services/error-logging';

// Stripe errors (and some AWS SDK errors) carry the full HTTP response — raw
// body, headers (request-ids) and an echo of submitted params (amounts,
// customer/payment-method ids, emails). Logging the whole object leaks that
// into our logs; keep only safe, useful fields.
function safeError(err: any) {
  const base = { name: err?.name, message: err?.message, stack: err?.stack };
  if (err?.type || err?.requestId || err?.statusCode || err?.code) {
    return { ...base, code: err.code, type: err.type, statusCode: err.statusCode, requestId: err.requestId };
  }
  return base;
}

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get('requestId');

  logger.error({
    message: err.message,
    error: safeError(err),
    requestId,
    path: c.req.path,
    method: c.req.method,
  });

  if (err instanceof ZodError) {
    return c.json({
      error: 'Validation Error',
      details: err.errors,
      requestId,
    }, 400);
  }

  if (err.message === 'Unauthorized') {
    return c.json({
      error: 'Unauthorized',
      message: 'Authentication required',
      requestId,
    }, 401);
  }

  if (err.message === 'Forbidden') {
    return c.json({
      error: 'Forbidden',
      message: 'You do not have permission to access this resource',
      requestId,
    }, 403);
  }

  if (err.message === 'Not Found') {
    return c.json({
      error: 'Not Found',
      message: 'The requested resource was not found',
      requestId,
    }, 404);
  }

  // Log 500 errors to database in production
  if (config.env === 'production') {
    // Get user info if available from context
    const user = c.get('user') as { id?: string; organizationId?: string } | undefined;

    // Log asynchronously - don't await to avoid slowing down error response
    logApiError({
      requestId,
      errorMessage: err.message,
      errorStack: err.stack,
      path: c.req.path,
      method: c.req.method,
      userId: user?.id,
      organizationId: user?.organizationId,
      statusCode: 500,
    }).catch(() => {
      // Already logged in logApiError, ignore here
    });
  }

  return c.json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    requestId,
  }, 500);
};