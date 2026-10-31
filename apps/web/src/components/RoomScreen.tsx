import { useEffect, useMemo, useRef, useState } from 'react';
import { PROTOTYPE_ROOM, displayPhase, type PrototypeIdentity } from '@studysync/shared';
import { useNow } from '../lib/useNow';
import { useStudyRoom } from '../realtime/useStudyRoom';
import { MembersList } from './MembersList';
import { SessionSummary } from './SessionSummary';
import { TimerPanel } from './TimerPanel';

interface Props {
  identity: PrototypeIdentity;
  onSwitchUser: () => void;
}

const PHASE_ANNOUNCEMENT = {
  NO_SESSION: 'Not studying.',
  STUDYING: 'Studying. Your timer is running.',
  ON_BREAK: 'On break.',
  BREAK_OVER: 'Break over. Click Resume when you are ready.',
} as const;

export function RoomScreen({ identity, onSwitchUser }: Props) {
  const { state, actions } = useStudyRoom(identity);
  const now = useNow();
  const members = useMemo(() => Object.values(state.members), [state.members]);
  const phase = state.session ? displayPhase(state.session, now) : 'NO_SESSION';

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
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900" data-testid="room-name">
            {state.room?.name ?? PROTOTYPE_ROOM.name}
          </h1>
          <p className="text-sm text-slate-500">
            Code:{' '}
            <span className="font-mono font-semibold tracking-wider">{PROTOTYPE_ROOM.code}</span>
            {' · '}You are <strong className="text-slate-700">{identity.name}</strong>
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span
            data-testid="connection"
            data-connection={state.connection}
            className={state.connection === 'connected' ? 'text-emerald-700' : 'text-amber-700'}
          >
            {state.connection === 'connected'
              ? '● Live'
              : state.connection === 'failed'
                ? '● Offline'
                : '● Reconnecting…'}
          </span>
          {state.inRoom ? (
            <button
              type="button"
              data-testid="leave-room"
              onClick={() => void actions.leaveRoom()}
              className="text-slate-600 underline"
            >
              Leave
            </button>
          ) : (
            <button type="button" onClick={onSwitchUser} className="text-slate-600 underline">
              Switch user
            </button>
          )}
        </div>
      </header>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {state.connectionError && state.connection !== 'connected' && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          Connection problem: {state.connectionError}
        </p>
      )}

      {state.error && (
        <p
          role="alert"
          data-testid="error"
          className="flex justify-between rounded-md bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <span>{state.error}</span>
          <button type="button" onClick={actions.dismissError} className="underline">
            Dismiss
          </button>
        </p>
      )}

      {!state.inRoom ? (
        <section className="rounded-lg bg-white p-6 text-center shadow-sm" data-testid="left-room">
          <p className="text-slate-700">You are not in {PROTOTYPE_ROOM.name}.</p>
          <button
            type="button"
            data-testid="rejoin-room"
            onClick={() => void actions.rejoinRoom()}
            className="mt-3 rounded-md bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700"
          >
            {state.room ? 'Rejoin room' : 'Joining…'}
          </button>
        </section>
      ) : (
        <>
          {state.summary && (
            <SessionSummary summary={state.summary} onDismiss={actions.dismissSummary} />
          )}
          <TimerPanel
            session={state.session}
            now={now}
            pending={state.pending}
            onStart={() => void actions.startStudy()}
            onBreak={(minutes) => void actions.takeBreak(minutes)}
            onResume={() => void actions.resumeStudy()}
            onEnd={() => void actions.endStudy()}
          />
          <MembersList members={members} myUserId={identity.userId} now={now} />
          <p className="text-center text-xs text-slate-400">
            Everyone has their own timer. A break or a departure never affects anyone else.
          </p>
        </>
      )}
    </main>
  );
}
