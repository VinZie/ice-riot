// Spring-bone hair for the ICE RIOT player model.
//
// Drives the hair_<lock>_<n> bone chains of hockey_player_game.glb with a position-based spring
// simulation in world space: each bone's tail keeps its momentum (so the hair lags and swings when
// the head moves, turns or gets hit), is pulled back toward the styled rest shape (stiffness), sags
// under gravity, is pushed by wind and by the air the player skates through, and is kept outside
// sphere colliders on the helmet, ear guards, neck and upper back.
//
//   import { HairPhysics } from './hair-physics.js';
//   const hair = await HairPhysics.load(model, 'hockey_player_game.physics.json');  // model in its bind pose
//   // every frame, after the animation mixer and any root movement:
//   model.updateMatrixWorld(true);
//   hair.update(dt, { wind: new THREE.Vector3(1.5, 0, 0) });
//   hair.reset();   // after teleporting the model
import * as THREE from 'three';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export class HairPhysics {
  static async load(model, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`hair physics data: HTTP ${res.status}`);
    return new HairPhysics(model, await res.json());
  }

  constructor(model, data) {
    this.model = model;
    this.params = { stiffness: 0.9, drag: 0.05, gravity: 1.2, air: 0.22, hairRadius: 0.004, substep: 1 / 120, ...data.params };
    this.enabled = true;
    this._acc = 0;
    const bones = {};
    let skeleton = null;
    model.traverse((o) => {
      if (o.isBone) bones[o.name] = o;
      if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton;
    });
    // Work in the bind (rest) pose, where the data's rest positions apply.
    if (skeleton) skeleton.pose();
    model.updateMatrixWorld(true);
    // The data is in the build's Z-up world; find how it maps onto this scene.
    const first = bones[data.chains[0].bones[0]];
    const actual = first.getWorldPosition(new THREE.Vector3());
    const candidates = [([x, y, z]) => new THREE.Vector3(x, z, -y), ([x, y, z]) => new THREE.Vector3(x, y, z)];
    const toScene = candidates.reduce((best, f) => (f(data.chains[0].joints[0]).distanceTo(actual) < best(data.chains[0].joints[0]).distanceTo(actual) ? f : best));
    this.mappingError = toScene(data.chains[0].joints[0]).distanceTo(actual);

    this.chains = data.chains.map((c) => c.bones.map((name, j) => {
      const bone = bones[name];
      if (!bone) throw new Error(`hair bone ${name} not in the model`);
      const tail = toScene(c.joints[j + 1]);
      const head = bone.getWorldPosition(new THREE.Vector3());
      const local = bone.worldToLocal(tail.clone());
      return { bone, q0: bone.quaternion.clone(), axis: local.normalize(), len: head.distanceTo(tail), cur: tail.clone(), prev: tail.clone(), restLocal: bone.worldToLocal(tail.clone()) };
    }));
    // Each chain's rest tip in the head's frame (the styled shape rides the head rigidly).
    this.restTips = data.chains.map((c) => bones.head.worldToLocal(toScene(c.joints[c.joints.length - 1])));
    this.colliders = data.colliders.map((c) => {
      const bone = bones[c.bone];
      return { bone, local: bone.worldToLocal(toScene(c.center)), radius: c.radius, world: new THREE.Vector3() };
    });
    this.head = bones.head;
    this._headPrev = null;
    this.headVelocity = new THREE.Vector3();
    this.boneCount = this.chains.reduce((n, c) => n + c.length, 0);
  }

  /** Average distance (m) of the lock tips from where the styled shape would put them. */
  tipOffset() {
    let sum = 0;
    this.chains.forEach((ch, i) => { sum += ch[ch.length - 1].cur.distanceTo(this.restTips[i].clone().applyMatrix4(this.head.matrixWorld)); });
    return sum / this.chains.length;
  }

  /** Put every tail back on its rest shape (after a teleport or when re-enabling). */
  reset() {
    this.model.updateMatrixWorld(true);
    for (const chain of this.chains) for (const j of chain) {
      j.bone.quaternion.copy(j.q0);
      j.bone.updateMatrixWorld(true);
      j.cur.copy(j.restLocal).applyMatrix4(j.bone.matrixWorld);
      j.prev.copy(j.cur);
    }
    this._headPrev = null;
    this._acc = 0;
  }

  /** Advance by dt seconds. env.wind: world-space wind (THREE.Vector3, roughly m/s). */
  update(dt, env = {}) {
    if (!this.enabled) { for (const chain of this.chains) for (const j of chain) j.bone.quaternion.copy(j.q0); return; }
    dt = Math.min(dt, 0.1);
    // Head velocity -> the air the hair moves through (skating speed, turns, hits).
    const hp = this.head.getWorldPosition(_v3);
    if (this._headPrev && dt > 0) this.headVelocity.lerp(_v1.subVectors(hp, this._headPrev).divideScalar(dt), 0.35);
    this._headPrev = (this._headPrev || new THREE.Vector3()).copy(hp);
    for (const c of this.colliders) c.world.copy(c.local).applyMatrix4(c.bone.matrixWorld);
    const h = this.params.substep;
    this._acc += dt;
    let steps = 0;
    while (this._acc >= h && steps < 12) { this._step(h, env.wind); this._acc -= h; steps++; }
    if (steps === 12) this._acc = 0;
  }

  _step(h, wind) {
    const { stiffness, drag, gravity, air, hairRadius } = this.params;
    // External push for this step: gravity + wind - (head velocity x air resistance).
    const ext = _v2.set(0, -gravity, 0).addScaledVector(this.headVelocity, -air);
    if (wind) ext.add(wind);
    ext.multiplyScalar(h);
    for (const chain of this.chains) {
      for (const j of chain) {
        const b = j.bone;
        b.quaternion.copy(j.q0);
        b.updateMatrixWorld(true);
        const head = b.getWorldPosition(_v1);
        const parentQ = b.parent.getWorldQuaternion(_q1);
        const restDir = _v3.copy(j.axis).applyQuaternion(j.q0).applyQuaternion(parentQ);
        // Verlet-style step: momentum, pull toward the styled shape, external forces.
        const next = j.cur.clone().sub(j.prev).multiplyScalar(1 - drag).add(j.cur)
          .addScaledVector(restDir, stiffness * h).add(ext);
        next.sub(head).setLength(j.len).add(head);
        for (const c of this.colliders) {
          const d = next.clone().sub(c.world), r = c.radius + hairRadius, dist = d.length();
          if (dist < r && dist > 1e-6) next.copy(c.world).addScaledVector(d, r / dist).sub(head).setLength(j.len).add(head);
        }
        if (!Number.isFinite(next.x)) { this.reset(); return; }
        j.prev.copy(j.cur);
        j.cur.copy(next);
        // Turn the bone from its rest direction to point at the new tail.
        const to = next.sub(head).normalize();
        _q2.setFromUnitVectors(restDir, to);
        b.quaternion.copy(parentQ).invert().multiply(_q2).multiply(parentQ).multiply(j.q0);
        b.updateMatrixWorld(true);
      }
    }
  }
}
