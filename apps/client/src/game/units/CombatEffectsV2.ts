import * as THREE from "three";
import { MAP_GRAPH } from "@kingdoms/content";
import type { SimEvent } from "@kingdoms/sim";
import type { NormalizedSnapshot, NormalizedUnit } from "../types";

const IMPACT_PARTICLES = 224;
const SPELL_PARTICLES = 288;
const IMPACT_RINGS = 40;
const SPELL_RINGS = 36;
const FIREBALLS = 8;
const LIGHTNING_EFFECTS = 16;
const LIGHTNING_SEGMENTS = 448;
const TICK_MS = 50;
const UP = new THREE.Vector3(0, 1, 0);
const FACTION_COLORS = [0x4f93d2, 0xd14c3e, 0x47a965, 0xa64fc1] as const;

interface Point { x: number; y: number; z: number; owner: number }
interface Particle {
  active: boolean; bornAt: number; lifetime: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  gravity: number; startScale: number; endScale: number; spin: number; color: number;
}
interface Ring {
  active: boolean; bornAt: number; lifetime: number;
  x: number; y: number; z: number; startScale: number; endScale: number; color: number;
}
interface Fireball {
  active: boolean; castId: number; bornAt: number; duration: number; owner: number;
  startX: number; startZ: number; endX: number; endZ: number;
  arcHeight: number; seed: number; lastTrailStep: number;
}
interface Segment { ax: number; ay: number; az: number; bx: number; by: number; bz: number }
interface Connection { from: Point; to: Point; seed: number }
interface Lightning {
  active: boolean; bornAt: number; lifetime: number; color: number; lastJitterStep: number;
  connections: Connection[]; segments: Segment[];
}
interface LegacySpell {
  type: "spell"; tick: number; playerId: number;
  cardId: "fireball" | "chain_lightning";
  position: { x: number; z: number }; targetIds: number[];
}
type CompatibleEvent = SimEvent | LegacySpell;
type ParticleOptions = Omit<Particle, "active" | "bornAt"> & { now: number };

function particle(): Particle {
  return {
    active: false, bornAt: 0, lifetime: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    gravity: 0, startScale: 0, endScale: 0, spin: 0, color: 0xffffff,
  };
}
function ring(): Ring {
  return {
    active: false, bornAt: 0, lifetime: 0,
    x: 0, y: 0, z: 0, startScale: 0, endScale: 0, color: 0xffffff,
  };
}
function fireball(): Fireball {
  return {
    active: false, castId: -1, bornAt: 0, duration: 0, owner: 0,
    startX: 0, startZ: 0, endX: 0, endZ: 0,
    arcHeight: 0, seed: 0, lastTrailStep: -1,
  };
}
function lightning(): Lightning {
  return {
    active: false, bornAt: 0, lifetime: 0, color: 0xc8f4ff, lastJitterStep: -1,
    connections: [], segments: [],
  };
}
function unitHeight(unit: NormalizedUnit): number {
  if (unit.kind.includes("tower") || unit.kind.includes("cannon")) return 2.35;
  if (unit.kind.includes("giant")) return 2.15;
  if (unit.kind.includes("knight")) return 2.02;
  if (unit.kind.includes("commander")) return 1.58;
  if (unit.kind.includes("archer")) return 1.46;
  return 1.48;
}
function additive(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
}
function makeMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  renderOrder: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return mesh;
}

/**
 * Fixed-capacity combat VFX. Critical spell pools are isolated from ordinary
 * hits, so a crowded fight cannot erase a fireball or lightning strike.
 */
export class CombatEffects {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly particles = Array.from({ length: IMPACT_PARTICLES }, particle);
  private readonly spellParticles = Array.from({ length: SPELL_PARTICLES }, particle);
  private readonly rings = Array.from({ length: IMPACT_RINGS }, ring);
  private readonly spellRings = Array.from({ length: SPELL_RINGS }, ring);
  private readonly fireballs = Array.from({ length: FIREBALLS }, fireball);
  private readonly lightning = Array.from({ length: LIGHTNING_EFFECTS }, lightning);

