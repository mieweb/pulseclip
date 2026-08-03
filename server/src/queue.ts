/**
 * Heavy media work (ffmpeg renders, Whisper, playback transcodes) runs one job
 * at a time.
 *
 * A single 40-segment render peaks near 2 GB and Whisper's larger models want
 * over 1 GB; the box has 4 GB, so two at once OOM-kill the server and take
 * every other user's work with them. Serializing trades a queue wait for never
 * losing the process. Failures release the slot like successes.
 *
 * Lives in its own module so every producer shares the one slot — a second
 * queue somewhere else would quietly reintroduce the crash it exists to
 * prevent.
 */
let heavyJobChain: Promise<unknown> = Promise.resolve();

export function runHeavyJob<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = heavyJobChain.then(
    () => {
      console.log(`[queue] running ${label}`);
      return fn();
    },
    () => {
      console.log(`[queue] running ${label}`);
      return fn();
    }
  );
  heavyJobChain = started.catch(() => {});
  return started;
}
