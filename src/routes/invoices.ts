import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Invoice, InvoiceItem } from '../db/models';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';
import { queueService, QueueName } from '../services/queue';
import { stripe } from '../services/stripe';
import { calculatePlatformFee, SubscriptionTier } from '../config/platform-fees';
import { getImageUrl } from '../services/images';
import { toSmallestUnit, getOrgCurrency } from '../utils/currency';

const app = new OpenAPIHono();

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  return authService.verifyToken(token);
}

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

async function getNextInvoiceNumber(organizationId: string): Promise<string> {
  const result = await query<{ last_number: number; prefix: string }>(
    `INSERT INTO invoice_number_sequences (organization_id, last_number, prefix)
     VALUES ($1, 1, 'INV')
     ON CONFLICT (organization_id) DO UPDATE
     SET last_number = invoice_number_sequences.last_number + 1,
         updated_at = NOW()
     RETURNING last_number, prefix`,
    [organizationId]
  );
  const { last_number, prefix } = result[0];
  return `${prefix}-${last_number.toString().padStart(4, '0')}`;
}

async function getConnectedAccount(organizationId: string): Promise<string | null> {
  const rows = await query<{ stripe_account_id: string }>(
    `SELECT stripe_account_id FROM stripe_connected_accounts
     WHERE organization_id = $1 AND charges_enabled = true LIMIT 1`,
    [organizationId]
  );
  return rows[0]?.stripe_account_id || null;
}

async function getOrCreateStripeCustomer(
  connectedAccountId: string,
  email: string,
  name: string,
  phone?: string | null
): Promise<string> {
  const existing = await stripe.customers.list(
    { email, limit: 1 },
    { stripeAccount: connectedAccountId }
  );
  if (existing.data.length > 0) {
    return existing.data[0].id;
  }
  const customer = await stripe.customers.create(
    { email, name, phone: phone || undefined },
    { stripeAccount: connectedAccountId }
  );
  return customer.id;
}

function formatInvoice(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    stripeInvoiceId: row.stripe_invoice_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeHostedUrl: row.stripe_hosted_url,
    stripePdfUrl: row.stripe_pdf_url,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeChargeId: row.stripe_charge_id,
    subtotal: parseFloat(row.subtotal) || 0,
    taxAmount: parseFloat(row.tax_amount) || 0,
    totalAmount: parseFloat(row.total_amount) || 0,
    amountPaid: parseFloat(row.amount_paid) || 0,
    amountDue: parseFloat(row.amount_due) || 0,
    platformFeeCents: row.platform_fee_cents || 0,
    status: row.status,
    dueDate: row.due_date,
    memo: row.memo,
    internalNotes: row.internal_notes,
    footer: row.footer,
    sentAt: row.sent_at?.toISOString() || null,
    paidAt: row.paid_at?.toISOString() || null,
    voidedAt: row.voided_at?.toISOString() || null,
    amountRefunded: parseFloat(row.amount_refunded) || 0,
    refundedAt: row.refunded_at?.toISOString() || null,
    refundReceiptUrl: row.refund_receipt_url || null,
    createdBy: row.created_by,
    createdByName: row.created_by_name || null,
    createdAt: row.created_at?.toISOString() || new Date().toISOString(),
    updatedAt: row.updated_at?.toISOString() || new Date().toISOString(),
  };
}

function formatInvoiceItem(row: any) {
  return {
    id: row.id,
    description: row.description,
    quantity: row.quantity,
    unitPrice: parseFloat(row.unit_price),
    amount: parseFloat(row.amount),
    productId: row.product_id,
    sortOrder: row.sort_order,
  };
}

// ─── POST /invoices — Create draft ─────────────────────────────────────────────

const createInvoiceRoute = createRoute({
  method: 'post',
  path: '/invoices',
  summary: 'Create a draft invoice',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            customerEmail: z.string().email(),
            customerName: z.string().min(1).max(255),
            customerPhone: z.string().max(50).optional(),
            items: z.array(z.object({
              description: z.string().min(1).max(500),
              quantity: z.number().int().min(1),
              unitPrice: z.number().min(0),
              productId: z.string().uuid().optional(),
            })).min(1),
            dueDate: z.string().optional(),
            taxAmount: z.number().min(0).optional(),
            memo: z.string().max(2000).optional(),
            internalNotes: z.string().max(2000).optional(),
            footer: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Invoice created' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
  },
});

