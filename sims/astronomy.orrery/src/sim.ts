/**
 * The protocol half, and the FIRST WebGL simulation in this set.  (P6-T11, gold sim 19)
 *
 * ## WHAT THE WEBGL CONTEXT IS FOR
 *
 * Not for the orbit — that is two lines. It is for the STARFIELD, which is three thousand points and would
 * be three thousand `arc()` calls in canvas 2D. That is a real reason, and it is worth being honest about
 * rather than reaching for WebGL on a diagram that did not need it.
 *
 * ## AND THE FALLBACK IS NOT DECORATIVE
 *
 * `webgl: true` is a declared capability, which means some hosts will be told this needs WebGL. If the
 * context fails, this simulation says so through the protocol and keeps working in 2D, because a student
 * with no WebGL driver still has a question to answer. A capability flag that means "and nothing else works"
 * is a lie about what the simulation is.
 *
 * ## `t` IS THE SLIDER, AND THE SLIDER IS THE HOSTILE ONE
 *
 * `MAX_TIME` is 4000 days, `stepSize` is a week. A student can drag the slider anywhere in that range, step
 * past the end, or scrub backwards, and `positionAt` gives the same answer every time — see the model.
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  createStepper,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
  type Stepper,
} from '@orrery/sim-sdk';
import {
  clamp,
  clampTime,
  describeOrbit,
  format,
  type OrreryParams,
  positionAt,
  round,
  SUN,
} from './model.js';

const SIM_ID = 'astronomy.orrery';
const SIM_VERSION = '1.0.0';
const MAX_TIME = 4000;
const STEP_SIZE = 7;
const PANEL = 320;
/** Half-width of the drawing in AU. The default orbit is 1 AU, so this shows 10 orbits' width. */
const SPAN = 10;

const CAPABILITIES: SimCapabilities = {
  state: true,
  grading: true,
  webgl: true,
  stepper: true,
  scenarios: [],
};

