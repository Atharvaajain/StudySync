/**
 * Phase 0 acceptance tests — the nine required scenarios, against the real server with real
 * Socket.IO clients and a controlled server clock. Since Phase 1 they run on PostgreSQL with
 * real JWTs; after every test the invariant audits (DATABASE_DESIGN §8, A–H) must return no rows.
 *
 *   AC-1 two browsers join the same room          AC-6 refresh while studying
 *   AC-2 both start independent timers            AC-7 refresh while on break
 *   AC-3 A breaks while B keeps studying          AC-8 invalid state transitions
 *   AC-4 A resumes after the break expires        AC-9 simultaneous requests
 *   AC-5 A ends without affecting B
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionDto } from '@studysync/shared';
import { audit, testDb } from '../helpers/db';
import { MIN, ROOM_ID, elapsedAt, startHarness, twoInRoom, type Harness } from '../helpers/harness';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

describe('AC-1 two browsers join the same room', () => {
  it('both are listed with live statuses; the room is the hardcoded DSA Night Study', async () => {
    const a = await h.connect('Alice');
    const b = await h.connect('Bob');

    const ja = await a.join();
    expect(ja.room).toMatchObject({ id: ROOM_ID, name: 'DSA Night Study', code: 'DSA7K2' });
    expect(ja.members.map((m) => [m.user.name, m.status])).toEqual([['Alice', 'IDLE']]);
    expect(ja.session).toBeNull();

    const markA = a.mark();
    const jb = await b.join();
    expect(jb.members.map((m) => [m.user.name, m.status])).toEqual([
      ['Alice', 'IDLE'],
      ['Bob', 'IDLE'],
    ]);
    const joined = await a.waitFor('member_joined', (p) => p.member.user.id === b.userId, markA);
    expect(joined.member).toMatchObject({ status: 'IDLE', reconnecting: false });
  });

  it('a member who leaves shows "reconnecting", then Offline after the 2-minute display grace', async () => {
    const [a, b] = await twoInRoom(h);
    const mark = a.mark();
    expect(b.ok(await b.call('leave_room', { roomId: ROOM_ID }))).toEqual({});
    await a.waitFor(
      'status_changed',
      (p) => p.member.user.id === b.userId && p.member.reconnecting,
      mark,
    );
    h.advance(2 * MIN - 1);
    await a.sync();
    expect(a.since(mark, 'member_left')).toHaveLength(0);
    h.advance(1);
    await a.waitFor('member_left', (p) => p.userId === b.userId, mark);
    expect(a.statusOf(b.userId)).toMatchObject({ status: 'OFFLINE', reconnecting: false });
  });
});

describe('AC-2 both users start independent timers', () => {
  it('each user gets their own session, timestamps and pushes', async () => {
    const [a, b] = await twoInRoom(h);
    const markA = a.mark();
    const markB = b.mark();

    const sa = await a.start();
    h.advance(MIN);
    const sb = await b.start();

    expect(sa.id).not.toBe(sb.id);
    expect(sa).toMatchObject({
      phase: 'STUDYING',
      roomId: ROOM_ID,
      roomName: 'DSA Night Study',
      studyMsClosed: 0,
      version: 1,
    });
    expect(Date.parse(sb.currentSegmentStartedAt!) - Date.parse(sa.currentSegmentStartedAt!)).toBe(
      MIN,
    );

    await a.sync();
    await b.sync();
    // R1: session_state only ever describes the receiver's own session.
    expect(a.since(markA, 'session_state').every((p) => p.session?.id === sa.id)).toBe(true);
    expect(b.since(markB, 'session_state').every((p) => p.session?.id === sb.id)).toBe(true);
    // Each sees the other studying.
    expect(a.statusOf(b.userId)?.status).toBe('STUDYING');
    expect(b.statusOf(a.userId)?.status).toBe('STUDYING');

    h.advance(4 * MIN);
    const stateA = await a.sync();
    const stateB = await b.sync();
    expect(elapsedAt(stateA.session!, stateA.serverNow)).toBe(5 * MIN);
    expect(elapsedAt(stateB.session!, stateB.serverNow)).toBe(4 * MIN);
  });
});

describe('AC-3 user A takes a break while user B continues studying', () => {
  it("A's break changes only A's timer; B sees A's countdown", async () => {
    const [a, b] = await twoInRoom(h);
    const sa = await a.start();
    const sb = await b.start();
    h.advance(5 * MIN);

    const markB = b.mark();
    const brk = await a.takeBreak(sa.id, 10);
    expect(brk.phase).toBe('ON_BREAK');
    expect(brk.studyMsClosed).toBe(5 * MIN);
    expect(brk.currentSegmentStartedAt).toBeNull();
    expect(brk.break).toMatchObject({ durationMinutes: 10 });
    expect(Date.parse(brk.break!.endsAt) - Date.parse(brk.break!.startedAt)).toBe(10 * MIN);

    const seen = await b.waitFor(
      'status_changed',
      (p) => p.member.user.id === a.userId && p.member.status === 'ON_BREAK',
      markB,
    );
    expect(seen.member.breakEndsAt).toBe(brk.break!.endsAt);

    // B's own timer is untouched: no session_state push, same segment and version.
    const stateB = await b.sync();
    expect(b.since(markB, 'session_state')).toHaveLength(0);
    expect(stateB.session).toMatchObject({
      id: sb.id,
      phase: 'STUDYING',
      currentSegmentStartedAt: sb.currentSegmentStartedAt,
      version: sb.version,
    });
    h.advance(3 * MIN);
    const later = await b.sync();
    expect(elapsedAt(later.session!, later.serverNow)).toBe(8 * MIN);
  });
});

describe('AC-4 user A resumes after the break expires', () => {
  it('no early resume, a server push at the end of the break, no automatic resume, then a manual resume', async () => {
    const [a, b] = await twoInRoom(h);
    const sa = await a.start();
    await b.start();
    h.advance(25 * MIN);
    const brk = await a.takeBreak(sa.id, 10);

    // Early resume is rejected, with the countdown end and the current session.
    const early = await a.call('resume_study', { commandId: randomUUID(), sessionId: sa.id });
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.error.code).toBe('BREAK_NOT_OVER');
      expect(early.error.details).toMatchObject({
        breakEndsAt: brk.break!.endsAt,
        session: { phase: 'ON_BREAK' },
      });
    }
    h.advance(10 * MIN - 1);
    const almost = await a.call('resume_study', { commandId: randomUUID(), sessionId: sa.id });
    expect(!almost.ok && almost.error.code).toBe('BREAK_NOT_OVER');

    // The countdown ends: the server pushes BREAK_OVER to A and IDLE to the room.
    const markA = a.mark();
    const markB = b.mark();
    h.advance(1);
    const over = await a.waitFor('session_state', (p) => p.cause === 'BREAK_OVER', markA);
    expect(over.session).toMatchObject({
      id: sa.id,
      phase: 'BREAK_OVER',
      currentSegmentStartedAt: null,
    });
    await b.waitFor(
      'status_changed',
      (p) => p.member.user.id === a.userId && p.member.status === 'IDLE',
      markB,
    );

    // R5: nothing resumes by itself, however long we wait.
    h.advance(20 * MIN);
    const waiting = await a.sync();
    expect(waiting.session).toMatchObject({
      phase: 'BREAK_OVER',
      studyMsClosed: 25 * MIN,
      currentSegmentStartedAt: null,
    });
    expect(elapsedAt(waiting.session!, waiting.serverNow)).toBe(25 * MIN);

    // Manual resume.
    const resumed = await a.resume(sa.id);
    expect(resumed).toMatchObject({
      phase: 'STUDYING',
      studyMsClosed: 25 * MIN,
      currentSegmentStartedAt: waiting.serverNow,
    });
    await b.waitFor(
      'status_changed',
      (p) => p.member.user.id === a.userId && p.member.status === 'STUDYING',
      markB,
    );

    // R3: break and waiting time never count as study time.
    h.advance(5 * MIN);
    const summary = await a.end(sa.id);
    expect(summary.studiedMs).toBe(30 * MIN);
    expect(summary.breaks).toEqual({ count: 1, totalMs: 10 * MIN }); // countdown time only (I-12)
  });
});

describe('AC-5 user A ends study without affecting user B', () => {
  it("A's summary is exact; B's session and stream are untouched; A can start fresh", async () => {
    const [a, b] = await twoInRoom(h);
    const sa = await a.start();
    const sb = await b.start();
    h.advance(10 * MIN);

    const markB = b.mark();
    const summary = await a.end(sa.id);
    expect(summary).toMatchObject({
      id: sa.id,
      endReason: 'USER',
      studiedMs: 10 * MIN,
      breaks: { count: 0, totalMs: 0 },
      where: { roomId: ROOM_ID, roomName: 'DSA Night Study', movedFromSolo: false },
    });
    expect((await a.sync()).session).toBeNull();

    await b.waitFor(
      'status_changed',
      (p) => p.member.user.id === a.userId && p.member.status === 'IDLE',
      markB,
    );
    const stateB = await b.sync();
    expect(b.since(markB, 'session_state')).toHaveLength(0);
    expect(stateB.session).toMatchObject({ id: sb.id, phase: 'STUDYING', version: sb.version });

    // R2: B only ever received room-presence events about A — never a timer command.
    const eventsB = new Set(b.received.slice(markB).map((r) => r.event));
    expect(
      [...eventsB].every((e) => ['status_changed', 'member_joined', 'member_left'].includes(e)),
    ).toBe(true);

    // One active session at a time, and A can start a new one.
    const again = await a.start();
    expect(again.id).not.toBe(sa.id);
  });
});

describe('AC-6 browser refresh while studying', () => {
  it('the new connection rebuilds the exact timer from server timestamps', async () => {
    const [a, b] = await twoInRoom(h);
    const sa = await a.start();
    h.advance(7 * MIN);
    await a.takeBreak(sa.id, 5);
    h.advance(5 * MIN);
    await a.resume(sa.id);
    h.advance(3 * MIN);

    const markB = b.mark();
    await a.disconnect(); // "F5"
    await b.waitFor(
      'status_changed',
      (p) => p.member.user.id === a.userId && p.member.reconnecting,
      markB,
    );
    expect(b.statusOf(a.userId)?.status).toBe('STUDYING'); // last status kept during grace

    h.advance(1_000);
    const a2 = await h.connect('Alice', { userId: a.userId });
    const connect = a2.all('session_state')[0]!;
    expect(connect.cause).toBe('CONNECT');
    expect(connect.session).toMatchObject({ id: sa.id, phase: 'STUDYING', studyMsClosed: 7 * MIN });
    expect(elapsedAt(connect.session!, connect.serverNow)).toBe(10 * MIN + 1_000);

    await a2.join();
    await b.waitFor(
      'status_changed',
      (p) =>
        p.member.user.id === a.userId && p.member.status === 'STUDYING' && !p.member.reconnecting,
      markB,
    );
  });
});

describe('AC-7 browser refresh while on break', () => {
  it('the countdown is rebuilt from the server; a break that ended while away shows Break Over (no auto resume)', async () => {
    const a = await h.connect('Alice');
    await a.join();
    const sa = await a.start();
    h.advance(10 * MIN);
    const brk = await a.takeBreak(sa.id, 15);
    h.advance(4 * MIN);

    await a.disconnect();
    const a2 = await h.connect('Alice', { userId: a.userId });
    const connect = a2.all('session_state')[0]!;
    expect(connect.session).toMatchObject({
      id: sa.id,
      phase: 'ON_BREAK',
      studyMsClosed: 10 * MIN,
      break: { durationMinutes: 15, endsAt: brk.break!.endsAt },
    });
    expect(Date.parse(connect.session!.break!.endsAt) - Date.parse(connect.serverNow)).toBe(
      11 * MIN,
    );
    const joined = await a2.join();
    expect(joined.members.find((m) => m.user.id === a.userId)).toMatchObject({
      status: 'ON_BREAK',
      breakEndsAt: brk.break!.endsAt,
    });

    // Refresh again after the break has ended while the tab was closed.
    await a2.disconnect();
    h.advance(12 * MIN);
    const a3 = await h.connect('Alice', { userId: a.userId });
    expect(a3.all('session_state')[0]!.session).toMatchObject({
      phase: 'BREAK_OVER',
      studyMsClosed: 10 * MIN,
    });
  });
});

describe('AC-8 invalid state transitions are rejected by the server', () => {
  const code = (res: { ok: boolean; error?: { code: string } }) =>
    res.ok ? 'OK' : res.error!.code;

  it('commands without an active session → NO_ACTIVE_SESSION (with details.session = null)', async () => {
    const a = await h.connect('Alice');
    await a.join();
    const sessionId = randomUUID();
    for (const [event, payload] of [
      ['take_break', { commandId: randomUUID(), sessionId, durationMinutes: 10 }],
      ['resume_study', { commandId: randomUUID(), sessionId }],
      ['end_study', { commandId: randomUUID(), sessionId }],
    ] as const) {
      const res = await a.call(event, payload);
      expect(code(res)).toBe('NO_ACTIVE_SESSION');
      if (!res.ok) expect(res.error.details).toEqual({ session: null });
    }
  });

  it('phase-illegal commands are rejected and change nothing', async () => {
    const a = await h.connect('Alice');
    await a.join();
    const s = await a.start();
    const r = () => randomUUID();

    expect(code(await a.call('start_study', { commandId: r(), roomId: ROOM_ID }))).toBe(
      'SESSION_ALREADY_ACTIVE',
    );
    expect(code(await a.call('resume_study', { commandId: r(), sessionId: s.id }))).toBe(
      'NOT_ON_BREAK',
    );
    await a.takeBreak(s.id, 5);
    expect(
      code(await a.call('take_break', { commandId: r(), sessionId: s.id, durationMinutes: 10 })),
    ).toBe('NOT_STUDYING');
    expect(code(await a.call('resume_study', { commandId: r(), sessionId: s.id }))).toBe(
      'BREAK_NOT_OVER',
    );
    h.advance(5 * MIN);
    expect(
      code(await a.call('take_break', { commandId: r(), sessionId: s.id, durationMinutes: 10 })),
    ).toBe('NOT_STUDYING');
    expect(code(await a.call('end_study', { commandId: r(), sessionId: randomUUID() }))).toBe(
      'STALE_SESSION',
    );

    const state = await a.sync();
    expect(state.session).toMatchObject({ id: s.id, phase: 'BREAK_OVER', version: 2 });
  });

  it('only 5, 10, 15 and 30-minute breaks; the client can never send timestamps or durations', async () => {
    const a = await h.connect('Alice');
    await a.join();
    const s = await a.start();
    for (const d of [0, 1, 20, 25, 45, 60, -5, 7.5, '10', null]) {
      const res = await a.call('take_break', {
        commandId: randomUUID(),
        sessionId: s.id,
        durationMinutes: d,
      });
      expect(code(res)).toBe('VALIDATION_ERROR');
      if (!res.ok)
        expect(res.error.details).toMatchObject({ session: { id: s.id, phase: 'STUDYING' } });
    }
    for (const field of ['studyMs', 'startedAt', 'endsAt', 'durationMs']) {
      expect(
        code(
          await a.call('take_break', {
            commandId: randomUUID(),
            sessionId: s.id,
            durationMinutes: 10,
            [field]: 1,
          }),
        ),
      ).toBe('VALIDATION_ERROR');
      expect(
        code(await a.call('end_study', { commandId: randomUUID(), sessionId: s.id, [field]: 1 })),
      ).toBe('VALIDATION_ERROR');
    }
    expect((await a.sync()).session).toMatchObject({ phase: 'STUDYING', version: 1 });
  });

  it('room rules: start only from the room you are in; resume only from a socket in the room', async () => {
    const outside = await h.connect('Alice');
    // Not in the room: a room start is rejected.
    expect(
      code(await outside.call('start_study', { commandId: randomUUID(), roomId: ROOM_ID })),
    ).toBe('MUST_START_IN_CURRENT_ROOM');
    // In the room (via a second tab): starting solo is rejected (I-07).
    const inRoom = await h.connect('Alice', { userId: outside.userId });
    await inRoom.join();
    expect(code(await outside.call('start_study', { commandId: randomUUID(), roomId: null }))).toBe(
      'MUST_START_IN_CURRENT_ROOM',
    );

    const s = await inRoom.start();
    await inRoom.takeBreak(s.id, 5);
    h.advance(5 * MIN);
    // D-7: a room session resumes only from a socket that shows the room.
    expect(
      code(await outside.call('resume_study', { commandId: randomUUID(), sessionId: s.id })),
    ).toBe('NOT_IN_SESSION_ROOM');
    // Closing actions are allowed from any socket.
    expect((await inRoom.resume(s.id)).phase).toBe('STUDYING');
    expect((await outside.end(s.id)).studiedMs).toBe(0);
  });

  it('unknown room, unattachable task, missing or invalid token and too many sockets', async () => {
    const a = await h.connect('Alice');
    expect(code(await a.call('join_room', { roomId: randomUUID() }))).toBe('NOT_FOUND');
    expect(code(await a.call('join_room', { roomId: 'not-a-uuid' }))).toBe('VALIDATION_ERROR');
    await a.join();
    expect(
      code(
        await a.call('start_study', {
          commandId: randomUUID(),
          roomId: ROOM_ID,
          taskId: randomUUID(),
        }),
      ),
    ).toBe('TASK_NOT_ATTACHABLE');

    expect(await h.connectExpectingError({})).toBe('UNAUTHENTICATED');
    expect(await h.connectExpectingError({ token: 'not-a-jwt' })).toBe('UNAUTHENTICATED');
    // The Phase 0 self-declared identity is gone.
    expect(await h.connectExpectingError({ userId: a.userId, name: 'Alice' })).toBe(
      'UNAUTHENTICATED',
    );
    for (let i = 0; i < 4; i++) await h.connect('Alice', { userId: a.userId }); // 5 sockets in total
    expect(await h.connectExpectingError({ token: h.tokenFor(a.userId) })).toBe(
      'TOO_MANY_CONNECTIONS',
    );
  });

  it('rate limiting per socket → RATE_LIMITED', async () => {
    await h.close();
    h = await startHarness({
      rateLimits: {
        timer: { capacity: 2, perMs: 60_000 },
        task: { capacity: 5, perMs: 60_000 },
        room: { capacity: 5, perMs: 60_000 },
        sync: { capacity: 5, perMs: 60_000 },
      },
    });
    const a = await h.connect('Alice');
    await a.join();
    const s = await a.start();
    expect(
      code(
        await a.call('take_break', {
          commandId: randomUUID(),
          sessionId: s.id,
          durationMinutes: 5,
        }),
      ),
    ).toBe('OK');
    expect(code(await a.call('end_study', { commandId: randomUUID(), sessionId: s.id }))).toBe(
      'RATE_LIMITED',
    );
  });
});

describe('AC-9 multiple simultaneous requests', () => {
  it('CT-1: 20 parallel start_study from 5 sockets of one user → exactly one session', async () => {
    const tabs = [await h.connect('Alice')];
    for (let i = 0; i < 4; i++) tabs.push(await h.connect('Alice', { userId: tabs[0]!.userId }));
    for (const t of tabs) await t.join();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tabs[i % 5]!.call('start_study', { commandId: randomUUID(), roomId: ROOM_ID }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'SESSION_ALREADY_ACTIVE')).toHaveLength(
      19,
    );
    const active = await testDb().studySession.count({
      where: { userId: tabs[0]!.userId, status: 'ACTIVE' },
    });
    expect(active).toBe(1);
  });

  it('CT-2: parallel take_break + end_study + resume_study are serialized into a consistent history', async () => {
    const a1 = await h.connect('Alice');
    const a2 = await h.connect('Alice', { userId: a1.userId });
    await a1.join();
    await a2.join();
    const s = await a1.start();
    h.advance(MIN);
    const mark = a1.mark();

    const r = () => randomUUID();
    const results = await Promise.all([
      a1.call('take_break', { commandId: r(), sessionId: s.id, durationMinutes: 5 }),
      a2.call('take_break', { commandId: r(), sessionId: s.id, durationMinutes: 10 }),
      a1.call('resume_study', { commandId: r(), sessionId: s.id }),
      a2.call('end_study', { commandId: r(), sessionId: s.id }),
      a1.call('end_study', { commandId: r(), sessionId: s.id }),
    ]);
    // Exactly one break and exactly one end were applied, whatever the interleaving.
    expect(results.filter((x, i) => x.ok && i < 2)).toHaveLength(1);
    expect(results.filter((x, i) => x.ok && i >= 3)).toHaveLength(1);
    expect(results[2]!.ok).toBe(false);
    await a1.sync();
    const versions = a1
      .since(mark, 'session_state')
      .map((p) => p.session?.version)
      .filter((v): v is number => v !== undefined);
    for (let i = 1; i < versions.length; i++)
      expect(versions[i]!).toBeGreaterThan(versions[i - 1]!);
    expect((await a1.sync()).session).toBeNull();
  });

  it('CT-3: the same commandId sent 10× in parallel is applied exactly once', async () => {
    const a = await h.connect('Alice');
    await a.join();
    const s = await a.start();
    const commandId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        a.call('take_break', { commandId, sessionId: s.id, durationMinutes: 10 }),
      ),
    );
    expect(results.every((x) => x.ok)).toBe(true);
    const sessions = results.map((x) =>
      x.ok ? (x.data as { session: SessionDto }).session : null,
    );
    expect(new Set(sessions.map((x) => JSON.stringify(x))).size).toBe(1);
    const db = testDb();
    expect(await db.sessionEvent.count({ where: { sessionId: s.id, type: 'BREAK_TAKEN' } })).toBe(
      1,
    );
    expect(await db.sessionEvent.count({ where: { commandId } })).toBe(1);
    expect(await db.studyBreak.count({ where: { sessionId: s.id } })).toBe(1);
  });

  it('two users acting at the same time never affect each other', async () => {
    const [a, b] = await twoInRoom(h);
    const [sa, sb] = await Promise.all([a.start(), b.start()]);
    h.advance(10 * MIN);
    await Promise.all([a.takeBreak(sa.id, 15), b.end(sb.id), a.sync(), b.sync()]);
    const [stateA, stateB] = await Promise.all([a.sync(), b.sync()]);
    expect(stateA.session).toMatchObject({ id: sa.id, phase: 'ON_BREAK', studyMsClosed: 10 * MIN });
    expect(stateB.session).toBeNull();
    expect((await h.server.sessions.summaryFor(b.userId, sb.id)).studiedMs).toBe(10 * MIN);
  });
});
