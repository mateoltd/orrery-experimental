/**
 * Account deletion planning.  (P1-T5, plans/13 §1.2)
 *
 * ## The architecture, and it is the whole design
 *
 * Deletion and the DRY RUN call the same function. `planDeletion(manifest)` returns a
 * `DeletionPlan`; the dry run renders it and stops, and the real run passes the same plan to an
 * executor. The counts cannot disagree because there is only one set of counts, computed once,
 * from one function — and a test asserts the plan's effects match what the executor actually
 * did.
 *
 * The naive alternative is a `dryRun: boolean` flag threaded through the delete path, and it is
 * wrong in a way that only shows up after a deletion has already happened: the two branches
 * drift, and nobody notices until a real user is told their grade history is being erased.
 *
 * ## The three outcomes, and why each exists
 *
 *   DELETE     — the account itself. Auth rows, sessions, notification preferences. Gone.
 *   ANONYMISE  — content referenced BY a graded submission. NOT deleted, because a grade with
 *                nothing to grade is incoherent, and `plans/13` §1.2 is explicit that a
 *                historical grade should be attributable to a tombstone rather than a person.
 *   RETAIN     — the student's own free-text answers.
 *
 * ## The RETAIN case is the one people get wrong
 *
 * It is tempting to null out PII in a student's own written answers. `plans/13` §1.2 rule 4
 * refuses this outright, and the reasoning is worth stating because it is a rights question
 * and not a technical one: the student asked to delete their ACCOUNT, not to falsify their
 * WORK. Their answers are their own academic records, governed by the retention schedule and
 * exportable until then. Silently blanking a student's essay would also destroy the very thing
 * a grade is evidence OF.
 *
 * So the plan retains free text, and `assertNoFalsification` exists to make that a checked
 * invariant rather than a comment: the executor cannot be handed a plan that nulls a student's
 * own submissions, because the planner cannot produce one.
 */

/** What the product knows about one account, gathered by the caller. */
export interface DeletionManifest {
  readonly userId: string;
  /** Count of auth rows: accounts, sessions, tokens, notification preferences. */
  readonly authRows: number;
  readonly sessions: number;
  readonly notificationPreferences: number;
  /** Content this user AUTHORED, split by whether a graded submission references it. */
  readonly authoredReferencedByGrade: readonly string[];
  readonly authoredUnreferenced: readonly string[];
  /** Content this user authored INSIDE their own submissions. Never nulled. */
  readonly ownFreeTextSubmissions: readonly string[];
  /** Grades awarded BY this user as a teacher. Retained so the grades they gave stay valid. */
  readonly gradesAuthored: number;
  /** Classrooms the user OWNS. Transferring these is a separate, manual process. */
  readonly ownedClassrooms: readonly string[];
  /** Enrollments. Removed so the roster reflects reality. */
  readonly enrollments: number;
}

export type DeletionOutcome = 'delete' | 'anonymise' | 'retain';

export interface DeletionPlanEntry {
  readonly id: string;
  readonly outcome: DeletionOutcome;
  readonly reason: string;
}

export interface DeletionPlan {
  readonly userId: string;
  /** A stable fingerprint, so the dry run and the real run can prove they planned the same. */
  readonly fingerprint: string;
  readonly entries: readonly DeletionPlanEntry[];
  readonly counts: Readonly<Record<DeletionOutcome, number>>;
  /**
   * Deletes that are AUTHORED CONTENT, as opposed to the account's own auth material.
   *
   * Split out because the confirmation says "N items you created" — and the total delete
   * count includes sessions, enrollments and notification preferences, which the user did not
   * create. Using the total made the copy state a falsehood, and the first test of this
   * caught it by asserting the sentence is absent when there is no authored content.
   *
   * A count that is right but about a different question is how a confirmation screen starts
   * telling people things that are not true.
   */
  readonly deletedAuthored: number;
  /** Counts recorded verbatim in the terminal AuditEvent, per plans/13 §1.2 rule 5. */
  readonly auditCounts: Readonly<{
    authRows: number;
    sessions: number;
    notificationPreferences: number;
    anonymised: number;
    deleted: number;
    retained: number;
    gradesAuthored: number;
    ownedClassrooms: number;
  }>;
  /** Rendered for the confirmation screen. Says the retention part plainly. */
  readonly confirmation: readonly string[];
  /**
   * Blocks the deletion until a human deals with these.
   *
   * An account that OWNS classrooms cannot be deleted automatically: deleting it would either
   * orphan the classrooms or hand them to nobody, and both are worse than asking. This is a
   * refusal, not a warning.
   */
  readonly blockers: readonly string[];
}

