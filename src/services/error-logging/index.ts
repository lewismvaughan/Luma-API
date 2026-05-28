import { pool } from '../../db';
import { logger } from '../../utils/logger';

interface ErrorLogData {
  requestId?: string;
  errorMessage: string;
  errorStack?: string;
  path?: string;
  method?: string;
  userId?: string;
  organizationId?: string;
  requestBody?: Record<string, unknown>;
  requestHeaders?: Record<string, string>;
  statusCode?: number;
}

/**
 * Log an API error to the database for tracking/management
 * Only used in production for server-side errors (500s)
 */
export async function logApiError(data: ErrorLogData): Promise<void> {
  try {
    // Sanitize headers - remove sensitive data
    const sanitizedHeaders = data.requestHeaders ? { ...data.requestHeaders } : undefined;
    if (sanitizedHeaders) {
      delete sanitizedHeaders['authorization'];
      delete sanitizedHeaders['cookie'];
      delete sanitizedHeaders['x-api-key'];
    }

    // Sanitize body - remove sensitive fields
    const sanitizedBody = data.requestBody ? { ...data.requestBody } : undefined;
    if (sanitizedBody) {
      delete sanitizedBody['password'];
      delete sanitizedBody['password_hash'];
      delete sanitizedBody['token'];
      delete sanitizedBody['refreshToken'];
      delete sanitizedBody['accessToken'];
      delete sanitizedBody['credit_card'];
      delete sanitizedBody['cardNumber'];
    }

    await pool.query(
      `INSERT INTO api_errors (
        request_id,
        error_message,
        error_stack,
        path,
        method,
        user_id,
        organization_id,
        request_body,
        request_headers,
        status_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        data.requestId || null,
        data.errorMessage,
        data.errorStack || null,
        data.path || null,
        data.method || null,
        data.userId || null,
        data.organizationId || null,
        sanitizedBody ? JSON.stringify(sanitizedBody) : null,
        sanitizedHeaders ? JSON.stringify(sanitizedHeaders) : null,
        data.statusCode || 500,
      ]
    );
  } catch (err) {
    // Don't throw - we don't want error logging to break the error response
    logger.error('Failed to log API error to database', { error: err, originalError: data });
  }
}

/**
 * Get unresolved errors for the admin dashboard
 */
export async function getUnresolvedErrors(organizationId: string, limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT
      e.*,
      u.email as user_email,
      o.name as organization_name
    FROM api_errors e
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN organizations o ON e.organization_id = o.id
    WHERE e.resolved = false AND e.organization_id = $3
    ORDER BY e.created_at DESC
    LIMIT $1 OFFSET $2`,
    [limit, offset, organizationId]
  );
  return result.rows;
}

/**
 * Get all errors with pagination and filters
 */
export async function getErrors(options: {
  organizationId: string;
  limit?: number;
  offset?: number;
  resolved?: boolean;
  startDate?: Date;
  endDate?: Date;
}) {
  const { organizationId, limit = 50, offset = 0, resolved, startDate, endDate } = options;

  // Always scope to the caller's organization — these are org-level admins, not
  // a platform superadmin, so they must not see other tenants' error records.
  let whereClause = 'WHERE e.organization_id = $1';
  const params: (number | boolean | Date | string)[] = [organizationId];
  let paramIndex = 2;

  if (resolved !== undefined) {
    whereClause += ` AND e.resolved = $${paramIndex++}`;
    params.push(resolved);
  }

  if (startDate) {
    whereClause += ` AND e.created_at >= $${paramIndex++}`;
    params.push(startDate);
  }

  if (endDate) {
    whereClause += ` AND e.created_at <= $${paramIndex++}`;
    params.push(endDate);
  }

  params.push(limit, offset);

  const result = await pool.query(
    `SELECT
      e.*,
      u.email as user_email,
      o.name as organization_name,
      resolver.email as resolved_by_email
    FROM api_errors e
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN organizations o ON e.organization_id = o.id
    LEFT JOIN users resolver ON e.resolved_by = resolver.id
    ${whereClause}
    ORDER BY e.created_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM api_errors e ${whereClause}`,
    params.slice(0, -2) // Exclude limit and offset
  );

  return {
    errors: result.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Mark an error as resolved
 */
export async function resolveError(errorId: string, resolvedBy: string, organizationId: string, notes?: string) {
  await pool.query(
    `UPDATE api_errors
    SET resolved = true, resolved_at = NOW(), resolved_by = $2, notes = $3
    WHERE id = $1 AND organization_id = $4`,
    [errorId, resolvedBy, notes || null, organizationId]
  );
}

/**
 * Delete old resolved errors (cleanup job)
 */
export async function deleteOldResolvedErrors(organizationId: string | null, daysOld = 30) {
  // Pass null from the scheduled cleanup to GC every tenant's old resolved
  // errors at once; pass an organizationId from the admin route so a tenant
  // owner can only clean their own org's history.
  if (organizationId) {
    const result = await pool.query(
      `DELETE FROM api_errors
       WHERE resolved = true
       AND organization_id = $2
       AND created_at < NOW() - INTERVAL '1 day' * $1
       RETURNING id`,
      [daysOld, organizationId]
    );
    return result.rowCount;
  }
  const result = await pool.query(
    `DELETE FROM api_errors
     WHERE resolved = true
     AND created_at < NOW() - INTERVAL '1 day' * $1
     RETURNING id`,
    [daysOld]
  );
  return result.rowCount;
}
