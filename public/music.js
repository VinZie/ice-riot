// ICE RIOT - music.js : original, fully synthesized arena music (WebAudio only).
// Owner: Agent MUSIC. Plain ES module, zero deps, no samples, no network: every sound is built
// from oscillators, one shared noise buffer, biquad filters and gain envelopes. All melodies,
// riffs and chord progressions here are original compositions for this game.
//
//   import { createMusic } from './music.js';
//   const music = createMusic(audioCtx, audioCtx.destination);
//   music.setMood('lobby');   // 'lobby'|'play'|'stoppage'|'goal'|'intermission'|'final'|'off'
//   music.stinger('bighit');  // 'goal'|'bighit'|'onfire'|'periodStart'|'win'
//   music.setVolume(0.6);     // 0..1 music bus volume (separate from SFX), smoothed
//   music.dispose();
//   music.getState();         // debug extra: { mood, pending, bar, beat, bpm, voices, ... }
//
// Behaviour notes
// - setMood() is cheap and idempotent: identical consecutive requests are ignored, so it can be
//   called every frame from the game phase. A change is applied on the next beat (next bar for
//   'lobby') of the groove that is playing, with a ~300 ms crossfade between per-mood buses.
// - 'goal' is a one-shot phrase (~5.1 s) that falls back to 'stoppage'; 'final' is a one-shot
//   ending (~10 s incl. ring-out) followed by silence. While either plays, requests other than
//   'off' / 'lobby' are queued and applied when the phrase ends.
// - stinger() hits are locked to the next 16th note of the current groove (or play at once when
//   silent), use the key of the current/pending mood, and are rate-limited per kind.
//   stinger('goal') is skipped while the 'goal' mood is pending/playing (the mood already
//   celebrates); stinger('win') during a pending/playing 'final' is folded into the final hit.
// - Timing: lookahead scheduler, setInterval 25 ms, notes scheduled ~120 ms ahead on
//   ctx.currentTime (1.2 s ahead while the tab is hidden, since timers get throttled).
// - Click safety: every gain change is a ramp, note envelopes start and end at 0 before their
//   source stops, exponential ramps never target 0. Voices are capped (MAX_VOICES sources).
// - Chain: mood buses + stinger bus -> master gain (volume) -> gentle compressor -> destination.

const TICK_MS = 25;
const LOOKAHEAD = 0.12;
const LOOKAHEAD_HIDDEN = 1.2;
const XFADE = 0.3;          // crossfade between moods (s)
const OFF_FADE = 0.8;       // fade for setMood('off')
const END_FADE = 0.5;       // fade after the 'final' phrase has rung out
const FLOOR = 1e-4;         // exponential ramps end here (never 0), then a tiny linear ramp to 0
const MAX_VOICES = 64;      // cap on simultaneously scheduled sources (oscillators + noise)
const KICK_F0 = 150;
const MOOD_NAMES = new Set(['lobby', 'play', 'stoppage', 'goal', 'intermission', 'final', 'off']);
const STING_GAP = { goal: 2, bighit: 0.6, onfire: 1.2, periodStart: 2, win: 3 };

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// [[step, a, b], ...] -> Map(step -> [[a, b], ...])
function seq(list) {
  const idx = new Map();
  for (const [s, ...rest] of list) {
    let a = idx.get(s);
    if (!a) idx.set(s, (a = []));
    a.push(rest);
  }
  return idx;
}

// ---------------------------------------------------------------------------------------------
// Envelopes (all start at 0, end at 0, exponential segments only between positive values).

function perc(p, t, a, peak, dec) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(FLOOR, t + a + dec);
  p.linearRampToValueAtTime(0, t + a + dec + 0.004);
  return t + a + dec + 0.004;
}

function adsr(p, t, dur, a, d, s, r, peak) {
  const tA = t + a;
  const tOff = Math.max(t + dur, tA + 0.002);
  let lev = peak;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, tA);
  if (s < 1 && d > 0) {
    lev = Math.max(peak * s, FLOOR * 2);
    p.exponentialRampToValueAtTime(lev, Math.min(tA + d, tOff));
  }
  p.setValueAtTime(lev, tOff);                       // anchor (same value: no jump)
  p.exponentialRampToValueAtTime(FLOOR, tOff + r);
  p.linearRampToValueAtTime(0, tOff + r + 0.004);
  return tOff + r + 0.004;
}

// ---------------------------------------------------------------------------------------------
// Compositions. Steps are 16th notes, 16 per bar, all moods in 4/4.
// MIDI reference: C4=60 D4=62 E4=64 F#4=66 G4=67 A4=69 B4=71 C5=72 D5=74 E5=76 G5=79 A5=81 B5=83

// LOBBY - 128 BPM, E minor, 8-bar loop: Em | Em | C | D | Em | G | Am | B
const LOBBY_CH = [
  { b: 40, arp: [64, 67, 71, 76] }, // Em
  { b: 40, arp: [64, 67, 71, 76] }, // Em
  { b: 36, arp: [64, 67, 72, 76] }, // C
  { b: 38, arp: [62, 66, 69, 74] }, // D
  { b: 40, arp: [64, 67, 71, 76] }, // Em
  { b: 43, arp: [62, 67, 71, 74] }, // G
  { b: 45, arp: [64, 69, 72, 76] }, // Am
  { b: 35, arp: [63, 66, 71, 75] }, // B
];
const LOBBY_ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 2];
const LOBBY_BASS = [0, null, 0, 12, null, 0, 0, null, 0, null, 12, 0, null, 0, 7, null];
const LOBBY_BASS_FILL = [0, null, 0, 12, null, 0, 12, null, 0, 12, 0, 12, 0, 12, 0, 12];
const LOBBY_LEAD = seq([ // [step in 8-bar loop, midi, length in steps]
  [0, 71, 2], [2, 76, 2], [4, 79, 3], [7, 78, 1], [8, 76, 2], [10, 71, 2], [12, 74, 4],
  [16, 76, 6], [22, 78, 2], [24, 79, 2], [26, 78, 2], [28, 74, 4],
  [32, 72, 2], [34, 76, 2], [36, 79, 4], [40, 81, 2], [42, 79, 2], [44, 76, 4],
  [48, 78, 3], [51, 76, 1], [52, 74, 2], [54, 69, 2], [56, 74, 4], [60, 78, 2], [62, 81, 2],
  [64, 79, 3], [67, 78, 1], [68, 76, 2], [70, 71, 2], [72, 76, 2], [74, 79, 2], [76, 83, 4],
  [80, 81, 2], [82, 79, 2], [84, 74, 4], [88, 71, 2], [90, 74, 2], [92, 79, 4],
  [96, 81, 3], [99, 79, 1], [100, 76, 2], [102, 72, 2], [104, 76, 2], [106, 81, 2], [108, 79, 2], [110, 76, 2],
  [112, 78, 4], [116, 75, 4], [120, 71, 2], [122, 75, 2], [124, 78, 4],
]);

