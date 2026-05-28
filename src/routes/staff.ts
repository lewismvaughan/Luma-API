import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { staffService } from '../services/staff';
import { logger } from '../utils/logger';
import { imageService } from '../services/images';
import { query } from '../db';
import { cacheService, CacheKeys } from '../services/redis/cache';

const app = new OpenAPIHono();

// Schema definitions
const staffMemberSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.enum(['user', 'admin']),
  status: z.enum(['pending', 'active', 'disabled']),
  invitedAt: z.string(),
  inviteAcceptedAt: z.string().nullable(),
  lastLogin: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  catalogIds: z.array(z.string().uuid()),
});

const createStaffSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: z.enum(['user', 'admin']),
  catalogIds: z.array(z.string().uuid()).optional(), // Required for 'user' role
});

const updateStaffSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().max(50).nullable().optional(),
  isActive: z.boolean().optional(),
  role: z.enum(['user', 'admin']).optional(),
  catalogIds: z.array(z.string().uuid()).optional(),
});

const staffLimitsSchema = z.object({
  currentCount: z.number(),
  maxAllowed: z.number(),
  canCreateMore: z.boolean(),
});

// Helper to verify token and get user info
async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  return authService.verifyToken(token);
}

// Helper to verify owner/admin role
function verifyOwnerOrAdmin(role: string) {
  if (role !== 'owner' && role !== 'admin') {
    throw new Error('Forbidden: Only owners and admins can manage staff');
  }
}

// Pro subscription check
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

// Transform Date to ISO string
function transformStaffMember(staff: any) {
  return {
    ...staff,
    invitedAt: staff.invitedAt instanceof Date ? staff.invitedAt.toISOString() : staff.invitedAt,
    inviteAcceptedAt: staff.inviteAcceptedAt instanceof Date
      ? staff.inviteAcceptedAt.toISOString()
      : staff.inviteAcceptedAt,
    lastLogin: staff.lastLogin instanceof Date ? staff.lastLogin.toISOString() : staff.lastLogin,
  };
}

// ==================== STAFF MANAGEMENT ====================

// GET /staff - List all staff
const listStaffRoute = createRoute({
  method: 'get',
  path: '/staff',
  summary: 'List all staff members',
  description: 'Returns all staff members for the organization.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of staff members',
      content: {
        'application/json': {
          schema: z.object({
            staff: z.array(staffMemberSchema),
            limits: staffLimitsSchema,
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can list staff' },
  },
});

app.openapi(listStaffRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const staff = await staffService.listStaff(payload.organizationId);
    const limits = await staffService.canCreateStaff(payload.organizationId);

    return c.json({
      staff: staff.map(transformStaffMember),
      limits: {
        currentCount: limits.currentCount,
        maxAllowed: limits.maxAllowed,
        canCreateMore: limits.allowed,
      },
    }, 200);
  } catch (error: any) {
    logger.error('Failed to list staff', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    return c.json({ error: error.message || 'Failed to list staff' }, 400);
  }
});

// POST /staff - Create staff invite
const createStaffRoute = createRoute({
  method: 'post',
  path: '/staff',
  summary: 'Invite a new staff member',
  description: 'Creates a new staff member and sends an invite email.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createStaffSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Staff member created',
      content: {
        'application/json': {
          schema: staffMemberSchema,
        },
      },
    },
    400: { description: 'Invalid request or staff limit reached' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can create staff' },
    409: { description: 'Email already in use' },
  },
});

app.openapi(createStaffRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const body = await c.req.json();

    const staff = await staffService.createStaffInvite({
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      organizationId: payload.organizationId,
      invitedById: payload.userId,
      role: body.role,
      catalogIds: body.catalogIds,
    });

    return c.json(transformStaffMember(staff), 201);
  } catch (error: any) {
    logger.error('Failed to create staff', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    if (error.message === 'Email is already in use') {
      return c.json({ error: error.message }, 409);
    }
    return c.json({ error: error.message || 'Failed to create staff' }, 400);
  }
});

