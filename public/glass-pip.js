// ICE RIOT - picture-in-picture replays of glass smashes.
//
// When a pane of glass shatters in live play, a small screen in the corner replays it a moment later
// while the game goes on: the run-up at full speed, then slow motion from just before the hit, shot
// from the ice a few metres off the broken pane (the camera rig's 'glass' replay shot). It plays in an
// inset renderer (render/renderer.js inset mode: a second scene drawn into a corner of the main
// canvas through the same WebGL context) from its own replay recording (replay.js, no overlay).
//
//   const pip = createGlassPip({ createReplay, SLOWMO_SPEED, glassPanels, EVENT, PHASE });
//   pip.record(liveState, liveEvents, nowMs);     // every frame (what the main replay records too)
//   pip.frame(mainRenderer, dt, { suppress, myId, names });   // after mainRenderer.render()
//   pip.stop(); pip.dispose();
//
// It stays out of the way: nothing is built until a game is live (the inset scene is made during a
// faceoff, when play is frozen, and its shaders compiled then), nothing is drawn unless a smash is
// replaying, and a goal replay (suppress) stops it. Desktop: bottom-right; touch screens: top-right
// (the touch controls own the bottom of the screen).

const STYLE_ID = 'ir-pip-style';
const CSS = `
.ir-pip{position:fixed;z-index:25;pointer-events:none;box-sizing:border-box;border:2px solid var(--ink,#E8EDF5);
border-radius:10px;box-shadow:0 0 0 1px rgba(10,15,28,.7),0 10px 28px rgba(0,0,0,.45);opacity:0;transform:scale(.96);
transition:opacity .16s ease-out,transform .16s ease-out}
.ir-pip.ir-pip-on{opacity:1;transform:none}
.ir-pip-tag{position:absolute;left:8px;top:8px;display:flex;align-items:center;gap:6px;height:22px;padding:0 8px;
border-radius:6px;background:var(--ground,#0A0F1C);color:var(--ink,#E8EDF5);font:600 11px/1 var(--f-ui,Bahnschrift,"Segoe UI",sans-serif);
letter-spacing:.06em;text-transform:uppercase}
.ir-pip-dot{width:7px;height:7px;border-radius:50%;background:var(--goal,#FF4B3E)}
.ir-pip-slo{color:var(--turbo,#7CC4FF);display:none}
.ir-pip-is-slow .ir-pip-slo{display:inline}
html.ir-replaying .ir-pip{display:none}
`;

