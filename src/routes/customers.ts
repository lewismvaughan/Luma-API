import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Customer } from '../db/models';
import { logger } from '../utils/logger';

const app = new OpenAPIHono();

// Auth verification helper (same pattern as orders.ts)
async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }

  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  const payload = await authService.verifyToken(token);
  return payload;
}

// List customers for organization
const listCustomersRoute = createRoute({
  method: 'get',
  path: '/customers',
  summary: 'List customers for organization',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      search: z.string().optional(),
      limit: z.string().optional().default('50'),
      offset: z.string().optional().default('0'),
    }),
  },
  responses: {
    200: {
      description: 'List of customers',
      content: {
        'application/json': {
          schema: z.object({
            customers: z.array(z.object({
              id: z.string(),
              email: z.string(),
              name: z.string().nullable(),
              phone: z.string().nullable(),
              totalOrders: z.number(),
              totalSpent: z.number(),
              lastOrderAt: z.string().nullable(),
              createdAt: z.string(),
            })),
            total: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listCustomersRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const { search, limit, offset } = c.req.query();

    // Cap the page size so a caller can't request a million-row scan.
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '50', 10) || 50));
    const offsetNum = Math.max(0, parseInt(offset || '0', 10) || 0);

    let whereClause = 'WHERE organization_id = $1';
    const params: any[] = [payload.organizationId];
    let paramCount = 2;

    if (search) {
      whereClause += ` AND (email ILIKE $${paramCount} OR name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM customers ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0', 10);

    // Read the rollup columns directly. They're kept current on every
    // order/preorder/ticket/invoice insert by the upsert path + stats triggers,
    // so the previous UNION-ALL-and-LOWER() aggregation was redundant and was
    // the worst single query in the codebase. This now uses the
    // (organization_id, last_order_at DESC) index for O(limit) reads.
    params.push(limitNum, offsetNum);
    const customers = await query<Customer>(
      `SELECT id, email, name, phone, total_orders, total_spent, last_order_at, created_at
         FROM customers
         ${whereClause}
         ORDER BY last_order_at DESC NULLS LAST, created_at DESC
         LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      params
    );

    return c.json({
      customers: customers.map(customer => ({
        id: customer.id,
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        totalOrders: customer.total_orders || 0,
        totalSpent: parseFloat(String(customer.total_spent || 0)),
        lastOrderAt: customer.last_order_at
          ? new Date(customer.last_order_at).toISOString()
          : null,
        createdAt: customer.created_at.toISOString(),
      })),
      total,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing customers', { error });
    return c.json({ error: 'Failed to list customers' }, 500);
  }
});

// Create or update customer (upsert)
const upsertCustomerRoute = createRoute({
  method: 'post',
  path: '/customers',
  summary: 'Create or update a customer',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            name: z.string().optional(),
            phone: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Customer created or updated',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            email: z.string(),
            name: z.string().nullable(),
            phone: z.string().nullable(),
            totalOrders: z.number(),
            totalSpent: z.number(),
            lastOrderAt: z.string().nullable(),
            createdAt: z.string(),
            isNew: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(upsertCustomerRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const body = await c.req.json();

    // Check if customer exists
    const existing = await query<Customer>(
      'SELECT * FROM customers WHERE organization_id = $1 AND email = $2',
      [payload.organizationId, body.email.toLowerCase()]
    );

    let customer: Customer;
    let isNew = false;

    if (existing[0]) {
      // Update existing customer
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (body.name !== undefined) {
        updates.push(`name = $${paramCount}`);
        values.push(body.name);
        paramCount++;
      }

      if (body.phone !== undefined) {
        updates.push(`phone = $${paramCount}`);
        values.push(body.phone);
        paramCount++;
      }

      if (updates.length > 0) {
        values.push(existing[0].id);
        const result = await query<Customer>(
          `UPDATE customers SET ${updates.join(', ')}, updated_at = NOW()
           WHERE id = $${paramCount} RETURNING *`,
          values
        );
        customer = result[0];
      } else {
        customer = existing[0];
      }
    } else {
      // Create new customer
      const result = await query<Customer>(
        `INSERT INTO customers (organization_id, email, name, phone)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [payload.organizationId, body.email.toLowerCase(), body.name || null, body.phone || null]
      );
      customer = result[0];
      isNew = true;
    }

    logger.info('Customer upserted', {
      customerId: customer.id,
      organizationId: payload.organizationId,
      isNew,
    });

    return c.json({
      id: customer.id,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
      totalOrders: customer.total_orders,
      totalSpent: Number(customer.total_spent),
      lastOrderAt: customer.last_order_at?.toISOString() || null,
      createdAt: customer.created_at.toISOString(),
      isNew,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error upserting customer', { error });
    return c.json({ error: 'Failed to save customer' }, 500);
  }
});

// Search customers by email (for autocomplete)
const searchCustomersRoute = createRoute({
  method: 'get',
  path: '/customers/search',
  summary: 'Search customers by email',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1),
      limit: z.string().optional().default('10'),
    }),
  },
  responses: {
    200: {
      description: 'Matching customers',
      content: {
        'application/json': {
          schema: z.object({
            customers: z.array(z.object({
              id: z.string(),
              email: z.string(),
              name: z.string().nullable(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(searchCustomersRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const { q, limit } = c.req.query();

    const customers = await query<Customer>(
      `SELECT id, email, name FROM customers
       WHERE organization_id = $1 AND email ILIKE $2
       ORDER BY last_order_at DESC NULLS LAST
       LIMIT $3`,
      [payload.organizationId, `%${q}%`, parseInt(limit, 10)]
    );

    return c.json({
      customers: customers.map(customer => ({
        id: customer.id,
        email: customer.email,
        name: customer.name,
      })),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error searching customers', { error });
    return c.json({ error: 'Failed to search customers' }, 500);
  }
});

// Update customer order stats (called after payment)
const updateCustomerStatsRoute = createRoute({
  method: 'post',
  path: '/customers/{id}/record-order',
  summary: 'Record an order for a customer',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            orderTotal: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Customer stats updated',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(updateCustomerStatsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();
    const { orderTotal } = await c.req.json();

    await query(
      `UPDATE customers
       SET total_orders = total_orders + 1,
           total_spent = total_spent + $1,
           last_order_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND organization_id = $3`,
      [orderTotal, id, payload.organizationId]
    );

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating customer stats', { error });
    return c.json({ error: 'Failed to update customer stats' }, 500);
  }
});

export default app;