// GET /staff/:id - Get staff member details
const getStaffRoute = createRoute({
  method: 'get',
  path: '/staff/:id',
  summary: 'Get staff member details',
  description: 'Returns details for a specific staff member.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Staff member details',
      content: {
        'application/json': {
          schema: staffMemberSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can view staff' },
    404: { description: 'Staff member not found' },
  },
});

app.openapi(getStaffRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();
    const staff = await staffService.getStaff(id, payload.organizationId);

    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    return c.json(transformStaffMember(staff), 200);
  } catch (error: any) {
    logger.error('Failed to get staff', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    return c.json({ error: error.message || 'Failed to get staff' }, 400);
  }
});

// PATCH /staff/:id - Update staff member
const updateStaffRoute = createRoute({
  method: 'patch',
  path: '/staff/:id',
  summary: 'Update staff member',
  description: 'Updates staff member name, phone, or active status.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateStaffSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Staff member updated',
      content: {
        'application/json': {
          schema: staffMemberSchema,
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can update staff' },
    404: { description: 'Staff member not found' },
  },
});

app.openapi(updateStaffRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();
    const body = await c.req.json();

    const staff = await staffService.updateStaff(id, payload.organizationId, body);

    return c.json(transformStaffMember(staff), 200);
  } catch (error: any) {
    logger.error('Failed to update staff', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    if (error.message === 'Staff member not found') {
      return c.json({ error: error.message }, 404);
    }
    return c.json({ error: error.message || 'Failed to update staff' }, 400);
  }
});

// DELETE /staff/:id - Delete staff member
const deleteStaffRoute = createRoute({
  method: 'delete',
  path: '/staff/:id',
  summary: 'Delete staff member',
  description: 'Permanently deletes a staff member account.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Staff member deleted' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can delete staff' },
    404: { description: 'Staff member not found' },
  },
});

app.openapi(deleteStaffRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();
    await staffService.deleteStaff(id, payload.organizationId);

    return c.body(null, 204);
  } catch (error: any) {
    logger.error('Failed to delete staff', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    if (error.message === 'Staff member not found') {
      return c.json({ error: error.message }, 404);
    }
    return c.json({ error: error.message || 'Failed to delete staff' }, 400);
  }
});

// POST /staff/:id/resend-invite - Resend invite email
const resendInviteRoute = createRoute({
  method: 'post',
  path: '/staff/:id/resend-invite',
  summary: 'Resend staff invite',
  description: 'Resends the invitation email to a pending staff member.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Invite resent',
      content: {
        'application/json': {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: { description: 'Invite already accepted' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can resend invites' },
    404: { description: 'Staff member not found' },
  },
});

app.openapi(resendInviteRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();
    await staffService.resendInvite(id, payload.organizationId);

    return c.json({ message: 'Invite email resent successfully' }, 200);
  } catch (error: any) {
    logger.error('Failed to resend invite', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    if (error.message === 'Staff member not found') {
      return c.json({ error: error.message }, 404);
    }
    if (error.message === 'Invite has already been accepted') {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: error.message || 'Failed to resend invite' }, 400);
  }
});

// POST /staff/:id/avatar - Upload staff avatar
const uploadStaffAvatarRoute = createRoute({
  method: 'post',
  path: '/staff/:id/avatar',
  summary: 'Upload staff avatar',
  description: 'Uploads or replaces a staff member\'s profile picture.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
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
      description: 'Avatar uploaded successfully',
      content: {
        'application/json': {
          schema: z.object({
            avatarUrl: z.string(),
            avatarImageId: z.string(),
          }),
        },
      },
    },
    400: { description: 'Invalid file or file too large' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can update staff' },
    404: { description: 'Staff member not found' },
    503: { description: 'Image service not configured' },
  },
});

