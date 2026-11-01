/**
 * Registration, login, refresh rotation with reuse detection, logout (ARCHITECTURE §17.1).
 *
 * Refresh tokens form a family per login. Every refresh revokes the presented token and issues
 * a new one in the same family. Presenting an already-rotated token revokes the whole family
 * (REFRESH_REUSED): the legitimate user and an attacker are both logged out.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { UserDto } from '@studysync/shared';
import type { Env } from '../../config/env';
import type { Clock } from '../../lib/clock';
import { isUniqueViolation, transaction, type Db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { toUserDto } from '../users/userDto';
import type { UserService } from '../users/userService';
import { hashRefreshToken, type TokenService } from './tokens';

export interface IssuedTokens {
  user: UserDto;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

const DAY_MS = 86_400_000;

export class AuthService {
  /** Compared against when the email is unknown, so login timing does not leak accounts. */
  private readonly dummyHash: string;

  constructor(
    private readonly deps: {
      db: Db;
      env: Env;
      clock: Clock;
      tokens: TokenService;
      users: UserService;
    },
  ) {
    this.dummyHash = bcrypt.hashSync('studysync-dummy-password', deps.env.BCRYPT_COST);
  }

  async register(
    input: { name: string; email: string; password: string; timezone: string },
    userAgent: string | undefined,
  ): Promise<IssuedTokens> {
    await this.deps.users.assertTimezone(input.timezone);
    const passwordHash = await bcrypt.hash(input.password, this.deps.env.BCRYPT_COST);
    const user = await this.deps.db.user
      .create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          timezone: input.timezone,
          createdAt: new Date(this.deps.clock.now()),
        },
      })
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new AppError('EMAIL_TAKEN') : error;
      });
    return this.issue(user, randomUUID(), userAgent);
  }

  async login(
    input: { email: string; password: string },
    userAgent: string | undefined,
  ): Promise<IssuedTokens> {
    const user = await this.deps.db.user.findUnique({ where: { email: input.email } });
    const ok = await bcrypt.compare(input.password, user?.passwordHash ?? this.dummyHash);
    if (!user || !ok) throw new AppError('INVALID_CREDENTIALS');
    return this.issue(user, randomUUID(), userAgent);
  }

  async refresh(
    rawToken: string | undefined,
    userAgent: string | undefined,
  ): Promise<IssuedTokens> {
    if (!rawToken) throw new AppError('REFRESH_INVALID');
    const { db, clock, env, tokens } = this.deps;
    const now = clock.now();
    const tokenHash = hashRefreshToken(rawToken);

    const outcome = await transaction(db, async (tx) => {
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!row) return { kind: 'invalid' as const };
      const revokeFamily = () =>
        tx.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date(now) },
        });
      if (row.revokedAt !== null) {
        await revokeFamily();
        return { kind: 'reused' as const };
      }
      if (row.expiresAt.getTime() <= now) return { kind: 'invalid' as const };
      // Claim the token atomically: a concurrent refresh with the same token loses the race.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(now) },
      });
      if (claimed.count !== 1) {
        await revokeFamily();
        return { kind: 'reused' as const };
      }
      const next = tokens.newRefreshToken();
      const expiresAt = now + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS;
      const created = await tx.refreshToken.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: next.hash,
          expiresAt: new Date(expiresAt),
          userAgent: userAgent?.slice(0, 255) ?? null,
          createdAt: new Date(now),
        },
      });
      await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: created.id } });
      return { kind: 'ok' as const, user: row.user, raw: next.raw, expiresAt };
    });

    if (outcome.kind === 'invalid') throw new AppError('REFRESH_INVALID');
    if (outcome.kind === 'reused') throw new AppError('REFRESH_REUSED');
    const access = tokens.signAccess(outcome.user.id);
    return {
      user: toUserDto(outcome.user),
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: outcome.raw,
      refreshTokenExpiresAt: outcome.expiresAt,
    };
  }

  /** Revokes the presented token's whole family. Always succeeds (idempotent). */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const row = await this.deps.db.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
    });
    if (!row) return;
    await this.deps.db.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date(this.deps.clock.now()) },
    });
  }

  private async issue(
    user: { id: string; name: string; email: string; timezone: string; createdAt: Date },
    familyId: string,
    userAgent: string | undefined,
  ): Promise<IssuedTokens> {
    const { db, clock, env, tokens } = this.deps;
    const now = clock.now();
    const refresh = tokens.newRefreshToken();
    const refreshTokenExpiresAt = now + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS;
    await db.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: refresh.hash,
        expiresAt: new Date(refreshTokenExpiresAt),
        userAgent: userAgent?.slice(0, 255) ?? null,
        createdAt: new Date(now),
      },
    });
    const access = tokens.signAccess(user.id);
    return {
      user: toUserDto(user),
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.raw,
      refreshTokenExpiresAt,
    };
  }
}
