/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 15)
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  BITS_PER_BYTE,
  bitsPerSecond,
  bytes,
  type DownloadParams,
  describeDownload,
  format,
  seconds,
  secondsRounded,
} from './model.js';

export default defineSim({
  meta: {
    id: 'computing-science.download-time',
    title: 'How long does the download take?',
    version: '1.0.0',
    subjects: ['computing-science'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    sizeMb: num({
      name: 'sizeMb',
      label: 'File size',
      unit: 'MB',
      min: 0.1,
      max: 10_000,
      default: 100,
    }),
    speedMbps: num({
      name: 'speedMbps',
      label: 'Connection speed',
      unit: 'Mbit/s',
      min: 0.1,
      max: 10_000,
      default: 100,
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A file size in megabytes, a connection speed in megabits per second, and a box for the time in seconds.',
    reducedMotion: true,
    // The TIME is the answer. The two inputs are named because they are the question, and the
    // relationships between them are stated -- because a student who is not told that a megabit is eight
    // times a megabyte has no way to know which of two equally plausible numbers to write down.
    textAlternative:
      'A file size in megabytes and a connection speed in megabits per second are given. A megabyte is ' +
      '1024 times 1024 bytes, a megabit is 1000 times 1000 bits, and there are 8 bits in a byte. Work ' +
      'out how many seconds the download takes.',
    summary: 'Set a file size and a connection speed, and work out the download time.',
  },
  grade(_state: unknown, params: DownloadParams, answer: unknown) {
    const blank =
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '');
    const given = Number(answer);
    if (blank || !Number.isFinite(given)) {
      return { points: 0, max: 4, code: 'UNPARSEABLE', feedback: 'Enter the time in seconds.' };
    }
    const exact = seconds(Number(params.sizeMb), Number(params.speedMbps));
    const expected = secondsRounded(Number(params.sizeMb), Number(params.speedMbps));
    // THE GRADER DOES NOT ROUND ITS OWN EXPECTATION AND THEN PUNISH THE PRECISE ANSWER.
    //
    // Judging `given` against the ROUNDED value with a 2% relative tolerance scored the exact transfer
    // time 8.388608 at 2.23 of 4 -- a student who computed the right answer to more decimal places than
    // the grader was willing to keep lost three quarters of the marks for it. The rounding belongs in the
    // ANSWER the feedback quotes, not in the comparison, and the tolerance is then the rounding itself:
    // half a second, which accepts both `8` and `8.39` and still refuses `9`.
    const judged = tolerance(given, exact, {
      abs: 0.5,
      rel: 0,
      maxPoints: 4,
      partialCredit: true,
      partialCreditBand: 3,
    });
    // The mistake is DIVIDING bytes by a rate in bits, so the wrong answer is eight times too SMALL.
    const dividedBitsFromBytes = Math.round(exact / BITS_PER_BYTE);
    return {
      points: judged.points,
      max: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: ${format(expected)} s.`
          : `You said ${format(given)} s. ${describeDownload(Number(params.sizeMb), Number(params.speedMbps))} ` +
            `${format(params.sizeMb)} MB is ${format(bytes(Number(params.sizeMb)))} bytes, which is ` +
            `${format(bytes(Number(params.sizeMb)) * BITS_PER_BYTE)} bits; at ` +
            `${format(bitsPerSecond(Number(params.speedMbps)))} bits per second that is ` +
            `${format(expected)} s.` +
            // Naming the exact mistake is worth more than naming the right answer, because the two
            // candidate errors are eight times apart and the student cannot otherwise tell which they made.
            (Math.abs(given - dividedBitsFromBytes) <= Math.max(0.5, dividedBitsFromBytes * 0.02)
              ? ` ${format(given)} s is exactly the answer you get by dividing megabytes by megabits ` +
                'without converting bits to bytes.'
              : ''),
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const size = (state as { sizeMb?: unknown }).sizeMb;
    return typeof size === 'number' && size > 0 ? null : 'the state has no positive file size';
  },
});

export { type bitsPerSecond, type bytes, seconds };
