import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { displayPhase, uuidSchema } from '@studysync/shared';
import { MembersList } from '../components/MembersList';
import { SessionSummary } from '../components/SessionSummary';
import { TimerPanel } from '../components/TimerPanel';
import { ErrorNote } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { useNow } from '../lib/useNow';
import { useStudyRoom } from '../realtime/useStudyRoom';
import { useTimer } from '../realtime/useTimer';
import type { SessionSummaryDto } from '@studysync/shared';

const PHASE_ANNOUNCEMENT = {
  NO_SESSION: 'Not studying.',
  STUDYING: 'Studying. Your timer is running.',
  ON_BREAK: 'On break.',
  BREAK_OVER: 'Break over. Click Resume when you are ready.',
} as const;

/** The room screen (Phase 0 prototype room): presence and statuses, your own timer. */
export function RoomPage() {
  const { roomId = '' } = useParams();
  if (!uuidSchema.safeParse(roomId).success) {
    return <ErrorNote message="This room does not exist." />;
  }
  return <Room key={roomId} roomId={roomId} />;
}

function Room({ roomId }: { roomId: string }) {
  const { user } = useAuth();
  const { state, join, leave, dismissError } = useStudyRoom(roomId);
  const timer = useTimer();
  const now = useNow();
  const [summary, setSummary] = useState<SessionSummaryDto | null>(null);
  const members = useMemo(() => Object.values(state.members), [state.members]);
  const session = timer.session;
  const phase = session ? displayPhase(session, now) : 'NO_SESSION';

  // Announce phase changes (not every tick) for screen readers.
  const [announcement, setAnnouncement] = useState('');
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (lastPhase.current !== phase) {
      lastPhase.current = phase;
      setAnnouncement(PHASE_ANNOUNCEMENT[phase]);
    }
  }, [phase]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900" data-testid="room-name">
            {state.room?.name ?? 'Room'}
          </h1>
          <p className="text-sm text-slate-500">
            Code:{' '}
            <span className="font-mono font-semibold tracking-wider">
              {state.room?.code ?? '—'}
            </span>
            {' · '}You are <strong className="text-slate-700">{user?.name}</strong>
          </p>
        </div>
        {state.inRoom && (
          <button
            type="button"
            data-testid="leave-room"
            onClick={() => void leave()}
            className="text-sm text-slate-600 underline"
          >
            Leave
          </button>
        )}
      </header>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <ErrorNote message={state.error} onDismiss={dismissError} />
      <ErrorNote message={timer.error} onDismiss={timer.clearError} />

      {!state.inRoom ? (
        <section className="rounded-lg bg-white p-6 text-center shadow-sm" data-testid="left-room">
          <p className="text-slate-700">You are not in this room right now.</p>
          <button
            type="button"
            data-testid="rejoin-room"
            onClick={() => void join()}
            className="mt-3 rounded-md bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700"
          >
            {state.room ? 'Rejoin room' : 'Joining…'}
          </button>
        </section>
      ) : (
        <>
          {summary && (
            <SessionSummary summary={summary} onDismiss={() => setSummary(null)} linkToDetails />
          )}
          <TimerPanel
            session={session}
            now={now}
            pending={timer.pending}
            onStart={() => {
              setSummary(null);
              void timer.start(roomId);
            }}
            onBreak={(minutes) => void timer.takeBreak(minutes)}
            onResume={() => void timer.resume()}
            onEnd={() => void timer.end().then((s) => s && setSummary(s))}
            taskSlot={
              session?.task ? (
                <p className="text-sm text-slate-600">
                  Working on <strong>{session.task.title}</strong>
                </p>
              ) : undefined
            }
          />
          <MembersList members={members} myUserId={user?.id ?? ''} now={now} />
          <p className="text-center text-xs text-slate-400">
            Everyone has their own timer. A break or a departure never affects anyone else.
          </p>
        </>
      )}
    </div>
  );
}