app.openapi(createInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const body = await c.req.json();
    const invoiceNumber = await getNextInvoiceNumber(payload.organizationId);

    // Calculate totals
    const subtotal = body.items.reduce((sum: number, item: any) =>
      sum + (item.quantity * item.unitPrice), 0);
    const taxAmount = body.taxAmount || 0;
    const totalAmount = subtotal + taxAmount;

    // Look up existing customer
    const existingCustomer = await query<{ id: string }>(
      'SELECT id FROM customers WHERE organization_id = $1 AND email = $2',
      [payload.organizationId, body.customerEmail.toLowerCase()]
    );

    // Insert invoice
    const invoiceRows = await query<Invoice>(
      `INSERT INTO invoices (
        organization_id, invoice_number, customer_id,
        customer_name, customer_email, customer_phone,
        subtotal, tax_amount, total_amount, amount_due,
        status, due_date, memo, internal_notes, footer, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        payload.organizationId,
        invoiceNumber,
        existingCustomer[0]?.id || null,
        body.customerName,
        body.customerEmail.toLowerCase(),
        body.customerPhone || null,
        subtotal,
        taxAmount,
        totalAmount,
        totalAmount,
        body.dueDate || null,
        body.memo || null,
        body.internalNotes || null,
        body.footer || null,
        payload.userId,
      ]
    );
    const invoice = invoiceRows[0];

    // Insert items
    const items: any[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      const amount = item.quantity * item.unitPrice;
      const itemRows = await query<InvoiceItem>(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, product_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [invoice.id, item.description, item.quantity, item.unitPrice, amount, item.productId || null, i]
      );
      items.push(formatInvoiceItem(itemRows[0]));
    }

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_CREATED, {
      invoiceId: invoice.id,
      invoiceNumber,
    });

    logger.info('Invoice created', { invoiceId: invoice.id, organizationId: payload.organizationId, invoiceNumber });

    return c.json({ invoice: { ...formatInvoice(invoice), items } });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error creating invoice', { error });
    return c.json({ error: 'Failed to create invoice' }, 500);
  }
});

// ─── GET /invoices — List invoices ──────────────────────────────────────────────

const listInvoicesRoute = createRoute({
  method: 'get',
  path: '/invoices',
  summary: 'List invoices',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.string().optional(),
      search: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: { description: 'List of invoices' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
  },
});

app.openapi(listInvoicesRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;

    let whereClause = 'i.organization_id = $1';
    const params: any[] = [payload.organizationId];
    let paramCount = 2;

    const status = c.req.query('status');
    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      const placeholders = statuses.map((_, idx) => `$${paramCount + idx}`);
      whereClause += ` AND i.status IN (${placeholders.join(',')})`;
      params.push(...statuses);
      paramCount += statuses.length;
    }

    const search = c.req.query('search');
    if (search) {
      whereClause += ` AND (i.customer_name ILIKE $${paramCount} OR i.customer_email ILIKE $${paramCount} OR i.invoice_number ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    const startDate = c.req.query('startDate');
    if (startDate) {
      whereClause += ` AND i.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    const endDate = c.req.query('endDate');
    if (endDate) {
      whereClause += ` AND i.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    // Count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM invoices i WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0');

    // Fetch invoices with creator name
    params.push(limit, offset);
    const invoices = await query<any>(
      `SELECT i.*, u.first_name || ' ' || u.last_name as created_by_name
       FROM invoices i
       LEFT JOIN users u ON i.created_by = u.id
       WHERE ${whereClause}
       ORDER BY i.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      params
    );

    return c.json({
      invoices: invoices.map(formatInvoice),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing invoices', { error });
    return c.json({ error: 'Failed to list invoices' }, 500);
  }
});

// ─── GET /invoices/stats — Aggregate stats ──────────────────────────────────────
// IMPORTANT: Register before /invoices/:id to avoid route collision

const invoiceStatsRoute = createRoute({
  method: 'get',
  path: '/invoices/stats',
  summary: 'Get invoice statistics',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Invoice statistics' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
  },
});

app.openapi(invoiceStatsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const result = await query<any>(
      `SELECT
        COUNT(*) AS total_invoices,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
        COUNT(*) FILTER (WHERE status = 'open') AS open_count,
        COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
        COUNT(*) FILTER (WHERE status = 'past_due') AS past_due_count,
        COUNT(*) FILTER (WHERE status = 'void') AS void_count,
        COUNT(*) FILTER (WHERE status = 'uncollectible') AS uncollectible_count,
        COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_count,
        COALESCE(SUM(amount_due) FILTER (WHERE status IN ('open', 'past_due')), 0) AS total_outstanding,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid' AND paid_at >= DATE_TRUNC('month', CURRENT_DATE)), 0) AS paid_this_month,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) AS total_collected
      FROM invoices WHERE organization_id = $1`,
      [payload.organizationId]
    );

    const stats = result[0];
    return c.json({
      totalInvoices: parseInt(stats.total_invoices),
      draftCount: parseInt(stats.draft_count),
      openCount: parseInt(stats.open_count),
      paidCount: parseInt(stats.paid_count),
      pastDueCount: parseInt(stats.past_due_count),
      voidCount: parseInt(stats.void_count),
      uncollectibleCount: parseInt(stats.uncollectible_count),
      refundedCount: parseInt(stats.refunded_count),
      totalOutstanding: parseFloat(stats.total_outstanding),
      paidThisMonth: parseFloat(stats.paid_this_month),
      totalCollected: parseFloat(stats.total_collected),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error getting invoice stats', { error });
    return c.json({ error: 'Failed to get invoice stats' }, 500);
  }
});

// ─── GET /invoices/:id — Get invoice detail ─────────────────────────────────────

const getInvoiceRoute = createRoute({
  method: 'get',
  path: '/invoices/{id}',
  summary: 'Get invoice detail',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Invoice detail' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(getInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    const invoices = await query<any>(
      `SELECT i.*, u.first_name || ' ' || u.last_name as created_by_name
       FROM invoices i
       LEFT JOIN users u ON i.created_by = u.id
       WHERE i.id = $1 AND i.organization_id = $2`,
      [id, payload.organizationId]
    );

    if (invoices.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }

    const items = await query<InvoiceItem>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
      [id]
    );

    return c.json({
      invoice: {
        ...formatInvoice(invoices[0]),
        items: items.map(formatInvoiceItem),
      },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error getting invoice', { error });
    return c.json({ error: 'Failed to get invoice' }, 500);
  }
});

// ─── PUT /invoices/:id — Update draft invoice ──────────────────────────────────

const updateInvoiceRoute = createRoute({
  method: 'put',
  path: '/invoices/{id}',
  summary: 'Update a draft invoice',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            customerEmail: z.string().email().optional(),
            customerName: z.string().min(1).max(255).optional(),
            customerPhone: z.string().max(50).optional().nullable(),
            items: z.array(z.object({
              description: z.string().min(1).max(500),
              quantity: z.number().int().min(1),
              unitPrice: z.number().min(0),
              productId: z.string().uuid().optional(),
            })).min(1).optional(),
            dueDate: z.string().optional().nullable(),
            taxAmount: z.number().min(0).optional(),
            memo: z.string().max(2000).optional().nullable(),
            internalNotes: z.string().max(2000).optional().nullable(),
            footer: z.string().max(500).optional().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Invoice updated' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(updateInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();
    const body = await c.req.json();

    // Verify invoice exists and is draft
    const existing = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    if (existing[0].status !== 'draft') {
      return c.json({ error: 'Only draft invoices can be edited' }, 400);
    }

    // Build update fields
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.customerName !== undefined) {
      updates.push(`customer_name = $${paramCount}`);
      values.push(body.customerName);
      paramCount++;
    }
    if (body.customerEmail !== undefined) {
      updates.push(`customer_email = $${paramCount}`);
      values.push(body.customerEmail.toLowerCase());
      paramCount++;
    }
    if (body.customerPhone !== undefined) {
      updates.push(`customer_phone = $${paramCount}`);
      values.push(body.customerPhone);
      paramCount++;
    }
    if (body.dueDate !== undefined) {
      updates.push(`due_date = $${paramCount}`);
      values.push(body.dueDate);
      paramCount++;
    }
    if (body.memo !== undefined) {
      updates.push(`memo = $${paramCount}`);
      values.push(body.memo);
      paramCount++;
    }
    if (body.internalNotes !== undefined) {
      updates.push(`internal_notes = $${paramCount}`);
      values.push(body.internalNotes);
      paramCount++;
    }
    if (body.footer !== undefined) {
      updates.push(`footer = $${paramCount}`);
      values.push(body.footer);
      paramCount++;
    }

    // Recalculate amounts if items or tax changed
    if (body.items || body.taxAmount !== undefined) {
      const items = body.items || [];
      const subtotal = items.length > 0
        ? items.reduce((sum: number, item: any) => sum + (item.quantity * item.unitPrice), 0)
        : parseFloat(existing[0].subtotal as any);
      const taxAmount = body.taxAmount !== undefined ? body.taxAmount : parseFloat(existing[0].tax_amount as any);
      const totalAmount = subtotal + taxAmount;

      updates.push(`subtotal = $${paramCount}`);
      values.push(subtotal);
      paramCount++;
      updates.push(`tax_amount = $${paramCount}`);
      values.push(taxAmount);
      paramCount++;
      updates.push(`total_amount = $${paramCount}`);
      values.push(totalAmount);
      paramCount++;
      updates.push(`amount_due = $${paramCount}`);
      values.push(totalAmount);
      paramCount++;
    }

    updates.push('updated_at = NOW()');

    // Update invoice
    values.push(id);
    const updatedRows = await query<Invoice>(
      `UPDATE invoices SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    // Replace items if provided
    let items: any[] = [];
    if (body.items) {
      await query('DELETE FROM invoice_items WHERE invoice_id = $1', [id]);
      for (let i = 0; i < body.items.length; i++) {
        const item = body.items[i];
        const amount = item.quantity * item.unitPrice;
        const itemRows = await query<InvoiceItem>(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, product_id, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [id, item.description, item.quantity, item.unitPrice, amount, item.productId || null, i]
        );
        items.push(formatInvoiceItem(itemRows[0]));
      }
    } else {
      const existingItems = await query<InvoiceItem>(
        'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
        [id]
      );
      items = existingItems.map(formatInvoiceItem);
    }

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_UPDATED, {
      invoiceId: id,
    });

    return c.json({ invoice: { ...formatInvoice(updatedRows[0]), items } });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating invoice', { error });
    return c.json({ error: 'Failed to update invoice' }, 500);
  }
});

// ─── DELETE /invoices/:id — Delete draft invoice ────────────────────────────────

const deleteInvoiceRoute = createRoute({
  method: 'delete',
  path: '/invoices/{id}',
  summary: 'Delete a draft invoice',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Invoice deleted' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(deleteInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    const existing = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    if (existing[0].status !== 'draft') {
      return c.json({ error: 'Only draft invoices can be deleted' }, 400);
    }

    await query('DELETE FROM invoices WHERE id = $1', [id]);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_UPDATED, {
      invoiceId: id,
      deleted: true,
    });

    logger.info('Invoice deleted', { invoiceId: id, organizationId: payload.organizationId });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting invoice', { error });
    return c.json({ error: 'Failed to delete invoice' }, 500);
  }
});