  private readonly particleMesh = makeMesh(new THREE.IcosahedronGeometry(0.24, 0), additive(0.9), IMPACT_PARTICLES, 16);
  private readonly spellParticleMesh = makeMesh(new THREE.IcosahedronGeometry(0.22, 0), additive(0.94), SPELL_PARTICLES, 19);
  private readonly ringMesh = makeMesh(
    new THREE.RingGeometry(0.72, 1, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.72, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    IMPACT_RINGS,
    15,
  );
  private readonly spellRingMesh = makeMesh(
    new THREE.RingGeometry(0.72, 1, 36),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.82, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    SPELL_RINGS,
    18,
  );
  private readonly fireballCoreMesh = makeMesh(new THREE.IcosahedronGeometry(0.34, 1), additive(1), FIREBALLS, 22);
  private readonly fireballShellMesh = makeMesh(new THREE.DodecahedronGeometry(0.66, 0), additive(0.38), FIREBALLS, 21);
  private readonly lightningCoreMesh = makeMesh(
    new THREE.CylinderGeometry(0.06, 0.06, 1, 5, 1, true),
    additive(0.98),
    LIGHTNING_SEGMENTS,
    24,
  );
  private readonly lightningGlowMesh = makeMesh(
    new THREE.CylinderGeometry(0.17, 0.17, 1, 6, 1, true),
    additive(0.28),
    LIGHTNING_SEGMENTS,
    23,
  );

  private particleCursor = 0;
  private spellParticleCursor = 0;
  private ringCursor = 0;
  private spellRingCursor = 0;
  private fireballCursor = 0;
  private lightningCursor = 0;
  private effectSerial = 1;
  private lastConsumedTick = Number.MIN_SAFE_INTEGER;
  private disposed = false;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly direction = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly horizontalRing = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = "combat-effects";
    this.group.add(
      this.ringMesh, this.particleMesh, this.spellRingMesh, this.spellParticleMesh,
      this.fireballShellMesh, this.fireballCoreMesh, this.lightningGlowMesh, this.lightningCoreMesh,
    );
    this.scene.add(this.group);
  }

  consume(
    events: readonly SimEvent[],
    current: NormalizedSnapshot,
    previous: NormalizedSnapshot,
    snapshotTick: number,
  ): void {
    if (this.disposed || snapshotTick === this.lastConsumedTick) return;
    this.lastConsumedTick = snapshotTick;
    const now = performance.now();
    events.forEach((rawEvent, index) => {
      const event = rawEvent as CompatibleEvent;
      const seed = (event.tick * 1_103_515_245 + index * 12_345 + this.effectSerial++) | 0;
      switch (event.type) {
        case "damage": {
          const target = event.targetType === "entity"
            ? this.entityPoint(event.targetId, current, previous)
            : this.castlePoint(event.targetId);
          if (target) this.spawnImpact(now, target, this.entityPoint(event.sourceId, current, previous), event.amount, seed);
          break;
        }
        case "death": {
          const point = this.entityPoint(event.entityId, current, previous);
          if (point) this.spawnDeath(now, point, seed);
          break;
        }
        case "spell-cast": {
          const destination: Point = {
            x: event.destination.x, y: 0.45, z: event.destination.z, owner: event.playerId,
          };
          if (event.cardId === "fireball") {
            this.spawnFireballFlight(
              now, event.castId, event.playerId, event.origin, event.destination,
              Math.max(300, (event.impactTick - event.tick) * TICK_MS), seed,
            );
          } else {
            this.spawnLightningCharge(now, destination);
          }
          break;
        }
        case "spell-impact": {
          const destination: Point = {
            x: event.destination.x, y: 0.42, z: event.destination.z, owner: event.playerId,
          };
          if (event.cardId === "fireball") {
            this.completeFireball(event.castId);
            this.spawnFireballImpact(now, destination, seed);
          } else {
            const targets = event.targetIds
              .map((id) => this.entityPoint(id, current, previous))
              .filter((candidate): candidate is Point => candidate !== null);
            this.spawnChainLightning(now, destination, targets, seed);
          }
          break;
        }
        case "spell": {
          const destination: Point = {
            x: event.position.x, y: 0.42, z: event.position.z, owner: event.playerId,
          };
          if (event.cardId === "fireball") {
            this.spawnFireballImpact(now, destination, seed);
          } else {
            const targets = event.targetIds
              .map((id: number) => this.entityPoint(id, current, previous))
              .filter((candidate: Point | null): candidate is Point => candidate !== null);
            this.spawnChainLightning(now, destination, targets, seed);
          }
          break;
        }
        default:
          break;
      }
    });
  }

