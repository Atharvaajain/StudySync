import { useState, type FormEvent } from 'react';
import { PROTOTYPE_ROOM } from '@studysync/shared';

interface Props {
  onJoin: (name: string) => void;
}

export function JoinScreen({ onJoin }: Props) {
  const [name, setName] = useState('');
  const trimmed = name.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length > 0) onJoin(trimmed);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <h1 className="text-3xl font-bold text-slate-900">StudySync</h1>
      <p className="mt-1 text-slate-600">Study together, at your own pace.</p>
      <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Phase 0 prototype: no accounts yet. Pick a display name to enter the room.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <label htmlFor="name" className="block text-sm font-medium text-slate-700">
          Your name
        </label>
        <input
          id="name"
          data-testid="name-input"
          value={name}
          maxLength={50}
          autoFocus
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          placeholder="e.g. Chitransh"
        />
        <button
          type="submit"
          data-testid="join-button"
          disabled={trimmed.length === 0}
          className="w-full rounded-md bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enter {PROTOTYPE_ROOM.name}
        </button>
      </form>
    </main>
  );
}