// ─── POST /invoices/:id/send — Finalize and send invoice ────────────────────────

const sendInvoiceRoute = createRoute({
  method: 'post',
  path: '/invoices/{id}/send',
  summary: 'Finalize and send invoice to customer',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Invoice sent' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(sendInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    // Get invoice
    const invoices = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (invoices.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    const invoice = invoices[0];
    if (invoice.status !== 'draft') {
      return c.json({ error: 'Only draft invoices can be sent' }, 400);
    }

    // Get org currency for proper Stripe unit conversion
    const orgCurrency = await getOrgCurrency(payload.organizationId);

    // Get connected account
    const connectedAccountId = await getConnectedAccount(payload.organizationId);
    if (!connectedAccountId) {
      return c.json({ error: 'Stripe Connect account required to send invoices' }, 400);
    }

    // Get items
    const items = await query<InvoiceItem>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
      [id]
    );

    // Calculate platform fee
    const totalCents = toSmallestUnit(parseFloat(invoice.total_amount as any), orgCurrency);
    const platformFeeCents = calculatePlatformFee(totalCents, (sub.tier as SubscriptionTier) || 'pro', orgCurrency);

    // Get or create Stripe customer on connected account
    const stripeCustomerId = await getOrCreateStripeCustomer(
      connectedAccountId,
      invoice.customer_email,
      invoice.customer_name,
      invoice.customer_phone
    );

    // Calculate days until due
    let daysUntilDue = 30;
    if (invoice.due_date) {
      const dueDate = new Date(invoice.due_date);
      const now = new Date();
      daysUntilDue = Math.max(1, Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    // Create Stripe invoice on connected account
    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      application_fee_amount: platformFeeCents,
      description: invoice.memo || undefined,
      footer: invoice.footer || undefined,
      metadata: {
        luma_invoice_id: invoice.id,
        organization_id: payload.organizationId,
      },
    }, { stripeAccount: connectedAccountId });

    // Add line items
    for (const item of items) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: stripeInvoice.id,
        description: item.description,
        quantity: item.quantity,
        unit_amount_decimal: String(toSmallestUnit(parseFloat(item.unit_price as any), orgCurrency)),
        metadata: { luma_item_id: item.id },
      }, { stripeAccount: connectedAccountId });
    }

    // Add tax as separate line item if applicable
    const taxAmount = parseFloat(invoice.tax_amount as any);
    if (taxAmount > 0) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: stripeInvoice.id,
        description: 'Tax',
        quantity: 1,
        unit_amount_decimal: String(toSmallestUnit(taxAmount, orgCurrency)),
      }, { stripeAccount: connectedAccountId });
    }

    // Finalize the invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(
      stripeInvoice.id,
      {},
      { stripeAccount: connectedAccountId }
    );

    // Update local DB
    const updatedRows = await query<Invoice>(
      `UPDATE invoices SET
        status = 'open',
        stripe_invoice_id = $1,
        stripe_customer_id = $2,
        stripe_hosted_url = $3,
        stripe_pdf_url = $4,
        platform_fee_cents = $5,
        sent_at = NOW(),
        updated_at = NOW()
      WHERE id = $6 RETURNING *`,
      [
        finalizedInvoice.id,
        stripeCustomerId,
        finalizedInvoice.hosted_invoice_url,
        finalizedInvoice.invoice_pdf,
        platformFeeCents,
        id,
      ]
    );

    // Get org name and branding for email
    const orgRows = await query<{ name: string; branding_logo_id: string | null }>(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const orgName = orgRows[0]?.name || 'Your vendor';
    const brandingLogoId = orgRows[0]?.branding_logo_id || null;

    // Queue email to customer
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'invoice_sent',
      to: invoice.customer_email,
      currency: orgCurrency,
      vendorBranding: {
        organizationName: orgName,
        brandingLogoUrl: getImageUrl(brandingLogoId),
      },
      data: {
        customerName: invoice.customer_name,
        invoiceNumber: invoice.invoice_number,
        organizationName: orgName,
        items: items.map(i => ({
          description: i.description,
          quantity: i.quantity,
          unitPrice: parseFloat(i.unit_price as any),
          amount: parseFloat(i.amount as any),
        })),
        subtotal: parseFloat(invoice.subtotal as any),
        taxAmount,
        totalAmount: parseFloat(invoice.total_amount as any),
        dueDate: invoice.due_date,
        memo: invoice.memo,
        hostedUrl: finalizedInvoice.hosted_invoice_url || '',
        pdfUrl: finalizedInvoice.invoice_pdf || null,
      },
    });

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_SENT, {
      invoiceId: id,
      invoiceNumber: invoice.invoice_number,
      customerName: invoice.customer_name,
      totalAmount: parseFloat(invoice.total_amount as any),
    });

    logger.info('Invoice sent', {
      invoiceId: id,
      stripeInvoiceId: finalizedInvoice.id,
      organizationId: payload.organizationId,
    });

    return c.json({
      invoice: {
        ...formatInvoice(updatedRows[0]),
        items: items.map(formatInvoiceItem),
      },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error sending invoice', { error });
    return c.json({ error: 'Failed to send invoice' }, 500);
  }
});

