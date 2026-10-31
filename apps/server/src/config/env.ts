import { z } from 'zod';

/**
 * Zod-validated environment (ARCHITECTURE §20). The process refuses to start on invalid config.
 *
 * Phase 0 safety rules:
 * - NODE_ENV=production is refused: the prototype has no authentication (identity is
 *   self-declared), so it must never be exposed as a real service.
 * - The test clock (POST /__test__/clock) is only allowed with NODE_ENV=test (§17.6).
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    STATIC_DIR: z
      .string()
      .optional()
      .transform((v) => (v && v.trim().length > 0 ? v : undefined)),
    ENABLE_TEST_CLOCK: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message:
          'Phase 0 prototype has no authentication and must not run with NODE_ENV=production.',
      });
    }
    if (env.ENABLE_TEST_CLOCK && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_TEST_CLOCK'],
        message: 'ENABLE_TEST_CLOCK=true is only allowed with NODE_ENV=test.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
