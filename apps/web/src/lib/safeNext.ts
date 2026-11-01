/**
 * A safe in-app path to return to after signing in (e.g. an invite link). Anything that isn't a
 * same-origin absolute path — `https://evil.example`, `//evil.example`, `/\\evil` — becomes "/",
 * so `?next=` can never be used as an open redirect.
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}
