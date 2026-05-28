import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query, transaction } from '../db';
// DB model types used for reference
// import { Event, TicketTier, Ticket } from '../db/models';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';
import { SubscriptionTier } from '../config/platform-fees';
import { getOrgCurrency, toSmallestUnit, fromSmallestUnit, formatCurrency as formatCurrencyUtil } from '../utils/currency';
import { randomBytes } from 'crypto';
import { imageService, getImageUrl, type ImageType } from '../services/images';
import { queueService, QueueName } from '../services/queue';
import QRCode from 'qrcode';
import { generateAppleWalletPass, generateGoogleWalletUrl, isAppleWalletAvailable, isGoogleWalletAvailable } from '../services/wallet';
import { geocodeAddress } from '../services/geocoder';
import { clawbackReferralEarnings } from '../services/referrals';
import { checkFieldsForProfanity } from '../utils/content-filter';

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

/** Require an active pro or enterprise subscription */
async function requirePro(organizationId: string): Promise<{ tier: SubscriptionTier } | null> {
  const rows = await query<{ tier: string; status: string }>(
    `SELECT tier, status FROM subscriptions
     WHERE organization_id = $1 AND status IN ('active', 'trialing')
     LIMIT 1`,
    [organizationId]
  );
  if (rows.length === 0) return null;
  const { tier } = rows[0];
  if (tier !== 'pro' && tier !== 'enterprise') return null;
  return { tier: tier as SubscriptionTier };
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 150);
}

function generateQrCode(): string {
  return randomBytes(32).toString('hex');
}

// ─── Response helpers ──────────────────────────────────────────────────────────

