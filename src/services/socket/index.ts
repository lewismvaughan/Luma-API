import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { authService } from '../auth';
import { cacheService, CacheKeys } from '../redis/cache';
import { query } from '../../db';

export interface SocketUser {
  userId: string;
  organizationId: string;
  role: string;
}

export class SocketService {
  private io: SocketIOServer | null = null;
  private connectedUsers: Map<string, SocketUser> = new Map();

  async initialize(server: HTTPServer) {
    this.io = new SocketIOServer(server, {
      path: config.socketio.path,
      cors: {
        origin: config.cors.origin.split(','),
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    // Set up Redis adapter for cross-instance event broadcasting
    try {
      const pubClient = createClient({ url: config.redis.url });
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) => {
        logger.error('Socket.IO Redis pub client error:', err);
      });
      subClient.on('error', (err) => {
        logger.error('Socket.IO Redis sub client error:', err);
      });

      await Promise.all([pubClient.connect(), subClient.connect()]);

      this.io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.IO Redis adapter initialized — cross-instance broadcasting enabled');
    } catch (error) {
      logger.error('Failed to initialize Socket.IO Redis adapter, falling back to in-memory adapter', error);
      // Socket.IO will continue to work with the default in-memory adapter
      // This allows local development without Redis but logs a clear warning
    }

    this.setupMiddleware();
    this.setupEventHandlers();

    logger.info('Socket.IO initialized');
  }

  private setupMiddleware() {
    if (!this.io) return;

    // Public namespace for anonymous event page connections (marketing site)
    const publicNs = this.io.of('/public');
    publicNs.on('connection', (socket) => {
      logger.debug('Public socket connected', { socketId: socket.id });

      socket.on('join', (room: string) => {
        // Only allow joining event-specific, preorder-specific, catalog-specific, or public rooms
        if (room === 'events:public' || room.startsWith('event:') || room.startsWith('preorder:') || room.startsWith('catalog:')) {
          socket.join(room);
          logger.debug('Public socket joined room', { socketId: socket.id, room });
        }
      });

      socket.on('disconnect', () => {
        logger.debug('Public socket disconnected', { socketId: socket.id });
      });
    });

    // Authenticated namespace (default)
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          return next(new Error('Authentication required'));
        }

        const user = await this.validateToken(token);
        if (!user) {
          return next(new Error('Invalid token'));
        }

        socket.data.user = user;
        next();
      } catch (error) {
        logger.error('Socket authentication error', error);
        next(new Error('Authentication failed'));
      }
    });
  }

  private async validateToken(token: string): Promise<SocketUser | null> {
    try {
      const payload = await authService.verifyToken(token);
      return {
        userId: payload.userId,
        organizationId: payload.organizationId,
        role: payload.role,
      };
    } catch (error) {
      logger.debug('Socket token validation failed', { error });
      return null;
    }
  }

  private setupEventHandlers() {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      const user = socket.data.user as SocketUser;
      logger.info('Socket connected', {
        socketId: socket.id,
        userId: user.userId,
        organizationId: user.organizationId,
      });

      // Clean up stale entries for this user (e.g., from a previous connection that didn't disconnect cleanly)
      for (const [existingSocketId, existingUser] of this.connectedUsers.entries()) {
        if (existingUser.userId === user.userId && existingSocketId !== socket.id) {
          this.connectedUsers.delete(existingSocketId);
        }
      }

      this.connectedUsers.set(socket.id, user);

      const orgRoom = `org:${user.organizationId}`;
      const userRoom = `user:${user.userId}`;
      socket.join(orgRoom);
      socket.join(userRoom);

      logger.info('[SOCKET DEBUG] User joined rooms', {
        socketId: socket.id,
        userId: user.userId,
        organizationId: user.organizationId,
        joinedRooms: [orgRoom, userRoom],
      });

      socket.on('join:event', async (eventId: string) => {
        // Only allow joining an event room the caller's org owns — otherwise a
        // logged-in user from org A could subscribe to org B's realtime
        // ticket/order events by supplying B's event UUID (cross-org leak).
        try {
          const rows = await query(
            `SELECT id FROM events WHERE id = $1 AND organization_id = $2`,
            [eventId, user.organizationId]
          );
          if (rows.length === 0) {
            logger.warn('Socket join:event denied (not owner)', { socketId: socket.id, eventId, organizationId: user.organizationId });
            return;
          }
        } catch (error) {
          logger.error('Socket join:event ownership check failed', { error, eventId });
          return;
        }
        socket.join(`event:${eventId}`);
        logger.debug('Socket joined event', { socketId: socket.id, eventId });
      });

      socket.on('leave:event', (eventId: string) => {
        socket.leave(`event:${eventId}`);
        logger.debug('Socket left event', { socketId: socket.id, eventId });
      });

      // Device room support - allows emitting to specific devices. Only join a
      // device room registered to the caller's organization.
      socket.on('join:device', async (deviceId: string) => {
        try {
          const rows = await query<{ tap_to_pay_device_ids: string[] | null }>(
            `SELECT tap_to_pay_device_ids FROM organizations WHERE id = $1`,
            [user.organizationId]
          );
          const ids = rows[0]?.tap_to_pay_device_ids || [];
          if (!Array.isArray(ids) || !ids.includes(deviceId)) {
            logger.warn('Socket join:device denied (not owner)', { socketId: socket.id, deviceId, organizationId: user.organizationId });
            return;
          }
        } catch (error) {
          logger.error('Socket join:device ownership check failed', { error, deviceId });
          return;
        }
        socket.join(`device:${deviceId}`);
        logger.debug('Socket joined device room', { socketId: socket.id, deviceId });
      });

      socket.on('leave:device', (deviceId: string) => {
        socket.leave(`device:${deviceId}`);
        logger.debug('Socket left device room', { socketId: socket.id, deviceId });
      });

      // NOTE: the client-emitted 'order:update' handler was removed — it let a
      // client rebroadcast an arbitrary order/status to any event room with no
      // ownership check or persistence. Order status changes now originate only
      // from authenticated REST handlers, which emit the canonical event.

      socket.on('disconnect', () => {
        this.connectedUsers.delete(socket.id);
        logger.info('Socket disconnected', { socketId: socket.id });
      });
    });
  }

  emitToOrganization(organizationId: string, event: string, data: any) {
    if (!this.io) {
      logger.warn('Socket.IO not initialized, cannot emit to organization', { organizationId, event });
      return;
    }
    const room = `org:${organizationId}`;
    const socketsInRoom = this.io.sockets.adapter.rooms.get(room);
    const socketCount = socketsInRoom?.size || 0;

    // Log all available rooms for debugging
    const allRooms = Array.from(this.io.sockets.adapter.rooms.keys()).filter(r => r.startsWith('org:'));
    logger.info('[SOCKET DEBUG] Available org rooms', { allOrgRooms: allRooms });

    this.io.to(room).emit(event, data);
    logger.info('Emitted to organization', {
      organizationId,
      event,
      room,
      connectedSockets: socketCount,
      roomExists: socketsInRoom !== undefined,
      data
    });

    // If no sockets in room, log this as a warning
    if (socketCount === 0) {
      logger.warn('[SOCKET DEBUG] No connected sockets in target room!', {
        targetRoom: room,
        availableOrgRooms: allRooms,
        totalConnectedUsers: this.connectedUsers.size,
      });
    }

    // Invalidate analytics Redis cache for events that affect revenue data
    if (ANALYTICS_INVALIDATING_EVENTS.has(event)) {
      cacheService.invalidateByPattern(CacheKeys.analyticsPattern(organizationId)).catch(err => {
        logger.error('Failed to invalidate analytics cache', { organizationId, event, error: err });
      });
    }
  }

  emitToEvent(eventId: string, event: string, data: any) {
    if (!this.io) return;
    // Emit to authenticated clients in the event room
    this.io.to(`event:${eventId}`).emit(event, data);
    // And to public-namespace viewers tracking THIS specific event. The former
    // blanket emit to the global 'events:public' room was removed — it fanned
    // every org's event/order updates out to every anonymous connected client.
    this.io.of('/public').to(`event:${eventId}`).emit(event, data);
    logger.debug('Emitted to event', { eventId, event });
  }

  emitToPreorder(preorderId: string, event: string, data: any) {
    if (!this.io) return;
    // Emit to public namespace for customer tracking their preorder
    this.io.of('/public').to(`preorder:${preorderId}`).emit(event, data);
    logger.debug('Emitted to preorder', { preorderId, event });
  }

  emitToCatalog(catalogId: string, event: string, data: any) {
    if (!this.io) return;
    // Emit to public namespace for marketing site menu pages
    this.io.of('/public').to(`catalog:${catalogId}`).emit(event, data);
    logger.debug('Emitted to catalog (public)', { catalogId, event });
  }

  emitToUser(userId: string, event: string, data: any) {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit(event, data);
    logger.debug('Emitted to user', { userId, event });
  }

  emitToDevice(deviceId: string, event: string, data: any) {
    if (!this.io) {
      logger.warn('Socket.IO not initialized, cannot emit to device', { deviceId, event });
      return;
    }
    const room = `device:${deviceId}`;
    const socketsInRoom = this.io.sockets.adapter.rooms.get(room);
    const socketCount = socketsInRoom?.size || 0;

    this.io.to(room).emit(event, data);
    logger.info('Emitted to device', {
      deviceId,
      event,
      room,
      connectedSockets: socketCount,
      data
    });
  }

  broadcast(event: string, data: any) {
    if (!this.io) return;
    this.io.emit(event, data);
    logger.debug('Broadcast event', { event });
  }

  getConnectedUsers(): SocketUser[] {
    return Array.from(this.connectedUsers.values());
  }

  getConnectedUsersCount(): number {
    return this.connectedUsers.size;
  }

  async disconnectUser(userId: string) {
    if (!this.io) return;

    const sockets = await this.io.fetchSockets();
    for (const socket of sockets) {
      const user = socket.data.user as SocketUser;
      if (user && user.userId === userId) {
        socket.disconnect(true);
      }
    }
  }

  /** Close the Socket.IO server (and its Redis adapter clients) on shutdown. */
  async close(): Promise<void> {
    if (!this.io) return;
    await new Promise<void>((resolve) => {
      this.io!.close(() => resolve());
    });
    this.io = null;
  }
}