  update(now: number): void {
    if (this.disposed) return;
    this.updateFireballs(now);
    this.updateParticlePool(now, this.particles, this.particleMesh);
    this.updateParticlePool(now, this.spellParticles, this.spellParticleMesh);
    this.updateRingPool(now, this.rings, this.ringMesh);
    this.updateRingPool(now, this.spellRings, this.spellRingMesh);
    this.updateLightning(now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    const meshes = [
      this.particleMesh, this.spellParticleMesh, this.ringMesh, this.spellRingMesh,
      this.fireballCoreMesh, this.fireballShellMesh, this.lightningCoreMesh, this.lightningGlowMesh,
    ];
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    }
    this.group.clear();
  }

  private entityPoint(id: number, current: NormalizedSnapshot, previous: NormalizedSnapshot): Point | null {
    const unit = current.unitById.get(id) ?? previous.unitById.get(id);
    return unit ? { x: unit.x, y: unitHeight(unit), z: unit.z, owner: unit.owner } : null;
  }

  private castlePoint(playerId: number): Point | null {
    const node = MAP_GRAPH.nodes.find((candidate) => candidate.playerId === playerId);
    return node ? { x: node.position.x, y: 4.8, z: node.position.z, owner: playerId } : null;
  }

  private spawnImpact(now: number, target: Point, source: Point | null, amount: number, seed: number): void {
    const dx = source ? target.x - source.x : 0;
    const dz = source ? target.z - source.z : 0;
    const length = Math.max(0.001, Math.hypot(dx, dz));
    const hitX = dx / length;
    const hitZ = dz / length;
    const strength = THREE.MathUtils.clamp(amount / 320, 0.45, 1.45);
    const count = Math.round(3 + strength * 3);
    for (let index = 0; index < count; index += 1) {
      const angle = this.noise(seed + index * 17) * Math.PI * 2;
      const speed = (1.6 + this.noise(seed + index * 17 + 1) * 2.8) * strength;
      this.spawnParticle({
        now, x: target.x, y: target.y, z: target.z,
        vx: -hitX * speed * 0.55 + Math.cos(angle) * speed * 0.62,
        vy: 1.4 + this.noise(seed + index * 17 + 2) * 3.2,
        vz: -hitZ * speed * 0.55 + Math.sin(angle) * speed * 0.62,
        gravity: 7.5, lifetime: 260 + this.noise(seed + index * 17 + 3) * 230,
        startScale: 0.68 + strength * 0.28, endScale: 0.08,
        color: index % 3 === 0 ? 0xff6a36 : 0xffe2a0, spin: angle,
      });
    }
    this.spawnRing(now, target.x, 0.2, target.z, 0.22, 0.9 + strength * 0.3, 230, 0xffb35b);
  }

  private spawnDeath(now: number, point: Point, seed: number): void {
    const factionColor = FACTION_COLORS[point.owner] ?? 0xb0a486;
    for (let index = 0; index < 12; index += 1) {
      const angle = this.noise(seed + index * 29) * Math.PI * 2;
      const speed = 1.2 + this.noise(seed + index * 29 + 1) * 3.5;
      this.spawnParticle({
        now, x: point.x, y: Math.max(0.35, point.y * 0.45), z: point.z,
        vx: Math.cos(angle) * speed,
        vy: 1.2 + this.noise(seed + index * 29 + 2) * 3.8,
        vz: Math.sin(angle) * speed,
        gravity: 8.5, lifetime: 420 + this.noise(seed + index * 29 + 3) * 360,
        startScale: 0.75 + this.noise(seed + index * 29 + 4) * 0.72, endScale: 0.12,
        color: index % 3 === 0 ? factionColor : index % 2 === 0 ? 0x947650 : 0x5e4b32,
        spin: angle,
      });
    }
    this.spawnRing(now, point.x, 0.18, point.z, 0.35, 1.9, 520, factionColor);
  }

