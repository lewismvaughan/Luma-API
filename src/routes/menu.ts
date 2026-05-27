import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query, transaction } from '../db';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';
import { calculatePlatformFee, SubscriptionTier } from '../config/platform-fees';
import { getOrgCurrency, toSmallestUnit, fromSmallestUnit } from '../utils/currency';
import { randomBytes } from 'crypto';
import { queueService, QueueName } from '../services/queue';
import { getImageUrl } from '../services/images';
import { getClientIpOrNull } from '../utils/client-ip';
import { publicPreorderRateLimit } from '../middleware/rate-limit';

const app = new OpenAPIHono();

// Public preorder creation is unauthenticated and writes to the DB + Stripe —
// rate-limit it (CGNAT-safe per-session cap + per-IP backstop).
app.use('/menu/public/:slug/preorder', publicPreorderRateLimit);

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Shared, TRUST_PROXY-aware client IP. Returns null for the fraud-tracking
// customer_ip column when the address can't be resolved (avoids storing the
// literal 'unknown'). Spoof-resistant — see utils/client-ip.
const getClientIp = getClientIpOrNull;

function generateOrderNumber(): string {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `PRE-${dateStr}-${random}`;
}

function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

// ─── Response formatters ──────────────────────────────────────────────────────

function formatPublicCatalog(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    location: row.location,
    date: row.date,
    slug: row.slug,
    organizationName: row.organization_name,
    // Preorder settings
    preorderPaymentMode: row.preorder_payment_mode || 'both',
    pickupInstructions: row.pickup_instructions,
    estimatedPrepTime: row.estimated_prep_time || 10,
    // Tip settings (for pay_at_pickup)
    showTipScreen: row.show_tip_screen ?? true,
    tipPercentages: row.tip_percentages ?? [15, 18, 20, 25],
    allowCustomTip: row.allow_custom_tip ?? true,
    taxRate: parseFloat(row.tax_rate) || 0,
  };
}

function formatPublicProduct(row: any) {
  return {
    id: row.product_id,
    catalogProductId: row.catalog_product_id,
    name: row.name,
    description: row.description,
    price: parseFloat(row.price),
    imageUrl: row.image_url,
    categoryId: row.category_id,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

function formatPublicCategory(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    sortOrder: row.sort_order,
  };
}

function formatPreorder(row: any) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    dailyNumber: row.daily_number,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    paymentType: row.payment_type,
    subtotal: parseFloat(row.subtotal),
    taxAmount: parseFloat(row.tax_amount),
    tipAmount: parseFloat(row.tip_amount),
    totalAmount: parseFloat(row.total_amount),
    status: row.status === 'cancelled' && row.stripe_charge_id ? 'refunded' : row.status,
    estimatedReadyAt: row.estimated_ready_at?.toISOString() || null,
    readyAt: row.ready_at?.toISOString() || null,
    pickedUpAt: row.picked_up_at?.toISOString() || null,
    orderNotes: row.order_notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (unauthenticated)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Get public menu by slug ──────────────────────────────────────────────────

const getPublicMenuRoute = createRoute({
  method: 'get',
  path: '/menu/public/{slug}',
  summary: 'Get public menu (catalog) by slug for customer browsing',
  tags: ['Menu'],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: 'Menu details with products and categories' },
    404: { description: 'Menu not found or preorders not enabled' },
  },
});

