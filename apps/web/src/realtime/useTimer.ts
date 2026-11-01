/**
 * Timer commands for the caller's OWN session (R1). Each command carries a fresh commandId;
 * the client never sends instants or durations (R14). Rejections carry `details.session`, which
 * is applied immediately so the UI resyncs (API_DESIGN §3).
 */
import { useCallback, useState } from 'react';
import type { AckResponse, BreakMinutes, SessionDto, SessionSummaryDto } from '@studysync/shared';
import { newUuid } from '../lib/uuid';
import { useRealtime } from './RealtimeProvider';

export function useTimer() {
  const { session, call, applySession } = useRealtime();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(send: () => Promise<AckResponse<T>>): Promise<T | null> => {
      setPending(true);
      try {
        const res = await send();
        if (res.ok) {
          setError(null);
          return res.data;
        }
        setError(res.error.message);
        const details = res.error.details;
        if (details && 'session' in details) applySession(details.session as SessionDto | null);
        return null;
      } finally {
        setPending(false);
      }
    },
    [applySession],
  );

  const sessionId = session?.id ?? null;

  const start = useCallback(
    async (roomId: string | null, taskId: string | null = null) => {
      const data = await run(() => call('start_study', { commandId: newUuid(), roomId, taskId }));
      if (data) applySession(data.session, 'START');
      return data?.session ?? null;
    },
    [run, call, applySession],
  );

  const takeBreak = useCallback(
    async (durationMinutes: BreakMinutes) => {
      if (!sessionId) return;
      const data = await run(() =>
        call('take_break', { commandId: newUuid(), sessionId, durationMinutes }),
      );
      if (data) applySession(data.session, 'BREAK');
    },
    [run, call, applySession, sessionId],
  );

  const resume = useCallback(async () => {
    if (!sessionId) return;
    const data = await run(() => call('resume_study', { commandId: newUuid(), sessionId }));
    if (data) applySession(data.session, 'RESUME');
  }, [run, call, applySession, sessionId]);

  const end = useCallback(async (): Promise<SessionSummaryDto | null> => {
    if (!sessionId) return null;
    const data = await run(() => call('end_study', { commandId: newUuid(), sessionId }));
    if (data) applySession(null, 'END');
    return data?.summary ?? null;
  }, [run, call, applySession, sessionId]);

  const setTask = useCallback(
    async (taskId: string | null) => {
      if (!sessionId) return;
      const data = await run(() =>
        call('set_session_task', { commandId: newUuid(), sessionId, taskId }),
      );
      if (data) applySession(data.session, 'TASK_SET');
    },
    [run, call, applySession, sessionId],
  );

  return {
    session,
    pending,
    error,
    clearError: () => setError(null),
    start,
    takeBreak,
    resume,
    end,
    setTask,
  };
}