  private spawnFireballFlight(
    now: number,
    castId: number,
    owner: number,
    origin: { x: number; z: number },
    destination: { x: number; z: number },
    duration: number,
    seed: number,
  ): void {
    const existing = this.fireballs.find((slot) => slot.active && slot.castId === castId);
    const slot = existing ?? this.fireballs[this.fireballCursor];
    if (!slot) return;
    if (!existing) this.fireballCursor = (this.fireballCursor + 1) % this.fireballs.length;
    const dx = destination.x - origin.x;
    const dz = destination.z - origin.z;
    const distance = Math.max(0.001, Math.hypot(dx, dz));
    Object.assign(slot, {
      active: true, castId, bornAt: now, duration, owner,
      startX: origin.x + dx / distance * 1.4,
      startZ: origin.z + dz / distance * 1.4,
      endX: destination.x, endZ: destination.z,
      arcHeight: THREE.MathUtils.clamp(distance * 0.11, 3.6, 10),
      seed, lastTrailStep: -1,
    });
    this.spawnSpellRing(now, slot.startX, 0.22, slot.startZ, 0.25, 1.4, 360, 0xff9a31);
  }

  private completeFireball(castId: number): void {
    const slot = this.fireballs.find((candidate) => candidate.active && candidate.castId === castId);
    if (slot) slot.active = false;
  }

  private fireballPoint(slot: Fireball, t: number, target: THREE.Vector3): THREE.Vector3 {
    const clamped = THREE.MathUtils.clamp(t, 0, 1);
    return target.set(
      THREE.MathUtils.lerp(slot.startX, slot.endX, clamped),
      THREE.MathUtils.lerp(6.6, 0.56, clamped) + Math.sin(clamped * Math.PI) * slot.arcHeight,
      THREE.MathUtils.lerp(slot.startZ, slot.endZ, clamped),
    );
  }

