/**
 * The protocol half.  (P6-T11, gold sim 18)
 *
 * ## THE STUDENT'S WORK IS CAPTURED, NOT SCORED
 *
 * Every other simulation here turns a student's input into a mark inside this frame. This one collects what
 * was asserted and hands it over unaltered, and that is the reason the simulation exists rather than a
 * limitation of it: a mark that looks machine-decided when a human decided it is worse than no mark, because
 * a teacher who trusts it will not read the work.
 *
 * So there is no "is this right" anywhere in this file. There is only "what did they say".
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
import { clamp, describeForces, type ScenarioParams, weightNewtons } from './model.js';

const SIM_ID = 'physics.free-body-diagram';
const SIM_VERSION = '1.0.0';
const PANEL = 200;
/** Arrow length. Fixed, and deliberately NOT scaled by any magnitude. */
const ARM = 58;

const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  mass: num({ name: 'mass', label: 'mass', unit: 'kg', min: 0.5, max: 20, default: 2 }),
  friction: num({ name: 'friction', label: 'friction', unit: 'N', min: 0, max: 20, default: 3 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): ScenarioParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({ mass: Number(values.mass), friction: Number(values.friction) });
};

/** The three forces this scenario offers, in display order. */
const FORCE_NAMES = ['weight', 'normal', 'friction'] as const;

