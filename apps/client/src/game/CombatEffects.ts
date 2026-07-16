import * as THREE from "three";
import { MAP_GRAPH } from "@kingdoms/content";
import type { SimEvent } from "@kingdoms/sim";
import type { NormalizedSnapshot, NormalizedUnit } from "./types";

const PARTICLE_CAPACITY = 224;
const RING_CAPACITY = 40;
const LIGHTNING_EFFECT_CAPACITY = 12;
const LIGHTNING_SEGMENT_CAPACITY = 320;

const FACTION_COLORS = [0x4f93d2, 0xd14c3e, 0x47a965, 0xa64fc1] as const;
const UP = new THREE.Vector3(0, 1, 0);

interface EffectPoint {
  x: number;
  y: number;
  z: number;
  owner: number;
}

interface ParticleSlot {
  active: boolean;
  bornAt: number;
  lifetime: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  startScale: number;
  endScale: number;
  spin: number;
  color: number;
}

interface RingSlot {
  active: boolean;
  bornAt: number;
  lifetime: number;
  x: number;
  y: number;
  z: number;
  startScale: number;
  endScale: number;
  color: number;
}

interface LightningSegment {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

interface LightningSlot {
  active: boolean;
  bornAt: number;
  lifetime: number;
  color: number;
  segments: LightningSegment[];
}

function makeParticleSlot(): ParticleSlot {
  return {
    active: false,
    bornAt: 0,
    lifetime: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    startScale: 0,
    endScale: 0,
    spin: 0,
    color: 0xffffff,
  };
}

function makeRingSlot(): RingSlot {
  return {
    active: false,
    bornAt: 0,
    lifetime: 0,
    x: 0,
    y: 0,
    z: 0,
    startScale: 0,
    endScale: 0,
    color: 0xffffff,
  };
}

function unitHeight(unit: NormalizedUnit): number {
  if (unit.kind.includes("tower") || unit.kind.includes("cannon")) return 2.2;
  if (unit.kind.includes("giant")) return 1.75;
  if (unit.kind.includes("commander") || unit.kind.includes("knight")) return 1.4;
  return 1.15;
}

/**
 * Fixed-capacity, three-draw-call combat VFX layer. It deliberately uses only
 * stock Three materials/geometries so it behaves the same on WebGPU and WebGL2.
 */
export class CombatEffects {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly particles: ParticleSlot[] = Array.from({ length: PARTICLE_CAPACITY }, makeParticleSlot);
  private readonly rings: RingSlot[] = Array.from({ length: RING_CAPACITY }, makeRingSlot);
  private readonly lightning: LightningSlot[] = Array.from({ length: LIGHTNING_EFFECT_CAPACITY }, () => ({
    active: false,
    bornAt: 0,
    lifetime: 0,
    color: 0xc8f4ff,
    segments: [],
  }));

  private readonly particleMesh: THREE.InstancedMesh;
  private readonly ringMesh: THREE.InstancedMesh;
  private readonly lightningMesh: THREE.InstancedMesh;
  private particleCursor = 0;
  private ringCursor = 0;
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

    const particleGeometry = new THREE.IcosahedronGeometry(0.24, 0);
    const particleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.particleMesh = new THREE.InstancedMesh(particleGeometry, particleMaterial, PARTICLE_CAPACITY);
    this.configureInstances(this.particleMesh, 16);

    const ringGeometry = new THREE.RingGeometry(0.72, 1, 24);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.ringMesh = new THREE.InstancedMesh(ringGeometry, ringMaterial, RING_CAPACITY);
    this.configureInstances(this.ringMesh, 15);

    const lightningGeometry = new THREE.CylinderGeometry(0.075, 0.075, 1, 5, 1, true);
    const lightningMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.lightningMesh = new THREE.InstancedMesh(lightningGeometry, lightningMaterial, LIGHTNING_SEGMENT_CAPACITY);
    this.configureInstances(this.lightningMesh, 18);

    this.group.add(this.particleMesh, this.ringMesh, this.lightningMesh);
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

