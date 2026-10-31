import { useEffect, useState } from 'react';
import { serverClock } from './serverClock';

/** Re-renders periodically with the corrected server "now" (display only). */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(serverClock.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
