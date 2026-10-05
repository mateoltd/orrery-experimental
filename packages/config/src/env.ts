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
    /**
     * The dedicated static origin simulation bundles are served from.  (P6-T6)
     *
     * It exists because "the sandbox is real rather than advisory" depends on it: with the bundle on
     * the app origin, a sim's bugs reach our cookies even through a cross-origin frame. Required, not
     * optional, because a missing value would otherwise default to `APP_URL` — which is the one
     * configuration where the whole `INV-SIM-1` argument does not hold, and it would hold silently.
     */
    SIM_ORIGIN: url('SIM_ORIGIN'),

    // ── observability ────────────────────────────────────────────────────────────
    OTEL_EXPORTER_OTLP_ENDPOINT: url('OTEL_EXPORTER_OTLP_ENDPOINT'),
    SENTRY_DSN: z.string().optional(),

    // ── product ──────────────────────────────────────────────────────────────────
    DEFAULT_LOCALE: z.string().min(2).default('en-GB'),
    SUPPORT_EMAIL: z.string().includes('@'),
    TARGET_CONCURRENT_EXAM_TAKERS: z.coerce.number().int().positive().default(150),

    // ── worker ──────────────────────────────────────────────────────────────────
    /**
     * The port the worker's Inngest endpoint is served on.
     *
     * **8380, AND NOT ANYWHERE NEAR 8288/8289 — BOTH OF THOSE ARE THE INNGEST DEV SERVER'S.** Measured by running
     * `inngest-cli dev` and listing its listeners: `*:8288` (API and dashboard), `*:8289` (its secondary listener),
     * `*:50052` and `*:50053` (gRPC). A first draft of this file used 8289 and the worker refused to boot with
     * `EADDRINUSE` against the dev server it was meant to be talking to — a failure that reads like a misconfiguration of
     * the wrong process, and that the person debugging it has no reason to connect to the other process's defaults.
     */
    WORKER_INNGEST_PORT: z.coerce.number().int().min(1).max(65_535).default(8380),
    /**
     * How long the worker may spend finishing in-flight work after `SIGTERM`, before it abandons it deliberately.
     *
     * **A GRACE LONGER THAN THE PLATFORM'S KILL DEADLINE IS A LIE.** Kubernetes' default `terminationGracePeriodSeconds`
     * is 30 s; 25 s leaves five seconds to actually exit. The ceiling exists because a value above the platform's own
     * deadline is indistinguishable from "wait forever" until a release transaction is killed mid-commit — and a release
     * transaction killed mid-commit is the failure this whole process exists to prevent.
     */
    WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().max(120_000).default(25_000),
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
    // The sim origin must be a DIFFERENT origin from the app. Same-origin (or same host, different
    // scheme, which the browser treats as a distinct origin but a firewall often does not) means a sim
    // bundle can reach the app's own response headers and any cookie scope that leaked into it.
    // `new URL` THROWS on a malformed string, and a `superRefine` that throws turns a validation failure
    // into an unhandled exception: the first version of this check did exactly that, and
    // "rejects a malformed URL" became "Invalid URL" as an exception rather than an issue. Compare
    // hosts only when BOTH parse, and let the field-level `url()` rules report the malformed ones.
    const hostOf = (value: string): string | null => {
      try {
        return new URL(value).host;
      } catch {
        return null;
      }
    };
    const appHost = hostOf(v.APP_URL);
    const simHost = hostOf(v.SIM_ORIGIN);
    if (appHost !== null && simHost !== null && appHost === simHost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SIM_ORIGIN'],
        message: `SIM_ORIGIN must not share a host with APP_URL (both are ${appHost})`,
      });
    }
    if (v.NODE_ENV === 'production') {
      // A placeholder in production is the single most common cause of "it worked in
      // staging" — so it is refused here rather than discovered during an exam.
      if (v.APP_URL.includes('localhost') || v.SIM_ORIGIN.includes('localhost')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [v.APP_URL.includes('localhost') ? 'APP_URL' : 'SIM_ORIGIN'],
          message: `${v.APP_URL.includes('localhost') ? 'APP_URL' : 'SIM_ORIGIN'} must not be localhost in production`,
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
