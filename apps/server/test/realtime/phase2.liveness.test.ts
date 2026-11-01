/**
 * Phase 2 — liveness, disconnect grace, idle timeout and restart recovery.
 *   RT-4a (solo liveness), RT-4b (room liveness), RT-8 / CT-4 (idle), independence (R1),
 *   INT-RESILIENCE (sweeper, lease, crash + restart on the same database).
 * After every test the DATABASE_DESIGN §8 audits (A–H) must return no rows.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit, testDb } from '../helpers/db';
import { MIN, ROOM_ID, START, elapsedAt, startHarness, type Harness } from '../helpers/harness';
import { api, bearer } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

const SEC = 1_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sessionRow = (id: string) => testDb().studySession.findUniqueOrThrow({ where: { id } });
const eventsOf = async (id: string) =>
  (await testDb().sessionEvent.findMany({ where: { sessionId: id }, orderBy: { id: 'asc' } })).map(
    (e) => `${e.type}:${e.actor}`,
  );
/** Wait until every queued operation (disconnect handling, deadline triggers) has run. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await h.server.maintenance.exclusive(async () => undefined);
};

describe('RT-4a solo-session liveness (R9, D-7)', () => {
  it('any socket keeps a solo session live; the last one gone starts the 2-minute grace', async () => {
    const tab1 = await h.connect('Atharva', { member: false });
    const tab2 = await h.connect('Atharva', { userId: tab1.userId }); // e.g. history page
    const s = await tab1.start(null);
    h.advance(10 * MIN);
    await tab1.disconnect(); // closing one of two tabs
    await settle();
    expect((await sessionRow(s.id)).disconnectedAt).toBeNull();
    expect((await tab2.sync()).session).toMatchObject({ disconnectedAt: null });

    const lostAt = h.clock.now();
    await tab2.disconnect(); // the last socket
    await settle();
    expect((await sessionRow(s.id)).disconnectedAt?.toISOString()).toBe(iso(lostAt));

    // Back at +119 s: nothing lost, the gap is credited, the phase is unchanged (row 9).
    h.advance(119 * SEC);
    const back = await h.connect('Atharva', { userId: tab1.userId });
    await back.waitFor('session_state', (p) => p.cause === 'RECONNECTED');
    const state = await back.sync();
    expect(state.session).toMatchObject({ id: s.id, phase: 'STUDYING', disconnectedAt: null });
    expect(elapsedAt(state.session!, state.serverNow)).toBe(10 * MIN + 119 * SEC);
    expect(await eventsOf(s.id)).toEqual([
      'STARTED:USER',
      'DISCONNECTED:SYSTEM',
      'RECONNECTED:SYSTEM',
    ]);
  });

  it('no reconnect → auto-saved at the disconnect instant; the notice shows once (F-40)', async () => {
    const a = await h.connect('Atharva', { member: false });
    const s = await a.start(null);
    h.advance(25 * MIN);
    await a.disconnect();
    await settle();
    h.advance(2 * MIN - 1);
    await settle();
    expect((await sessionRow(s.id)).status).toBe('ACTIVE');
    h.advance(1);
    await settle();
    const row = await sessionRow(s.id);
    expect(row).toMatchObject({ status: 'ENDED', endReason: 'DISCONNECTED' });
    expect(row.endedAt?.toISOString()).toBe(iso(START + 25 * MIN)); // I-03: at the loss instant
    expect(await eventsOf(s.id)).toEqual([
      'STARTED:USER',
      'DISCONNECTED:SYSTEM',
      'GRACE_EXPIRED:SYSTEM',
    ]);

    const back = await h.connect('Atharva', { userId: a.userId });
    const connect = back.all('session_state')[0]!;
    expect(connect.session).toBeNull();
    expect(connect.lastAutoSaved).toEqual({
      sessionId: s.id,
      endReason: 'DISCONNECTED',
      endedAt: iso(START + 25 * MIN),
      studiedMs: 25 * MIN, // nothing after the disconnect counts
    });
    const token = h.tokenFor(a.userId);
    expect(
      (
        await api(h)
          .post(`/api/v1/sessions/${s.id}/summary-seen`)
          .set(...bearer(token))
      ).status,
    ).toBe(204);
    expect(
      (
        await api(h)
          .post(`/api/v1/sessions/${s.id}/summary-seen`)
          .set(...bearer(token))
      ).status,
    ).toBe(204);
    expect(
      (
        await api(h)
          .get('/api/v1/sessions/current')
          .set(...bearer(token))
      ).body.lastAutoSaved,
    ).toBeNull();
    const other = await h.connect('Bilal', { member: false });
    const foreign = await api(h)
      .post(`/api/v1/sessions/${s.id}/summary-seen`)
      .set(...bearer(h.tokenFor(other.userId)));
    expect(foreign.status).toBe(404);
  });
});

describe('RT-4b room-session liveness (R9, D-7) and independence (R1)', () => {
  it('only presence in the session’s room keeps it live; others are never affected', async () => {
    const room = await h.connect('Atharva');
    const dashboard = await h.connect('Atharva', { userId: room.userId }); // connected elsewhere
    const b = await h.connect('Bilal');
    await room.join();
    await b.join();
    const s = await room.start();
    const sb = await b.start();
    h.advance(5 * MIN);
    await room.takeBreak(s.id, 5);
    h.advance(4 * MIN);

    const mb = b.mark();
    const lostAt = h.clock.now();
    room.ok(await room.call('leave_room', { roomId: ROOM_ID })); // dashboard tab stays connected
    await settle();
    expect((await sessionRow(s.id)).disconnectedAt?.toISOString()).toBe(iso(lostAt));
    await b.waitFor(
      'status_changed',
      (p) => p.member.user.id === room.userId && p.member.reconnecting,
      mb,
    );

    // The break ends during grace. Opening a segment needs the room (row 21).
    h.advance(MIN);
    const res = await dashboard.call('resume_study', { commandId: randomUUID(), sessionId: s.id });
    expect(!res.ok && res.error.code).toBe('NOT_IN_SESSION_ROOM');

    // B's own timer was never touched by A's break or departure.
    const stateB = await b.sync();
    expect(stateB.session).toMatchObject({
      id: sb.id,
      phase: 'STUDYING',
      disconnectedAt: null,
      version: 1,
    });
    expect(b.since(mb, 'session_state')).toEqual([]);

    // Back in the room within 2 min of losing presence → reconnected, nothing lost.
    h.advance(MIN - 2 * SEC);
    await room.join();
    await settle();
    expect((await sessionRow(s.id)).disconnectedAt).toBeNull();
    expect((await room.sync()).session).toMatchObject({ phase: 'BREAK_OVER' });
  });

  it('room session: away > 2 min → auto-saved at the loss instant and shown Offline', async () => {
    const a = await h.connect('Atharva');
    const b = await h.connect('Bilal');
    await a.join();
    await b.join();
    const s = await a.start();
    h.advance(12 * MIN);
    const mb = b.mark();
    await a.disconnect();
    await settle();
    h.advance(2 * MIN);
    await b.waitFor('member_left', (p) => p.userId === a.userId, mb);
    await settle();
    const row = await sessionRow(s.id);
    expect(row).toMatchObject({ status: 'ENDED', endReason: 'DISCONNECTED' });
    expect(row.endedAt?.toISOString()).toBe(iso(START + 12 * MIN));
    expect(b.statusOf(a.userId)).toMatchObject({ status: 'OFFLINE' });
  });
});

describe('RT-8 / CT-4 idle timeout (R10)', () => {
  it('30 min in Break Over → auto-saved at exactly ends_at + 30 min; the member stays Idle', async () => {
    const a = await h.connect('Atharva');
    const b = await h.connect('Bilal');
    await a.join();
    await b.join();
    const s = await a.start();
    h.advance(20 * MIN);
    const brk = await a.takeBreak(s.id, 5);
    const endsAt = Date.parse(brk.break!.endsAt);
    h.advance(5 * MIN);
    await a.waitFor('session_state', (p) => p.cause === 'BREAK_OVER');
    const state = await a.sync();
    expect(state.session!.autoSaveAt).toBe(iso(endsAt + 30 * MIN)); // the UI's countdown
    const mark = a.mark();
    h.advance(30 * MIN);
    const saved = await a.waitFor('session_state', (p) => p.cause === 'AUTO_SAVED_IDLE', mark);
    expect(saved.session).toBeNull();
    expect(saved.lastAutoSaved).toMatchObject({
      sessionId: s.id,
      endReason: 'IDLE_TIMEOUT',
      studiedMs: 20 * MIN,
    });
    const row = await sessionRow(s.id);
    expect(row.endedAt?.toISOString()).toBe(iso(endsAt + 30 * MIN));
    await b.sync();
    expect(b.statusOf(a.userId)).toMatchObject({ status: 'IDLE', reconnecting: false }); // present, no session
  });

  it('CT-4: resume exactly at ends_at + 30 min → the deadline wins (NO_ACTIVE_SESSION)', async () => {
    const a = await h.connect('Atharva');
    await a.join();
    const s = await a.start();
    await a.takeBreak(s.id, 10);
    h.clock.advance(40 * MIN); // no scheduler run: the command itself reconciles first
    const res = await a.call('resume_study', { commandId: randomUUID(), sessionId: s.id });
    expect(!res.ok && res.error.code).toBe('NO_ACTIVE_SESSION');
    expect(await sessionRow(s.id)).toMatchObject({ status: 'ENDED', endReason: 'IDLE_TIMEOUT' });
  });
});

describe('INT-RESILIENCE: restart recovery (§13.9)', () => {
  it('crash mid-study, client back within 2 min of the last lease → nothing lost', async () => {
    const a = await h.connect('Atharva', { member: false });
    const s = await a.start(null);
    h.advance(10 * MIN);
    await h.server.maintenance.tick(); // lease refreshed at T+10 min
    const leaseAt = h.clock.now();
    await h.crashAndRestart(); // no disconnect is processed; the new instance knows nobody
    h.advance(95 * SEC);
    await h.server.maintenance.tick(); // stale lease → liveness lost at last_seen_at
    expect((await sessionRow(s.id)).disconnectedAt?.toISOString()).toBe(iso(leaseAt));
    const back = await h.connect('Atharva', { userId: a.userId });
    await back.waitFor('session_state', (p) => p.cause === 'RECONNECTED');
    const state = await back.sync();
    expect(state.session).toMatchObject({ id: s.id, phase: 'STUDYING' });
    expect(elapsedAt(state.session!, state.serverNow)).toBe(10 * MIN + 95 * SEC);
    expect(await eventsOf(s.id)).toEqual([
      'STARTED:USER',
      'LEASE_LOST:SYSTEM',
      'RECONNECTED:SYSTEM',
    ]);
  });

  it('crash with nobody coming back → auto-saved at the last lease, stamped at the deadline', async () => {
    const a = await h.connect('Atharva', { member: false });
    const s = await a.start(null);
    h.advance(10 * MIN);
    await h.server.maintenance.tick();
    const leaseAt = h.clock.now();
    await h.crashAndRestart();
    h.advance(60 * MIN); // the server was down for an hour
    await h.server.maintenance.tick(); // boot sweep
    const row = await sessionRow(s.id);
    expect(row).toMatchObject({ status: 'ENDED', endReason: 'DISCONNECTED' });
    expect(row.endedAt?.toISOString()).toBe(iso(leaseAt));
    const events = await testDb().sessionEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => [e.type, e.occurredAt.toISOString()])).toEqual([
      ['STARTED', iso(START)],
      ['LEASE_LOST', iso(leaseAt)],
      ['GRACE_EXPIRED', iso(leaseAt + 2 * MIN)], // as if processed on time (P5)
    ]);
  });

  it('a break survives a restart: the countdown is unchanged and idle expiry applies late', async () => {
    const a = await h.connect('Atharva', { member: false });
    const s = await a.start(null);
    h.advance(15 * MIN);
    const brk = await a.takeBreak(s.id, 10);
    await h.crashAndRestart();
    h.advance(MIN);
    const back = await h.connect('Atharva', { userId: a.userId });
    const connect = back.all('session_state')[0]!;
    expect(connect.session).toMatchObject({
      phase: 'ON_BREAK',
      break: { endsAt: brk.break!.endsAt },
    });
    expect(Date.parse(brk.break!.endsAt) - Date.parse(connect.serverNow)).toBe(9 * MIN);
    await back.disconnect();
    await settle();
    // Down again for a long time: the idle deadline (ends_at + 30) comes before the grace end?
    // No — grace (2 min) ends first: auto-saved at the disconnect instant.
    await h.crashAndRestart();
    h.advance(3 * 60 * MIN);
    await h.server.maintenance.tick();
    const row = await sessionRow(s.id);
    expect(row).toMatchObject({ status: 'ENDED', endReason: 'DISCONNECTED' });
    const summary = await h.server.sessions.summaryFor(a.userId, s.id);
    expect(summary.studiedMs).toBe(15 * MIN); // breaks never count
    expect(summary.breaks.count).toBe(1);
  });

  it('CT-12 (single instance): the sweeper and the deadline trigger save a session exactly once', async () => {
    const a = await h.connect('Atharva', { member: false });
    const s = await a.start(null);
    await a.disconnect();
    await settle();
    h.clock.advance(2 * MIN);
    await Promise.all([
      h.server.maintenance.tick(),
      h.server.sessions.reconcile(a.userId),
      h.server.maintenance.tick(),
    ]);
    h.server.scheduler.runDue();
    await settle();
    expect(await eventsOf(s.id)).toEqual([
      'STARTED:USER',
      'DISCONNECTED:SYSTEM',
      'GRACE_EXPIRED:SYSTEM',
    ]);
  });
});