function formatEvent(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    locationName: row.location_name,
    locationAddress: row.location_address,
    latitude: row.latitude ? parseFloat(row.latitude) : null,
    longitude: row.longitude ? parseFloat(row.longitude) : null,
    startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : row.starts_at,
    endsAt: row.ends_at instanceof Date ? row.ends_at.toISOString() : row.ends_at,
    salesStartAt: row.sales_start_at ? (row.sales_start_at instanceof Date ? row.sales_start_at.toISOString() : row.sales_start_at) : null,
    salesEndAt: row.sales_end_at ? (row.sales_end_at instanceof Date ? row.sales_end_at.toISOString() : row.sales_end_at) : null,
    imageUrl: row.image_url,
    bannerUrl: row.banner_url,
    visibility: row.visibility,
    status: row.status,
    createdBy: row.created_by,
    maxTicketsPerOrder: row.max_tickets_per_order ?? 10,
    refundPolicy: row.refund_policy || null,
    contactEmail: row.contact_email || null,
    ageRestriction: row.age_restriction || null,
    isRsvpOnly: row.is_rsvp_only ?? false,
    ticketsSold: parseInt(row.tickets_sold) || 0,
    ticketsScanned: parseInt(row.tickets_scanned) || 0,
    totalCapacity: parseInt(row.total_capacity) || null,
    timezone: row.timezone || 'America/New_York',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function formatTier(row: any) {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    description: row.description,
    price: parseFloat(row.price),
    maxQuantity: row.max_quantity ? parseInt(row.max_quantity) : null,
    maxPerCustomer: row.max_per_customer ? parseInt(row.max_per_customer) : null,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    soldCount: parseInt(row.sold_count) || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function formatTicket(row: any) {
  return {
    id: row.id,
    ticketTierId: row.ticket_tier_id,
    eventId: row.event_id,
    customerEmail: row.customer_email,
    customerName: row.customer_name,
    qrCode: row.qr_code,
    status: row.status,
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    usedAt: row.used_at ? (row.used_at instanceof Date ? row.used_at.toISOString() : row.used_at) : null,
    usedBy: row.used_by,
    usedByName: row.used_by_name || null,
    usedDeviceId: row.used_device_id || null,
    amountPaid: parseFloat(row.amount_paid),
    platformFeeCents: row.platform_fee_cents,
    tierName: row.tier_name || null,
    purchasedAt: row.purchased_at instanceof Date ? row.purchased_at.toISOString() : row.purchased_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const eventResponseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  locationName: z.string().nullable(),
  locationAddress: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  salesStartAt: z.string().nullable(),
  salesEndAt: z.string().nullable(),
  imageUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  visibility: z.enum(['public', 'link_only']),
  status: z.enum(['draft', 'published', 'cancelled', 'completed']),
  createdBy: z.string().nullable(),
  maxTicketsPerOrder: z.number(),
  refundPolicy: z.string().nullable(),
  contactEmail: z.string().nullable(),
  ageRestriction: z.string().nullable(),
  isRsvpOnly: z.boolean(),
  ticketsSold: z.number(),
  totalCapacity: z.number().nullable(),
  timezone: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const tierSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  price: z.number().min(0),
  maxQuantity: z.number().int().min(1).nullable().optional(),
  maxPerCustomer: z.number().int().min(1).nullable().optional(),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

const createEventSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  locationName: z.string().max(300).nullable().optional(),
  locationAddress: z.string().max(1000).nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  salesStartAt: z.string().nullable().optional(),
  salesEndAt: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  bannerUrl: z.string().nullable().optional(),
  visibility: z.enum(['public', 'link_only']).optional().default('public'),
  timezone: z.string().max(50).optional().default('America/New_York'),
  maxTicketsPerOrder: z.number().int().min(1).max(50).optional().default(10),
  refundPolicy: z.string().max(300).nullable().optional(),
  contactEmail: z.string().email().max(255).nullable().optional(),
  ageRestriction: z.string().max(100).nullable().optional(),
  isRsvpOnly: z.boolean().optional().default(false),
  tiers: z.array(tierSchema).min(1),
});

const updateEventSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  locationName: z.string().max(300).nullable().optional(),
  locationAddress: z.string().max(1000).nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  salesStartAt: z.string().nullable().optional(),
  salesEndAt: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  bannerUrl: z.string().nullable().optional(),
  visibility: z.enum(['public', 'link_only']).optional(),
  timezone: z.string().max(50).optional(),
  maxTicketsPerOrder: z.number().int().min(1).max(50).optional(),
  refundPolicy: z.string().max(300).nullable().optional(),
  contactEmail: z.string().email().max(255).nullable().optional(),
  ageRestriction: z.string().max(100).nullable().optional(),
  isRsvpOnly: z.boolean().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED (VENDOR) ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── List events ───────────────────────────────────────────────────────────────

const listEventsRoute = createRoute({
  method: 'get',
  path: '/events',
  summary: 'List events for the organization',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of events',
      content: { 'application/json': { schema: z.array(eventResponseSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
  },
});

app.openapi(listEventsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Events require a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const rows = await query(
      `SELECT e.*,
        COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status NOT IN ('cancelled', 'refunded')), 0)::int AS tickets_sold,
        COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'used'), 0)::int AS tickets_scanned,
        (SELECT SUM(tt.max_quantity) FROM ticket_tiers tt WHERE tt.event_id = e.id)::int AS total_capacity
       FROM events e
       WHERE e.organization_id = $1
       ORDER BY e.starts_at DESC`,
      [payload.organizationId]
    );

    return c.json({ events: rows.map(formatEvent) });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing events', { error });
    return c.json({ error: 'Failed to list events' }, 500);
  }
});

// ─── Create event ──────────────────────────────────────────────────────────────

const createEventRoute = createRoute({
  method: 'post',
  path: '/events',
  summary: 'Create a new event with ticket tiers',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: createEventSchema } } },
  },
  responses: {
    201: {
      description: 'Event created',
      content: { 'application/json': { schema: eventResponseSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
  },
});

app.openapi(createEventRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Events require a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const body = await c.req.json();

    // Check event name, description, and tier names for profanity
    const profanityField = checkFieldsForProfanity({
      name: body.name,
      description: body.description,
      ...(body.tiers ? Object.fromEntries(body.tiers.map((t: any, i: number) => [`tier ${i + 1} name`, t.name])) : {}),
    });
    if (profanityField) {
      return c.json({ error: `The ${profanityField} contains inappropriate language` }, 400);
    }

    // Force all tier prices to 0 for RSVP-only events
    if (body.isRsvpOnly) {
      for (const tier of body.tiers) { tier.price = 0; }
    }

    // Generate or validate slug
    let slug = body.slug ? body.slug : generateSlug(body.name);
    // Ensure unique slug
    const existing = await query('SELECT id FROM events WHERE slug = $1', [slug]);
    if (existing.length > 0) {
      slug = `${slug}-${randomBytes(3).toString('hex')}`;
    }

    // Auto-geocode address if lat/lon not provided
    let latitude = body.latitude ?? null;
    let longitude = body.longitude ?? null;
    if (body.locationAddress && latitude === null && longitude === null) {
      const geo = await geocodeAddress(body.locationAddress);
      if (geo) {
        latitude = geo.latitude;
        longitude = geo.longitude;
      }
    }

    return await transaction(async (client) => {
      const eventResult = await client.query(
        `INSERT INTO events (
          organization_id, name, slug, description,
          location_name, location_address, latitude, longitude,
          starts_at, ends_at, sales_start_at, sales_end_at,
          image_url, banner_url, visibility, timezone, status, created_by,
          max_tickets_per_order, refund_policy, contact_email, age_restriction,
          is_rsvp_only
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17,$18,$19,$20,$21,$22)
        RETURNING *`,
        [
          payload.organizationId, body.name, slug, body.description || null,
          body.locationName || null, body.locationAddress || null,
          latitude, longitude,
          body.startsAt, body.endsAt,
          body.salesStartAt || null, body.salesEndAt || null,
          body.imageUrl || null, body.bannerUrl || null,
          body.visibility || 'public', body.timezone || 'America/New_York',
          payload.userId,
          body.maxTicketsPerOrder ?? 10, body.refundPolicy || null,
          body.contactEmail || null, body.ageRestriction || null,
          body.isRsvpOnly ?? false,
        ]
      );
      const event = eventResult.rows[0];

      // Create ticket tiers
      for (let i = 0; i < body.tiers.length; i++) {
        const tier = body.tiers[i];
        await client.query(
          `INSERT INTO ticket_tiers (event_id, name, description, price, max_quantity, max_per_customer, sort_order, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [event.id, tier.name, tier.description || null, tier.price, tier.maxQuantity ?? null, tier.maxPerCustomer ?? null, tier.sortOrder ?? i, tier.isActive ?? true]
        );
      }

      logger.info('Event created', { eventId: event.id, organizationId: payload.organizationId });

      socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_CREATED, {
        eventId: event.id,
        name: event.name,
      });

      return c.json(formatEvent({ ...event, tickets_sold: 0, total_capacity: null }), 201);
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error creating event', { error });
    return c.json({ error: 'Failed to create event' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (unauthenticated)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── List public events ────────────────────────────────────────────────────────

const listPublicEventsRoute = createRoute({
  method: 'get',
  path: '/events/public',
  summary: 'List public published events',
  tags: ['Events'],
  responses: {
    200: { description: 'List of public events' },
  },
});

app.openapi(listPublicEventsRoute, async (c) => {
  try {
    const search = c.req.query('search');
    const lat = c.req.query('lat');
    const lng = c.req.query('lng');
    const radius = c.req.query('radius') || '50'; // km
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const offset = (page - 1) * limit;

    const whereConditions = `e.status = 'published' AND e.visibility = 'public' AND e.ends_at > NOW()`;
    let extraWhere = '';
    const params: any[] = [];
    let p = 1;

    if (search) {
      extraWhere += ` AND (e.name ILIKE $${p} OR e.location_name ILIKE $${p} OR e.location_address ILIKE $${p})`;
      params.push(`%${search}%`);
      p++;
    }

    if (lat && lng) {
      extraWhere += ` AND e.latitude IS NOT NULL AND e.longitude IS NOT NULL
               AND (
                 6371 * acos(
                   cos(radians($${p})) * cos(radians(e.latitude)) *
                   cos(radians(e.longitude) - radians($${p + 1})) +
                   sin(radians($${p})) * sin(radians(e.latitude))
                 )
               ) < $${p + 2}`;
      params.push(parseFloat(lat), parseFloat(lng), parseFloat(radius));
      p += 3;
    }

    // Count total
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM events e WHERE ${whereConditions}${extraWhere}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0');

    // Fetch page
    const rows = await query(
      `SELECT e.*,
        COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status NOT IN ('cancelled', 'refunded')), 0)::int AS tickets_sold,
        (SELECT SUM(tt.max_quantity) FROM ticket_tiers tt WHERE tt.event_id = e.id)::int AS total_capacity,
        (SELECT MIN(tt.price) FROM ticket_tiers tt WHERE tt.event_id = e.id AND tt.is_active = true) AS min_price,
        o.name AS organization_name,
        o.currency AS org_currency
       FROM events e
       JOIN organizations o ON e.organization_id = o.id
       WHERE ${whereConditions}${extraWhere}
       ORDER BY e.starts_at ASC
       LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset]
    );

    return c.json({
      events: rows.map(row => ({
        ...formatEvent(row),
        minPrice: row.min_price ? parseFloat(row.min_price) : null,
        organizationName: row.organization_name,
        currency: row.org_currency || 'usd',
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    logger.error('Error listing public events', { error });
    return c.json({ error: 'Failed to list events' }, 500);
  }
});

// ─── Get public event by slug ──────────────────────────────────────────────────

const getPublicEventRoute = createRoute({
  method: 'get',
  path: '/events/public/{slug}',
  summary: 'Get public event by slug',
  tags: ['Events'],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: 'Event details' },
    404: { description: 'Event not found' },
  },
});

app.openapi(getPublicEventRoute, async (c) => {
  const { slug } = c.req.param();
  try {
    const rows = await query(
      `SELECT e.*,
        o.name AS organization_name,
        o.currency AS org_currency
       FROM events e
       JOIN organizations o ON e.organization_id = o.id
       WHERE e.slug = $1 AND e.status = 'published'`,
      [slug]
    );
    if (!rows[0]) return c.json({ error: 'Event not found' }, 404);

    const event = rows[0];

    // Get tiers with availability
    const tiers = await query(
      `SELECT tt.*,
        COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.ticket_tier_id = tt.id AND t.status NOT IN ('cancelled', 'refunded')), 0)::int AS sold_count,
        COALESCE((SELECT SUM(tl.quantity) FROM ticket_locks tl WHERE tl.ticket_tier_id = tt.id AND tl.expires_at > NOW()), 0)::int AS locked_count
       FROM ticket_tiers tt
       WHERE tt.event_id = $1 AND tt.is_active = true
       ORDER BY tt.sort_order ASC`,
      [event.id]
    );

    return c.json({
      event: {
        ...formatEvent({ ...event, tickets_sold: 0, total_capacity: null }),
        organizationName: event.organization_name,
        currency: event.org_currency || 'usd',
        tiers: tiers.map(t => ({
          ...formatTier(t),
          available: t.max_quantity ? Math.max(0, parseInt(t.max_quantity) - parseInt(t.sold_count) - parseInt(t.locked_count)) : null,
        })),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching public event', { error, slug });
    return c.json({ error: 'Failed to fetch event' }, 500);
  }
});

// ─── Lock tickets ──────────────────────────────────────────────────────────────

const checkLockRoute = createRoute({
  method: 'get',
  path: '/events/public/{slug}/lock/{sessionId}',
  summary: 'Check if a ticket lock is still valid',
  tags: ['Events'],
  request: {
    params: z.object({ slug: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: { description: 'Lock status' },
    404: { description: 'Lock not found or expired' },
  },
});

app.openapi(checkLockRoute, async (c) => {
  try {
    const { slug, sessionId } = c.req.param();

    const locks = await query(
      `SELECT tl.*, tt.price, tt.name as tier_name
       FROM ticket_locks tl
       JOIN ticket_tiers tt ON tt.id = tl.ticket_tier_id
       JOIN events e ON e.id = tt.event_id
       WHERE tl.session_id = $1 AND e.slug = $2 AND tl.expires_at > NOW()`,
      [sessionId, slug]
    );

    if (!locks[0]) return c.json({ error: 'Lock not found or expired' }, 404);

    return c.json({
      sessionId,
      lockId: locks[0].id,
      tierId: locks[0].ticket_tier_id,
      quantity: locks[0].quantity,
      expiresAt: locks[0].expires_at,
      tierPrice: parseFloat(locks[0].price),
    });
  } catch (error: any) {
    logger.error('Error checking lock', { error });
    return c.json({ error: 'Failed to check lock' }, 500);
  }
});

const lockTicketsRoute = createRoute({
  method: 'post',
  path: '/events/public/{slug}/lock',
  summary: 'Lock tickets for checkout (10-minute hold)',
  tags: ['Events'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tierId: z.string().uuid(),
            quantity: z.number().int().min(1).max(10),
            customerEmail: z.string().email().optional(), // Optional during lock, required during purchase
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Tickets locked' },
    404: { description: 'Event not found' },
    409: { description: 'Not enough tickets available' },
  },
});

// Helper to get client IP from request
function getClientIp(c: any): string | null {
  // Check various headers (in order of preference)
  const xForwardedFor = c.req.header('x-forwarded-for');
  if (xForwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first (original client)
    return xForwardedFor.split(',')[0].trim();
  }
  const xRealIp = c.req.header('x-real-ip');
  if (xRealIp) return xRealIp;
  const cfConnectingIp = c.req.header('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp;
  // Fallback to direct connection (may be proxy IP)
  return c.req.raw?.socket?.remoteAddress || null;
}

app.openapi(lockTicketsRoute, async (c) => {
  try {
    const { slug } = c.req.param();
    const body = await c.req.json();
    const customerIp = getClientIp(c);
    // Email is optional during lock - real email collected during purchase
    const customerEmail = body.customerEmail ? body.customerEmail.toLowerCase().trim() : null;

    const events = await query(
      `SELECT e.id, e.max_tickets_per_order FROM events e WHERE e.slug = $1 AND e.status = 'published'`,
      [slug]
    );
    if (!events[0]) return c.json({ error: 'Event not found' }, 404);

    const maxPerOrder = events[0].max_tickets_per_order ?? 10;
    if (body.quantity > maxPerOrder) {
      return c.json({ error: `Maximum ${maxPerOrder} tickets per order`, maxPerOrder }, 400);
    }

    // Wrap availability check + lock creation in a transaction with FOR UPDATE
    // to prevent race conditions where concurrent requests both see the same availability
    const sessionId = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const lockResult = await transaction(async (client) => {
      // FOR UPDATE locks the tier row, serializing concurrent lock attempts for the same tier
      const tierResult = await client.query(
        `SELECT tt.*,
          COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.ticket_tier_id = tt.id AND t.status NOT IN ('cancelled', 'refunded')), 0)::int AS sold_count,
          COALESCE((SELECT SUM(tl.quantity) FROM ticket_locks tl WHERE tl.ticket_tier_id = tt.id AND tl.expires_at > NOW()), 0)::int AS locked_count
         FROM ticket_tiers tt
         WHERE tt.id = $1 AND tt.event_id = $2 AND tt.is_active = true
         FOR UPDATE OF tt`,
        [body.tierId, events[0].id]
      );
      if (!tierResult.rows[0]) return { error: 'Ticket tier not found', status: 404 };

      const tierRow = tierResult.rows[0];

      if (tierRow.max_quantity) {
        const available = parseInt(tierRow.max_quantity) - parseInt(tierRow.sold_count) - parseInt(tierRow.locked_count);
        if (available < body.quantity) {
          return { error: 'Not enough tickets available', available, status: 409 };
        }
      }

      // Check max_per_customer limit if set (only if email provided for email-based check)
      if (tierRow.max_per_customer) {
        const maxPerCustomer = parseInt(tierRow.max_per_customer);

        // Email-based check only if email provided
        if (customerEmail) {
          const emailTickets = await client.query(
            `SELECT COUNT(*) as count FROM tickets
             WHERE event_id = $1 AND LOWER(customer_email) = $2 AND status != 'cancelled'`,
            [events[0].id, customerEmail]
          );
          const existingByEmail = parseInt(emailTickets.rows[0]?.count || '0');

          const emailLocks = await client.query(
            `SELECT COALESCE(SUM(quantity), 0) as total FROM ticket_locks tl
             JOIN ticket_tiers tt ON tl.ticket_tier_id = tt.id
             WHERE tt.event_id = $1 AND LOWER(tl.customer_email) = $2 AND tl.expires_at > NOW()`,
            [events[0].id, customerEmail]
          );
          const lockedByEmail = parseInt(emailLocks.rows[0]?.total || '0');

          const totalByEmail = existingByEmail + lockedByEmail + body.quantity;
          if (totalByEmail > maxPerCustomer) {
            const remaining = Math.max(0, maxPerCustomer - existingByEmail - lockedByEmail);
            return {
              error: `Maximum ${maxPerCustomer} tickets per customer. You can purchase ${remaining} more.`,
              code: 'MAX_PER_CUSTOMER_EXCEEDED',
              maxPerCustomer,
              alreadyPurchased: existingByEmail,
              pendingCheckout: lockedByEmail,
              remaining,
              status: 409,
            };
          }
        }

        // Also check by IP as secondary fraud prevention (if IP available)
        if (customerIp) {
          const ipTickets = await client.query(
            `SELECT COUNT(*) as count FROM tickets
             WHERE event_id = $1 AND customer_ip = $2 AND status != 'cancelled'`,
            [events[0].id, customerIp]
          );
          const existingByIp = parseInt(ipTickets.rows[0]?.count || '0');

          const ipLocks = await client.query(
            `SELECT COALESCE(SUM(quantity), 0) as total FROM ticket_locks tl
             JOIN ticket_tiers tt ON tl.ticket_tier_id = tt.id
             WHERE tt.event_id = $1 AND tl.customer_ip = $2 AND tl.expires_at > NOW()`,
            [events[0].id, customerIp]
          );
          const lockedByIp = parseInt(ipLocks.rows[0]?.total || '0');

          const ipLimit = maxPerCustomer * 2;
          const totalByIp = existingByIp + lockedByIp + body.quantity;
          if (totalByIp > ipLimit) {
            logger.warn('IP-based ticket limit exceeded', {
              eventId: events[0].id,
              customerIp,
              existingByIp,
              lockedByIp,
              requested: body.quantity
            });
            return {
              error: 'Too many tickets purchased from this location. Please contact support if this is an error.',
              code: 'IP_LIMIT_EXCEEDED',
              status: 409,
            };
          }
        }
      }

      // Create lock within the same transaction (still holding FOR UPDATE lock)
      const lockInsert = await client.query(
        `INSERT INTO ticket_locks (ticket_tier_id, quantity, session_id, expires_at, customer_email, customer_ip)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [body.tierId, body.quantity, sessionId, expiresAt, customerEmail, customerIp]
      );

      return {
        lock: lockInsert.rows[0],
        tierPrice: parseFloat(tierRow.price),
      };
    });

    // Handle errors returned from within the transaction
    if ('error' in lockResult) {
      const { status, ...errorBody } = lockResult;
      return c.json(errorBody, status as 409 | 404);
    }

    return c.json({
      sessionId,
      lockId: lockResult.lock.id,
      expiresAt: expiresAt.toISOString(),
      tierPrice: lockResult.tierPrice,
      quantity: body.quantity,
    });
  } catch (error: any) {
    logger.error('Error locking tickets', { error });
    return c.json({ error: 'Failed to lock tickets' }, 500);
  }
});

// ─── Purchase tickets ──────────────────────────────────────────────────────────

const purchaseTicketsRoute = createRoute({
  method: 'post',
  path: '/events/public/{slug}/purchase',
  summary: 'Purchase locked tickets',
  tags: ['Events'],
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            sessionId: z.string(),
            tierId: z.string().uuid(),
            quantity: z.number().int().min(1).max(10),
            customerEmail: z.string().email(),
            customerName: z.string().min(1).max(200),
            paymentMethodId: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Tickets purchased' },
    404: { description: 'Event not found' },
    409: { description: 'Lock expired or invalid' },
  },
});

app.openapi(purchaseTicketsRoute, async (c) => {
  try {
    const { slug } = c.req.param();
    const body = await c.req.json();
    const customerIp = getClientIp(c);
    const customerEmail = body.customerEmail.toLowerCase().trim();

    // Verify lock
    const locks = await query(
      `SELECT * FROM ticket_locks WHERE session_id = $1 AND ticket_tier_id = $2 AND expires_at > NOW()`,
      [body.sessionId, body.tierId]
    );
    if (!locks[0]) {
      return c.json({ error: 'Lock expired or invalid. Please try again.', code: 'LOCK_EXPIRED' }, 409);
    }

    // Get event + org + tier
    const events = await query(
      `SELECT e.*, o.stripe_account_id, o.name as org_name, o.branding_logo_id,
              sca.stripe_account_id as connected_account_id
       FROM events e
       JOIN organizations o ON e.organization_id = o.id
       LEFT JOIN stripe_connected_accounts sca ON sca.organization_id = o.id AND sca.charges_enabled = true
       WHERE e.slug = $1 AND e.status = 'published'`,
      [slug]
    );
    if (!events[0]) return c.json({ error: 'Event not found' }, 404);

    const event = events[0];
    const connectedAccountId = event.connected_account_id;
    if (!connectedAccountId && !event.is_rsvp_only) {
      return c.json({ error: 'This organization cannot accept payments yet' }, 400);
    }

    const tiers = await query('SELECT * FROM ticket_tiers WHERE id = $1', [body.tierId]);
    if (!tiers[0]) return c.json({ error: 'Tier not found' }, 404);
    const tier = tiers[0];

    // Re-verify max_per_customer limit before payment (defense in depth)
    if (tier.max_per_customer) {
      const maxPerCustomer = parseInt(tier.max_per_customer);
      const emailTickets = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tickets
         WHERE event_id = $1 AND LOWER(customer_email) = $2 AND status != 'cancelled'`,
        [event.id, customerEmail]
      );
      const existingByEmail = parseInt(emailTickets[0]?.count || '0');

      if (existingByEmail + body.quantity > maxPerCustomer) {
        const remaining = Math.max(0, maxPerCustomer - existingByEmail);
        return c.json({
          error: `Maximum ${maxPerCustomer} tickets per customer. You can purchase ${remaining} more.`,
          code: 'MAX_PER_CUSTOMER_EXCEEDED',
          maxPerCustomer,
          alreadyPurchased: existingByEmail,
          remaining,
        }, 409);
      }
    }

    const orgCurrency = await getOrgCurrency(event.organization_id);
    const unitPrice = parseFloat(tier.price);
    const totalDollars = unitPrice * body.quantity;
    const totalCents = toSmallestUnit(totalDollars, orgCurrency);

    // Luma platform fee: $1.00 flat per ticket (100 smallest units)
    // Stripe processing fee passed through to customer via gross-up
    const LUMA_FEE_PER_TICKET_CENTS = 100;
    const lumaFeePerTicketCents = totalCents > 0 ? LUMA_FEE_PER_TICKET_CENTS : 0;
    const lumaFeeTotalCents = lumaFeePerTicketCents * body.quantity;

    // Estimated Stripe online card rates by currency
    const STRIPE_ONLINE_RATES: Record<string, { percent: number; fixed: number }> = {
      usd: { percent: 0.029, fixed: 30 }, cad: { percent: 0.029, fixed: 30 },
      gbp: { percent: 0.015, fixed: 20 }, eur: { percent: 0.015, fixed: 25 },
      aud: { percent: 0.0175, fixed: 30 }, nzd: { percent: 0.0265, fixed: 30 },
      sek: { percent: 0.015, fixed: 180 }, dkk: { percent: 0.015, fixed: 180 },
      nok: { percent: 0.024, fixed: 200 }, chf: { percent: 0.029, fixed: 30 },
      czk: { percent: 0.015, fixed: 450 }, sgd: { percent: 0.034, fixed: 50 },
      myr: { percent: 0.030, fixed: 100 },
    };
    const stripeRate = STRIPE_ONLINE_RATES[orgCurrency.toLowerCase()] || STRIPE_ONLINE_RATES.usd;

    // Gross-up: vendor nets exactly the ticket subtotal
    // Iterate to account for Stripe's independent fee rounding
    let grandTotalCents = 0;
    if (totalCents > 0) {
      grandTotalCents = Math.ceil((totalCents + lumaFeeTotalCents + stripeRate.fixed) / (1 - stripeRate.percent));
      for (let i = 0; i < 10; i++) {
        const estStripeFee = Math.round(grandTotalCents * stripeRate.percent) + stripeRate.fixed;
        if (grandTotalCents - lumaFeeTotalCents - estStripeFee >= totalCents) break;
        grandTotalCents++;
      }
    }
    const grandTotalDollars = fromSmallestUnit(grandTotalCents, orgCurrency);

    let paymentIntentId: string | null = null;
    let chargeId: string | null = null;

    // Process payment (skip Stripe for free tickets)
    if (totalCents > 0) {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

      // Clone the platform payment method to the connected account
      const clonedPm = await stripe.paymentMethods.create(
        { payment_method: body.paymentMethodId },
        { stripeAccount: connectedAccountId }
      );

      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: grandTotalCents,
          currency: orgCurrency,
          payment_method: clonedPm.id,
          payment_method_types: ['card'],
          confirm: true,
          application_fee_amount: lumaFeeTotalCents,
          receipt_email: body.customerEmail,
          metadata: {
            event_id: event.id,
            ticket_tier_id: body.tierId,
            quantity: body.quantity.toString(),
            organization_id: event.organization_id,
          },
        },
        { stripeAccount: connectedAccountId }
      );

      if (paymentIntent.status !== 'succeeded') {
        return c.json({ error: 'Payment failed', status: paymentIntent.status }, 400);
      }

      paymentIntentId = paymentIntent.id;
      chargeId = (paymentIntent.latest_charge as string) || null;
    }

    // Create tickets — single round-trip via unnest of the per-ticket qr codes
    // (everything else is the same per purchase). Was N round-trips for a
    // 6-pack; now 1.
    return await transaction(async (client) => {
      const qrCodes = Array.from({ length: body.quantity }, () => generateQrCode());
      const insertResult = await client.query(
        `INSERT INTO tickets (
           ticket_tier_id, event_id, organization_id,
           customer_email, customer_name, qr_code, status,
           stripe_payment_intent_id, stripe_charge_id,
           amount_paid, platform_fee_cents, customer_ip
         )
         SELECT $1, $2, $3, $4, $5, qr, 'valid', $6, $7, $8, $9, $10
         FROM unnest($11::text[]) AS qr
         RETURNING *`,
        [
          body.tierId, event.id, event.organization_id,
          customerEmail, body.customerName,
          paymentIntentId, chargeId,
          unitPrice, lumaFeePerTicketCents,
          customerIp,
          qrCodes,
        ]
      );
      const tickets: any[] = insertResult.rows;

      // Delete the lock
      await client.query('DELETE FROM ticket_locks WHERE session_id = $1', [body.sessionId]);

      // Upsert customer so ticket buyers appear in the organization's customer list
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
        [event.organization_id, body.customerEmail.toLowerCase(), body.customerName || null, totalDollars]
      );

      logger.info('Tickets purchased', {
        eventId: event.id,
        quantity: body.quantity,
        subtotal: totalDollars,
        serviceFee: fromSmallestUnit(lumaFeeTotalCents, orgCurrency),
        totalCharged: grandTotalDollars,
        customerEmail: body.customerEmail,
      });

      // Emit socket event for real-time vendor dashboard updates
      socketService.emitToOrganization(event.organization_id, SocketEvents.TICKET_PURCHASED, {
        eventId: event.id,
        quantity: body.quantity,
        totalAmount: totalDollars,
        tierName: tier.name,
      });

      // Queue ticket confirmation email
      const eventDate = new Date(event.starts_at);
      const eventTimezone = event.timezone || 'America/New_York';
      await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
        type: 'ticket_confirmation',
        to: body.customerEmail,
        currency: orgCurrency,
        vendorBranding: {
          organizationName: event.org_name,
          brandingLogoUrl: getImageUrl(event.branding_logo_id),
        },
        data: {
          customerName: body.customerName,
          eventName: event.name,
          eventDate: eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: eventTimezone }),
          eventTime: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: eventTimezone }),
          eventLocation: event.location_name,
          eventLocationAddress: event.location_address,
          tierName: tier.name,
          quantity: body.quantity,
          totalAmount: grandTotalDollars,
          serviceFee: fromSmallestUnit(lumaFeeTotalCents, orgCurrency),
          subtotal: totalDollars,
          tickets: tickets.map(t => ({ id: t.id, qrCode: t.qr_code })),
          eventSlug: event.slug,
          apiUrl: process.env.API_URL || 'http://localhost:3334',
          eventImageUrl: event.image_url || null,
        },
      });

      // Schedule reminder email 24h before event
      const msUntilReminder = eventDate.getTime() - Date.now() - (24 * 60 * 60 * 1000);
      if (msUntilReminder > 0) {
        await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
          type: 'ticket_reminder',
          to: body.customerEmail,
          vendorBranding: {
            organizationName: event.org_name,
            brandingLogoUrl: getImageUrl(event.branding_logo_id),
          },
          data: {
            customerName: body.customerName,
            eventName: event.name,
            eventDate: eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: eventTimezone }),
            eventTime: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: eventTimezone }),
            eventLocation: event.location_name,
            eventLocationAddress: event.location_address,
            tickets: tickets.map(t => ({ id: t.id, qrCode: t.qr_code })),
            eventSlug: event.slug,
            apiUrl: process.env.API_URL || 'http://localhost:3334',
            eventImageUrl: event.image_url || null,
          },
        }, { delay: msUntilReminder });
      }

      return c.json({
        tickets: tickets.map(t => formatTicket({ ...t, tier_name: tier.name })),
        paymentIntentId,
        totalAmount: grandTotalDollars,
        subtotal: totalDollars,
        serviceFee: fromSmallestUnit(lumaFeeTotalCents, orgCurrency),
        customerEmail: body.customerEmail,
      });
    });
  } catch (error: any) {
    logger.error('Error purchasing tickets', { error });
    if (error.type === 'StripeCardError') {
      return c.json({ error: error.message, code: 'PAYMENT_FAILED' }, 400);
    }
    return c.json({ error: 'Failed to purchase tickets' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QR CODE IMAGE ENDPOINT (public, for emails)
// ═══════════════════════════════════════════════════════════════════════════════

const qrImageRoute = createRoute({
  method: 'get',
  path: '/tickets/{id}/qr.png',
  summary: 'Get QR code image for a ticket',
  tags: ['Events'],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'QR code PNG image' },
    404: { description: 'Ticket not found' },
  },
});

app.openapi(qrImageRoute, async (c) => {
  try {
    const { id } = c.req.param();
    const tickets = await query('SELECT qr_code FROM tickets WHERE id = $1', [id]);
    if (!tickets[0]) return c.json({ error: 'Ticket not found' }, 404);

    const pngBuffer = await QRCode.toBuffer(tickets[0].qr_code, { width: 300, margin: 2, type: 'png' });

    return new Response(pngBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error: any) {
    logger.error('Error generating QR image', { error });
    return c.json({ error: 'Failed to generate QR code' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// APPLE WALLET PASS ENDPOINT (public, for email links)
// ═══════════════════════════════════════════════════════════════════════════════

const appleWalletRoute = createRoute({
  method: 'get',
  path: '/tickets/{id}/wallet/apple',
  summary: 'Download Apple Wallet pass for a ticket',
  tags: ['Events'],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Apple Wallet .pkpass file' },
    404: { description: 'Ticket not found' },
    503: { description: 'Apple Wallet not configured' },
  },
});

app.openapi(appleWalletRoute, async (c) => {
  try {
    if (!isAppleWalletAvailable()) {
      return c.json({ error: 'Apple Wallet not configured' }, 503);
    }

    const { id } = c.req.param();
    const tickets = await query(
      `SELECT t.*, tt.name as tier_name, e.name as event_name, e.starts_at, e.ends_at,
              e.location_name, e.location_address, e.latitude, e.longitude,
              e.image_url as event_image_url, e.banner_url as event_banner_url,
              e.timezone,
              o.name as org_name
       FROM tickets t
       JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
       JOIN events e ON t.event_id = e.id
       JOIN organizations o ON t.organization_id = o.id
       WHERE t.id = $1`,
      [id]
    );

    if (!tickets[0]) return c.json({ error: 'Ticket not found' }, 404);
    const ticket = tickets[0];
    const eventTimezone = ticket.timezone || 'America/New_York';

    const eventDate = new Date(ticket.starts_at);
    const passBuffer = await generateAppleWalletPass({
      ticketId: ticket.id,
      qrCode: ticket.qr_code,
      eventName: ticket.event_name,
      eventDate: eventDate.toISOString(),
      eventDateDisplay: eventDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: eventTimezone }),
      eventTime: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: eventTimezone }),
      eventLocation: ticket.location_name,
      eventAddress: ticket.location_address,
      tierName: ticket.tier_name,
      customerName: ticket.customer_name || ticket.customer_email,
      organizationName: ticket.org_name,
      latitude: ticket.latitude ? parseFloat(ticket.latitude) : null,
      longitude: ticket.longitude ? parseFloat(ticket.longitude) : null,
      timezone: eventTimezone,
    });

    if (!passBuffer) {
      return c.json({ error: 'Failed to generate pass' }, 500);
    }

    return new Response(passBuffer, {
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': `attachment; filename="ticket-${id.substring(0, 8)}.pkpass"`,
      },
    });
  } catch (error: any) {
    logger.error('Error generating Apple Wallet pass', { error });
    return c.json({ error: 'Failed to generate Apple Wallet pass' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE WALLET URL ENDPOINT (public, for email links)
// ═══════════════════════════════════════════════════════════════════════════════

const googleWalletRoute = createRoute({
  method: 'get',
  path: '/tickets/{id}/wallet/google',
  summary: 'Get Google Wallet add URL for a ticket',
  tags: ['Events'],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Redirect to Google Wallet save URL' },
    404: { description: 'Ticket not found' },
    503: { description: 'Google Wallet not configured' },
  },
});

app.openapi(googleWalletRoute, async (c) => {
  try {
    if (!isGoogleWalletAvailable()) {
      return c.json({ error: 'Google Wallet not configured' }, 503);
    }

    const { id } = c.req.param();
    const tickets = await query(
      `SELECT t.*, tt.name as tier_name, e.name as event_name, e.starts_at, e.ends_at,
              e.location_name, e.location_address, e.latitude, e.longitude,
              e.image_url as event_image_url, e.banner_url as event_banner_url,
              e.timezone,
              o.name as org_name
       FROM tickets t
       JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
       JOIN events e ON t.event_id = e.id
       JOIN organizations o ON t.organization_id = o.id
       WHERE t.id = $1`,
      [id]
    );

    if (!tickets[0]) return c.json({ error: 'Ticket not found' }, 404);
    const ticket = tickets[0];
    const eventTimezone = ticket.timezone || 'America/New_York';

    const eventDate = new Date(ticket.starts_at);
    const apiUrl = process.env.API_URL || 'http://localhost:3334';
    const url = generateGoogleWalletUrl({
      ticketId: ticket.id,
      qrCode: ticket.qr_code,
      eventName: ticket.event_name,
      eventDate: eventDate.toISOString(),
      eventDateDisplay: eventDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: eventTimezone }),
      eventTime: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: eventTimezone }),
      eventLocation: ticket.location_name,
      eventAddress: ticket.location_address,
      tierName: ticket.tier_name,
      customerName: ticket.customer_name || ticket.customer_email,
      organizationName: ticket.org_name,
      eventBannerUrl: ticket.event_banner_url,
      eventImageUrl: ticket.event_image_url,
      apiUrl,
      timezone: eventTimezone,
    });

    if (!url) {
      return c.json({ error: 'Failed to generate Google Wallet URL' }, 500);
    }

    return c.redirect(url);
  } catch (error: any) {
    logger.error('Error generating Google Wallet URL', { error });
    return c.json({ error: 'Failed to generate Google Wallet URL' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR (.ics) ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const calendarRoute = createRoute({
  method: 'get',
  path: '/tickets/{id}/calendar.ics',
  summary: 'Download .ics calendar file for a ticket',
  tags: ['Events'],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'iCalendar file' },
    404: { description: 'Ticket not found' },
  },
});

app.openapi(calendarRoute, async (c) => {
  try {
    const { id } = c.req.param();
    const tickets = await query(
      `SELECT t.*, e.name as event_name, e.starts_at, e.ends_at,
              e.location_name, e.location_address, e.description as event_description,
              e.slug as event_slug
       FROM tickets t
       JOIN events e ON t.event_id = e.id
       WHERE t.id = $1`,
      [id]
    );

    if (!tickets[0]) return c.json({ error: 'Ticket not found' }, 404);
    const ticket = tickets[0];

    const start = formatIcsDate(new Date(ticket.starts_at));
    const end = formatIcsDate(new Date(ticket.ends_at));
    const now = formatIcsDate(new Date());
    const location = [ticket.location_name, ticket.location_address].filter(Boolean).join(', ');
    const siteUrl = process.env.SITE_URL || 'https://lumapos.co';

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Luma//Tickets//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${ticket.id}@lumapos.co`,
      `DTSTAMP:${now}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${ticket.event_name}`,
      location ? `LOCATION:${location}` : '',
      ticket.event_description ? `DESCRIPTION:${ticket.event_description.replace(/\n/g, '\\n').substring(0, 500)}` : '',
      `URL:${siteUrl}/events/${ticket.event_slug}`,
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT1H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${ticket.event_name} starts in 1 hour`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');

    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ticket.event_slug}-ticket.ics"`,
      },
    });
  } catch (error: any) {
    logger.error('Error generating calendar file', { error });
    return c.json({ error: 'Failed to generate calendar file' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QR SCAN ENDPOINT (authenticated, from mobile app)
// ═══════════════════════════════════════════════════════════════════════════════

const scanTicketRoute = createRoute({
  method: 'post',
  path: '/events/scan',
  summary: 'Scan and verify a ticket QR code',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            qrCode: z.string().min(1),
            eventId: z.string().uuid().optional(),
            deviceId: z.string().max(64).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Scan result' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(scanTicketRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    const tickets = await query(
      `SELECT t.*, tt.name as tier_name, e.name as event_name, e.organization_id
       FROM tickets t
       JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
       JOIN events e ON t.event_id = e.id
       WHERE t.qr_code = $1`,
      [body.qrCode]
    );

    if (!tickets[0]) {
      return c.json({ valid: false, reason: 'INVALID', message: 'Ticket not found' });
    }

    const ticket = tickets[0];

    // Verify this ticket belongs to the scanner's organization
    if (ticket.organization_id !== payload.organizationId) {
      return c.json({ valid: false, reason: 'INVALID', message: 'Ticket not found' });
    }

    // Optionally filter by event
    if (body.eventId && ticket.event_id !== body.eventId) {
      return c.json({
        valid: false,
        reason: 'WRONG_EVENT',
        message: 'This ticket is for a different event',
        ticketEvent: ticket.event_name,
      });
    }

    if (ticket.status === 'used') {
      return c.json({
        valid: false,
        reason: 'ALREADY_USED',
        message: 'Ticket already scanned',
        usedAt: ticket.used_at,
        customerName: ticket.customer_name,
        tierName: ticket.tier_name,
        eventName: ticket.event_name,
      });
    }

    if (ticket.status === 'refunded' || ticket.status === 'cancelled') {
      return c.json({
        valid: false,
        reason: 'INVALID',
        message: `Ticket has been ${ticket.status}`,
      });
    }

    // Mark as used
    await query(
      `UPDATE tickets SET status = 'used', used_at = NOW(), used_by = $1, used_device_id = $2 WHERE id = $3`,
      [payload.userId, body.deviceId || null, ticket.id]
    );

    socketService.emitToOrganization(payload.organizationId, SocketEvents.TICKET_SCANNED, {
      eventId: ticket.event_id,
      ticketId: ticket.id,
      tierName: ticket.tier_name,
    });

    return c.json({
      valid: true,
      reason: 'VALID',
      message: 'Ticket verified',
      customerName: ticket.customer_name,
      customerEmail: ticket.customer_email,
      tierName: ticket.tier_name,
      eventName: ticket.event_name,
      amountPaid: parseFloat(ticket.amount_paid),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error scanning ticket', { error });
    return c.json({ error: 'Failed to scan ticket' }, 500);
  }
});

// ─── Get recent scans for event ────────────────────────────────────────────────

const recentScansRoute = createRoute({
  method: 'get',
  path: '/events/{eventId}/scans',
  summary: 'Get recent ticket scans for an event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({
      deviceId: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: { description: 'List of recent scans' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(recentScansRoute, async (c) => {
  const { eventId } = c.req.param();
  const deviceId = c.req.query('deviceId');
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20') || 20));

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Verify event ownership
    const event = await query(
      'SELECT id FROM events WHERE id = $1 AND organization_id = $2',
      [eventId, payload.organizationId]
    );
    if (!event[0]) return c.json({ error: 'Event not found' }, 404);

    // Build query - get recent scans, optionally filtered by device
    let sql = `
      SELECT t.id, t.customer_name, t.customer_email, t.status, t.used_at,
             t.used_by, t.used_device_id, tt.name as tier_name
      FROM tickets t
      JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
      WHERE t.event_id = $1 AND t.status = 'used'
    `;
    const params: any[] = [eventId];
    let p = 2;

    if (deviceId) {
      sql += ` AND t.used_device_id = $${p}`;
      params.push(deviceId);
      p++;
    }

    sql += ` ORDER BY t.used_at DESC LIMIT $${p}`;
    params.push(limit);

    const rows = await query(sql, params);

    return c.json({
      scans: rows.map((row: any) => ({
        id: row.id,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        tierName: row.tier_name,
        usedAt: row.used_at instanceof Date ? row.used_at.toISOString() : row.used_at,
        usedDeviceId: row.used_device_id,
      })),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching recent scans', { error, eventId });
    return c.json({ error: 'Failed to fetch recent scans' }, 500);
  }
});

// ─── Get event detail ──────────────────────────────────────────────────────────

const getEventRoute = createRoute({
  method: 'get',
  path: '/events/{id}',
  summary: 'Get event detail with tiers',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Event detail' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(getEventRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query(
      `SELECT e.*,
        COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status NOT IN ('cancelled', 'refunded')), 0)::int AS tickets_sold,
        (SELECT SUM(tt.max_quantity) FROM ticket_tiers tt WHERE tt.event_id = e.id)::int AS total_capacity
       FROM events e
       WHERE e.id = $1 AND e.organization_id = $2`,
      [id, payload.organizationId]
    );
    if (!rows[0]) return c.json({ error: 'Event not found' }, 404);

    // Get tiers with sold counts
    const tiers = await query(
      `SELECT tt.*,
        COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.ticket_tier_id = tt.id AND t.status NOT IN ('cancelled', 'refunded')), 0)::int AS sold_count
       FROM ticket_tiers tt
       WHERE tt.event_id = $1
       ORDER BY tt.sort_order ASC`,
      [id]
    );

    return c.json({
      ...formatEvent(rows[0]),
      tiers: tiers.map(formatTier),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching event', { error, eventId: id });
    return c.json({ error: 'Failed to fetch event' }, 500);
  }
});

// ─── Update event ──────────────────────────────────────────────────────────────

const updateEventRoute = createRoute({
  method: 'put',
  path: '/events/{id}',
  summary: 'Update an event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: updateEventSchema } } },
  },
  responses: {
    200: { description: 'Event updated' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(updateEventRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Check updated fields for profanity
    const profanityField = checkFieldsForProfanity({
      name: body.name,
      description: body.description,
    });
    if (profanityField) {
      return c.json({ error: `The ${profanityField} contains inappropriate language` }, 400);
    }

    const fieldMap: Record<string, string> = {
      name: 'name', slug: 'slug', description: 'description',
      locationName: 'location_name', locationAddress: 'location_address',
      latitude: 'latitude', longitude: 'longitude',
      startsAt: 'starts_at', endsAt: 'ends_at',
      salesStartAt: 'sales_start_at', salesEndAt: 'sales_end_at',
      imageUrl: 'image_url', bannerUrl: 'banner_url',
      visibility: 'visibility', timezone: 'timezone',
      maxTicketsPerOrder: 'max_tickets_per_order',
      refundPolicy: 'refund_policy', contactEmail: 'contact_email',
      ageRestriction: 'age_restriction',
      isRsvpOnly: 'is_rsvp_only',
    };

    const updates: string[] = [];
    const values: any[] = [];
    let p = 1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) {
        updates.push(`${col} = $${p}`);
        values.push(body[key]);
        p++;
      }
    }

    // Auto-geocode if address changed but no lat/lon provided
    if (body.locationAddress && body.latitude === undefined && body.longitude === undefined) {
      const geo = await geocodeAddress(body.locationAddress);
      if (geo) {
        updates.push(`latitude = $${p}`);
        values.push(geo.latitude);
        p++;
        updates.push(`longitude = $${p}`);
        values.push(geo.longitude);
        p++;
      }
    }

    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

    // If slug changed, verify uniqueness
    if (body.slug !== undefined) {
      const existing = await query('SELECT id FROM events WHERE slug = $1 AND id != $2', [body.slug, id]);
      if (existing.length > 0) return c.json({ error: 'Slug already in use' }, 409);
    }

    updates.push('updated_at = NOW()');
    values.push(id, payload.organizationId);

    const rows = await query(
      `UPDATE events SET ${updates.join(', ')}
       WHERE id = $${p} AND organization_id = $${p + 1}
       RETURNING *`,
      values
    );

    if (!rows[0]) return c.json({ error: 'Event not found' }, 404);

    // When switching to RSVP-only, force all existing tier prices to 0
    if (body.isRsvpOnly === true) {
      await query('UPDATE ticket_tiers SET price = 0, updated_at = NOW() WHERE event_id = $1', [id]);
    }

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, {
      eventId: rows[0].id,
      name: rows[0].name,
    });

    return c.json(formatEvent({ ...rows[0], tickets_sold: 0, total_capacity: null }));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating event', { error, eventId: id });
    return c.json({ error: 'Failed to update event' }, 500);
  }
});

// ─── Delete event ──────────────────────────────────────────────────────────────

const deleteEventRoute = createRoute({
  method: 'delete',
  path: '/events/{id}',
  summary: 'Delete event (only if no tickets sold)',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Event deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
    409: { description: 'Cannot delete - tickets have been sold' },
  },
});

app.openapi(deleteEventRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    if (payload.role !== 'owner') {
      return c.json({ error: 'Only owners can delete events' }, 403);
    }

    // Check for sold tickets
    const ticketCount = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tickets WHERE event_id = $1 AND status != 'cancelled'`,
      [id]
    );
    if (parseInt(ticketCount[0].count) > 0) {
      return c.json({ error: 'Cannot delete event with sold tickets', code: 'TICKETS_EXIST' }, 409);
    }

    const result = await query(
      'DELETE FROM events WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, payload.organizationId]
    );
    if (result.length === 0) return c.json({ error: 'Event not found' }, 404);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_DELETED, { eventId: id });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting event', { error, eventId: id });
    return c.json({ error: 'Failed to delete event' }, 500);
  }
});

// ─── Publish event ─────────────────────────────────────────────────────────────

const publishEventRoute = createRoute({
  method: 'post',
  path: '/events/{id}/publish',
  summary: 'Publish a draft event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Event published' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
    409: { description: 'Event is not in draft status' },
  },
});

app.openapi(publishEventRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query(
      `UPDATE events SET status = 'published', updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status = 'draft'
       RETURNING *`,
      [id, payload.organizationId]
    );

    if (!rows[0]) {
      // Check if event exists but wrong status
      const exists = await query('SELECT status FROM events WHERE id = $1 AND organization_id = $2', [id, payload.organizationId]);
      if (exists.length === 0) return c.json({ error: 'Event not found' }, 404);
      return c.json({ error: `Event is ${exists[0].status}, not draft` }, 409);
    }

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, {
      eventId: rows[0].id,
      name: rows[0].name,
      status: 'published',
    });

    return c.json(formatEvent({ ...rows[0], tickets_sold: 0, total_capacity: null }));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error publishing event', { error, eventId: id });
    return c.json({ error: 'Failed to publish event' }, 500);
  }
});

// ─── Cancel event ──────────────────────────────────────────────────────────────

const cancelEventRoute = createRoute({
  method: 'post',
  path: '/events/{id}/cancel',
  summary: 'Cancel a published event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Event cancelled' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(cancelEventRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query(
      `UPDATE events SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status IN ('draft', 'published')
       RETURNING *`,
      [id, payload.organizationId]
    );

    if (!rows[0]) return c.json({ error: 'Event not found or already cancelled/completed' }, 404);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, {
      eventId: rows[0].id,
      name: rows[0].name,
      status: 'cancelled',
    });

    return c.json(formatEvent({ ...rows[0], tickets_sold: 0, total_capacity: null }));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error cancelling event', { error, eventId: id });
    return c.json({ error: 'Failed to cancel event' }, 500);
  }
});

// ─── Ticket tier CRUD ──────────────────────────────────────────────────────────

const addTierRoute = createRoute({
  method: 'post',
  path: '/events/{id}/tiers',
  summary: 'Add a ticket tier to an event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: tierSchema } } },
  },
  responses: {
    201: { description: 'Tier created' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(addTierRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Check tier name/description for profanity
    const profanityField = checkFieldsForProfanity({ name: body.name, description: body.description });
    if (profanityField) {
      return c.json({ error: `The tier ${profanityField} contains inappropriate language` }, 400);
    }

    // Verify event ownership
    const event = await query('SELECT id FROM events WHERE id = $1 AND organization_id = $2', [id, payload.organizationId]);
    if (!event[0]) return c.json({ error: 'Event not found' }, 404);

    const rows = await query(
      `INSERT INTO ticket_tiers (event_id, name, description, price, max_quantity, max_per_customer, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, body.name, body.description || null, body.price, body.maxQuantity ?? null, body.maxPerCustomer ?? null, body.sortOrder ?? 0, body.isActive ?? true]
    );

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, { eventId: id });

    return c.json(formatTier({ ...rows[0], sold_count: 0 }), 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error adding tier', { error, eventId: id });
    return c.json({ error: 'Failed to add tier' }, 500);
  }
});

const updateTierRoute = createRoute({
  method: 'put',
  path: '/events/{id}/tiers/{tierId}',
  summary: 'Update a ticket tier',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid(), tierId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: tierSchema.partial() } } },
  },
  responses: {
    200: { description: 'Tier updated' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tier not found' },
  },
});

app.openapi(updateTierRoute, async (c) => {
  const { id, tierId } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Verify the event belongs to the caller's organization before touching its
    // tiers — otherwise any token could edit another org's tier by UUID (IDOR).
    const ownEvent = await query(
      `SELECT id FROM events WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );
    if (ownEvent.length === 0) return c.json({ error: 'Event not found' }, 404);

    // Check updated fields for profanity
    const profanityField = checkFieldsForProfanity({ name: body.name, description: body.description });
    if (profanityField) {
      return c.json({ error: `The tier ${profanityField} contains inappropriate language` }, 400);
    }

    const fieldMap: Record<string, string> = {
      name: 'name', description: 'description', price: 'price',
      maxQuantity: 'max_quantity', maxPerCustomer: 'max_per_customer',
      sortOrder: 'sort_order', isActive: 'is_active',
    };

    const updates: string[] = [];
    const values: any[] = [];
    let p = 1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) {
        updates.push(`${col} = $${p}`);
        values.push(body[key]);
        p++;
      }
    }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

    updates.push('updated_at = NOW()');
    values.push(tierId, id);

    const rows = await query(
      `UPDATE ticket_tiers SET ${updates.join(', ')}
       WHERE id = $${p} AND event_id = $${p + 1}
       RETURNING *`,
      values
    );
    if (!rows[0]) return c.json({ error: 'Tier not found' }, 404);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, { eventId: id });

    return c.json(formatTier({ ...rows[0], sold_count: 0 }));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating tier', { error, tierId });
    return c.json({ error: 'Failed to update tier' }, 500);
  }
});

const deleteTierRoute = createRoute({
  method: 'delete',
  path: '/events/{id}/tiers/{tierId}',
  summary: 'Delete a ticket tier (only if no tickets sold)',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid(), tierId: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Tier deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tier not found' },
    409: { description: 'Cannot delete - tickets sold' },
  },
});

app.openapi(deleteTierRoute, async (c) => {
  const { id, tierId } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Verify the event belongs to the caller's organization (prevents IDOR via
    // another org's event/tier UUIDs).
    const ownEvent = await query(
      `SELECT id FROM events WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );
    if (ownEvent.length === 0) return c.json({ error: 'Event not found' }, 404);

    const ticketCount = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tickets WHERE ticket_tier_id = $1 AND status != 'cancelled'`,
      [tierId]
    );
    if (parseInt(ticketCount[0].count) > 0) {
      return c.json({ error: 'Cannot delete tier with sold tickets', code: 'TICKETS_EXIST' }, 409);
    }

    const result = await query(
      `DELETE FROM ticket_tiers WHERE id = $1 AND event_id = $2 RETURNING id`,
      [tierId, id]
    );
    if (result.length === 0) return c.json({ error: 'Tier not found' }, 404);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, { eventId: id });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting tier', { error, tierId });
    return c.json({ error: 'Failed to delete tier' }, 500);
  }
});

// ─── List tickets for event ────────────────────────────────────────────────────

const listTicketsRoute = createRoute({
  method: 'get',
  path: '/events/{id}/tickets',
  summary: 'List tickets sold for an event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'List of tickets' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(listTicketsRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Verify event ownership
    const event = await query('SELECT id FROM events WHERE id = $1 AND organization_id = $2', [id, payload.organizationId]);
    if (!event[0]) return c.json({ error: 'Event not found' }, 404);

    const status = c.req.query('status');
    const search = c.req.query('search');

    let sql = `SELECT t.*, tt.name as tier_name,
                      COALESCE(u.first_name || ' ' || u.last_name, u.email) as used_by_name
               FROM tickets t
               JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
               LEFT JOIN users u ON t.used_by = u.id
               WHERE t.event_id = $1`;
    const params: any[] = [id];
    let p = 2;

    if (status) {
      sql += ` AND t.status = $${p}`;
      params.push(status);
      p++;
    }
    if (search) {
      sql += ` AND (t.customer_email ILIKE $${p} OR t.customer_name ILIKE $${p})`;
      params.push(`%${search}%`);
      p++;
    }

    // Cap + paginate. A successful event has thousands of tickets; the prior
    // unbounded query held a PG connection while streaming the whole table.
    const limitRaw = c.req.query('limit');
    const offsetRaw = c.req.query('offset');
    const limitNum = Math.min(200, Math.max(1, parseInt(limitRaw || '100', 10) || 100));
    const offsetNum = Math.max(0, parseInt(offsetRaw || '0', 10) || 0);
    params.push(limitNum, offsetNum);
    sql += ` ORDER BY t.purchased_at DESC LIMIT $${p} OFFSET $${p + 1}`;

    const rows = await query(sql, params);
    return c.json(rows.map(formatTicket));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing tickets', { error, eventId: id });
    return c.json({ error: 'Failed to list tickets' }, 500);
  }
});

// ─── Refund ticket ────────────────────────────────────────────────────────────

const refundTicketRoute = createRoute({
  method: 'post',
  path: '/events/{eventId}/tickets/{ticketId}/refund',
  summary: 'Refund a ticket (full or partial)',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      eventId: z.string().uuid(),
      ticketId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().optional(), // If not provided, full refund
            reason: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Refund processed' },
    400: { description: 'Invalid refund amount or ticket already refunded' },
    401: { description: 'Unauthorized' },
    404: { description: 'Ticket not found' },
  },
});

app.openapi(refundTicketRoute, async (c) => {
  const { eventId, ticketId } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    // Refunds move money — restrict to owner/admin (matches invoice refund).
    if (payload.role !== 'owner' && payload.role !== 'admin') {
      return c.json({ error: 'Only an owner or admin can refund tickets', code: 'FORBIDDEN' }, 403);
    }
    const body = await c.req.json();

    // Fetch ticket with event details
    const tickets = await query(
      `SELECT t.*, tt.name as tier_name, e.name as event_name, e.slug as event_slug,
              e.starts_at, e.location_name, e.timezone, sca.stripe_account_id as connected_account_id,
              o.name as org_name, o.branding_logo_id
       FROM tickets t
       JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
       JOIN events e ON t.event_id = e.id
       JOIN organizations o ON e.organization_id = o.id
       LEFT JOIN stripe_connected_accounts sca ON sca.organization_id = e.organization_id
       WHERE t.id = $1 AND t.event_id = $2 AND t.organization_id = $3`,
      [ticketId, eventId, payload.organizationId]
    );

    if (!tickets[0]) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const ticket = tickets[0];

    if (ticket.status === 'refunded') {
      return c.json({ error: 'Ticket has already been refunded' }, 400);
    }

    if (ticket.status === 'cancelled') {
      return c.json({ error: 'Cannot refund a cancelled ticket' }, 400);
    }

    const amountPaid = parseFloat(ticket.amount_paid);
    const refundAmount = body.amount !== undefined ? body.amount : amountPaid;
    const refundCurrency = await getOrgCurrency(payload.organizationId);

    if (refundAmount > amountPaid) {
      return c.json({ error: `Refund amount cannot exceed amount paid (${formatCurrencyUtil(amountPaid, refundCurrency)})` }, 400);
    }

    if (refundAmount <= 0) {
      return c.json({ error: 'Refund amount must be positive' }, 400);
    }

    // For paid tickets, process Stripe refund
    let stripeRefundId: string | null = null;
    if (ticket.stripe_charge_id && ticket.connected_account_id) {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

      const refundCents = toSmallestUnit(refundAmount, refundCurrency);

      // Create refund on the connected account (vendor pays)
      // NOTE: Service fee is NOT refunded - Luma keeps it
      const refund = await stripe.refunds.create(
        {
          charge: ticket.stripe_charge_id,
          amount: refundCents,
          reason: 'requested_by_customer',
          metadata: {
            ticket_id: ticketId,
            event_id: eventId,
            refund_reason: body.reason || 'Vendor initiated refund',
          },
        },
        { stripeAccount: ticket.connected_account_id }
      );

      stripeRefundId = refund.id;
    }

    // Update ticket status (mark as refunded if full refund)
    const isFullRefund = refundAmount >= amountPaid;
    if (isFullRefund) {
      await query(
        `UPDATE tickets SET status = 'refunded' WHERE id = $1`,
        [ticketId]
      );
    }

    // Update customer total_spent
    await query(
      `UPDATE customers
       SET total_spent = GREATEST(0, total_spent - $1), updated_at = NOW()
       WHERE organization_id = $2 AND email = $3`,
      [refundAmount, payload.organizationId, ticket.customer_email.toLowerCase()]
    );

    logger.info('Ticket refunded', {
      ticketId,
      eventId,
      refundAmount,
      isFullRefund,
      stripeRefundId,
      customerEmail: ticket.customer_email,
    });

    // Emit socket event
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TICKET_REFUNDED, {
      eventId,
      ticketId,
      refundAmount,
      isFullRefund,
    });

    // Clawback referral earnings for this specific ticket
    // New format: {paymentIntentId}:ticket:{ticketId} — per-ticket earnings
    // Old format fallback: {paymentIntentId} — legacy single earning for entire purchase
    if (ticket.stripe_payment_intent_id) {
      const perTicketSourceId = `${ticket.stripe_payment_intent_id}:ticket:${ticketId}`;
      logger.info('[Events] Attempting referral clawback for ticket refund', {
        ticketId,
        stripePaymentIntentId: ticket.stripe_payment_intent_id,
        perTicketSourceId,
        refundAmount,
        isFullRefund,
      });
      try {
        await clawbackReferralEarnings(perTicketSourceId, 'Ticket refunded');
      } catch (clawbackErr) {
        logger.error('[Events] Failed to clawback referral earnings on ticket refund', { error: clawbackErr, ticketId });
      }
    }

    // Queue refund notification email
    const eventDate = new Date(ticket.starts_at);
    const eventTimezone = ticket.timezone || 'America/New_York';
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'ticket_refund',
      to: ticket.customer_email,
      currency: refundCurrency,
      vendorBranding: {
        organizationName: ticket.org_name,
        brandingLogoUrl: getImageUrl(ticket.branding_logo_id),
      },
      data: {
        customerName: ticket.customer_name || ticket.customer_email,
        eventName: ticket.event_name,
        eventDate: eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: eventTimezone }),
        tierName: ticket.tier_name,
        refundAmount,
        isFullRefund,
        reason: body.reason,
      },
    });

    return c.json({
      success: true,
      refundAmount,
      isFullRefund,
      stripeRefundId,
      ticketStatus: isFullRefund ? 'refunded' : ticket.status,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Handle Stripe errors
    if (error.type === 'StripeInvalidRequestError') {
      logger.error('Stripe refund error', { error: error.message, ticketId });
      return c.json({ error: `Refund failed: ${error.message}` }, 400);
    }

    logger.error('Error refunding ticket', { error, ticketId, eventId });
    return c.json({ error: 'Failed to refund ticket' }, 500);
  }
});

// ─── Resend ticket email ──────────────────────────────────────────────────────

const resendTicketEmailRoute = createRoute({
  method: 'post',
  path: '/events/{id}/tickets/resend',
  summary: 'Resend ticket confirmation email to a customer',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            customerEmail: z.string().email(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Email queued' },
    401: { description: 'Unauthorized' },
    404: { description: 'No tickets found' },
  },
});

app.openapi(resendTicketEmailRoute, async (c) => {
  const { id: eventId } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Verify event ownership + get event details
    const events = await query(
      `SELECT e.*, e.slug, o.name as org_name, o.branding_logo_id
       FROM events e
       JOIN organizations o ON e.organization_id = o.id
       WHERE e.id = $1 AND e.organization_id = $2`,
      [eventId, payload.organizationId]
    );
    if (!events[0]) return c.json({ error: 'Event not found' }, 404);
    const event = events[0];

    // Get all valid tickets for this customer + event
    const tickets = await query(
      `SELECT t.*, tt.name as tier_name, tt.price
       FROM tickets t
       JOIN ticket_tiers tt ON t.ticket_tier_id = tt.id
       WHERE t.event_id = $1 AND t.customer_email = $2 AND t.status != 'cancelled'
       ORDER BY t.purchased_at ASC`,
      [eventId, body.customerEmail]
    );

    if (!tickets.length) {
      return c.json({ error: 'No tickets found for this customer' }, 404);
    }

    const eventDate = new Date(event.starts_at);
    const eventTimezone = event.timezone || 'America/New_York';
    const totalAmount = tickets.reduce((sum: number, t: any) => sum + parseFloat(t.amount_paid), 0);
    const resendCurrency = await getOrgCurrency(payload.organizationId);

    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'ticket_confirmation',
      to: body.customerEmail,
      currency: resendCurrency,
      vendorBranding: {
        organizationName: event.org_name,
        brandingLogoUrl: getImageUrl(event.branding_logo_id),
      },
      data: {
        customerName: tickets[0].customer_name,
        eventName: event.name,
        eventDate: eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: eventTimezone }),
        eventTime: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: eventTimezone }),
        eventLocation: event.location_name,
        eventLocationAddress: event.location_address,
        tierName: tickets[0].tier_name,
        quantity: tickets.length,
        totalAmount,
        tickets: tickets.map((t: any) => ({ id: t.id, qrCode: t.qr_code })),
        eventSlug: event.slug,
        apiUrl: process.env.API_URL || 'http://localhost:3334',
        eventImageUrl: event.image_url || null,
      },
    });

    logger.info('Resending ticket email', { eventId, customerEmail: body.customerEmail, ticketCount: tickets.length });

    return c.json({ success: true, ticketCount: tickets.length });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error resending ticket email', { error, eventId });
    return c.json({ error: 'Failed to resend email' }, 500);
  }
});

// ─── Event stats ───────────────────────────────────────────────────────────────

const eventStatsRoute = createRoute({
  method: 'get',
  path: '/events/{id}/stats',
  summary: 'Get ticket sales stats for an event',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Event stats' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(eventStatsRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const event = await query('SELECT id FROM events WHERE id = $1 AND organization_id = $2', [id, payload.organizationId]);
    if (!event[0]) return c.json({ error: 'Event not found' }, 404);

    const [summary] = await query(
      `SELECT
        COUNT(*) FILTER (WHERE status != 'cancelled') as total_sold,
        COUNT(*) FILTER (WHERE status = 'used') as total_scanned,
        COUNT(*) FILTER (WHERE status = 'refunded') as total_refunded,
        COALESCE(SUM(amount_paid) FILTER (WHERE status != 'cancelled' AND status != 'refunded'), 0) as total_revenue
       FROM tickets WHERE event_id = $1`,
      [id]
    );

    const tierStats = await query(
      `SELECT tt.id, tt.name, tt.price, tt.max_quantity,
        COUNT(t.id) FILTER (WHERE t.status != 'cancelled') as sold,
        COALESCE(SUM(t.amount_paid) FILTER (WHERE t.status != 'cancelled' AND t.status != 'refunded'), 0) as revenue
       FROM ticket_tiers tt
       LEFT JOIN tickets t ON t.ticket_tier_id = tt.id
       WHERE tt.event_id = $1
       GROUP BY tt.id, tt.name, tt.price, tt.max_quantity, tt.sort_order
       ORDER BY tt.sort_order ASC`,
      [id]
    );

    return c.json({
      totalSold: parseInt(summary.total_sold) || 0,
      totalScanned: parseInt(summary.total_scanned) || 0,
      totalRefunded: parseInt(summary.total_refunded) || 0,
      totalRevenue: parseFloat(summary.total_revenue) || 0,
      tiers: tierStats.map(t => ({
        id: t.id,
        name: t.name,
        price: parseFloat(t.price),
        maxQuantity: t.max_quantity ? parseInt(t.max_quantity) : null,
        sold: parseInt(t.sold) || 0,
        revenue: parseFloat(t.revenue) || 0,
      })),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching event stats', { error, eventId: id });
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// ─── Upload event image ──────────────────────────────────────────────────────

const uploadEventImageRoute = createRoute({
  method: 'post',
  path: '/events/{id}/image',
  summary: 'Upload event thumbnail image (recommended 1200x675, 16:9)',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Image uploaded' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(uploadEventImageRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const event = await query('SELECT id, image_url FROM events WHERE id = $1 AND organization_id = $2', [id, payload.organizationId]);
    if (!event[0]) return c.json({ error: 'Event not found' }, 404);

    const formData = await c.req.formData();
    const file = formData.get('image');
    if (!file || typeof file === 'string' || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ error: 'No image file provided' }, 400);
    }

    const buffer = await (file as any).arrayBuffer();
    const result = await imageService.upload(buffer, (file as any).type || 'image/jpeg', { imageType: 'event-image' as ImageType });

    await query('UPDATE events SET image_url = $1, updated_at = NOW() WHERE id = $2', [result.url, id]);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, { eventId: id });

    return c.json({ imageUrl: result.url, id: result.id });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.code === 'INVALID_TYPE') return c.json({ error: error.message }, 400);
    if (error.code === 'FILE_TOO_LARGE') return c.json({ error: error.message }, 400);
    logger.error('Error uploading event image', { error, eventId: id });
    return c.json({ error: 'Failed to upload image' }, 500);
  }
});

// ─── Upload event banner ─────────────────────────────────────────────────────

const uploadEventBannerRoute = createRoute({
  method: 'post',
  path: '/events/{id}/banner',
  summary: 'Upload event banner image (recommended 1920x480, 4:1)',
  tags: ['Events'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Banner uploaded' },
    401: { description: 'Unauthorized' },
    404: { description: 'Event not found' },
  },
});

app.openapi(uploadEventBannerRoute, async (c) => {
  const { id } = c.req.param();
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const event = await query('SELECT id, banner_url FROM events WHERE id = $1 AND organization_id = $2', [id, payload.organizationId]);
    if (!event[0]) return c.json({ error: 'Event not found' }, 404);

    const formData = await c.req.formData();
    const file = formData.get('image');
    if (!file || typeof file === 'string' || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ error: 'No image file provided' }, 400);
    }

    const buffer = await (file as any).arrayBuffer();
    const result = await imageService.upload(buffer, (file as any).type || 'image/jpeg', { imageType: 'event-banner' as ImageType });

    await query('UPDATE events SET banner_url = $1, updated_at = NOW() WHERE id = $2', [result.url, id]);

    socketService.emitToOrganization(payload.organizationId, SocketEvents.EVENT_UPDATED, { eventId: id });

    return c.json({ bannerUrl: result.url, id: result.id });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.code === 'INVALID_TYPE') return c.json({ error: error.message }, 400);
    if (error.code === 'FILE_TOO_LARGE') return c.json({ error: error.message }, 400);
    logger.error('Error uploading event banner', { error, eventId: id });
    return c.json({ error: 'Failed to upload banner' }, 500);
  }
});

export default app;
