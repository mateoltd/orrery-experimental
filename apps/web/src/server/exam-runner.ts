/**
 * EXAM RUNNER LOADER: the attempt's questions, resolved for the student holding it.  (P8-T17)
 *
 * Loads the caller's OWN attempt with its responses ordered by position, parses each question spec,
 * projects it through `publicQuestionSpec` (keys dropped BY CONSTRUCTION, never by omission), and
 * carries the prompt alongside -- because the prompt lives in the stored spec JSON (`seed-banks.ts`
 * writes `{ prompt, ... }`), not in the contracts type, and a runner that cannot name the question it
 * renders is a runner that renders a nameless fieldset.
 *
 * ## FAIL CLOSED, WHOLE PAPER OR NOTHING
 *
 * A wrong owner, a missing attempt, an unparseable spec, or a missing prompt returns null for the WHOLE
 * load -- never a partial paper. A paper that renders two of three questions is a student answering a
 * different exam than the one that will be graded, and `submitAnswer` would happily accept answers
 * against it. The refusal names which question failed, so the failure is diagnosable without rendering
 * anything.
 *
 * ## WHAT THIS DOES NOT DO
 *
 * It does not check timing, membership windows, or release -- `submitAnswer` re-derives all of that per
 * write, and a loader that pre-checked them would be a second place the answers can differ (the audit's
 * standing rule). It also does not filter by status: a submitted attempt loads read-only downstream.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExamPolicy } from '@orrery/contracts/policy';
import { examPolicySchema } from '@orrery/contracts/policy';
import {
  type PublicQuestionSpec,
  publicQuestionSpec,
  type QuestionSpec,
} from '@orrery/contracts/question';
import type { PrismaClient } from '@orrery/db';
import { resolveCspSimOrigin } from './csp-sim-origin.js';

export interface RunnerSimExtras {
  readonly title: string;
  readonly textAlternative: {
    readonly shows: string;
    readonly task: string;
    readonly reportedIn: string;
  };
  /**
   * Frame config for the rewire, or absent when unresolvable. Bundle path from the registry entry,
   * origin from `resolveCspSimOrigin` -- the same resolution the CSP uses, so the frame and the
   * policy cannot disagree about where sims live. Absent in tests and in deployments without sim
   * hosting, in which case the renderer shows its fallback instead of a broken frame.
   */
  readonly bundleUrl?: string;
  readonly simOrigin?: string;
}

export interface RunnerQuestion {
  readonly responseId: string;
  readonly questionId: string;
  readonly position: number;
  readonly spec: PublicQuestionSpec;
  readonly prompt: string;
  readonly answer: unknown;
  readonly revision: number;
  /**
   * Simulation extras, resolved from the sim manifest -- because `SimulationProps` REQUIRES a title
   * and a three-part text alternative, and inventing them in the renderer would be content authored
   * by nobody. Present exactly when `spec.type === 'simulation'`; absent otherwise.
   */
  readonly sim?: RunnerSimExtras;
}

export interface RunnerData {
  readonly attemptId: string;
  /**
   * The FROZEN policy snapshot, parsed -- never a default. A policy that fails to parse refuses the
   * paper: running an exam under a policy nobody can read is how `INV-POLICY-1` fails silently.
   */
  readonly policy: ExamPolicy;
  readonly questions: readonly RunnerQuestion[];
}

function promptOf(spec: QuestionSpec): string | null {
  const candidate = (spec as unknown as Record<string, unknown>).prompt;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
}

/**
 * Resolves a sim's title and text alternative from its manifest. Injected root so tests do not read
 * the repository: the default is the checkout's `sims/` directory, which is where the manifests live
 * in every environment that builds them.
 *
 * DEPLOYMENT NOTE, recorded rather than solved: if manifests are not deployed alongside the app,
 * simulation questions refuse the whole paper. That is fail-closed and loud, not a blank frame -- but
 * it does mean sim questions depend on manifest availability, which `D-36` owns.
 */
