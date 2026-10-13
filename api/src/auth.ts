/**
 * Admin authentication: a single username/password from .env exchanged for a 12 h JWT.
 * - `signToken` / `verifyToken` for REST login
 * - `requireAdmin` Fastify preHandler (Authorization: Bearer <jwt>)
 * - `verifySocketAuth` for the socket.io `/admin` namespace handshake
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface AdminClaims {
  sub: string;
  role: 'admin';
  iat: number;
  exp: number;
}

export interface SignedToken {
  token: string;
  expiresAt: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Check a login attempt against ADMIN_USERNAME / ADMIN_PASSWORD. */
export function checkCredentials(username: string, password: string): boolean {
  const c = config();
  return safeEqual(username, c.ADMIN_USERNAME) && safeEqual(password, c.ADMIN_PASSWORD);
}

/** Issue a 12 h admin token for `username`. */
export function signToken(username: string): SignedToken {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ sub: username, role: 'admin', iat: now }, config().JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SECONDS,
  });
  return { token, expiresAt: new Date((now + TOKEN_TTL_SECONDS) * 1000).toISOString() };
}

/** Verify a token; returns the claims or null when missing/invalid/expired. */
export function verifyToken(token: string | undefined | null): AdminClaims | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, config().JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null) return null;
    const claims = decoded as Partial<AdminClaims>;
    if (claims.role !== 'admin' || typeof claims.sub !== 'string') return null;
    return claims as AdminClaims;
  } catch {
    return null;
  }
}

/** Extract the bearer token from an Authorization header value. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAdmin` once the bearer token has been verified. */
    admin?: AdminClaims;
  }
}

/** Fastify preHandler: rejects with 401 unless a valid admin bearer token is present. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const claims = verifyToken(bearerToken(request.headers.authorization));
  if (!claims) {
    reply.code(401).send({ error: 'Unauthorized', code: 'unauthorized' });
    return reply;
  }
  request.admin = claims;
}

/**
 * Verify the `auth` object of a socket.io handshake (`io('/admin', { auth: { token } })`).
 * Returns the claims or null.
 */
export function verifySocketAuth(auth: unknown): AdminClaims | null {
  if (!auth || typeof auth !== 'object') return null;
  const token = (auth as { token?: unknown }).token;
  return typeof token === 'string' ? verifyToken(token) : null;
}
