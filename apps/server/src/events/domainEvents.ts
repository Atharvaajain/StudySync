import type { SessionCause } from '@studysync/shared';

/**
 * Domain events, published only AFTER a change is committed (ARCHITECTURE §9.7, "emit after
 * commit"). The realtime layer subscribes and turns them into Socket.IO pushes, so domain
 * services never depend on Socket.IO.
 */
export type DomainEvent =
  | { type: 'session_changed'; userId: string; cause: SessionCause }
  | { type: 'member_status_changed'; roomId: string; userId: string }
  | { type: 'member_joined'; roomId: string; userId: string }
  | { type: 'member_left'; roomId: string; userId: string };

export type DomainEventListener = (event: DomainEvent) => void;

export class DomainEvents {
  private readonly listeners = new Set<DomainEventListener>();

  subscribe(listener: DomainEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: DomainEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
