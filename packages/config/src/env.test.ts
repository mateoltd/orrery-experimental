/**
 * P0-T3 gate verification: the environment validator must REFUSE bad input, not
 * quietly default it.
 *
 * The failure this prevents is specific and expensive: an `undefined` secret that
 * surfaces mid-exam is an outage, and the same `undefined` caught at boot is a log line.
 * A validator that returns a defaulted object for invalid input is worse than none,
 * because it converts a loud failure into a silent one.
 */
import { describe, expect, it } from 'vitest';
import { envShape, loadEnv, parseEnv } from './env.js';

const good = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/orrery',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET_ASSETS: 'orrery-assets',
  S3_BUCKET_SIMS: 'orrery-sims',
  S3_ACCESS_KEY_ID: 'orrery',
  S3_SECRET_ACCESS_KEY: 'orrery-secret',
  S3_FORCE_PATH_STYLE: 'true',
  EMAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtp://localhost:1025',
  EMAIL_FROM: 'Orrery <no-reply@example.invalid>',
  AUTH_SECRET: 'x'.repeat(48),
  APP_URL: 'http://localhost:3000',
  SIM_ORIGIN: 'http://localhost:3001',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  DEFAULT_LOCALE: 'en-GB',
  SUPPORT_EMAIL: 'support@example.invalid',
} satisfies Record<string, string>;

describe('parseEnv — accepts a well-formed environment', () => {
  it('parses the local development shape', () => {
    const r = parseEnv(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.DATABASE_URL).toContain('postgresql://');
    expect(r.env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(r.env.TARGET_CONCURRENT_EXAM_TAKERS).toBe(150);
  });
});

/**
 * Build an env object with one key removed.
 *
 * The tests below were written as `const { KEY: _drop, ...rest } = good`, which leaves an
 * unused binding that ESLint correctly reports — four times. Naming the intent is better
 * than a throwaway variable, and it makes each test say which key it is removing.
 */
function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[key];
  return copy;
}