function renderLobby(K, m, bar, s, t, sd) {
  const out = m.bus, lb = bar % 8, cyc = (bar / 8) | 0, ch = LOBBY_CH[lb];
  const leadOn = cyc % 2 === 1;
  if (s % 4 === 0) K.kick(out, t, s === 0 ? 1 : 0.85);
  if (s === 14 && (lb === 3 || lb === 7)) K.kick(out, t, 0.6);
  if (s === 4 || s === 12) K.snare(out, t, 0.9);
  if (lb === 7 && s >= 13) K.snare(out, t, 0.3 + 0.2 * (s - 13));
  if (s === 6 || s === 14) K.hat(out, t, 0.5, true);
  else K.hat(out, t, [0.55, 0.2, 0.4, 0.2][s % 4]);
  if (s === 0 && lb === 0) K.crash(out, t, cyc === 0 ? 0.6 : 0.85);
  const off = (lb === 7 ? LOBBY_BASS_FILL : LOBBY_BASS)[s];
  if (off !== null) K.bass(out, t, ch.b + off, sd * 0.75, s % 4 === 0 ? 1 : 0.8, { cutoff: 360 + 40 * lb });
  if (cyc > 0 || lb >= 2) K.pluck(out, t, ch.arp[LOBBY_ARP[s]], sd, leadOn ? 0.5 : 0.85, { cutoff: 1400 + 180 * lb });
  if (leadOn) {
    const ev = LOBBY_LEAD.get(lb * 16 + s);
    if (ev) for (const [mid, len] of ev) K.lead(out, t, mid, len * sd * 0.92, 0.9);
  }
}

// PLAY - 132 BPM, E minor, 8-bar loop of roots E E C D E E A B. Drums + 8th-note bass pulse,
// low-passed bus and low level so SFX sit on top.
const PLAY_ROOTS = [40, 40, 36, 38, 40, 40, 45, 47];

function renderPlay(K, m, bar, s, t, sd) {
  const out = m.bus, lb = bar % 8, r = PLAY_ROOTS[lb];
  if (s % 4 === 0) K.kick(out, t, s === 0 ? 0.95 : 0.75);
  if (s === 4 || s === 12) K.rim(out, t, 0.7);
  if (s % 4 === 2) K.hat(out, t, 0.45);
  else if (s % 2 === 1) K.hat(out, t, 0.15);
  if (s % 2 === 0) {
    const up = (s === 14 && lb % 2 === 1) || (s === 6 && lb === 7);
    K.bass(out, t, r + (up ? 12 : 0), sd * 1.1, s % 8 === 0 ? 1 : 0.75,
      { cutoff: 260 + 70 * (bar % 4), q: 6, level: 0.36 });
  }
  if (lb === 7 && s >= 12) K.tom(out, t, [52, 49, 47, 43][s - 12], 0.55);
  if (lb === 7 && s === 0) K.sweep(out, t, r + 12, r + 24, sd * 15, 0.25);
  if (lb === 0 && s === 0 && bar > 0) K.crash(out, t, 0.35);
}

// STOPPAGE - 116 BPM shuffle, G major, arena-organ vamp: G | C | G (Em every 2nd pass) | D7,
// additive organ (sine 8'/4'/2 2/3' + detuned square) with Leslie-ish vibrato + tremolo,
// walking organ pedal bass, hand-claps on 2 & 4.
const ST_BARS = [
  { pedal: [43, 47, 50, 47], ch: [67, 71, 74], rh: 0 }, // G
  { pedal: [48, 52, 55, 52], ch: [67, 72, 76], rh: 1 }, // C
  { pedal: [43, 47, 50, 52], ch: [67, 71, 74], rh: 0 }, // G
  { pedal: [50, 48, 47, 45], ch: [66, 72, 74], rh: 2 }, // D7
];
const ST_ALT3 = { pedal: [40, 43, 47, 43], ch: [64, 67, 71], rh: 0 }; // Em
const ST_RHYTHMS = [ // [step, length]
  [[0, 4], [6, 2], [12, 2], [14, 2]],
  [[0, 2], [4, 4], [10, 2], [12, 4]],
  [[0, 4], [6, 2], [10, 2], [12, 2], [14, 2]],
];
const ORGAN_PARTS = [[1, 'sine', 0.5, 0], [2, 'sine', 0.25, 0], [3, 'sine', 0.1, 0], [1, 'square', 0.06, 6]];
const PEDAL_PARTS = [[1, 'sine', 0.6, 0], [2, 'sine', 0.22, 0]];

function setupOrgan(ctx, m, t) {
  const organ = ctx.createGain();
  organ.gain.value = 0.85;
  organ.connect(m.bus);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 6.4;
  const vib = ctx.createGain();
  vib.gain.value = 9;          // +/- 9 cents pitch wobble
  const trem = ctx.createGain();
  trem.gain.value = 0.12;      // +/- amplitude wobble around 0.85
  lfo.connect(vib);
  lfo.connect(trem);
  trem.connect(organ.gain);
  lfo.start(t);
  m.organ = organ;
  m.vib = vib;
  m.nodes.push(organ, lfo, vib, trem);
  m.lfos.push(lfo);
}