// ─── POST /invoices/:id/void — Void invoice ────────────────────────────────────

const voidInvoiceRoute = createRoute({
  method: 'post',
  path: '/invoices/{id}/void',
  summary: 'Void an invoice',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Invoice voided' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(voidInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    // Voiding is a money-moving action — restrict to owner/admin, not every staff user.
    if (payload.role !== 'owner' && payload.role !== 'admin') {
      return c.json({ error: 'Only an owner or admin can void invoices', code: 'FORBIDDEN' }, 403);
    }
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    const existing = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    if (existing[0].status !== 'open' && existing[0].status !== 'past_due') {
      return c.json({ error: 'Only open or overdue invoices can be voided' }, 400);
    }

    // Void on Stripe
    if (existing[0].stripe_invoice_id) {
      const connectedAccountId = await getConnectedAccount(payload.organizationId);
      if (connectedAccountId) {
        await stripe.invoices.voidInvoice(
          existing[0].stripe_invoice_id,
          {},
          { stripeAccount: connectedAccountId }
        );
      }
    }

    await query(
      `UPDATE invoices SET status = 'void', voided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_VOIDED, {
      invoiceId: id,
    });

    logger.info('Invoice voided', { invoiceId: id, organizationId: payload.organizationId });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error voiding invoice', { error });
    return c.json({ error: 'Failed to void invoice' }, 500);
  }
});

// ─── POST /invoices/:id/mark-uncollectible ──────────────────────────────────────

const markUncollectibleRoute = createRoute({
  method: 'post',
  path: '/invoices/{id}/mark-uncollectible',
  summary: 'Mark invoice as uncollectible',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Invoice marked uncollectible' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(markUncollectibleRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    const existing = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    if (existing[0].status !== 'open' && existing[0].status !== 'past_due') {
      return c.json({ error: 'Only open or overdue invoices can be marked uncollectible' }, 400);
    }

    if (existing[0].stripe_invoice_id) {
      const connectedAccountId = await getConnectedAccount(payload.organizationId);
      if (connectedAccountId) {
        await stripe.invoices.markUncollectible(
          existing[0].stripe_invoice_id,
          {},
          { stripeAccount: connectedAccountId }
        );
      }
    }

    await query(
      `UPDATE invoices SET status = 'uncollectible', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_UPDATED, {
      invoiceId: id,
      status: 'uncollectible',
    });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error marking invoice uncollectible', { error });
    return c.json({ error: 'Failed to mark invoice uncollectible' }, 500);
  }
});

