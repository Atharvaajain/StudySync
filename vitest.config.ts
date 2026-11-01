import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web-unit',
          root: './apps/web',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server-unit',
          root: './apps/server',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real PostgreSQL (studysync_test). Files run one at a time: they share the database.
        test: {
          name: 'server-db',
          root: './apps/server',
          include: ['test/integration/**/*.test.ts', 'test/realtime/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/globalSetup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
