import type { UserDto } from '@studysync/shared';
import { toIso } from '../../lib/time';

/** Explicit mapper: password hashes and token hashes are never serialized (§17.3). */
export function toUserDto(user: {
  id: string;
  name: string;
  email: string;
  timezone: string;
  createdAt: Date;
}): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    timezone: user.timezone,
    createdAt: toIso(user.createdAt.getTime()),
  };
}