// ─── POST /invoices/:id/send-reminder — Resend invoice email ────────────────────

const sendReminderRoute = createRoute({
  method: 'post',
  path: '/invoices/{id}/send-reminder',
  summary: 'Send invoice reminder email',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Reminder sent' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(sendReminderRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    const invoices = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (invoices.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    const invoice = invoices[0];
    if (invoice.status !== 'open' && invoice.status !== 'past_due') {
      return c.json({ error: 'Can only send reminders for open or overdue invoices' }, 400);
    }

    const items = await query<InvoiceItem>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
      [id]
    );

    const orgRows = await query<{ name: string; branding_logo_id: string | null }>(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const orgName = orgRows[0]?.name || 'Your vendor';
    const brandingLogoId = orgRows[0]?.branding_logo_id || null;
    const reminderCurrency = await getOrgCurrency(payload.organizationId);

    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'invoice_sent',
      to: invoice.customer_email,
      currency: reminderCurrency,
      vendorBranding: {
        organizationName: orgName,
        brandingLogoUrl: getImageUrl(brandingLogoId),
      },
      data: {
        customerName: invoice.customer_name,
        invoiceNumber: invoice.invoice_number,
        organizationName: orgName,
        items: items.map(i => ({
          description: i.description,
          quantity: i.quantity,
          unitPrice: parseFloat(i.unit_price as any),
          amount: parseFloat(i.amount as any),
        })),
        subtotal: parseFloat(invoice.subtotal as any),
        taxAmount: parseFloat(invoice.tax_amount as any),
        totalAmount: parseFloat(invoice.total_amount as any),
        dueDate: invoice.due_date,
        memo: invoice.memo,
        hostedUrl: invoice.stripe_hosted_url || '',
        pdfUrl: invoice.stripe_pdf_url || null,
        isReminder: true,
      },
    });

    logger.info('Invoice reminder sent', { invoiceId: id, organizationId: payload.organizationId });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error sending invoice reminder', { error });
    return c.json({ error: 'Failed to send reminder' }, 500);
  }
});

