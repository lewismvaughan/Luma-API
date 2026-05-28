import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getErrors, getUnresolvedErrors, resolveError, deleteOldResolvedErrors } from '../../services/error-logging';

const app = new OpenAPIHono();

async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.slice(7);
  const { authService } = await import('../../services/auth');
  return authService.verifyToken(token);
}

// Only allow owners/admins to access error management
async function requireOwner(authHeader: string | undefined) {
  const payload = await verifyAuth(authHeader);
  if (payload.role !== 'owner' && payload.role !== 'admin') {
    throw new Error('Forbidden');
  }
  return payload;
}

// List errors
const listErrorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin - Errors'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.string().transform(Number).optional(),
      offset: z.string().transform(Number).optional(),
      resolved: z.enum(['true', 'false']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of API errors',
      content: {
        'application/json': {
          schema: z.object({
            errors: z.array(z.any()),
            total: z.number(),
          }),
        },
      },
    },
  },
});

app.openapi(listErrorsRoute, async (c) => {
  const payload = await requireOwner(c.req.header('Authorization'));

  const { limit, offset, resolved, startDate, endDate } = c.req.valid('query');

  const result = await getErrors({
    organizationId: payload.organizationId,
    limit: Math.min(200, Math.max(1, limit || 50)),
    offset: Math.max(0, offset || 0),
    resolved: resolved ? resolved === 'true' : undefined,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
  });

  return c.json(result);
});

// Get unresolved errors (quick access)
const unresolvedErrorsRoute = createRoute({
  method: 'get',
  path: '/unresolved',
  tags: ['Admin - Errors'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.string().transform(Number).optional(),
      offset: z.string().transform(Number).optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of unresolved API errors',
      content: {
        'application/json': {
          schema: z.object({
            errors: z.array(z.any()),
          }),
        },
      },
    },
  },
});

app.openapi(unresolvedErrorsRoute, async (c) => {
  const payload = await requireOwner(c.req.header('Authorization'));

  const { limit, offset } = c.req.valid('query');
  const errors = await getUnresolvedErrors(
    payload.organizationId,
    Math.min(200, Math.max(1, limit || 50)),
    Math.max(0, offset || 0)
  );

  return c.json({ errors });
});

// Resolve an error
const resolveErrorRoute = createRoute({
  method: 'post',
  path: '/:id/resolve',
  tags: ['Admin - Errors'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Error resolved',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
          }),
        },
      },
    },
  },
});

app.openapi(resolveErrorRoute, async (c) => {
  const payload = await requireOwner(c.req.header('Authorization'));
  const { id } = c.req.valid('param');
  const { notes } = c.req.valid('json');

  await resolveError(id, payload.userId, payload.organizationId, notes);

  return c.json({ success: true });
});

// Cleanup old resolved errors
const cleanupErrorsRoute = createRoute({
  method: 'post',
  path: '/cleanup',
  tags: ['Admin - Errors'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            daysOld: z.number().min(1).max(365).default(30),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Cleanup result',
      content: {
        'application/json': {
          schema: z.object({
            deleted: z.number(),
          }),
        },
      },
    },
  },
});

app.openapi(cleanupErrorsRoute, async (c) => {
  const payload = await requireOwner(c.req.header('Authorization'));
  const { daysOld } = c.req.valid('json');

  const deleted = await deleteOldResolvedErrors(payload.organizationId, daysOld);

  return c.json({ deleted: deleted || 0 });
});

export default app;
