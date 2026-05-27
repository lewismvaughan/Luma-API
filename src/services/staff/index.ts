import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../../db';
import { User, StaffStatus } from '../../db/models';
import { Subscription, DEFAULT_FEATURES_BY_TIER } from '../../db/models/subscription';
import { cacheService, CacheKeys } from '../redis/cache';
import { cognitoService } from '../auth/cognito';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { normalizeEmail } from '../../utils/email';
import { sendStaffInviteEmail } from '../email/template-sender';

export interface StaffMember {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: 'user' | 'admin';
  status: StaffStatus;
  invitedAt: Date;
  inviteAcceptedAt: Date | null;
  lastLogin: Date | null;
  avatarUrl: string | null;
  avatarImageId: string | null;
  catalogIds: string[]; // Catalogs this user has access to (only for 'user' role)
}

export interface CreateStaffParams {
  email: string;
  firstName: string;
  lastName: string;
  organizationId: string;
  invitedById: string;
  role: 'user' | 'admin';
  catalogIds?: string[]; // Required for 'user' role
}

// Convert database user to StaffMember response
function userToStaffMember(user: User, catalogIds: string[] = []): StaffMember {
  let status: StaffStatus = 'pending';
  if (!user.is_active) {
    status = 'disabled';
  } else if (user.invite_accepted_at) {
    status = 'active';
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
    role: user.role as 'user' | 'admin',
    status,
    invitedAt: user.created_at,
    inviteAcceptedAt: user.invite_accepted_at,
    lastLogin: user.last_login,
    avatarUrl: user.avatar_image_id
      ? `${config.images.fileServerUrl}/images/${user.avatar_image_id}`
      : null,
    avatarImageId: user.avatar_image_id || null,
    catalogIds,
  };
}

export class StaffService {
  /**
   * Get organization's subscription to check staff limits
   */
  async getOrganizationSubscription(organizationId: string): Promise<Subscription | null> {
    const result = await query<Subscription>(
      `SELECT * FROM subscriptions WHERE organization_id = $1 AND status IN ('active', 'trialing')`,
      [organizationId]
    );
    return result[0] || null;
  }

