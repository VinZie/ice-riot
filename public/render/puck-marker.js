// ICE RIOT renderer - puck indicator. The play camera follows your own skater instead of the puck,
// so the puck gets a marker drawn over the frame:
//   on screen:  a small chevron floating just above the puck, pointing down at it (hidden while the
//               skater the camera follows is carrying it)
//   off screen: an arrow pinned to the edge of the screen, pointing toward the puck
// White with a dark outline so it reads on the white ice, the boards and the crowd alike.
//
//   const marker = createPuckMarker();
//   marker.update(dt, on, x, y, z, carried);   // every frame: puck world position, whether to show it
//   marker.render(renderer, camera);           // after the main render (one extra pass, skipped when hidden)
//
// Like render/head-tags.js it draws in its own orthographic scene whose units are drawing-buffer pixels,
// projected with the camera the frame was just drawn with, so it never lags the puck.
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// sizes in CSS px at 1x (scaled like the head plates: viewport height / 900, 0.85..1.5, x pixel ratio)
const EDGE = 34;            // off-screen arrows sit this far inside the viewport edge
const LIFT = 26;            // on-screen chevron: tip this far above the puck
const ON_SCALE = 0.75, OFF_SCALE = 1.15;

export function createPuckMarker() {
  const scene = new THREE.Scene();
  scene.name = 'puck-marker';
  const cam = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
  // arrowhead pointing +X, tip at the origin (so rotating it aims the tip; scaling keeps the tip put)
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(-17, 9); shape.lineTo(-12, 0); shape.lineTo(-17, -9); shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  const mat = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const fillMat = mat(0xffffff), lineMat = mat(0x0a0f1c);
  const group = new THREE.Group();
  const outline = new THREE.Mesh(geo, lineMat);
  outline.scale.set(1.32, 1.42, 1); outline.position.x = 2.2; outline.renderOrder = 0;
  const fill = new THREE.Mesh(geo, fillMat); fill.renderOrder = 1;
  group.add(outline, fill);
  scene.add(group);

  const _v = new THREE.Vector3(), _size = new THREE.Vector2(), _buf = new THREE.Vector2();
  const pos = new THREE.Vector3();
  let want = false, carried = false, a = 0, time = 0, passes = 0;

  function update(dt, on, x, y, z, isCarried) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
    time += dt;
    want = !!on && Number.isFinite(x) && Number.isFinite(z);
    carried = !!isCarried;
    if (want) pos.set(x, Math.max(0, Number.isFinite(y) ? y : 0) + 0.04, z);
    a = clamp(a + (want && !carried ? 1 : -1) * dt * 8, 0, 1);
  }

  /** Call right after renderer.render(scene, camera). */
  function render(renderer, camera) {
    if (a <= 0) return;
    renderer.getSize(_size);
    renderer.getDrawingBufferSize(_buf);
    const W = _buf.x, H = _buf.y;
    if (!(W > 0 && H > 0 && _size.y > 0)) return;
    const K = clamp(_size.y / 900, 0.85, 1.5) * (H / _size.y);
    if (cam.right !== W || cam.bottom !== -H) { cam.left = 0; cam.right = W; cam.top = 0; cam.bottom = -H; cam.updateProjectionMatrix(); }

    _v.copy(pos).project(camera);
    const behind = _v.z > 1 || _v.z < -1;
    let nx = _v.x, ny = _v.y;
    if (behind) { nx = -nx; ny = -ny; }        // behind the lens: the direction flips
    const sx = (nx + 1) * 0.5 * W, sy = (1 - ny) * 0.5 * H;   // screen px, y down
    const m = EDGE * K;
    const onScreen = !behind && sx >= m * 0.5 && sx <= W - m * 0.5 && sy >= m * 0.5 && sy <= H - m * 0.5;
    let px, py, ang, s;
    if (onScreen) {
      // chevron above the puck, pointing down at it, bobbing a little
      const bob = Math.sin(time * 6) * 3 * K;
      px = sx; py = sy - (LIFT * K + bob);
      ang = -Math.PI / 2;                      // pointing down the screen (ortho y is up)
      s = ON_SCALE * K;
    } else {
      // edge arrow: from the screen centre toward the puck, clamped to an inset rectangle
      const cx = W / 2, cy = H / 2;
      let dx = sx - cx, dy = sy - cy;
      if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = 1;
      const hx = cx - m, hy = cy - m;
      const t = Math.min(hx / Math.max(1e-6, Math.abs(dx)), hy / Math.max(1e-6, Math.abs(dy)));
      px = cx + dx * t; py = cy + dy * t;
      ang = Math.atan2(-dy, dx);
      s = OFF_SCALE * K * (1 + Math.sin(time * 7) * 0.06);
    }
    group.position.set(Math.round(px), -Math.round(py), 0);
    group.rotation.z = ang;
    group.scale.set(s, s, 1);
    fillMat.opacity = a;
    lineMat.opacity = a * 0.85;

    const ac = renderer.autoClear, ar = renderer.info.autoReset;
    renderer.autoClear = false;                // draw over the frame
    renderer.info.autoReset = false;           // count into the frame's draw stats
    renderer.render(scene, cam);
    renderer.autoClear = ac;
    renderer.info.autoReset = ar;
    passes++;
  }

  function dispose() { geo.dispose(); fillMat.dispose(); lineMat.dispose(); }

  return { update, render, dispose, get visible() { return a > 0; }, stats: () => ({ passes }) };
}
