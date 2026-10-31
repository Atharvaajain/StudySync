/**
 * PHASE 0 ONLY — self-declared user identities (name + client-generated id). There is no
 * authentication in the prototype; Phase 1 replaces this with registered users and JWTs.
 */
export class UserDirectory {
  private readonly names = new Map<string, string>();

  upsert(userId: string, name: string): void {
    this.names.set(userId, name);
  }

  nameOf(userId: string): string {
    return this.names.get(userId) ?? 'Unknown';
  }
}
