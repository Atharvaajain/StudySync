/**
 * Tasks (ARCHITECTURE §15, API_DESIGN §7, I-13–I-16). Reads are REST; mutations are socket events.
 * - Personal tasks (`room_id` NULL): owner only. Room tasks: members only (404 otherwise).
 * - task_add is idempotent on the client-generated id.
 * - task_toggle has set semantics (I-14): `done` is the target state, a no-op if already there.
 * - task_update is versioned (`expectedVersion` → VERSION_CONFLICT with the current task).
 * - task_delete is a soft delete. Room tasks: task creator or room creator (FORBIDDEN).
 * - Changes are published after commit: `personal_task_updated` to my devices,
 *   `room_task_updated` to the room. Tasks never affect study time (F-28).
 */
import { PERSONAL_TASK_LIMIT, ROOM_TASK_LIMIT, type TaskDto } from '@studysync/shared';
import type { DomainEvents } from '../../events/domainEvents';
import type { Clock } from '../../lib/clock';
import { lockUser, transaction, type Db, type Prisma, type Tx } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { toIso } from '../../lib/time';

const taskInclude = {
  user: { select: { id: true, name: true } },
  completedBy: { select: { id: true, name: true } },
} as const;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export function toTaskDto(t: TaskRow): TaskDto {
  return {
    id: t.id,
    roomId: t.roomId,
    title: t.title,
    description: t.description,
    status: t.status,
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
    version: t.version,
    createdBy: t.user,
    completedBy: t.completedBy,
    completedAt: t.completedAt ? toIso(t.completedAt.getTime()) : null,
    createdAt: toIso(t.createdAt.getTime()),
    updatedAt: toIso(t.updatedAt.getTime()),
  };
}

/** `YYYY-MM-DD` → a DATE value (calendar date, no timezone). */
const toDueDate = (date: string | null | undefined): Date | null | undefined =>
  date === undefined ? undefined : date === null ? null : new Date(`${date}T00:00:00.000Z`);

const ORDER: Prisma.TaskOrderByWithRelationInput[] = [
  { status: 'asc' },
  { dueDate: { sort: 'asc', nulls: 'last' } },
  { createdAt: 'asc' },
  { id: 'asc' },
];

export interface AddTaskInput {
  id: string;
  roomId: string | null;
  title: string;
  description?: string | null | undefined;
  dueDate?: string | null | undefined;
}

export interface UpdateTaskInput {
  taskId: string;
  expectedVersion: number;
  title?: string | undefined;
  description?: string | null | undefined;
  dueDate?: string | null | undefined;
}

type Action = 'added' | 'updated' | 'deleted';

export class TaskService {
  constructor(private readonly deps: { db: Db; clock: Clock; events: DomainEvents }) {}

  /** GET /tasks — the caller's live personal tasks. */
  async list(userId: string, status?: 'TODO' | 'DONE'): Promise<TaskDto[]> {
    const rows = await this.deps.db.task.findMany({
      where: { userId, roomId: null, deletedAt: null, ...(status ? { status } : {}) },
      include: taskInclude,
      orderBy: ORDER,
    });
    return rows.map(toTaskDto);
  }

  /** Room tasks (membership is checked by the caller). */
  async listRoom(roomId: string, status?: 'TODO' | 'DONE'): Promise<TaskDto[]> {
    const rows = await this.deps.db.task.findMany({
      where: { roomId, deletedAt: null, ...(status ? { status } : {}) },
      include: taskInclude,
      orderBy: ORDER,
    });
    return rows.map(toTaskDto);
  }