  /**
   * Check if organization can create more staff accounts
   */
  async canCreateStaff(organizationId: string): Promise<{ allowed: boolean; reason?: string; currentCount: number; maxAllowed: number }> {
    const subscription = await this.getOrganizationSubscription(organizationId);

    if (!subscription) {
      return { allowed: false, reason: 'No active subscription', currentCount: 0, maxAllowed: 0 };
    }

    // Get features from subscription or defaults
    const tier = subscription.tier;
    const features = subscription.features || DEFAULT_FEATURES_BY_TIER[tier];
    const maxStaff = features.max_staff_accounts ?? DEFAULT_FEATURES_BY_TIER[tier].max_staff_accounts ?? 0;

    // Count current staff (users where invited_by is not null)
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM users WHERE organization_id = $1 AND invited_by IS NOT NULL`,
      [organizationId]
    );
    const currentCount = parseInt(countResult[0].count, 10);

    // -1 means unlimited
    if (maxStaff === -1) {
      return { allowed: true, currentCount, maxAllowed: -1 };
    }

    if (currentCount >= maxStaff) {
      return {
        allowed: false,
        reason: `Staff limit reached (${currentCount}/${maxStaff}). Upgrade your plan to add more staff.`,
        currentCount,
        maxAllowed: maxStaff
      };
    }

    return { allowed: true, currentCount, maxAllowed: maxStaff };
  }

  /**
   * Get catalog IDs for a user
   */
  async getUserCatalogIds(userId: string): Promise<string[]> {
    const result = await query<{ catalog_id: string }>(
      `SELECT catalog_id FROM user_catalogs WHERE user_id = $1`,
      [userId]
    );
    return result.map(r => r.catalog_id);
  }

  /**
   * Set catalog access for a user
   */
  async setUserCatalogs(userId: string, catalogIds: string[], organizationId: string): Promise<void> {
    // Remove existing catalog assignments
    await query(`DELETE FROM user_catalogs WHERE user_id = $1`, [userId]);

    // Add new catalog assignments — only catalogs owned by this organization
    // (prevents injecting another org's catalog id into the assignment table).
    if (catalogIds.length > 0) {
      const owned = await query<{ id: string }>(
        `SELECT id FROM catalogs WHERE id = ANY($1) AND organization_id = $2`,
        [catalogIds, organizationId]
      );
      const ownedIds = owned.map(r => r.id);
      if (ownedIds.length === 0) return;
      const values = ownedIds.map((_, i) => `($1, $${i + 2})`).join(', ');
      await query(
        `INSERT INTO user_catalogs (user_id, catalog_id) VALUES ${values}`,
        [userId, ...ownedIds]
      );
    }
  }

  /**
   * List all staff members for an organization
   */
  async listStaff(organizationId: string): Promise<StaffMember[]> {
    const result = await query<User>(
      `SELECT * FROM users
       WHERE organization_id = $1 AND invited_by IS NOT NULL
       ORDER BY created_at DESC`,
      [organizationId]
    );

    // Get catalog IDs for each staff member
    const staffMembers: StaffMember[] = [];
    for (const user of result) {
      const catalogIds = user.role === 'user'
        ? await this.getUserCatalogIds(user.id)
        : [];
      staffMembers.push(userToStaffMember(user, catalogIds));
    }

    return staffMembers;
  }

  /**
   * Get a specific staff member
   */
  async getStaff(staffId: string, organizationId: string): Promise<StaffMember | null> {
    const result = await query<User>(
      `SELECT * FROM users
       WHERE id = $1 AND organization_id = $2 AND invited_by IS NOT NULL`,
      [staffId, organizationId]
    );

    if (result.length === 0) {
      return null;
    }

    const user = result[0];
    const catalogIds = user.role === 'user'
      ? await this.getUserCatalogIds(user.id)
      : [];

    return userToStaffMember(user, catalogIds);
  }

  /**
   * Create a staff invite
   */
  async createStaffInvite(params: CreateStaffParams): Promise<StaffMember> {
    const normalizedEmail = normalizeEmail(params.email);

    // Check if email is already in use
    const existingUser = await query<User>(
      `SELECT * FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (existingUser.length > 0) {
      throw new Error('Email is already in use');
    }

    // Check staff limits
    const canCreate = await this.canCreateStaff(params.organizationId);
    if (!canCreate.allowed) {
      throw new Error(canCreate.reason || 'Cannot create staff');
    }

    // Generate invite token (expires in 7 days)
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date();
    inviteExpiresAt.setDate(inviteExpiresAt.getDate() + 7);

    // Get inviter info for email
    const inviterResult = await query<User>(
      `SELECT first_name, last_name FROM users WHERE id = $1`,
      [params.invitedById]
    );
    const inviter = inviterResult[0];
    const inviterName = inviter
      ? `${inviter.first_name || ''} ${inviter.last_name || ''}`.trim() || 'Your organization admin'
      : 'Your organization admin';

    // Get organization name for email
    const orgResult = await query<{ name: string }>(
      `SELECT name FROM organizations WHERE id = $1`,
      [params.organizationId]
    );
    const orgName = orgResult[0]?.name || 'Your organization';

    // Validate catalog IDs if role is 'user'
    if (params.role === 'user' && (!params.catalogIds || params.catalogIds.length === 0)) {
      throw new Error('At least one catalog must be assigned for user role');
    }

    // Create the staff user
    const result = await query<User>(
      `INSERT INTO users (
        email, first_name, last_name, organization_id, role,
        invited_by, invite_token, invite_expires_at, is_active,
        email_alerts, marketing_emails, weekly_reports
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        normalizedEmail,
        params.firstName,
        params.lastName,
        params.organizationId,
        params.role, // 'user' or 'admin'
        params.invitedById,
        inviteToken,
        inviteExpiresAt,
        true, // is_active
        true, // email_alerts
        false, // marketing_emails (opt-in for staff)
        false, // weekly_reports
      ]
    );

    const user = result[0];

    // Set catalog access for user role
    if (params.role === 'user' && params.catalogIds && params.catalogIds.length > 0) {
      await this.setUserCatalogs(user.id, params.catalogIds, params.organizationId);
    }

    // Send invite email
    try {
      await sendStaffInviteEmail(normalizedEmail, {
        firstName: params.firstName,
        inviterName,
        organizationName: orgName,
        inviteToken,
      });
    } catch (error) {
      logger.error('Failed to send staff invite email', { error, email: normalizedEmail });
      // Don't fail the invite creation if email fails
    }

    logger.info('Staff invite created', {
      staffId: user.id,
      email: normalizedEmail,
      organizationId: params.organizationId,
      invitedBy: params.invitedById,
      role: params.role,
      catalogIds: params.catalogIds,
    });

    return userToStaffMember(user, params.catalogIds || []);
  }

  /**
   * Resend invite email
   */
  async resendInvite(staffId: string, organizationId: string): Promise<void> {
    const result = await query<User>(
      `SELECT u.*, o.name as org_name, inv.first_name as inviter_first_name, inv.last_name as inviter_last_name
       FROM users u
       JOIN organizations o ON u.organization_id = o.id
       LEFT JOIN users inv ON u.invited_by = inv.id
       WHERE u.id = $1 AND u.organization_id = $2 AND u.invited_by IS NOT NULL`,
      [staffId, organizationId]
    );

    if (result.length === 0) {
      throw new Error('Staff member not found');
    }

    const user = result[0] as User & { org_name: string; inviter_first_name: string | null; inviter_last_name: string | null };

    if (user.invite_accepted_at) {
      throw new Error('Invite has already been accepted');
    }

    // Generate new invite token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date();
    inviteExpiresAt.setDate(inviteExpiresAt.getDate() + 7);

    await query(
      `UPDATE users SET invite_token = $1, invite_expires_at = $2, updated_at = NOW()
       WHERE id = $3`,
      [inviteToken, inviteExpiresAt, staffId]
    );

    const inviterName = user.inviter_first_name
      ? `${user.inviter_first_name || ''} ${user.inviter_last_name || ''}`.trim()
      : 'Your organization admin';

    await sendStaffInviteEmail(user.email, {
      firstName: user.first_name || 'Team Member',
      inviterName,
      organizationName: user.org_name,
      inviteToken,
    });

    // Invalidate cache
    await cacheService.del(CacheKeys.user(staffId));
    await cacheService.del(CacheKeys.userByEmail(user.email));

    logger.info('Staff invite resent', { staffId, email: user.email });
  }

  /**
   * Validate an invite token
   */
  async validateInviteToken(token: string): Promise<{
    valid: boolean;
    user?: User;
    organizationName?: string;
    inviterName?: string;
  }> {
    const result = await query<User & { org_name: string; inviter_first_name: string | null; inviter_last_name: string | null }>(
      `SELECT u.*, o.name as org_name, inv.first_name as inviter_first_name, inv.last_name as inviter_last_name
       FROM users u
       JOIN organizations o ON u.organization_id = o.id
       LEFT JOIN users inv ON u.invited_by = inv.id
       WHERE u.invite_token = $1
         AND u.invite_expires_at > NOW()
         AND u.invite_accepted_at IS NULL`,
      [token]
    );

    if (result.length === 0) {
      return { valid: false };
    }

    const user = result[0];
    const inviterName = user.inviter_first_name
      ? `${user.inviter_first_name || ''} ${user.inviter_last_name || ''}`.trim()
      : undefined;

    return {
      valid: true,
      user,
      organizationName: user.org_name,
      inviterName,
    };
  }

  /**
   * Accept an invite and set password
   */
  async acceptInvite(token: string, password: string): Promise<User> {
    const validation = await this.validateInviteToken(token);
    if (!validation.valid || !validation.user) {
      throw new Error('Invalid or expired invite token');
    }

    const user = validation.user;

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Update user
    await query(
      `UPDATE users SET
        password_hash = $1,
        invite_token = NULL,
        invite_expires_at = NULL,
        invite_accepted_at = NOW(),
        updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    // Create Cognito user if configured
    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.createUser({
          email: user.email,
          temporaryPassword: password,
          attributes: {
            given_name: user.first_name || '',
            family_name: user.last_name || '',
          },
        });

        await cognitoService.addUserToGroup(user.email, 'user');
        await cognitoService.setUserPassword(user.email, password, true);
      } catch (error: any) {
        // If user already exists in Cognito, that's fine
        if (error.name !== 'UsernameExistsException') {
          logger.error('Failed to create Cognito user for staff', { error, userId: user.id });
          throw error;
        }
      }
    }

