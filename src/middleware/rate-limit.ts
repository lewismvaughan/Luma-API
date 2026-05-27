import { MiddlewareHandler } from 'hono';
import { redisService } from '../services/redis';
import { logger } from '../utils/logger';
import { getClientIp } from '../utils/client-ip';

const RATE_LIMIT_PREFIX = 'luma:ratelimit:';

interface RateLimitOptions {
  /** Max number of requests allowed in the window */
  max: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Key prefix to namespace different limiters */
  keyPrefix: string;
  /** Custom key extractor (defaults to client IP) */
  keyExtractor?: (c: any) => string;
}

// Client-IP resolution lives in `utils/client-ip.ts` (TRUST_PROXY-aware) so
// X-Forwarded-For spoofing can't fan the rate-limit counter into unlimited
// buckets. The same helper backs any route that records a client IP.

/**
 * Redis-based rate limiting middleware using fixed window counters.
 * Uses INCR + EXPIRE for atomic, race-condition-free counting.
 */
export const rateLimit = (options: RateLimitOptions): MiddlewareHandler => {
  return async (c, next) => {
    const identifier = options.keyExtractor
      ? options.keyExtractor(c)
      : getClientIp(c);

    const key = `${RATE_LIMIT_PREFIX}${options.keyPrefix}:${identifier}`;

    try {
      const count = await redisService.incr(key);

      if (count === null) {
        // Redis error — fail open so legitimate requests aren't blocked
        logger.warn('Rate limit: Redis INCR failed, allowing request', { key });
        return await next();
      }

      // Set expiry on first request in the window
      if (count === 1) {
        await redisService.expire(key, options.windowSeconds);
      }

      // Set rate limit headers
      c.header('X-RateLimit-Limit', String(options.max));
      c.header('X-RateLimit-Remaining', String(Math.max(0, options.max - count)));

      if (count > options.max) {
        const ttl = await redisService.ttl(key);
        c.header('Retry-After', String(ttl > 0 ? ttl : options.windowSeconds));

        logger.warn('Rate limit exceeded', {
          key: options.keyPrefix,
          identifier,
          count,
          max: options.max,
          path: c.req.path,
        });

        return c.json(
          { error: 'Too many requests. Please try again later.' },
          429
        );
      }
    } catch (error) {
      // Fail open on unexpected errors
      logger.error('Rate limit middleware error', { error, key });
    }

    return await next();
  };
};

/**
 * Session-scoped rate limit: a tight per-(IP, sessionId) cap PLUS a loose
 * per-IP backstop. For public customer-facing endpoints (preorders, menu)
 * where many unrelated customers sit behind one CGNAT/venue-WiFi IP.
 *
 *   - Tight bucket keys on `${ip}:${sid}` so each customer device gets its own
 *     budget regardless of how many siblings share the WAN address. The ip
 *     prefix stops an attacker squatting a sid across IPs to exhaust someone.
 *   - Loose bucket (`maxPerIp`) is a flood ceiling — even on a CGNAT egress no
 *     single source IP exceeds it. Sized ~10–30× the per-session cap.
 *   - Missing sid (legacy clients) collapses both buckets to the IP key — i.e.
 *     the old IP-only behaviour, no regression.
 */
interface SessionScopedRateLimitOptions {
  maxPerSession: number;
  maxPerIp: number;
  windowSeconds: number;
  keyPrefix: string;
}
export const sessionScopedRateLimit = (
  options: SessionScopedRateLimitOptions
): MiddlewareHandler => {
  return async (c, next) => {
    const ip = getClientIp(c);
    const sidRaw =
      c.req.header('X-Session-Id') ||
      c.req.header('x-session-id') ||
      c.req.query('sessionId') ||
      '';
    const sid = sidRaw.trim().slice(0, 64); // bound length so a giant header can't blow the key
    const sessionKey = sid
      ? `${RATE_LIMIT_PREFIX}${options.keyPrefix}:s:${ip}:${sid}`
      : null;
    const ipKey = `${RATE_LIMIT_PREFIX}${options.keyPrefix}:i:${ip}`;

    try {
      // Per-IP backstop FIRST — short-circuits a flood before we touch the
      // session bucket so an attacker can't mint unlimited sids to inflate
      // Redis memory.
      const ipCount = await redisService.incr(ipKey);
      if (ipCount === null) {
        logger.warn('Rate limit: Redis INCR failed (ip), allowing', { ipKey });
        return await next();
      }
      if (ipCount === 1) {
        await redisService.expire(ipKey, options.windowSeconds);
      }
      if (ipCount > options.maxPerIp) {
        const ttl = await redisService.ttl(ipKey);
        c.header('Retry-After', String(ttl > 0 ? ttl : options.windowSeconds));
        c.header('X-RateLimit-Limit', String(options.maxPerIp));
        c.header('X-RateLimit-Remaining', '0');
        logger.warn('Rate limit exceeded (ip backstop)', {
          key: options.keyPrefix,
          ip,
          ipCount,
          maxPerIp: options.maxPerIp,
          path: c.req.path,
        });
        return c.json(
          { error: 'Too many requests from this network. Please try again later.' },
          429
        );
      }

      // Per-session cap — primary check for individual abuse.
      if (sessionKey) {
        const sessionCount = await redisService.incr(sessionKey);
        if (sessionCount === null) {
          logger.warn('Rate limit: Redis INCR failed (session), allowing', { sessionKey });
          return await next();
        }
        if (sessionCount === 1) {
          await redisService.expire(sessionKey, options.windowSeconds);
        }
        c.header('X-RateLimit-Limit', String(options.maxPerSession));
        c.header(
          'X-RateLimit-Remaining',
          String(Math.max(0, options.maxPerSession - sessionCount))
        );
        if (sessionCount > options.maxPerSession) {
          const ttl = await redisService.ttl(sessionKey);
          c.header('Retry-After', String(ttl > 0 ? ttl : options.windowSeconds));
          logger.warn('Rate limit exceeded (per session)', {
            key: options.keyPrefix,
            ip,
            sid,
            sessionCount,
            maxPerSession: options.maxPerSession,
            path: c.req.path,
          });
          return c.json(
            { error: 'Too many requests for this session. Please try again later.' },
            429
          );
        }
      } else {
        c.header('X-RateLimit-Limit', String(options.maxPerIp));
        c.header('X-RateLimit-Remaining', String(Math.max(0, options.maxPerIp - ipCount)));
      }
    } catch (error) {
      logger.error('sessionScopedRateLimit error', { error, keyPrefix: options.keyPrefix });
      // Fail open
    }

    return await next();
  };
};