  async add(userId: string, input: AddTaskInput): Promise<TaskDto> {
    const { task, created } = await transaction(this.deps.db, async (tx) => {
      if (input.roomId !== null) {
        await this.assertMember(tx, input.roomId, userId);
        // Serialize room task inserts so the room limit holds.
        await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${input.roomId}::uuid FOR UPDATE`;
      } else {
        await lockUser(tx, userId); // count + insert atomically (personal task limit)
      }
      const existing = await tx.task.findUnique({ where: { id: input.id }, include: taskInclude });
      if (existing) {
        // A replayed id returns the existing task (idempotent retry).
        const same = existing.userId === userId && existing.roomId === input.roomId;
        if (!same) throw new AppError('ID_CONFLICT');
        if (existing.deletedAt !== null) throw new AppError('NOT_FOUND');
        return { task: existing, created: false };
      }
      const live = await tx.task.count({
        where:
          input.roomId === null
            ? { userId, roomId: null, deletedAt: null }
            : { roomId: input.roomId, deletedAt: null },
      });
      if (live >= (input.roomId === null ? PERSONAL_TASK_LIMIT : ROOM_TASK_LIMIT)) {
        throw new AppError('TASK_LIMIT_REACHED');
      }
      const now = new Date(this.deps.clock.now());
      const row = await tx.task.create({
        data: {
          id: input.id,
          userId,
          roomId: input.roomId,
          title: input.title,
          description: input.description ?? null,
          dueDate: toDueDate(input.dueDate) ?? null,
          createdAt: now,
          updatedAt: now,
        },
        include: taskInclude,
      });
      return { task: row, created: true };
    });
    const dto = toTaskDto(task);
    if (created) this.publish(userId, 'added', dto.roomId, dto.id, dto);
    return dto;
  }

  async toggle(userId: string, taskId: string, done: boolean): Promise<TaskDto> {
    const result = await transaction(this.deps.db, async (tx) => {
      const { task: current } = await this.lockAccessible(tx, userId, taskId);
      const target = done ? 'DONE' : 'TODO';
      if (current.status === target) return { row: current, changed: false };
      const now = new Date(this.deps.clock.now());
      const row = await tx.task.update({
        where: { id: taskId },
        data: {
          status: target,
          completedAt: done ? now : null,
          completedById: done ? userId : null,
          version: { increment: 1 },
          updatedAt: now,
        },
        include: taskInclude,
      });
      return { row, changed: true };
    });
    const dto = toTaskDto(result.row);
    if (result.changed) this.publish(userId, 'updated', dto.roomId, dto.id, dto);
    return dto;
  }

  async update(userId: string, input: UpdateTaskInput): Promise<TaskDto> {
    const row = await transaction(this.deps.db, async (tx) => {
      const { task: current } = await this.lockAccessible(tx, userId, input.taskId);
      if (current.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', { current: toTaskDto(current) });
      }
      const data: Prisma.TaskUpdateInput = {
        version: { increment: 1 },
        updatedAt: new Date(this.deps.clock.now()),
      };
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      const due = toDueDate(input.dueDate);
      if (due !== undefined) data.dueDate = due;
      return tx.task.update({ where: { id: input.taskId }, data, include: taskInclude });
    });
    const dto = toTaskDto(row);
    this.publish(userId, 'updated', dto.roomId, dto.id, dto);
    return dto;
  }

  /** Soft delete. Deleting an already-deleted visible task is a no-op. */
  async remove(userId: string, taskId: string): Promise<void> {
    const deleted = await transaction(this.deps.db, async (tx) => {
      const { task, roomCreatorId } = await this.lockAccessible(tx, userId, taskId, {
        includeDeleted: true,
      });
      // I-16: a room task can be deleted by its creator or by the room's creator.
      if (task.roomId !== null && task.userId !== userId && roomCreatorId !== userId) {
        throw new AppError('FORBIDDEN');
      }
      if (task.deletedAt !== null) return null; // already deleted: nothing to publish
      const now = new Date(this.deps.clock.now());
      await tx.task.update({
        where: { id: taskId },
        data: { deletedAt: now, updatedAt: now, version: { increment: 1 } },
      });
      return { roomId: task.roomId };
    });
    if (deleted !== null) this.publish(userId, 'deleted', deleted.roomId, taskId);
  }

  /**
   * Locks and returns a task the caller may change: their own personal task, or a task of a
   * room they are a member of. Anything else is NOT_FOUND (no existence leak).
   */
  private async lockAccessible(
    tx: Tx,
    userId: string,
    taskId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<{ task: TaskRow; roomCreatorId: string | null }> {
    const rows = await tx.$queryRaw<
      { user_id: string; room_id: string | null; deleted_at: Date | null }[]
    >`
      SELECT user_id, room_id, deleted_at FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row || (row.deleted_at !== null && !options.includeDeleted))
      throw new AppError('NOT_FOUND');
    let roomCreatorId: string | null = null;
    if (row.room_id === null) {
      if (row.user_id !== userId) throw new AppError('NOT_FOUND');
    } else {
      await this.assertMember(tx, row.room_id, userId);
      const room = await tx.room.findUniqueOrThrow({
        where: { id: row.room_id },
        select: { createdById: true },
      });
      roomCreatorId = room.createdById;
    }
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
    return { task, roomCreatorId };
  }

  private async assertMember(tx: Tx, roomId: string, userId: string): Promise<void> {
    const member = await tx.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { userId: true },
    });
    if (!member) throw new AppError('NOT_FOUND');
  }

  private publish(
    userId: string,
    action: Action,
    roomId: string | null,
    taskId: string,
    task?: TaskDto,
  ): void {
    const withTask = task ? { task } : {};
    this.deps.events.publish(
      roomId === null
        ? { type: 'personal_task_changed', userId, action, taskId, ...withTask }
        : { type: 'room_task_changed', roomId, actorId: userId, action, taskId, ...withTask },
    );
  }
}
