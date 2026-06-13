// app.js — wires the UI, audio engine, mic analyzer, gestures and storage together.
import { AudioEngine } from './audioEngine.js';
import { MicAnalyzer, findPeaks } from './analyzer.js';
import { attachGestures } from './gestures.js';
import { freqToNote, snapToSemitone, VIOLIN_RESONANCE_HINTS } from './notes.js';
import * as store from './storage.js';

const $ = (id) => document.getElementById(id);

const engine = new AudioEngine();
let mic = null;

// ---- App state (hydrated from the active profile) -------------------------
const state = {
  freq: 440,
  rangeMin: 180,
  rangeMax: 700,
  a4: 440,
  fine: false,
  snap: false,
  waveform: 'sine',
};

const RANGE_PRESETS = [
  { label: '共振探索', min: 160, max: 800 },
  { label: 'バイオリン全域', min: 190, max: 3200 },
  { label: 'G線', min: 180, max: 230 },
  { label: 'D線', min: 270, max: 330 },
  { label: 'A線', min: 410, max: 480 },
  { label: 'E線', min: 620, max: 700 },
  { label: '全帯域', min: 20, max: 20000 },
];

// Recorded sweep response: [{ freq, db }]
let responseCurve = [];

// ---- Helpers --------------------------------------------------------------
function logPos(f, min = state.rangeMin, max = state.rangeMax) {
  return (Math.log(f) - Math.log(min)) / (Math.log(max) - Math.log(min));
}
function posToFreq(p, min = state.rangeMin, max = state.rangeMax) {
  return Math.exp(Math.log(min) + p * (Math.log(max) - Math.log(min)));
}
function clampFreq(f) {
  return Math.min(state.rangeMax, Math.max(state.rangeMin, f));
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---- Frequency / display --------------------------------------------------
function setFreq(f, { fromUI = false } = {}) {
  let nf = clampFreq(f);
  if (state.snap) nf = clampFreq(snapToSemitone(nf, state.a4));
  state.freq = nf;
  engine.setFrequency(nf);
  updateFreqDisplay();
  if (!fromUI) syncSlider();
}

function updateFreqDisplay() {
  const decimals = state.freq < 1000 ? 1 : 0;
  $('freqValue').textContent = state.freq.toFixed(decimals);
  const n = freqToNote(state.freq, state.a4);
  $('noteLabel').textContent = n.label;
}

function syncSlider() {
  $('freqSlider').value = Math.round(logPos(state.freq) * 1000);
}

function updateRangeUI() {
  $('rangeMin').value = state.rangeMin;
  $('rangeMax').value = state.rangeMax;
  $('rangeLabel').textContent = `範囲 ${state.rangeMin}–${state.rangeMax} Hz`;
  $('sweepFrom').value = state.rangeMin;
  $('sweepTo').value = state.rangeMax;
  syncSlider();
  renderResonanceStrip();
}

// ---- Resonance strip (marks + violin hint bands) --------------------------
function renderResonanceStrip() {
  const strip = $('resonanceStrip');
  strip.innerHTML = '';
  const within = (f) => f >= state.rangeMin && f <= state.rangeMax;

  VIOLIN_RESONANCE_HINTS.forEach((h) => {
    const lo = Math.max(h.lo, state.rangeMin);
    const hi = Math.min(h.hi, state.rangeMax);
    if (lo >= hi) return;
    const band = document.createElement('div');
    band.className = 'hint-band';
    band.style.left = `${logPos(lo) * 100}%`;
    band.style.width = `${(logPos(hi) - logPos(lo)) * 100}%`;
    band.title = h.label;
    strip.appendChild(band);
  });

  store.getActiveProfile().marks.forEach((m) => {
    if (!within(m.freq)) return;
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${logPos(m.freq) * 100}%`;
    const span = document.createElement('span');
    span.textContent = Math.round(m.freq);
    tick.appendChild(span);
    strip.appendChild(tick);
  });
}

// ---- Pad visualizer -------------------------------------------------------
const vizCanvas = $('viz');
let vizCtx, vizW, vizH, dpr;
const scopeData = new Float32Array(2048);

function resizeViz() {
  dpr = window.devicePixelRatio || 1;
  vizW = vizCanvas.clientWidth;
  vizH = vizCanvas.clientHeight;
  vizCanvas.width = vizW * dpr;
  vizCanvas.height = vizH * dpr;
  vizCtx = vizCanvas.getContext('2d');
  vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawViz() {
  if (!vizCtx) resizeViz();
  const c = vizCtx;
  c.clearRect(0, 0, vizW, vizH);

  // Range grid: vertical lines at each octave boundary.
  c.strokeStyle = 'rgba(255,255,255,0.05)';
  c.lineWidth = 1;
  const startOct = Math.ceil(Math.log2(state.rangeMin));
  for (let oct = startOct; Math.pow(2, oct) <= state.rangeMax; oct++) {
    const x = logPos(Math.pow(2, oct)) * vizW;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, vizH); c.stroke();
  }

  // Live mic response across the range (filled curve) when mic is active.
  if (mic && mic.isActive()) {
    c.beginPath();
    c.moveTo(0, vizH);
    for (let x = 0; x <= vizW; x += 2) {
      const f = posToFreq(x / vizW);
      const db = mic.getMagnitudeAt(f); // -120..0
      const norm = Math.max(0, (db + 100) / 100); // 0..1
      const y = vizH - norm * (vizH * 0.85);
      c.lineTo(x, y);
    }
    c.lineTo(vizW, vizH);
    c.closePath();
    c.fillStyle = 'rgba(124,231,135,0.18)';
    c.fill();
    c.strokeStyle = 'rgba(124,231,135,0.6)';
    c.lineWidth = 1.5;
    c.stroke();
  }

  // Output scope (time-domain) — a lively trace of the tone being generated.
  const analyser = engine.getAnalyser();
  if (engine.isPlaying() && analyser) {
    analyser.getFloatTimeDomainData(scopeData);
    c.beginPath();
    c.strokeStyle = 'rgba(76,194,255,0.7)';
    c.lineWidth = 2;
    const slice = vizW / scopeData.length;
    for (let i = 0; i < scopeData.length; i++) {
      const y = vizH / 2 + scopeData[i] * (vizH * 0.32);
      const x = i * slice;
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
  }

  // Current frequency cursor.
  const cx = logPos(state.freq) * vizW;
  c.strokeStyle = '#ffb454';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, vizH); c.stroke();

  requestAnimationFrame(drawViz);
}

// ---- Mic level readout ----------------------------------------------------
function updateMicLevel() {
  const el = $('micLevel');
  if (mic && mic.isActive()) {
    const db = mic.getLevelDb();
    el.textContent = `マイク ${db.toFixed(0)} dB`;
    el.classList.add('on'); el.classList.remove('off');
  }
  setTimeout(updateMicLevel, 120);
}

// ---- Marks ----------------------------------------------------------------
function markCurrent(responseDb = null) {
  const n = freqToNote(state.freq, state.a4);
  const entry = store.addMark({
    freq: Math.round(state.freq * 10) / 10,
    note: n.label,
    label: '',
    response: responseDb,
  });
  renderMarks();
  renderResonanceStrip();
  toast(`マーク: ${entry.freq} Hz (${n.name}${n.octave})`);
}

function renderMarks() {
  const list = $('markList');
  const marks = store.getActiveProfile().marks;
  $('markCount').textContent = marks.length;
  $('markEmpty').style.display = marks.length ? 'none' : 'block';
  list.innerHTML = '';
  marks.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'mark-item';
    row.innerHTML = `
      <span class="m-freq">${m.freq}</span>
      <span class="m-note">${m.note || ''}</span>
      <input class="m-label" value="${(m.label || '').replace(/"/g, '&quot;')}" placeholder="メモ" />
      <span class="m-resp">${m.response != null ? m.response.toFixed(0) + 'dB' : ''}</span>
      <button class="icon-btn go" title="この周波数へ">▶</button>
      <button class="icon-btn del" title="削除">✕</button>`;
    row.querySelector('.m-label').addEventListener('change', (e) =>
      store.updateMark(m.id, { label: e.target.value }));
    row.querySelector('.go').addEventListener('click', () => {
      if (!engine.isPlaying()) togglePlay();
      setFreq(m.freq);
    });
    row.querySelector('.del').addEventListener('click', () => {
      store.deleteMark(m.id);
      renderMarks(); renderResonanceStrip();
    });
    list.appendChild(row);
  });
}

// ---- Transport ------------------------------------------------------------
function togglePlay() {
  const playing = engine.toggle();
  const btn = $('playBtn');
  btn.textContent = playing ? '⏸ 停止' : '▶ 再生';
  btn.classList.toggle('playing', playing);
  if (playing) setFreq(state.freq);
}

// ---- Sweep & response curve ----------------------------------------------
async function ensureMic() {
  if (!mic) mic = new MicAnalyzer(engine.getAnalyser().context);
  if (!mic.isActive()) {
    try {
      await mic.enable();
      $('micBtn').textContent = '🎤 マイクON (タップでOFF)';
      $('micLevel').classList.add('on'); $('micLevel').classList.remove('off');
      toast('マイクON — 応答を測定します');
    } catch (e) {
      toast('マイクを使用できません: ' + e.message);
      throw e;
    }
  }
}

function toggleMic() {
  if (mic && mic.isActive()) {
    mic.disable();
    $('micBtn').textContent = '🎤 マイクをON';
    $('micLevel').textContent = 'マイク OFF';
    $('micLevel').classList.add('off'); $('micLevel').classList.remove('on');
  } else {
    ensureMic().catch(() => {});
  }
}

const curveCanvas = $('responseCurve');
function drawResponseCurve() {
  const ctx = curveCanvas.getContext('2d');
  const r = window.devicePixelRatio || 1;
  const w = curveCanvas.clientWidth, h = curveCanvas.clientHeight;
  curveCanvas.width = w * r; curveCanvas.height = h * r;
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0c1014'; ctx.fillRect(0, 0, w, h);
  if (responseCurve.length < 2) {
    ctx.fillStyle = '#9aa7b4'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('スイープを実行すると応答カーブが表示されます', w / 2, h / 2);
    return;
  }
  const fMin = responseCurve[0].freq, fMax = responseCurve[responseCurve.length - 1].freq;
  const dbs = responseCurve.map((p) => p.db);
  const dbMin = Math.min(...dbs), dbMax = Math.max(...dbs) + 1;
  const xOf = (f) => ((Math.log(f) - Math.log(fMin)) / (Math.log(fMax) - Math.log(fMin))) * w;
  const yOf = (db) => h - ((db - dbMin) / (dbMax - dbMin)) * (h - 16) - 8;

  ctx.beginPath(); ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
  responseCurve.forEach((p, i) => {
    const x = xOf(p.freq), y = yOf(p.db);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  const peaks = findPeaks(responseCurve, { minProminence: 5 }).slice(0, 6);
  ctx.fillStyle = '#ffb454';
  peaks.forEach((pk) => {
    const x = xOf(pk.freq), y = yOf(pk.db);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(pk.freq)}Hz`, x, y - 8);
  });
}

