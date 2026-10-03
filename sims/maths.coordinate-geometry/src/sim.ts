/**
 * The protocol half.  (P6-T11, gold sim 20)
 *
 * ## THE FIRST SIMULATION DRAWN IN SVG, AND THE FIRST WITH UNDO
 *
 * Nineteen simulations in, every one drew into a `<canvas>`. For an orrery or a parabola that is the right
 * trade: thousands of moving marks, nothing that needs semantics. For a coordinate grid it is not, because a
 * grid is *meant* to be inspected — the numbers have to be in the DOM so a student can read them, and a
 * canvas has no text nodes at all. So this one draws `<line>`, `<text>` and `<rect>`, and the axis labels are
 * real text a screen reader and a print stylesheet can both use.
 *
 * ## THE MARKER IS THE ANSWER'S PLACE, AND UNDO IS A HISTORY OF PLACES
 *
 * The draggable thing is one point, so the whole history is a list of points. That is only possible because
 * it is one number pair, and it is why the history is worth storing rather than re-deriving: a teacher asking
 * "what did they do before this?" gets a real answer, because every entry is a thing the student did.
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import {
  canRedo,
  canUndo,
  clamp,
  constrain,
  describeAlternative,
  describeTask,
  EXTENT,
  format,
  type GridPoint,
  type History,
  initialHistory,
  type LineParams,
  push,
  redo,
  undo,
  yIntercept,
} from './model.js';

const SIM_ID = 'maths.coordinate-geometry';
const SIM_VERSION = '1.0.0';
const SIZE = 380;

const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  x1: num({ name: 'x1', label: 'first x', unit: '', min: -10, max: 10, default: -6 }),
  y1: num({ name: 'y1', label: 'first y', unit: '', min: -10, max: 10, default: -2 }),
  x2: num({ name: 'x2', label: 'second x', unit: '', min: -10, max: 10, default: 6 }),
  y2: num({ name: 'y2', label: 'second y', unit: '', min: -10, max: 10, default: 4 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): LineParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({
    x1: Number(values.x1),
    y1: Number(values.y1),
    x2: Number(values.x2),
    y2: Number(values.y2),
  });
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let params = paramsFrom({});
  /** The marker starts ON the y-axis at the origin, which is a real place and not the answer. */
  let history: History = initialHistory({ x: 0, y: 0 });

  const svgNs = 'http://www.w3.org/2000/svg';
  const el = <K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] =>
    document_.createElementNS(svgNs, name);

  const svg = el('svg');
  svg.id = 'sim-grid';
  svg.setAttribute(
    'viewBox',
    `${String(-EXTENT - 1)} ${String(-EXTENT - 1)} ${String((EXTENT + 1) * 2)} ${String((EXTENT + 1) * 2)}`,
  );
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    'A square coordinate grid with a straight line through two marked points.',
  );

  /** Grid units to SVG units. One viewBox unit per grid unit, so `y` is negated to point up. */
  const px = (point: GridPoint): { x: number; y: number } => ({ x: point.x, y: -point.y });

  const drawGrid = (): void => {
    for (let value = -EXTENT; value <= EXTENT; value += 1) {
      const vertical = el('line');
      vertical.setAttribute('x1', String(value));
      vertical.setAttribute('y1', String(-EXTENT));
      vertical.setAttribute('x2', String(value));
      vertical.setAttribute('y2', String(EXTENT));
      vertical.setAttribute('class', value === 0 ? 'sim-axis' : 'sim-grid-line');
      svg.append(vertical);
    }
    for (let value = -EXTENT; value <= EXTENT; value += 1) {
      const horizontal = el('line');
      horizontal.setAttribute('x1', String(-EXTENT));
      horizontal.setAttribute('y1', String(-value));
      horizontal.setAttribute('x2', String(EXTENT));
      horizontal.setAttribute('y2', String(-value));
      horizontal.setAttribute('class', value === 0 ? 'sim-axis' : 'sim-grid-line');
      svg.append(horizontal);
    }
    /**
     * AXIS LABELS ARE TEXT, NOT DRAWN PIXELS.
     *
     * Every other simulation here has a canvas with no text nodes at all, so its numbers live in a table
     * beside it and the canvas needs `role="img"`. Here they are `<text>`, which is what makes this grid
     * printable, zoomable and readable by assistive technology without a parallel implementation.
     */
    for (let value = -EXTENT; value <= EXTENT; value += 5) {
      if (value === 0) continue;
      const xLabel = el('text');
      xLabel.setAttribute('x', String(value + 0.2));
      xLabel.setAttribute('y', '1');
      xLabel.setAttribute('class', 'sim-tick');
      xLabel.textContent = format(value);
      svg.append(xLabel);

      const yLabel = el('text');
      yLabel.setAttribute('x', '0.2');
      yLabel.setAttribute('y', String(-value + 0.6));
      yLabel.setAttribute('class', 'sim-tick');
      yLabel.textContent = format(value);
      svg.append(yLabel);
    }
  };

  drawGrid();

  const lineEl = el('line');
  lineEl.setAttribute('class', 'sim-line');
  svg.append(lineEl);

  const crossing = el('circle');
  crossing.setAttribute('class', 'sim-crossing');
  crossing.setAttribute('r', '0.35');
  svg.append(crossing);

  /**
   * THE MARKER IS A `<rect>` WITH `tabindex`, NOT A DRAWN SQUARE.
   *
   * Because it has to be focusable. A canvas rectangle is a pixel region with no identity; an SVG element
   * is an element, so it takes focus, responds to arrow keys, and can carry a label — which is how this
   * simulation is usable without a pointer at all.
   */
  const marker = el('rect');
  marker.id = 'sim-marker';
  marker.setAttribute('x', '-0.4');
  marker.setAttribute('y', '-0.4');
  marker.setAttribute('width', '0.8');
  marker.setAttribute('height', '0.8');
  marker.setAttribute('class', 'sim-marker');
  marker.setAttribute('tabindex', '0');
  marker.setAttribute('role', 'slider');
  marker.setAttribute('aria-valuetext', 'the marker');
  svg.append(marker);

  root.append(svg);

  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  alternative.className = 'sim-alternative';
  root.append(status, alternative);

  const readout = document_.createElement('p');
  readout.id = 'sim-readout';

  const answerBox = document_.createElement('input');
  answerBox.type = 'number';
  answerBox.step = '0.5';
  answerBox.id = 'sim-answer';
  answerBox.setAttribute('aria-label', 'the y-coordinate where the line crosses the vertical axis');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const undoButton = document_.createElement('button');
  undoButton.type = 'button';
  undoButton.id = 'sim-undo';
  describeControl(undoButton, 'Undo the last move');
  const redoButton = document_.createElement('button');
  redoButton.type = 'button';
  redoButton.id = 'sim-redo';
  describeControl(redoButton, 'Redo the move you undid');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(answerBox, submit, undoButton, redoButton);
  root.append(readout, controls);

  let connection: SimConnection | null = null;

  /**
   * THE MARKER IS CONSTRAINED TO THE Y-AXIS, and that is not a limitation on the student.
   *
   * The question is "where does the line cross the vertical axis", so a marker that could sit anywhere would
   * invite an answer to a different question. Snapping to the axis is what makes the drag mean something.
   */
  const applyHistory = (next: History): void => {
    history = next;
    const at = px(history.present);
    marker.setAttribute('x', String(at.x - 0.4));
    marker.setAttribute('y', String(at.y - 0.4));
    marker.setAttribute('aria-valuetext', `marker at y ${format(history.present.y)}`);
    readout.textContent = `Marker on the vertical axis at y = ${format(history.present.y)}`;
    undoButton.disabled = !canUndo(history);
    redoButton.disabled = !canRedo(history);
  };

  const moveTo = (next: GridPoint): void => {
    // ONLY THE y COMPONENT MOVES. Passing the whole point through `constrain` would let a drag off the axis
    // be recorded, and the answer key would then be "wherever the student dropped it".
    const onAxis = constrain({ x: 0, y: next.y });
    applyHistory(push(history, onAxis));
  };

  /**
   * THE DRAG, IN SVG COORDINATES RATHER THAN PIXELS.
   *
   * The first version read `event.offsetX` and divided by a pixel width. That is wrong the moment the SVG is
   * scaled — which it is, because the viewBox is fixed and the element is `width: 100%`. It used
   * `getBoundingClientRect` and `getScreenCTM().inverse()` instead, which is the transform the browser has
   * already computed, so a student on a phone and a student on a 4K monitor drag identically.
   */
  const toGrid = (clientX: number, clientY: number): GridPoint => {
    const matrix = svg.getScreenCTM();
    if (matrix === null) return { x: 0, y: 0 };
    const inverse = matrix.inverse();
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(inverse);
    return { x: local.x, y: -local.y };
  };

  let dragging = false;
  const onDown = (event: PointerEvent): void => {
    dragging = true;
    marker.setPointerCapture(event.pointerId);
    moveTo(toGrid(event.clientX, event.clientY));
  };
  const onMove = (event: PointerEvent): void => {
    if (!dragging) return;
    moveTo(toGrid(event.clientX, event.clientY));
  };
  const onUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
    announce(status, readout.textContent ?? '');
  };
  marker.addEventListener('pointerdown', onDown);
  marker.addEventListener('pointermove', onMove);
  marker.addEventListener('pointerup', onUp);
  marker.addEventListener('pointercancel', onUp);

  /**
   * ARROW KEYS MOVE THE MARKER, AND THEY ARE NOT A KEYBOARD ACCOMMODATION — THEY ARE THE PRIMARY INPUT.
   *
   * A drag with a pointer is imprecise by nature: a half-unit snap means the nearest correct answer can be
   * unreachable with a finger. With arrow keys every lattice position is exactly reachable, and the
   * simulation says so on the marker itself.
   */
  marker.addEventListener('keydown', (event: KeyboardEvent) => {
    const step = event.shiftKey ? 1 : 0.5;
    if (event.key === 'ArrowUp') {
      moveTo({ x: 0, y: history.present.y + step });
    } else if (event.key === 'ArrowDown') {
      moveTo({ x: 0, y: history.present.y - step });
    } else if (event.key === 'z' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applyHistory(undo(history));
      announce(status, 'Undone.');
    } else if (event.key === 'y' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applyHistory(redo(history));
      announce(status, 'Redone.');
    } else {
      return;
    }
    event.preventDefault();
    announce(status, readout.textContent ?? '');
  });

  undoButton.addEventListener('click', () => {
    applyHistory(undo(history));
    announce(status, 'Undone.');
  });
  redoButton.addEventListener('click', () => {
    applyHistory(redo(history));
    announce(status, 'Redone.');
  });
  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(
      answerBox.value.trim() === '' ? null : Number(answerBox.value),
      { confidence: 1, explanation: describeTask(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const refresh = (): void => {
    const first = px({ x: params.x1, y: params.y1 });
    const second = px({ x: params.x2, y: params.y2 });
    lineEl.setAttribute('x1', String(first.x));
    lineEl.setAttribute('y1', String(first.y));
    lineEl.setAttribute('x2', String(second.x));
    lineEl.setAttribute('y2', String(second.y));

    const intercept = yIntercept(params);
    if (intercept === null) {
      // A VERTICAL LINE HAS NO SINGLE CROSSING, so nothing is marked and the marker stays where the
      // student put it. Drawing a dot at the origin would be inventing an answer.
      crossing.setAttribute('visibility', 'hidden');
    } else {
      crossing.setAttribute('visibility', 'visible');
      crossing.setAttribute('cx', '0');
      crossing.setAttribute('cy', String(-intercept));
    }
    alternative.textContent = describeAlternative(params);
  };

  const handlers: BridgeHandlers = {
    onResize: () => {
      refresh();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        params = paramsFrom((args.params as Record<string, unknown>) ?? {});
        applyHistory(initialHistory({ x: 0, y: 0 }));
        refresh();
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
    },
    onSetParams: (next) => {
      params = paramsFrom(next);
      applyHistory(initialHistory({ x: 0, y: 0 }));
      refresh();
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    /**
     * THE STUDENT'S SAVED WORK, AND HERE THE HISTORY IS THE WORK.
     *
     * Restoring the marker but not the undo stack would leave a student able to undo back to a position they
     * had never visited — and, worse, would make the restored diagram disagree with the keyboard's own
     * Ctrl+Z. Both halves go in together or neither does.
     */
    onRestore: (state) => {
      if (state === null || typeof state !== 'object') return;
      const s = state as Record<string, unknown>;
      params = paramsFrom({
        x1: Number(s.x1),
        y1: Number(s.y1),
        x2: Number(s.x2),
        y2: Number(s.y2),
      });
      const markerState = s.marker;
      const saved =
        markerState !== null && typeof markerState === 'object'
          ? (markerState as { x?: unknown; y?: unknown })
          : null;
      const restored: History = {
        past: Array.isArray(s.past)
          ? (s.past as unknown[])
              .filter(
                (item): item is GridPoint =>
                  item !== null &&
                  typeof item === 'object' &&
                  typeof (item as GridPoint).y === 'number',
              )
              .map((item) => constrain({ x: 0, y: (item as GridPoint).y }))
          : [],
        present: constrain({
          x: 0,
          y: typeof saved?.y === 'number' ? saved.y : 0,
        }),
        future: [],
      };
      // REDO DOES NOT SURVIVE A RELOAD. The branch a student was about to take is not part of the work they
      // did, and restoring it would put a "redo" button back into a state they never reached.
      applyHistory(restored);
      refresh();
    },
    getState: () => ({
      x1: params.x1,
      y1: params.y1,
      x2: params.x2,
      y2: params.y2,
      marker: { x: history.present.x, y: history.present.y },
      // The history is part of the state, so a save is a save of what they did and not just where they are.
      past: history.past.map((point) => ({ x: point.x, y: point.y })),
      answer: answerBox.value,
    }),
  };

  const transport = {
    post: (frame: unknown): void => {
      parent?.postMessage(frame, '*');
    },
    subscribe: (handler: (frame: unknown, source: unknown) => void): (() => void) => {
      const listener = (event: MessageEvent): void => {
        const type = (event.data as { type?: unknown } | null)?.type;
        if (typeof type === 'string') received.push(type);
        handler(event.data, event.source);
      };
      window_.addEventListener('message', listener);
      return () => window_.removeEventListener('message', listener);
    },
  };

  applyHistory(history);
  refresh();

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['slope', 'yIntercept', 'snap'],
  });

  return connection;
}
