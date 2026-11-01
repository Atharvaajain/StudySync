/**
 * Phase 2 — rooms with several real users over Socket.IO on PostgreSQL.
 *   RT-2 (non-members), RT-3 (statuses), RT-12 (no shared timer), RT-10 / CT-8 / CT-9 (room
 *   tasks), Today in this room (F-23, I-09), RT-7 (solo → room move without reset), CT-6.
 * After every test the DATABASE_DESIGN §8 audits (A–H) must return no rows.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomDto, TaskDto, TodayDto, TodayInRoomDto } from '@studysync/shared';
import { audit } from '../helpers/db';
import { MIN, ROOM_ID, elapsedAt, startHarness, type Harness } from '../helpers/harness';
import { api, bearer } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

const r = () => randomUUID();
const code = (res: { ok: boolean; error?: { code: string } }) => (res.ok ? 'OK' : res.error!.code);

async function three() {
  const a = await h.connect('Atharva');
  const b = await h.connect('Bilal');
  const c = await h.connect('Chen');
  for (const x of [a, b, c]) await x.join();
  await Promise.all([a.sync(), b.sync(), c.sync()]);
  return [a, b, c] as const;
}

describe('RT-2 / RT-3 / RT-12: statuses with independent timers', () => {
  it('each member sees the others’ own statuses; commands change only the caller’s timer', async () => {
    const [a, b, c] = await three();
    const [sa, sb] = await Promise.all([a.start(), b.start()]);
    h.advance(20 * MIN);
    const mb = b.mark();
    const mc = c.mark();
    const brk = await a.takeBreak(sa.id, 15);

    // B and C see A On Break with A's own countdown; nobody else's timer changed.
    for (const x of [b, c]) {
      await x.waitFor(
        'status_changed',
        (p) => p.member.user.id === a.userId && p.member.status === 'ON_BREAK',
        x === b ? mb : mc,
      );
      expect(x.statusOf(a.userId)).toMatchObject({ breakEndsAt: brk.break!.endsAt });
    }
    await Promise.all([b.sync(), c.sync()]);
    expect(b.since(mb, 'session_state')).toEqual([]); // R2: A's break is not B's event
    expect(c.since(mc, 'session_state')).toEqual([]);
    const stateB = await b.sync();
    expect(stateB.session).toMatchObject({ id: sb.id, phase: 'STUDYING', version: 1 });
    expect(elapsedAt(stateB.session!, stateB.serverNow)).toBe(20 * MIN);
    expect(c.statusOf(b.userId)?.status).toBe('STUDYING');
    expect(c.statusOf(c.userId)?.status).toBe('IDLE'); // C never started
  });

  it('RT-2: a non-member cannot enter and never receives room broadcasts', async () => {
    const a = await h.connect('Atharva');
    const outsider = await h.connect('Mallory', { member: false });
    await a.join();
    expect(code(await outsider.call('join_room', { roomId: ROOM_ID }))).toBe('NOT_FOUND');
    const mark = outsider.mark();
    await a.start();
    a.ok(await a.call('task_add', { id: r(), roomId: ROOM_ID, title: 'secret' }));
    await outsider.sync();
    expect(
      outsider.received
        .slice(mark)
        .filter((e) => e.event !== 'session_state')
        .map((e) => e.event),
    ).toEqual([]);
    expect(code(await outsider.call('task_add', { id: r(), roomId: ROOM_ID, title: 'x' }))).toBe(
      'NOT_FOUND',
    );
    const res = await api(h)
      .get(`/api/v1/rooms/${ROOM_ID}/tasks`)
      .set(...bearer(h.tokenFor(outsider.userId)));
    expect(res.status).toBe(404);
  });
});

describe('RT-10 room tasks (R8)', () => {
  it('A adds, B checks off, C sees it; delete rights; conflicts; never other rooms', async () => {
    const [a, b, c] = await three();
    const other = await h.connect('Other', { member: false }); // in no room
    const mc = c.mark();
    const task = a.ok(
      await a.call('task_add', {
        id: r(),
        roomId: ROOM_ID,
        title: 'Graph problems',
        dueDate: '2026-11-03',
      }),
    ).task;
    const added = await c.waitFor('room_task_updated', (p) => p.taskId === task.id, mc);
    expect(added).toMatchObject({ roomId: ROOM_ID, action: 'added', actorId: a.userId });

    // CT-8: two members check it off at once → DONE once, one completedBy.
    const [t1, t2] = await Promise.all([
      b.call('task_toggle', { taskId: task.id, done: true }),
      c.call('task_toggle', { taskId: task.id, done: true }),
    ]);
    const done = [t1, t2].map((x) => (x.ok ? (x.data as { task: TaskDto }).task : null));
    expect(done.map((t) => t?.version)).toEqual([2, 2]);
    expect(done[0]!.completedBy?.id).toBe(done[1]!.completedBy?.id);
    await a.waitFor('room_task_updated', (p) => p.task?.status === 'DONE');

    // CT-9: two edits on the same version → one wins, the other gets the current task.
    const edits = await Promise.all([
      a.call('task_update', { taskId: task.id, expectedVersion: 2, title: 'Graphs I' }),
      b.call('task_update', { taskId: task.id, expectedVersion: 2, title: 'Graphs II' }),
    ]);
    expect(edits.map(code).sort()).toEqual(['OK', 'VERSION_CONFLICT']);

    // I-16: only the task creator or the room creator may delete.
    const byB = b.ok(
      await b.call('task_add', { id: r(), roomId: ROOM_ID, title: 'B’s task' }),
    ).task;
    expect(code(await c.call('task_delete', { taskId: task.id }))).toBe('FORBIDDEN');
    expect(code(await c.call('task_delete', { taskId: byB.id }))).toBe('FORBIDDEN');
    expect(code(await b.call('task_delete', { taskId: byB.id }))).toBe('OK'); // task creator
    // Atharva created the room in the harness (first member), so may delete any room task.
    expect(code(await a.call('task_delete', { taskId: task.id }))).toBe('OK');
    expect(code(await other.call('task_toggle', { taskId: byB.id, done: true }))).toBe('NOT_FOUND');

    await other.sync();
    expect(other.all('room_task_updated')).toEqual([]);
    const list = await api(h)
      .get(`/api/v1/rooms/${ROOM_ID}/tasks`)
      .set(...bearer(h.tokenFor(c.userId)));
    expect(list.body.items).toEqual([]);
    // Room tasks never show up in anyone's personal list.
    const personal = await api(h)
      .get('/api/v1/tasks')
      .set(...bearer(h.tokenFor(a.userId)));
    expect(personal.body.items).toEqual([]);
  });

  it('a room task can be attached to a session in that room only (I-17)', async () => {
    const [a] = await three();
    const task = a.ok(await a.call('task_add', { id: r(), roomId: ROOM_ID, title: 'Shared' })).task;
    const s = a.ok(
      await a.call('start_study', { commandId: r(), roomId: ROOM_ID, taskId: task.id }),
    ).session;
    expect(s.task).toEqual({ id: task.id, title: 'Shared' });
    await a.end(s.id);
    a.ok(await a.call('leave_room', { roomId: ROOM_ID }));
    expect(
      code(await a.call('start_study', { commandId: r(), roomId: null, taskId: task.id })),
    ).toBe('TASK_NOT_ATTACHABLE');
  });
});

describe('Today in this room (F-23, I-09)', () => {
  it('shows each member’s own today in this room, running segments included', async () => {
    const a = await h.connect('Atharva', { timezone: 'Asia/Kolkata' });
    const b = await h.connect('Bilal', { timezone: 'America/New_York' });
    await a.join();
    await b.join();
    const sa = await a.start();
    h.advance(30 * MIN);
    await a.takeBreak(sa.id, 10); // 30 min closed
    await b.start(); // running
    h.advance(10 * MIN);
    const today = (
      await api(h)
        .get(`/api/v1/rooms/${ROOM_ID}/today`)
        .set(...bearer(h.tokenFor(b.userId)))
    ).body as TodayInRoomDto;
    expect(
      today.members.map((m) => [m.user.name, m.todayMs / MIN, m.studyingSince !== null]),
    ).toEqual([
      ['Atharva', 30, false],
      ['Bilal', 10, true],
    ]);
    // The join_room ack carries the same snapshot.
    const joined = await b.join();
    expect(joined.today.members).toHaveLength(2);
  });
});

describe('RT-7: a solo session moves into a room without resetting (F-12, F-15)', () => {
  it('Study with friends: create a room mid-study, join it, the timer keeps counting', async () => {
    const a = await h.connect('Atharva', { member: false });
    const token = h.tokenFor(a.userId);
    const solo = await a.start(null);
    h.advance(30 * MIN);
    const room = (
      await api(h)
        .post('/api/v1/rooms')
        .set(...bearer(token))
        .send({ name: 'Friends' })
    ).body as RoomDto;
    const mark = a.mark();
    const joined = await a.join(room.id);
    expect(joined.session).toMatchObject({ id: solo.id, roomId: room.id, phase: 'STUDYING' });
    const moved = await a.waitFor('session_state', (p) => p.cause === 'MOVED_TO_ROOM', mark);
    expect(elapsedAt(moved.session!, moved.serverNow)).toBe(30 * MIN); // not reset
    h.advance(5 * MIN);
    const today = (
      await api(h)
        .get('/api/v1/stats/today')
        .set(...bearer(token))
    ).body as TodayDto;
    expect([today.soloMs / MIN, today.roomsMs / MIN, today.totalMs / MIN]).toEqual([30, 5, 35]);
    const summary = await a.end(solo.id);
    expect(summary.where).toEqual({ roomId: room.id, roomName: 'Friends', movedFromSolo: true });
    expect(summary.studiedMs).toBe(35 * MIN);
  });

  it('CT-6: two tabs join rooms A and B at once → one move, one SESSION_IN_OTHER_ROOM', async () => {
    const t1 = await h.connect('Atharva', { member: false });
    const t2 = await h.connect('Atharva', { userId: t1.userId });
    const token = h.tokenFor(t1.userId);
    const mk = async (name: string) =>
      (
        (
          await api(h)
            .post('/api/v1/rooms')
            .set(...bearer(token))
            .send({ name })
        ).body as RoomDto
      ).id;
    const [roomA, roomB] = [await mk('A'), await mk('B')];
    const s = await t1.start(null);
    const results = await Promise.all([
      t1.call('join_room', { roomId: roomA }),
      t2.call('join_room', { roomId: roomB }),
    ]);
    expect(results.map(code).sort()).toEqual(['OK', 'SESSION_IN_OTHER_ROOM']);
    const state = await t1.sync();
    expect(state.session).toMatchObject({ id: s.id });
    expect([roomA, roomB]).toContain(state.session!.roomId);
  });
});