function renderStoppage(K, m, bar, s, t, sd) {
  const lb = bar % 4, pass = (bar / 4) | 0;
  const b = lb === 2 && pass % 2 === 1 ? ST_ALT3 : ST_BARS[lb];
  for (const [st, len] of ST_RHYTHMS[b.rh]) {
    if (st === s) K.organ(m.organ, t, b.ch, len * sd * 0.9, st === 0 ? 1 : 0.8, m.vib);
  }
  if (s % 4 === 0) K.organ(m.bus, t, [b.pedal[s / 4]], sd * 3, 0.9, null, PEDAL_PARTS);
  if (s === 4 || s === 12 || (lb === 3 && s === 14)) K.clap(m.bus, t, s === 14 ? 0.6 : 0.85);
  if (s === 0 || s === 8) K.kick(m.bus, t, 0.6);
  if (s % 2 === 0) K.hat(m.bus, t, s % 4 === 2 ? 0.3 : 0.18);
}

// GOAL - 140 BPM, D major, 3-bar one-shot: D | C  G/B | D (held). Brass stabs + lead line.
const D_MAJ = [62, 66, 69, 74], C_MAJ = [60, 64, 67, 72], G_B = [59, 62, 67, 71];
const D_BIG = [50, 57, 62, 66, 69, 74];
const GOAL_BRASS = seq([
  [0, D_MAJ, 4], [6, D_MAJ, 2], [10, D_MAJ, 2], [12, D_MAJ, 4],
  [16, C_MAJ, 4], [22, C_MAJ, 2], [24, G_B, 4], [30, G_B, 2],
  [32, D_BIG, 14],
]);
const GOAL_LEAD = seq([
  [0, 78, 3], [3, 76, 1], [4, 78, 2], [6, 81, 2], [8, 79, 2], [10, 78, 2], [12, 76, 2], [14, 74, 2],
  [16, 76, 3], [19, 79, 1], [20, 76, 2], [22, 72, 2], [24, 74, 3], [27, 79, 1], [28, 83, 2], [30, 81, 2],
  [32, 81, 14],
]);
const GOAL_BASS = seq([
  [0, 38, 2], [2, 50, 2], [4, 38, 2], [6, 50, 2], [8, 38, 2], [10, 50, 2], [12, 38, 2], [14, 50, 2],
  [16, 36, 2], [18, 48, 2], [20, 36, 2], [22, 48, 2], [24, 35, 2], [26, 47, 2], [28, 35, 2], [30, 47, 2],
  [32, 38, 14],
]);

function renderGoal(K, m, bar, s, t, sd) {
  const out = m.bus, st = bar * 16 + s;
  const br = GOAL_BRASS.get(st);
  if (br) for (const [ms, len] of br) K.brass(out, t, ms, len * sd * 0.92, st === 32 ? 1.1 : 1, { r: st === 32 ? 0.6 : 0.12 });
  const ld = GOAL_LEAD.get(st);
  if (ld) for (const [mid, len] of ld) K.lead(out, t, mid, len * sd * 0.95, 1, { cutoff: 3200 });
  const bs = GOAL_BASS.get(st);
  if (bs) for (const [mid, len] of bs) K.bass(out, t, mid, len * sd * 0.8, 1, { cutoff: 520, sub: st === 32 });
  if (bar < 2) {
    if (s % 4 === 0) K.kick(out, t, 1);
    if (s === 4 || s === 12) K.snare(out, t, 1);
    if (s % 4 === 2) K.hat(out, t, 0.5, true);
    if (bar === 0 && s === 0) K.crash(out, t, 1);
    if (bar === 1 && s >= 13) K.snare(out, t, 0.45 + 0.18 * (s - 13));
    if (bar === 1 && s >= 14) K.tom(out, t, s === 14 ? 45 : 41, 0.8);
  } else if (s === 0) {
    K.kick(out, t, 1.1);
    K.crash(out, t, 1);
    K.tom(out, t, 38, 0.9);
  }
}

// INTERMISSION - 88 BPM, swung 16ths, A minor, 4-bar loop: Am9 | Fmaj9 | Dm9 | E7sus4 -> E7b9.
// Soft electric-piano chords, round sub bass, rim + brushed hats, bell melody every other pass.
const INT_BARS = [
  { b: 45, ep: [60, 64, 67, 71], ap: 43 },
  { b: 41, ep: [57, 60, 64, 67], ap: 40 },
  { b: 38, ep: [53, 57, 60, 64], ap: 39 },
  { b: 40, ep: [62, 64, 69, 71], ep2: [56, 59, 62, 65], ap: 44 },
];
const INT_MEL = seq([
  [3, 76, 3], [6, 79, 2], [8, 81, 4], [14, 79, 2],
  [18, 76, 6], [26, 72, 4],
  [35, 74, 3], [38, 76, 2], [40, 77, 4], [44, 76, 2], [46, 74, 2],
  [48, 71, 6], [56, 68, 4],
]);
const BASS_SOFT = { type: 'triangle', cutoff: 700, q: 0.8, env: 1.4, sub: true, level: 0.3, s: 0.8, d: 0.3, r: 0.08 };

function renderIntermission(K, m, bar, s, t, sd) {
  const out = m.bus, lb = bar % 4, cyc = (bar / 4) | 0, c = INT_BARS[lb];
  if (s === 0) K.ep(out, t, c.ep, sd * 6.5, 0.9);
  if (s === 7 && !c.ep2) K.ep(out, t, c.ep, sd * 1.5, 0.45);
  if (s === 10) K.ep(out, t, c.ep2 || c.ep, sd * 5.5, 0.7);
  if (s === 0) K.bass(out, t, c.b, sd * 5, 1, BASS_SOFT);
  if (s === 7) K.bass(out, t, c.b + 12, sd, 0.6, BASS_SOFT);
  if (s === 10) K.bass(out, t, c.b, sd * 3, 0.85, BASS_SOFT);
  if (s === 14) K.bass(out, t, c.ap, sd * 1.6, 0.7, BASS_SOFT);
  if (s === 0 || s === 10) K.kick(out, t, s === 0 ? 0.75 : 0.6);
  if (s === 7 && lb % 2 === 1) K.kick(out, t, 0.4);
  if (s === 4 || s === 12) K.rim(out, t, 0.75);
  K.hat(out, t, [0.32, 0.12, 0.22, 0.12][s % 4]);
  if (cyc % 2 === 0) {
    const ev = INT_MEL.get(lb * 16 + s);
    if (ev) for (const [mid, len] of ev) K.bell(out, t, mid, len * sd, 0.8);
  }
}

