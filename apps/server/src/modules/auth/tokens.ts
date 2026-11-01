/**
 * Access and refresh tokens (ARCHITECTURE §17.1).
 *
 * - Access token: JWT HS256 (algorithm pinned on verify), claims sub/iss/aud/iat/exp, issued
 *   and verified against the injected Clock, so the test clock moves token expiry too.
 * - Refresh token: opaque 256-bit random value. Only its SHA-256 hash is stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Env } from '../../config/env';
import type { Clock } from '../../lib/clock';
import { AppError } from '../../lib/errors';

export interface AccessToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

export class TokenService {
  constructor(
    private readonly env: Env,
    private readonly clock: Clock,
  ) {}

  signAccess(userId: string): AccessToken {
    const iat = Math.floor(this.clock.now() / 1000);
    const exp = iat + this.env.ACCESS_TOKEN_TTL_SEC;
    const token = jwt.sign({ iat, exp }, this.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: userId,
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
    });
    return { token, expiresAt: exp * 1000 };
  }

  /** Returns the user id and expiry. Throws UNAUTHENTICATED or TOKEN_EXPIRED. */
  verifyAccess(token: string): { userId: string; expiresAt: number } {
    try {
      const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        clockTimestamp: Math.floor(this.clock.now() / 1000),
      });
      if (typeof payload === 'string' || typeof payload.sub !== 'string' || !payload.exp) {
        throw new AppError('UNAUTHENTICATED');
      }
      if (!UUID_RE.test(payload.sub)) throw new AppError('UNAUTHENTICATED');
      return { userId: payload.sub, expiresAt: payload.exp * 1000 };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) throw new AppError('TOKEN_EXPIRED');
      throw new AppError('UNAUTHENTICATED');
    }
  }

  newRefreshToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: hashRefreshToken(raw) };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
