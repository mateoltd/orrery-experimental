/**
 * The render entry. Browser only, inside the sandboxed frame.  (P6-T11, gold sim 23)
 *
 * ## WHY IT IS A LOADER AND NOT A RENDERER
 *
 * The blocks and the comparison counter live in `sim.ts`, next to the state they draw, because a drawing
 * created here and updated there is two files keeping one piece of state in step. What is left is the boot —
 * and the guard, because this file is parsed under Node by the build, where `document` does not exist.
 */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.parent !== window) {
  const boot = async (): Promise<void> => {
    try {
      const { startSim } = await import('./sim.js');
      startSim(document, window, window.parent);
    } catch (error) {
      // A simulation that dies during boot is silent by default: the frame shows an empty page and the host
      // waits out its handshake timeout with no idea why. Saying so is the difference between a five-minute
      // fix and a day of it.
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