app.openapi(uploadStaffAvatarRoute, async (c) => {
  try {
    // Check if image service is configured
    if (!imageService.isConfigured()) {
      return c.json({ error: 'Image upload service not available' }, 503);
    }

    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    // Get the staff member
    const staff = await staffService.getStaff(id, payload.organizationId);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Parse multipart form data
    const formData = await c.req.formData();
    const file = formData.get('file') as File;

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file provided' }, 400);
    }

    // Validate content type
    const contentType = file.type;
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(contentType)) {
      return c.json({
        error: `Invalid file type. Allowed: ${allowedTypes.join(', ')}`
      }, 400);
    }

    // Read file buffer
    const buffer = await file.arrayBuffer();

    // Check file size
    const maxSize = imageService.maxSizeBytes;
    if (buffer.byteLength > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      return c.json({
        error: `File too large. Maximum size: ${maxMB}MB`
      }, 400);
    }

    // Delete old avatar if it exists
    const oldAvatarId = staff.avatarImageId;
    if (oldAvatarId) {
      try {
        await imageService.delete(oldAvatarId);
      } catch {
        logger.warn('Failed to delete old staff avatar', { staffId: id, oldAvatarId });
      }
    }

    // Upload as a new image (new ID = new URL, avoids browser cache)
    const uploadResult = await imageService.upload(buffer, contentType, {
      imageType: 'avatar',
    });

    // Update staff's avatar_image_id in database
    await query(
      `UPDATE users SET avatar_image_id = $1, updated_at = NOW() WHERE id = $2`,
      [uploadResult.id, id]
    );

    // Invalidate cache
    await cacheService.del(CacheKeys.user(id));
    if (staff.email) {
      await cacheService.del(CacheKeys.userByEmail(staff.email));
    }

    logger.info('Staff avatar uploaded', {
      staffId: id,
      avatarImageId: uploadResult.id,
    });

    return c.json({
      avatarUrl: uploadResult.url,
      avatarImageId: uploadResult.id,
    });
  } catch (error: any) {
    logger.error('Upload staff avatar error', { error });
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    return c.json({ error: error.message || 'Failed to upload avatar' }, 500);
  }
});

// DELETE /staff/:id/avatar - Delete staff avatar
const deleteStaffAvatarRoute = createRoute({
  method: 'delete',
  path: '/staff/:id/avatar',
  summary: 'Delete staff avatar',
  description: 'Deletes a staff member\'s profile picture.',
  tags: ['Staff'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Avatar deleted successfully',
      content: {
        'application/json': {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners and admins can update staff' },
    404: { description: 'Staff member not found or no avatar to delete' },
  },
});

app.openapi(deleteStaffAvatarRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    verifyOwnerOrAdmin(payload.role);

    const sub = await requirePro(payload.organizationId);
    if (!sub) {
      return c.json({ error: 'Staff management requires a Pro subscription', code: 'PRO_REQUIRED' }, 403);
    }

    const { id } = c.req.param();

    // Get the staff member
    const staff = await staffService.getStaff(id, payload.organizationId);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    if (!staff.avatarImageId) {
      return c.json({ error: 'No avatar to delete' }, 404);
    }

    // Delete the image file (if image service is configured)
    if (imageService.isConfigured()) {
      try {
        await imageService.delete(staff.avatarImageId);
      } catch (error) {
        logger.warn('Failed to delete avatar file', {
          avatarImageId: staff.avatarImageId,
          error
        });
      }
    }

    // Update staff's avatar_image_id to null in database
    await query(
      `UPDATE users SET avatar_image_id = NULL, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Invalidate BOTH user cache keys (CLAUDE.md mandate). The sibling upload
    // route already does both; the delete path was missing userByEmail.
    await cacheService.del(CacheKeys.user(id));
    if (staff.email) await cacheService.del(CacheKeys.userByEmail(staff.email));

    logger.info('Staff avatar deleted', {
      staffId: id,
      deletedAvatarId: staff.avatarImageId,
    });

    return c.json({ message: 'Avatar deleted successfully' });
  } catch (error: any) {
    logger.error('Delete staff avatar error', { error });
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message.includes('Forbidden')) {
      return c.json({ error: error.message }, 403);
    }
    return c.json({ error: error.message || 'Failed to delete avatar' }, 500);
  }
});

export default app;