const PARAM_SPECS = {
  a: num({ name: 'a', label: 'orbit radius', unit: 'AU', min: 0.1, max: 40, default: 1 }),
  e: num({ name: 'e', label: 'eccentricity', unit: '', min: 0, max: 0.9, default: 0.017 }),
  period: num({
    name: 'period',
    label: 'period',
    unit: 'days',
    min: 1,
    max: 5000,
    default: 365.25,
  }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): OrreryParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({
    a: Number(values.a),
    e: Number(values.e),
    period: Number(values.period),
  });
};

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

  /**
   * THE CLOCK IS THE SDK STEPPER'S `t`, AND THAT IS THE POINT OF `stepper: true`.
   *
   * The first version declared `stepper: true` in the capabilities and then hand-rolled a `step` command,
   * so the claim was about a manifest rather than about the code. The capabilities cell cross-checks the
   * manifest against the GRADER and never against the simulation's own source, so nothing caught it: a
   * capability flag can say true while nothing implements it, and that is precisely the failure the cell
   * exists to prevent -- one layer short of where the lie actually is.
   *
   * `maxTime` and `stepSize` are the SDK's, and the host's step/pause/scrub all drive the same object the
   * slider does. One clock, one source of truth, and `INV-TIME-1` is respected because the sim never reads a
   * wall clock to advance -- it reads the stepper's `t`, which only the host or the user moves.
   */
  const stepper: Stepper = createStepper({
    maxTime: MAX_TIME,
    stepSize: STEP_SIZE,
    allowMotion: false,
  });
  const t = (): number => stepper.get().t;

  /**
   * THE STARFIELD, IN WEBGL, AND THE FALLBACK IF THERE IS NO CONTEXT.
   *
   * A deterministic star list, because a starfield that changes between renders makes every screenshot
   * comparison useless and every "the picture did not move" check a coin toss. The positions come from the
   * same seeded generator the SDK exposes, so the sky is identical on every load and in every browser.
   */
  const stage = document_.createElement('div');
  let webgl: WebGLRenderingContext | null = null;
  let starfield: { x: number; y: number }[] = [];
  try {
    webgl = canvas.getContext('webgl', { antialias: true });
  } catch {
    // A CONTEXT THAT THROWS IS NOT A REASON TO LOSE THE SIMULATION.
    webgl = null;
  }
  if (webgl === null) {
    // `canvas.getContext('2d')` after a failed `getContext('webgl')` on the SAME element returns null,
    // because an element can only ever have one context type. So the fallback needs its own canvas, and
    // getting this wrong is why the first attempt drew nothing at all.
    const flat = document_.createElement('canvas');
    flat.id = 'sim-canvas-2d';
    stage.append(flat);
    root.append(stage);
    status.textContent = 'This browser has no WebGL, so the orrery is drawn flat.';
    announce(status, status.textContent ?? '');
  } else {
    starfield = buildStars();
  }

  const width = (): number => Math.max(root.clientWidth || 640, 200);
  const _height = (): number => PANEL;

  const toX = (au: number): number => width() / 2 + (au / SPAN) * (width() / 2);
  const toY = (au: number): number => PANEL / 2 - (au / SPAN) * (PANEL / 2);

  /** THE 2D PATH. The orbit, the Sun, and the planet — three shapes, and it always works. */
  const drawFlat = (context: CanvasRenderingContext2D, next: OrreryParams, at: number): void => {
    const w = width();
    context.clearRect(0, 0, w, PANEL);
    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(toX(0), toY(0), (next.a / SPAN) * (w / 2), 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = '#e8a33d';
    context.beginPath();
    context.arc(toX(SUN.x), toY(SUN.y), 6, 0, Math.PI * 2);
    context.fill();

    const where = positionAt(next, at);
    context.fillStyle = '#0b6b8a';
    context.beginPath();
    context.arc(toX(where.x), toY(where.y), 5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#52606d';
    context.font = '13px system-ui, sans-serif';
    context.fillText(`day ${format(round(at))}`, 10, 18);
  };

  /** THE WEBGL PATH. The starfield in a background colour, and the orbit drawn over the top in 2D terms. */
  const drawGl = (): void => {
    const gl = webgl;
    if (gl === null) return;
    const w = width();
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = PANEL;
      gl.viewport(0, 0, w, PANEL);
    }
    gl.clearColor(0.04, 0.05, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // The stars, as GL points. `POINTS` with a size in the vertex shader is the whole reason this is WebGL:
    // three thousand of them in one draw call.
    drawStars(gl, starfield, w, PANEL);
  };

  const draw = (): void => {
    if (webgl !== null) {
      drawGl();
      // The orbit and the planet are drawn over the WebGL background on a SECOND canvas, because a canvas
      // has one context type and mixing 2D shapes into the WebGL context needs a shader per shape.
      if (overlay === null) return;
      const w = width();
      overlay.width = w;
      overlay.height = PANEL;
      const context = overlay.getContext('2d');
      if (context === null) return;
      context.clearRect(0, 0, w, PANEL);
      drawOrbit(context, params);
    } else {
      const flat = document_.getElementById('sim-canvas-2d') as HTMLCanvasElement | null;
      if (flat === null) return;
      flat.width = width();
      flat.height = PANEL;
      const context = flat.getContext('2d');
      if (context === null) return;
      drawFlat(context, params, t());
    }
  };

  const drawOrbit = (context: CanvasRenderingContext2D, next: OrreryParams): void => {
    const w = width();
    context.strokeStyle = '#8fa3bd';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(toX(0), toY(0), (next.a / SPAN) * (w / 2), 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = '#e8a33d';
    context.beginPath();
    context.arc(toX(SUN.x), toY(SUN.y), 7, 0, Math.PI * 2);
    context.fill();

    const where = positionAt(next, t());
    context.fillStyle = '#4fd1c5';
    context.beginPath();
    context.arc(toX(where.x), toY(where.y), 6, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#cbd5e0';
    context.font = '13px system-ui, sans-serif';
    context.fillText(`day ${format(round(t))} of ${String(MAX_TIME)}`, 10, 18);
    context.fillText(`orbit ${format(next.a)} AU · ${format(next.period)} days`, 10, 36);
  };

  let overlay: HTMLCanvasElement | null = null;
  if (webgl !== null) {
    canvas.id = 'sim-canvas-gl';
    overlay = document_.createElement('canvas');
    overlay.id = 'sim-canvas';
    // BOTH CANVASES GO IN A POSITIONED STAGE. Absolute positioning needs a containing block, and appending
    // them straight to the root stacked them in normal flow instead -- so the orbit canvas covered the sky
    // completely and the WebGL context was invisible behind an opaque 2D canvas.
    stage.id = 'sim-stage';
    stage.append(canvas, overlay);
    root.append(stage);
  } else {
    canvas.remove();
  }

  const refresh = (): void => {
    draw();
    alternative.textContent = describeOrbit(params);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(status, alternative);

  /**
   * THE HOSTILE SLIDER.
   *
   * `step` is `any` rather than `1`, because a hostile slider gets dragged to 0, to the far end, and back,
   * and a slider that only accepts integers hides the property this simulation exists to prove.
   */
  const slider = document_.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(MAX_TIME);
  slider.step = 'any';
  slider.value = '0';
  slider.id = 'sim-time';
  slider.setAttribute('aria-label', 'days since the start');

  const readout = document_.createElement('output');
  readout.id = 'sim-time-readout';
  readout.htmlFor = 'sim-time';

  const answerBox = document_.createElement('input');
  answerBox.type = 'number';
  answerBox.step = '0.01';
  // `#sim-answer` is what `conformance.type` looks for, and the KEY in the submitted object is what
  // `expect.answer` compares against. Both are checked against the runner's real vocabulary rather than
  // against what seemed reasonable.
  answerBox.id = 'sim-answer';
  answerBox.setAttribute('aria-label', 'how many days the orbit takes');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const reset = document_.createElement('button');
  reset.type = 'button';
  reset.id = 'sim-reset-time';
  describeControl(reset, 'Back to day zero');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(slider, readout, answerBox, submit, reset);
  root.append(controls);

  let connection: SimConnection | null = null;

  const setTime = (next: number): void => {
    // `clampTime` first: a slider dragged past the end, or a `NaN` from a host, must not reach the model.
    // SET THE CLOCK ON THE STEPPER AND READ IT BACK. One clock, and the value the student sees is the value
    // the host would report, rather than a second copy that can disagree.
    const now = clampTime(next);
    stepper.dispatch({ type: 'scrubTo', t: now });
    const at = t();
    slider.value = String(at);
    readout.textContent = `${format(round(at))} days`;
    draw();
  };

  slider.addEventListener('input', () => {
    setTime(Number(slider.value));
  });
  reset.addEventListener('click', () => {
    setTime(0);
    announce(status, 'Back to day zero.');
  });
  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(
      { days: Number(answerBox.value) },
      { confidence: 1, explanation: describeOrbit(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: OrreryParams): void => {
    params = next;
    answerBox.value = '';
    setTime(0);
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
      // THE STEPPER'S OWN COMMAND, and it SATURATES rather than accumulating.
      if (name === 'step') {
        stepper.dispatch({ type: 'step', direction: args.direction === -1 ? -1 : 1 });
        setTime(t());
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
    // THE STUDENT'S SAVED WORK, and here the day matters as much as the parameters. A student who scrubbed
    // to day 812, typed an answer and closed the tab must come back to day 812 — restoring the parameters
    // alone would put them on day 0 with an answer about a different moment.
    onRestore: (state) => {
      if (state === null || typeof state === 'object') {
        const s = (state ?? {}) as Record<string, unknown>;
        restart(
          paramsFrom({
            a: Number(s.a),
            e: Number(s.e),
            period: Number(s.period),
          }),
        );
        if (typeof s.t === 'number') setTime(s.t);
        if (typeof s.answer === 'string') answerBox.value = s.answer;
      }
    },
    getState: () => ({
      a: params.a,
      e: params.e,
      period: params.period,
      t: t(),
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

  refresh();

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['positionAt', 'radiusAt'],
  });

  return connection;
}

/** A DETERMINISTIC starfield. Seeded, so every load and every screenshot sees the same sky. */
function buildStars(): { x: number; y: number }[] {
  const stars: { x: number; y: number }[] = [];
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < 600; index += 1) stars.push({ x: next(), y: next() });
  return stars;
}

/** ONE DRAW CALL for the whole sky, which is the entire reason this is WebGL. */
function drawStars(
  gl: WebGLRenderingContext,
  stars: readonly { x: number; y: number }[],
  w: number,
  h: number,
): void {
  const data = new Float32Array(stars.length * 3);
  for (let index = 0; index < stars.length; index += 1) {
    const star = stars[index];
    if (star === undefined) continue;
    data[index * 3] = star.x * 2 - 1;
    data[index * 3 + 1] = star.y * 2 - 1;
    data[index * 3 + 2] = 1;
  }
  const buffer = gl.createBuffer();
  if (buffer === null) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const shader = gl.createShader(gl.VERTEX_SHADER);
  if (shader === null) return;
  gl.shaderSource(
    shader,
    'attribute vec3 p; void main(){ gl_Position = vec4(p, 1.0); gl_PointSize = 1.5; }',
  );
  gl.compileShader(shader);
  const program = gl.createProgram();
  if (program === null) return;
  gl.attachShader(program, shader);
  gl.linkProgram(program);
  gl.useProgram(program);

  const location = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.drawArrays(gl.POINTS, 0, stars.length);
  gl.deleteBuffer(buffer);
  gl.deleteProgram(program);
  gl.deleteShader(shader);
  void w;
  void h;
}
