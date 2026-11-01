/**
 * Personal tasks (ARCHITECTURE §15, API_DESIGN §7). Reads are REST; mutations are socket events.
 * - task_add is idempotent on the client-generated id.
 * - task_toggle has set semantics (I-14): `done` is the target state, a no-op if already there.
 * - task_update is versioned (`expectedVersion` → VERSION_CONFLICT with the current task).
 * - task_delete is a soft delete. Deleted tasks are invisible (404) but still resolve in
 *   session summaries (E-22).
 * Tasks never affect study time (F-28).
 *
 * PHASE 1 scope: personal tasks only. Room tasks arrive in Phase 2.
 */
import { PERSONAL_TASK_LIMIT, type TaskDto } from '@studysync/shared';
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

export class TaskService {
  constructor(private readonly deps: { db: Db; clock: Clock; events: DomainEvents }) {}

  /** GET /tasks — the caller's live personal tasks: status, due date, creation order. */
  async list(userId: string, status?: 'TODO' | 'DONE'): Promise<TaskDto[]> {
    const rows = await this.deps.db.task.findMany({
      where: { userId, roomId: null, deletedAt: null, ...(status ? { status } : {}) },
      include: taskInclude,
      orderBy: [
        { status: 'asc' },
        { dueDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
    return rows.map(toTaskDto);
  }

  async add(userId: string, input: AddTaskInput): Promise<TaskDto> {
    if (input.roomId !== null) {
      throw new AppError('VALIDATION_ERROR', { reason: 'Room tasks arrive in Phase 2.' });
    }
    const { task, created } = await transaction(this.deps.db, async (tx) => {
      await lockUser(tx, userId); // count + insert atomically (personal task limit)
      const existing = await tx.task.findUnique({ where: { id: input.id }, include: taskInclude });
      if (existing) {
        // A replayed id returns the existing task (idempotent retry).
        if (existing.userId !== userId || existing.roomId !== null)
          throw new AppError('ID_CONFLICT');
        if (existing.deletedAt !== null) throw new AppError('NOT_FOUND');
        return { task: existing, created: false };
      }
      const live = await tx.task.count({ where: { userId, roomId: null, deletedAt: null } });
      if (live >= PERSONAL_TASK_LIMIT) throw new AppError('TASK_LIMIT_REACHED');
      const now = new Date(this.deps.clock.now());
      const row = await tx.task.create({
        data: {
          id: input.id,
          userId,
          roomId: null,
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
    if (created) this.publish(userId, 'added', dto);
    return dto;
  }

  async toggle(userId: string, taskId: string, done: boolean): Promise<TaskDto> {
    const task = await transaction(this.deps.db, async (tx) => {
      const current = await this.lockOwn(tx, userId, taskId);
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
    const dto = toTaskDto(task.row);
    if (task.changed) this.publish(userId, 'updated', dto);
    return dto;
  }

  async update(userId: string, input: UpdateTaskInput): Promise<TaskDto> {
    const row = await transaction(this.deps.db, async (tx) => {
      const current = await this.lockOwn(tx, userId, input.taskId);
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
    this.publish(userId, 'updated', dto);
    return dto;
  }

  /** Soft delete. Deleting an already-deleted own task is a no-op. */
  async remove(userId: string, taskId: string): Promise<void> {
    const deleted = await transaction(this.deps.db, async (tx) => {
      const rows = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM tasks
        WHERE id = ${taskId}::uuid AND user_id = ${userId}::uuid AND room_id IS NULL FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AppError('NOT_FOUND');
      if (row.deleted_at !== null) return false;
      const now = new Date(this.deps.clock.now());
      await tx.task.update({
        where: { id: taskId },
        data: { deletedAt: now, updatedAt: now, version: { increment: 1 } },
      });
      return true;
    });
    if (deleted) this.publish(userId, 'deleted', undefined, taskId);
  }

  /** Locks and returns the caller's live personal task, or throws NOT_FOUND. */
  private async lockOwn(tx: Tx, userId: string, taskId: string): Promise<TaskRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tasks
      WHERE id = ${taskId}::uuid AND user_id = ${userId}::uuid AND room_id IS NULL
        AND deleted_at IS NULL
      FOR UPDATE`;
    if (locked.length === 0) throw new AppError('NOT_FOUND');
    return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
  }

  private publish(
    userId: string,
    action: 'added' | 'updated' | 'deleted',
    task?: TaskDto,
    taskId?: string,
  ): void {
    const id = task?.id ?? taskId!;
    this.deps.events.publish(
      task
        ? { type: 'personal_task_changed', userId, action, taskId: id, task }
        : { type: 'personal_task_changed', userId, action, taskId: id },
    );
  }
}