function startSweep() {
  const from = parseFloat($('sweepFrom').value) || state.rangeMin;
  const to = parseFloat($('sweepTo').value) || state.rangeMax;
  const dur = Math.max(1, parseFloat($('sweepDur').value) || 8);
  if (engine.isSweeping()) { engine.cancelSweep(); $('sweepBtn').textContent = '▶ スイープ開始'; return; }

  responseCurve = [];
  const measuring = mic && mic.isActive();
  $('sweepBtn').textContent = '⏹ 停止';
  if (!engine.isPlaying()) togglePlay();

  engine.startSweep({
    from, to, duration: dur, mode: 'exp',
    onTick: (freq) => {
      state.freq = freq;
      updateFreqDisplay(); syncSlider();
      if (measuring) responseCurve.push({ freq, db: mic.getMagnitudeAt(freq) });
      drawResponseCurve();
    },
    onDone: () => {
      $('sweepBtn').textContent = '▶ スイープ開始';
      drawResponseCurve();
      if (measuring && responseCurve.length) {
        const peaks = findPeaks(responseCurve, { minProminence: 5 });
        renderPeakList(peaks.slice(0, 8));
        toast(`測定完了 — ピーク ${peaks.length} 件`);
      } else if (!measuring) {
        toast('スイープ完了（マイクONで応答測定できます）');
      }
    },
  });
}