  private updateFireballs(now: number): void {
    let count = 0;
    for (const slot of this.fireballs) {
      if (!slot.active) continue;
      const elapsed = now - slot.bornAt;
      const progress = elapsed / Math.max(1, slot.duration);
      if (elapsed > slot.duration + 300) {
        slot.active = false;
        continue;
      }
      const trailStep = Math.floor(Math.min(elapsed, slot.duration) / 45);
      const firstStep = Math.max(slot.lastTrailStep + 1, trailStep - 3);
      for (let step = firstStep; step <= trailStep; step += 1) {
        this.fireballPoint(slot, Math.min(1, step * 45 / Math.max(1, slot.duration)), this.position);
        for (let spark = 0; spark < 2; spark += 1) {
          const sample = slot.seed + step * 97 + spark * 31;
          const angle = this.noise(sample) * Math.PI * 2;
          const speed = 0.5 + this.noise(sample + 1) * 1.2;
          this.spawnSpellParticle({
            now, x: this.position.x, y: this.position.y, z: this.position.z,
            vx: Math.cos(angle) * speed, vy: -0.4 + this.noise(sample + 2) * 1.2,
            vz: Math.sin(angle) * speed, gravity: 1.4,
            lifetime: 260 + this.noise(sample + 3) * 180,
            startScale: spark === 0 ? 1.15 : 0.72, endScale: 0.04,
            color: spark === 0 ? 0xffb337 : 0xff5a1f, spin: angle,
          });
        }
      }
      slot.lastTrailStep = Math.max(slot.lastTrailStep, trailStep);
      this.fireballPoint(slot, progress, this.position);
      const pulse = 0.94 + Math.sin(now * 0.025 + slot.castId) * 0.12;
      this.quaternion.setFromEuler(new THREE.Euler(now * 0.003, now * 0.006, now * 0.004));
      this.scale.setScalar(pulse);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.fireballCoreMesh.setMatrixAt(count, this.matrix);
      this.fireballCoreMesh.setColorAt(count, this.color.setHex(0xfff2a6));
      this.scale.setScalar(0.92 + Math.sin(now * 0.017 + slot.castId * 0.7) * 0.14);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.fireballShellMesh.setMatrixAt(count, this.matrix);
      this.fireballShellMesh.setColorAt(count, this.color.setHex(0xff6120));
      count += 1;
    }
    for (const mesh of [this.fireballCoreMesh, this.fireballShellMesh]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private spawnFireballImpact(now: number, point: Point, seed: number): void {
    this.spawnSpellRing(now, point.x, 0.2, point.z, 0.18, 5.5, 660, 0xff5720);
    this.spawnSpellRing(now, point.x, 0.23, point.z, 0.12, 3.6, 430, 0xffd563);
    this.spawnSpellRing(now, point.x, 0.18, point.z, 0.8, 2.4, 1_650, 0x8e351d);
    for (let index = 0; index < 44; index += 1) {
      const angle = this.noise(seed + index * 41) * Math.PI * 2;
      const radial = 2.4 + this.noise(seed + index * 41 + 1) * 8.6;
      const smoke = index >= 34;
      this.spawnSpellParticle({
        now,
        x: point.x + Math.cos(angle) * (smoke ? 0.5 : 0.15),
        y: 0.42 + this.noise(seed + index * 41 + 2) * (smoke ? 1.1 : 0.65),
        z: point.z + Math.sin(angle) * (smoke ? 0.5 : 0.15),
        vx: Math.cos(angle) * (smoke ? radial * 0.18 : radial),
        vy: smoke ? 2.6 + this.noise(seed + index * 41 + 3) * 2.8 : 3.8 + this.noise(seed + index * 41 + 3) * 9.2,
        vz: Math.sin(angle) * (smoke ? radial * 0.18 : radial),
        gravity: smoke ? 1.6 : 13,
        lifetime: smoke ? 1_050 + this.noise(seed + index * 41 + 4) * 550 : 480 + this.noise(seed + index * 41 + 4) * 460,
        startScale: smoke ? 1.8 + this.noise(seed + index * 41 + 5) : index < 7 ? 2.35 : 0.72 + this.noise(seed + index * 41 + 5) * 1.2,
        endScale: smoke ? 0.35 : 0.06,
        color: smoke ? 0x6b5544 : index % 4 === 0 ? 0xfff2ad : index % 2 === 0 ? 0xffa22e : 0xef421d,
        spin: angle,
      });
    }
  }

  private spawnLightningCharge(now: number, point: Point): void {
    this.spawnSpellRing(now, point.x, 0.2, point.z, 0.25, 2.35, 360, 0x8edfff);
    this.spawnSpellRing(now, point.x, 0.22, point.z, 1.7, 0.5, 330, 0xe8fbff);
  }

  private spawnChainLightning(now: number, point: Point, targets: Point[], seed: number): void {
    const path: Point[] = [
      { x: point.x - 0.65, y: 18, z: point.z + 0.4, owner: point.owner },
      { x: point.x, y: 0.68, z: point.z, owner: point.owner },
      ...targets,
    ];
    const slot = this.lightning[this.lightningCursor];
    this.lightningCursor = (this.lightningCursor + 1) % this.lightning.length;
    if (!slot) return;
    slot.active = true;
    slot.bornAt = now;
    slot.lifetime = 620;
    slot.color = 0xc8f5ff;
    slot.lastJitterStep = -1;
    slot.connections.length = 0;
    slot.segments.length = 0;
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      if (from && to) slot.connections.push({ from, to, seed: seed + index * 101 });
    }
    this.rebuildLightning(slot, 0);

    this.spawnSpellRing(now, point.x, 0.21, point.z, 0.2, 3.2, 520, 0x8edfff);
    this.spawnSpellRing(now, point.x, 0.23, point.z, 2.7, 0.5, 420, 0xffffff);
    const sparks = Math.max(18, 8 + targets.length * 7);
    for (let index = 0; index < sparks; index += 1) {
      const anchor = targets[index % Math.max(1, targets.length)] ?? point;
      const angle = this.noise(seed + index * 53) * Math.PI * 2;
      const speed = 2.2 + this.noise(seed + index * 53 + 1) * 5.2;
      this.spawnSpellParticle({
        now, x: anchor.x, y: anchor.y, z: anchor.z,
        vx: Math.cos(angle) * speed,
        vy: 1.8 + this.noise(seed + index * 53 + 2) * 5.8,
        vz: Math.sin(angle) * speed,
        gravity: 6.4, lifetime: 340 + this.noise(seed + index * 53 + 3) * 360,
        startScale: 0.68 + this.noise(seed + index * 53 + 4) * 0.62,
        endScale: 0.035, color: index % 3 === 0 ? 0xffffff : 0x8edfff, spin: angle,
      });
    }
  }

  private rebuildLightning(slot: Lightning, jitterStep: number): void {
    slot.segments.length = 0;
    slot.connections.forEach((connection, index) => {
      this.addJaggedConnection(
        slot.segments, connection.from, connection.to,
        connection.seed + jitterStep * 7_919,
      );
      if (index === 0) {
        const offsetFrom = {
          ...connection.from, x: connection.from.x + 0.16, z: connection.from.z - 0.12,
        };
        const offsetTo = {
          ...connection.to, x: connection.to.x - 0.12, z: connection.to.z + 0.1,
        };
        this.addJaggedConnection(
          slot.segments, offsetFrom, offsetTo,
          connection.seed + 31_337 + jitterStep * 3_571,
        );
      }
    });
    slot.lastJitterStep = jitterStep;
  }

  private addJaggedConnection(segments: Segment[], from: Point, to: Point, seed: number): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const divisions = THREE.MathUtils.clamp(Math.ceil(distance / 1.1), 5, 18);
    let previousX = from.x;
    let previousY = from.y;
    let previousZ = from.z;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const horizontalLength = Math.max(0.001, Math.hypot(dx, dz));
    const perpendicularX = -dz / horizontalLength;
    const perpendicularZ = dx / horizontalLength;
    for (let index = 1; index <= divisions; index += 1) {
      const t = index / divisions;
      const envelope = Math.sin(t * Math.PI);
      const lateral = (this.noise(seed + index * 7) - 0.5) * Math.min(1.45, distance * 0.14) * envelope;
      const lift = (this.noise(seed + index * 7 + 1) - 0.5) * Math.min(1, distance * 0.11) * envelope;
      const nextX = THREE.MathUtils.lerp(from.x, to.x, t) + perpendicularX * lateral;
      const nextY = THREE.MathUtils.lerp(from.y, to.y, t) + lift;
      const nextZ = THREE.MathUtils.lerp(from.z, to.z, t) + perpendicularZ * lateral;
      segments.push({ ax: previousX, ay: previousY, az: previousZ, bx: nextX, by: nextY, bz: nextZ });
      previousX = nextX;
      previousY = nextY;
      previousZ = nextZ;
    }
  }

