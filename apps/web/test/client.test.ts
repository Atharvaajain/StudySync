/** Frontend unit tests (TESTING_STRATEGY §5.7): the client's version guard and task order. */
import { describe, expect, it } from 'vitest';
import type { SessionDto, TaskDto } from '@studysync/shared';
import { acceptSession } from '../src/realtime/sessionGuard';
import { sortTasks } from '../src/realtime/useTasks';

const session = (id: string, version: number): SessionDto => ({
  id,
  phase: 'STUDYING',
  version,
  roomId: null,
  roomName: null,
  task: null,
  startedAt: '2026-11-01T10:00:00.000Z',
  studyMsClosed: 0,
  currentSegmentStartedAt: '2026-11-01T10:00:00.000Z',
  break: null,
  disconnectedAt: null,
  autoSaveAt: null,
});

describe('acceptSession (§12.5 version guard)', () => {
  it('keeps the newest version and drops older pushes of the same session', () => {
    const ended = new Set<string>();
    const v2 = session('a', 2);
    expect(acceptSession(null, v2, ended)).toBe(v2);
    expect(acceptSession(v2, session('a', 1), ended)).toBe(v2);
    const v3 = session('a', 3);
    expect(acceptSession(v2, v3, ended)).toBe(v3);
  });

  it('ignores late pushes about a session that already ended; accepts a new one', () => {
    const ended = new Set<string>();
    expect(acceptSession(session('a', 4), null, ended)).toBeNull();
    expect(acceptSession(null, session('a', 3), ended)).toBeNull();
    const next = session('b', 1);
    expect(acceptSession(null, next, ended)).toBe(next);
  });
});

describe('sortTasks', () => {
  const task = (id: string, status: 'TODO' | 'DONE', dueDate: string | null, createdAt: string) =>
    ({ id, status, dueDate, createdAt }) as TaskDto;

  it('orders TODO first, then by due date (none last), then by creation', () => {
    const sorted = sortTasks([
      task('done', 'DONE', '2026-11-01', '2026-10-01T00:00:00Z'),
      task('none', 'TODO', null, '2026-10-01T00:00:00Z'),
      task('late', 'TODO', '2026-12-01', '2026-10-01T00:00:00Z'),
      task('soon-b', 'TODO', '2026-11-02', '2026-10-03T00:00:00Z'),
      task('soon-a', 'TODO', '2026-11-02', '2026-10-02T00:00:00Z'),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['soon-a', 'soon-b', 'late', 'none', 'done']);
  });
});