// FINAL - 120 BPM, E major, one-shot: E A/E E B/D# | C#m A C D | Esus4 (roll) | E (final hit),
// then one silent bar to ring out, then silence.
const E_MAJ = [64, 68, 71, 76], A_E = [64, 69, 73, 76], B_DS = [63, 66, 71, 75], CS_M = [61, 64, 68, 73];
const A_MAJ = [61, 64, 69, 73], C_MAJ2 = [60, 64, 67, 72], D_MAJ2 = [62, 66, 69, 74];
const E_SUS = [52, 64, 69, 71, 76], E_END = [52, 59, 64, 68, 71, 76];
const FIN_BRASS = seq([
  [0, E_MAJ, 3], [4, A_E, 3], [8, E_MAJ, 4], [12, B_DS, 4],
  [16, CS_M, 4], [20, A_MAJ, 4], [24, C_MAJ2, 3], [28, D_MAJ2, 4],
  [32, E_SUS, 15], [48, E_END, 10],
]);
const FIN_LEAD = seq([
  [0, 80, 3], [3, 78, 1], [4, 81, 3], [7, 80, 1], [8, 83, 4], [12, 78, 4],
  [16, 80, 4], [20, 81, 4], [24, 79, 3], [28, 81, 4],
  [32, 81, 15], [48, 80, 10],
]);
const FIN_BASS = seq([
  [0, 40, 3], [4, 40, 3], [8, 40, 4], [12, 39, 4],
  [16, 37, 4], [20, 33, 4], [24, 36, 3], [28, 38, 4],
  [32, 40, 15], [48, 28, 10],
]);

function renderFinal(K, m, bar, s, t, sd) {
  const out = m.bus, st = bar * 16 + s;
  const br = FIN_BRASS.get(st);
  if (br) for (const [ms, len] of br) K.brass(out, t, ms, len * sd * 0.92, st >= 32 ? 1.1 : 1, { r: st >= 32 ? 0.7 : 0.12 });
  const ld = FIN_LEAD.get(st);
  if (ld) for (const [mid, len] of ld) K.lead(out, t, mid, len * sd * 0.95, 1, { cutoff: 3400 });
  const bs = FIN_BASS.get(st);
  if (bs) for (const [mid, len] of bs) K.bass(out, t, mid, len * sd * 0.85, 1, { cutoff: 500, sub: st >= 32 });
  if (bar < 2) {
    if (s % 4 === 0) K.kick(out, t, 1);
    if (s === 4 || s === 12) K.snare(out, t, 0.95);
    if (s === 0) K.crash(out, t, bar === 0 ? 1 : 0.7);
    if (s % 4 === 2) K.hat(out, t, 0.45, true);
    if (bar === 1 && s >= 14) K.tom(out, t, s === 14 ? 47 : 43, 0.8);
  } else if (bar === 2) {
    if (s === 0) { K.kick(out, t, 1); K.crash(out, t, 0.9); }
    K.snare(out, t, 0.12 + 0.05 * s);                 // crescendo roll
    if (s >= 12) K.tom(out, t, [50, 47, 43, 40][s - 12], 0.9);
  } else if (bar === 3 && s === 0) {
    K.kick(out, t, 1.2);
    K.crash(out, t, 1.1);
    K.tom(out, t, 36, 1);
    if (m.win) sparkle(K, out, t, 64);
  }
}

const MOODS = {
  lobby: { bpm: 128, level: 0.55, fadeIn: XFADE, quant: 16, tonic: 40, major: 67, render: renderLobby },
  play: { bpm: 132, level: 0.28, fadeIn: XFADE, quant: 4, filter: 2800, tonic: 40, major: 67, render: renderPlay },
  stoppage: { bpm: 116, level: 0.5, fadeIn: XFADE, quant: 4, swing: 0.45, swingMode: 8, tonic: 43, major: 67, setup: setupOrgan, render: renderStoppage },
  goal: { bpm: 140, level: 0.6, fadeIn: 0.04, quant: 4, bars: 3, then: 'stoppage', protect: true, tonic: 38, major: 62, render: renderGoal },
  intermission: { bpm: 88, level: 0.5, fadeIn: XFADE, quant: 4, swing: 0.3, swingMode: 16, tonic: 45, major: 60, render: renderIntermission },
  final: { bpm: 120, level: 0.6, fadeIn: 0.04, quant: 4, bars: 5, then: null, protect: true, tonic: 40, major: 64, render: renderFinal },
};

function swingOffset(def, s, sd) {
  if (!def.swing) return 0;
  if (def.swingMode === 16) return s % 2 === 1 ? def.swing * sd : 0;
  return s % 4 === 2 ? def.swing * sd : s % 4 === 3 ? def.swing * sd * 0.5 : 0;
}

// ---------------------------------------------------------------------------------------------
// Stingers (k = { tonic: low MIDI root for power chords, major: MIDI root ~C4..B4 for major hits }).

function sparkle(K, out, t, R) {
  [0, 4, 7, 12, 16, 19].forEach((iv, i) => K.bell(out, t + i * 0.06, R + 12 + iv, 0.5, 0.7));
}