    events.forEach((event, index) => {
      const seed = (event.tick * 1_103_515_245 + index * 12_345 + this.effectSerial++) | 0;
      switch (event.type) {
        case "damage": {
          const target = event.targetType === "entity"
            ? this.entityPoint(event.targetId, current, previous)
            : this.castlePoint(event.targetId);
          if (!target) break;
          const source = this.entityPoint(event.sourceId, current, previous);
          this.spawnImpact(now, target, source, event.amount, seed);
          break;
        }
        case "death": {
          const point = this.entityPoint(event.entityId, current, previous);
          if (point) this.spawnDeath(now, point, seed);
          break;
        }
        case "spell": {
          const point: EffectPoint = { x: event.position.x, y: 0.35, z: event.position.z, owner: event.playerId };
          if (event.cardId === "fireball") {
            this.spawnFireball(now, point, seed);
          } else if (event.cardId === "chain_lightning") {
            const targets = event.targetIds
              .map((id) => this.entityPoint(id, current, previous))
              .filter((candidate): candidate is EffectPoint => candidate !== null);
            this.spawnChainLightning(now, point, targets, seed);
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
    this.updateParticles(now);
    this.updateRings(now);
    this.updateLightning(now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    this.particleMesh.geometry.dispose();
    this.ringMesh.geometry.dispose();
    this.lightningMesh.geometry.dispose();
    for (const mesh of [this.particleMesh, this.ringMesh, this.lightningMesh]) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    }
    this.group.clear();
  }

  private configureInstances(mesh: THREE.InstancedMesh, renderOrder: number): void {
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
  }

  private entityPoint(id: number, current: NormalizedSnapshot, previous: NormalizedSnapshot): EffectPoint | null {
    const unit = current.unitById.get(id) ?? previous.unitById.get(id);
    if (!unit) return null;
    return { x: unit.x, y: unitHeight(unit), z: unit.z, owner: unit.owner };
  }

  private castlePoint(playerId: number): EffectPoint | null {
    const node = MAP_GRAPH.nodes.find((candidate) => candidate.playerId === playerId);
    return node ? { x: node.position.x, y: 3.4, z: node.position.z, owner: playerId } : null;
  }

  private spawnImpact(now: number, target: EffectPoint, source: EffectPoint | null, amount: number, seed: number): void {
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
        now,
        x: target.x,
        y: target.y,
        z: target.z,
        vx: -hitX * speed * 0.55 + Math.cos(angle) * speed * 0.62,
        vy: 1.4 + this.noise(seed + index * 17 + 2) * 3.2,
        vz: -hitZ * speed * 0.55 + Math.sin(angle) * speed * 0.62,
        gravity: 7.5,
        lifetime: 260 + this.noise(seed + index * 17 + 3) * 230,
        startScale: 0.68 + strength * 0.28,
        endScale: 0.08,
        color: index % 3 === 0 ? 0xff6a36 : 0xffe2a0,
        spin: angle,
      });
    }
    this.spawnRing(now, target.x, 0.2, target.z, 0.22, 0.9 + strength * 0.3, 230, 0xffb35b);
  }

  private spawnDeath(now: number, point: EffectPoint, seed: number): void {
    const factionColor = FACTION_COLORS[point.owner] ?? 0xb0a486;
    for (let index = 0; index < 13; index += 1) {
      const angle = this.noise(seed + index * 29) * Math.PI * 2;
      const speed = 1.2 + this.noise(seed + index * 29 + 1) * 3.5;
      this.spawnParticle({
        now,
        x: point.x,
        y: Math.max(0.35, point.y * 0.45),
        z: point.z,
        vx: Math.cos(angle) * speed,
        vy: 1.2 + this.noise(seed + index * 29 + 2) * 3.8,
        vz: Math.sin(angle) * speed,
        gravity: 8.5,
        lifetime: 420 + this.noise(seed + index * 29 + 3) * 360,
        startScale: 0.75 + this.noise(seed + index * 29 + 4) * 0.72,
        endScale: 0.12,
        color: index % 3 === 0 ? factionColor : index % 2 === 0 ? 0x947650 : 0x5e4b32,
        spin: angle,
      });
    }
    this.spawnRing(now, point.x, 0.18, point.z, 0.35, 1.9, 520, factionColor);
  }

  private spawnFireball(now: number, point: EffectPoint, seed: number): void {
    this.spawnRing(now, point.x, 0.21, point.z, 0.45, 5.1, 610, 0xff6a20);
    this.spawnRing(now, point.x, 0.24, point.z, 0.25, 3.25, 390, 0xffd262);
    for (let index = 0; index < 28; index += 1) {
      const angle = this.noise(seed + index * 41) * Math.PI * 2;
      const radial = 2.1 + this.noise(seed + index * 41 + 1) * 7.4;
      this.spawnParticle({
        now,
        x: point.x,
        y: 0.42 + this.noise(seed + index * 41 + 2) * 0.8,
        z: point.z,
        vx: Math.cos(angle) * radial,
        vy: 2.8 + this.noise(seed + index * 41 + 3) * 8.2,
        vz: Math.sin(angle) * radial,
        gravity: 12,
        lifetime: 460 + this.noise(seed + index * 41 + 4) * 440,
        startScale: index < 5 ? 2.1 : 0.7 + this.noise(seed + index * 41 + 5) * 1.15,
        endScale: 0.08,
        color: index % 4 === 0 ? 0xfff0a2 : index % 2 === 0 ? 0xffa22e : 0xef421d,
        spin: angle,
      });
    }
  }

  private spawnChainLightning(now: number, point: EffectPoint, targets: EffectPoint[], seed: number): void {
    const path: EffectPoint[] = [
      { x: point.x - 0.8, y: 10.5, z: point.z + 0.45, owner: point.owner },
      { x: point.x, y: 0.65, z: point.z, owner: point.owner },
      ...targets,
    ];
    const slot = this.lightning[this.lightningCursor];
    this.lightningCursor = (this.lightningCursor + 1) % this.lightning.length;
    if (!slot) return;
    slot.active = true;
    slot.bornAt = now;
    slot.lifetime = 320;
    slot.color = 0xbbeeff;
    slot.segments.length = 0;
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      if (!from || !to) continue;
      this.addJaggedConnection(slot.segments, from, to, seed + index * 101);
    }
    this.spawnRing(now, point.x, 0.22, point.z, 0.25, 2.6, 360, 0x8edfff);
    const sparks = Math.max(10, 5 + targets.length * 4);
    for (let index = 0; index < sparks; index += 1) {
      const anchor = targets[index % Math.max(1, targets.length)] ?? point;
      const angle = this.noise(seed + index * 53) * Math.PI * 2;
      const speed = 1.8 + this.noise(seed + index * 53 + 1) * 4.2;
      this.spawnParticle({
        now,
        x: anchor.x,
        y: anchor.y,
        z: anchor.z,
        vx: Math.cos(angle) * speed,
        vy: 1.5 + this.noise(seed + index * 53 + 2) * 4.8,
        vz: Math.sin(angle) * speed,
        gravity: 5.8,
        lifetime: 260 + this.noise(seed + index * 53 + 3) * 290,
        startScale: 0.62 + this.noise(seed + index * 53 + 4) * 0.52,
        endScale: 0.04,
        color: index % 3 === 0 ? 0xffffff : 0x8edfff,
        spin: angle,
      });
    }
  }

