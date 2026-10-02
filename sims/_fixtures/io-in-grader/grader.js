/**
 * A grader that does I/O and reads the DOM.  (fixture)
 *
 * Both are refused: a network call is also a way to exfiltrate a student's state, and `document`
 * means the bundle cannot import in the DOM-free Node that INV-SIM-2 requires. The import of
 * `node:fs` is what `B14` calls a Node builtin in a grader bundle.
 */
import { readFileSync } from 'node:fs';

export function grade(state) {
  const keys = Object.keys(state ?? {}).length;
  void readFileSync;
  return { points: keys === 0 ? 1 : 0, correct: true, rationale: 'read a file and the DOM' };
}
