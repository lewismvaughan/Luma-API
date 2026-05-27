/**
 * Client IP resolution — single source of truth for every route + middleware
 * that buckets behaviour by client IP (rate limit keys, fraud-tracking
 * `customer_ip` columns).
 *
 * Threat model
 * ────────────
 * `X-Forwarded-For` is a list that proxies APPEND to. Behind a LoadBalancer /
 * nginx-ingress the on-wire header looks like:
 *
 *   X-Forwarded-For: <client supplied in request>, <real client added by proxy>
 *
 * Reading `XFF.split(',')[0]` therefore returns the **attacker-controlled**
 * value — not the real client. An attacker sets `X-Forwarded-For: 1.1.1.1` on
 * every request, picks a fresh value each time, and fans the rate-limit
 * counter into infinitely many buckets. Login brute-force, signup spam and
 * password-reset floods all become uncapped.
 *
 * Correct resolution depends on **how many proxies are in front of the API**
 * — fixed per deploy:
 *
 *   - Direct (no proxy):              trust the socket, ignore XFF entirely.
 *   - Behind 1 trusted hop (nginx):   real client = XFF[length - 1].
 *   - Behind 2 trusted hops (LB→nginx): real client = XFF[length - 2].
 *
 * Generalised: real client = `XFF[length - TRUSTED_PROXY_HOPS]`, clamped at 0.
 *
 * Env knobs
 * ─────────
 * - `TRUST_PROXY=true` enables proxy-header trust. Default false (local dev).
 *   MUST be true in the k8s deployment (behind nginx-ingress) — otherwise the
 *   socket address is the ingress pod IP and every client collapses into one
 *   shared rate-limit bucket.
 * - `TRUSTED_PROXY_HOPS` (integer ≥1) — number of proxies in front of the API.
 *   Default 1. Ignored when TRUST_PROXY=false.
 *
 * `X-Real-IP` is honoured only in trust-proxy mode AND only if XFF is absent.
 */

import { getConnInfo } from '@hono/node-server/conninfo';

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Clamp to a sane range — TRUSTED_PROXY_HOPS=0 with TRUST_PROXY=true would
// degenerate to "always trust whatever the client sent", the very bypass we
// guard against. Floor at 1.
const TRUSTED_PROXY_HOPS = (() => {
  const raw = parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return raw;
})();

/**
 * Resolve the client IP for the current request. Returns the socket address
 * when not behind a trusted proxy, or counts back `TRUSTED_PROXY_HOPS` from
 * the end of `X-Forwarded-For` when behind one. Returns `'unknown'` only when
 * both proxy headers are absent AND the adapter exposes no remote address.
 */
export function getClientIp(c: any): string {
  if (TRUST_PROXY) {
    const xForwardedFor = c.req.header('x-forwarded-for');
    if (xForwardedFor) {
      const parts = xForwardedFor
        .split(',')
        .map((p: string) => p.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        // Count back TRUSTED_PROXY_HOPS from the end. Clamp at index 0 so a
        // misconfigured hop count that exceeds the chain length falls back to
        // the leftmost value rather than throwing.
        const idx = Math.max(0, parts.length - TRUSTED_PROXY_HOPS);
        return parts[idx];
      }
    }
    const xRealIp = c.req.header('x-real-ip');
    if (xRealIp) return xRealIp.trim();
  }

  // Direct connections OR trust-proxy mode with no proxy headers — fall back
  // to the socket remote address so each client still gets its own bucket.
  try {
    const info = getConnInfo(c);
    const addr = info?.remote?.address;
    if (addr) return addr;
  } catch {
    // getConnInfo is only available on the Node adapter — fall through.
  }

  return 'unknown';
}

/**
 * Convenience for routes that store the IP into a nullable DB column. The
 * literal string `'unknown'` would corrupt fraud/audit queries.
 */
export function getClientIpOrNull(c: any): string | null {
  const ip = getClientIp(c);
  return ip === 'unknown' ? null : ip;
}