export const socketService = new SocketService();

// Events that affect analytics data — triggers Redis analytics cache invalidation
const ANALYTICS_INVALIDATING_EVENTS = new Set([
  'order:created',
  'order:completed',
  'order:refunded',
  'order:deleted',
  'payment:received',
  'revenue:update',
  'ticket:purchased',
  'ticket:refunded',
  'preorder:created',
  'preorder:completed',
  'preorder:cancelled',
  'invoice:paid',
  'invoice:updated',
  'invoice:voided',
  'terminal:payment_succeeded',
]);

export const SocketEvents = {
  // Order events
  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_COMPLETED: 'order:completed',
  ORDER_FAILED: 'order:failed',
  ORDER_REFUNDED: 'order:refunded',
  ORDER_DELETED: 'order:deleted',
  // Payment events
  PAYMENT_RECEIVED: 'payment:received',
  REVENUE_UPDATE: 'revenue:update',
  TIP_UPDATED: 'tip:updated',
  // Stripe Connect events
  CONNECT_STATUS_UPDATED: 'connect:status_updated',
  // Subscription events
  SUBSCRIPTION_UPDATED: 'subscription:updated',
  // User events
  USER_UPDATED: 'user:updated',
  // Session events
  SESSION_KICKED: 'session:kicked', // Emitted when user logs in on another device
  // Organization events
  ORGANIZATION_UPDATED: 'organization:updated',
  // Catalog events
  CATALOG_UPDATED: 'catalog:updated',
  CATALOG_CREATED: 'catalog:created',
  CATALOG_DELETED: 'catalog:deleted',
  // Product events
  PRODUCT_UPDATED: 'product:updated',
  PRODUCT_CREATED: 'product:created',
  PRODUCT_DELETED: 'product:deleted',
  // Category events
  CATEGORY_UPDATED: 'category:updated',
  CATEGORY_CREATED: 'category:created',
  CATEGORY_DELETED: 'category:deleted',
  CATEGORIES_REORDERED: 'categories:reordered',
  // Event events
  EVENT_CREATED: 'event:created',
  EVENT_UPDATED: 'event:updated',
  EVENT_DELETED: 'event:deleted',
  // Ticket events
  TICKET_PURCHASED: 'ticket:purchased',
  TICKET_SCANNED: 'ticket:scanned',
  TICKET_REFUNDED: 'ticket:refunded',
  // Preorder events
  PREORDER_CREATED: 'preorder:created',
  PREORDER_UPDATED: 'preorder:updated',
  PREORDER_READY: 'preorder:ready',
  PREORDER_COMPLETED: 'preorder:completed',
  PREORDER_CANCELLED: 'preorder:cancelled',
  // Invoice events
  INVOICE_CREATED: 'invoice:created',
  INVOICE_UPDATED: 'invoice:updated',
  INVOICE_SENT: 'invoice:sent',
  INVOICE_PAID: 'invoice:paid',
  INVOICE_PAYMENT_FAILED: 'invoice:payment_failed',
  INVOICE_VOIDED: 'invoice:voided',
  INVOICE_OVERDUE: 'invoice:overdue',
  // Dispute events
  DISPUTE_CREATED: 'dispute:created',
  DISPUTE_UPDATED: 'dispute:updated',
  DISPUTE_CLOSED: 'dispute:closed',
  // Terminal reader events
  TERMINAL_PAYMENT_SUCCEEDED: 'terminal:payment_succeeded',
  TERMINAL_PAYMENT_FAILED: 'terminal:payment_failed',
  // Referral events
  REFERRAL_CREATED: 'referral:created',
  REFERRAL_ACTIVATED: 'referral:activated',
  REFERRAL_EARNING: 'referral:earning',
  REFERRAL_PAYOUT: 'referral:payout',
  REFERRAL_CLAWBACK: 'referral:clawback',
} as const;
