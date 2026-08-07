/**
 * Touch support for selecting a range of transcript words.
 *
 * @mieweb/ui's MediaEditor drives selection entirely from mouse events: the
 * drag starts in an `onMouseDown` on a word and is extended by a document-level
 * `mousemove` listener. A finger never produces `mousemove`, so on a phone the
 * range selection simply does not exist. Verified against a real touch through
 * the browser's input pipeline:
 *
 *     pointerdown@174   touchstart@175
 *     pointerup@1722    touchend@1722      <- 1.5s hold, nothing in between
 *     mousedown@1729    mouseup@1747       <- 18ms apart, AFTER the finger lifts
 *
 * The browser withholds the synthesized `mousedown` until it knows the gesture
 * was not a scroll, so it arrives after the finger is already up and is
 * cancelled 18ms later by its own `mouseup`. MediaEditor's 500ms long-press
 * (which opens the word editor on desktop) can therefore never fire on touch —
 * which is why long-pressing appears to do nothing at all.
 *
 * This translates touch into the mouse events MediaEditor already understands,
 * without reaching inside it. It is a shim, not the right long-term fix: the
 * correct version is pointer events inside MediaEditor, where one code path
 * would serve mouse, touch and pen. This lives here so PulseClip works on a
 * phone today without changing a shared component.
 *
 * The gesture is the platform one — hold to start selecting, then drag:
 *
 *   - press and hold a word for 400ms  -> selection begins on that word
 *   - drag                             -> extends the selection
 *   - lift                             -> selection stands
 *   - moving before the hold completes -> it was a scroll; we never engage
 *
 * That last rule is what keeps the transcript scrollable. `touchmove` is only
 * ever cancelled once a selection is actually underway.
 */

import { useEffect } from 'react';

/** How long a finger must rest on a word before it means "select", not "scroll". */
const HOLD_MS = 400;
/** Movement beyond this before the hold completes is a scroll, not a selection. */
const SLOP_PX = 10;

/** MediaEditor renders each word with role="option". */
const WORD_SELECTOR = '[role="option"]';

function synthesizeMouse(
  target: EventTarget,
  type: 'mousedown' | 'mousemove' | 'mouseup',
  x: number,
  y: number
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      // MediaEditor ignores anything that is not the primary button.
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX: x,
      clientY: y,
    })
  );
}

/**
 * Wire touch-driven word selection into whatever element contains a MediaEditor.
 *
 * @param ref      the container holding the editor
 * @param enabled  skip entirely when there is no transcript on screen
 */
export function useTouchWordSelection(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean
) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    // Nothing to do for a mouse; MediaEditor already handles that case, and
    // engaging here would mean two systems driving one selection.
    if (!window.matchMedia('(pointer: coarse)').matches) return;

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let word: Element | null = null;
    let selecting = false;

    const cancelHold = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const hit = el?.closest(WORD_SELECTOR) ?? null;
      if (!hit) return;

      word = hit;
      startX = t.clientX;
      startY = t.clientY;
      selecting = false;

      holdTimer = setTimeout(() => {
        holdTimer = null;
        selecting = true;
        // Drop any native text selection the long press may have started, so
        // the browser's own selection UI does not fight the editor's.
        window.getSelection?.()?.removeAllRanges();
        if (word) synthesizeMouse(word, 'mousedown', startX, startY);
      }, HOLD_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (!selecting) {
        // Still deciding. Enough movement means the finger is scrolling, so
        // stand down and let the browser have the gesture.
        if (Math.hypot(t.clientX - startX, t.clientY - startY) > SLOP_PX) {
          cancelHold();
          word = null;
        }
        return;
      }

      // A selection is underway: this drag belongs to us, not to the scroller.
      // The listener is registered non-passively so this is allowed to take it.
      e.preventDefault();
      synthesizeMouse(document, 'mousemove', t.clientX, t.clientY);
    };

    const finish = (e: TouchEvent) => {
      cancelHold();
      if (selecting) {
        const t = e.changedTouches[0];
        synthesizeMouse(document, 'mouseup', t?.clientX ?? startX, t?.clientY ?? startY);
      }
      selecting = false;
      word = null;
    };

    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', finish, { passive: true });
    root.addEventListener('touchcancel', finish, { passive: true });

    return () => {
      cancelHold();
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', finish);
      root.removeEventListener('touchcancel', finish);
    };
  }, [ref, enabled]);
}
