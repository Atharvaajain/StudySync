/**
 * Phase 1 — solo timer, tasks and summaries over real sockets on PostgreSQL.
 *   INT-SESS (solo), INT-TASKS (personal), CT-1/CT-3/CT-8/CT-9, RT-1, RT-5, RT-9, SEC-2.
 * After every test the DATABASE_DESIGN §8 audits (A–H) must return no rows.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { SessionDto, SessionHistoryPage, TaskDto } from '@studysync/shared';
import { TEST_JWT_SECRET, audit, createUser, testDb } from '../helpers/db';
import { MIN, startHarness, type Harness, type TestClient } from '../helpers/harness';
import { api, bearer } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

const code = (res: { ok: boolean; error?: { code: string } }) => (res.ok ? 'OK' : res.error!.code);
const r = () => randomUUID();

async function addTask(c: TestClient, title: string): Promise<TaskDto> {
  return c.ok(await c.call('task_add', { id: r(), roomId: null, title })).task;
}

describe('INT-SESS solo session: start → break → Break Over → resume → end', () => {
  it('records segments only for study time and returns an exact summary', async () => {
    const a = await h.connect('Atharva', { timezone: 'Asia/Kolkata' });
    const task = await addTask(a, 'Graphs: Dijkstra');

    const started = a.ok(
      await a.call('start_study', { commandId: r(), roomId: null, taskId: task.id }),
    ).session;
    expect(started).toMatchObject({
      phase: 'STUDYING',
      roomId: null,
      roomName: null,
      task: { id: task.id, title: 'Graphs: Dijkstra' },
      studyMsClosed: 0,
      version: 1,
      startedAt: '2026-11-01T10:00:00.000Z',
    });

    h.advance(25 * MIN);
    const onBreak = await a.takeBreak(started.id, 10);
    expect(onBreak).toMatchObject({ phase: 'ON_BREAK', studyMsClosed: 25 * MIN });

    // No early resume (R5), and the rejection carries the session (§3).
    h.advance(10 * MIN - 1);
    const early = await a.call('resume_study', { commandId: r(), sessionId: started.id });
    expect(code(early)).toBe('BREAK_NOT_OVER');
    if (!early.ok) {
      expect(early.error.details).toMatchObject({
        breakEndsAt: '2026-11-01T10:35:00.000Z',
        session: { id: started.id, phase: 'ON_BREAK' },
      });
    }

    const mark = a.mark();
    h.advance(1);
    const over = await a.waitFor('session_state', (p) => p.cause === 'BREAK_OVER', mark);
    expect(over.session).toMatchObject({ phase: 'BREAK_OVER', currentSegmentStartedAt: null });

    // Nothing resumes by itself.
    h.advance(7 * MIN);
    expect((await a.sync()).session).toMatchObject({ phase: 'BREAK_OVER' });

    // Complete a task during the session (I-13), then resume and study 15 more minutes.
    a.ok(await a.call('task_toggle', { taskId: task.id, done: true }));
    const resumed = await a.resume(started.id);
    expect(resumed).toMatchObject({ phase: 'STUDYING', studyMsClosed: 25 * MIN });
    h.advance(15 * MIN);
    const summary = await a.end(started.id);
    expect(summary).toEqual({
      id: started.id,
      startedAt: '2026-11-01T10:00:00.000Z',
      endedAt: '2026-11-01T10:57:00.000Z', // 25 + 10 + 7 + 15 min
      endReason: 'USER',
      studiedMs: 40 * MIN, // R3: the 10-min break and 7 min of Break Over never count
      breaks: { count: 1, totalMs: 10 * MIN }, // I-12: capped at the chosen length
      where: { roomId: null, roomName: null, movedFromSolo: false },
      task: { id: task.id, title: 'Graphs: Dijkstra' },
      completedTasks: [{ id: task.id, title: 'Graphs: Dijkstra' }],
    });

    // Rows: two segments with the user's timezone snapshot, one break, five events.
    const db = testDb();
    const segments = await db.studySegment.findMany({
      where: { sessionId: started.id },
      orderBy: { startedAt: 'asc' },
    });
    expect(
      segments.map((g) => [
        g.timezone,
        g.roomId,
        g.endReason,
        g.endedAt!.getTime() - g.startedAt.getTime(),
      ]),
    ).toEqual([
      ['Asia/Kolkata', null, 'BREAK', 25 * MIN],
      ['Asia/Kolkata', null, 'ENDED_BY_USER', 15 * MIN],
    ]);
    const events = await db.sessionEvent.findMany({
      where: { sessionId: started.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => [e.type, e.actor, e.fromPhase, e.toPhase])).toEqual([
      ['STARTED', 'USER', 'NO_SESSION', 'STUDYING'],
      ['BREAK_TAKEN', 'USER', 'STUDYING', 'ON_BREAK'],
      ['RESUMED', 'USER', 'BREAK_OVER', 'STUDYING'],
      ['ENDED', 'USER', 'STUDYING', 'ENDED'],
    ]);

    // REST reads: summary, current, history.
    const token = h.tokenFor(a.userId);
    const rest = await api(h)
      .get(`/api/v1/sessions/${started.id}/summary`)
      .set(...bearer(token));
    expect(rest.body).toEqual(summary);
    const current = await api(h)
      .get('/api/v1/sessions/current')
      .set(...bearer(token));
    expect(current.body).toMatchObject({ session: null, lastAutoSaved: null });
  });

  it('every phase-illegal command is rejected with details.session and changes nothing', async () => {
    const a = await h.connect('Atharva');
    const s = await a.start(null);
    expect(code(await a.call('start_study', { commandId: r(), roomId: null }))).toBe(
      'SESSION_ALREADY_ACTIVE',
    );
    expect(code(await a.call('resume_study', { commandId: r(), sessionId: s.id }))).toBe(
      'NOT_ON_BREAK',
    );
    expect(code(await a.call('end_study', { commandId: r(), sessionId: r() }))).toBe(
      'STALE_SESSION',
    );
    const bad = await a.call('take_break', {
      commandId: r(),
      sessionId: s.id,
      durationMinutes: 20,
    });
    expect(code(bad)).toBe('VALIDATION_ERROR');
    if (!bad.ok) expect(bad.error.details).toMatchObject({ session: { id: s.id, version: 1 } });
    expect((await a.sync()).session).toMatchObject({ id: s.id, phase: 'STUDYING', version: 1 });
  });

  it('C3: a replayed commandId returns the same outcome; reusing it for another command fails', async () => {
    const a = await h.connect('Atharva');
    const s = await a.start(null);
    h.advance(30 * MIN);
    const commandId = r();
    const first = a.ok(await a.call('end_study', { commandId, sessionId: s.id })).summary;
    const again = a.ok(await a.call('end_study', { commandId, sessionId: s.id })).summary;
    expect(again).toEqual(first);
    expect(first.studiedMs).toBe(30 * MIN);
    expect(
      code(await a.call('take_break', { commandId, sessionId: s.id, durationMinutes: 5 })),
    ).toBe('VALIDATION_ERROR');
    expect(await testDb().sessionEvent.count({ where: { commandId } })).toBe(1);
  });

  it('CT-1: 20 parallel solo starts from 5 tabs of one user → one session; CT-3 replays', async () => {
    const tabs = [await h.connect('Atharva')];
    for (let i = 0; i < 4; i++) tabs.push(await h.connect('Atharva', { userId: tabs[0]!.userId }));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tabs[i % 5]!.call('start_study', { commandId: r(), roomId: null }),
      ),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => code(x) === 'SESSION_ALREADY_ACTIVE')).toHaveLength(19);
    expect(
      await testDb().studySession.count({ where: { userId: tabs[0]!.userId, status: 'ACTIVE' } }),
    ).toBe(1);
  });
});

describe('set_session_task (F-29, I-17)', () => {
  it('attaches, switches and clears; only your own live personal tasks are attachable', async () => {
    const a = await h.connect('Atharva');
    const b = await h.connect('Bilal');
    const t1 = await addTask(a, 'Arrays');
    const t2 = await addTask(a, 'Trees');
    const foreign = await addTask(b, 'Not yours');
    const s = await a.start(null);

    const set = (taskId: string | null) =>
      a.call('set_session_task', { commandId: r(), sessionId: s.id, taskId });
    expect(a.ok(await set(t1.id)).session).toMatchObject({
      task: { id: t1.id },
      phase: 'STUDYING',
    });
    expect(a.ok(await set(t2.id)).session.task).toEqual({ id: t2.id, title: 'Trees' });
    expect(code(await set(foreign.id))).toBe('TASK_NOT_ATTACHABLE');
    expect(code(await set(r()))).toBe('TASK_NOT_ATTACHABLE');
    a.ok(await a.call('task_delete', { taskId: t1.id }));
    expect(code(await set(t1.id))).toBe('TASK_NOT_ATTACHABLE');
    expect(
      code(await a.call('start_study', { commandId: r(), roomId: null, taskId: foreign.id })),
    ).toBe('SESSION_ALREADY_ACTIVE');
    const cleared = a.ok(await set(null)).session;
    expect(cleared).toMatchObject({ task: null, phase: 'STUDYING', version: 4 });

    // Starting with someone else's task is rejected and creates nothing.
    await a.end(s.id);
    expect(
      code(await a.call('start_study', { commandId: r(), roomId: null, taskId: foreign.id })),
    ).toBe('TASK_NOT_ATTACHABLE');
    expect((await a.sync()).session).toBeNull();
  });
});

describe('INT-TASKS personal tasks', () => {
  it('add is idempotent, toggle has set semantics, update is versioned, delete is soft', async () => {
    const a = await h.connect('Atharva');
    const id = r();
    const payload = {
      id,
      roomId: null,
      title: '  DP practice  ',
      description: 'LeetCode 70',
      dueDate: '2026-11-05',
    };
    const added = a.ok(await a.call('task_add', payload)).task;
    expect(added).toMatchObject({
      id,
      roomId: null,
      title: 'DP practice',
      description: 'LeetCode 70',
      dueDate: '2026-11-05',
      status: 'TODO',
      version: 1,
      createdBy: { id: a.userId, name: 'Atharva' },
      completedBy: null,
      completedAt: null,
    });
    expect(a.ok(await a.call('task_add', payload)).task).toEqual(added); // replay
    expect(await testDb().task.count({ where: { userId: a.userId } })).toBe(1);

    const done = a.ok(await a.call('task_toggle', { taskId: id, done: true })).task;
    expect(done).toMatchObject({ status: 'DONE', version: 2, completedBy: { id: a.userId } });
    expect(done.completedAt).toBe('2026-11-01T10:00:00.000Z');
    expect(a.ok(await a.call('task_toggle', { taskId: id, done: true })).task.version).toBe(2);
    const undone = a.ok(await a.call('task_toggle', { taskId: id, done: false })).task;
    expect(undone).toMatchObject({
      status: 'TODO',
      version: 3,
      completedBy: null,
      completedAt: null,
    });

    const edited = a.ok(
      await a.call('task_update', { taskId: id, expectedVersion: 3, title: 'DP', dueDate: null }),
    ).task;
    expect(edited).toMatchObject({
      title: 'DP',
      dueDate: null,
      description: 'LeetCode 70',
      version: 4,
    });
    const stale = await a.call('task_update', { taskId: id, expectedVersion: 3, title: 'Old' });
    expect(code(stale)).toBe('VERSION_CONFLICT');
    if (!stale.ok)
      expect(stale.error.details).toMatchObject({ current: { title: 'DP', version: 4 } });

    const list = await api(h)
      .get('/api/v1/tasks')
      .set(...bearer(h.tokenFor(a.userId)));
    expect(list.body.items.map((t: TaskDto) => t.id)).toEqual([id]);
    expect(a.ok(await a.call('task_delete', { taskId: id }))).toEqual({});
    expect(a.ok(await a.call('task_delete', { taskId: id }))).toEqual({}); // idempotent
    const after = await api(h)
      .get('/api/v1/tasks')
      .set(...bearer(h.tokenFor(a.userId)));
    expect(after.body.items).toEqual([]);
    expect(code(await a.call('task_toggle', { taskId: id, done: true }))).toBe('NOT_FOUND');
    expect((await testDb().task.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  });

  it('lists TODO first, then by due date and creation; filters by status', async () => {
    const a = await h.connect('Atharva');
    const mk = async (title: string, dueDate: string | null) =>
      a.ok(await a.call('task_add', { id: r(), roomId: null, title, dueDate })).task;
    const later = await mk('later', '2026-12-01');
    h.advance(1);
    const none = await mk('no date', null);
    h.advance(1);
    const soon = await mk('soon', '2026-11-02');
    a.ok(await a.call('task_toggle', { taskId: later.id, done: true }));
    const token = h.tokenFor(a.userId);
    const all = await api(h)
      .get('/api/v1/tasks')
      .set(...bearer(token));
    expect(all.body.items.map((t: TaskDto) => t.title)).toEqual(['soon', 'no date', 'later']);
    const todo = await api(h)
      .get('/api/v1/tasks?status=TODO')
      .set(...bearer(token));
    expect(todo.body.items.map((t: TaskDto) => t.id)).toEqual([soon.id, none.id]);
    expect(
      (
        await api(h)
          .get('/api/v1/tasks?status=OPEN')
          .set(...bearer(token))
      ).status,
    ).toBe(400);
  });

  it('SEC-2: another user can never read or change my tasks; non-members never touch room tasks', async () => {
    const a = await h.connect('Atharva');
    const b = await h.connect('Bilal');
    const task = await addTask(a, 'Mine');
    expect(code(await b.call('task_toggle', { taskId: task.id, done: true }))).toBe('NOT_FOUND');
    expect(
      code(await b.call('task_update', { taskId: task.id, expectedVersion: 1, title: 'x' })),
    ).toBe('NOT_FOUND');
    expect(code(await b.call('task_delete', { taskId: task.id }))).toBe('NOT_FOUND');
    expect(code(await b.call('task_add', { id: task.id, roomId: null, title: 'steal id' }))).toBe(
      'ID_CONFLICT',
    );
    const bList = await api(h)
      .get('/api/v1/tasks')
      .set(...bearer(h.tokenFor(b.userId)));
    expect(bList.body.items).toEqual([]);
    expect(code(await a.call('task_add', { id: r(), roomId: r(), title: 'room task' }))).toBe(
      'NOT_FOUND', // not a member of that room (no existence leak)
    );
    for (const bad of [
      { id: r(), roomId: null, title: '' },
      { id: r(), roomId: null, title: 'x'.repeat(201) },
      { id: 'nope', roomId: null, title: 'x' },
      { id: r(), roomId: null, title: 'x', dueDate: '2026-13-01' },
      { id: r(), roomId: null, title: 'x', status: 'DONE' },
    ]) {
      expect(code(await a.call('task_add', bad)), JSON.stringify(bad)).toBe('VALIDATION_ERROR');
    }
  });

  it('CT-8 / CT-9: parallel toggles converge; parallel edits on one version → one wins', async () => {
    const a1 = await h.connect('Atharva');
    const a2 = await h.connect('Atharva', { userId: a1.userId });
    const task = await addTask(a1, 'Race');
    const toggles = await Promise.all([
      a1.call('task_toggle', { taskId: task.id, done: true }),
      a2.call('task_toggle', { taskId: task.id, done: true }),
    ]);
    const versions = toggles.map((t) => (t.ok ? t.data.task.version : -1));
    expect(versions).toEqual([2, 2]);
    const edits = await Promise.all([
      a1.call('task_update', { taskId: task.id, expectedVersion: 2, title: 'one' }),
      a2.call('task_update', { taskId: task.id, expectedVersion: 2, title: 'two' }),
    ]);
    expect(edits.map(code).sort()).toEqual(['OK', 'VERSION_CONFLICT']);
  });

  it('RT-5: personal_task_updated reaches all my devices and nobody else', async () => {
    const a1 = await h.connect('Atharva');
    const a2 = await h.connect('Atharva', { userId: a1.userId });
    const b = await h.connect('Bilal');
    const markA2 = a2.mark();
    const markB = b.mark();
    const task = await addTask(a1, 'Sync me');
    const push = await a2.waitFor('personal_task_updated', (p) => p.taskId === task.id, markA2);
    expect(push).toMatchObject({ action: 'added', task: { id: task.id, title: 'Sync me' } });
    a1.ok(await a1.call('task_delete', { taskId: task.id }));
    await a2.waitFor('personal_task_updated', (p) => p.action === 'deleted', markA2);
    await b.sync();
    expect(b.since(markB, 'personal_task_updated')).toEqual([]);
  });
});

describe('RT-1 / RT-5 / RT-9 sockets', () => {
  it('RT-1: the handshake rejects missing, forged, expired and unknown-user tokens', async () => {
    const now = Math.floor(h.clock.now() / 1000);
    const user = await createUser(testDb());
    const claims = { sub: user.id, iss: 'studysync', aud: 'studysync-web', iat: now };
    expect(await h.connectExpectingError({})).toBe('UNAUTHENTICATED');
    expect(
      await h.connectExpectingError({
        token: jwt.sign({ ...claims, exp: now - 1 }, TEST_JWT_SECRET),
      }),
    ).toBe('TOKEN_EXPIRED');
    expect(
      await h.connectExpectingError({
        token: jwt.sign({ ...claims, exp: now + 60 }, 'wrong-secret-wrong-secret-wrong-secret'),
      }),
    ).toBe('UNAUTHENTICATED');
    expect(
      await h.connectExpectingError({
        token: jwt.sign({ ...claims, sub: randomUUID(), exp: now + 60 }, TEST_JWT_SECRET),
      }),
    ).toBe('UNAUTHENTICATED');
  });

  it('RT-5: session_state reaches all of my sockets and none of anyone else’s (R1)', async () => {
    const a1 = await h.connect('Atharva');
    const a2 = await h.connect('Atharva', { userId: a1.userId });
    const b = await h.connect('Bilal');
    const m2 = a2.mark();
    const mb = b.mark();
    const s = await a1.start(null);
    await a2.waitFor('session_state', (p) => p.cause === 'START' && p.session?.id === s.id, m2);
    await b.sync();
    expect(b.since(mb, 'session_state')).toEqual([]);
    expect((await b.sync()).session).toBeNull(); // B's timer is untouched
  });

  it('RT-9: auth_renew extends a socket; expiry without renewal → auth_expired + disconnect', async () => {
    await h.close();
    h = await startHarness({ accessTokenTtlSec: 900 });
    const a = await h.connect('Atharva');
    const s = await a.start(null);
    h.advance(10 * MIN);
    const renewed = a.ok(await a.call('auth_renew', { token: h.tokenFor(a.userId) }));
    expect(renewed.expiresAt).toBe('2026-11-01T10:25:00.000Z');
    expect(code(await a.call('auth_renew', { token: h.tokenFor(randomUUID()) }))).toBe(
      'UNAUTHENTICATED',
    );
    h.advance(10 * MIN); // past the first token's expiry: still connected
    expect((await a.sync()).session).toMatchObject({ id: s.id, phase: 'STUDYING' });

    const gone = new Promise<void>((resolve) => a.socket.once('disconnect', () => resolve()));
    h.advance(5 * MIN);
    await a.waitFor('auth_expired');
    await gone;
    // Reconnect with a fresh token: the timer was never affected.
    const again = await h.connect('Atharva', { userId: a.userId });
    expect(again.all('session_state')[0]!.session).toMatchObject({
      id: s.id,
      phase: 'STUDYING',
      studyMsClosed: 0,
    });
  });
});

describe('REST session reads and SEC-2', () => {
  it('history pages newest first; summaries of other users are 404', async () => {
    const a = await h.connect('Atharva');
    const b = await h.connect('Bilal');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await a.start(null);
      h.advance((i + 1) * MIN);
      await a.end(s.id);
      ids.push(s.id);
      h.advance(MIN);
    }
    const live: SessionDto = await a.start(null);
    h.advance(2 * MIN);
    const token = h.tokenFor(a.userId);
    const page1 = (
      await api(h)
        .get('/api/v1/sessions?limit=2')
        .set(...bearer(token))
    ).body as SessionHistoryPage;
    expect(page1.items.map((x) => [x.id, x.studiedMs, x.endReason])).toEqual([
      [live.id, 2 * MIN, null],
      [ids[2], 3 * MIN, 'USER'],
    ]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (
      await api(h)
        .get(`/api/v1/sessions?limit=2&cursor=${page1.nextCursor}`)
        .set(...bearer(token))
    ).body as SessionHistoryPage;
    expect(page2.items.map((x) => x.id)).toEqual([ids[1], ids[0]]);
    expect(page2.nextCursor).toBeNull();

    // A live partial summary for the active session.
    const partial = await api(h)
      .get(`/api/v1/sessions/${live.id}/summary`)
      .set(...bearer(token));
    expect(partial.body).toMatchObject({ endedAt: null, endReason: null, studiedMs: 2 * MIN });
    const current = await api(h)
      .get('/api/v1/sessions/current')
      .set(...bearer(token));
    expect(current.body.session).toMatchObject({ id: live.id, phase: 'STUDYING' });

    const other = h.tokenFor(b.userId);
    const foreign = await api(h)
      .get(`/api/v1/sessions/${ids[0]}/summary`)
      .set(...bearer(other));
    expect([foreign.status, foreign.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect(
      (
        await api(h)
          .get('/api/v1/sessions')
          .set(...bearer(other))
      ).body.items,
    ).toEqual([]);
    expect(
      (
        await api(h)
          .get('/api/v1/sessions/nope/summary')
          .set(...bearer(other))
      ).status,
    ).toBe(400);
    expect(
      (
        await api(h)
          .get('/api/v1/sessions?cursor=garbage')
          .set(...bearer(token))
      ).status,
    ).toBe(400);
    expect((await api(h).get('/api/v1/sessions')).status).toBe(401);
    expect(code(await b.call('end_study', { commandId: r(), sessionId: live.id }))).toBe(
      'NO_ACTIVE_SESSION',
    );
  });
});