function renderPeakList(peaks) {
  const el = $('peakList');
  el.innerHTML = '';
  if (!peaks.length) { el.innerHTML = '<p class="hint">明確なピークは検出されませんでした。</p>'; return; }
  peaks.forEach((pk) => {
    const n = freqToNote(pk.freq, state.a4);
    const row = document.createElement('div');
    row.className = 'peak';
    row.innerHTML = `
      <span class="m-freq">${Math.round(pk.freq)} Hz</span>
      <span class="m-note">${n.name}${n.octave}</span>
      <span class="m-resp">突出 ${pk.prominence.toFixed(0)}dB</span>
      <button class="icon-btn go" title="マーク追加">🚩</button>`;
    row.querySelector('.go').addEventListener('click', () => {
      store.addMark({ freq: Math.round(pk.freq * 10) / 10, note: n.label, label: '自動検出', response: pk.db });
      renderMarks(); renderResonanceStrip(); toast('マークに追加しました');
    });
    el.appendChild(row);
  });
}

// ---- Profiles -------------------------------------------------------------
function loadProfileIntoState() {
  const p = store.getActiveProfile();
  state.rangeMin = p.rangeMin; state.rangeMax = p.rangeMax;
  state.a4 = p.a4; state.waveform = p.waveform;
  state.freq = clampFreq(state.freq);
  engine.setWaveform(state.waveform);
  $('a4').value = state.a4; $('a4Val').textContent = `${state.a4} Hz`;
  $('profileName').value = p.name;
  document.querySelectorAll('#waveforms .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.wave === state.waveform));
  updateRangeUI(); updateFreqDisplay(); renderMarks();
}

function renderProfileSelect() {
  const sel = $('profileSelect');
  sel.innerHTML = '';
  store.listProfiles().forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    if (p.id === store.getActiveProfile().id) o.selected = true;
    sel.appendChild(o);
  });
}

