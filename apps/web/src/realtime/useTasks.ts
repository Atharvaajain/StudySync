/**
 * Tasks (F-25–F-27, R8): personal (`roomId` null) or a room's shared list. Read over REST,
 * changed over the socket, kept in sync by `personal_task_updated` (my devices) or
 * `room_task_updated` (everyone present in the room). Every task carries a version; older
 * copies are dropped.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AckResponse, TaskDto } from '@studysync/shared';
import { api, errorMessage } from '../lib/api';
import { newUuid } from '../lib/uuid';
import { useRealtime } from './RealtimeProvider';

function upsert(tasks: TaskDto[], task: TaskDto): TaskDto[] {
  const existing = tasks.find((t) => t.id === task.id);
  if (existing && existing.version > task.version) return tasks;
  return existing ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task];
}

/** TODO first, then by due date (no date last), then creation (same as the server). */
export function sortTasks(tasks: TaskDto[]): TaskDto[] {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'TODO' ? -1 : 1;
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export function useTasks(roomId: string | null = null) {
  const { socket, call } = useRealtime();
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ items: TaskDto[] }>(roomId ? `/rooms/${roomId}/tasks` : '/tasks');
      setTasks(res.items);
      setLoaded(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [roomId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!socket) return;
    const onUpdate = (p: {
      action: 'added' | 'updated' | 'deleted';
      task?: TaskDto;
      taskId: string;
      roomId?: string;
    }) => {
      if ((p.roomId ?? null) !== roomId) return;
      setTasks((current) =>
        p.action === 'deleted' || !p.task
          ? current.filter((t) => t.id !== p.taskId)
          : upsert(current, p.task),
      );
    };
    // Changes made while disconnected arrive with the next full read.
    const onReconnect = () => void reload();
    const event = roomId ? 'room_task_updated' : 'personal_task_updated';
    socket.on(event, onUpdate);
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.off(event, onUpdate);
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, reload, roomId]);

  const handle = useCallback(async <T>(res: AckResponse<T>): Promise<T | null> => {
    if (res.ok) {
      setError(null);
      return res.data;
    }
    setError(res.error.message);
    const current = res.error.details?.current as TaskDto | undefined;
    if (current) setTasks((ts) => upsert(ts, current));
    return null;
  }, []);

  const add = useCallback(
    async (input: { title: string; description?: string | null; dueDate?: string | null }) => {
      const data = await handle(await call('task_add', { id: newUuid(), roomId, ...input }));
      if (data) setTasks((ts) => upsert(ts, data.task));
      return data?.task ?? null;
    },
    [call, handle, roomId],
  );

  const toggle = useCallback(
    async (taskId: string, done: boolean) => {
      const data = await handle(await call('task_toggle', { taskId, done }));
      if (data) setTasks((ts) => upsert(ts, data.task));
    },
    [call, handle],
  );

  const update = useCallback(
    async (
      task: TaskDto,
      patch: { title?: string; description?: string | null; dueDate?: string | null },
    ) => {
      const data = await handle(
        await call('task_update', { taskId: task.id, expectedVersion: task.version, ...patch }),
      );
      if (data) setTasks((ts) => upsert(ts, data.task));
      return data !== null;
    },
    [call, handle],
  );

  const remove = useCallback(
    async (taskId: string) => {
      const data = await handle(await call('task_delete', { taskId }));
      if (data) setTasks((ts) => ts.filter((t) => t.id !== taskId));
    },
    [call, handle],
  );

  return {
    tasks: sortTasks(tasks),
    loaded,
    error,
    clearError: () => setError(null),
    add,
    toggle,
    update,
    remove,
  };
}
