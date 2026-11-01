import { useMemo, useState, type FormEvent } from 'react';
import { canonicalTimeZone, type UserDto } from '@studysync/shared';
import { useAuth } from '../auth/AuthContext';
import { Card, ErrorNote, inputClass, primaryButton } from '../components/ui';
import { api, errorMessage } from '../lib/api';

function timezones(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  // Current IANA names only (legacy browser ids are mapped), each listed once.
  const all = [
    ...new Set((intl.supportedValuesOf?.('timeZone') ?? []).map(canonicalTimeZone)),
  ].sort();
  return all.includes(current) ? all : [current, ...all];
}

/** Profile: name and timezone (F-03). A timezone change applies to new study only (D-6). */
export function SettingsPage() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const zones = useMemo(() => timezones(user?.timezone ?? 'UTC'), [user?.timezone]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    try {
      const updated = await api<UserDto>('/users/me', {
        method: 'PATCH',
        body: { name, timezone },
      });
      setUser(updated);
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
      <Card title="Profile">
        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          <ErrorNote message={error} />
          {saved && (
            <p role="status" className="text-sm text-emerald-700" data-testid="settings-saved">
              Saved.
            </p>
          )}
          <label className="block text-sm text-slate-700">
            Name
            <input
              className={inputClass}
              name="name"
              maxLength={50}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm text-slate-700">
            Timezone
            <select
              className={inputClass}
              name="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-slate-500">
            Your days are counted in this timezone. Changing it never rewrites past days.
          </p>
          <p className="text-xs text-slate-500">Email: {user?.email}</p>
          <button type="submit" className={primaryButton}>
            Save
          </button>
        </form>
      </Card>
    </div>
  );
}
