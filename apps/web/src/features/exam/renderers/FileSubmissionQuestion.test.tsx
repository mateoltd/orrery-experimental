// @vitest-environment jsdom

import type { FileSubmissionSpec } from '@orrery/contracts/question';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendersContract } from './contractHarness';
import { FileSubmissionQuestion, uploadConstraints } from './FileSubmissionQuestion';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const spec: FileSubmissionSpec = {
  type: 'file_submission',
  maxFiles: 3,
  maxBytes: 2_097_152,
  allow: ['image/png', 'application/pdf'],
};

afterEach(cleanup);

const file = (name: string, size = 1024): File =>
  new File(['x'.repeat(size)], name, { type: 'application/octet-stream' });

const Stateful = ({
  initial = [] as readonly File[],
  spy,
  rejection,
}: {
  readonly initial?: readonly File[];
  readonly spy?: (files: readonly File[]) => void;
  readonly rejection?: string;
}) => {
  const [files, setFiles] = React.useState<readonly File[]>(initial);
  return (
    <FileSubmissionQuestion
      spec={spec}
      prompt="Upload your graph of the light curve."
      value={files}
      onChange={(next) => {
        setFiles(next);
        spy?.(next);
      }}
      rejection={rejection}
    />
  );
};

describe('as DRAWN', () => {
  it('is a single LABELLED file input, with no role, because the contract says `role: null`', async () => {
    await assertRendersContract('file_submission', <Stateful />);
    const input = screen.getByLabelText(/Upload your graph/);
    expect(input.getAttribute('type')).toBe('file');
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('renders NO DROP TARGET, because a drop target is pointer-only by construction', async () => {
    await assertRendersContract('file_submission', <Stateful />);
    /**
     * The contract forbids the drag outright rather than asking for a keyboard-reachable drop zone. A `div` with a
     * `dragover` handler has no role, is not focusable, and has no keyboard equivalent, so the student who cannot
     * drag is offered a worse path than the student with a mouse.
     *
     * Asserted on the ABSENCE of drop affordances rather than the presence of an accessible one, because an
     * accessible drag-and-drop region is a much harder thing to get right and this design declines to attempt it.
     */
    const dropZone = document.querySelector(
      '[ondragover], [ondrop], [role="button"][aria-label*="drop" i]',
    );
    expect(dropZone).toBeNull();
    expect(screen.queryByText(/drop .*here/i)).toBeNull();
    // The reachable control is the real one, and it is an `<input type="file">`.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it('states the constraints as TEXT rather than filtering the OS dialog with `accept`', async () => {
    const { container } = await assertRendersContract('file_submission', <Stateful />);
    expect(container.textContent).toContain('3 file(s) at most');
    expect(container.textContent).toContain('2 MB');
    expect(container.textContent).toContain('image/png');
    /**
     * `accept` filters the picker and nothing else, and it hides the student's only correct file with no way to
     * explain from the page why it is missing. Enforcement belongs in `onChange`, where a refusal can be stated.
     */
    const input = screen.getByLabelText(/Upload your graph/);
    expect(input.getAttribute('accept')).toBeNull();
  });

  it('`multiple` follows `maxFiles`, so the picker cannot silently take fewer than the spec allows', async () => {
    const { container } = await assertRendersContract('file_submission', <Stateful />);
    expect(container.querySelector('input[type="file"]')?.hasAttribute('multiple')).toBe(true);
  });

  it('associates BOTH the constraints and the rejection with the input', async () => {
    const { container } = await assertRendersContract(
      'file_submission',
      <Stateful rejection="That file is 3 MB; the limit is 2 MB." />,
    );
    const input = container.querySelector('input[type="file"]');
    const describedBy = input?.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ');
    expect(ids).toHaveLength(2);
    // Every id in `aria-describedby` resolves to a real element in THIS render.
    for (const id of ids) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(container.textContent).toContain('the limit is 2 MB');
  });

  it('lists the chosen files by name, because "1 file" does not say which one', async () => {
    await assertRendersContract(
      'file_submission',
      <Stateful initial={[file('curve-a.png'), file('curve-b.png')]} />,
    );
    expect(screen.getByText('curve-a.png')).toBeDefined();
    expect(screen.getByText('curve-b.png')).toBeDefined();
  });
});

describe('as DRIVEN', () => {
  it('is reachable by Tab and opens the picker with Space, as the contract requires', async () => {
    await assertRendersContract('file_submission', <Stateful />);
    await userEvent.tab();
    const input = screen.getByLabelText(/Upload your graph/);
    expect(document.activeElement).toBe(input);
    /**
     * The file picker is a native dialog that jsdom does not implement, so the click cannot be observed. What is
     * asserted is the part that is ours: the control is focusable, and it is a NATIVE file input, which is what
     * makes `Space`/`Enter` open a picker at all. A `div` with a click handler would have neither property.
     */
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('file');
  });

  it('reports whole `File` objects, not names and sizes', async () => {
    const spy = vi.fn();
    await assertRendersContract('file_submission', <Stateful spy={spy} />);
    const input = screen.getByLabelText(/Upload your graph/) as HTMLInputElement;
    const chosen = file('curve.png', 2048);
    // `userEvent.upload` writes through the native setter, which is what a real selection does.
    await userEvent.upload(input, chosen);
    expect(spy).toHaveBeenCalledTimes(1);
    const reported = spy.mock.calls[0]?.[0] as readonly File[];
    expect(reported).toHaveLength(1);
    // The object is a `File`, so content-type and last-modified survive to the grader.
    expect(reported[0]).toBeInstanceOf(File);
    expect(reported[0]?.name).toBe('curve.png');
    expect(reported[0]?.size).toBe(2048);
  });
});

describe('the constraint sentence', () => {
  it('is built from the spec, so it cannot drift from what is enforced', () => {
    expect(uploadConstraints(spec)).toBe(
      'Allowed: 3 file(s) at most; up to 2 MB each; accepted types: image/png, application/pdf.',
    );
  });

  it('is absent when the spec constrains nothing, rather than printing an empty "Allowed:"', () => {
    expect(uploadConstraints({ type: 'file_submission' })).toBeUndefined();
  });
});
