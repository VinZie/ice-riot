// ICE RIOT - wires the optional feature modules into the client loop:
// settings, music, instant replay, touch controls, chat, couch co-op, challenges,
// tutorial hints, leaderboard, offline practice, fight overlay.
//
// Every module is loaded independently; if one fails to load or throws, the game keeps running
// without it (errors go to the console). main.js calls the hooks below once per frame.

import { EVENT, PHASE, PHASE_DURATION, BTN, PSTATE, TEAMS } from '/shared/constants.js';
import { evType } from './net.js';

const SKIP_BTNS = BTN.SHOOT | BTN.PASS | BTN.ACTION; // not TURBO: touch auto-turbo can hold it
const MOOD = {
  [PHASE.FACEOFF]: 'stoppage', [PHASE.PLAY]: 'play', [PHASE.GOAL]: 'goal',
  [PHASE.PERIOD_END]: 'intermission', [PHASE.GAME_OVER]: 'final',
};

async function load(path) {
  try { return await import(path); } catch (e) { console.warn(`[ICE RIOT] optional module ${path} failed to load:`, e); return null; }
}
function safe(label, fn) {
  try { return fn(); } catch (e) { console.warn(`[ICE RIOT] ${label}:`, e); return undefined; }
}

/**
 * opts: { onlineNet, getNet(), setNet(n), ui, input, audio, uiRoot }
 */
