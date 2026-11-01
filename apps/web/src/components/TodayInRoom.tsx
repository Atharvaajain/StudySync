import { useCallback, useEffect, useState } from 'react';
import type { TodayInRoomDto } from '@studysync/shared';
import { api } from '../lib/api';
import { useRealtime } from '../realtime/RealtimeProvider';
import { Card, formatTotal } from './ui';

const REFRESH_MS = 60_000;

/**
 * Today in this room (F-23, I-09): each member's own local today, in this room. Ticks live
 * from `studyingSince`; refetched every 60 s and whenever a member's status changes.
 */
export function TodayInRoom({ roomId, now }: { roomId: string; now: number }) {
  const { socket } = useRealtime();
  const [today, setToday] = useState<TodayInRoomDto | null>(null);
  const load = useCallback(async () => {
    try {
      setToday(await api<TodayInRoomDto>(`/rooms/${roomId}/today`));
    } catch {
      // keep the last values; the next refresh retries
    }
  }, [roomId]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);
  useEffect(() => {
    if (!socket) return;
    let pending: number | undefined;
    const onChange = ({ roomId: r }: { roomId: string }) => {
      if (r !== roomId) return;
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void load(), 300);
    };
    socket.on('status_changed', onChange);
    return () => {
      window.clearTimeout(pending);
      socket.off('status_changed', onChange);
    };
  }, [socket, roomId, load]);

  return (
    <Card title="Today in this room" testId="today-in-room">
      {!today || today.members.length === 0 ? (
        <p className="text-sm text-slate-500">Nobody has studied here today yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {today.members.map((m) => {
            const live = m.studyingSince
              ? Math.max(
                  0,
                  now - Math.max(Date.parse(today.serverNow), Date.parse(m.studyingSince)),
                )
              : 0;
            return (
              <li
                key={m.user.id}
                data-testid="today-member"
                data-user-name={m.user.name}
                className="flex justify-between"
              >
                <span>
                  {m.studyingSince ? '🟢 ' : ''}
                  {m.user.name}
                </span>
                <span className="font-mono">{formatTotal(m.todayMs + live)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-400">Each member’s own day, in their own timezone.</p>
    </Card>
  );
}
