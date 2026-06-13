// analyzer.js — microphone capture + FFT analysis for resonance measurement.
//
// The key trick for measuring an instrument's resonance response: drive a tone,
// then read the mic's FFT magnitude *at the driven frequency*. Sweeping the tone
// and recording that magnitude builds a response curve whose peaks are resonances.
//
// AGC / noise suppression / echo cancellation are disabled so the captured
// magnitudes reflect the real acoustic response rather than the OS "cleaning" it.

export class MicAnalyzer {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.freqData = null; // Float32Array, dB
    this.timeData = null; // Float32Array, waveform
    this.active = false;
  }

  async enable() {
    if (this.active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('このブラウザはマイク入力に対応していません');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192; // fine frequency resolution for resonance peaks
    this.analyser.smoothingTimeConstant = 0.3;
    this.source.connect(this.analyser);
    this.freqData = new Float32Array(this.analyser.frequencyBinCount);
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.active = true;
  }

  disable() {
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = this.source = this.analyser = null;
    this.active = false;
  }

  isActive() {
    return this.active;
  }

  _refresh() {
    if (!this.active) return false;
    this.analyser.getFloatFrequencyData(this.freqData);
    return true;
  }

  // Broadband RMS level in dBFS-ish units, derived from the time-domain signal.
  getLevelDb() {
    if (!this.active) return -120;
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) sum += this.timeData[i] * this.timeData[i];
    const rms = Math.sqrt(sum / this.timeData.length);
    return 20 * Math.log10(rms + 1e-9);
  }

  // FFT magnitude (dB) at a target frequency — averaged over a few neighbouring
  // bins so the reading is robust to small frequency drift.
  getMagnitudeAt(freq) {
    if (!this._refresh()) return -120;
    const nyquist = this.ctx.sampleRate / 2;
    const binCount = this.freqData.length;
    const center = Math.round((freq / nyquist) * binCount);
    let max = -Infinity;
    for (let i = center - 1; i <= center + 1; i++) {
      if (i >= 0 && i < binCount) max = Math.max(max, this.freqData[i]);
    }
    return max === -Infinity ? -120 : max;
  }

  // Raw spectrum (dB) for drawing the live analyser.
  getSpectrum() {
    if (!this._refresh()) return null;
    return this.freqData;
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }
}

// Find local maxima ("peaks") in a recorded response curve.
// points: [{ freq, db }]. Returns peaks sorted by prominence (descending).
export function findPeaks(points, { minProminence = 6, neighbourhood = 3 } = {}) {
  if (!points || points.length < 5) return [];
  const peaks = [];
  for (let i = neighbourhood; i < points.length - neighbourhood; i++) {
    const v = points[i].db;
    let isMax = true;
    for (let j = i - neighbourhood; j <= i + neighbourhood; j++) {
      if (j !== i && points[j].db > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    // Prominence: rise above the lower of the two surrounding valleys.
    let leftMin = v, rightMin = v;
    for (let j = i; j >= 0; j--) leftMin = Math.min(leftMin, points[j].db);
    for (let j = i; j < points.length; j++) rightMin = Math.min(rightMin, points[j].db);
    const prominence = v - Math.max(leftMin, rightMin);
    if (prominence >= minProminence) {
      peaks.push({ freq: points[i].freq, db: v, prominence });
    }
  }
  return peaks.sort((a, b) => b.prominence - a.prominence);
}