app.openapi(getPublicMenuRoute, async (c) => {
  const { slug } = c.req.param();
  try {
    // Get catalog with preorders enabled
    const catalogs = await query(
      `SELECT c.*, o.name AS organization_name, o.currency AS org_currency
       FROM catalogs c
       JOIN organizations o ON c.organization_id = o.id
       WHERE c.slug = $1 AND c.preorder_enabled = true AND c.is_active = true`,
      [slug]
    );

    if (!catalogs[0]) {
      return c.json({ error: 'Menu not found or preorders not enabled' }, 404);
    }

    const catalog = catalogs[0];

    // Check if organization has a Pro subscription (preorders are Pro-only)
    const subRows = await query<{ tier: string }>(
      `SELECT tier FROM subscriptions WHERE organization_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [(catalog as any).organization_id]
    );
    const orgTier = subRows[0]?.tier || 'starter';
    if (orgTier === 'starter' || orgTier === 'free') {
      return c.json({ error: 'Menu not available' }, 404);
    }

    // Check if organization has Stripe Connect enabled
    const stripeAccounts = await query(
      `SELECT stripe_account_id FROM stripe_connected_accounts
       WHERE organization_id = $1 AND charges_enabled = true`,
      [catalog.organization_id]
    );

    const canAcceptPayments = stripeAccounts.length > 0;

    // Get categories
    const categories = await query(
      `SELECT id, name, description, icon, sort_order
       FROM categories
       WHERE catalog_id = $1 AND is_active = true
       ORDER BY sort_order ASC`,
      [catalog.id]
    );

    // Get products with catalog pricing
    const products = await query(
      `SELECT cp.id AS catalog_product_id, cp.product_id, cp.category_id, cp.price, cp.sort_order, cp.is_active,
              p.name, p.description, p.image_url
       FROM catalog_products cp
       JOIN products p ON cp.product_id = p.id
       WHERE cp.catalog_id = $1 AND cp.is_active = true
       ORDER BY cp.sort_order ASC`,
      [catalog.id]
    );

    return c.json({
      catalog: {
        ...formatPublicCatalog(catalog),
        canAcceptPayments,
        currency: catalog.org_currency || 'usd',
        categories: categories.map(formatPublicCategory),
        products: products.map(formatPublicProduct),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching public menu', { error, slug });
    return c.json({ error: 'Failed to fetch menu' }, 500);
  }
});

// ─── Create preorder ──────────────────────────────────────────────────────────

const createPreorderRoute = createRoute({
  method: 'post',
  path: '/menu/public/{slug}/preorder',
  summary: 'Create a preorder from public menu',
  tags: ['Menu'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            customerName: z.string().min(1).max(200),
            customerEmail: z.string().email(),
            customerPhone: z.string().max(50).optional(),
            paymentType: z.enum(['pay_now', 'pay_at_pickup']),
            items: z.array(z.object({
              catalogProductId: z.string().uuid(),
              quantity: z.number().int().min(1).max(99),
              notes: z.string().max(500).optional(),
            })).min(1),
            tipAmount: z.number().min(0).optional().default(0),
            orderNotes: z.string().max(1000).optional(),
            // For pay_now only
            paymentMethodId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Preorder created' },
    400: { description: 'Invalid request' },
    404: { description: 'Menu not found' },
  },
});

app.openapi(createPreorderRoute, async (c) => {
  const { slug } = c.req.param();
  const body = await c.req.json();
  const customerIp = getClientIp(c);

  try {
    // Get catalog
    const catalogs = await query(
      `SELECT c.*, o.id AS org_id, o.name AS org_name, o.branding_logo_id
       FROM catalogs c
       JOIN organizations o ON c.organization_id = o.id
       WHERE c.slug = $1 AND c.preorder_enabled = true AND c.is_active = true`,
      [slug]
    );

    if (!catalogs[0]) {
      return c.json({ error: 'Menu not found or preorders not enabled' }, 404);
    }

    const catalog = catalogs[0];
    const organizationId = catalog.organization_id;

    // Validate payment type is allowed
    const allowedModes = catalog.preorder_payment_mode;
    if (allowedModes !== 'both' && allowedModes !== body.paymentType) {
      return c.json({
        error: `This menu only accepts ${allowedModes === 'pay_now' ? 'online payment' : 'pay at pickup'} orders`,
        code: 'PAYMENT_TYPE_NOT_ALLOWED',
      }, 400);
    }

    // For pay_now, require payment method and check Stripe is connected
    if (body.paymentType === 'pay_now') {
      if (!body.paymentMethodId) {
        return c.json({ error: 'Payment method required for pay_now orders', code: 'PAYMENT_METHOD_REQUIRED' }, 400);
      }

      const stripeAccounts = await query(
        `SELECT stripe_account_id FROM stripe_connected_accounts
         WHERE organization_id = $1 AND charges_enabled = true`,
        [organizationId]
      );

      if (!stripeAccounts[0]) {
        return c.json({ error: 'This organization cannot accept online payments', code: 'PAYMENTS_NOT_ENABLED' }, 400);
      }
    }

    // Validate items and calculate totals
    const catalogProductIds = body.items.map((i: any) => i.catalogProductId);
    const products = await query(
      `SELECT cp.id, cp.product_id, cp.price, p.name
       FROM catalog_products cp
       JOIN products p ON cp.product_id = p.id
       WHERE cp.id = ANY($1) AND cp.catalog_id = $2 AND cp.is_active = true`,
      [catalogProductIds, catalog.id]
    );

    const productMap = new Map(products.map(p => [p.id, p]));

    // Verify all items exist
    for (const item of body.items) {
      if (!productMap.has(item.catalogProductId)) {
        return c.json({ error: `Product ${item.catalogProductId} not found or unavailable`, code: 'PRODUCT_NOT_FOUND' }, 400);
      }
    }

    // Calculate totals (product.price is stored in smallest unit, convert to base unit)
    const orgCurrencyForCalc = await getOrgCurrency(organizationId);
    let subtotal = 0;
    for (const item of body.items) {
      const product = productMap.get(item.catalogProductId);
      subtotal += fromSmallestUnit(parseFloat(product.price), orgCurrencyForCalc) * item.quantity;
    }

    const taxRate = parseFloat(catalog.tax_rate) || 0;
    const taxAmount = subtotal * (taxRate / 100);
    const tipAmount = body.tipAmount || 0;
    const totalAmount = subtotal + taxAmount + tipAmount;

    const orderNumber = generateOrderNumber();
    const sessionId = generateSessionId();
    const estimatedReadyAt = new Date(Date.now() + (catalog.estimated_prep_time || 10) * 60 * 1000);

    // Get subscription tier for platform fees + Pro check
    const subRows = await query<{ tier: string }>(
      `SELECT tier FROM subscriptions WHERE organization_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [organizationId]
    );
    const subTier = (subRows[0]?.tier || 'starter') as SubscriptionTier;

    // Preorders require Pro subscription
    if (subTier === 'starter') {
      return c.json({ error: 'Preorders are not available for this menu', code: 'PRO_REQUIRED' }, 403);
    }

    let paymentIntentId: string | null = null;
    let chargeId: string | null = null;
    let platformFeeCents = 0;

    // Process payment for pay_now orders
    const orgCurrency = await getOrgCurrency(organizationId);
    if (body.paymentType === 'pay_now' && totalAmount > 0) {
      const totalCents = toSmallestUnit(totalAmount, orgCurrency);
      platformFeeCents = calculatePlatformFee(totalCents, subTier, orgCurrency);

      const stripeAccounts = await query(
        `SELECT stripe_account_id FROM stripe_connected_accounts
         WHERE organization_id = $1 AND charges_enabled = true`,
        [organizationId]
      );
      const connectedAccountId = stripeAccounts[0]?.stripe_account_id;

      if (!connectedAccountId) {
        return c.json({ error: 'Payment processing unavailable' }, 400);
      }

      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

      // Clone the platform payment method to the connected account
      const clonedPm = await stripe.paymentMethods.create(
        { payment_method: body.paymentMethodId },
        { stripeAccount: connectedAccountId }
      );

      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: totalCents,
          currency: orgCurrency,
          payment_method: clonedPm.id,
          payment_method_types: ['card'],
          confirm: true,
          application_fee_amount: platformFeeCents,
          receipt_email: body.customerEmail,
          metadata: {
            catalog_id: catalog.id,
            organization_id: organizationId,
            preorder_number: orderNumber,
            type: 'preorder',
          },
        },
        { stripeAccount: connectedAccountId }
      );

      if (paymentIntent.status !== 'succeeded') {
        return c.json({ error: 'Payment failed', status: paymentIntent.status, code: 'PAYMENT_FAILED' }, 400);
      }

      paymentIntentId = paymentIntent.id;
      chargeId = (paymentIntent.latest_charge as string) || null;
    }

    // Create preorder in transaction — side effects (socket, email) happen AFTER commit
    const { preorder, dailyNumber } = await transaction(async (client) => {
      // Get next daily order number for this organization (resets each day)
      const dailyResult = await client.query(
        `SELECT COALESCE(MAX(daily_number), 0) + 1 AS next_number
         FROM preorders
         WHERE organization_id = $1
           AND created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
        [organizationId]
      );
      const dailyNumber = dailyResult.rows[0].next_number;

      // Insert preorder
      const preorderResult = await client.query(
        `INSERT INTO preorders (
          organization_id, catalog_id, order_number, daily_number,
          customer_name, customer_email, customer_phone,
          payment_type, subtotal, tax_amount, tip_amount, total_amount,
          stripe_payment_intent_id, stripe_charge_id, platform_fee_cents,
          status, estimated_ready_at, order_notes, session_id, customer_ip
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING *`,
        [
          organizationId, catalog.id, orderNumber, dailyNumber,
          body.customerName, body.customerEmail.toLowerCase().trim(), body.customerPhone || null,
          body.paymentType, subtotal, taxAmount, tipAmount, totalAmount,
          paymentIntentId, chargeId, platformFeeCents,
          'pending', estimatedReadyAt, body.orderNotes || null, sessionId, customerIp,
        ]
      );

      const preorder = preorderResult.rows[0];

      // Insert preorder items
      for (const item of body.items) {
        const product = productMap.get(item.catalogProductId);
        await client.query(
          `INSERT INTO preorder_items (preorder_id, catalog_product_id, product_id, name, unit_price, quantity, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [preorder.id, item.catalogProductId, product.product_id, product.name, fromSmallestUnit(parseFloat(product.price), orgCurrencyForCalc), item.quantity, item.notes || null]
        );
      }

      // Update Stripe payment intent metadata with preorder_id for webhook lookup fallback
      if (paymentIntentId) {
        try {
          const stripeAccounts = await query(
            `SELECT stripe_account_id FROM stripe_connected_accounts
             WHERE organization_id = $1 AND charges_enabled = true`,
            [organizationId]
          );
          if (stripeAccounts[0]) {
            const Stripe = (await import('stripe')).default;
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
            await stripe.paymentIntents.update(
              paymentIntentId,
              { metadata: { preorder_id: preorder.id } },
              { stripeAccount: stripeAccounts[0].stripe_account_id }
            );
          }
        } catch (updateError) {
          // Non-critical - webhook can still look up by payment_intent_id
          logger.warn('Failed to update payment intent metadata with preorder_id', { updateError, preorderId: preorder.id });
        }
      }

      // Upsert customer
      await client.query(
        `INSERT INTO customers (organization_id, email, name, total_orders, total_spent, last_order_at)
         VALUES ($1, $2, $3, 1, $4, NOW())
         ON CONFLICT (organization_id, COALESCE(catalog_id, '00000000-0000-0000-0000-000000000000'::uuid), email)
         DO UPDATE SET
           total_orders = customers.total_orders + 1,
           total_spent = customers.total_spent + $4,
           last_order_at = NOW(),
           name = COALESCE(EXCLUDED.name, customers.name),
           updated_at = NOW()`,
        [organizationId, body.customerEmail.toLowerCase(), body.customerName, totalAmount]
      );

      return { preorder, dailyNumber };
    });

    // --- Transaction committed — safe to emit socket events and queue emails ---

    logger.info('Preorder created', {
      preorderId: preorder.id,
      orderNumber,
      dailyNumber,
      organizationId: organizationId,
      catalogId: catalog.id,
      catalogSlug: slug,
      paymentType: body.paymentType,
      totalAmount,
    });

    socketService.emitToOrganization(organizationId, SocketEvents.PREORDER_CREATED, {
      preorderId: preorder.id,
      orderNumber,
      dailyNumber,
      catalogId: catalog.id,
      customerName: body.customerName,
      totalAmount,
      paymentType: body.paymentType,
      itemCount: body.items.length,
    });

    // Queue confirmation email
    const siteUrl = process.env.SITE_URL || 'https://lumapos.co';
    const trackingUrl = `${siteUrl}/menu/${slug}/success?id=${preorder.id}&email=${encodeURIComponent(body.customerEmail.toLowerCase().trim())}`;

    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'preorder_confirmation',
      to: body.customerEmail,
      currency: orgCurrencyForCalc,
      vendorBranding: {
        organizationName: catalog.org_name,
        brandingLogoUrl: getImageUrl(catalog.branding_logo_id),
      },
      data: {
        orderNumber,
        dailyNumber,
        customerName: body.customerName,
        catalogName: catalog.name,
        location: catalog.location,
        items: body.items.map((item: any) => ({
          name: productMap.get(item.catalogProductId).name,
          quantity: item.quantity,
          unitPrice: fromSmallestUnit(parseFloat(productMap.get(item.catalogProductId).price), orgCurrencyForCalc),
        })),
        subtotal,
        taxAmount,
        tipAmount,
        totalAmount,
        paymentType: body.paymentType,
        estimatedReadyAt: estimatedReadyAt.toISOString(),
        pickupInstructions: catalog.pickup_instructions,
        trackingUrl,
      },
    });

    return c.json({
      preorder: {
        ...formatPreorder(preorder),
        items: body.items.map((item: any) => ({
          catalogProductId: item.catalogProductId,
          name: productMap.get(item.catalogProductId).name,
          unitPrice: fromSmallestUnit(parseFloat(productMap.get(item.catalogProductId).price), orgCurrencyForCalc),
          quantity: item.quantity,
          notes: item.notes || null,
        })),
      },
    }, 201);
  } catch (error: any) {
    logger.error('Error creating preorder', { error, slug });
    if (error.type === 'StripeCardError') {
      return c.json({ error: error.message, code: 'CARD_DECLINED' }, 400);
    }
    return c.json({ error: 'Failed to create preorder' }, 500);
  }
});

