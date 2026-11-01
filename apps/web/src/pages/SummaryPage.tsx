import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { uuidSchema, type SessionSummaryDto } from '@studysync/shared';
import { SessionSummary } from '../components/SessionSummary';
import { ErrorNote, Loading } from '../components/ui';
import { api, errorMessage } from '../lib/api';

export function SummaryPage() {
  const { sessionId = '' } = useParams();
  const [summary, setSummary] = useState<SessionSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uuidSchema.safeParse(sessionId).success) {
      setError('Not found.');
      return;
    }
    api<SessionSummaryDto>(`/sessions/${sessionId}/summary`)
      .then(setSummary)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [sessionId]);

  return (
    <div className="space-y-4">
      <Link to="/history" className="text-sm text-indigo-700 underline">
        ← History
      </Link>
      <ErrorNote message={error} />
      {summary ? <SessionSummary summary={summary} /> : !error && <Loading />}
    </div>
  );
}