export function createGlassPip({ createReplay, SLOWMO_SPEED = 0.35, glassPanels, EVENT, PHASE }) {
  const rec = createReplay({ seconds: 6, container: null });
  let pipR = null, building = false, failed = false, mainGL = null;
  let pending = null;          // { at: record ms of the smash, panel }
  let playing = false, teamsKey = '';
  let frameEl = null, tagEl = null;
  const glass = { x: 0, z: 0, w: 1 };
  const ctx = {
    myId: 0, names: {}, showNames: false,
    replay: { cam: 'glass', goal: null, glass },
    video: { quality: 'low', cameraShake: 0.5, reduceFlashes: false },
  };
  let lastLive = null;

  function ensureDom() {
    if (frameEl || typeof document === 'undefined') return;
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID; st.textContent = CSS;
      document.head.appendChild(st);
    }
    frameEl = document.createElement('div');
    frameEl.className = 'ir-pip';
    tagEl = document.createElement('div');
    tagEl.className = 'ir-pip-tag';
    tagEl.innerHTML = '<span class="ir-pip-dot"></span><span>Glass smash</span><span class="ir-pip-slo">' +
      `${Math.round(SLOWMO_SPEED * 100) / 100}×</span>`;
    frameEl.appendChild(tagEl);
    document.body.appendChild(frameEl);
  }

  // corner rect (CSS px): ~26% of the width, 16:9
  function layout() {
    const W = innerWidth, H = innerHeight;
    const touch = document.documentElement.classList.contains('ir-touch-on');
    const w = Math.round(Math.min(420, Math.max(200, W * 0.26))), h = Math.round(w * 9 / 16);
    const m = W < 700 ? 10 : 20;
    const top = touch ? Math.min(H - h - m, 64) : H - h - m;          // from the top of the window
    const left = W - w - m;
    if (frameEl) {
      frameEl.style.left = left + 'px'; frameEl.style.top = top + 'px';
      frameEl.style.width = w + 'px'; frameEl.style.height = h + 'px';
    }
    return { x: left, y: H - top - h, w, h };                          // renderer inset: bottom-left origin
  }

  async function build(main) {
    building = true;
    try {
      const mod = await import('./render/renderer.js');
      pipR = mod.createRenderer(null, { shareWith: main.three.renderer, dynamicResolution: false });
      pipR.setInset({ x: 0, y: 0, w: 320, h: 180 });
      if (lastLive) { pipR.setTeams(lastLive.teams || [0, 1]); teamsKey = String(lastLive.teams || ''); pipR.update(lastLive, 0, [], ctx); }
      pipR.warm();
      pipR.update(null, 0, [], ctx);       // idle (attract): the next replay cuts straight to its shot
    } catch (e) {
      failed = true; pipR = null;
      console.warn('[ICE RIOT] glass replay picture-in-picture off:', e);
    }
    building = false;
  }

  function show(on) {
    ensureDom();
    if (frameEl) frameEl.classList.toggle('ir-pip-on', on);
  }

  function stop() {
    if (playing) { rec.stop(); playing = false; show(false); if (pipR) pipR.update(null, 0, [], ctx); }
    pending = null;
  }

  function dropInset() {
    stop();
    if (pipR) { try { pipR.dispose(); } catch { /* ignore */ } }
    pipR = null; mainGL = null; teamsKey = '';
  }

  return {
    /** Record the live frame; notice a live glass smash. */
    record(live, events, now) {
      lastLive = live || null;
      if (!live) { if (playing || pending) stop(); return; }
      rec.record(live, events, now);
      if (events) for (const e of events) {
        if (e && e.type === EVENT.GLASS && !e.replay && live.ph === PHASE.PLAY) pending = { at: now, panel: e.panel | 0 };
      }
      // a moment after the smash (the shards flying), start its replay; a newer smash replaces it
      if (pending && now - pending.at >= 1100 && pipR) {
        const pn = glassPanels()[pending.panel];
        const at = pending.at;
        pending = null;
        if (!pn) return;
        glass.x = pn.x; glass.z = pn.z; glass.w = 1;
        const wall = rec.start({ endMs: at + 1000, lengthSec: 2.4, speed: 1, slowmoTailSec: 1.2, maxWallSec: 6, caption: false });
        playing = wall > 0;
      }
    },
    /** After the main frame: build the inset when it's time, draw the replay while one plays. */
    frame(main, dt, { suppress = false, myId = 0, names = null } = {}) {
      if (!main || !main.three || failed) return;
      if (mainGL && mainGL !== main.three.renderer) dropInset();   // a new main renderer: rebuild on it
      mainGL = main.three.renderer;
      // build during a faceoff (play is frozen, so a hitch goes unnoticed)
      if (!pipR && !building && lastLive && lastLive.ph === PHASE.FACEOFF) build(main);
      if (suppress && (playing || pending)) stop();
      if (!playing || !pipR) return;
      const r = rec.update(dt);
      if (!r) { stop(); return; }
      ctx.myId = myId; ctx.names = names || ctx.names;
      const tk = String(r.state.teams || '');
      if (tk !== teamsKey) { teamsKey = tk; pipR.setTeams(r.state.teams || [0, 1]); }
      pipR.setInset(layout());
      pipR.update(r.state, dt * (r.rate || 1), r.events, ctx);
      pipR.render();
      show(true);
      if (frameEl) frameEl.classList.toggle('ir-pip-is-slow', !!r.slowmo);
    },
    stop,
    get playing() { return playing; },
    dispose() {
      dropInset();
      if (frameEl && frameEl.parentNode) frameEl.parentNode.removeChild(frameEl);
      frameEl = null; tagEl = null;
      rec.dispose();
    },
  };
}
