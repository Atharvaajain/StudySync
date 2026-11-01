import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { RoomDto } from '@studysync/shared';
import { ErrorNote } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';

/** /join/:code — a share link: membership by code, then the room screen. */
export function JoinPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<RoomDto>('/rooms/join', { method: 'POST', body: { code } })
      .then((room) => navigate(`/rooms/${room.id}`, { replace: true }))
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError && e.code === 'SESSION_IN_OTHER_ROOM'
            ? 'You are studying in another room. End Study there first, then join this room.'
            : errorMessage(e),
        ),
      );
  }, [code, navigate]);

  return (
    <div className="space-y-4">
      {error ? (
        <>
          <ErrorNote message={error} />
          <Link to="/" className="text-sm text-indigo-700 underline">
            Back to the dashboard
          </Link>
        </>
      ) : (
        <p className="text-slate-500">Joining room {code.toUpperCase()}…</p>
      )}
    </div>
  );
}
