/**
 * Profile and timezone (API_DESIGN §5 Users). A timezone change applies to segments started
 * afterwards: each segment keeps the snapshot from when it started (I-10, D-6), so historical
 * totals never change.
 */
import type { UserDto } from '@studysync/shared';
import type { Db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { toUserDto } from './userDto';
import type { UserDirectory } from './userDirectory';

export class UserService {
  private readonly knownZones = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly directory: UserDirectory,
  ) {}

  /**
   * The zone must be valid for both the app (Intl, checked by the Zod schema) and PostgreSQL,
   * which does the midnight splitting (`AT TIME ZONE`).
   */
  async assertTimezone(timezone: string): Promise<void> {
    if (this.knownZones.has(timezone)) return;
    const rows = await this.db.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM pg_timezone_names WHERE name = ${timezone} LIMIT 1`;
    if (rows.length === 0) throw new AppError('INVALID_TIMEZONE');
    this.knownZones.add(timezone);
  }

  async getMe(userId: string): Promise<UserDto> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('NOT_FOUND');
    return toUserDto(user);
  }

  async updateMe(
    userId: string,
    patch: { name?: string | undefined; timezone?: string | undefined },
  ): Promise<UserDto> {
    if (patch.timezone !== undefined) await this.assertTimezone(patch.timezone);
    const data: { name?: string; timezone?: string } = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.timezone !== undefined) data.timezone = patch.timezone;
    const user = await this.db.user.update({ where: { id: userId }, data }).catch(() => {
      throw new AppError('NOT_FOUND');
    });
    this.directory.upsert(user.id, user.name);
    return toUserDto(user);
  }
}
