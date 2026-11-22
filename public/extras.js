// ICE RIOT - wires the optional feature modules into the client loop:
// settings, music, instant replay (+ picture-in-picture glass-smash replays), touch controls, chat,
// couch co-op, challenges, tutorial hints, leaderboard, offline practice, fight overlay.
//
// Every module is loaded independently; if one fails to load or throws, the game keeps running
// without it (errors go to the console). main.js calls the hooks below once per frame.

import { EVENT, PHASE, PHASE_DURATION, BTN, PSTATE, TEAMS, glassPanels } from '/shared/constants.js';
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
  const [mSettings, mMusic, mReplay, mTouch, mChat, mCouch, mAch, mTut, mLb, mLocal, mFight, mPip] = await Promise.all([
    load('./settings.js'), load('./music.js'), load('./replay.js'), load('./touch.js'),
    load('./chat.js'), load('./couch.js'), load('./achievements.js'), load('./tutorial.js'), load('./leaderboard.js'),
    load('./local.js'), load('./fight-view.js'), load('./glass-pip.js'),
  ]);

  const X = { ready: true };

  // ------------------------------------------------------------------ settings
  const settings = mSettings && safe('settings', () => mSettings.createSettings());
  let settingsPanel = null;
  if (settings) {
    // audio.js keeps its own volume/mute; mirror them into the settings store at boot.
    safe('settings sync', () => { settings.set('sfxVolume', audio.volume); settings.set('muted', audio.muted); });
    settingsPanel = safe('settings panel', () => mSettings.createSettingsPanel(document.body, settings, {
      onOpen: () => { input.setSuppressed(true); syncNameIn(); safe('settings sync', () => { settings.set('sfxVolume', audio.volume); settings.set('muted', audio.muted); }); },
      onClose: () => input.setSuppressed(false),
    }));
    input.setKeymap((code) => settings.keyFor(code));
    settings.subscribe((key, value, all) => {
      if (key === 'sfxVolume') audio.setVolume(value);
      else if (key === 'muted') { if (audio.muted !== !!value) audio.setMuted(!!value); ui.syncSound(); }
      else if (key === 'keys') input.clear();
      else if (key === 'name') nameFromSettings(value);
      applyVolumes(all);
    });
  }
  const S = (k, d) => (settings ? settings.get(k) : d);
  // Settings > Gameplay > Player name: applied once typing pauses (the lobby rail edits the same name).
  let nameTimer = 0;
  function nameFromSettings(value) {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => safe('settings name', () => {
      const n = String(value || '').trim().slice(0, 16);
      if (!n || n === (getNet().name || onlineNet.name)) return;
      ui.setName(n, { save: true }); // remembered like a rail rename (localStorage 'iceriot.name')
      const net = getNet();
      if (net.setName) net.setName(n);
      if (net !== onlineNet && onlineNet.setName) onlineNet.setName(n);
    }), 600);
  }
  // the live name (URL, rail edit, saved) is the source of truth; the sheet shows it when it opens
  const syncNameIn = () => { if (settings) safe('settings name', () => { const n = getNet().name || onlineNet.name || ''; if (n && settings.get('name') !== n) settings.set('name', n); }); };
  /** main.js: the global M key toggled the mute; keep the settings store in step. */
  X.syncMute = () => { if (settings) safe('settings sync', () => settings.set('muted', audio.muted)); };

  // ------------------------------------------------------------------ music
  let music = null;
  function applyVolumes(all = settings ? settings.all() : null) {
    if (!all) return;
    if (music) music.setVolume(all.muted ? 0 : all.musicVolume);
    if (tutorial) tutorial.setEnabled(!!all.showTutorial);
  }

  // ------------------------------------------------------------------ replay
  // seconds of play kept for replays, and of play before the goal a replay shows (the GOAL phase in
  // shared/constants.js is long enough for it; maxWallSec trims the run-up if it would overrun)
  const REPLAY_KEEP = 10, REPLAY_RUNUP = 6;
  let replayNames = {};
  const replay = mReplay && safe('replay', () => mReplay.createReplay({ seconds: REPLAY_KEEP, nameOf: (id, p) => (p && p.c && replayNames[p.c]) || null }));
  let goalAt = 0, prevB = 0, holdOff = false, replayView = null, replayCls = false;
  let replayCam = 'net';             // the slow-mo tail's camera for this playback: 'net' or 'puck'
  let replayGlass = null;            // { ms, x, z }: a glass break this playback features
  const replayCtx = { cam: 'cast', goal: null, glass: null };
  const glassCam = { x: 0, z: 0, w: 0 };
  // glass smashes in live play replay in a small screen in the corner (glass-pip.js)
  const pip = mReplay && mPip && safe('glass pip', () => mPip.createGlassPip({
    createReplay: mReplay.createReplay, SLOWMO_SPEED: mReplay.SLOWMO_SPEED, glassPanels, EVENT, PHASE,
  }));
  const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  /**
   * Plan a goal replay that fits `budget` wall seconds (the goal celebration plus the faceoff):
   * real speed up to the shot, then slow motion from just before the release until the puck hits the
   * twine (a beat past the goal). A glass break in the last few seconds stretches the window so it is
   * in the replay, playing the run-up faster when it has to.
   */
  function planReplay(budget) {
    const SLO = mReplay.SLOWMO_SPEED || 0.35, FIN = mReplay.FINISH_SPEED || 0.15;
    const g = replay.lastGoalMs();
    replayGlass = null;
    if (!Number.isFinite(g)) return { lengthSec: REPLAY_RUNUP, speed: 1, slowmoTailSec: 1.0, maxWallSec: budget };
    const post = 0.3;                                              // seconds of puck-in-the-net after the goal
    // slow motion from the windup (a beat before the release), then even slower (FIN) for the puck
    // going in: from FIN_IN before it crosses the line until it is in the twine
    const FIN_IN = 0.25, fin = FIN_IN + post;
    const shot = replay.findEventMs((e) => evType(e) === EVENT.SHOT, g - 1100, g);
    const pre = Number.isFinite(shot) ? Math.min(1.0, Math.max(0.55, (g - shot) / 1000 + 0.35)) : 0.8;
    let tail = pre + post, lengthSec = REPLAY_RUNUP + post, speed = 1;
    const tailWall = (t) => Math.max(0, t - fin) / SLO + Math.min(t, fin) / FIN;
    const gf = replay.findEvent((e) => evType(e) === EVENT.GLASS, g - (REPLAY_KEEP - 1.5) * 1000, g);
    if (gf) {
      const glass = gf.ms, pn = glassPanels()[gf.event.panel | 0];
      replayGlass = pn ? { ms: glass, x: pn.x, z: pn.z } : null;
      const need = (g - glass) / 1000 + post + 0.35;               // from just before the break
      // run-up speed that fits the break in; a shorter slow-mo first if it would pass 1.8x
      const speedFor = (t) => (need - t) / Math.max(0.5, budget - tailWall(t));
      if (speedFor(tail) > 1.8) tail = Math.min(tail, 0.35 + post);
      speed = Math.min(1.8, Math.max(1, speedFor(tail)));
      lengthSec = Math.max(lengthSec, need);
    }
    return { endMs: g + post * 1000, lengthSec, speed, slowmoTailSec: tail, finishSec: Math.min(fin, tail), finishSpeed: FIN, maxWallSec: budget };
  }

  // ------------------------------------------------------------------ touch
  const touch = mTouch && safe('touch', () => mTouch.createTouchControls(document.body, { autoTurbo: false }));
  let touchOn = !!(mTouch && safe('touch detect', () => mTouch.isTouchDevice()));
  // last input source (tutorial glyphs, fight hint, replay Skip glyph); a phone or tablet starts on touch
  let device = touchOn ? 'touch' : 'keyboard', wasPad = false;
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
    onlineNet.on('chat', (m) => {
      chat.receive(m);
      safe('chat unread', () => ui.noteChat && ui.noteChat(m)); // phone Chat tab's unread pill
    });
  }

  // ------------------------------------------------------------------ couch co-op
  const couch = mCouch && safe('couch', () => mCouch.createCouch({
    wsUrl: onlineNet.url, room: onlineNet.room, reservePads: 1,
    onChange: (list, err) => { if (err) ui.toast(err, 'warn'); },
  }));
  const noCouch = new Set();

  // ------------------------------------------------------------------ challenges, tutorial, leaderboard
  const ach = mAch && safe('achievements', () => mAch.createAchievements({
    container: document.body,
    onUnlock: (ch) => { audio.blip('start'); safe('unlock note', () => ui.noteUnlock && ui.noteUnlock(ch)); },
    onOpen: () => input.setSuppressed(true),
    onClose: () => input.setSuppressed(!!(chat && chat.isTyping())),
  }));
  if (ach) {
    const syncCount = () => safe('challenge count', () => {
      if (typeof ach.progress === 'function' && ui.setChallenges) ui.setChallenges(ach.progress());
    });
    syncCount();
    if (typeof ach.onProgress === 'function') safe('challenge progress', () => ach.onProgress(syncCount));
  }
  // The tutorial gets the RAW primary code (e.g. "Mouse0", "KeyJ") so it can draw a mouse glyph.
  const tutorial = mTut && safe('tutorial', () => mTut.createTutorial({
    container: uiRoot,
    keyLabel: settings ? (button) => {
      if (button === 'move') return null;
      const codes = settings.get('keys')[button];
      return codes && codes[0] ? codes[0] : null;
    } : null,
  }));
  let leaderboard = null;
  const getLeaderboard = () => {
    if (!mLb) return null;
    leaderboard ||= safe('leaderboard', () => mLb.createLeaderboard(document.body, {
      me: () => getNet().name || onlineNet.name,
      meTeam: () => { const L = getNet().lobby; const me = L && (L.clients || []).find((c) => c.id === getNet().myId); return me && (me.team === 0 || me.team === 1) && L.config && L.config.teams ? L.config.teams[me.team] : null; },
    }));
    return leaderboard;
  };
  applyVolumes();
  syncNameIn();

  /** Fight hint from the player's current primary bindings, e.g. "Left click jab · L haymaker · Right click block · L-Shift dodge". */
  function fightHint() {
    const label = (mSettings && mSettings.keyLabel) || ((c) => String(c || '').replace(/^Key/, ''));
    const keys = settings ? settings.get('keys') : { shoot: ['Mouse0'], action: ['KeyL'], pass: ['Mouse2'], turbo: ['ShiftLeft'] };
    const k = (a) => { const c = keys[a] && keys[a][0]; return c ? safe('key label', () => label(c)) || c : 'Unbound'; };
    return `${k('shoot')} jab · ${k('action')} haymaker · ${k('pass')} block · ${k('turbo')} dodge`;
  }
  /** The primary shoot binding as shown to the player ("Left click", "J"), for the replay's Skip glyph. */
  function shootLabel() {
    const label = (mSettings && mSettings.keyLabel) || ((c) => String(c || '').replace(/^Key/, ''));
    const keys = settings ? settings.get('keys') : null;
    const c = keys && keys.shoot && keys.shoot[0] ? keys.shoot[0] : 'Mouse0';
    return safe('key label', () => label(c)) || c;
  }

  // ------------------------------------------------------------------ fight overlay (state.fi from the sim)
  let fightView = null, fightShown = false, fightHost = null;
  if (mFight) {
    const host = fightHost = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:35';
    document.body.appendChild(host);
    fightView = safe('fight view', () => mFight.createFightView(host));
  }
  function fighterInfo(state, id, names) {
    const p = state.p && state.p[id];
    const ti = (state.teams || [0, 1])[p && (p.tm === 0 || p.tm === 1) ? p.tm : id < 4 ? 0 : 1];
    const team = TEAMS[ti] || TEAMS[0];
    const ros = team.skaters[id % 4] || team.goalie;
    const mine = !!(p && p.c && p.c === lastMyId);
    const ctrl = mine ? 'You' : p && p.c ? (names[p.c] || 'Player') : 'AI';
    return { name: ros.name, ctrl, team: ti, num: p ? p.n : ros.num, colors: team.colors, mine };
  }

  // ------------------------------------------------------------------ offline practice
  let local = null, failedTries = 0, lastRetryAt = 0, autoOfflineDone = false, reachableToast = false;
  async function enterOffline(auto) {
    if (local || !mLocal) { if (!mLocal) ui.toast('Offline practice is unavailable', 'error'); return; }
    try {
      const L = onlineNet.lobby;
      const session = await mLocal.createLocalSession({ name: onlineNet.name, team: 0, config: (L && L.config) || {} });
      local = session.asNet();
      local.on('err', (m) => ui.toast(m.msg || 'Something went wrong', 'error'));
      setNet(local);
      reachableToast = false;
      safe('offline ui', () => ui.setOffline && ui.setOffline(true));
      ui.toast(auto ? "Can't reach the server, so you're in offline practice against the AI" : "Offline practice against the AI. You're the host", 'info');
    } catch (e) {
      console.error(e);
      ui.toast(`Offline practice is unavailable: ${e.message || e}`, 'error');
    }
  }
  function leaveOffline() {
    if (!local) return;
    safe('offline dispose', () => local.dispose());
    local = null;
    setNet(onlineNet);
    safe('offline ui', () => ui.setOffline && ui.setOffline(false));
    onlineNet.reconnectNow();
    ui.toast(onlineNet.connected() ? 'Back online' : 'Reconnecting to the server', onlineNet.connected() ? 'good' : 'info');
  }
  onlineNet.on('lobby', (m) => {
    if (local && m && !reachableToast) { reachableToast = true; ui.toast('The server is reachable again. Press Go online to rejoin', 'info'); }
  });

  // ------------------------------------------------------------------ lobby views (contract: ui calls handlers.view(name, el))
  X.lobbyView = (name, el) => {
    if (!el) return;
    if (name === 'leaderboard') {
      const lb = getLeaderboard();
      if (lb && typeof lb.mount === 'function') safe('leaderboard view', () => lb.mount(el));
      else if (!lb) el.textContent = '';
    } else if (name === 'challenges') {
      if (ach && typeof ach.mountView === 'function') safe('challenges view', () => ach.mountView(el));
    }
  };
  /** True while a sheet that owns Esc is open (settings, challenges, leaderboard). */
  X.sheetOpen = () => !!(
    (settingsPanel && typeof settingsPanel.isOpen === 'function' && safe('settings open', () => settingsPanel.isOpen()))
    || (ach && typeof ach.isPanelOpen === 'function' && safe('challenges open', () => ach.isPanelOpen()))
    || (leaderboard && leaderboard.isOpen));

  // ------------------------------------------------------------------ UI buttons
  X.extra = (name) => {
    switch (name) {
      case 'settings': if (settingsPanel) settingsPanel.open(); else ui.toast('Settings are unavailable', 'warn'); break;
      case 'controls': if (settingsPanel) settingsPanel.open('controls'); else ui.toast('Settings are unavailable', 'warn'); break;
      case 'challenges':
        if (ui.screen === 'lobby' && ui.showView) ui.showView('challenges');
        else if (ach) ach.openPanel();
        else ui.toast('Challenges are unavailable', 'warn');
        break;
      case 'leaderboard': {
        if (ui.screen === 'lobby' && ui.showView) { ui.showView('leaderboard'); break; }
        const lb = getLeaderboard();
        if (!lb) { ui.toast('The leaderboard is unavailable', 'warn'); break; }
        if (local) { ui.toast('The leaderboard lives on the server. Go online to see it', 'info'); break; }
        lb.open();
        break;
      }
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
        touch.setContext({ hasPuck: !!me && !!lastState.k && lastState.k.o === me.id, fight: !!(lastState && lastState.fi) });
        touch.setCharge(me && me.s === PSTATE.CHARGE ? me.ch : 0);
        if (touch.setTurbo) touch.setTurbo(me && typeof me.tb === 'number' ? me.tb : -1);
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
    if (pip) safe('glass pip', () => pip.record(live, events, now));
    if (!replay) return { state: live, events, dt };
    return safe('replay', () => {
      replay.record(live, events, now);
      for (const e of events) if (evType(e) === EVENT.GOAL && !e.replay) goalAt = now;
      if (goalAt && now - goalAt >= 800) {
        goalAt = 0;
        const budget = live && live.ph === PHASE.GOAL ? live.phT + PHASE_DURATION.FACEOFF - 0.4 : Infinity;
        if (replay.setSkipHint) replay.setSkipHint({ device: touchOn && device === 'touch' ? 'touch' : device, label: shootLabel() });
        // the slow-mo tail is shot from inside the net, or from behind the puck (Settings > Video)
        replayCam = S('puckCam', false) ? 'puck' : 'net';
        replay.start({ ...planReplay(budget), tailLabel: replayCam === 'puck' ? 'Puck cam' : 'Goal cam' });
      }
      if (replay.isPlaying() && (!live || live.ph === PHASE.PLAY)) replay.stop();
      const r = replay.update(dt);
      replayView = r;
      // the replay owns the screen: style.css hides the in-game chat chip/feed and the touch turbo bar
      if (!!r !== replayCls) { replayCls = !!r; document.documentElement.classList.toggle('ir-replaying', replayCls); }
      return r ? { state: r.state, events: r.events, dt: dt * (r.rate || 1) } : { state: live, events, dt };
    }) || { state: live, events, dt };
  };

  /** After the main frame is drawn: the glass-smash picture-in-picture (stopped by a goal replay). */
  X.afterRender = (mainRenderer, dt) => {
    if (!pip) return;
    safe('glass pip', () => pip.frame(mainRenderer, dt, {
      suppress: !!(replay && replay.isPlaying()),
      myId: lastMyId, names: replayNames,
    }));
  };

  /** Extra renderer ctx fields. */
  X.decorateCtx = (ctx) => {
    if (couch) ctx.couchIds = safe('couch ids', () => couch.clientIds()) || noCouch;
    // replay camera: the broadcast view for the run-up, the goal cam / puck cam for the slow-mo tail
    if (replayView) {
      replayCtx.cam = replayView.tail && replayView.goal ? replayCam : 'cast';
      replayCtx.goal = replayView.goal || null;
      // a featured glass break: framed from just before it shatters, held, then back to the puck
      replayCtx.glass = null;
      if (replayGlass && replayCtx.cam === 'cast') {
        const d = replayView.ms - replayGlass.ms;
        glassCam.w = sstep(-700, -400, d) * (1 - sstep(800, 1250, d));
        if (glassCam.w > 0) { glassCam.x = replayGlass.x; glassCam.z = replayGlass.z; replayCtx.glass = glassCam; }
      }
      ctx.replay = replayCtx;
    }
    if (settings) {
      if (!settings.get('showNames')) ctx.showNames = false; // renderer hides all name tags
      ctx.video = { quality: settings.get('quality'), cameraShake: settings.get('cameraShake'), reduceFlashes: settings.get('reduceFlashes') };
    }
    return ctx;
  };

  /** Everything that reacts to the LIVE game: music, fight overlay, challenges, tutorial, chat mode. */
  X.after = ({ state, events, ctx, dt, lobby, inGame, playing, menuOpen, myTeam }) => {
    lastState = state; lastMyId = ctx.myId; replayNames = ctx.names || replayNames;
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
      // the pause menu (and the "turn your phone sideways" prompt) sit above the scrap
      const hideFight = !!menuOpen;
      if (fightHost && fightHost._hidden !== hideFight) { fightHost._hidden = hideFight; fightHost.style.visibility = hideFight ? 'hidden' : ''; }
      if (fi) {
        if (!fightShown) {
          const A = fighterInfo(state, fi.a, ctx.names), B = fighterInfo(state, fi.b, ctx.names);
          fightView.show(fi, {
            nameA: A.name, nameB: B.name, numA: A.num, numB: B.num, colorA: A.colors, colorB: B.colors,
            ctrlA: A.ctrl, ctrlB: B.ctrl, teamA: A.team, teamB: B.team,
            shake: S('cameraShake', 1), flashes: !S('reduceFlashes', false),
            // touch players already see Jab / Block / Haymaker / Dodge on the buttons
            hint: (A.mine || B.mine) && !(touchOn && device === 'touch') ? fightHint() : false,
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