// ── Pre-configured limiters for auth endpoints ──

/**
 * Login limiter — two-bucket strategy. An IP-only key locks out a whole shop
 * on shared WiFi when one staffer mistypes their password. We split it:
 *   - Per-(IP, email): 10 attempts / 15 min — the real anti-bruteforce; one
 *     typo-prone user can't lock anyone else out.
 *   - Per-IP backstop: 60 attempts / 15 min — flood ceiling even if an
 *     attacker rotates through many emails from one IP.
 * Hono caches `req.json()`, so the route handler reading the body again gets
 * the same object — no double-parse. Missing/invalid email collapses to the
 * IP backstop only.
 */
export const loginRateLimit: MiddlewareHandler = async (c, next) => {
  const ip = getClientIp(c);
  const ipKey = `${RATE_LIMIT_PREFIX}login:i:${ip}`;
  try {
    const ipCount = await redisService.incr(ipKey);
    if (ipCount === null) {
      logger.warn('Login rate limit: Redis INCR failed (ip), allowing', { ipKey });
      return await next();
    }
    if (ipCount === 1) {
      await redisService.expire(ipKey, 15 * 60);
    }
    if (ipCount > 60) {
      const ttl = await redisService.ttl(ipKey);
      c.header('Retry-After', String(ttl > 0 ? ttl : 15 * 60));
      logger.warn('Login rate limit exceeded (ip backstop)', { ip, ipCount, path: c.req.path });
      return c.json({ error: 'Too many login attempts from this network. Please try again later.' }, 429);
    }

    // Per-account bucket. A malformed body should still pass through so the
    // route returns a proper 400, not a 429.
    let email = '';
    try {
      const body = await c.req.json();
      email = String(body?.email || '').trim().toLowerCase();
    } catch {
      // No JSON body → only the IP backstop applied above.
    }
    if (email) {
      const acctKey = `${RATE_LIMIT_PREFIX}login:a:${ip}:${email}`;
      const acctCount = await redisService.incr(acctKey);
      if (acctCount === null) {
        logger.warn('Login rate limit: Redis INCR failed (acct), allowing', { acctKey });
        return await next();
      }
      if (acctCount === 1) {
        await redisService.expire(acctKey, 15 * 60);
      }
      c.header('X-RateLimit-Limit', '10');
      c.header('X-RateLimit-Remaining', String(Math.max(0, 10 - acctCount)));
      if (acctCount > 10) {
        const ttl = await redisService.ttl(acctKey);
        c.header('Retry-After', String(ttl > 0 ? ttl : 15 * 60));
        logger.warn('Login rate limit exceeded (per-account)', { ip, email, acctCount, path: c.req.path });
        return c.json({ error: 'Too many failed login attempts for this account. Please try again later.' }, 429);
      }
    }
  } catch (error) {
    logger.error('loginRateLimit error', { error });
    // Fail open
  }
  return await next();
};

/** Signup: 5 attempts per 15 minutes per IP */
export const signupRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'signup',
});

/** Forgot password: 5 attempts per 15 minutes per IP */
export const forgotPasswordRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'forgot-password',
});

/** Password reset: 5 attempts per 15 minutes per IP */
export const resetPasswordRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'reset-password',
});

/** Email/password check: 20 attempts per 15 minutes per IP */
export const checkRateLimit = rateLimit({
  max: 20,
  windowSeconds: 15 * 60,
  keyPrefix: 'check',
});

/** Contact form: 5 submissions per 15 minutes per IP */
export const contactRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'contact',
});

/**
 * Public preorder creation (`POST /menu/public/{slug}/preorder`). Customer-
 * facing and unauthenticated, so it must tolerate CGNAT — a single venue-WiFi
 * or mobile-carrier IP can mask hundreds of unrelated customers ordering at a
 * busy event. The per-session cap is the real per-customer limit; the per-IP
 * backstop is a flood ceiling sized for a packed QR-table rush.
 */
export const publicPreorderRateLimit = sessionScopedRateLimit({
  maxPerSession: 10,
  maxPerIp: 300,
  windowSeconds: 15 * 60,
  keyPrefix: 'public-preorder',
});