  private writeParticle(pool: Particle[], cursor: number, options: ParticleOptions): number {
    const slot = pool[cursor];
    const next = (cursor + 1) % pool.length;
    if (!slot) return next;
    Object.assign(slot, options, { active: true, bornAt: options.now });
    return next;
  }

  private spawnParticle(options: ParticleOptions): void {
    this.particleCursor = this.writeParticle(this.particles, this.particleCursor, options);
  }

  private spawnSpellParticle(options: ParticleOptions): void {
    this.spellParticleCursor = this.writeParticle(this.spellParticles, this.spellParticleCursor, options);
  }

  private writeRing(
    pool: Ring[],
    cursor: number,
    now: number,
    x: number,
    y: number,
    z: number,
    startScale: number,
    endScale: number,
    lifetime: number,
    color: number,
  ): number {
    const slot = pool[cursor];
    const next = (cursor + 1) % pool.length;
    if (slot) Object.assign(slot, { active: true, bornAt: now, lifetime, x, y, z, startScale, endScale, color });
    return next;
  }

  private spawnRing(
    now: number,
    x: number,
    y: number,
    z: number,
    startScale: number,
    endScale: number,
    lifetime: number,
    color: number,
  ): void {
    this.ringCursor = this.writeRing(
      this.rings, this.ringCursor, now, x, y, z, startScale, endScale, lifetime, color,
    );
  }

