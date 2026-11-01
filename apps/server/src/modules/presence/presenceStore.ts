/**
 * Presence: which sockets a user has, and which room each socket is showing
 * (ARCHITECTURE §11.2). Ephemeral and in memory by design. Presence is NOT membership and
 * NOT a session (R16). A user is "present" in room R if at least one of their sockets has
 * joined R. Each socket shows at most one room.
 */
export class PresenceStore {
  private readonly userSockets = new Map<string, Set<string>>();
  private readonly socketUser = new Map<string, string>();
  private readonly socketRoom = new Map<string, string>();

  addSocket(userId: string, socketId: string): void {
    let set = this.userSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userSockets.set(userId, set);
    }
    set.add(socketId);
    this.socketUser.set(socketId, userId);
  }

  /** Removes the socket; returns the room it was showing (if any). */
  removeSocket(socketId: string): { userId: string | undefined; roomId: string | undefined } {
    const userId = this.socketUser.get(socketId);
    const roomId = this.socketRoom.get(socketId);
    this.socketRoom.delete(socketId);
    this.socketUser.delete(socketId);
    if (userId) {
      const set = this.userSockets.get(userId);
      set?.delete(socketId);
      if (set && set.size === 0) this.userSockets.delete(userId);
    }
    return { userId, roomId };
  }

  socketCount(userId: string): number {
    return this.userSockets.get(userId)?.size ?? 0;
  }

  /** Marks the socket as showing `roomId`; returns the room it showed before (if any). */
  joinRoom(socketId: string, roomId: string): string | undefined {
    const previous = this.socketRoom.get(socketId);
    this.socketRoom.set(socketId, roomId);
    return previous;
  }

  /** Restores a socket's room (used to undo a join that failed half-way). */
  setSocketRoom(socketId: string, roomId: string | null): void {
    if (roomId === null) this.socketRoom.delete(socketId);
    else this.socketRoom.set(socketId, roomId);
  }

  /** Removes every socket of `userId` from `roomId`; returns the socket ids that left. */
  leaveRoom(userId: string, roomId: string): string[] {
    const left: string[] = [];
    for (const socketId of this.userSockets.get(userId) ?? []) {
      if (this.socketRoom.get(socketId) === roomId) {
        this.socketRoom.delete(socketId);
        left.push(socketId);
      }
    }
    return left;
  }

  roomOfSocket(socketId: string): string | null {
    return this.socketRoom.get(socketId) ?? null;
  }

  isPresent(roomId: string, userId: string): boolean {
    for (const socketId of this.userSockets.get(userId) ?? []) {
      if (this.socketRoom.get(socketId) === roomId) return true;
    }
    return false;
  }

  /** Users with at least one socket on this instance (solo liveness, lease §6.8). */
  connectedUsers(): string[] {
    return [...this.userSockets.keys()];
  }

  /** (user, room) pairs present on this instance (room liveness, lease §6.8). */
  presentPairs(): { userId: string; roomId: string }[] {
    const pairs = new Map<string, { userId: string; roomId: string }>();
    for (const [socketId, roomId] of this.socketRoom) {
      const userId = this.socketUser.get(socketId);
      if (userId) pairs.set(`${userId}:${roomId}`, { userId, roomId });
    }
    return [...pairs.values()];
  }

  /** ARCHITECTURE §11.3 (D-7): solo — any socket; room session — present in that room. */
  isLive(userId: string, sessionRoomId: string | null): boolean {
    return sessionRoomId === null
      ? this.socketCount(userId) > 0
      : this.isPresent(sessionRoomId, userId);
  }

  /** The room the user is present in (I-08: one room at a time), or null. */
  roomOfUser(userId: string): string | null {
    for (const socketId of this.userSockets.get(userId) ?? []) {
      const room = this.socketRoom.get(socketId);
      if (room) return room;
    }
    return null;
  }
}