// ─── Get preorder status ──────────────────────────────────────────────────────

const getPreorderStatusRoute = createRoute({
  method: 'get',
  path: '/menu/public/{slug}/preorder/{id}',
  summary: 'Get preorder status (requires email verification)',
  tags: ['Menu'],
  request: {
    params: z.object({
      slug: z.string(),
      id: z.string().uuid(),
    }),
    query: z.object({
      email: z.string().email(),
    }),
  },
  responses: {
    200: { description: 'Preorder details' },
    404: { description: 'Preorder not found' },
  },
});

app.openapi(getPreorderStatusRoute, async (c) => {
  const { slug, id } = c.req.param();
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Email is required' }, 400);
  }

  try {
    // Get preorder with email verification
    const preorders = await query(
      `SELECT p.*, c.name AS catalog_name, c.location AS catalog_location, c.pickup_instructions
       FROM preorders p
       JOIN catalogs c ON p.catalog_id = c.id
       WHERE p.id = $1 AND c.slug = $2 AND LOWER(p.customer_email) = $3`,
      [id, slug, email.toLowerCase().trim()]
    );

    if (!preorders[0]) {
      return c.json({ error: 'Preorder not found' }, 404);
    }

    const preorder = preorders[0];

    // Get org currency
    const orgCurrency = await getOrgCurrency(preorder.organization_id);

    // Get items
    const items = await query(
      `SELECT * FROM preorder_items WHERE preorder_id = $1`,
      [preorder.id]
    );

    return c.json({
      preorder: {
        ...formatPreorder(preorder),
        currency: orgCurrency,
        catalogName: preorder.catalog_name,
        catalogLocation: preorder.catalog_location,
        pickupInstructions: preorder.pickup_instructions,
        items: items.map(item => ({
          id: item.id,
          name: item.name,
          unitPrice: parseFloat(item.unit_price),
          quantity: item.quantity,
          notes: item.notes,
        })),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching preorder status', { error, id });
    return c.json({ error: 'Failed to fetch preorder' }, 500);
  }
});

// ─── Cancel preorder (customer) ───────────────────────────────────────────────

const cancelPreorderRoute = createRoute({
  method: 'post',
  path: '/menu/public/{slug}/preorder/{id}/cancel',
  summary: 'Cancel a preorder (only if status is pending)',
  tags: ['Menu'],
  request: {
    params: z.object({
      slug: z.string(),
      id: z.string().uuid(),
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
    200: { description: 'Preorder cancelled' },
    400: { description: 'Cannot cancel - order already being prepared' },
    404: { description: 'Preorder not found' },
  },
});

app.openapi(cancelPreorderRoute, async (c) => {
  const { slug, id } = c.req.param();
  const body = await c.req.json();

  try {
    // Get preorder with email verification
    const preorders = await query(
      `SELECT p.*, c.organization_id
       FROM preorders p
       JOIN catalogs c ON p.catalog_id = c.id
       WHERE p.id = $1 AND c.slug = $2 AND LOWER(p.customer_email) = $3`,
      [id, slug, body.email.toLowerCase().trim()]
    );

    if (!preorders[0]) {
      return c.json({ error: 'Preorder not found' }, 404);
    }

    const preorder = preorders[0];

    // Only allow cancellation if pending
    if (preorder.status !== 'pending') {
      return c.json({
        error: 'Cannot cancel - order is already being prepared',
        code: 'CANNOT_CANCEL',
        currentStatus: preorder.status,
      }, 400);
    }

    // If paid, initiate refund
    if (preorder.payment_type === 'pay_now' && preorder.stripe_charge_id) {
      const stripeAccounts = await query(
        `SELECT stripe_account_id FROM stripe_connected_accounts
         WHERE organization_id = $1 AND charges_enabled = true`,
        [preorder.organization_id]
      );

      if (stripeAccounts[0]) {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

        await stripe.refunds.create(
          { charge: preorder.stripe_charge_id },
          { stripeAccount: stripeAccounts[0].stripe_account_id }
        );
      }
    }

    // Update status
    await query(
      `UPDATE preorders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    logger.info('Preorder cancelled by customer', { preorderId: id });

    // Emit socket event (use PREORDER_CANCELLED so analytics cache is invalidated)
    socketService.emitToOrganization(preorder.organization_id, SocketEvents.PREORDER_CANCELLED, {
      preorderId: id,
      status: 'cancelled',
      cancelledBy: 'customer',
    });

    return c.json({ success: true, message: 'Preorder cancelled' });
  } catch (error: any) {
    logger.error('Error cancelling preorder', { error, id });
    return c.json({ error: 'Failed to cancel preorder' }, 500);
  }
});

export default app;
