import { Router, type Request, type Response } from 'express';
import { REFRESH_COOKIE, loginSchema, registerSchema, type AuthResponse } from '@studysync/shared';
import type { Env } from '../../config/env';
import { toIso } from '../../lib/time';
import { parseOrThrow } from '../../lib/validate';
import {
  byIp,
  byIpAndEmail,
  limiter,
  requireCsrf,
  type HttpRateLimits,
} from '../../http/middleware';
import type { AuthService, IssuedTokens } from './authService';

const MINUTE = 60_000;
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function authRoutes(deps: { env: Env; auth: AuthService; limits: HttpRateLimits }): Router {
  const { env, auth, limits } = deps;
  const router = Router();

  const setRefreshCookie = (res: Response, tokens: IssuedTokens): void => {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: new Date(tokens.refreshTokenExpiresAt),
    });
  };
  const clearRefreshCookie = (res: Response): void => {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  };
  const body = (tokens: IssuedTokens): AuthResponse => ({
    user: tokens.user,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: toIso(tokens.accessTokenExpiresAt),
  });
  const cookieOf = (req: Request): string | undefined => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length <= 200 ? value : undefined;
  };

  router.post(
    '/register',
    limiter({ windowMs: 60 * MINUTE, limit: limits.registerPerIpHour, key: byIp }),
    async (req, res) => {
      const input = parseOrThrow(registerSchema, req.body);
      const tokens = await auth.register(input, req.get('user-agent'));
      setRefreshCookie(res, tokens);
      res.status(201).json(body(tokens));
    },
  );

  router.post(
    '/login',
    limiter({ windowMs: MINUTE, limit: limits.loginPerIp, key: byIp }),
    limiter({ windowMs: MINUTE, limit: limits.loginPerIpEmail, key: byIpAndEmail }),
    async (req, res) => {
      const input = parseOrThrow(loginSchema, req.body);
      const tokens = await auth.login(input, req.get('user-agent'));
      setRefreshCookie(res, tokens);
      res.json(body(tokens));
    },
  );

  router.post(
    '/refresh',
    limiter({ windowMs: MINUTE, limit: limits.refreshPerIp, key: byIp }),
    requireCsrf,
    async (req, res) => {
      try {
        const tokens = await auth.refresh(cookieOf(req), req.get('user-agent'));
        setRefreshCookie(res, tokens);
        res.json(body(tokens));
      } catch (error) {
        clearRefreshCookie(res);
        throw error;
      }
    },
  );

  router.post('/logout', requireCsrf, async (req, res) => {
    await auth.logout(cookieOf(req));
    clearRefreshCookie(res);
    res.status(204).end();
  });

  return router;
}