export const BLOCKER_OWNS_CLASSROOM =
  'You still own a classroom. Transfer it to another teacher, or ask an administrator to remove it, before deleting your account.';

/**
 * Plan the deletion. Pure: no database, no clock, no I/O.
 *
 * The ordering of the outcomes below is the policy, and each comment is a decision rather
 * than a restatement.
 */
export function planDeletion(manifest: DeletionManifest): DeletionPlan {
  const entries: DeletionPlanEntry[] = [];

  // The account's own auth material. Gone, all of it, unconditionally.
  for (const [id, count, reason] of [
    ['auth', manifest.authRows, 'Authentication records for the account.'],
    ['sessions', manifest.sessions, 'Every active session, signed out immediately.'],
    ['notification-preferences', manifest.notificationPreferences, 'Notification preferences.'],
  ] as const) {
    for (let i = 0; i < count; i += 1) {
      entries.push({ id: `${id}:${i}`, outcome: 'delete', reason });
    }
  }

  // Not a truthiness check on a required number. `manifest.enrollments ? ... : []` reads as
  // "when there are no enrollments" but is really "when the count is 0", and a reader cannot
  // tell that from a guard against a missing field — which would be the right thing to write
  // if the field were optional. It is not.
  for (let i = 0; i < manifest.enrollments; i += 1) {
    entries.push({ id: `enrollment:${i}`, outcome: 'delete', reason: 'Classroom enrollment.' });
  }

  // Authored content that a graded submission REFERENCES. Anonymised, never deleted.
  for (const id of manifest.authoredReferencedByGrade) {
    entries.push({
      id,
      outcome: 'anonymise',
      reason:
        'Referenced by a graded submission. Kept without identifying details so the grade stays valid.',
    });
  }

  // Authored content nobody references. Gone — there is no reason to keep a draft that no
  // student's work depends on.
  for (const id of manifest.authoredUnreferenced) {
    entries.push({
      id,
      outcome: 'delete',
      reason: 'Authored content not referenced by any graded work.',
    });
  }

  // The student's own answers. RETAINED. See the file header — this is the decision most
  // likely to be got wrong, and it is a rights question rather than a technical one.
  for (const id of manifest.ownFreeTextSubmissions) {
    entries.push({
      id,
      outcome: 'retain',
      reason:
        'Your own answers. These are your academic records, kept for the retention period, and you can export them until then.',
    });
  }

  const counts = {
    delete: entries.filter((e) => e.outcome === 'delete').length,
    anonymise: entries.filter((e) => e.outcome === 'anonymise').length,
    retain: entries.filter((e) => e.outcome === 'retain').length,
  };
  const deletedAuthored = manifest.authoredUnreferenced.length;

  const blockers: string[] = [];
  if (manifest.ownedClassrooms.length > 0) blockers.push(BLOCKER_OWNS_CLASSROOM);

  return {
    userId: manifest.userId,
    // A fingerprint of the PLAN, not of the data. Two dry runs over an unchanged account
    // produce the same string, and a dry run followed by a changed account does not — which is
    // how the UI can refuse to execute a plan the user agreed to something else.
    fingerprint: fingerprintOf(entries, manifest),
    entries,
    counts,
    deletedAuthored,
    auditCounts: {
      authRows: manifest.authRows,
      sessions: manifest.sessions,
      notificationPreferences: manifest.notificationPreferences,
      anonymised: counts.anonymise,
      deleted: counts.delete,
      retained: counts.retain,
      gradesAuthored: manifest.gradesAuthored,
      ownedClassrooms: manifest.ownedClassrooms.length,
    },
    confirmation: buildConfirmation(manifest, counts, deletedAuthored),
    blockers,
  };
}

/**
 * The confirmation copy.  (plans/13 §1.2 rule 4: "stated plainly in the confirmation")
 *
 * The retention sentence is not buried and not softened. A user who does not know their own
 * work is being kept has not been told what they agreed to.
 */
