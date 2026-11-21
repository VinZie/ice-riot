// ICE RIOT - synthesized audio (WebAudio only, no sample files).
//
// createAudio() -> { handle(events, state, ctx), blip(kind), setScene('lobby'|'game'),
//                    toggleMute(), setMuted(b), setVolume(v), muted, volume, unlock() }
// The AudioContext is created / resumed on the first user gesture.

import { EVENT } from '/shared/constants.js';
import { evType } from './net.js';

const LS_VOL = 'iceriot.volume';
const LS_MUTE = 'iceriot.muted';
const MAX_VOICES = 32;

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, v) { try { localStorage.setItem(key, String(v)); } catch { /* private mode */ } }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

export function createAudio() {
  let ctx = null;
  let master, comp, sfx, crowdBus, swellGain, swellFilter, noiseBuf, pinkBuf, distCurve;
  let duck, musicBus, musicDuck; // duck: optional crowd ducking; musicBus: output for music.js
  let scene = 'lobby';
  let voices = 0;
  const lastAt = {};
  let volume = clamp(parseFloat(load(LS_VOL) ?? '0.8'), 0, 1);
  if (!Number.isFinite(volume)) volume = 0.8;
  let muted = load(LS_MUTE) === '1';

  const api = {
    get muted() { return muted; },
    get volume() { return volume; },
    get ready() { return !!ctx && ctx.state === 'running'; },
  };

  // ------------------------------------------------------------------ setup
  function makeNoise(seconds, pink) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (!pink) { d[i] = w; continue; }
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      // crossfade the loop seam
      const fade = Math.min(2000, len >> 3);
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        d[i] = d[i] * t + d[len - fade + i] * (1 - t);
      }
    }
    return b;
  }

  function init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return false; }
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    comp.connect(master); master.connect(ctx.destination);
    sfx = ctx.createGain(); sfx.gain.value = 0.9; sfx.connect(comp);
    duck = ctx.createGain(); duck.gain.value = 1; duck.connect(comp);
    crowdBus = ctx.createGain(); crowdBus.gain.value = scene === 'game' ? 1 : 0.35; crowdBus.connect(duck);
    // Music has its own compressor in music.js, so it bypasses ours; it still follows mute + ducking.
    musicDuck = ctx.createGain(); musicDuck.gain.value = 1; musicDuck.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = muted ? 0 : 1; musicBus.connect(musicDuck);
    noiseBuf = makeNoise(2, false);
    pinkBuf = makeNoise(5, true);
    distCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; distCurve[i] = Math.tanh(x * 3.2); }
    startCrowd();
    return true;
  }

  function unlock() {
    if (!ctx && !init()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  api.unlock = unlock;
  for (const type of ['pointerdown', 'keydown', 'touchend']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }

  // ------------------------------------------------------------------ crowd ambience
  function startCrowd() {
    const layer = (freq, q, gain, lfoRate, lfoDepth) => {
      const src = ctx.createBufferSource();
      src.buffer = pinkBuf; src.loop = true;
      src.loopStart = 0; src.loopEnd = pinkBuf.duration;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      const lfo = ctx.createOscillator(); lfo.frequency.value = lfoRate;
      const lg = ctx.createGain(); lg.gain.value = lfoDepth;
      lfo.connect(lg); lg.connect(g.gain);
      src.connect(f); f.connect(g); g.connect(crowdBus);
      src.start(0, Math.random() * pinkBuf.duration); lfo.start();
    };
    layer(520, 0.7, 0.22, 0.11, 0.06);
    layer(1500, 1.1, 0.08, 0.23, 0.03);
    layer(260, 0.9, 0.12, 0.07, 0.04);
    // swell layer: brighter roar driven by swell()
    const src = ctx.createBufferSource();
    src.buffer = pinkBuf; src.loop = true;
    swellFilter = ctx.createBiquadFilter(); swellFilter.type = 'bandpass';
    swellFilter.frequency.value = 900; swellFilter.Q.value = 0.6;
    swellGain = ctx.createGain(); swellGain.gain.value = 0;
    src.connect(swellFilter); swellFilter.connect(swellGain); swellGain.connect(crowdBus);
    src.start(0, Math.random() * pinkBuf.duration);
  }

  // Crowd reaction: amount 0..1.5, attack / hold / release seconds.
  function swell(amount, attack = 0.15, hold = 0.4, release = 1.6) {
    if (!ctx) return;
    const t = ctx.currentTime, g = swellGain.gain;
    const cur = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(cur, t);
    g.linearRampToValueAtTime(Math.max(cur, amount), t + attack);
    g.setValueAtTime(Math.max(cur, amount), t + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.setValueAtTime(0, t + attack + hold + release + 0.01);
    const fr = swellFilter.frequency;
    fr.cancelScheduledValues(t);
    fr.setValueAtTime(fr.value, t);
    fr.linearRampToValueAtTime(900 + amount * 500, t + attack);
    fr.linearRampToValueAtTime(800, t + attack + hold + release);
  }

  // Vowel-ish crowd voices ("oooh" for big hits, "aaah"/roar for goals).
  function crowdVoices(vowel, amount, dur) {
    if (!take('crowd' + vowel, 0.35, dur, 1)) return;
    const t = ctx.currentTime;
    const [f1, f2] = vowel === 'oo' ? [320, 800] : [720, 1150];
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.11 * amount, t + dur * 0.25);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const fa = ctx.createBiquadFilter(); fa.type = 'bandpass'; fa.frequency.value = f1; fa.Q.value = 5;
    const fb = ctx.createBiquadFilter(); fb.type = 'bandpass'; fb.frequency.value = f2; fb.Q.value = 6;
    fa.connect(out); fb.connect(out); out.connect(crowdBus);
    for (let i = 0; i < 7; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = rand(150, 330);
      o.frequency.setValueAtTime(base * 0.94, t);
      o.frequency.linearRampToValueAtTime(base * (vowel === 'oo' ? 1.08 : 1.12), t + dur * 0.35);
      o.frequency.linearRampToValueAtTime(base * 0.86, t + dur);
      const g = ctx.createGain(); g.gain.value = 0.25;
      o.connect(g); g.connect(fa); g.connect(fb);
      o.start(t + rand(0, 0.08)); o.stop(t + dur + 0.1);
    }
  }

  // ------------------------------------------------------------------ primitives
  // Voice budget + per-kind rate limit. Returns false when the sound should be skipped.
  function take(kind, minGap, dur, prio = 0) {
    if (!ctx || ctx.state !== 'running') return false;
    const t = ctx.currentTime;
    if (minGap && lastAt[kind] !== undefined && t - lastAt[kind] < minGap) return false;
    if (voices >= MAX_VOICES && prio < 2) return false;
    if (voices >= MAX_VOICES * 0.75 && prio < 1) return false;
    lastAt[kind] = t;
    voices++;
    setTimeout(() => { voices--; }, Math.max(50, dur * 1000 + 60));
    return true;
  }

  function panner(pan) {
    const g = ctx.createGain();
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p); p.connect(sfx);
    } else {
      g.connect(sfx);
    }
    return g;
  }

  function envGain(dest, t, attack, peak, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest);
    return g;
  }

  function noiseBurst(dest, t, dur, filterType, freq, q, attack, peak, decay) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = envGain(dest, t, attack, peak, decay);
    src.connect(f); f.connect(g);
    src.start(t, Math.random() * (noiseBuf.duration - dur - 0.1));
    src.stop(t + dur + 0.05);
    return f;
  }

  function tone(dest, t, type, f0, f1, attack, peak, decay) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    const g = envGain(dest, t, attack, peak, decay);
    o.connect(g);
    o.start(t); o.stop(t + attack + decay + 0.05);
    return o;
  }

  // ------------------------------------------------------------------ sounds
  function clack(pan, gain = 0.5, bright = 1) {
    if (!take('clack', 0.025, 0.12)) return;
    const t = ctx.currentTime, d = panner(pan);
    noiseBurst(d, t, 0.06, 'bandpass', 2400 * bright, 1.4, 0.001, gain, 0.045);
    tone(d, t, 'triangle', 1100 * bright, 520, 0.001, gain * 0.55, 0.05);
  }

  function slapCrack(pan, power = 1, oneTimer = false) {
    if (!take('slap', 0.04, 0.35, 1)) return;
    const t = ctx.currentTime, d = panner(pan);
    const p = 0.6 + 0.4 * clamp(power, 0, 1);
    noiseBurst(d, t, 0.2, 'highpass', 1800, 0.8, 0.001, 0.9 * p, 0.12);
    noiseBurst(d, t, 0.1, 'bandpass', 4200, 2, 0.001, 0.7 * p, 0.05);
    tone(d, t, 'sine', 210, 55, 0.002, 0.7 * p, 0.12);
    tone(d, t, 'square', 3200, 1800, 0.0005, 0.12 * p, 0.012);
    if (oneTimer) {
      noiseBurst(d, t + 0.012, 0.15, 'bandpass', 6500, 3, 0.001, 0.5, 0.08);
      tone(d, t + 0.01, 'triangle', 1900, 900, 0.001, 0.25, 0.09);
    }
  }

  function swish(pan, gain = 0.25, dur = 0.22) {
    if (!take('swish', 0.06, dur)) return;
    const t = ctx.currentTime, d = panner(pan);
    const f = noiseBurst(d, t, dur, 'bandpass', 800, 2.5, 0.04, gain, dur);
    f.frequency.setValueAtTime(700, t);
    f.frequency.exponentialRampToValueAtTime(4200, t + dur);
  }

  function thud(pan, power = 0.5) {
    if (!take('thud', 0.03, 0.3)) return;
    const t = ctx.currentTime, d = panner(pan);
    const p = clamp(power, 0, 1);
    tone(d, t, 'sine', 105, 42, 0.003, 0.35 + 0.55 * p, 0.17 + 0.1 * p);
    noiseBurst(d, t, 0.2, 'lowpass', 520, 0.8, 0.002, 0.3 + 0.4 * p, 0.12);
    noiseBurst(d, t, 0.06, 'bandpass', 1600, 1.2, 0.001, 0.1 + 0.15 * p, 0.03);
  }

  function boom(pan) {
    if (!take('boom', 0.08, 0.9, 1)) return;
    const t = ctx.currentTime, d = panner(pan);
    const shaper = ctx.createWaveShaper();
    shaper.curve = distCurve;
    const g = ctx.createGain(); g.gain.value = 0.7;
    shaper.connect(g); g.connect(d);
    tone(shaper, t, 'sine', 78, 26, 0.004, 0.95, 0.65);
    tone(d, t, 'triangle', 160, 50, 0.002, 0.35, 0.25);
    noiseBurst(d, t, 0.6, 'lowpass', 900, 1, 0.002, 0.8, 0.4);
    noiseBurst(d, t, 0.1, 'bandpass', 2400, 1, 0.001, 0.35, 0.06);
  }

  function shatter(pan) {
    if (!take('glass', 0.1, 1.2, 1)) return;
    const t = ctx.currentTime, d = panner(pan);
    noiseBurst(d, t, 0.08, 'bandpass', 5200, 1.5, 0.0008, 0.9, 0.05);
    noiseBurst(d, t, 0.9, 'highpass', 2600, 0.7, 0.002, 0.55, 0.6);
    noiseBurst(d, t + 0.02, 0.5, 'bandpass', 8000, 2, 0.004, 0.3, 0.35);
    for (let i = 0; i < 22; i++) {
      const at = t + 0.01 + Math.pow(Math.random(), 1.6) * 0.95;
      const dd = panner(clamp(pan + rand(-0.35, 0.35), -1, 1));
      tone(dd, at, Math.random() < 0.5 ? 'sine' : 'triangle', rand(2300, 7800), 0, 0.001, rand(0.04, 0.13), rand(0.03, 0.22));
    }
  }

  function boardsThump(pan, power = 0.5) {
    const p = clamp(power, 0, 1);
    if (p < 0.05) return;
    if (!take('boards', 0.06, 0.25)) return;
    const t = ctx.currentTime, d = panner(pan);
    tone(d, t, 'sine', 130, 62, 0.002, 0.2 + 0.5 * p, 0.14);
    noiseBurst(d, t, 0.2, 'lowpass', 380, 0.9, 0.002, 0.25 + 0.45 * p, 0.13);
    noiseBurst(d, t, 0.12, 'bandpass', 950, 4, 0.002, 0.08 + 0.15 * p, 0.08); // board rattle
  }

  function postPing(pan) {
    if (!take('post', 0.08, 1.3, 1)) return;
    const t = ctx.currentTime, d = panner(pan);
    const f0 = rand(1180, 1280);
    const parts = [[1, 0.5, 1.3], [2.76, 0.28, 0.85], [5.4, 0.18, 0.5], [8.93, 0.12, 0.32], [13.34, 0.07, 0.2]];
    for (const [r, g, dec] of parts) tone(d, t, 'sine', f0 * r, 0, 0.001, g, dec);
    noiseBurst(d, t, 0.03, 'highpass', 5000, 1, 0.0005, 0.3, 0.015);
  }

  function saveThump(pan) {
    if (!take('save', 0.06, 0.2)) return;
    const t = ctx.currentTime, d = panner(pan);
    noiseBurst(d, t, 0.15, 'lowpass', 1100, 1, 0.002, 0.55, 0.09);
    tone(d, t, 'sine', 160, 70, 0.002, 0.45, 0.1);
    tone(d, t, 'triangle', 700, 380, 0.001, 0.12, 0.04);
  }

  function goalHorn() {
    if (!take('horn', 1.0, 2.8, 2)) return;
    const t = ctx.currentTime, dur = 2.5;
    const out = panner(0);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 3.5;
    lp.frequency.setValueAtTime(350, t);
    lp.frequency.exponentialRampToValueAtTime(1250, t + 0.18);
    lp.frequency.setValueAtTime(1250, t + dur - 0.3);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.07);
    g.gain.setValueAtTime(0.42, t + dur - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    lp.connect(g); g.connect(out);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
    const vg = ctx.createGain(); vg.gain.value = 1.4;
    vib.connect(vg);
    for (const f of [116.5, 117.3, 174.6, 175.8, 233.1, 293.7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      vg.connect(o.frequency);
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.4);
    }
    vib.start(t); vib.stop(t + dur + 0.4);
  }

  function whistle(dur = 0.5, blasts = 1) {
    if (!take('whistle', 0.25, dur * blasts + 0.3, 1)) return;
    const t0 = ctx.currentTime;
    const d = panner(0);
    for (let b = 0; b < blasts; b++) {
      const t = t0 + b * (dur + 0.12);
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.value = rand(2750, 2950);
      const trill = ctx.createOscillator(); trill.frequency.value = rand(28, 36);
      const tg = ctx.createGain(); tg.gain.value = 140;
      trill.connect(tg); tg.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.setValueAtTime(0.22, t + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const am = ctx.createGain(); am.gain.value = 0.7;
      const amo = ctx.createGain(); amo.gain.value = 0.3;
      trill.connect(amo); amo.connect(am.gain);
      o.connect(am); am.connect(g); g.connect(d);
      o.start(t); o.stop(t + dur + 0.05);
      trill.start(t); trill.stop(t + dur + 0.05);
      noiseBurst(d, t, dur, 'bandpass', 3100, 6, 0.02, 0.06, dur);
    }
  }

  function buzzer(dur = 1.3) {
    if (!take('buzzer', 0.8, dur + 0.2, 2)) return;
    const t = ctx.currentTime, d = panner(0);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1900; lp.Q.value = 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    g.gain.setValueAtTime(0.3, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(d);
    for (const f of [98, 98.7, 196.3]) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
    }
  }

  function fireWhoosh(pan) {
    if (!take('fire', 0.3, 1.1, 1)) return;
    const t = ctx.currentTime, d = panner(pan);
    const f = noiseBurst(d, t, 1.0, 'bandpass', 300, 1.8, 0.35, 0.6, 0.6);
    f.frequency.setValueAtTime(260, t);
    f.frequency.exponentialRampToValueAtTime(3800, t + 0.9);
    tone(d, t, 'sawtooth', 110, 440, 0.3, 0.08, 0.6);
    for (let i = 0; i < 8; i++) {
      noiseBurst(d, t + 0.2 + Math.random() * 0.7, 0.03, 'highpass', 3000, 1, 0.001, rand(0.05, 0.15), 0.015);
    }
  }

  const BLIPS = {
    move: [[660, 0.03]],
    select: [[880, 0.045], [1320, 0.06]],
    back: [[520, 0.04], [390, 0.06]],
    start: [[523, 0.06], [659, 0.06], [784, 0.06], [1047, 0.12]],
    error: [[180, 0.12]],
    toast: [[990, 0.04]],
  };
  api.blip = (kind = 'move') => {
    unlock();
    const seq = BLIPS[kind] || BLIPS.move;
    const dur = seq.reduce((s, x) => s + x[1], 0);
    if (!take('blip' + kind, 0.03, dur)) return;
    const d = panner(0);
    let t = ctx.currentTime;
    for (const [f, len] of seq) {
      tone(d, t, kind === 'error' ? 'sawtooth' : 'square', f, 0, 0.003, 0.09, len);
      t += len;
    }
  };

  // ------------------------------------------------------------------ event dispatch
  const panX = (x) => clamp((Number(x) || 0) / 30 * 0.8, -0.8, 0.8);
  function playerX(state, id) {
    const p = state && state.p && state.p[id];
    return p ? p.x : 0;
  }

  api.handle = (events, state, ctx2 = {}) => {
    if (!ctx || ctx.state !== 'running' || muted || !events || !events.length) return;
    for (const e of events) {
      const type = evType(e);
      const hasX = typeof e.x === 'number';
      const pan = panX(hasX ? e.x : playerX(state, e.by ?? e.player ?? e.goalie));
      switch (type) {
        case EVENT.SHOT:
          if (e.kind === 'slap') slapCrack(pan, e.power ?? 1, false);
          else if (e.kind === 'onetimer') { slapCrack(pan, 1, true); swell(0.35, 0.1, 0.2, 0.8); }
          else clack(pan, 0.45 + 0.25 * clamp(e.power ?? 0.5, 0, 1), 1.15);
          break;
        case EVENT.PASS: clack(pan, 0.3, 0.85); break;
        case EVENT.STEAL: clack(pan, 0.4, 1.3); swish(pan, 0.12, 0.12); break;
        case EVENT.DEKE: swish(pan, 0.22, 0.25); break;
        case EVENT.HIT:
          if (e.big) { boom(pan); crowdVoices('oo', 1.0, 1.5); swell(0.8, 0.12, 0.4, 1.6); }
          else thud(pan, e.power ?? 0.4);
          break;
        case EVENT.GLASS: shatter(pan); crowdVoices('oo', 1.2, 1.8); swell(1.0, 0.1, 0.6, 1.8); break;
        case EVENT.BOARDS: boardsThump(pan, e.power ?? 0.5); break;
        case EVENT.POST: postPing(pan); crowdVoices('oo', 0.6, 1.1); swell(0.35, 0.1, 0.2, 0.9); break;
        case EVENT.SAVE: saveThump(pan); swell(0.3, 0.1, 0.15, 0.8); break;
        case EVENT.GOAL: goalHorn(); crowdVoices('ah', 1.4, 3.2); swell(1.5, 0.2, 2.2, 2.6); break;
        case EVENT.FACEOFF: whistle(0.22, 1); break;
        case EVENT.WHISTLE: whistle(0.55, 1); break;
        case EVENT.PERIOD: whistle(0.4, 2); break;
        case EVENT.PERIOD_END: buzzer(1.3); swell(0.5, 0.2, 0.6, 1.5); break;
        case EVENT.FINAL: buzzer(1.8); crowdVoices('ah', 1.0, 2.5); swell(1.2, 0.3, 1.5, 2.5); break;
        case EVENT.FIRE: if (e.on) { fireWhoosh(pan); swell(0.6, 0.2, 0.5, 1.4); } break;
        case EVENT.SWITCH: if (ctx2.myId && e.client === ctx2.myId) api.blip('move'); break;
        // fight mini-game (shared/fight.js events wrapped by the sim as {type:'fight', sub})
        case 'fightStart': whistle(0.5, 1); crowdVoices('ah', 1.1, 2.2); swell(1.0, 0.2, 1.2, 2.0); break;
        case 'fightEnd': crowdVoices('ah', 1.0, 2.0); swell(0.8, 0.1, 0.8, 1.8); break;
        case 'fight':
          if (e.sub === 'punch') thud(0, clamp(0.35 + (e.power ?? 0.5) * 0.6, 0, 1));
          else if (e.sub === 'block') clack(0, 0.35, 0.7);
          else if (e.sub === 'dodge') swish(0, 0.2, 0.2);
          else if (e.sub === 'ko') { boom(0); crowdVoices('oo', 1.2, 2.0); swell(1.2, 0.1, 1.0, 2.2); }
          break;
        default: break;
      }
    }
  };

  // ------------------------------------------------------------------ controls
  function applyGain() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(muted ? 0 : volume, t, 0.03);
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setTargetAtTime(muted ? 0 : 1, t, 0.03);
  }
  api.getContext = () => ctx;
  api.getMusicBus = () => musicBus;
  // Duck crowd + music (e.g. under voice chat). level 1 = normal.
  api.setDuck = (level) => {
    if (!ctx) return;
    const t = ctx.currentTime, l = clamp(Number(level) || 0, 0, 1);
    duck.gain.setTargetAtTime(l, t, l < 1 ? 0.08 : 0.4);
    musicDuck.gain.setTargetAtTime(0.4 + 0.6 * l, t, l < 1 ? 0.08 : 0.4);
  };
  api.setScene = (s) => {
    if (s === scene) return;
    scene = s;
    if (ctx) crowdBus.gain.setTargetAtTime(s === 'game' ? 1 : 0.35, ctx.currentTime, 0.6);
  };
  api.setMuted = (m) => { muted = !!m; save(LS_MUTE, muted ? '1' : '0'); applyGain(); };
  api.toggleMute = () => { api.setMuted(!muted); return muted; };
  api.setVolume = (v) => {
    volume = clamp(Number(v) || 0, 0, 1);
    save(LS_VOL, volume.toFixed(2));
    if (muted && volume > 0) { muted = false; save(LS_MUTE, '0'); }
    applyGain();
  };
  api.swell = (a) => swell(a);
  return api;
}
