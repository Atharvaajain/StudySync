/**
 * Display-name cache for room status pushes (synchronous lookups on the hot path).
 * Filled from the database on socket connect, when room members are loaded and on profile
 * edits. The database stays the source of truth.
 */
export class UserDirectory {
  private readonly names = new Map<string, string>();

  upsert(userId: string, name: string): void {
    this.names.set(userId, name);
  }

  nameOf(userId: string): string {
    return this.names.get(userId) ?? 'Member';
  }
}
