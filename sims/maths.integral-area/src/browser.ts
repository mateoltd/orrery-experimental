/**
 * The render entry. Browser only, inside the sandboxed frame.  (P12-T2, card 135 `maths.integral-area`)
 *
 * ## WHY IT IS A LOADER AND NOT A RENDERER
 *
 * The whole rendering lives in `sim.ts`, next to the state it renders from. What is left here is the boot,
 * and the guard, because this file is parsed under Node by the build where `document` does not exist.
 * A simulation that dies during boot is silent by default — the frame shows an empty page and the host
 * waits out its handshake timeout with no idea why — so a failure is posted as `sim:error` and written to
 * the console with its stack.
 */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.parent !== window) {
  const boot = async (): Promise<void> => {
    try {
      const { startSim } = await import('./sim.js');
      startSim(document, window, window.parent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        '[sim] failed to start:',
        message,
        error instanceof Error ? error.stack : 'no stack',
      );
      try {
        window.parent.postMessage(
          { type: 'sim:error', code: 'INTERNAL', message, recoverable: true },
          '*',
        );
      } catch {
        // The host may already be gone, and there is nothing further to say.
      }
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void boot();
    });
  } else {
    void boot();
  }
}