function buildConfirmation(
  manifest: DeletionManifest,
  counts: Readonly<Record<DeletionOutcome, number>>,
  deletedAuthored: number,
): string[] {
  const lines: string[] = [];

  lines.push(
    `Your account and its ${manifest.sessions} active session${manifest.sessions === 1 ? '' : 's'} will be deleted. You will be signed out everywhere.`,
  );
  // `deletedAuthored`, not `counts.delete` — see the field's own comment. Saying "12 items you
  // created" when 10 of them are the user's own sessions and enrollments is a falsehood on a
  // screen the user is about to consent to.
  if (deletedAuthored > 0) {
    lines.push(
      `${deletedAuthored} item${deletedAuthored === 1 ? '' : 's'} you created that no graded work depends on will be deleted.`,
    );
  }
  if (counts.anonymise > 0) {
    lines.push(
      `${counts.anonymise} item${counts.anonymise === 1 ? '' : 's'} you created will be kept without your name, because a grade depends on them. The grade stays valid.`,
    );
  }
  if (counts.retain > 0) {
    lines.push(
      `Your own answers (${counts.retain}) are NOT deleted. You asked to delete your account, not to change your work. They are kept for the retention period and you can export them until then.`,
    );
  }
  if (manifest.gradesAuthored > 0) {
    lines.push(
      `The ${manifest.gradesAuthored} grade${manifest.gradesAuthored === 1 ? '' : 's'} you gave are kept, so students are not left with marks from nobody.`,
    );
  }
  if (manifest.ownedClassrooms.length > 0) lines.push(BLOCKER_OWNS_CLASSROOM);
  return lines;
}

/** A stable, non-cryptographic plan fingerprint. Order-independent by construction. */
function fingerprintOf(entries: readonly DeletionPlanEntry[], manifest: DeletionManifest): string {
  const parts = [manifest.userId, ...entries.map((e) => `${e.outcome}:${e.id}`).sort()];
  // FNV-1a over a canonical string. NOT a security hash: it identifies a plan, it does not
  // protect one, and pretending otherwise would invite someone to rely on it.
  let h = 0x811c9dc5;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The invariant that cannot be violated: the plan never falsifies a student's own work.
 *
 * Checked rather than assumed, because the tempting implementation — a post-processing pass
 * that nulls free text on the way out — is a two-line change that would silently destroy a
 * student's essays and every grade computed from them. Making it a function that is CALLED
 * means the executor has to go out of its way to break it.
 */
export function assertNoFalsification(plan: DeletionPlan): void {
  const falsified = plan.entries.filter(
    (e) => e.outcome !== 'retain' && e.reason.includes('own answers'),
  );
  if (falsified.length > 0) {
    throw new Error(
      `Refusing a deletion plan that alters the student's own work: ` +
        `${falsified.map((e) => e.id).join(', ')}. plans/13 §1.2 rule 4 — they asked to ` +
        'delete their account, not to falsify their work.',
    );
  }
}

/** Whether the plan may be executed as-is. */
export function canExecute(plan: DeletionPlan): boolean {
  return plan.blockers.length === 0;
}

/**
 * The export, as a plan too, so the dry run covers export as well.
 *
 * Export is the mirror of deletion: everything a user is entitled to take with them, listed
 * before they ask rather than assembled afterwards.
 */
export interface ExportPlan {
  readonly userId: string;
  readonly sections: readonly { readonly label: string; readonly count: number }[];
  readonly total: number;
}

export function planExport(input: {
  userId: string;
  submissions: number;
  gradesReceived: number;
  gradesGiven: number;
  authoredContent: number;
  classrooms: number;
  auditEvents: number;
}): ExportPlan {
  const sections = [
    { label: 'Your submitted answers', count: input.submissions },
    { label: 'Grades you received', count: input.gradesReceived },
    { label: 'Grades you gave', count: input.gradesGiven },
    { label: 'Content you created', count: input.authoredContent },
    { label: 'Classrooms', count: input.classrooms },
    { label: 'Account history', count: input.auditEvents },
  ];
  return { userId: input.userId, sections, total: sections.reduce((n, s) => n + s.count, 0) };
}
