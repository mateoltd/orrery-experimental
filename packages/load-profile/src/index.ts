/**
 * THE LOAD PROFILE, AND IT SAYS IT IS SYNTHETIC IN ITS OWN TYPE.
 *
 * ## WHY THE PROVENANCE IS A FIELD AND NOT A COMMENT
 *
 * `plans/08` §2.4's item time-on-item percentiles come from real students, and **they do not exist yet** — they are
 * `P17-T4`'s pilot, three classrooms and two exam cycles away. `D-15` is the decision the whole plan has been waiting
 * on for exactly this.
 *
 * So the profile below is **synthetic**, and the dangerous failure is not that someone believes it is real — it is
 * that a committed load report gets read six months later by somebody who does not remember. A baseline JSON with a
 * `"provenance": "SYNTHETIC"` field in it **cannot be misread**, because the misreading has to delete the field.
 * A comment above a number can be scrolled past, and a number without provenance is just a number.
 *
 * **AND THE FIELD IS A CLOSED UNION**, so a future profile that IS derived from the pilot cannot quietly claim to be
 * something it is not: `SYNTHETIC` and `MEASURED` are the only values, and `MEASURED` carries the percentile table it
 * was derived from. There is no third option to reach for.
 *
 * ## WHAT THE SHAPE IS TAKEN FROM, AND WHY IT IS NOT A FLAT LOOP
 *
 * `plans/18` §11 requires think-time *distributions*, not a flat loop, and the distribution used is **log-normal**,
 * because reading time is log-normal in the literature and a uniform draw of it produces a load profile no real cohort
 * creates: the same number of students arriving at every instant.
 *
 * The parameters are the ones `plans/08` §2.4 will eventually replace. They are marked `DECLARED SYNTHETIC` per field
 * so that replacing them is a per-field edit with the provenance updated alongside, rather than a silent edit to a
 * number whose meaning has changed.
 *
 * ## AND THE SAVES ARE AT THE OBSERVED DEBOUNCE RATE
 *
 * `plans/09` §9: 1.2 s after the last keystroke, immediate on blur/question change/`visibilitychange`, and every 20 s
 * while dirty. So a student answering five questions in a sitting generates a burst of saves followed by a gap, and a
 * load test that fires one save per question measures a system that never sees the real shape.
 */

/** Provenance of the think-time numbers. See the note above. */
export type ProfileProvenance =
  /** Invented. Real time-on-item data does not exist until P17-T4's pilot (`D-15`). */
  | { readonly kind: 'SYNTHETIC'; readonly reason: string }
  /** Derived from measured percentiles, naming the measurement. */
  | { readonly kind: 'MEASURED'; readonly source: string; readonly observedAt: string };

/**
 * `SYNTHETIC` UNTIL P17-T4 RUNS. Changing this is not a numbers change; it is a provenance change and the two must
 * move together, which is the point of it being a union rather than a string.
 */
export const PROVENANCE: ProfileProvenance = {
  kind: 'SYNTHETIC',
  reason:
    'No student has sat a real exam in this deployment. Time-on-item percentiles arrive with P17-T4 (3 classrooms, ' +
    '30 students, 2 cycles). Until then every latency figure below describes THIS profile and nothing else. ' +
    'P15-T3 hardens this suite and replaces these numbers; do not cite them as capacity.',
};

/** Log-normal parameters for per-question think time, in ms. Every field marked DECLARED SYNTHETIC. */
export const THINK_TIME = {
  /** DECLARED SYNTHETIC: median per-question time. */
  medianMs: 30_000,
  /** DECLARED SYNTHETIC: log-space sigma. 0.55 gives a long right tail and a few genuinely stuck students. */
  sigma: 0.55,
  /**
   * DECLARED SYNTHETIC: the fastest plausible student. A log-normal has no lower bound, and an unbounded fast student
   * is not a real person; the floor is where the number stops describing a human and starts describing the harness.
   */
  floorMs: 1_500,
  /** DECLARED SYNTHETIC: the slowest. Above this the student is presumed to have walked away. */
  ceilingMs: 240_000,
} as const;

/** `plans/09` §9's autosave shape. Real rates, because these come from the spec rather than from measurement. */
export const SAVE_SHAPE = {
  /** Debounced after the last keystroke. */
  debounceMs: 1_200,
  /** Immediate on blur, question change and `visibilitychange` — so saves arrive in bursts, not evenly. */
  flushOnExit: true,
  /** Every 20 s while dirty, for a student still typing on one question. */
  dirtyHeartbeatMs: 20_000,
  /** A save is also queued per answered question. */
  perAnsweredQuestion: true,
} as const;

/**
 * THE COHORT. `plans/18` §11's 750 is the full-cohort figure; `test:load` runs a calibration by default and the full
 * cohort only on request, because a 750-student run against a developer's machine is a long job nobody will re-run.
 *
 * **THE CALIBRATION IS NOT A SMALLER VERSION OF THE SAME TEST** and the baseline records which ran. A 40-student run
 * does not reproduce the stampede's lock contention, and a report that does not say which it was is the exact problem
 * this file exists to prevent.
 */
export const COHORT = {
  full: 750,
  calibration: 40,
  /**
   * `plans/18` §11: the stampede is all attempts released into the same 10-second window, which is what happens when a
   * teacher releases a year of coursework at 09:00 on a Monday.
   */
  stampedeWindowMs: 10_000,
  /**
   * `plans/18` §11 asserts "no partial release observed", so the release assertions need a batch big enough for a
   * partial release to be a real possibility rather than a theoretical one. 5,000 is the plan's figure.
   */
  releaseBatch: 5_000,
} as const;

/**
 * THE ASSERTION THRESHOLDS, and each is a CORRECTNESS claim except the last.
 *
 * `plans/18` §11's own sentence is the reason this file exists: *"Latency without correctness assertions is how teams
 * ship a load test that passes while the product loses student answers."*
 *
 * **`lostAcknowledgedSaves` IS 0 AND NOT A PERCENTAGE.** A percentage would let the suite pass having lost four
 * answers, and four students found out at marking time. The quantity is a count of promises the system made and did
 * not keep, so it is compared to an integer.
 */
export const ASSERTIONS = {
  /**
   * EVERY save the server acknowledged must be present in the database at the end, with the exact bytes and the exact
   * revision it was acknowledged with. This is the assertion that catches a lost answer.
   *
   * Checked against `AnswerRevision`, not against the response row: the response row is an UPSERT and the last writer
   * wins, so a revision that was acknowledged and then overwritten is invisible there. This is the same reasoning as
   * `C5` — hash the bytes accepted, never re-read the column.
   */
  lostAcknowledgedSaves: 0,

  /**
   * NO PARTIAL RELEASE. Every member of a released batch is `RELEASED`; a batch where some are and some are not is the
   * `B16` failure that member rows moving one at a time would cause, and `releaseBatch` exists specifically to prevent
   * it with a single `updateMany`.
   */
  partiallyReleasedMembers: 0,

  /** `plans/18` §11: no 5xx above 0.1%. A bound rather than zero, because one dropped connection is not a defect. */
  max5xxRate: 0.001,

  /**
   * The p99 save latency, recorded but NOT asserted on by default. **A latency assertion without a hardware
   * statement is a lie**: the same suite on a laptop and on the staging shape produces different numbers, and a
   * committed threshold invites someone to enforce it on weaker hardware than it was taken on. The p99 is committed
   * so a REGRESSION is visible against history, which is what "versioned" means here, and the baseline records the
   * machine.
   */
  recordP99SaveLatencyMs: true,
} as const;