  private addJaggedConnection(segments: LightningSegment[], from: EffectPoint, to: EffectPoint, seed: number): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const divisions = THREE.MathUtils.clamp(Math.ceil(distance / 1.2), 5, 11);
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
      const lateral = (this.noise(seed + index * 7) - 0.5) * Math.min(1.25, distance * 0.13) * envelope;
      const lift = (this.noise(seed + index * 7 + 1) - 0.5) * Math.min(0.85, distance * 0.1) * envelope;
      const nextX = THREE.MathUtils.lerp(from.x, to.x, t) + perpendicularX * lateral;
      const nextY = THREE.MathUtils.lerp(from.y, to.y, t) + lift;
      const nextZ = THREE.MathUtils.lerp(from.z, to.z, t) + perpendicularZ * lateral;
      segments.push({ ax: previousX, ay: previousY, az: previousZ, bx: nextX, by: nextY, bz: nextZ });
      previousX = nextX;
      previousY = nextY;
      previousZ = nextZ;
    }
  }

  private spawnParticle(options: Omit<ParticleSlot, "active" | "bornAt"> & { now: number }): void {
    const slot = this.particles[this.particleCursor];
    this.particleCursor = (this.particleCursor + 1) % this.particles.length;
    if (!slot) return;
    slot.active = true;
    slot.bornAt = options.now;
    slot.lifetime = options.lifetime;
    slot.x = options.x;
    slot.y = options.y;
    slot.z = options.z;
    slot.vx = options.vx;
    slot.vy = options.vy;
    slot.vz = options.vz;
    slot.gravity = options.gravity;
    slot.startScale = options.startScale;
    slot.endScale = options.endScale;
    slot.spin = options.spin;
    slot.color = options.color;
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
    const slot = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    if (!slot) return;
    slot.active = true;
    slot.bornAt = now;
    slot.lifetime = lifetime;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.startScale = startScale;
    slot.endScale = endScale;
    slot.color = color;
  }

  private updateParticles(now: number): void {
    let count = 0;
    for (const slot of this.particles) {
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
      this.particleMesh.setMatrixAt(count, this.matrix);
      this.color.setHex(slot.color).multiplyScalar(Math.max(0.08, fade));
      this.particleMesh.setColorAt(count, this.color);
      count += 1;
    }
    this.particleMesh.count = count;
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }

  private updateRings(now: number): void {
    let count = 0;
    for (const slot of this.rings) {
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
      this.ringMesh.setMatrixAt(count, this.matrix);
      this.color.setHex(slot.color).multiplyScalar(Math.max(0.045, fade));
      this.ringMesh.setColorAt(count, this.color);
      count += 1;
    }
    this.ringMesh.count = count;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
  }

  private updateLightning(now: number): void {
    let count = 0;
    for (const slot of this.lightning) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        slot.segments.length = 0;
        continue;
      }
      const flicker = 0.68 + Math.abs(Math.sin(now * 0.073 + slot.bornAt * 0.017)) * 0.32;
      const fade = Math.pow(1 - Math.max(0, progress), 0.4) * flicker;
      for (const segment of slot.segments) {
        if (count >= LIGHTNING_SEGMENT_CAPACITY) break;
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
        this.lightningMesh.setMatrixAt(count, this.matrix);
        this.color.setHex(slot.color).multiplyScalar(Math.max(0.12, fade));
        this.lightningMesh.setColorAt(count, this.color);
        count += 1;
      }
      if (count >= LIGHTNING_SEGMENT_CAPACITY) break;
    }
    this.lightningMesh.count = count;
    this.lightningMesh.instanceMatrix.needsUpdate = true;
    if (this.lightningMesh.instanceColor) this.lightningMesh.instanceColor.needsUpdate = true;
  }

  private noise(seed: number): number {
    let value = seed | 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 4_294_967_295;
  }
}