export async function createExtras(opts) {
  const { onlineNet, getNet, setNet, ui, input, audio, uiRoot } = opts;
  const [mSettings, mMusic, mReplay, mTouch, mChat, mCouch, mAch, mTut, mLb, mLocal, mFight] = await Promise.all([
    load('./settings.js'), load('./music.js'), load('./replay.js'), load('./touch.js'),
    load('./chat.js'), load('./couch.js'), load('./achievements.js'), load('./tutorial.js'), load('./leaderboard.js'),
    load('./local.js'), load('./fight-view.js'),
  ]);

  const X = { ready: true };

  // ------------------------------------------------------------------ settings
  const settings = mSettings && safe('settings', () => mSettings.createSettings());
  let settingsPanel = null;
  if (settings) {
    // audio.js keeps its own volume/mute; mirror them into the settings store at boot.
    safe('settings sync', () => { settings.set('sfxVolume', audio.volume); settings.set('muted', audio.muted); });
    settingsPanel = safe('settings panel', () => mSettings.createSettingsPanel(document.body, settings, {
      onOpen: () => { input.setSuppressed(true); safe('settings sync', () => { settings.set('sfxVolume', audio.volume); settings.set('muted', audio.muted); }); },
      onClose: () => input.setSuppressed(false),
    }));
    input.setKeymap((code) => settings.keyFor(code));
    settings.subscribe((key, value, all) => {
      if (key === 'sfxVolume') audio.setVolume(value);
      else if (key === 'muted') { if (audio.muted !== !!value) audio.setMuted(!!value); ui.syncSound(); }
      else if (key === 'keys') input.clear();
      applyVolumes(all);
    });
  }
  const S = (k, d) => (settings ? settings.get(k) : d);

  // ------------------------------------------------------------------ music
  let music = null;
  function applyVolumes(all = settings ? settings.all() : null) {
    if (!all) return;
    if (music) music.setVolume(all.muted ? 0 : all.musicVolume);
    if (tutorial) tutorial.setEnabled(!!all.showTutorial);
  }

  // ------------------------------------------------------------------ replay
  const replay = mReplay && safe('replay', () => mReplay.createReplay({ seconds: 5 }));
  let goalAt = 0, prevB = 0, holdOff = false, replayView = null;

  // ------------------------------------------------------------------ touch
  const touch = mTouch && safe('touch', () => mTouch.createTouchControls(document.body, { autoTurbo: false }));
  let touchOn = !!(mTouch && safe('touch detect', () => mTouch.isTouchDevice()));
  let device = 'keyboard', wasPad = false;
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { touchOn = true; device = 'touch'; } }, { capture: true, passive: true });
  addEventListener('keydown', () => { device = 'keyboard'; }, { capture: true, passive: true });

  // ------------------------------------------------------------------ chat
  const chatEl = document.getElementById('ir-lobby-chat');
  const chat = mChat && chatEl && safe('chat', () => mChat.createChat(chatEl, {
    send: (m) => { const n = getNet(); return n.send ? n.send(m) : false; },
    gameContainer: document.body,
    onTyping: (on) => input.setSuppressed(on),
  }));
  if (chat) {
    onlineNet.on('welcome', (m) => chat.setMyId(m.id));
    onlineNet.on('chat', (m) => chat.receive(m));
  }

  // ------------------------------------------------------------------ couch co-op
  const couch = mCouch && safe('couch', () => mCouch.createCouch({
    wsUrl: onlineNet.url, room: onlineNet.room, reservePads: 1,
    onChange: (list, err) => { if (err) ui.toast(err, 'warn'); },
  }));
  const noCouch = new Set();

  // ------------------------------------------------------------------ challenges, tutorial, leaderboard
  const ach = mAch && safe('achievements', () => mAch.createAchievements({ container: document.body, onUnlock: () => audio.blip('start') }));
  const tutorial = mTut && safe('tutorial', () => mTut.createTutorial({
    container: uiRoot,
    keyLabel: settings ? (button) => {
      if (button === 'move') return null;
      const codes = settings.get('keys')[button];
      return codes && codes[0] ? codes[0] : null;
    } : null,
  }));
  let leaderboard = null;
  applyVolumes();

  // ------------------------------------------------------------------ fight overlay (state.fi from the sim)
  let fightView = null, fightShown = false;
  if (mFight) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:35';
    document.body.appendChild(host);
    fightView = safe('fight view', () => mFight.createFightView(host));
  }
  function fighterInfo(state, id, names) {
    const p = state.p && state.p[id];
    const team = TEAMS[(state.teams || [0, 1])[p ? p.tm : id < 4 ? 0 : 1]] || TEAMS[0];
    const ros = team.skaters[id % 4] || team.goalie;
    const name = p && p.c && names[p.c] ? names[p.c] : ros.name;
    return { name, num: p ? p.n : ros.num, colors: team.colors, mine: !!(p && p.c && p.c === lastMyId) };
  }

  // ------------------------------------------------------------------ offline practice
  let local = null, failedTries = 0, lastRetryAt = 0, autoOfflineDone = false;
  const offlineBtn = document.querySelector('[data-act="extra"][data-x="offline"]');
  async function enterOffline(auto) {
    if (local || !mLocal) { if (!mLocal) ui.toast('Offline practice is unavailable', 'error'); return; }
    try {
      const L = onlineNet.lobby;
      const session = await mLocal.createLocalSession({ name: onlineNet.name, team: 0, config: (L && L.config) || {} });
      local = session.asNet();
      local.on('err', (m) => ui.toast(m.msg || 'Error', 'error'));
      setNet(local);
      if (offlineBtn) offlineBtn.textContent = 'GO ONLINE';
      ui.toast(auto ? "Can't reach the server - OFFLINE PRACTICE vs AI" : 'OFFLINE PRACTICE vs AI - you are the host', 'info');
    } catch (e) {
      console.error(e);
      ui.toast(`Offline practice unavailable: ${e.message || e}`, 'error');
    }
  }
  function leaveOffline() {
    if (!local) return;
    safe('offline dispose', () => local.dispose());
    local = null;
    setNet(onlineNet);
    if (offlineBtn) offlineBtn.textContent = 'PRACTICE OFFLINE';
    onlineNet.reconnectNow();
    ui.toast(onlineNet.connected() ? 'Back online' : 'Reconnecting to the server…', 'info');
  }
  onlineNet.on('lobby', (m) => { if (local && m) ui.toast('Server is reachable - press GO ONLINE in the lobby to rejoin', 'info'); });

  // ------------------------------------------------------------------ UI buttons
  X.extra = (name) => {
    switch (name) {
      case 'settings': if (settingsPanel) settingsPanel.open(); else ui.toast('Settings unavailable', 'warn'); break;
      case 'challenges': if (ach) ach.openPanel(); else ui.toast('Challenges unavailable', 'warn'); break;
      case 'leaderboard':
        if (!mLb) { ui.toast('Leaderboard unavailable', 'warn'); break; }
        if (local) { ui.toast('The leaderboard lives on the server - go online to see it', 'info'); break; }
        leaderboard ||= mLb.createLeaderboard(document.body, { me: () => onlineNet.name });
        leaderboard.open();
        break;
      case 'offline': if (local) leaveOffline(); else enterOffline(false); break;
      default: break;
    }
  };

  // ------------------------------------------------------------------ per-frame hooks
  let lastState = null, lastMyId = 0;

  /** Merge touch input, apply chat/replay suppression. Returns the input to send. */
  X.filterInput = (inp, { inGame, menuOpen }) => {
    const out = { mx: inp.mx, mz: inp.mz, b: inp.b };
    if (input.usingPad && !wasPad) device = 'gamepad';
    wasPad = input.usingPad;
    if (touch) {
      safe('touch', () => {
        touch.setVisible(touchOn && inGame && !menuOpen);
        const me = lastState && lastState.p && lastState.p.find((p) => p && p.c === lastMyId);
        touch.setContext({ hasPuck: !!me && lastState.k && lastState.k.o === me.id });
        touch.setCharge(me && me.s === PSTATE.CHARGE ? me.ch : 0);
        const t = touch.poll();
        out.b |= t.b;
        if (Math.hypot(t.mx, t.mz) > Math.hypot(out.mx, out.mz)) { out.mx = t.mx; out.mz = t.mz; }
      });
    }
    // couch pads: main input only reads pad 0 while couch players are joined
    if (couch) safe('couch', () => {
      const joined = couch.list().length > 0;
      input.setPadLimit(joined ? 1 : Infinity);
      couch.setPaused(menuOpen);
      if (!local) couch.update();
    });
    // instant replay: skip on a fresh SHOOT/PASS/ACTION press; neutral input while it plays
    if (replay && replay.isPlaying() && (out.b & ~prevB & SKIP_BTNS)) replay.stop();
    prevB = out.b;
    const playingReplay = !!(replay && replay.isPlaying());
    if (playingReplay) holdOff = true; else if (!(out.b & SKIP_BTNS)) holdOff = false;
    if (playingReplay || (chat && chat.isTyping())) { out.mx = 0; out.mz = 0; out.b = 0; }
    else if (holdOff) out.b &= ~SKIP_BTNS;
    return out;
  };

  /** Live state/events in, what the renderer should show out (replay may substitute). */
  X.view = (live, events, now, dt) => {
    replayView = null;
    if (!replay) return { state: live, events, dt };
    return safe('replay', () => {
      replay.record(live, events, now);
      for (const e of events) if (evType(e) === EVENT.GOAL && !e.replay) goalAt = now;
      if (goalAt && now - goalAt >= 800) {
        goalAt = 0;
        const budget = live && live.ph === PHASE.GOAL ? live.phT + PHASE_DURATION.FACEOFF - 0.4 : Infinity;
        replay.start({ lengthSec: 3.5, speed: 0.9, slowmoTailSec: 0.7, maxWallSec: budget });
      }
      if (replay.isPlaying() && (!live || live.ph === PHASE.PLAY)) replay.stop();
      const r = replay.update(dt);
      replayView = r;
      return r ? { state: r.state, events: r.events, dt: dt * (r.rate || 1) } : { state: live, events, dt };
    }) || { state: live, events, dt };
  };

  /** Extra renderer ctx fields. */
  X.decorateCtx = (ctx) => {
    if (couch) ctx.couchIds = safe('couch ids', () => couch.clientIds()) || noCouch;
    if (settings) {
      if (!settings.get('showNames')) ctx.showNames = false; // renderer hides all name tags
      ctx.video = { quality: settings.get('quality'), cameraShake: settings.get('cameraShake'), reduceFlashes: settings.get('reduceFlashes') };
    }
    return ctx;
  };

  /** Everything that reacts to the LIVE game: music, fight overlay, challenges, tutorial, chat mode. */
  X.after = ({ state, events, ctx, dt, lobby, inGame, playing, menuOpen, myTeam }) => {
    lastState = state; lastMyId = ctx.myId;
    const periods = lobby && lobby.config && lobby.config.periods;

    if (local) {
      safe('offline pause', () => local.pause(!!menuOpen));
    } else if (mLocal && !autoOfflineDone && !onlineNet.everConnected && onlineNet.status !== 'online') {
      if (onlineNet.retryAt && onlineNet.retryAt !== lastRetryAt) { lastRetryAt = onlineNet.retryAt; failedTries++; }
      if (failedTries >= 3) { autoOfflineDone = true; enterOffline(true); }
    }

    if (chat) safe('chat', () => {
      chat.setInGame(inGame && !menuOpen);
      if (lobby && lobby.config && lobby.config.teams) {
        const key = lobby.config.teams.join(',');
        if (key !== X._chatTeams) { X._chatTeams = key; chat.setTeamColors(lobby.config.teams.map((i) => TEAMS[i] && TEAMS[i].colors.primary)); }
      }
    });

    // music (created once the audio context exists, i.e. after the first user gesture)
    if (!music && mMusic && audio.getContext()) {
      music = safe('music', () => mMusic.createMusic(audio.getContext(), audio.getMusicBus()));
      applyVolumes();
    }
    if (music) safe('music', () => {
      music.setMood(inGame ? (state ? MOOD[state.ph] || 'play' : 'stoppage') : 'lobby');
      for (const e of events) {
        const t = evType(e);
        if (t === EVENT.PERIOD) music.stinger('periodStart');
        else if (t === EVENT.HIT && e.big) music.stinger('bighit');
        else if (t === EVENT.GLASS) music.stinger('bighit');
        else if (t === EVENT.FIRE && e.on) music.stinger('onfire');
        else if (t === EVENT.FINAL) {
          music.setMood('final');
          const sc = e.score || (state && state.sc) || [0, 0];
          if ((myTeam === 0 && sc[0] > sc[1]) || (myTeam === 1 && sc[1] > sc[0])) music.stinger('win');
        }
      }
    });

    if (fightView) safe('fight view', () => {
      const fi = state && state.fi;
      if (fi) {
        if (!fightShown) {
          const A = fighterInfo(state, fi.a, ctx.names), B = fighterInfo(state, fi.b, ctx.names);
          fightView.show(fi, {
            nameA: A.name, nameB: B.name, numA: A.num, numB: B.num, colorA: A.colors, colorB: B.colors,
            hint: A.mine || B.mine ? 'J JAB · L HAYMAKER · K BLOCK · SHIFT DODGE' : false,
          });
          fightShown = true;
        }
        fightView.update(fi, dt, events.filter((e) => evType(e) === 'fight'));
      } else if (fightShown) {
        fightView.hide();
        fightShown = false;
      }
    });

    if (ach) safe('achievements', () => ach.handle(events, state, { myId: ctx.myId, periods }));
    if (tutorial) safe('tutorial', () => {
      tutorial.setDevice(device);
      tutorial.update(playing && !menuOpen && !(replay && replay.isPlaying()) ? state : null, events, { ...ctx, periods }, dt);
    });
  };

  X.isOffline = () => !!local;
  X.replaying = () => !!replayView;
  return X;
}
