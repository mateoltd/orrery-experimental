/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 15)
 *
 * ## TWO TRAPS, AND NEITHER IS THE ARITHMETIC
 *
 * Every other simulation in this set has at most one thing to get wrong. This one has two, and they pull
 * in opposite directions, so a student who fixes one reliably breaks the other:
 *
 * 1. **A connection speed is in BITS per second and a file size is in BYTES.** Dividing megabits by
 *    megabytes without dividing by eight gives an answer eight times too small -- a download that "takes"
 *    4 seconds when it takes 32.
 * 2. **A "megabyte" from a file manager is 2^20 bytes and a "megabit" from a speed test is 10^6 bits.**
 *    Mixing them is not a rounding quibble; it is about 5% on every answer.
 *
 * Both traps push in opposite directions, which is what makes the question worth a simulation: a student
 * who has memorised one of them and not the other will produce an answer that is wrong by a factor of
 * eight and be unable to tell which mistake they made.
 *
 * ## WHY THE ANSWER IS ROUNDED TO A SECOND
 *
 * A transfer time is not measured to a millisecond; it is the time a progress bar shows. The answer is
 * therefore rounded, and the grading tolerance is set to accept the rounding rather than to hide a
 * mistake behind it.
 */

export const BITS_PER_BYTE = 8;

export interface DownloadParams {
  /** File size as the operating system reports it: MEGABYTES, so 2^20 bytes each. */
  readonly sizeMb: number;
  /** Connection speed as a speed test reports it: MEGABITS per second, 10^6 bits each. */
  readonly speedMbps: number;
}

export const clamp = (params: DownloadParams): DownloadParams => ({
  sizeMb: Math.min(10_000, Math.max(0.1, Number.isFinite(params.sizeMb) ? params.sizeMb : 100)),
  speedMbps: Math.min(
    10_000,
    Math.max(0.1, Number.isFinite(params.speedMbps) ? params.speedMbps : 100),
  ),
});

export const bytes = (sizeMb: number): number => sizeMb * 1024 * 1024;
export const bitsPerSecond = (speedMbps: number): number => speedMbps * 1_000_000;

/** Seconds, unrounded. The two conversions and the division, in that order. */
export function seconds(sizeMb: number, speedMbps: number): number {
  if (!(speedMbps > 0)) return Number.NaN;
  return (bytes(sizeMb) * BITS_PER_BYTE) / bitsPerSecond(speedMbps);
}

/** What the progress bar shows. */
export const secondsRounded = (sizeMb: number, speedMbps: number): number =>
  Math.round(seconds(sizeMb, speedMbps));

/**
 * The factor-eight mistake, named so a test can assert exactly what it produces.
 *
 * It DIVIDES by eight, not multiplies: the mistake is dividing a count of BYTES by a rate in BITS, so
 * the answer comes out eight times too SMALL. The first version multiplied, which is the opposite error,
 * and a test asserting the value caught it immediately -- 67 seconds instead of 1.
 */
export const withoutTheByteConversion = (sizeMb: number, speedMbps: number): number =>
  seconds(sizeMb, speedMbps) / BITS_PER_BYTE;

export function describeDownload(sizeMb: number, speedMbps: number): string {
  return (
    `A file of ${format(sizeMb)} MB is being downloaded over a connection measured at ` +
    `${format(speedMbps)} Mbit/s. Work out how many seconds the download takes. ` +
    `A megabyte here is 1024 x 1024 bytes, a megabit is 1000 x 1000 bits, and there are 8 bits in a byte.`
  );
}

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  if (value === 0) return '0';
  const magnitude = Math.ceil(Math.log10(Math.abs(value)));
  const power = Math.max(0, 6 - magnitude);
  const rounded = Math.round(value * 10 ** power) / 10 ** power;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
