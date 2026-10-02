/**
 * The two origins every browser-facing simulation check runs against.
 *
 * ## WHY THIS IS SHARED, AND WHY IT MATTERS
 *
 * `sim:conformance` and `sim:sandbox-escape` both need an APP origin and a SIM origin that are genuinely
 * different, and getting that wrong is INVISIBLE: every assertion still runs, and every one of them is
 * about a same-origin arrangement where cross-origin isolation has nothing to enforce. The first version
 * of the conformance runner served bundles out of the REGISTRY directory rather than from each sim's own
 * `dist`, because the registry's paths are relative to that -- and every simulation 404'd with an error
 * that read like a broken bundle.
 *
 * One definition, used by both, so a path mistake can be made once and fixed once.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const HARNESS_BUNDLE = join(ROOT, 'node_modules/.cache/orrery-conformance/harness.js');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // `text/html` matters: without it the browser DOWNLOADS the page instead of rendering it, which is
  // the same class of mistake as pointing a frame at a script.
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The sim origin.
 *
 * CORP `cross-origin` and a permissive CORS header are not politeness — a browser will refuse the
 * bundle outright without CORP, so an origin that omits it fails every simulation at once with an
 * error that looks like a broken bundle rather than a missing header.
 */
export const startSimOrigin = async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim.local');
    if (url.pathname === '/__sim_origin_probe') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end('ok');
      return;
    }
    // Served out of each sim's own `dist`, because the registry's bundle paths are relative to THAT
    // directory and not to the registry. Serving them out of the registry 404s every simulation with
    // an error that looks like a broken bundle.
    const [, simId, version, file] = url.pathname.split('/');
    const path =
      simId === undefined || version === undefined || file === undefined
        ? null
        : join(ROOT, 'sims', simId, 'dist', file);
    const distRoot = join(ROOT, 'sims');
    if (path === null || !path.startsWith(distRoot) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    void readFile(path).then((body) => {
      res.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        'cross-origin-resource-policy': 'cross-origin',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(body);
    });
  });
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
};

/** The app origin. Serves the harness page and its bundle. */
export /**
 * The harness page.
 *
 * A loader, not a page: it pulls in the bundle that renders the REAL `SimulationFrame`, so neither suite
 * can pass against a simplified stand-in.
 */
const harnessPage = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Simulation frame harness</title>
  </head>
  <body>
    <script src="/harness.js"></script>
  </body>
</html>`;

export const startAppOrigin = async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://app.local');
    if (url.pathname === '/' || url.pathname === '/harness.js') {
      // Read per request rather than once at startup, so a rebuilt harness needs no restart -- and so a
      // missing bundle answers 500 with a sentence instead of throwing inside the handler, which Node
      // answers by dropping the connection and the test by timing out for no stated reason.
      const send = (body, type) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      if (url.pathname === '/') {
        send(harnessPage(), MIME['.html']);
        return;
      }
      void readFile(HARNESS_BUNDLE)
        .then((body) => send(body, MIME['.js']))
        .catch(() => {
          res.writeHead(500, { 'content-type': 'text/plain' }).end('harness bundle missing');
        });
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
};
