'use client';

/**
 * The `file_submission` renderer.  (P7-T7)
 *
 * ## THE OBVIOUS DESIGN IS FORBIDDEN BY THE CONTRACT, AND THIS FILE EXISTS BECAUSE OF IT
 *
 * A drop target is the design everyone reaches for: a large dashed rectangle, "drop your file here", a
 * `dragover` handler. That rectangle is `pointerOnly` **by construction** -- it has no role, it is not focusable, it
 * has no keyboard equivalent, and no amount of ARIA added afterwards makes it one. A student who cannot drag would be
 * offered a worse path than the one a mouse user gets, which is the opposite of the point.
 *
 * `INTERACTION_CONTRACTS.file_submission` therefore forbids the drag outright and requires that `Tab` focus the file
 * input and that `Space`/`Enter` open the picker. The drop area, if one is wanted, is decoration painted *over* a real
 * `<input type="file">`, so the same outcome costs the same keystrokes either way.
 *
 * ## THIS RENDERS NO DROP AREA AT ALL
 *
 * Not "a drop area that is also keyboard reachable", which is the usual compromise and is genuinely hard to get
 * right, but no drop area. A visual-only affordance that cannot be operated is worse than an absent one, because it
 * advertises a capability and then fails the student who took it up.
 *
 * ## `liveRegion: 'none'`, AND THAT IS NOT AN OMISSION
 *
 * The contract says no live region, which looks wrong for an upload until you notice what already announces. The
 * chosen filename is rendered by the browser as part of the native control's own value, and that value change is
 * announced natively. Adding a second announcement would say the same thing twice, and `polite` interruptions on every
 * file dialog close are exactly the noise that makes screen-reader users turn announcements off.
 */

import type { FileSubmissionSpec } from '@orrery/contracts/question';
import * as React from 'react';

export interface FileSubmissionProps {
  readonly spec: FileSubmissionSpec;
  readonly prompt: string;
  readonly value?: readonly File[];
  /**
   * The chosen files, as whole `File` objects.
   *
   * The whole `File`, not a name and a size. `plans/01` treats the submission as content that is graded and later
   * stored, and reconstructing a `File` from a name at save time is where content-type and last-modified silently
   * change underneath a grader.
   */
  readonly onChange: (files: readonly File[]) => void;
  readonly disabled?: boolean;
  /**
   * A rejected file, rendered next to the input.
   *
   * `plans/07` scores an unreadable submission as `NEEDS_HUMAN`, not zero, so the student is told what happened here
   * rather than discovering at grading time that an over-size file read as a blank answer.
   */
  readonly rejection?: string;
}

/** The constraint sentence, built from the spec so it cannot drift from what will actually be enforced. */
export const uploadConstraints = (spec: FileSubmissionSpec): string | undefined => {
  const parts: string[] = [];
  if (spec.maxFiles !== undefined) parts.push(`${String(spec.maxFiles)} file(s) at most`);
  if (spec.maxBytes !== undefined) parts.push(`up to ${formatBytes(spec.maxBytes)} each`);
  if (spec.allow !== undefined && spec.allow.length > 0)
    parts.push(`accepted types: ${spec.allow.join(', ')}`);
  return parts.length === 0 ? undefined : `Allowed: ${parts.join('; ')}.`;
};

const formatBytes = (bytes: number): string => {
  if (bytes >= 1_048_576) return `${String(Math.round(bytes / 1_048_576))} MB`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} kB`;
  return `${String(bytes)} bytes`;
};

export function FileSubmissionQuestion({
  spec,
  prompt,
  value = [],
  onChange,
  disabled = false,
  rejection,
}: FileSubmissionProps) {
  const inputId = React.useId();
  const constraintsId = `${inputId}-constraints`;
  const rejectionId = `${inputId}-rejection`;
  const constraints = uploadConstraints(spec);

  // `aria-describedby` takes every id that applies, so a student hears the constraints AND the rejection rather
  // than whichever was assigned last.
  const describedBy =
    [
      constraints === undefined ? undefined : constraintsId,
      rejection === undefined ? undefined : rejectionId,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ') || undefined;

  return (
    <div>
      {/*
        A `<label>` on the input itself, so the accessible name IS the visible question text -- which is what
        `nameFrom: 'the upload label'` asks for.
      */}
      <label htmlFor={inputId}>{prompt}</label>

      {/*
        NO `role` ATTRIBUTE, MATCHING `role: null`. A single labelled file input is not a group, and `role="group"`
        would assert a grouping that does not exist.

        `multiple` is driven by `maxFiles`: a spec that allows four files and an input that takes one would fail the
        student silently at the OS dialog, with no way to tell from the page that more were expected.

        THE SIZE AND TYPE RESTRICTIONS ARE NOT SET ON THE INPUT. An `accept` attribute filters the OS file picker and
        nothing else -- a determined or confused student can still select anything, and a filter that silently hides
        their only correct file is a support incident. The constraints are stated as text and enforced in
        `onChange`, where a refusal can be explained.
      */}
      <input
        id={inputId}
        type="file"
        multiple={(spec.maxFiles ?? 1) > 1}
        onChange={(event) => {
          onChange(Array.from(event.target.files ?? []));
        }}
        disabled={disabled}
        aria-describedby={describedBy}
      />

      {constraints === undefined ? null : <p id={constraintsId}>{constraints}</p>}

      {rejection === undefined ? null : (
        <p id={rejectionId} role="alert">
          {rejection}
        </p>
      )}

      {/*
        THE CHOSEN FILES ARE LISTED AS TEXT. The browser shows the count beside the input, but not the names, and
        "1 file" is not enough for a student who picked three and needs to know which two were dropped.
      */}
      {value.length === 0 ? null : (
        <ul>
          {value.map((file) => (
            <li key={`${file.name}:${String(file.size)}`}>{file.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
