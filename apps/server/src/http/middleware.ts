/**
 * HTTP cross-cutting concerns: request ids, bearer authentication, the CSRF header for cookie
 * endpoints, and rate limits (API_DESIGN §1, §10; ARCHITECTURE §17).
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { CSRF_HEADER, ERROR_MESSAGES } from '@studysync/shared';
import { AppError } from '../lib/errors';
import type { TokenService } from '../modules/auth/tokens';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** `Authorization: Bearer <access token>` → `res.locals.userId`. */
export function requireAuth(tokens: TokenService): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._-]{1,4096})$/.exec(header);
    if (!match?.[1]) throw new AppError('UNAUTHENTICATED');
    res.locals.userId = tokens.verifyAccess(match[1]).userId;
    next();
  };
}

export function userIdOf(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== 'string') throw new AppError('UNAUTHENTICATED');
  return userId;
}

/** Cookie-authenticated endpoints require `X-StudySync-CSRF: 1` (plus SameSite=Strict). */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (req.get(CSRF_HEADER) !== '1') throw new AppError('CSRF_REQUIRED');
  next();
}

export interface HttpRateLimits {
  loginPerIp: number;
  loginPerIpEmail: number;
  registerPerIpHour: number;
  refreshPerIp: number;
  readsPerUser: number;
  joinPerUserMinute: number;
  joinPerUserHour: number;
  joinPerIpHour: number;
}

export const DEFAULT_HTTP_RATE_LIMITS: HttpRateLimits = {
  loginPerIp: 20,
  loginPerIpEmail: 5,
  registerPerIpHour: 5,
  refreshPerIp: 30,
  readsPerUser: 300,
  joinPerUserMinute: 10,
  joinPerUserHour: 30,
  joinPerIpHour: 60,
};

/** Generous limits for automated test runs only (NODE_ENV=test + RELAX_RATE_LIMITS=true). */
export const RELAXED_HTTP_RATE_LIMITS: HttpRateLimits = {
  loginPerIp: 10_000,
  loginPerIpEmail: 10_000,
  registerPerIpHour: 10_000,
  refreshPerIp: 10_000,
  readsPerUser: 100_000,
  joinPerUserMinute: 10_000,
  joinPerUserHour: 10_000,
  joinPerIpHour: 10_000,
};

const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

export function limiter(options: {
  windowMs: number;
  limit: number;
  key: (req: Request, res: Response) => string;
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: options.key,
    handler: (_req, res, _next, opts) => {
      const retryAfterSec = Math.ceil(opts.windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: ERROR_MESSAGES.RATE_LIMITED,
          details: { retryAfterMs: retryAfterSec * 1000 },
          requestId: res.locals.requestId as string | undefined,
        },
      });
    },
  });
}

export const byIp = (req: Request): string => ipKey(req);
export const byIpAndEmail = (req: Request): string => {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return `${ipKey(req)}|${email}`;
};
export const byUser = (_req: Request, res: Response): string =>
  typeof res.locals.userId === 'string' ? res.locals.userId : 'anonymous';