  private spawnSpellRing(
    now: number,
    x: number,
    y: number,
    z: number,
    startScale: number,
    endScale: number,
    lifetime: number,
    color: number,
  ): void {
    this.spellRingCursor = this.writeRing(
      this.spellRings, this.spellRingCursor, now, x, y, z, startScale, endScale, lifetime, color,
    );
  }

  private updateParticlePool(now: number, slots: Particle[], mesh: THREE.InstancedMesh): void {
    let count = 0;
    for (const slot of slots) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        continue;
      }
      const age = Math.max(0, now - slot.bornAt) * 0.001;
      const fade = Math.pow(1 - Math.max(0, progress), 0.72);
      const size = THREE.MathUtils.lerp(slot.startScale, slot.endScale, progress) * fade;
      this.position.set(
        slot.x + slot.vx * age,
        Math.max(0.16, slot.y + slot.vy * age - 0.5 * slot.gravity * age * age),
        slot.z + slot.vz * age,
      );
      this.quaternion.setFromEuler(new THREE.Euler(slot.spin * age * 2.1, slot.spin + age * 3.4, slot.spin * 0.37));
      this.scale.setScalar(size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(count, this.matrix);
      mesh.setColorAt(count, this.color.setHex(slot.color).multiplyScalar(Math.max(0.08, fade)));
      count += 1;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private updateRingPool(now: number, slots: Ring[], mesh: THREE.InstancedMesh): void {
    let count = 0;
    for (const slot of slots) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        continue;
      }
      const eased = 1 - Math.pow(1 - Math.max(0, progress), 3);
      const size = THREE.MathUtils.lerp(slot.startScale, slot.endScale, eased);
      const fade = Math.pow(1 - Math.max(0, progress), 0.58);
      this.position.set(slot.x, slot.y, slot.z);
      this.scale.set(size, size, size);
      this.matrix.compose(this.position, this.horizontalRing, this.scale);
      mesh.setMatrixAt(count, this.matrix);
      mesh.setColorAt(count, this.color.setHex(slot.color).multiplyScalar(Math.max(0.045, fade)));
      count += 1;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private updateLightning(now: number): void {
    let count = 0;
    for (const slot of this.lightning) {
      if (!slot.active) continue;
      const elapsed = now - slot.bornAt;
      const progress = elapsed / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        slot.connections.length = 0;
        slot.segments.length = 0;
        continue;
      }
      const jitterStep = Math.floor(elapsed / 48);
      if (jitterStep !== slot.lastJitterStep) this.rebuildLightning(slot, jitterStep);
      const flicker = 0.72 + Math.abs(Math.sin(now * 0.081 + slot.bornAt * 0.019)) * 0.28;
      const fade = Math.pow(1 - Math.max(0, progress), 0.32) * flicker;
      for (const segment of slot.segments) {
        if (count >= LIGHTNING_SEGMENTS) break;
        this.direction.set(segment.bx - segment.ax, segment.by - segment.ay, segment.bz - segment.az);
        const length = this.direction.length();
        if (length <= 0.001) continue;
        this.direction.multiplyScalar(1 / length);
        this.midpoint.set(
          (segment.ax + segment.bx) * 0.5,
          (segment.ay + segment.by) * 0.5,
          (segment.az + segment.bz) * 0.5,
        );
        this.quaternion.setFromUnitVectors(UP, this.direction);
        this.scale.set(1, length, 1);
        this.matrix.compose(this.midpoint, this.quaternion, this.scale);
        this.lightningCoreMesh.setMatrixAt(count, this.matrix);
        this.lightningCoreMesh.setColorAt(
          count, this.color.setHex(0xf3ffff).multiplyScalar(Math.max(0.2, fade)),
        );
        this.lightningGlowMesh.setMatrixAt(count, this.matrix);
        this.lightningGlowMesh.setColorAt(
          count, this.color.setHex(slot.color).multiplyScalar(Math.max(0.09, fade * 0.78)),
        );
        count += 1;
      }
      if (count >= LIGHTNING_SEGMENTS) break;
    }
    for (const mesh of [this.lightningCoreMesh, this.lightningGlowMesh]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private noise(seed: number): number {
    let value = seed | 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 4_294_967_295;
  }
}
