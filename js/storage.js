// storage.js — persistence for resonance marks and instrument profiles
// Backed by localStorage so it survives reloads and works fully offline.

const KEY = 'wavegen.v1';

const DEFAULT_STATE = {
  activeProfileId: 'default',
  profiles: {
    default: {
      id: 'default',
      name: 'デフォルト',
      a4: 440,
      rangeMin: 180,
      rangeMax: 700,
      waveform: 'sine',
      marks: [], // { id, freq, note, label, response, ts }
    },
  },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    if (!parsed.profiles || !parsed.activeProfileId) return structuredClone(DEFAULT_STATE);
    return parsed;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

let state = load();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('保存に失敗しました', e);
  }
}

export function getActiveProfile() {
  return state.profiles[state.activeProfileId] || Object.values(state.profiles)[0];
}

export function listProfiles() {
  return Object.values(state.profiles).sort((a, b) => a.name.localeCompare(b.name));
}

export function setActiveProfile(id) {
  if (state.profiles[id]) {
    state.activeProfileId = id;
    persist();
  }
  return getActiveProfile();
}

export function updateActiveProfile(patch) {
  const p = getActiveProfile();
  Object.assign(p, patch);
  persist();
  return p;
}

export function createProfile(name) {
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const base = getActiveProfile();
  state.profiles[id] = {
    id,
    name: name || '新しいプロファイル',
    a4: base.a4,
    rangeMin: base.rangeMin,
    rangeMax: base.rangeMax,
    waveform: base.waveform,
    marks: [],
  };
  state.activeProfileId = id;
  persist();
  return state.profiles[id];
}

export function renameProfile(id, name) {
  if (state.profiles[id]) {
    state.profiles[id].name = name;
    persist();
  }
}

export function deleteProfile(id) {
  if (id === 'default') return; // keep at least the default
  delete state.profiles[id];
  if (state.activeProfileId === id) state.activeProfileId = 'default';
  persist();
}

export function addMark(mark) {
  const p = getActiveProfile();
  const entry = {
    id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    ...mark,
  };
  p.marks.push(entry);
  p.marks.sort((a, b) => a.freq - b.freq);
  persist();
  return entry;
}

export function updateMark(id, patch) {
  const p = getActiveProfile();
  const m = p.marks.find((x) => x.id === id);
  if (m) {
    Object.assign(m, patch);
    p.marks.sort((a, b) => a.freq - b.freq);
    persist();
  }
}

export function deleteMark(id) {
  const p = getActiveProfile();
  p.marks = p.marks.filter((m) => m.id !== id);
  persist();
}

// Export / import the whole dataset as JSON (for backup or sharing a profile).
export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed.profiles) throw new Error('プロファイルデータが見つかりません');
  state = parsed;
  if (!state.profiles[state.activeProfileId]) {
    state.activeProfileId = Object.keys(state.profiles)[0];
  }
  persist();
  return state;
}
