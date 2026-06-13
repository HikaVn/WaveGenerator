// audioEngine.js — Web Audio tone generator + simple synthesizer + sweep engine.
//
// Signal graph:
//   osc (+ optional detuned osc) -> oscGain -> tremoloGain -> masterGain -> analyser -> destination
//   vibratoLFO -> vibratoDepth(cents) -> osc.detune
//   tremoloLFO -> tremoloDepth        -> tremoloGain.gain

// Additive harmonic presets (real coefficients) for richer synth timbres.
const PERIODIC_PRESETS = {
  organ: [0, 1, 0, 0.6, 0, 0.4, 0, 0.25, 0, 0.15],
  strings: [0, 1, 0.5, 0.35, 0.28, 0.22, 0.18, 0.14, 0.1, 0.08, 0.06],
  hollow: [0, 1, 0, 0.5, 0, 0.33, 0, 0.25, 0, 0.2, 0, 0.16],
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.osc2 = null;
    this.oscGain = null;
    this.tremoloGain = null;
    this.masterGain = null;
    this.analyser = null;
    this.vibratoLFO = null;
    this.vibratoDepth = null;
    this.tremoloLFO = null;
    this.tremoloDepth = null;

    this.playing = false;
    this.frequency = 440;
    this.volume = 0.4;
    this.waveform = 'sine';
    this.detuneSpread = 0; // cents, for a second detuned oscillator (chorus/beats)
    this.vibratoRate = 5; // Hz
    this.vibratoCents = 0; // depth in cents
    this.tremoloRate = 4; // Hz
    this.tremoloAmount = 0; // 0..1
    this.attack = 0.02;
    this.release = 0.08;

    this._sweep = null; // active sweep handle
    this._periodicWaves = {};
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  _periodicWave(name) {
    if (this._periodicWaves[name]) return this._periodicWaves[name];
    const reals = PERIODIC_PRESETS[name];
    const real = new Float32Array(reals.length);
    const imag = new Float32Array(reals.length);
    for (let i = 0; i < reals.length; i++) imag[i] = reals[i];
    const wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this._periodicWaves[name] = wave;
    return wave;
  }

  _applyWaveform(osc) {
    if (PERIODIC_PRESETS[this.waveform]) {
      osc.setPeriodicWave(this._periodicWave(this.waveform));
    } else {
      osc.type = this.waveform; // sine | square | sawtooth | triangle
    }
  }

  isPlaying() {
    return this.playing;
  }

  start() {
    const ctx = this._ensureContext();
    if (this.playing) return;
    const now = ctx.currentTime;

    this.oscGain = ctx.createGain();
    this.oscGain.gain.value = 1;
    this.tremoloGain = ctx.createGain();
    this.tremoloGain.gain.value = 1;

    this.osc = ctx.createOscillator();
    this._applyWaveform(this.osc);
    this.osc.frequency.setValueAtTime(this.frequency, now);
    this.osc.connect(this.oscGain);

    // Optional second, detuned oscillator — useful for hearing beats while tuning.
    if (this.detuneSpread > 0) {
      this.osc2 = ctx.createOscillator();
      this._applyWaveform(this.osc2);
      this.osc2.frequency.setValueAtTime(this.frequency, now);
      this.osc2.detune.setValueAtTime(this.detuneSpread, now);
      this.osc2.connect(this.oscGain);
    }

    this.oscGain.connect(this.tremoloGain);
    this.tremoloGain.connect(this.masterGain);

    // Vibrato: LFO modulates detune (cents) so depth stays musical at any pitch.
    this.vibratoLFO = ctx.createOscillator();
    this.vibratoLFO.frequency.value = this.vibratoRate;
    this.vibratoDepth = ctx.createGain();
    this.vibratoDepth.gain.value = this.vibratoCents;
    this.vibratoLFO.connect(this.vibratoDepth);
    this.vibratoDepth.connect(this.osc.detune);
    if (this.osc2) this.vibratoDepth.connect(this.osc2.detune);

    // Tremolo: LFO modulates the tremolo gain around (1 - amount/2).
    this.tremoloLFO = ctx.createOscillator();
    this.tremoloLFO.frequency.value = this.tremoloRate;
    this.tremoloDepth = ctx.createGain();
    this.tremoloDepth.gain.value = this.tremoloAmount / 2;
    this.tremoloGain.gain.value = 1 - this.tremoloAmount / 2;
    this.tremoloLFO.connect(this.tremoloDepth);
    this.tremoloDepth.connect(this.tremoloGain.gain);

    this.osc.start();
    if (this.osc2) this.osc2.start();
    this.vibratoLFO.start();
    this.tremoloLFO.start();

    // Click-free attack ramp.
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(this.volume, now + this.attack);

    this.playing = true;
  }

  stop() {
    if (!this.playing || !this.ctx) return;
    const now = this.ctx.currentTime;
    const stopAt = now + this.release + 0.02;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0, now + this.release);

    const nodes = [this.osc, this.osc2, this.vibratoLFO, this.tremoloLFO];
    nodes.forEach((n) => {
      if (n) {
        try { n.stop(stopAt); } catch {}
      }
    });
    this.osc = this.osc2 = this.vibratoLFO = this.tremoloLFO = null;
    this.playing = false;
    this.cancelSweep();
  }

  toggle() {
    if (this.playing) this.stop();
    else this.start();
    return this.playing;
  }

  setFrequency(freq, glideSeconds = 0.03) {
    this.frequency = freq;
    if (this.playing && this.osc) {
      const now = this.ctx.currentTime;
      this.osc.frequency.setTargetAtTime(freq, now, glideSeconds);
      if (this.osc2) this.osc2.frequency.setTargetAtTime(freq, now, glideSeconds);
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.playing && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setWaveform(w) {
    this.waveform = w;
    if (this.playing) {
      if (this.osc) this._applyWaveform(this.osc);
      if (this.osc2) this._applyWaveform(this.osc2);
    }
  }

  setVibrato(rate, cents) {
    this.vibratoRate = rate;
    this.vibratoCents = cents;
    if (this.playing && this.vibratoLFO) {
      this.vibratoLFO.frequency.setTargetAtTime(rate, this.ctx.currentTime, 0.05);
      this.vibratoDepth.gain.setTargetAtTime(cents, this.ctx.currentTime, 0.05);
    }
  }

  setTremolo(rate, amount) {
    this.tremoloRate = rate;
    this.tremoloAmount = amount;
    if (this.playing && this.tremoloLFO) {
      const now = this.ctx.currentTime;
      this.tremoloLFO.frequency.setTargetAtTime(rate, now, 0.05);
      this.tremoloDepth.gain.setTargetAtTime(amount / 2, now, 0.05);
      this.tremoloGain.gain.setTargetAtTime(1 - amount / 2, now, 0.05);
    }
  }

  // Detune spread requires a restart to add/remove the second oscillator.
  setDetuneSpread(cents) {
    const wasPlaying = this.playing;
    this.detuneSpread = cents;
    if (wasPlaying) {
      this.stop();
      // Restart on next tick so the release ramp does not clip the new start.
      setTimeout(() => this.start(), 30);
    }
  }

  getAnalyser() {
    this._ensureContext();
    return this.analyser;
  }

  // Sweep the frequency from `from` to `to` over `duration` seconds.
  // mode: 'exp' (musical, equal time per octave) or 'lin'.
  // onTick(freq, progress) fires ~60fps; onDone() fires at the end.
  startSweep({ from, to, duration, mode = 'exp', onTick, onDone }) {
    this._ensureContext();
    if (!this.playing) this.start();
    this.cancelSweep();

    const startTime = performance.now();
    const durMs = duration * 1000;
    const logFrom = Math.log(from);
    const logTo = Math.log(to);

    const handle = { raf: 0, cancelled: false };
    const step = () => {
      if (handle.cancelled) return;
      const t = Math.min(1, (performance.now() - startTime) / durMs);
      const freq = mode === 'exp'
        ? Math.exp(logFrom + (logTo - logFrom) * t)
        : from + (to - from) * t;
      this.setFrequency(freq, 0.005);
      if (onTick) onTick(freq, t);
      if (t >= 1) {
        this._sweep = null;
        if (onDone) onDone();
        return;
      }
      handle.raf = requestAnimationFrame(step);
    };
    handle.raf = requestAnimationFrame(step);
    this._sweep = handle;
    return handle;
  }

  cancelSweep() {
    if (this._sweep) {
      this._sweep.cancelled = true;
      cancelAnimationFrame(this._sweep.raf);
      this._sweep = null;
    }
  }

  isSweeping() {
    return !!this._sweep;
  }
}