export function simExtrasFor(
  simId: string,
  prompt: string,
  simsRoot: string,
  simVersion?: string,
): RunnerSimExtras | null {
  const path = join(simsRoot, simId, 'sim.manifest.json');
  if (!existsSync(path)) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null) return null;
  const record = manifest as Record<string, unknown>;
  const title =
    typeof record.title === 'string' && record.title.trim().length > 0 ? record.title : null;
  const accessibility =
    typeof record.accessibility === 'object' && record.accessibility !== null
      ? (record.accessibility as Record<string, unknown>)
      : null;
  const alternative =
    accessibility !== null &&
    typeof accessibility.textAlternative === 'string' &&
    accessibility.textAlternative.trim().length > 0
      ? accessibility.textAlternative
      : null;
  if (title === null || alternative === null) return null;
  const extras: RunnerSimExtras = {
    title,
    textAlternative: {
      shows: alternative,
      task: prompt,
      reportedIn: 'Recorded as your answer to this question once sim answer capture is wired.',
    },
  };
  // Bundle URL from the registry entry for THIS version; origin from the CSP resolution. Either
  // absent means no frame config, and the renderer falls back -- a sim question that refuses the
  // paper for lack of hosting config would hold the whole exam hostage to deployment.
  const registryPath = join(simsRoot, 'registry', 'registry.json');
  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      entries?: { id?: unknown; version?: unknown; bundle?: { page?: unknown } }[];
    };
    const entry = (registry.entries ?? []).find(
      (candidate) =>
        candidate.id === simId && (simVersion === undefined || candidate.version === simVersion),
    );
    const page =
      typeof entry?.bundle?.page === 'string' ? entry.bundle.page.replace(/^\.\//u, '') : null;
    if (page !== null) {
      const resolved = resolveCspSimOrigin(process.env);
      if (resolved.origin !== null) {
        return {
          ...extras,
          bundleUrl: `${resolved.origin}/sims/${simId}/${simVersion ?? 'latest'}/${page}`,
          simOrigin: resolved.origin,
        };
      }
    }
  } catch {
    // Unreadable registry or unresolvable origin: extras without a frame, by design (see above).
  }
  return extras;
}

export async function loadExamRunnerData(
  db: PrismaClient,
  userId: string,
  attemptId: string,
  simsRoot = join(process.cwd(), '..', '..', 'sims'),
): Promise<RunnerData | null> {
  // Own attempt or nothing. `isSameActor` lives in the answers route; here the check is inline
  // because the loader must not depend on the route it feeds.
  const attempt = await db.examAttempt.findFirst({
    where: { id: attemptId, studentId: userId },
    select: { id: true, policySnapshot: true },
  });
  if (attempt === null) return null;
  const policy = examPolicySchema.safeParse(attempt.policySnapshot);
  if (!policy.success) return null;

  const responses = await db.questionResponse.findMany({
    where: { attemptId },
    select: {
      id: true,
      questionId: true,
      position: true,
      answer: true,
      revision: true,
      question: { select: { spec: true } },
    },
    orderBy: { position: 'asc' },
  });
  if (responses.length === 0) return null;

  const questions: RunnerQuestion[] = [];
  for (const response of responses) {
    // Parsed as QuestionSpec first: the stored JSON is teacher-side and MAY carry a key, and the
    // projection below is what keeps it server-side. Parsing also refuses malformed specs here
    // rather than handing the registry something it cannot render.
    const parsed = (response.question.spec ?? null) as QuestionSpec | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      return null;
    }
    const prompt = promptOf(parsed);
    if (prompt === null) return null;
    // `publicQuestionSpec` ends in `assertNever`, so an unknown or malformed type THROWS rather than
    // returning a partial projection. Caught here into the same whole-paper refusal: a 500 on a
    // malformed question is a crash, and a crash is not fail-closed, it is fail-loud in the wrong place.
    let spec: PublicQuestionSpec;
    try {
      spec = publicQuestionSpec(parsed);
    } catch {
      return null;
    }
    // Simulation questions carry their renderer-required extras from the manifest. Unresolvable
    // extras refuse the paper: a sim frame without its text alternative is the accessibility failure
    // `P13-T4` guards at the manifest level, and rendering it anyway would bypass the guard.
    let sim: RunnerSimExtras | undefined;
    if (spec.type === 'simulation') {
      const extras = simExtrasFor(spec.simId, prompt, simsRoot, spec.simVersion);
      if (extras === null) return null;
      sim = extras;
    }
    questions.push({
      responseId: response.id,
      questionId: response.questionId,
      position: response.position,
      spec,
      prompt,
      answer: response.answer,
      revision: response.revision,
      ...(sim === undefined ? {} : { sim }),
    });
  }
  return { attemptId, policy: policy.data, questions };
}