    // Get updated user
    const updatedResult = await query<User>(
      `SELECT * FROM users WHERE id = $1`,
      [user.id]
    );

    const updatedUser = updatedResult[0];

    // Cache the user
    await cacheService.set(CacheKeys.user(user.id), updatedUser, { ttl: 3600 });
    await cacheService.set(CacheKeys.userByEmail(user.email), updatedUser, { ttl: 3600 });

    logger.info('Staff invite accepted', { userId: user.id, email: user.email });

    return updatedUser;
  }

  /**
   * Update staff member
   */
  async updateStaff(
    staffId: string,
    organizationId: string,
    updates: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      isActive?: boolean;
      role?: 'user' | 'admin';
      catalogIds?: string[];
    }
  ): Promise<StaffMember> {
    const staff = await this.getStaff(staffId, organizationId);
    if (!staff) {
      throw new Error('Staff member not found');
    }

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.firstName !== undefined) {
      setClauses.push(`first_name = $${paramIndex++}`);
      values.push(updates.firstName);
    }
    if (updates.lastName !== undefined) {
      setClauses.push(`last_name = $${paramIndex++}`);
      values.push(updates.lastName);
    }
    if (updates.phone !== undefined) {
      setClauses.push(`phone = $${paramIndex++}`);
      values.push(updates.phone);
    }
    if (updates.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIndex++}`);
      values.push(updates.isActive);

      // If disabling, increment session version to force logout
      if (!updates.isActive) {
        setClauses.push(`session_version = session_version + 1`);
      }
    }
    if (updates.role !== undefined) {
      setClauses.push(`role = $${paramIndex++}`);
      values.push(updates.role);

      // If changing to admin, clear catalog assignments (admins have access to all)
      if (updates.role === 'admin') {
        await this.setUserCatalogs(staffId, [], organizationId);
      }
    }

    // Validate catalog assignments for user role
    const newRole = updates.role || staff.role;
    if (newRole === 'user' && updates.catalogIds !== undefined) {
      if (updates.catalogIds.length === 0) {
        throw new Error('At least one catalog must be assigned for user role');
      }
      await this.setUserCatalogs(staffId, updates.catalogIds, organizationId);
    }

    if (setClauses.length === 0 && updates.catalogIds === undefined) {
      return staff;
    }

    let user: User;

    if (setClauses.length > 0) {
      setClauses.push('updated_at = NOW()');
      values.push(staffId);
      values.push(organizationId);

      const result = await query<User>(
        `UPDATE users SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex++} AND organization_id = $${paramIndex} AND invited_by IS NOT NULL
         RETURNING *`,
        values
      );

      if (result.length === 0) {
        throw new Error('Staff member not found');
      }

      user = result[0];
    } else {
      // Only catalog IDs were updated, fetch user from DB
      const result = await query<User>(
        `SELECT * FROM users WHERE id = $1 AND organization_id = $2 AND invited_by IS NOT NULL`,
        [staffId, organizationId]
      );
      user = result[0];
    }

    // Invalidate cache
    await cacheService.del(CacheKeys.user(staffId));
    await cacheService.del(CacheKeys.userByEmail(user.email));
    await cacheService.del(CacheKeys.sessionVersion(staffId));

    // Get updated catalog IDs
    const catalogIds = user.role === 'user'
      ? await this.getUserCatalogIds(staffId)
      : [];

    logger.info('Staff member updated', { staffId, updates });

    return userToStaffMember(user, catalogIds);
  }

  /**
   * Delete staff member
   */
  async deleteStaff(staffId: string, organizationId: string): Promise<void> {
    const staff = await this.getStaff(staffId, organizationId);
    if (!staff) {
      throw new Error('Staff member not found');
    }

    // Delete from Cognito if configured
    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.deleteUser(staff.email);
      } catch (error: any) {
        // If user not found in Cognito, continue with database deletion
        if (error.name !== 'UserNotFoundException') {
          logger.error('Failed to delete staff from Cognito', { error, staffId });
        }
      }
    }

    // Delete from database
    await query(
      `DELETE FROM users WHERE id = $1 AND organization_id = $2 AND invited_by IS NOT NULL`,
      [staffId, organizationId]
    );

    // Invalidate cache
    await cacheService.del(CacheKeys.user(staffId));
    await cacheService.del(CacheKeys.userByEmail(staff.email));
    await cacheService.del(CacheKeys.sessionVersion(staffId));

    logger.info('Staff member deleted', { staffId, email: staff.email });
  }

  /**
   * Disable all staff for an organization (called when subscription lapses)
   */
  async disableAllStaff(organizationId: string): Promise<number> {
    // Get all staff to invalidate caches
    const staff = await query<User>(
      `SELECT id, email FROM users
       WHERE organization_id = $1 AND invited_by IS NOT NULL AND is_active = true`,
      [organizationId]
    );

    if (staff.length === 0) {
      return 0;
    }

    // Disable all staff and increment session version to force logout
    await query(
      `UPDATE users SET is_active = false, session_version = session_version + 1, updated_at = NOW()
       WHERE organization_id = $1 AND invited_by IS NOT NULL AND is_active = true`,
      [organizationId]
    );

    // Invalidate caches
    for (const user of staff) {
      await cacheService.del(CacheKeys.user(user.id));
      await cacheService.del(CacheKeys.userByEmail(user.email));
      await cacheService.del(CacheKeys.sessionVersion(user.id));
    }

    logger.info('All staff disabled for organization', { organizationId, count: staff.length });

    return staff.length;
  }

  /**
   * Enable all staff for an organization (called when subscription reactivates)
   */
  async enableAllStaff(organizationId: string): Promise<number> {
    // Get all disabled staff
    const staff = await query<User>(
      `SELECT id, email FROM users
       WHERE organization_id = $1 AND invited_by IS NOT NULL AND is_active = false AND invite_accepted_at IS NOT NULL`,
      [organizationId]
    );

    if (staff.length === 0) {
      return 0;
    }

    // Enable all staff (only those who have accepted their invite)
    await query(
      `UPDATE users SET is_active = true, updated_at = NOW()
       WHERE organization_id = $1 AND invited_by IS NOT NULL AND is_active = false AND invite_accepted_at IS NOT NULL`,
      [organizationId]
    );

    // Invalidate caches
    for (const user of staff) {
      await cacheService.del(CacheKeys.user(user.id));
      await cacheService.del(CacheKeys.userByEmail(user.email));
    }

    logger.info('All staff enabled for organization', { organizationId, count: staff.length });

    return staff.length;
  }
}

export const staffService = new StaffService();
