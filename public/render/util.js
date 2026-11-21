// ICE RIOT renderer - geometry helpers (build-time only; nothing here runs per frame).
import * as THREE from 'three';
import { RINK } from '/shared/constants.js';

const _col = new THREE.Color();

/** sRGB hex -> linear [r,g,b] */
export function lin(hex, out = [0, 0, 0]) {
  _col.setHex(hex);
  out[0] = _col.r; out[1] = _col.g; out[2] = _col.b;
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Accumulates flat-shaded chunky pieces into one non-indexed geometry with
 * position / normal / uv / color / slot attributes.
 * slot: 0 = fixed vertex color, 1 = team primary, 2 = secondary, 3 = accent, 4 = skin (color * skin tone).
 */
export class PartBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.slot = []; }

  _tri(a, b, c, slot, rgb, center) {
    // orient so the normal points away from `center`
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    nx /= len; ny /= len; nz /= len;
    if (center) {
      const mx = (a[0] + b[0] + c[0]) / 3 - center[0], my = (a[1] + b[1] + c[1]) / 3 - center[1], mz = (a[2] + b[2] + c[2]) / 3 - center[2];
      if (mx * nx + my * ny + mz * nz < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    }
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.uv.push(0, 0);
      this.col.push(rgb[0], rgb[1], rgb[2]);
      this.slot.push(slot);
    }
  }

  /** 8 corners: bottom ring b0..b3 then top ring t0..t3 (same winding). skip = set of face names to omit */
  hexa(c, slot, hex = 0xffffff, skip = null) {
    const rgb = lin(hex);
    const center = [0, 0, 0];
    for (const p of c) { center[0] += p[0] / 8; center[1] += p[1] / 8; center[2] += p[2] / 8; }
    const faces = {
      bottom: [0, 1, 2, 3], top: [4, 5, 6, 7],
      s0: [0, 1, 5, 4], s1: [1, 2, 6, 5], s2: [2, 3, 7, 6], s3: [3, 0, 4, 7],
    };
    for (const k in faces) {
      if (skip && skip.includes(k)) continue;
      const f = faces[k];
      this._tri(c[f[0]], c[f[1]], c[f[2]], slot, rgb, center);
      this._tri(c[f[0]], c[f[2]], c[f[3]], slot, rgb, center);
    }
    return this;
  }

  /** Tapered box: bottom rect [bx0,bx1]x[bz0,bz1] at y0, top rect [tx0,tx1]x[tz0,tz1] at y1. */
  taper(bx0, bx1, bz0, bz1, y0, tx0, tx1, tz0, tz1, y1, slot, hex) {
    return this.hexa([
      [bx0, y0, bz0], [bx1, y0, bz0], [bx1, y0, bz1], [bx0, y0, bz1],
      [tx0, y1, tz0], [tx1, y1, tz0], [tx1, y1, tz1], [tx0, y1, tz1],
    ], slot, hex);
  }

  box(x0, x1, y0, y1, z0, z1, slot, hex) {
    return this.taper(x0, x1, z0, z1, y0, x0, x1, z0, z1, y1, slot, hex);
  }

  /** Band slice of a taper box between heights ya..yb, inflated by `inf`. */
  band(bx0, bx1, bz0, bz1, y0, tx0, tx1, tz0, tz1, y1, ya, yb, inf, slot, hex) {
    const f = (y) => (y - y0) / (y1 - y0);
    const L = (a, b, t) => a + (b - a) * t;
    const ta = f(ya), tb = f(yb);
    return this.taper(
      L(bx0, tx0, ta) - inf, L(bx1, tx1, ta) + inf, L(bz0, tz0, ta) - inf, L(bz1, tz1, ta) + inf, ya,
      L(bx0, tx0, tb) - inf, L(bx1, tx1, tb) + inf, L(bz0, tz0, tb) - inf, L(bz1, tz1, tb) + inf, yb, slot, hex);
  }

  /** Append a three.js geometry (indexed or not) transformed by matrix. */
  geom(g, matrix, slot, hex = 0xffffff) {
    const rgb = lin(hex);
    const src = g.index ? g.toNonIndexed() : g;
    if (matrix) src.applyMatrix4(matrix);
    const p = src.attributes.position.array;
    const n = src.attributes.normal ? src.attributes.normal.array : null;
    for (let i = 0; i < p.length / 3; i++) {
      this.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      if (n) this.nrm.push(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]); else this.nrm.push(0, 1, 0);
      this.uv.push(0, 0);
      this.col.push(rgb[0], rgb[1], rgb[2]);
      this.slot.push(slot);
    }
    if (src !== g) src.dispose();
    g.dispose();
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('slot', new THREE.Float32BufferAttribute(this.slot, 1));
    g.computeBoundingSphere();
    return g;
  }
}

export function mat(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return m;
}

/**
 * Rounded-rectangle rink outline offset outward by `off` meters.
 * Path starts at the far (-Z) straight at -X and runs +X first (same order as glassPanels()).
 * at(s) -> {x, z, nx, nz} with (nx, nz) the OUTWARD unit normal; s = arclength along this offset path.
 */