const STINGERS = {
  goal(K, out, t, k) {               // hit, stepwise run up (5-6-7-8), big held chord
    const R = k.major, dt = 0.085;
    K.brass(out, t, [R - 12, R - 5, R, R + 4], 0.14, 1, { r: 0.08 });
    K.kick(out, t, 0.9);
    [7, 9, 11, 12].forEach((iv, i) => K.lead(out, t + 0.17 + i * dt, R + iv, dt * 0.9, 0.9, { cutoff: 3600 }));
    const th = t + 0.17 + 4 * dt;
    K.brass(out, th, [R - 12, R - 5, R, R + 4, R + 7], 0.75, 1.1, { r: 0.4 });
    K.lead(out, th, R + 16, 0.75, 0.9);
    K.kick(out, th, 1);
    K.crash(out, th, 0.9);
  },
  bighit(K, out, t, k) {             // low power-chord slam
    const T = k.tonic;
    K.brass(out, t, [T, T + 7, T + 12], 0.22, 1.2, { r: 0.25, bright: 2400 });
    K.kick(out, t, 1.2);
    K.tom(out, t, T - 5, 1);
    K.crash(out, t, 0.45);
  },
  onfire(K, out, t, k) {             // rising sweep into a pentatonic shimmer
    const R = k.major;
    K.sweep(out, t, k.tonic + 12, k.tonic + 36, 0.55, 1);
    [0, 2, 4, 7, 9, 12, 14, 16].forEach((iv, i) => K.bell(out, t + 0.45 + i * 0.045, R + iv, 0.35, 0.8));
    K.crash(out, t + 0.5, 0.5);
  },
  periodStart(K, out, t, k) {        // snare roll into a tonic hit
    const R = k.major;
    for (let i = 0; i < 8; i++) K.snare(out, t + i * 0.06, 0.2 + i * 0.09);
    const th = t + 0.5;
    K.brass(out, th, [R - 12, R - 5, R, R + 4, R + 7], 0.9, 1.1, { r: 0.5 });
    K.kick(out, th, 1.1);
    K.crash(out, th, 1);
    K.tom(out, th, k.tonic, 0.9);
  },
  win(K, out, t, k) {                // IV - V - I with sparkle
    const R = k.major;
    K.brass(out, t, [R - 7, R - 3, R, R + 5], 0.24, 1);
    K.brass(out, t + 0.3, [R - 5, R - 1, R + 2, R + 7], 0.24, 1);
    K.brass(out, t + 0.6, [R - 12, R - 5, R, R + 4, R + 7], 1.3, 1.15, { r: 0.6 });
    K.kick(out, t, 0.8);
    K.kick(out, t + 0.3, 0.8);
    K.kick(out, t + 0.6, 1.1);
    K.crash(out, t + 0.6, 1);
    sparkle(K, out, t + 0.6, R);
  },
};

// ---------------------------------------------------------------------------------------------