// ─── POST /invoices/:id/duplicate — Duplicate invoice ───────────────────────────

const duplicateInvoiceRoute = createRoute({
  method: 'post',
  path: '/invoices/{id}/duplicate',
  summary: 'Duplicate an invoice as a new draft',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Invoice duplicated' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(duplicateInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    const invoices = await query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (invoices.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    const original = invoices[0];

    const originalItems = await query<InvoiceItem>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
      [id]
    );

    // Create new draft with fresh number
    const invoiceNumber = await getNextInvoiceNumber(payload.organizationId);

    const newRows = await query<Invoice>(
      `INSERT INTO invoices (
        organization_id, invoice_number, customer_id,
        customer_name, customer_email, customer_phone,
        subtotal, tax_amount, total_amount, amount_due,
        status, due_date, memo, internal_notes, footer, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        payload.organizationId,
        invoiceNumber,
        original.customer_id,
        original.customer_name,
        original.customer_email,
        original.customer_phone,
        original.subtotal,
        original.tax_amount,
        original.total_amount,
        original.total_amount,
        original.due_date,
        original.memo,
        original.internal_notes,
        original.footer,
        payload.userId,
      ]
    );
    const newInvoice = newRows[0];

    // Copy items
    const items: any[] = [];
    for (const item of originalItems) {
      const itemRows = await query<InvoiceItem>(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, product_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [newInvoice.id, item.description, item.quantity, item.unit_price, item.amount, item.product_id, item.sort_order]
      );
      items.push(formatInvoiceItem(itemRows[0]));
    }

    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_CREATED, {
      invoiceId: newInvoice.id,
      invoiceNumber,
      duplicatedFrom: id,
    });

    logger.info('Invoice duplicated', {
      originalId: id,
      newId: newInvoice.id,
      organizationId: payload.organizationId,
    });

    return c.json({ invoice: { ...formatInvoice(newInvoice), items } });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error duplicating invoice', { error });
    return c.json({ error: 'Failed to duplicate invoice' }, 500);
  }
});

// ─── POST /invoices/:id/refund — Refund a paid invoice ──────────────────────

const refundInvoiceRoute = createRoute({
  method: 'post',
  path: '/invoices/{id}/refund',
  summary: 'Refund a paid invoice (full or partial)',
  tags: ['Invoices'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().optional(),
            reason: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Refund processed' },
    400: { description: 'Invalid refund' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Invoice not found' },
  },
});

app.openapi(refundInvoiceRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    // Refunds move money — restrict to owner/admin, not every staff user.
    if (payload.role !== 'owner' && payload.role !== 'admin') {
      return c.json({ error: 'Only an owner or admin can refund invoices', code: 'FORBIDDEN' }, 403);
    }
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Invoicing requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();
    const body = await c.req.json();

    // Get invoice
    const invoices = await query<any>(
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, payload.organizationId]
    );
    if (invoices.length === 0) {
      return c.json({ error: 'Invoice not found' }, 404);
    }
    const invoice = invoices[0];

    if (invoice.status !== 'paid') {
      return c.json({ error: 'Only paid invoices can be refunded' }, 400);
    }

    const orgCurrency = await getOrgCurrency(payload.organizationId);
    const amountPaid = parseFloat(invoice.amount_paid);
    const alreadyRefunded = parseFloat(invoice.amount_refunded) || 0;
    const refundableAmount = amountPaid - alreadyRefunded;

    if (refundableAmount <= 0) {
      return c.json({ error: 'This invoice has already been fully refunded' }, 400);
    }

    const refundAmount = body.amount ? Math.min(body.amount, refundableAmount) : refundableAmount;
    if (refundAmount <= 0) {
      return c.json({ error: 'Invalid refund amount' }, 400);
    }

    // Get connected account
    const connectedAccountId = await getConnectedAccount(payload.organizationId);
    if (!connectedAccountId) {
      return c.json({ error: 'Stripe Connect account not found' }, 400);
    }

    // Process Stripe refund
    let stripeRefundId: string | null = null;
    let refundReceiptUrl: string | null = null;
    const chargeId = invoice.stripe_charge_id;
    const paymentIntentId = invoice.stripe_payment_intent_id;

    if (chargeId || paymentIntentId) {
      const refundCents = toSmallestUnit(refundAmount, orgCurrency);
      const refundParams: any = {
        amount: refundCents,
        reason: 'requested_by_customer',
        metadata: {
          luma_invoice_id: id,
          refund_reason: body.reason || 'Vendor initiated refund',
        },
      };
      if (chargeId) {
        refundParams.charge = chargeId;
      } else {
        refundParams.payment_intent = paymentIntentId;
      }

      const refund = await stripe.refunds.create(
        refundParams,
        { stripeAccount: connectedAccountId }
      );
      stripeRefundId = refund.id;

      // Get the charge receipt URL (shows refund info after refund)
      if (chargeId) {
        try {
          const charge = await stripe.charges.retrieve(chargeId, { stripeAccount: connectedAccountId });
          refundReceiptUrl = charge.receipt_url || null;
        } catch (e) {
          // Non-critical, continue without receipt URL
        }
      }
    }

    // Update invoice
    const newAmountRefunded = alreadyRefunded + refundAmount;
    const isFullRefund = newAmountRefunded >= amountPaid;
    const newStatus = isFullRefund ? 'refunded' : 'paid';

    const updatedRows = await query<any>(
      `UPDATE invoices SET
        amount_refunded = $1,
        status = $2,
        refunded_at = COALESCE(refunded_at, NOW()),
        refund_receipt_url = COALESCE($4, refund_receipt_url),
        updated_at = NOW()
      WHERE id = $3 RETURNING *`,
      [newAmountRefunded, newStatus, id, refundReceiptUrl]
    );

    // Get items for response
    const items = await query<any>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order',
      [id]
    );

    // Emit socket event
    socketService.emitToOrganization(payload.organizationId, SocketEvents.INVOICE_UPDATED, {
      invoiceId: id,
      invoiceNumber: invoice.invoice_number,
      refundAmount,
      isFullRefund,
    });

    // Queue refund notification email
    const orgRows = await query<{ name: string; branding_logo_id: string | null }>(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const orgName = orgRows[0]?.name || 'Your vendor';
    const brandingLogoId = orgRows[0]?.branding_logo_id || null;

    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'invoice_refunded',
      to: invoice.customer_email,
      currency: orgCurrency,
      vendorBranding: {
        organizationName: orgName,
        brandingLogoUrl: getImageUrl(brandingLogoId),
      },
      data: {
        customerName: invoice.customer_name,
        invoiceNumber: invoice.invoice_number,
        organizationName: orgName,
        refundAmount,
        isFullRefund,
        totalAmount: parseFloat(invoice.total_amount),
      },
    });

    logger.info('Invoice refunded', {
      invoiceId: id,
      refundAmount,
      isFullRefund,
      stripeRefundId,
      organizationId: payload.organizationId,
    });

    return c.json({
      invoice: {
        ...formatInvoice(updatedRows[0]),
        items: items.map(formatInvoiceItem),
      },
      refundAmount,
      isFullRefund,
      stripeRefundId,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error refunding invoice', { error });
    const msg = error?.raw?.message || error?.message || 'Failed to refund invoice';
    return c.json({ error: msg }, 500);
  }
});

export default app;
