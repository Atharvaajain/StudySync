export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://studysync:studysync@127.0.0.1:5432/studysync_test?schema=public';

/** Tests truncate tables: never let them touch a database that isn't a dedicated test one. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run DB tests against "${name}": the name must end with _test.`);
  }
}
