// notes.js — frequency <-> musical note conversion
// A4 reference is configurable to support non-standard tunings (baroque 415, etc.)

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Open strings of a violin in standard tuning (G3, D4, A4, E5).
export const VIOLIN_STRINGS = [
  { name: 'G3', freq: 196.0 },
  { name: 'D4', freq: 293.66 },
  { name: 'A4', freq: 440.0 },
  { name: 'E5', freq: 659.25 },
];

// Typical violin body/air resonance regions (approximate, instrument dependent).
export const VIOLIN_RESONANCE_HINTS = [
  { label: 'A0 (空気/Helmholtz)', lo: 270, hi: 290 },
  { label: 'CBR (本体)', lo: 400, hi: 430 },
  { label: 'B1- (本体)', lo: 440, hi: 490 },
  { label: 'B1+ (本体)', lo: 520, hi: 580 },
];

// Convert a frequency to the nearest note name + cents deviation.
export function freqToNote(freq, a4 = 440) {
  if (!freq || freq <= 0) return { name: '--', octave: 0, cents: 0, midi: 0, label: '--' };
  const midiFloat = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const name = NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const sign = cents > 0 ? '+' : '';
  return {
    name,
    octave,
    cents,
    midi,
    label: `${name}${octave} ${sign}${cents}¢`,
  };
}

// Convert a MIDI note number to frequency.
export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

// Snap a frequency to the nearest equal-tempered semitone.
export function snapToSemitone(freq, a4 = 440) {
  const midi = Math.round(69 + 12 * Math.log2(freq / a4));
  return midiToFreq(midi, a4);
}
