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

describe('parseEnv — refuses rather than defaulting', () => {
  it('rejects a missing DATABASE_URL, and names it', () => {
    const { DATABASE_URL: _drop, ...rest } = good;
    const r = parseEnv(rest);
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

  it('requires SMTP_URL when the provider is smtp', () => {
    const { SMTP_URL: _drop, ...rest } = good;
    const r = parseEnv(rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(' ')).toContain('SMTP_URL');
  });

  it('requires RESEND_API_KEY when the provider is resend', () => {
    const { RESEND_API_KEY: _drop, ...rest } = good;
    const r = parseEnv({ ...rest, EMAIL_PROVIDER: 'resend' });
    expect(r.ok).toBe(false);
  });

  it('does not require SMTP_URL for the noop provider', () => {
    const { SMTP_URL: _drop, ...rest } = good;
    expect(parseEnv({ ...rest, EMAIL_PROVIDER: 'noop' }).ok).toBe(true);
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