export function createMusic(ctx, destination) {
  let disposed = false;
  let volume = 0.7;
  let volZeroAt = Infinity;   // when volume is 0, stop creating notes after the fade has finished

  const master = ctx.createGain();
  master.gain.value = volume * volume;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 3;
  comp.attack.value = 0.008;
  comp.release.value = 0.25;
  master.connect(comp);
  comp.connect(destination);

  const stingBus = ctx.createGain();
  stingBus.gain.value = 0.6;
  stingBus.connect(master);

  const sr = ctx.sampleRate || 44100;
  const noiseBuf = ctx.createBuffer(1, Math.floor(sr), sr);
  {
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // ---- voice cap: one entry (end time) per scheduled source
  const voiceEnds = [];
  function activeVoices(now) {
    let w = 0;
    for (let i = 0; i < voiceEnds.length; i++) if (voiceEnds[i] > now) voiceEnds[w++] = voiceEnds[i];
    voiceEnds.length = w;
    return w;
  }
  function claim(n, end, pri) {
    const active = activeVoices(ctx.currentTime);
    const limit = pri >= 2 ? MAX_VOICES * 0.7 : pri === 1 ? MAX_VOICES * 0.9 : MAX_VOICES;
    if (active + n > limit) return false;
    for (let i = 0; i < n; i++) voiceEnds.push(end);
    return true;
  }

  // ---- node helpers
  function gainAt0() { const g = ctx.createGain(); g.gain.value = 0; return g; }
  function fixedGain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function filt(type, f, q) {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    if (q != null) b.Q.value = q;
    return b;
  }
  function oscN(type, freq, detune) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    return o;
  }
  function noise(t, end) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.start(t, Math.random() * 0.9);
    s.stop(end);
    return s;
  }
  function run(src, t, end) { src.start(t); src.stop(end); return src; }
  function freeOn(src, ...nodes) {
    src.onended = () => {
      try { src.disconnect(); } catch (_) { /* already gone */ }
      for (const n of nodes) { try { n.disconnect(); } catch (_) { /* already gone */ } }
    };
  }

  // ---- instrument kit (out = destination node, t = start time, v = velocity ~0..1.2)
  const K = {
    kick(out, t, v = 1) {
      const end = t + 0.42;
      if (!claim(1, end, 0)) return;
      const o = oscN('sine', KICK_F0);
      o.frequency.setValueAtTime(KICK_F0, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.35);
      const g = gainAt0();
      perc(g.gain, t, 0.002, 0.95 * v, 0.36);
      o.connect(g); g.connect(out);
      run(o, t, end); freeOn(o, g);
    },
    snare(out, t, v = 1) {
      const end = t + 0.24;
      if (!claim(2, end, 0)) return;
      const n = noise(t, end), hp = filt('highpass', 1500, 0.7), g = gainAt0();
      perc(g.gain, t, 0.002, 0.42 * v, 0.17);
      n.connect(hp); hp.connect(g); g.connect(out); freeOn(n, hp, g);
      const o = oscN('triangle', 220);
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(165, t + 0.07);
      const g2 = gainAt0();
      perc(g2.gain, t, 0.002, 0.32 * v, 0.09);
      o.connect(g2); g2.connect(out);
      run(o, t, end); freeOn(o, g2);
    },
    rim(out, t, v = 1) {
      const end = t + 0.08;
      if (!claim(2, end, 1)) return;
      const n = noise(t, end), bp = filt('bandpass', 2400, 3), g = gainAt0();
      perc(g.gain, t, 0.001, 0.3 * v, 0.035);
      n.connect(bp); bp.connect(g); g.connect(out); freeOn(n, bp, g);
      const o = oscN('triangle', 820), g2 = gainAt0();
      perc(g2.gain, t, 0.001, 0.16 * v, 0.03);
      o.connect(g2); g2.connect(out);
      run(o, t, end); freeOn(o, g2);
    },
    clap(out, t, v = 1) {
      const end = t + 0.26;
      if (!claim(1, end, 0)) return;
      const n = noise(t, end), bp = filt('bandpass', 1150, 1.1), g = gainAt0(), p = g.gain, pk = 0.55 * v;
      p.setValueAtTime(0, t);                       // three fast bursts, then the tail
      p.linearRampToValueAtTime(pk, t + 0.002);
      p.linearRampToValueAtTime(pk * 0.2, t + 0.010);
      p.linearRampToValueAtTime(pk * 0.9, t + 0.012);
      p.linearRampToValueAtTime(pk * 0.2, t + 0.021);
      p.linearRampToValueAtTime(pk * 0.85, t + 0.023);
      p.exponentialRampToValueAtTime(FLOOR, t + 0.22);
      p.linearRampToValueAtTime(0, t + 0.225);
      n.connect(bp); bp.connect(g); g.connect(out); freeOn(n, bp, g);
    },
    hat(out, t, v = 1, open = false) {
      const dec = open ? 0.22 : 0.035, end = t + dec + 0.03;
      if (!claim(1, end, 2)) return;
      const n = noise(t, end), hp = filt('highpass', 7200, 0.8), g = gainAt0();
      perc(g.gain, t, 0.001, 0.2 * v, dec);
      n.connect(hp); hp.connect(g); g.connect(out); freeOn(n, hp, g);
    },
    crash(out, t, v = 1) {
      const end = t + 1.56;
      if (!claim(1, end, 1)) return;
      const n = noise(t, end), hp = filt('highpass', 3800, 0.5), g = gainAt0();
      perc(g.gain, t, 0.002, 0.25 * v, 1.5);
      n.connect(hp); hp.connect(g); g.connect(out); freeOn(n, hp, g);
    },
    tom(out, t, m, v = 1) {
      const end = t + 0.36;
      if (!claim(1, end, 1)) return;
      const f = mtof(m), o = oscN('sine', f * 1.7), g = gainAt0();
      o.frequency.setValueAtTime(f * 1.7, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
      perc(g.gain, t, 0.002, 0.6 * v, 0.3);
      o.connect(g); g.connect(out);
      run(o, t, end); freeOn(o, g);
    },
    bass(out, t, m, dur, v = 1, o = {}) {
      const r = o.r ?? 0.03, end = t + Math.max(dur, 0.01) + r + 0.03;
      if (!claim(o.sub ? 2 : 1, end, 0)) return;
      const g = gainAt0();
      adsr(g.gain, t, dur, 0.004, o.d ?? 0.12, o.s ?? 0.6, r, (o.level ?? 0.34) * v);
      const c = o.cutoff ?? 450, lp = filt('lowpass', c, o.q ?? 5);
      lp.frequency.setValueAtTime(c * (o.env ?? 3.2), t);
      lp.frequency.exponentialRampToValueAtTime(c, t + 0.11);
      lp.connect(g); g.connect(out);
      const a = oscN(o.type ?? 'sawtooth', mtof(m));
      a.connect(lp); run(a, t, end);
      if (o.sub) {
        const b = oscN('sine', mtof(m));
        b.connect(g); run(b, t, end);
      }
      freeOn(a, lp, g);
    },
    pluck(out, t, m, dur, v = 1, o = {}) {
      const dec = Math.min(0.22, Math.max(0.06, dur * 1.2)), end = t + dec + 0.02;
      if (!claim(1, end, 2)) return;
      const c = o.cutoff ?? 2200, a = oscN(o.type ?? 'square', mtof(m)), lp = filt('lowpass', c, 2), g = gainAt0();
      lp.frequency.setValueAtTime(c * 1.8, t);
      lp.frequency.exponentialRampToValueAtTime(c, t + dec * 0.6);
      perc(g.gain, t, 0.002, 0.13 * v, dec);
      a.connect(lp); lp.connect(g); g.connect(out);
      run(a, t, end); freeOn(a, lp, g);
    },
    lead(out, t, m, dur, v = 1, o = {}) {
      const r = o.r ?? 0.08, end = t + dur + r + 0.03, vib = dur > 0.45;
      if (!claim(vib ? 3 : 2, end, 1)) return;
      const f = mtof(m), c = o.cutoff ?? 2600, lp = filt('lowpass', c, 1.2), g = gainAt0();
      lp.frequency.setValueAtTime(c * 1.6, t);
      lp.frequency.exponentialRampToValueAtTime(c, t + 0.15);
      adsr(g.gain, t, dur, 0.01, 0.18, 0.65, r, 0.13 * v);
      lp.connect(g); g.connect(out);
      const a = oscN('sawtooth', f, -7), b = oscN('sawtooth', f, 7);
      a.connect(lp); b.connect(lp);
      run(a, t, end); run(b, t, end);
      if (vib) {                                   // delayed vibrato on held notes
        const lfo = oscN('sine', 5.6), dep = fixedGain(12);
        lfo.connect(dep); dep.connect(a.detune); dep.connect(b.detune);
        run(lfo, t + 0.25, end); freeOn(lfo, dep);
      }
      freeOn(a); freeOn(b, lp, g);
    },
    brass(out, t, ms, dur, v = 1, o = {}) {
      const r = o.r ?? 0.14, end = t + dur + r + 0.03;
      const per = ms.length > 4 ? 1 : 2;           // big chords: one saw per note
      if (!claim(ms.length * per, end, 0)) return;
      const pk = o.bright ?? 3200, lp = filt('lowpass', 500, 1.6), g = gainAt0();
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.exponentialRampToValueAtTime(pk, t + 0.05);
      lp.frequency.exponentialRampToValueAtTime(pk * 0.55, t + 0.3);
      adsr(g.gain, t, dur, 0.012, 0.25, 0.7, r, (0.36 * v) / Math.sqrt(ms.length * per));
      lp.connect(g); g.connect(out);
      let last = null;
      ms.forEach((m, i) => {
        const dets = per === 2 ? [-6, 6] : [i % 2 ? 6 : -6];
        for (const d of dets) {
          const a = oscN('sawtooth', mtof(m), d);
          a.connect(lp); run(a, t, end); freeOn(a);
          last = a;
        }
      });
      if (last) freeOn(last, lp, g);
    },
    organ(out, t, ms, dur, v = 1, vib = null, parts = ORGAN_PARTS) {
      const r = 0.06, end = t + dur + r + 0.03;
      if (!claim(ms.length * parts.length, end, 0)) return;
      const g = gainAt0(), lp = filt('lowpass', 4200, 0.5);
      adsr(g.gain, t, dur, 0.006, 0, 1, r, 0.2 * v);
      lp.connect(g); g.connect(out);
      const pg = parts.map((p) => { const x = fixedGain(p[2]); x.connect(lp); return x; });
      let last = null;
      for (const m of ms) {
        const f = mtof(m);
        parts.forEach(([ratio, type, , det], i) => {
          const a = oscN(type, f * ratio, det);
          if (vib) vib.connect(a.detune);
          a.connect(pg[i]); run(a, t, end);
          a.onended = () => {
            try { a.disconnect(); } catch (_) { /* gone */ }
            if (vib) { try { vib.disconnect(a.detune); } catch (_) { /* gone */ } }
          };
          last = a;
        });
      }
      if (last) {
        const prev = last.onended;
        last.onended = () => {
          prev();
          for (const n of [...pg, lp, g]) { try { n.disconnect(); } catch (_) { /* gone */ } }
        };
      }
    },
    ep(out, t, ms, dur, v = 1) {
      const r = 0.35, end = t + dur + r + 0.03, tineEnd = t + 0.2;
      if (!claim(ms.length, end, 1) || !claim(ms.length, tineEnd, 1)) return;
      const g = gainAt0(), lp = filt('lowpass', 2800, 0.4), tine = gainAt0();
      adsr(g.gain, t, dur, 0.004, 1.4, 0.35, r, 0.11 * v);
      perc(tine.gain, t, 0.002, 0.05 * v, 0.14);
      g.connect(lp); lp.connect(out); tine.connect(out);
      let last = null, lastT = null;
      for (const m of ms) {
        const f = mtof(m);
        const a = oscN('sine', f); a.connect(g); run(a, t, end); freeOn(a); last = a;
        const b = oscN('sine', f * 4); b.connect(tine); run(b, t, tineEnd); freeOn(b); lastT = b;
      }
      freeOn(last, g, lp);
      freeOn(lastT, tine);
    },
    bell(out, t, m, dur, v = 1) {
      const dec = Math.max(0.3, dur), end = t + dec + 0.05;
      if (!claim(2, end, 1)) return;
      const f = mtof(m), g1 = gainAt0(), g2 = gainAt0();
      perc(g1.gain, t, 0.002, 0.13 * v, dec);
      perc(g2.gain, t, 0.001, 0.05 * v, dec * 0.35);
      g1.connect(out); g2.connect(out);
      const a = oscN('sine', f), b = oscN('sine', f * 2.76);
      a.connect(g1); b.connect(g2);
      run(a, t, end); run(b, t, end); freeOn(a, g1); freeOn(b, g2);
    },
    sweep(out, t, m0, m1, dur, v = 1) {
      const end = t + dur + 0.12;
      if (!claim(2, end, 1)) return;
      const bp = filt('bandpass', 300, 3), g = gainAt0(), p = g.gain;
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.exponentialRampToValueAtTime(5000, t + dur);
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(0.22 * v, t + dur * 0.85);
      p.exponentialRampToValueAtTime(FLOOR, t + dur + 0.08);
      p.linearRampToValueAtTime(0, t + dur + 0.085);
      bp.connect(g); g.connect(out);
      const a = oscN('sawtooth', mtof(m0));
      a.frequency.setValueAtTime(mtof(m0), t);
      a.frequency.exponentialRampToValueAtTime(mtof(m1), t + dur);
      a.connect(bp); run(a, t, end); freeOn(a);
      const n = noise(t, end), ng = fixedGain(0.5);
      n.connect(ng); ng.connect(bp); freeOn(n, ng, bp, g);
    },
  };

  // ---- scheduler state
  let cur = null;          // playing mood instance
  let pending = null;      // requested mood name, applied on the next allowed boundary
  let lastRequest = null;
  let winQueued = false;   // stinger('win') arrived while 'final' was pending
  let idleFrom = 0;        // when nothing plays: earliest start for the next mood
  const retired = [];      // fading buses, disconnected once silent
  const lastSting = {};

  const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const isMuted = (t) => volume === 0 && t >= volZeroAt;

  function makeInst(name, T) {
    const def = MOODS[name];
    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    const inst = { name, def, bus, start: T, step: 0, sd: 60 / def.bpm / 4, fadeEnd: 0, nodes: [bus], lfos: [], win: false };
    if (def.filter) {
      const f = filt('lowpass', def.filter, 0.5);
      bus.connect(f); f.connect(master);
      inst.nodes.push(f);
    } else {
      bus.connect(master);
    }
    const t0 = Math.max(now, T - def.fadeIn / 2), t1 = Math.max(t0 + 0.01, T + def.fadeIn / 2);
    bus.gain.setValueAtTime(0, t0);
    bus.gain.linearRampToValueAtTime(def.level, t1);
    inst.fadeEnd = t1;
    if (def.setup) def.setup(ctx, inst, T);
    if (name === 'final' && winQueued) inst.win = true;
    winQueued = false;
    return inst;
  }

  function retire(inst, at, dur) {
    const t0 = Math.max(at, inst.fadeEnd, ctx.currentTime + 0.002);
    const g = inst.bus.gain;
    g.setValueAtTime(inst.def.level, t0);
    g.linearRampToValueAtTime(0, t0 + dur);
    const freeAt = t0 + dur + 0.5;
    for (const l of inst.lfos) { try { l.stop(freeAt); } catch (_) { /* already stopped */ } }
    retired.push({ inst, freeAt });
  }

  function freeRetired(now) {
    for (let i = retired.length - 1; i >= 0; i--) {
      if (now < retired[i].freeAt) continue;
      for (const n of retired[i].inst.nodes) { try { n.disconnect(); } catch (_) { /* gone */ } }
      retired.splice(i, 1);
    }
  }

  // Switch at grid time T. name: mood name, 'off', or null (silence after a one-shot).
  function switchTo(name, T) {
    const toSilence = !name || name === 'off';
    if (cur) {
      const fade = name === 'off' ? OFF_FADE : !name ? END_FADE : XFADE;
      retire(cur, toSilence ? T : T - XFADE / 2, fade);
    }
    cur = null;
    if (toSilence) { idleFrom = T + 0.05; winQueued = false; return; }
    cur = makeInst(name, T);
  }

  function canInterrupt(inst, name) {
    return !inst.def.protect || name === 'off' || name === 'lobby';
  }

  function tick() {
    if (disposed) return;
    const now = ctx.currentTime;
    const ahead = now + (isHidden() ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
    freeRetired(now);
    if (!cur && pending) {
      const name = pending;
      pending = null;
      if (name !== 'off') cur = makeInst(name, Math.max(now + 0.05, idleFrom));
    }
    if (!cur) return;
    // Timers were throttled (background tab / jank): skip the missed steps instead of bursting.
    if (cur.start + cur.step * cur.sd < now - 0.05) {
      cur.step = Math.max(cur.step, Math.ceil((now + 0.01 - cur.start) / cur.sd));
    }
    let guard = 0;
    while (cur && guard++ < 1024) {
      const T = cur.start + cur.step * cur.sd;
      if (T >= ahead) break;
      const def = cur.def, s = cur.step % 16, bar = (cur.step / 16) | 0;
      if (pending && canInterrupt(cur, pending) && cur.step > 0 && cur.step % MOOD_QUANT(pending) === 0) {
        const name = pending;
        pending = null;
        switchTo(name, T);
        continue;
      }
      if (def.bars && bar >= def.bars) {
        const next = pending || def.then;
        pending = null;
        switchTo(next, T);
        continue;
      }
      if (!isMuted(T)) def.render(K, cur, bar, s, T + swingOffset(def, s, cur.sd), cur.sd);
      cur.step++;
    }
  }

  function MOOD_QUANT(name) { return name === 'off' ? 4 : MOODS[name].quant; }

  const timer = setInterval(tick, TICK_MS);

  // ---- public API
  function setMood(name) {
    if (disposed || !MOOD_NAMES.has(name) || name === lastRequest) return;
    lastRequest = name;
    if (cur && cur.name === name) { pending = null; return; }   // already there: cancel any change
    if (!cur && name === 'off') { pending = null; return; }
    pending = name;
    tick();
  }

  function stinger(kind) {
    if (disposed || !Object.prototype.hasOwnProperty.call(STINGERS, kind)) return;
    const now = ctx.currentTime;
    if (isMuted(now)) return;
    if (now - (lastSting[kind] ?? -1e9) < STING_GAP[kind]) return;
    if (kind === 'goal' && (pending === 'goal' || (cur && cur.name === 'goal'))) return;
    lastSting[kind] = now;
    if (kind === 'win') {
      if (pending === 'final') { winQueued = true; return; }
      if (cur && cur.name === 'final' && cur.step <= 48) { cur.win = true; return; }
    }
    let t = now + 0.02;
    if (cur) {                                   // lock to the next 16th if it is close
      const q = cur.start + Math.ceil((now + 0.01 - cur.start) / cur.sd) * cur.sd;
      if (q >= now + 0.01 && q - now < 0.14) t = q;
    }
    const def = MOODS[pending && pending !== 'off' ? pending : cur ? cur.name : 'lobby'];
    STINGERS[kind](K, stingBus, t, { tonic: def.tonic, major: def.major });
  }

  function setVolume(v) {
    if (disposed) return;
    v = Math.min(1, Math.max(0, Number(v) || 0));
    volume = v;
    const now = ctx.currentTime;
    master.gain.setTargetAtTime(v * v, now, 0.06);     // smooth, never a step
    volZeroAt = v === 0 ? now + 0.6 : Infinity;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    const now = ctx.currentTime;
    master.gain.setTargetAtTime(0, now, 0.04);
    const insts = retired.map((r) => r.inst);
    if (cur) insts.push(cur);
    for (const inst of insts) for (const l of inst.lfos) { try { l.stop(now + 0.4); } catch (_) { /* stopped */ } }
    cur = null;
    pending = null;
    setTimeout(() => {
      for (const inst of insts) for (const n of inst.nodes) { try { n.disconnect(); } catch (_) { /* gone */ } }
      for (const n of [stingBus, master, comp]) { try { n.disconnect(); } catch (_) { /* gone */ } }
    }, 450);
  }

  function getState() {
    const now = ctx.currentTime;
    const base = { requested: lastRequest, pending, volume, voices: activeVoices(now), time: now };
    if (!cur) return { mood: 'silent', bpm: 0, bar: 0, beat: 0, step: 0, startedAt: null, ...base };
    const pos = Math.max(0, Math.floor((now - cur.start) / cur.sd + 1e-6));
    return {
      mood: cur.name, bpm: cur.def.bpm, bar: ((pos / 16) | 0) + 1, beat: (((pos % 16) / 4) | 0) + 1,
      step: pos % 16, startedAt: cur.start, ...base,
    };
  }

  return { setMood, stinger, setVolume, dispose, getState };
}