interface Row {
  readonly on: HTMLInputElement;
  readonly magnitude: HTMLInputElement;
  readonly direction: HTMLSelectElement;
}

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const canvas = document_.createElement('canvas');
  const status = document_.createElement('p');
  const alternative = document_.createElement('p');
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let params = paramsFrom({});

  const arrow = (
    context: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    dx: number,
    dy: number,
  ): void => {
    const tipX = fromX + dx * ARM;
    const tipY = fromY + dy * ARM;
    context.strokeStyle = '#9b2c2c';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(tipX, tipY);
    context.stroke();
    // THE HEAD. An arrow without one is a line segment, and a line segment has no direction — which is the
    // one thing this diagram exists to communicate.
    context.fillStyle = '#9b2c2c';
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(tipX - dx * 14 + dy * 7, tipY - dy * 14 - dx * 7);
    context.lineTo(tipX - dx * 14 - dy * 7, tipY - dy * 14 + dx * 7);
    context.closePath();
    context.fill();
  };

  const draw = (): void => {
    const width = root.clientWidth || 640;
    canvas.id = 'sim-canvas';
    canvas.width = width;
    canvas.height = PANEL;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PANEL)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, PANEL);

    const cx = width / 2;
    const cy = PANEL / 2;

    // THE FLOOR. Drawn under the crate and never hatched, because hatching reads as friction and this crate
    // has friction regardless of how the floor is drawn.
    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(20, cy + 30);
    context.lineTo(width - 20, cy + 30);
    context.stroke();

    context.strokeStyle = '#52606d';
    context.lineWidth = 2;
    context.strokeRect(cx - 34, cy - 24, 68, 54);

    // THE STUDENT'S ARROWS, from what they ticked. Ticks are read from the inputs, never from
    // `forcesFor`, so the diagram cannot show an answer the student did not assert.
    let slot = 0;
    for (const name of FORCE_NAMES) {
      const row = rows[name];
      if (!row.on.checked) continue;
      const dx = row.direction.value === 'left' ? -1 : row.direction.value === 'right' ? 1 : 0;
      const dy = row.direction.value === 'up' ? -1 : row.direction.value === 'down' ? 1 : 0;
      if (dx === 0 && dy === 0) continue;
      // FANNED OUT, because two arrows in the same direction from the same point is one arrow.
      const nudge = slot * 14;
      arrow(context, cx + (dx === 0 ? nudge : 0), cy + (dx !== 0 ? nudge : 0), dx, dy);
      slot += 1;
    }

    context.fillStyle = '#52606d';
    context.font = '12px system-ui, sans-serif';
    context.fillText(`${weightNewtons(params.mass).toFixed(2)} kg`, 8, 18);
    // THE ARROW LENGTH IS NOT THE MAGNITUDE, and this says so on the drawing itself. A student who compares
    // arrow lengths is comparing something the simulation never encoded.
    context.fillText('arrow length is not to scale', 8, 34);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeForces(params);
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  // THE CLAIM TABLE. A row per force, ticked or not, each with a magnitude and a direction, so the answer
  // is a list of assertions a teacher can read down rather than a sentence they have to parse.
  const table = document_.createElement('div');
  table.id = 'sim-claims';
  const rows = {} as Record<(typeof FORCE_NAMES)[number], Row>;
  for (const name of FORCE_NAMES) {
    const row = document_.createElement('div');
    row.id = `sim-row-${name}`;
    row.className = 'sim-claim';

    const on = document_.createElement('input');
    on.type = 'checkbox';
    on.id = `sim-${name}-acts`;
    const label = document_.createElement('label');
    label.htmlFor = on.id;
    label.textContent = `${name} acts`;

    const magnitude = document_.createElement('input');
    magnitude.type = 'number';
    magnitude.step = '0.01';
    magnitude.id = `sim-${name}-magnitude`;
    magnitude.setAttribute('aria-label', `${name} magnitude in newtons`);

    const direction = document_.createElement('select');
    direction.id = `sim-${name}-direction`;
    direction.setAttribute('aria-label', `${name} direction`);
    for (const option of ['up', 'down', 'left', 'right'] as const) {
      const element = document_.createElement('option');
      element.value = option;
      element.textContent = option;
      direction.append(element);
    }

    row.append(on, label, magnitude, direction);
    table.append(row);
    rows[name] = { on, magnitude, direction };
  }
  root.append(table);

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const clear = document_.createElement('button');
  clear.type = 'button';
  clear.id = 'sim-clear';
  describeControl(clear, 'Clear the diagram');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(submit, clear);
  root.append(controls);

  let connection: SimConnection | null = null;

  for (const name of FORCE_NAMES) {
    rows[name].on.addEventListener('change', draw);
    rows[name].direction.addEventListener('change', draw);
  }

  clear.addEventListener('click', () => {
    for (const name of FORCE_NAMES) {
      rows[name].on.checked = false;
      rows[name].magnitude.value = '';
    }
    draw();
    status.textContent = 'Diagram cleared.';
    announce(status, 'Diagram cleared.');
  });

  submit.addEventListener('click', () => {
    const claims: { claim: string; evidence: string }[] = [];
    for (const name of FORCE_NAMES) {
      const row = rows[name];
      if (!row.on.checked) continue;
      const magnitude = row.magnitude.value.trim();
      claims.push({
        claim: `${name} acts, pointing ${row.direction.value}`,
        // THE STUDENT'S OWN NUMBER, VERBATIM, INCLUDING A BLANK ONE.
        //
        // A blank magnitude is recorded as `''` and NOT as `0`. An unanswered magnitude is a MISSING claim,
        // and a rubric that cannot tell "no value given" from "zero newtons" cannot mark either fairly — so
        // the distinction has to survive the transport, and this is the only place it can be made.
        evidence: magnitude === '' ? `${name}: no magnitude given` : `${name}: ${magnitude} N`,
      });
    }
    connection?.bridge?.reportAnswer(
      { claims, note: 'rubric-marked: a person decides these marks' },
      { confidence: 1, explanation: describeForces(params) },
    );
    status.textContent = `Answer submitted with ${String(claims.length)} claim(s) for a teacher to mark`;
    announce(status, status.textContent ?? '');
  });

  const restart = (next: ScenarioParams): void => {
    params = next;
    for (const name of FORCE_NAMES) {
      rows[name].on.checked = false;
      rows[name].magnitude.value = '';
    }
    refresh();
  };

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        restart(paramsFrom((args.params as Record<string, unknown>) ?? {}));
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      if (name === 'loadScenario') {
        // A crate pulled UPWARD, so friction points DOWN — the case where copying "friction opposes the
        // motion" from a mental picture of a horizontal crate gets the arrow the wrong way up.
        restart(paramsFrom({ mass: 3, friction: 5 }));
        return;
      }
    },
    onSetParams: (next) => {
      restart(paramsFrom(next));
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    // THE STUDENT'S SAVED WORK, and for this simulation it is the whole point: a rubric-marked diagram is
    // unfinished work by definition, so losing it on a reload loses the only thing the student produced.
    onRestore: (state) => {
      if (state === null || typeof state !== 'object') return;
      const s = state as Record<string, unknown>;
      restart(paramsFrom({ mass: Number(s.mass), friction: Number(s.friction) }));
      const saved = s.forces;
      if (saved !== null && typeof saved === 'object') {
        for (const [name, value] of Object.entries(saved as Record<string, unknown>)) {
          const row = rows[name as (typeof FORCE_NAMES)[number]];
          if (row === undefined || value === null || typeof value !== 'object') continue;
          const record = value as { on?: unknown; magnitude?: unknown; direction?: unknown };
          row.on.checked = record.on === true;
          row.magnitude.value = typeof record.magnitude === 'string' ? record.magnitude : '';
          if (typeof record.direction === 'string') row.direction.value = record.direction;
        }
        draw();
      }
    },
    getState: () => ({
      mass: params.mass,
      friction: params.friction,
      forces: Object.fromEntries(
        FORCE_NAMES.map((name) => [
          name,
          {
            on: rows[name].on.checked,
            magnitude: rows[name].magnitude.value,
            direction: rows[name].direction.value,
          },
        ]),
      ),
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

  refresh();
  focusEntryPoint(root);

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['forcesFor', 'weightNewtons'],
  });

  return connection;
}