describe('parseEnv — refuses rather than defaulting', () => {
  it('rejects a missing DATABASE_URL, and names it', () => {
    const r = parseEnv(omit(good, 'DATABASE_URL'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('DATABASE_URL');
  });

  it('rejects a DATABASE_URL that is not postgres', () => {
    const r = parseEnv({ ...good, DATABASE_URL: 'mysql://localhost/orrery' });
    expect(r.ok).toBe(false);
  });

  it('rejects a short AUTH_SECRET', () => {
    const r = parseEnv({ ...good, AUTH_SECRET: 'too-short' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('AUTH_SECRET');
  });

  it('rejects an AUTH_SECRET still holding its placeholder', () => {
    const r = parseEnv({ ...good, AUTH_SECRET: `replace-me-with-${'x'.repeat(40)}` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('placeholder');
  });

  it('rejects an empty string where a URL is required', () => {
    const r = parseEnv({ ...good, REDIS_URL: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed URL', () => {
    const r = parseEnv({ ...good, APP_URL: 'not a url' });
    expect(r.ok).toBe(false);
  });

  it('requires SIM_ORIGIN, because defaulting it to APP_URL defeats the whole sandbox argument', () => {
    // A missing value would otherwise be the one configuration where INV-SIM-1 does not hold, and it
    // would hold silently.
    const r = parseEnv(omit(good, 'SIM_ORIGIN'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('SIM_ORIGIN');
  });

  it('refuses a SIM_ORIGIN that shares a host with APP_URL', () => {
    const r = parseEnv({
      ...good,
      SIM_ORIGIN: 'https://app.example',
      APP_URL: 'https://app.example',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/must not share a host/u);
  });

  it('refuses a localhost SIM_ORIGIN in production, naming the right variable', () => {
    // The message names whichever variable is actually localhost, because "APP_URL must not be
    // localhost" sent an author hunting the wrong line.
    const r = parseEnv({
      ...good,
      NODE_ENV: 'production',
      APP_URL: 'https://orrery.test',
      SIM_ORIGIN: 'http://localhost:3001',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('SIM_ORIGIN');
  });

  it('requires SMTP_URL when the provider is smtp', () => {
    const r = parseEnv(omit(good, 'SMTP_URL'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('SMTP_URL');
  });

  it('requires RESEND_API_KEY when the provider is resend', () => {
    const r = parseEnv({ ...omit(good, 'RESEND_API_KEY'), EMAIL_PROVIDER: 'resend' });
    expect(r.ok).toBe(false);
  });

  it('does not require SMTP_URL for the noop provider', () => {
    expect(parseEnv({ ...omit(good, 'SMTP_URL'), EMAIL_PROVIDER: 'noop' }).ok).toBe(true);
  });

  it('rejects an EMAIL_FROM without @', () => {
    const r = parseEnv({ ...good, EMAIL_FROM: 'no-reply' });
    expect(r.ok).toBe(false);
  });

  it('reports EVERY problem at once, not one per run', () => {
    const r = parseEnv({ ...good, DATABASE_URL: 'nope', AUTH_SECRET: 'x', EMAIL_FROM: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // A validator that reports one issue per boot turns a 5-variable mistake into
    // 5 redeploys.
    expect(r.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('production is stricter than development', () => {
  it('refuses a localhost APP_URL in production', () => {
    const r = parseEnv({ ...good, NODE_ENV: 'production' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('APP_URL');
  });

  it('refuses a localhost S3_ENDPOINT in production', () => {
    const r = parseEnv({ ...good, NODE_ENV: 'production', APP_URL: 'https://orrery.test' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('S3_ENDPOINT');
  });

  it('accepts a fully specified production environment', () => {
    const r = parseEnv({
      ...good,
      NODE_ENV: 'production',
      APP_URL: 'https://orrery.test',
      SIM_ORIGIN: 'https://sims.orrery.test',
      S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
    });
    expect(r.ok).toBe(true);
  });
});

describe('loadEnv throws, so the process cannot start half-configured', () => {
  it('throws with a readable, actionable message', () => {
    expect(() => loadEnv({})).toThrow(/refusing to start/i);
    expect(() => loadEnv({})).toThrow(/\.env\.example/);
  });
});

describe('envShape never leaks a secret', () => {
  it('redacts every secret-looking value', () => {
    const r = parseEnv(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shape = envShape(r.env);
    const serialised = JSON.stringify(shape);
    expect(serialised).not.toContain('orrery-secret');
    expect(serialised).not.toContain(good.AUTH_SECRET);
    expect(shape.AUTH_SECRET).toMatch(/^<redacted:/);
    expect(shape.S3_SECRET_ACCESS_KEY).toMatch(/^<redacted:/);
  });

  it('still shows the non-secret values, so the shape is diagnosable', () => {
    const r = parseEnv(good);
    if (!r.ok) return;
    const shape = envShape(r.env);
    expect(shape.NODE_ENV).toBe('test');
    expect(shape.DATABASE_URL).toContain('postgresql');
  });
});

/**
 * The worker's two settings, tested separately from the rest because their DEFAULTS encode two decisions
 * that are easy to get wrong silently: a port that collides with the Inngest dev server, and a drain grace
 * longer than the platform's kill deadline.
 */
describe('worker settings', () => {
  it('defaults the Inngest port clear of every port the Inngest dev server binds', () => {
    const r = parseEnv(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.WORKER_INNGEST_PORT).toBe(8380);
    // Measured from `inngest-cli dev`: 8288 is its API, 8289 its second listener, 50052/50053 its gRPC.
    for (const taken of [8288, 8289, 50_052, 50_053]) {
      expect(r.env.WORKER_INNGEST_PORT).not.toBe(taken);
    }
  });

  it('defaults the shutdown grace below a 30 s platform kill deadline', () => {
    const r = parseEnv(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.WORKER_SHUTDOWN_GRACE_MS).toBe(25_000);
    // A grace longer than the deadline it is supposed to fit inside is indistinguishable from "wait forever".
    expect(r.env.WORKER_SHUTDOWN_GRACE_MS).toBeLessThan(30_000);
  });

  it('refuses a port that is not a port', () => {
    for (const port of ['0', '70000', 'eighty']) {
      const r = parseEnv({ ...good, WORKER_INNGEST_PORT: port });
      expect(r.ok, `${port} must be refused`).toBe(false);
    }
  });

  it('refuses a zero or negative grace, because "abandon immediately" is not a configuration', () => {
    for (const grace of ['0', '-1']) {
      const r = parseEnv({ ...good, WORKER_SHUTDOWN_GRACE_MS: grace });
      expect(r.ok, `${grace} must be refused`).toBe(false);
    }
  });

  it('coerces a numeric string, because an env var is always a string', () => {
    const r = parseEnv({ ...good, WORKER_INNGEST_PORT: '9001', WORKER_SHUTDOWN_GRACE_MS: '5000' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.WORKER_INNGEST_PORT).toBe(9001);
    expect(r.env.WORKER_SHUTDOWN_GRACE_MS).toBe(5000);
  });
});
