import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { query } from '../../db';
import { User } from '../../db/models';
import { cacheService, CacheKeys } from '../redis/cache';
import { cognitoService } from './cognito';
import { normalizeEmail } from '../../utils/email';
import { socketService, SocketEvents } from '../socket';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface JWTPayload {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
  sessionId?: string;
  type: 'access' | 'refresh';
}

export class AuthService {

  async register(params: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    organizationId: string;
    role?: string;
  }): Promise<User> {
    const existingUser = await this.getUserByEmail(params.email);
    if (existingUser) {
      throw new Error('User already exists');
    }

    const passwordHash = await bcrypt.hash(params.password, 10);

    const userResult = await query<User>(
      `INSERT INTO users (
        email, password_hash, first_name, last_name,
        organization_id, role, email_alerts, marketing_emails, weekly_reports
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        params.email,
        passwordHash,
        params.firstName,
        params.lastName,
        params.organizationId,
        params.role || 'bartender',
        true, // email_alerts
        true, // marketing_emails
        true  // weekly_reports
      ]
    );

    const user = userResult[0];

    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.createUser({
          email: params.email,
          temporaryPassword: params.password,
          attributes: {
            'given_name': params.firstName || '',
            'family_name': params.lastName || '',
          },
        });

        await cognitoService.addUserToGroup(params.email, user.role);
        await cognitoService.setUserPassword(params.email, params.password, true);
      } catch (error) {
        logger.error('Failed to create Cognito user, rolling back', error);
        await query('DELETE FROM users WHERE id = $1', [user.id]);
        throw error;
      }
    }

    await cacheService.set(CacheKeys.user(user.id), user, { ttl: 3600 });
    await cacheService.set(CacheKeys.userByEmail(user.email), user, { ttl: 3600 });

    logger.info('User registered', { userId: user.id, email: user.email });
    return user;
  }

  async login(email: string, password: string, source: 'app' | 'web' = 'web'): Promise<AuthTokens & { sessionVersion: number }> {
    const user = await this.getUserByEmail(email);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // If account has pending deletion, cancel the deletion and reactivate on login
    if (!user.is_active && user.deletion_requested_at) {
      await query(
        `UPDATE users SET is_active = true, deletion_requested_at = NULL, deletion_reminder_sent = false, updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      await cacheService.del(CacheKeys.user(user.id));
      await cacheService.del(CacheKeys.userByEmail(user.email));
      logger.info('Account deletion canceled via login', { userId: user.id, email: user.email });
    } else if (!user.is_active) {
      throw new Error('Invalid credentials');
    }

    if (config.aws.cognito.userPoolId) {
      try {
        const cognitoAuth = await cognitoService.authenticateUser(email, password);

        if (cognitoAuth.challengeName === 'NEW_PASSWORD_REQUIRED') {
          throw new Error('Password change required');
        }

        let newSessionVersion: number;

        // Single session enforcement - ONLY for app logins
        // Vendor portal (web) can have multiple sessions without kicking others
        if (source === 'app') {
          // 1. Notify existing APP sessions they're being kicked (via Socket.IO)
          socketService.emitToUser(user.id, SocketEvents.SESSION_KICKED, {
            reason: 'logged_in_elsewhere',
            message: 'You have been signed out because your account was signed in on another device.',
            timestamp: new Date().toISOString(),
            source: 'app', // Include source so clients can filter
          });

          // 2. Increment session version to invalidate old app tokens on API calls
          newSessionVersion = await this.incrementSessionVersion(user.id);

          // 3. Store new session version in Redis for fast auth middleware checks
          await cacheService.set(
            CacheKeys.sessionVersion(user.id),
            newSessionVersion,
            { ttl: 86400 * 7 } // 7 days
          );

          logger.info('App login - session version incremented, old sessions kicked', {
            userId: user.id,
            sessionVersion: newSessionVersion,
          });
        } else {
          // Web login - don't increment session version, allow multiple sessions
          newSessionVersion = await this.getSessionVersion(user.id);
          logger.info('Web login - no session kicking', {
            userId: user.id,
            sessionVersion: newSessionVersion,
          });
        }

        // Update last login and invalidate user cache
        await this.updateLastLogin(user.id);
        await cacheService.del(CacheKeys.user(user.id));
        await cacheService.del(CacheKeys.userByEmail(user.email));

        return {
          accessToken: cognitoAuth.idToken!,
          refreshToken: cognitoAuth.refreshToken!,
          expiresIn: cognitoAuth.expiresIn!,
          sessionVersion: newSessionVersion,
        };
      } catch (error: any) {
        if (error.name === 'NotAuthorizedException') {
          throw new Error('Invalid credentials');
        }
        throw error;
      }
    }

    if (!user.password_hash) {
      throw new Error('Password not set');
    }

    throw new Error('Local authentication not supported. Please use Cognito.');
  }

  private async incrementSessionVersion(userId: string): Promise<number> {
    const result = await query<{ session_version: number; email: string }>(
      `UPDATE users
       SET session_version = session_version + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING session_version, email`,
      [userId]
    );
    // Invalidate user cache immediately to prevent concurrent requests
    // from reading stale session_version between here and the later invalidation in login()
    await cacheService.del(CacheKeys.user(userId));
    await cacheService.del(CacheKeys.userByEmail(result[0].email));
    return result[0].session_version;
  }

  async getSessionVersion(userId: string): Promise<number> {
    // Try Redis cache first
    const cached = await cacheService.get<number>(CacheKeys.sessionVersion(userId));
    if (cached !== null) {
      return cached;
    }

    // Fall back to database
    const result = await query<{ session_version: number }>(
      `SELECT session_version FROM users WHERE id = $1`,
      [userId]
    );

    if (result.length === 0) {
      return 0;
    }

    const version = result[0].session_version;

    // Cache for future lookups
    await cacheService.set(
      CacheKeys.sessionVersion(userId),
      version,
      { ttl: 86400 * 7 }
    );

    return version;
  }

  async generateTokens(_user: User): Promise<AuthTokens> {
    throw new Error('Local token generation not supported. Please use Cognito.');
  }

  async refreshTokens(refreshToken: string, username?: string): Promise<AuthTokens> {
    logger.info('AuthService.refreshTokens called', {
      hasRefreshToken: !!refreshToken,
      hasUsername: !!username,
      username
    });
    
    if (config.aws.cognito.userPoolId) {
      try {
        logger.info('Calling cognitoService.refreshTokens...');
        const cognitoAuth = await cognitoService.refreshTokens(refreshToken, username);
        
        logger.info('Cognito refresh successful', {
          hasIdToken: !!cognitoAuth.idToken,
          hasAccessToken: !!cognitoAuth.accessToken,
          expiresIn: cognitoAuth.expiresIn
        });
        
        return {
          accessToken: cognitoAuth.idToken!,
          refreshToken: refreshToken,
          expiresIn: cognitoAuth.expiresIn!,
        };
      } catch (error: any) {
        logger.error('Failed to refresh Cognito tokens', {
          error: error.message || error,
          errorName: error.name,
          stack: error.stack
        });
        throw new Error('Invalid refresh token');
      }
    }

    throw new Error('Local token refresh not supported. Please use Cognito.');
  }

  async verifyToken(token: string): Promise<JWTPayload> {
    if (config.aws.cognito.userPoolId) {
      try {
        const cognitoPayload = await cognitoService.verifyIdToken(token);
        
        // Get user data from database
        const user = await this.getUserByEmail(cognitoPayload.email);
        if (!user) {
          throw new Error('User not found');
        }

        // Reject deactivated/disabled accounts on every request. Without this a
        // user whose access was revoked (staff disabled, subscription lapse,
        // pending account deletion) keeps full API access until their Cognito
        // token expires. This is the central gate for all routes, which each
        // call verifyToken via their own verifyAuth helper.
        if (user.is_active === false) {
          throw new Error('Account is not active');
        }

        return {
          userId: user.id,
          email: cognitoPayload.email,
          organizationId: user.organization_id,
          role: user.role,
          type: 'access',
        };
      } catch (error) {
        logger.error('Failed to verify Cognito token', error);
        throw new Error('Invalid token');
      }
    }

    throw new Error('Local token verification not supported. Please use Cognito.');
  }

  async logout(refreshToken: string): Promise<void> {
    await query(
      `DELETE FROM sessions WHERE refresh_token = $1`,
      [refreshToken]
    );

    logger.info('User logged out');
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.authenticateUser(user.email, currentPassword);
        await cognitoService.setUserPassword(user.email, newPassword, true);
      } catch (error: any) {
        if (error.name === 'NotAuthorizedException') {
          throw new Error('Current password is incorrect');
        }
        throw error;
      }
    } else if (user.password_hash) {
      const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isValidPassword) {
        throw new Error('Current password is incorrect');
      }
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newPasswordHash, userId]
    );

    await query(
      `DELETE FROM sessions WHERE user_id = $1`,
      [userId]
    );

    // Invalidate user cache
    await cacheService.del(CacheKeys.user(userId));
    if (user.email) {
      await cacheService.del(CacheKeys.userByEmail(user.email));
    }

    logger.info('Password changed', { userId });
  }

  async setNewPassword(userId: string, newPassword: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.setUserPassword(user.email, newPassword, true);
      } catch (error: any) {
        if (error.name === 'UserNotFoundException') {
          // User exists in DB but not in Cognito (e.g. seeded account) — create them
          logger.info('Cognito user not found during password reset, creating user', { userId, email: user.email });
          const cognitoUser = await cognitoService.createUser({
            email: user.email,
            temporaryPassword: newPassword,
            messageAction: 'SUPPRESS',
          });
          await cognitoService.setUserPassword(user.email, newPassword, true);
          // Link the Cognito user to the DB record
          await query(
            `UPDATE users SET cognito_user_id = $1 WHERE id = $2`,
            [cognitoUser.username, userId]
          );
        } else {
          logger.error('Failed to set user password in Cognito', error);
          throw error;
        }
      }
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newPasswordHash, userId]
    );

    // Invalidate user cache
    await cacheService.del(CacheKeys.user(userId));
    if (user.email) {
      await cacheService.del(CacheKeys.userByEmail(user.email));
    }

    logger.info('Password set for user', { userId });
  }

  async getUserById(userId: string): Promise<User | null> {
    const cached = await cacheService.get<User>(CacheKeys.user(userId));
    if (cached) {
      return cached;
    }

    const result = await query<User>(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    if (result.length === 0) {
      return null;
    }

    const user = result[0];
    await cacheService.set(CacheKeys.user(userId), user, { ttl: 3600 });

    return user;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const normalized = normalizeEmail(email);
    
    logger.info('Checking for user by email', { 
      originalEmail: email,
      normalizedEmail: normalized 
    });
    
    const cached = await cacheService.get<User>(CacheKeys.userByEmail(normalized));
    if (cached) {
      logger.info('User found in cache', { email: normalized, userId: cached.id });
      return cached;
    }

    const result = await query<User>(
      `SELECT * FROM users WHERE email = $1`,
      [normalized]
    );
    
    logger.info('Database query result', { 
      email: normalized,
      found: result.length > 0,
      resultCount: result.length 
    });

    if (result.length === 0) {
      return null;
    }

    const user = result[0];
    await cacheService.set(CacheKeys.userByEmail(normalized), user, { ttl: 3600 });

    return user;
  }

  async isEmailInUse(email: string): Promise<boolean> {
    const normalized = normalizeEmail(email);
    
    // Check local database first
    const user = await this.getUserByEmail(normalized);
    if (user) {
      return true;
    }

    // Check Cognito if configured
    if (config.aws.cognito.userPoolId) {
      try {
        // Use filter to search for the email
        const cognitoUser = await cognitoService.getUser(normalized);
        return cognitoUser !== null;
      } catch (error: any) {
        // If user not found, that's what we expect
        if (error.name === 'UserNotFoundException') {
          return false;
        }
        logger.error('Failed to check email in Cognito', error);
        // Fall back to database check only
      }
    }

    return false;
  }

  private async updateLastLogin(userId: string): Promise<void> {
    await query(
      `UPDATE users SET last_login = NOW() WHERE id = $1`,
      [userId]
    );
    // CLAUDE.md mandates invalidating BOTH user cache keys on every users
    // update. last_login feeds /auth/me, so a stale value would persist 1h.
    const u = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
    await cacheService.del(CacheKeys.user(userId));
    if (u[0]?.email) await cacheService.del(CacheKeys.userByEmail(u[0].email));
  }

  async createPasswordResetToken(email: string): Promise<string | null> {
    const normalized = normalizeEmail(email);
    const user = await this.getUserByEmail(normalized);
    
    if (!user) {
      logger.info('Password reset requested for non-existent email', { email: normalized });
      return null;
    }

    // Generate a secure random token. The RAW token is what we email; only its
    // SHA-256 hash is stored, and lookups are by hash — so the secret never
    // lives in the DB or logs. (Previously the row's UUID id was emailed/used,
    // which is logged and is the primary key, not a secret.)
    const tokenId = crypto.randomUUID();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Token expires in 10 minutes
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);

    // Store hashed token in database
    await query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenId, user.id, tokenHash, expiresAt]
    );

    logger.info('Password reset token created', {
      userId: user.id,
      email: normalized,
      tokenId, // internal PK only — NOT the emailed secret
      expiresAt,
    });

    // Return the raw secret token (emailed to the user); never logged.
    return rawToken;
  }

  async validatePasswordResetToken(rawToken: string): Promise<User | null> {
    try {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      // Find the token by its hash (constant lookup; the raw secret is never stored)
      const tokenResult = await query<any>(
        `SELECT prt.*, u.*
         FROM password_reset_tokens prt
         JOIN users u ON prt.user_id = u.id
         WHERE prt.token_hash = $1
           AND prt.used_at IS NULL
           AND prt.expires_at > NOW()`,
        [tokenHash]
      );

      if (tokenResult.length === 0) {
        logger.warn('Invalid or expired password reset token');
        return null;
      }

      const user = {
        id: tokenResult[0].user_id,
        email: tokenResult[0].email,
        first_name: tokenResult[0].first_name,
        last_name: tokenResult[0].last_name,
        organization_id: tokenResult[0].organization_id,
        role: tokenResult[0].role,
        is_active: tokenResult[0].is_active,
        password_hash: tokenResult[0].password_hash,
        phone: tokenResult[0].phone,
        created_at: tokenResult[0].created_at,
        updated_at: tokenResult[0].updated_at,
        last_login: tokenResult[0].last_login
      } as User;

      return user;
    } catch (error) {
      logger.error('Failed to validate password reset token', { error });
      return null;
    }
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<boolean> {
    try {
      // Validate token and get user
      const user = await this.validatePasswordResetToken(rawToken);

      if (!user) {
        return false;
      }

      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      // Set the new password
      await this.setNewPassword(user.id, newPassword);

      // Mark this token as used (by hash)
      await query(
        `UPDATE password_reset_tokens
         SET used_at = NOW()
         WHERE token_hash = $1`,
        [tokenHash]
      );

      // Invalidate all other outstanding reset tokens for this user
      await query(
        `UPDATE password_reset_tokens
         SET used_at = NOW()
         WHERE user_id = $1 AND token_hash != $2 AND used_at IS NULL`,
        [user.id, tokenHash]
      );

      logger.info('Password reset successful', { userId: user.id });
      return true;
    } catch (error) {
      logger.error('Failed to reset password', { error });
      return false;
    }
  }
}

export const authService = new AuthService();