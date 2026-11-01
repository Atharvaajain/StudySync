import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { canonicalTimeZone } from '@studysync/shared';
import { useAuth } from '../auth/AuthContext';
import { ErrorNote, inputClass, primaryButton } from '../components/ui';
import { errorMessage } from '../lib/api';

/** F-01: the timezone is detected from the browser and editable later in Settings. */
export function detectTimezone(): string {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch {
    return 'UTC';
  }
}

function AuthLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="text-3xl font-bold text-slate-900">StudySync</h1>
      <p className="mt-1 text-slate-600">Study together. Your time is always yours.</p>
      <section className="mt-8 rounded-lg bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {children}
      </section>
    </main>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Log in">
      <form className="mt-4 space-y-3" onSubmit={(e) => void submit(e)}>
        <ErrorNote message={error} />
        <label className="block text-sm text-slate-700">
          Email
          <input
            className={inputClass}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm text-slate-700">
          Password
          <input
            className={inputClass}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
          Log in
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        New here?{' '}
        <Link to="/register" className="text-indigo-700 underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [timezone] = useState(detectTimezone);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await register({ name, email, password, timezone });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Create your account">
      <form className="mt-4 space-y-3" onSubmit={(e) => void submit(e)}>
        <ErrorNote message={error} />
        <label className="block text-sm text-slate-700">
          Name
          <input
            className={inputClass}
            name="name"
            autoComplete="name"
            required
            maxLength={50}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm text-slate-700">
          Email
          <input
            className={inputClass}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm text-slate-700">
          Password <span className="text-xs text-slate-500">(at least 10 characters)</span>
          <input
            className={inputClass}
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <p className="text-xs text-slate-500" data-testid="detected-timezone">
          Timezone: {timezone} (change it any time in Settings)
        </p>
        <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
          Create account
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="text-indigo-700 underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}
