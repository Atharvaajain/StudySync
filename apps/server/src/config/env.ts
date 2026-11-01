import { z } from 'zod';

/**
 * Zod-validated environment (ARCHITECTURE §20). The process refuses to start on invalid config.
 *
 * Safety rules:
 * - NODE_ENV=production is refused until the pre-launch phase (DEVELOPMENT_ROADMAP Phase 5:
 *   security review, password reset, deployment). Development and test only.
 * - The test clock (POST /__test__/clock), relaxed rate limits, other token lifetimes and a
 *   bcrypt cost below 10 are only allowed with NODE_ENV=test (§17.6).
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
    /** Automated test runs only: lifts the HTTP auth rate limits (many registrations per IP). */
    RELAX_RATE_LIMITS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),
    /** HS256 signing secret, ≥ 32 characters (§17.1). */
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().min(1).default('studysync'),
    JWT_AUDIENCE: z.string().min(1).default('studysync-web'),
    /** 15 minutes (§17.1). Other values only for automated tests (expiry / long timer runs). */
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(1).max(86_400).default(900),
    /** 30 days (§17.1). Other values only for automated tests. */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
    /** `Secure` flag on the refresh cookie (§17.1). Set false only for plain-http local dev. */
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message:
          'StudySync is not release-ready until the pre-launch phase (Phase 5); NODE_ENV=production is refused.',
      });
    }
    if (env.ENABLE_TEST_CLOCK && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_TEST_CLOCK'],
        message: 'ENABLE_TEST_CLOCK=true is only allowed with NODE_ENV=test.',
      });
    }
    if (
      (env.ACCESS_TOKEN_TTL_SEC !== 900 || env.REFRESH_TOKEN_TTL_DAYS !== 30) &&
      env.NODE_ENV !== 'test'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ACCESS_TOKEN_TTL_SEC'],
        message: 'Token lifetimes other than 15 min / 30 days are only allowed with NODE_ENV=test.',
      });
    }
    if (env.RELAX_RATE_LIMITS && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['RELAX_RATE_LIMITS'],
        message: 'RELAX_RATE_LIMITS=true is only allowed with NODE_ENV=test.',
      });
    }
    if (env.BCRYPT_COST < 10 && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['BCRYPT_COST'],
        message: 'BCRYPT_COST below 10 is only allowed with NODE_ENV=test.',
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
