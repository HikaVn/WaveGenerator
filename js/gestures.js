// gestures.js — touch/pointer gestures for the swipe pad.
//
// Horizontal drag  -> change frequency (logarithmic, so it feels musical).
// Vertical drag    -> change volume.
// Double tap       -> play/stop toggle.
// Long press       -> mark current frequency as a resonance point.
//
// Frequency is changed by octaves: dragging `pxPerOctave` pixels shifts one
// octave. Fine mode raises pxPerOctave so the same swipe covers less range.

export function attachGestures(el, handlers) {
  let active = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let moved = false;
  let longPressTimer = null;
  let lastTapTime = 0;

  const opts = {
    pxPerOctaveCoarse: 220,
    pxPerOctaveFine: 900,
    pxPerVolume: 260, // pixels for full 0..1 volume swing
    fine: () => false,
    ...handlers,
  };

  function pxPerOctave() {
    return opts.fine() ? opts.pxPerOctaveFine : opts.pxPerOctaveCoarse;
  }

  function onDown(e) {
    if (active) return;
    active = true;
    moved = false;
    pointerId = e.pointerId;
    el.setPointerCapture?.(pointerId);
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    startTime = performance.now();
    longPressTimer = setTimeout(() => {
      if (!moved) {
        moved = true; // suppress the tap that would otherwise follow
        opts.onLongPress?.();
      }
    }, 550);
  }

  function onMove(e) {
    if (!active || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) {
      moved = true;
      clearTimeout(longPressTimer);
    }
    // Decide dominant axis per gesture for predictable control.
    const totalDx = Math.abs(e.clientX - startX);
    const totalDy = Math.abs(e.clientY - startY);
    if (totalDx >= totalDy) {
      const octaves = dx / pxPerOctave();
      opts.onFreqDelta?.(octaves);
    } else {
      const dv = -dy / opts.pxPerVolume;
      opts.onVolumeDelta?.(dv);
    }
    e.preventDefault();
  }

  function onUp(e) {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    clearTimeout(longPressTimer);
    el.releasePointerCapture?.(pointerId);
    const dt = performance.now() - startTime;
    if (!moved && dt < 350) {
      const now = performance.now();
      if (now - lastTapTime < 320) {
        lastTapTime = 0;
        opts.onDoubleTap?.();
      } else {
        lastTapTime = now;
        // Defer single-tap so a double tap can cancel it.
        setTimeout(() => {
          if (lastTapTime !== 0 && performance.now() - lastTapTime >= 300) {
            opts.onTap?.();
          }
        }, 320);
      }
    }
    pointerId = null;
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);

  return function detach() {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
  };
}