function persistRangeAndWave() {
  store.updateActiveProfile({
    rangeMin: state.rangeMin, rangeMax: state.rangeMax,
    a4: state.a4, waveform: state.waveform,
  });
}

// ---- Wiring ---------------------------------------------------------------
function wire() {
  // Range presets.
  const presetWrap = $('rangePresets');
  RANGE_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = p.label;
    b.addEventListener('click', () => {
      state.rangeMin = p.min; state.rangeMax = p.max;
      state.freq = clampFreq(state.freq);
      updateRangeUI(); persistRangeAndWave(); setFreq(state.freq);
    });
    presetWrap.appendChild(b);
  });

  // Gestures on the pad.
  attachGestures($('pad'), {
    fine: () => state.fine,
    onFreqDelta: (oct) => setFreq(state.freq * Math.pow(2, oct)),
    onVolumeDelta: (dv) => {
      const v = Math.max(0, Math.min(1, engine.volume + dv));
      engine.setVolume(v);
      $('volume').value = Math.round(v * 100); $('volVal').textContent = `${Math.round(v * 100)}%`;
    },
    onDoubleTap: togglePlay,
    onLongPress: () => markCurrent(mic && mic.isActive() ? mic.getMagnitudeAt(state.freq) : null),
  });

  $('playBtn').addEventListener('click', togglePlay);
  $('markBtn').addEventListener('click', () =>
    markCurrent(mic && mic.isActive() ? mic.getMagnitudeAt(state.freq) : null));
  $('fineBtn').addEventListener('click', (e) => {
    state.fine = !state.fine; e.target.classList.toggle('active', state.fine);
    toast(state.fine ? '微調整モード ON' : '微調整モード OFF');
  });
  $('snapBtn').addEventListener('click', (e) => {
    state.snap = !state.snap; e.target.classList.toggle('active', state.snap);
    if (state.snap) setFreq(state.freq);
    toast(state.snap ? '音階スナップ ON' : '音階スナップ OFF');
  });

  // Range inputs + slider.
  $('rangeMin').addEventListener('change', (e) => {
    state.rangeMin = Math.max(8, parseFloat(e.target.value) || state.rangeMin);
    if (state.rangeMin >= state.rangeMax) state.rangeMin = state.rangeMax - 1;
    state.freq = clampFreq(state.freq); updateRangeUI(); persistRangeAndWave(); setFreq(state.freq);
  });
  $('rangeMax').addEventListener('change', (e) => {
    state.rangeMax = Math.min(22000, parseFloat(e.target.value) || state.rangeMax);
    if (state.rangeMax <= state.rangeMin) state.rangeMax = state.rangeMin + 1;
    state.freq = clampFreq(state.freq); updateRangeUI(); persistRangeAndWave(); setFreq(state.freq);
  });
  $('freqSlider').addEventListener('input', (e) => {
    setFreq(posToFreq(e.target.value / 1000), { fromUI: true });
  });

  // Cents nudges.
  $('nudgeRow').addEventListener('click', (e) => {
    const cents = e.target.dataset.cents;
    if (cents) setFreq(state.freq * Math.pow(2, parseFloat(cents) / 1200));
  });

  // Waveforms.
  $('waveforms').addEventListener('click', (e) => {
    const w = e.target.dataset.wave; if (!w) return;
    state.waveform = w; engine.setWaveform(w); persistRangeAndWave();
    document.querySelectorAll('#waveforms .chip').forEach((b) =>
      b.classList.toggle('active', b.dataset.wave === w));
  });

  // Synth sliders.
  const bindVib = () => engine.setVibrato(parseFloat($('vibRate').value), parseFloat($('vibDepth').value));
  const bindTrem = () => engine.setTremolo(parseFloat($('tremRate').value), parseFloat($('tremAmt').value) / 100);
  $('volume').addEventListener('input', (e) => {
    engine.setVolume(e.target.value / 100); $('volVal').textContent = `${e.target.value}%`;
  });
  $('vibRate').addEventListener('input', (e) => { $('vibRateVal').textContent = `${(+e.target.value).toFixed(1)} Hz`; bindVib(); });
  $('vibDepth').addEventListener('input', (e) => { $('vibDepthVal').textContent = `${e.target.value}¢`; bindVib(); });
  $('tremRate').addEventListener('input', (e) => { $('tremRateVal').textContent = `${(+e.target.value).toFixed(1)} Hz`; bindTrem(); });
  $('tremAmt').addEventListener('input', (e) => { $('tremAmtVal').textContent = `${e.target.value}%`; bindTrem(); });
  $('detune').addEventListener('input', (e) => {
    $('detuneVal').textContent = `${e.target.value}¢`; engine.setDetuneSpread(parseFloat(e.target.value));
  });
  $('a4').addEventListener('input', (e) => {
    state.a4 = parseFloat(e.target.value); $('a4Val').textContent = `${state.a4} Hz`;
    persistRangeAndWave(); updateFreqDisplay();
  });

  // Sweep / mic.
  $('micBtn').addEventListener('click', toggleMic);
  $('sweepBtn').addEventListener('click', startSweep);
  $('sweepUseRange').addEventListener('click', () => {
    $('sweepFrom').value = state.rangeMin; $('sweepTo').value = state.rangeMax;
  });
  $('detectPeaksBtn').addEventListener('click', () => {
    if (responseCurve.length < 5) { toast('先にマイクONでスイープを実行してください'); return; }
    renderPeakList(findPeaks(responseCurve, { minProminence: 4 }).slice(0, 8));
  });
  $('clearCurveBtn').addEventListener('click', () => { responseCurve = []; drawResponseCurve(); $('peakList').innerHTML = ''; });

  // Profiles.
  $('profileSelect').addEventListener('change', (e) => { store.setActiveProfile(e.target.value); loadProfileIntoState(); });
  $('renameBtn').addEventListener('click', () => {
    const name = $('profileName').value.trim(); if (!name) return;
    store.renameProfile(store.getActiveProfile().id, name); renderProfileSelect(); toast('名前を変更しました');
  });
  $('newProfileBtn').addEventListener('click', () => {
    store.createProfile('プロファイル ' + (store.listProfiles().length + 1));
    renderProfileSelect(); loadProfileIntoState(); toast('新規プロファイルを作成しました');
  });
  $('deleteProfileBtn').addEventListener('click', () => {
    const p = store.getActiveProfile();
    if (p.id === 'default') { toast('デフォルトは削除できません'); return; }
    if (confirm(`「${p.name}」を削除しますか？`)) {
      store.deleteProfile(p.id); renderProfileSelect(); loadProfileIntoState(); toast('削除しました');
    }
  });
  $('exportBtn').addEventListener('click', () => { $('ioArea').value = store.exportJSON(); toast('JSONを書き出しました'); });
  $('importBtn').addEventListener('click', () => {
    try { store.importJSON($('ioArea').value); renderProfileSelect(); loadProfileIntoState(); toast('インポートしました'); }
    catch (err) { toast('インポート失敗: ' + err.message); }
  });

  window.addEventListener('resize', resizeViz);
}

// ---- Boot -----------------------------------------------------------------
function init() {
  wire();
  renderProfileSelect();
  loadProfileIntoState();
  resizeViz();
  drawViz();
  drawResponseCurve();
  updateMicLevel();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
