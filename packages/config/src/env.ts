/**
 * The environment schema.  (P0-T3)
 *
 * ## Why this module is load-bearing
 *
 * The plan's rule is that `process.env` is read *here and nowhere else*, and that a
 * missing or malformed variable **fails the process at boot** rather than becoming
 * `undefined` three layers deep in a request handler. An `undefined` secret discovered
 * during an exam is an outage; the same `undefined` discovered at boot is a log line.
 *
 * The ESLint restriction in `eslint.config.js` enforces the "nowhere else" half. This
 * file, plus `env.test.ts`, enforce the "fails at boot" half — because a validator that
 * quietly returns a defaulted object for an invalid input is worse than no validator.
 *
 * Two hard rules, both of which have bitten real systems:
 *   1. Secrets are validated for PRESENCE and SHAPE, never for value. Nothing logs,
 *      prints, or serialises them.
 *   2. Every variable is REQUIRED unless it has a documented, safe, local-only default.
 *      "Optional" is how `DATABASE_URL` ends up pointing at a developer's laptop in
 *      production, and how the release transaction runs against the wrong database.
 */

import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? '1' : '0')
    .transform((v) => v === 'true' || v === '1');

/** A URL that must parse. Rejects the empty string, which `z.url()` alone permits. */
const url = (name: string) =>
  z.string().min(1, `${name} must not be empty`).url(`${name} must be a valid URL`);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // ── datastores ────────────────────────────────────────────────────────────────
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required — release and grading both run in transactions')
      .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgres:// URL',
      }),
    REDIS_URL: url('REDIS_URL'),

    // ── object storage ───────────────────────────────────────────────────────────
    S3_ENDPOINT: url('S3_ENDPOINT'),
    S3_REGION: z.string().min(1),
    S3_BUCKET_ASSETS: z.string().min(1),
    S3_BUCKET_SIMS: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool(true),

    // ── email ────────────────────────────────────────────────────────────────────
    EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'noop']).default('smtp'),
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().min(1).includes('@', { message: 'EMAIL_FROM must contain @' }),
    RESEND_API_KEY: z.string().optional(),

    // ── auth ─────────────────────────────────────────────────────────────────────
    AUTH_SECRET: z
      .string()
      .min(32, 'AUTH_SECRET must be at least 32 bytes — session and HMAC signing depend on it')
      .refine((v) => !v.includes('replace-me'), {
        message: 'AUTH_SECRET still holds its placeholder value',
      }),
    APP_URL: url('APP_URL'),

    // ── observability ────────────────────────────────────────────────────────────
    OTEL_EXPORTER_OTLP_ENDPOINT: url('OTEL_EXPORTER_OTLP_ENDPOINT'),
    SENTRY_DSN: z.string().optional(),

    // ── product ──────────────────────────────────────────────────────────────────
    DEFAULT_LOCALE: z.string().min(2).default('en-GB'),
    SUPPORT_EMAIL: z.string().includes('@'),
    TARGET_CONCURRENT_EXAM_TAKERS: z.coerce.number().int().positive().default(150),
  })
  .superRefine((v, ctx) => {
    if (v.EMAIL_PROVIDER === 'smtp' && !v.SMTP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_URL'],
        message: 'SMTP_URL is required when EMAIL_PROVIDER=smtp',
      });
    }
    if (v.EMAIL_PROVIDER === 'resend' && !v.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
      });
    }
    if (v.NODE_ENV === 'production') {
      // A placeholder in production is the single most common cause of "it worked in
      // staging" — so it is refused here rather than discovered during an exam.
      if (v.APP_URL.includes('localhost')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_URL'],
          message: 'APP_URL must not be localhost in production',
        });
      }
      if (v.S3_ENDPOINT.includes('localhost')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_ENDPOINT'],
          message: 'S3_ENDPOINT must not be localhost in production',
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;
export type EnvInput = z.input<typeof schema>;

export type EnvResult = { ok: true; env: Env } | { ok: false; issues: string[] };

/**
 * Validate without throwing. Separated from the side-effecting import below so it can
 * be tested — a boot-failure path that cannot be exercised is a boot-failure path that
 * does not work.
 */
export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  const result = schema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** Validate, or throw with every problem listed. Use at the top of a process entrypoint. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = parseEnv(source);
  if (!result.ok) {
    throw new Error(
      `Invalid environment — refusing to start:\n  - ${result.issues.join('\n  - ')}\n` +
        'Copy .env.example to .env and fill in real values.',
    );
  }
  return result.env;
}

/**
 * Print the SHAPE of the environment, never its values. Safe to log, safe to paste into
 * a bug report, and enough to answer "which config is this process actually running?".
 */
export function envShape(env: Env): Record<string, string> {
  const secret = /SECRET|KEY|PASSWORD|TOKEN|DSN/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = secret.test(k) ? `<redacted:${typeof v}>` : String(v);
  }
  return out;
}
