import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MyRoomDto, RoomDto } from '@studysync/shared';
import { api, errorMessage } from '../lib/api';
import { Card, ErrorNote, Loading, inputClass, primaryButton } from './ui';

/** My Rooms (F-19), Create Room (F-11) and Join Room by code (F-14) on the dashboard. */
export function RoomsPanel() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<MyRoomDto[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRooms((await api<{ items: MyRoomDto[] }>('/rooms')).items);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const room = await api<RoomDto>('/rooms', { method: 'POST', body: { name } });
      navigate(`/rooms/${room.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const join = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const room = await api<RoomDto>('/rooms/join', { method: 'POST', body: { code } });
      navigate(`/rooms/${room.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card title="Rooms" testId="rooms">
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      {rooms === null && !error ? (
        <Loading label="Loading your rooms…" />
      ) : rooms && rooms.length > 0 ? (
        <ul className="divide-y divide-slate-100" data-testid="my-rooms">
          {rooms.map((room) => (
            <li
              key={room.id}
              data-testid="my-room"
              data-room-name={room.name}
              className="flex items-center justify-between py-2 text-sm"
            >
              <span>
                <span className="font-medium text-slate-900">{room.name}</span>
                <span className="ml-2 font-mono text-xs text-slate-500">{room.code}</span>
                <span className="ml-2 text-xs text-slate-400">
                  {room.memberCount} member{room.memberCount === 1 ? '' : 's'}
                </span>
              </span>
              <Link to={`/rooms/${room.id}`} className="font-semibold text-indigo-700 underline">
                Open
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">
          No rooms yet. Rooms show who is studying — everyone keeps their own timer.
        </p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <form onSubmit={(e) => void create(e)} className="flex gap-2" aria-label="Create a room">
          <input
            aria-label="Room name"
            data-testid="room-name-input"
            className={inputClass}
            placeholder="New room name"
            maxLength={60}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" data-testid="create-room" className={primaryButton}>
            Create
          </button>
        </form>
        <form onSubmit={(e) => void join(e)} className="flex gap-2" aria-label="Join a room">
          <input
            aria-label="Room code"
            data-testid="room-code-input"
            className={`${inputClass} font-mono uppercase`}
            placeholder="Code (e.g. DSA7K2)"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" data-testid="join-room" className={primaryButton}>
            Join
          </button>
        </form>
      </div>
    </Card>
  );
}