export function outline(off = 0) {
  const L = RINK.halfLength, W = RINK.halfWidth, R = RINK.cornerRadius;
  const sx = L - R, sz = W - R, r = R + off;
  const H = Math.PI / 2;
  const segs = [
    { line: true, x0: -sx, z0: -(W + off), x1: sx, z1: -(W + off), nx: 0, nz: -1 },
    { cx: sx, cz: -sz, a0: -H },
    { line: true, x0: L + off, z0: -sz, x1: L + off, z1: sz, nx: 1, nz: 0 },
    { cx: sx, cz: sz, a0: 0 },
    { line: true, x0: sx, z0: W + off, x1: -sx, z1: W + off, nx: 0, nz: 1 },
    { cx: -sx, cz: sz, a0: H },
    { line: true, x0: -(L + off), z0: sz, x1: -(L + off), z1: -sz, nx: -1, nz: 0 },
    { cx: -sx, cz: -sz, a0: 2 * H },
  ];
  let total = 0;
  for (const s of segs) {
    s.len = s.line ? Math.hypot(s.x1 - s.x0, s.z1 - s.z0) : r * H;
    s.s0 = total; total += s.len;
  }
  const out = { x: 0, z: 0, nx: 0, nz: 0 };
  function at(s) {
    s = ((s % total) + total) % total;
    let seg = segs[segs.length - 1];
    for (const g of segs) { if (s < g.s0 + g.len) { seg = g; break; } }
    const t = (s - seg.s0) / seg.len;
    if (seg.line) {
      out.x = seg.x0 + (seg.x1 - seg.x0) * t; out.z = seg.z0 + (seg.z1 - seg.z0) * t;
      out.nx = seg.nx; out.nz = seg.nz;
    } else {
      const a = seg.a0 + H * t;
      out.nx = Math.cos(a); out.nz = Math.sin(a);
      out.x = seg.cx + out.nx * r; out.z = seg.cz + out.nz * r;
    }
    return out;
  }
  /** Sample points: straights get endpoints only, arcs get `arcSegs` pieces. Returns [{s, x, z, nx, nz}] (closed: last == first). */
  function samples(arcSegs = 16) {
    const pts = [];
    for (const g of segs) {
      const n = g.line ? 1 : arcSegs;
      for (let k = 0; k < n; k++) {
        const s = g.s0 + g.len * (k / n);
        const p = at(s);
        pts.push({ s, x: p.x, z: p.z, nx: p.nx, nz: p.nz });
      }
    }
    const p0 = pts[0];
    pts.push({ s: total, x: p0.x, z: p0.z, nx: p0.nx, nz: p0.nz });
    return pts;
  }
  return { total, at, samples };
}

/**
 * Sweep a straight cross-section band around the rink outline.
 * Band goes from (off0, y0) to (off1, y1) where off = outward offset from the board line.
 * normalOut/normalUp: desired facing of the band in (outward, up) components (winding is fixed to match).
 * uvMode: function(sBase, k) -> [u, v] with k in {0,1} (band edge), sBase = arclength on the base (off=0) path.
 */
export function sweepBand(off0, y0, off1, y1, normalOut, normalUp, arcSegs, uvFn, colorHex) {
  const base = outline(0);
  const pts = base.samples(arcSegs);
  const pos = [], nrm = [], uv = [], col = [], idx = [];
  const rgb = lin(colorHex ?? 0xffffff);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    for (let k = 0; k < 2; k++) {
      const off = k ? off1 : off0, y = k ? y1 : y0;
      pos.push(p.x + p.nx * off, y, p.z + p.nz * off);
      let nx = p.nx * normalOut, ny = normalUp, nz = p.nz * normalOut;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l, ny / l, nz / l);
      const t = uvFn ? uvFn(p.s, k) : [p.s, k];
      uv.push(t[0], t[1]);
      col.push(rgb[0], rgb[1], rgb[2]);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    // check winding vs desired normal for this quad
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dot = nx * nrm[a * 3] + ny * nrm[a * 3 + 1] + nz * nrm[a * 3 + 2];
    if (dot >= 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Merge indexed/non-indexed geometries that share the same attribute set (position, normal, uv, color optional). */
export function mergeGeometries(list) {
  const names = ['position', 'normal', 'uv', 'color'];
  const sizes = { position: 3, normal: 3, uv: 2, color: 3 };
  const data = { position: [], normal: [], uv: [], color: [] };
  const idx = [];
  let base = 0;
  for (const g0 of list) {
    const g = g0;
    const n = g.attributes.position.count;
    for (const nm of names) {
      const a = g.attributes[nm];
      const arr = data[nm];
      if (a) { for (let i = 0; i < n * sizes[nm]; i++) arr.push(a.array[i]); }
      else { for (let i = 0; i < n * sizes[nm]; i++) arr.push(nm === 'color' ? 1 : 0); }
    }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + base); }
    else { for (let i = 0; i < n; i++) idx.push(i + base); }
    base += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  for (const nm of names) out.setAttribute(nm, new THREE.Float32BufferAttribute(data[nm], sizes[nm]));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
