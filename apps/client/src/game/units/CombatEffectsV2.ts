import * as THREE from "three";
import { CONTENT, MAP_GRAPH } from "@kingdoms/content";
import type { SimEvent } from "@kingdoms/sim";
import type { NormalizedSnapshot, NormalizedUnit } from "../types";
import { FACTION_COLORS } from "../factions";

const IMPACT_PARTICLES = 224;
const DEATH_PARTICLES = 192;
const SPELL_PARTICLES = 288;
const SMOKE_PARTICLES = 128;
const ACID_DROPS = 192;
const SPAWN_PARTICLES = 160;
const IMPACT_RINGS = 40;
const DEATH_RINGS = 32;
const SPELL_RINGS = 36;
const SPAWN_RINGS = 32;
const BURN_MARKS = 32;
const FIREBALLS = 8;
const ARROWS = 128;
const LIGHTNING_EFFECTS = 16;
const LIGHTNING_SEGMENTS = 448;
const LIGHTNING_NODES = 80;
const SPAWN_COCOONS = 32;
const TICK_MS = 50;
const MIN_VISIBLE_ARROW_MS = 150;
const UP = new THREE.Vector3(0, 1, 0);

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
interface BurnMark {
  active: boolean; bornAt: number; lifetime: number;
  x: number; y: number; z: number; scale: number; rotation: number; color: number;
}
interface Fireball {
  active: boolean; castId: number; bornAt: number; duration: number; owner: number;
  startX: number; startZ: number; endX: number; endZ: number;
  arcHeight: number; seed: number; lastTrailStep: number;
}
interface Arrow {
  active: boolean; projectileId: number; bornAt: number; duration: number;
  targetType: 'entity' | 'castle'; targetId: number;
  startX: number; startY: number; startZ: number;
  endX: number; endY: number; endZ: number; arcHeight: number;
}
interface Segment { ax: number; ay: number; az: number; bx: number; by: number; bz: number }
interface Connection { from: Point; to: Point; seed: number }
interface Lightning {
  active: boolean; bornAt: number; lifetime: number; color: number; lastJitterStep: number;
  connections: Connection[]; segments: Segment[];
}
interface LightningNode {
  active: boolean; bornAt: number; lifetime: number;
  x: number; y: number; z: number; color: number; seed: number;
}
interface SpawnCocoon {
  active: boolean; bornAt: number; lifetime: number;
  x: number; z: number; height: number; color: number; seed: number;
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
function burnMark(): BurnMark {
  return {
    active: false, bornAt: 0, lifetime: 0,
    x: 0, y: 0, z: 0, scale: 0, rotation: 0, color: 0x23451f,
  };
}
function fireball(): Fireball {
  return {
    active: false, castId: -1, bornAt: 0, duration: 0, owner: 0,
    startX: 0, startZ: 0, endX: 0, endZ: 0,
    arcHeight: 0, seed: 0, lastTrailStep: -1,
  };
}
function arrow(): Arrow {
  return {
    active: false, projectileId: -1, bornAt: 0, duration: 0,
    targetType: 'entity', targetId: -1,
    startX: 0, startY: 0, startZ: 0,
    endX: 0, endY: 0, endZ: 0, arcHeight: 0,
  };
}
function lightning(): Lightning {
  return {
    active: false, bornAt: 0, lifetime: 0, color: 0xc8f4ff, lastJitterStep: -1,
    connections: [], segments: [],
  };
}
function lightningNode(): LightningNode {
  return {
    active: false, bornAt: 0, lifetime: 0,
    x: 0, y: 0, z: 0, color: 0xc8f4ff, seed: 0,
  };
}
function spawnCocoon(): SpawnCocoon {
  return {
    active: false, bornAt: 0, lifetime: 0,
    x: 0, z: 0, height: 1, color: 0xffffff, seed: 0,
  };
}
function unitHeight(unit: NormalizedUnit): number {
  if (unit.kind.includes("tower") || unit.kind.includes("cannon")) return CONTENT.buildings[0]?.height ?? 3.6;
  const archetype = unit.kind.includes("giant")
    ? "giant"
    : unit.kind.includes("knight")
      ? "knight"
      : unit.kind.includes("commander")
        ? "commander"
        : unit.kind.includes("archer")
          ? "archer"
          : "guard";
  return CONTENT.units.find((definition) => definition.id === archetype)?.height ?? 1.15;
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

function makeOrganicRingGeometry(
  innerRadius: number,
  outerRadius: number,
  segments: number,
): THREE.BufferGeometry {
  const positions = new Float32Array(segments * 2 * 3);
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    const ripple = 1 + Math.sin(angle * 5 + 0.7) * 0.045 + Math.sin(angle * 9) * 0.018;
    const inner = innerRadius * (1 + Math.sin(angle * 7 + 1.3) * 0.025);
    const outer = outerRadius * ripple;
    const offset = index * 6;
    positions[offset] = Math.cos(angle) * inner;
    positions[offset + 1] = Math.sin(angle) * inner;
    positions[offset + 2] = 0;
    positions[offset + 3] = Math.cos(angle) * outer;
    positions[offset + 4] = Math.sin(angle) * outer;
    positions[offset + 5] = 0;
    const next = (index + 1) % segments;
    indices.push(index * 2, index * 2 + 1, next * 2 + 1, index * 2, next * 2 + 1, next * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeOrganicDiscGeometry(segments: number): THREE.BufferGeometry {
  const positions = new Float32Array((segments + 1) * 3);
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    const radius = 0.82
      + Math.sin(angle * 3 + 0.6) * 0.11
      + Math.sin(angle * 7 + 1.1) * 0.055;
    const offset = (index + 1) * 3;
    positions[offset] = Math.cos(angle) * radius;
    positions[offset + 1] = Math.sin(angle) * radius;
    indices.push(0, index + 1, (index + 1) % segments + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeChitinShardGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.22, -0.07, -0.055, 0.22, -0.07, -0.055, 0.02, 0.27, -0.025,
    -0.17, -0.045, 0.07, 0.17, -0.045, 0.07, 0.02, 0.21, 0.055,
  ], 3));
  geometry.setIndex([
    0, 1, 2, 5, 4, 3,
    0, 3, 4, 0, 4, 1,
    1, 4, 5, 1, 5, 2,
    2, 5, 3, 2, 3, 0,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function deformOrganicSphere(
  geometry: THREE.BufferGeometry,
  verticalScale: number,
  radialScale: number,
): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const ripple = 1 + Math.sin(x * 8.3 + z * 5.7) * 0.055 + Math.sin(y * 11.2) * 0.035;
    const taper = 0.84 + 0.16 * (1 - Math.min(1, Math.abs(y)));
    position.setXYZ(
      index,
      x * radialScale * ripple * taper,
      y * verticalScale,
      z * radialScale * ripple * taper,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function makeAcidDropGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(0.22, 7, 5);
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const lowerStretch = y < 0 ? 1.65 : 0.82;
    const radial = y < 0 ? 0.72 : 1;
    position.setXYZ(index, x * radial, y * lowerStretch, z * radial);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Fixed-capacity combat VFX. Critical spell pools are isolated from ordinary
 * hits, so a crowded fight cannot erase a fireball or lightning strike.
 */
export class CombatEffects {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly particles = Array.from({ length: IMPACT_PARTICLES }, particle);
  private readonly deathParticles = Array.from({ length: DEATH_PARTICLES }, particle);
  private readonly spellParticles = Array.from({ length: SPELL_PARTICLES }, particle);
  private readonly smokeParticles = Array.from({ length: SMOKE_PARTICLES }, particle);
  private readonly acidDrops = Array.from({ length: ACID_DROPS }, particle);
  private readonly spawnParticles = Array.from({ length: SPAWN_PARTICLES }, particle);
  private readonly rings = Array.from({ length: IMPACT_RINGS }, ring);
  private readonly deathRings = Array.from({ length: DEATH_RINGS }, ring);
  private readonly spellRings = Array.from({ length: SPELL_RINGS }, ring);
  private readonly spawnRings = Array.from({ length: SPAWN_RINGS }, ring);
  private readonly burnMarks = Array.from({ length: BURN_MARKS }, burnMark);
  private readonly fireballs = Array.from({ length: FIREBALLS }, fireball);
  private readonly arrows = Array.from({ length: ARROWS }, arrow);
  private readonly lightning = Array.from({ length: LIGHTNING_EFFECTS }, lightning);
  private readonly lightningNodes = Array.from({ length: LIGHTNING_NODES }, lightningNode);
  private readonly spawnCocoons = Array.from({ length: SPAWN_COCOONS }, spawnCocoon);

  private readonly particleMesh = makeMesh(makeChitinShardGeometry(), additive(0.9), IMPACT_PARTICLES, 16);
  private readonly deathParticleMesh = makeMesh(
    makeChitinShardGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false,
      blending: THREE.NormalBlending, toneMapped: true,
    }),
    DEATH_PARTICLES,
    14,
  );
  private readonly spellParticleMesh = makeMesh(new THREE.IcosahedronGeometry(0.22, 0), additive(0.94), SPELL_PARTICLES, 19);
  private readonly smokeParticleMesh = makeMesh(
    new THREE.IcosahedronGeometry(0.5, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.34, depthWrite: false,
      blending: THREE.NormalBlending, toneMapped: true,
    }),
    SMOKE_PARTICLES,
    17,
  );
  private readonly acidDropMesh = makeMesh(
    makeAcidDropGeometry(),
    additive(0.94),
    ACID_DROPS,
    20,
  );
  private readonly spawnParticleMesh = makeMesh(
    new THREE.OctahedronGeometry(0.16, 0),
    additive(0.82),
    SPAWN_PARTICLES,
    17,
  );
  private readonly ringMesh = makeMesh(
    makeOrganicRingGeometry(0.72, 1, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.72, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    IMPACT_RINGS,
    15,
  );
  private readonly spellRingMesh = makeMesh(
    makeOrganicRingGeometry(0.72, 1, 36),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.82, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    SPELL_RINGS,
    18,
  );
  private readonly deathRingMesh = makeMesh(
    makeOrganicRingGeometry(0.7, 1, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.48, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.NormalBlending, toneMapped: true,
    }),
    DEATH_RINGS,
    13,
  );
  private readonly spawnRingMesh = makeMesh(
    makeOrganicRingGeometry(0.68, 1, 28),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.58, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    SPAWN_RINGS,
    14,
  );
  private readonly burnMarkMesh = makeMesh(
    makeOrganicDiscGeometry(24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.46, side: THREE.DoubleSide,
      depthWrite: false, depthTest: true, blending: THREE.NormalBlending, toneMapped: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    BURN_MARKS,
    6,
  );
  private readonly fireballCoreMesh = makeMesh(
    deformOrganicSphere(new THREE.SphereGeometry(0.34, 10, 7), 1.18, 0.92),
    additive(1),
    FIREBALLS,
    22,
  );
  private readonly fireballShellMesh = makeMesh(
    deformOrganicSphere(new THREE.IcosahedronGeometry(0.66, 1), 1.12, 0.96),
    additive(0.38),
    FIREBALLS,
    21,
  );
  private readonly arrowShaftMesh = makeMesh(
    new THREE.CylinderGeometry(0.026, 0.026, 0.68, 5),
    new THREE.MeshBasicMaterial({ color: 0x2b2117, toneMapped: true }),
    ARROWS,
    20,
  );
  private readonly arrowHeadMesh = makeMesh(
    new THREE.ConeGeometry(0.09, 0.22, 5),
    new THREE.MeshBasicMaterial({ color: 0xe7c13d, toneMapped: true }),
    ARROWS,
    20,
  );
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
  private readonly lightningNodeCoreMesh = makeMesh(
    new THREE.OctahedronGeometry(0.22, 0),
    additive(0.96),
    LIGHTNING_NODES,
    25,
  );
  private readonly lightningNodeHaloMesh = makeMesh(
    new THREE.IcosahedronGeometry(0.34, 1),
    additive(0.22),
    LIGHTNING_NODES,
    24,
  );
  private readonly spawnCocoonMesh = makeMesh(
    deformOrganicSphere(new THREE.SphereGeometry(0.52, 8, 6), 1.46, 0.92),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    }),
    SPAWN_COCOONS,
    16,
  );

  private particleCursor = 0;
  private deathParticleCursor = 0;
  private spellParticleCursor = 0;
  private smokeParticleCursor = 0;
  private acidDropCursor = 0;
  private spawnParticleCursor = 0;
  private ringCursor = 0;
  private deathRingCursor = 0;
  private spellRingCursor = 0;
  private spawnRingCursor = 0;
  private burnMarkCursor = 0;
  private fireballCursor = 0;
  private arrowCursor = 0;
  private lightningCursor = 0;
  private lightningNodeCursor = 0;
  private spawnCocoonCursor = 0;
  private effectSerial = 1;
  private lastConsumedTick = Number.MIN_SAFE_INTEGER;
  private disposed = false;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly direction = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private readonly nextPosition = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly euler = new THREE.Euler();
  private readonly horizontalRing = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = "combat-effects";
    this.group.add(
      this.burnMarkMesh,
      this.deathRingMesh, this.deathParticleMesh, this.smokeParticleMesh,
      this.spawnRingMesh, this.spawnCocoonMesh, this.spawnParticleMesh,
      this.ringMesh, this.particleMesh, this.spellRingMesh, this.spellParticleMesh, this.acidDropMesh,
      this.fireballShellMesh, this.fireballCoreMesh, this.arrowShaftMesh, this.arrowHeadMesh,
      this.lightningGlowMesh, this.lightningCoreMesh,
      this.lightningNodeHaloMesh, this.lightningNodeCoreMesh,
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
    // Projectile damage follows an entity identity, so its visible trajectory
    // follows that same moving identity instead of a stale launch coordinate.
    this.retargetActiveArrows(current, previous);
    events.forEach((rawEvent, index) => {
      const event = rawEvent as CompatibleEvent;
      const seed = (event.tick * 1_103_515_245 + index * 12_345 + this.effectSerial++) | 0;
      switch (event.type) {
        case "spawn": {
          const point = this.entityPoint(event.entityId, current, previous);
          if (point) this.spawnArrival(now, point, seed);
          break;
        }
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
        case "projectile-cast": {
          this.spawnArrowFlight(now, event, current, previous);
          break;
        }
        case "projectile-impact": {
          this.completeArrow(event.projectileId);
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
            this.spawnLightningCharge(now, destination, seed);
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
    this.updateArrows(now);
    this.updateFireballs(now);
    this.updateParticlePool(now, this.particles, this.particleMesh);
    this.updateParticlePool(now, this.deathParticles, this.deathParticleMesh);
    this.updateParticlePool(now, this.spellParticles, this.spellParticleMesh);
    this.updateParticlePool(now, this.smokeParticles, this.smokeParticleMesh);
    this.updateParticlePool(now, this.acidDrops, this.acidDropMesh);
    this.updateParticlePool(now, this.spawnParticles, this.spawnParticleMesh);
    this.updateRingPool(now, this.rings, this.ringMesh);
    this.updateRingPool(now, this.deathRings, this.deathRingMesh);
    this.updateRingPool(now, this.spellRings, this.spellRingMesh);
    this.updateRingPool(now, this.spawnRings, this.spawnRingMesh);
    this.updateBurnMarks(now);
    this.updateLightning(now);
    this.updateLightningNodes(now);
    this.updateSpawnCocoons(now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    const meshes = [
      this.deathParticleMesh, this.smokeParticleMesh, this.deathRingMesh, this.burnMarkMesh,
      this.spawnParticleMesh, this.spawnRingMesh, this.spawnCocoonMesh,
      this.particleMesh, this.spellParticleMesh, this.acidDropMesh, this.ringMesh, this.spellRingMesh,
      this.fireballCoreMesh, this.fireballShellMesh, this.arrowShaftMesh, this.arrowHeadMesh,
      this.lightningCoreMesh, this.lightningGlowMesh,
      this.lightningNodeCoreMesh, this.lightningNodeHaloMesh,
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
    return node ? { x: node.position.x, y: 3.8, z: node.position.z, owner: playerId } : null;
  }

  private spawnArrival(now: number, point: Point, seed: number): void {
    const factionColor = FACTION_COLORS[point.owner] ?? 0x9bea52;
    const cocoon = this.spawnCocoons[this.spawnCocoonCursor];
    this.spawnCocoonCursor = (this.spawnCocoonCursor + 1) % this.spawnCocoons.length;
    if (cocoon) {
      Object.assign(cocoon, {
        active: true,
        bornAt: now,
        lifetime: 780,
        x: point.x,
        z: point.z,
        height: THREE.MathUtils.clamp(point.y, 0.85, 3.8),
        color: factionColor,
        seed,
      });
    }
    this.spawnSpawnRing(now, point.x, 0.16, point.z, 0.16, 1.35, 520, factionColor);
    this.spawnSpawnRing(now, point.x, 0.19, point.z, 1.05, 0.24, 420, 0xdffff0);
    for (let index = 0; index < 10; index += 1) {
      const sample = seed + index * 43;
      const angle = this.noise(sample) * Math.PI * 2;
      const radius = 0.22 + this.noise(sample + 1) * 0.62;
      const speed = 0.35 + this.noise(sample + 2) * 1.15;
      this.spawnSpawnParticle({
        now,
        x: point.x + Math.cos(angle) * radius,
        y: 0.22 + this.noise(sample + 3) * point.y * 0.62,
        z: point.z + Math.sin(angle) * radius,
        vx: Math.cos(angle) * speed,
        vy: 1.25 + this.noise(sample + 4) * 2.2,
        vz: Math.sin(angle) * speed,
        gravity: 2.8,
        lifetime: 460 + this.noise(sample + 5) * 360,
        startScale: 0.48 + this.noise(sample + 6) * 0.48,
        endScale: 0.04,
        color: index % 3 === 0 ? 0xeaffd4 : factionColor,
        spin: angle,
      });
    }
  }

  private spawnImpact(now: number, target: Point, source: Point | null, amount: number, seed: number): void {
    const dx = source ? target.x - source.x : 0;
    const dz = source ? target.z - source.z : 0;
    const length = Math.max(0.001, Math.hypot(dx, dz));
    const hitX = dx / length;
    const hitZ = dz / length;
    const strength = THREE.MathUtils.clamp(amount / 320, 0.45, 1.45);
    const factionColor = FACTION_COLORS[target.owner] ?? 0x7fc74c;
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
        color: index % 3 === 0 ? factionColor : index % 2 === 0 ? 0xd9f1a4 : 0x49372b,
        spin: angle,
      });
    }
    this.spawnRing(now, target.x, 0.2, target.z, 0.18, 0.9 + strength * 0.3, 230, factionColor);
    this.spawnRing(now, target.x, 0.22, target.z, 0.68, 0.12, 180, 0xf2ffd2);
  }

  private spawnDeath(now: number, point: Point, seed: number): void {
    const factionColor = FACTION_COLORS[point.owner] ?? 0xb0a486;
    for (let index = 0; index < 15; index += 1) {
      const angle = this.noise(seed + index * 29) * Math.PI * 2;
      const speed = 1.2 + this.noise(seed + index * 29 + 1) * 3.5;
      this.spawnDeathParticle({
        now, x: point.x, y: Math.max(0.35, point.y * 0.45), z: point.z,
        vx: Math.cos(angle) * speed,
        vy: 1.2 + this.noise(seed + index * 29 + 2) * 3.8,
        vz: Math.sin(angle) * speed,
        gravity: 8.5, lifetime: 420 + this.noise(seed + index * 29 + 3) * 360,
        startScale: 0.75 + this.noise(seed + index * 29 + 4) * 0.72, endScale: 0.12,
        color: index % 3 === 0 ? factionColor : index % 2 === 0 ? 0x5f4b38 : 0x29231d,
        spin: angle,
      });
    }
    for (let index = 0; index < 4; index += 1) {
      const sample = seed + 70_001 + index * 61;
      const angle = this.noise(sample) * Math.PI * 2;
      this.spawnSmokeParticle({
        now,
        x: point.x + Math.cos(angle) * 0.2,
        y: Math.max(0.24, point.y * 0.24),
        z: point.z + Math.sin(angle) * 0.2,
        vx: Math.cos(angle) * 0.32,
        vy: 0.55 + this.noise(sample + 1) * 0.75,
        vz: Math.sin(angle) * 0.32,
        gravity: -0.05,
        lifetime: 720 + this.noise(sample + 2) * 480,
        startScale: 0.35 + this.noise(sample + 3) * 0.3,
        endScale: 1.35 + this.noise(sample + 4) * 0.65,
        color: index % 2 === 0 ? 0x2c2924 : 0x4b4337,
        spin: angle,
      });
    }
    this.spawnDeathRing(now, point.x, 0.18, point.z, 0.28, 1.95, 560, factionColor);
    this.spawnDeathRing(now, point.x, 0.2, point.z, 1.25, 0.18, 430, 0x352a22);
  }

  private spawnArrowFlight(
    now: number,
    event: Extract<SimEvent, { type: "projectile-cast" }>,
    current: NormalizedSnapshot,
    previous: NormalizedSnapshot,
  ): void {
    const source = this.entityPoint(event.sourceId, current, previous);
    const target = event.targetType === "entity"
      ? this.entityPoint(event.targetId, current, previous)
      : this.castlePoint(event.targetId);
    const slot = this.arrows[this.arrowCursor];
    this.arrowCursor = (this.arrowCursor + 1) % this.arrows.length;
    if (!slot) return;
    const horizontalDistance = Math.hypot(
      event.destination.x - event.origin.x,
      event.destination.z - event.origin.z,
    );
    Object.assign(slot, {
      active: true,
      projectileId: event.projectileId,
      bornAt: now,
      duration: Math.max(MIN_VISIBLE_ARROW_MS, (event.impactTick - event.tick) * TICK_MS),
      targetType: event.targetType,
      targetId: event.targetId,
      startX: event.origin.x,
      startY: Math.max(1.08, (source?.y ?? 1.46) * 0.84),
      startZ: event.origin.z,
      endX: event.destination.x,
      endY: event.targetType === "castle"
        ? Math.max(2.4, (target?.y ?? 4.8) * 0.62)
        : Math.max(0.72, (target?.y ?? 1.48) * 0.62),
      endZ: event.destination.z,
      arcHeight: THREE.MathUtils.clamp(horizontalDistance * 0.055, 0.18, 0.72),
    });
  }

  private retargetActiveArrows(
    current: NormalizedSnapshot,
    previous: NormalizedSnapshot,
  ): void {
    for (const slot of this.arrows) {
      if (!slot.active) continue;
      const target = slot.targetType === "entity"
        ? this.entityPoint(slot.targetId, current, previous)
        : this.castlePoint(slot.targetId);
      if (!target) continue;
      slot.endX = target.x;
      slot.endZ = target.z;
      slot.endY = slot.targetType === "castle"
        ? Math.max(2.4, target.y * 0.62)
        : Math.max(0.72, target.y * 0.62);
    }
  }
  private completeArrow(projectileId: number): void {
    const slot = this.arrows.find((candidate) => candidate.active && candidate.projectileId === projectileId);
    if (slot) slot.active = false;
  }

  private arrowPoint(slot: Arrow, progress: number, target: THREE.Vector3): THREE.Vector3 {
    const t = THREE.MathUtils.clamp(progress, 0, 1);
    return target.set(
      THREE.MathUtils.lerp(slot.startX, slot.endX, t),
      THREE.MathUtils.lerp(slot.startY, slot.endY, t) + Math.sin(t * Math.PI) * slot.arcHeight,
      THREE.MathUtils.lerp(slot.startZ, slot.endZ, t),
    );
  }

  private updateArrows(now: number): void {
    let count = 0;
    for (const slot of this.arrows) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / Math.max(1, slot.duration);
      if (progress >= 1) {
        slot.active = false;
        continue;
      }
      this.arrowPoint(slot, progress, this.position);
      this.arrowPoint(slot, Math.min(1, progress + 0.025), this.nextPosition);
      this.direction.copy(this.nextPosition).sub(this.position);
      if (this.direction.lengthSq() < 0.000001) {
        this.direction.set(slot.endX - slot.startX, slot.endY - slot.startY, slot.endZ - slot.startZ);
      }
      this.direction.normalize();
      this.quaternion.setFromUnitVectors(UP, this.direction);
      this.scale.set(1, 1, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.arrowShaftMesh.setMatrixAt(count, this.matrix);

      this.midpoint.copy(this.position).addScaledVector(this.direction, 0.43);
      this.matrix.compose(this.midpoint, this.quaternion, this.scale);
      this.arrowHeadMesh.setMatrixAt(count, this.matrix);
      count += 1;
    }
    for (const mesh of [this.arrowShaftMesh, this.arrowHeadMesh]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
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
    this.spawnSpellRing(now, slot.startX, 0.22, slot.startZ, 0.25, 1.4, 360, 0x9be85d);
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
          this.spawnAcidDrop({
            now, x: this.position.x, y: this.position.y, z: this.position.z,
            vx: Math.cos(angle) * speed, vy: -0.4 + this.noise(sample + 2) * 1.2,
            vz: Math.sin(angle) * speed, gravity: 1.4,
            lifetime: 260 + this.noise(sample + 3) * 180,
            startScale: spark === 0 ? 1.15 : 0.72, endScale: 0.04,
            color: spark === 0 ? 0xc6ff73 : 0x69d13f, spin: angle,
          });
        }
        if (step % 3 === 0) {
          const glowSeed = slot.seed + step * 173;
          const glowAngle = this.noise(glowSeed) * Math.PI * 2;
          this.spawnSpellParticle({
            now,
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
            vx: Math.cos(glowAngle) * 0.34,
            vy: 0.18,
            vz: Math.sin(glowAngle) * 0.34,
            gravity: 0,
            lifetime: 240,
            startScale: 0.58,
            endScale: 0.02,
            color: 0xefffc5,
            spin: glowAngle,
          });
        }
        if (step % 2 === 0) {
          const smokeSeed = slot.seed + step * 131;
          const smokeAngle = this.noise(smokeSeed) * Math.PI * 2;
          this.spawnSmokeParticle({
            now, x: this.position.x + Math.cos(smokeAngle) * 0.12, y: this.position.y + 0.08,
            z: this.position.z + Math.sin(smokeAngle) * 0.12,
            vx: Math.cos(smokeAngle) * 0.18, vy: 0.28 + this.noise(smokeSeed + 1) * 0.4,
            vz: Math.sin(smokeAngle) * 0.18, gravity: -0.08,
            lifetime: 620 + this.noise(smokeSeed + 2) * 360,
            startScale: 0.38 + this.noise(smokeSeed + 3) * 0.24, endScale: 1.35 + this.noise(smokeSeed + 4) * 0.5,
            color: this.noise(smokeSeed + 5) > 0.55 ? 0x4a4039 : 0x655246, spin: smokeAngle,
          });
        }
      }
      slot.lastTrailStep = Math.max(slot.lastTrailStep, trailStep);
      this.fireballPoint(slot, progress, this.position);
      const pulse = 0.94 + Math.sin(now * 0.025 + slot.castId) * 0.12;
      this.quaternion.setFromEuler(this.euler.set(now * 0.003, now * 0.006, now * 0.004));
      this.scale.setScalar(pulse);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.fireballCoreMesh.setMatrixAt(count, this.matrix);
      this.fireballCoreMesh.setColorAt(count, this.color.setHex(0xeaffad));
      this.scale.setScalar(0.92 + Math.sin(now * 0.017 + slot.castId * 0.7) * 0.14);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.fireballShellMesh.setMatrixAt(count, this.matrix);
      this.fireballShellMesh.setColorAt(count, this.color.setHex(0x5fcf35));
      count += 1;
    }
    for (const mesh of [this.fireballCoreMesh, this.fireballShellMesh]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private spawnFireballImpact(now: number, point: Point, seed: number): void {
    this.spawnSpellRing(now, point.x, 0.2, point.z, 0.18, 5.5, 660, 0x5fcf35);
    this.spawnSpellRing(now, point.x, 0.23, point.z, 0.12, 3.6, 430, 0xd9ff84);
    this.spawnBurnMark(now, point.x, point.z, seed);
    for (let index = 0; index < 30; index += 1) {
      const angle = this.noise(seed + index * 41) * Math.PI * 2;
      const radial = 2.4 + this.noise(seed + index * 41 + 1) * 8.6;
      this.spawnAcidDrop({
        now,
        x: point.x + Math.cos(angle) * 0.15,
        y: 0.42 + this.noise(seed + index * 41 + 2) * 0.65,
        z: point.z + Math.sin(angle) * 0.15,
        vx: Math.cos(angle) * radial,
        vy: 3.8 + this.noise(seed + index * 41 + 3) * 9.2,
        vz: Math.sin(angle) * radial,
        gravity: 13,
        lifetime: 480 + this.noise(seed + index * 41 + 4) * 460,
        startScale: index < 7 ? 2.35 : 0.72 + this.noise(seed + index * 41 + 5) * 1.2,
        endScale: 0.06,
        color: index % 4 === 0 ? 0xf1ffb5 : index % 2 === 0 ? 0x9bea52 : 0x42b83a,
        spin: angle,
      });
    }
    for (let index = 0; index < 10; index += 1) {
      const sample = seed + 80_009 + index * 37;
      const angle = this.noise(sample) * Math.PI * 2;
      const speed = 1.2 + this.noise(sample + 1) * 3.2;
      this.spawnSpellParticle({
        now,
        x: point.x,
        y: 0.45 + this.noise(sample + 2) * 0.5,
        z: point.z,
        vx: Math.cos(angle) * speed,
        vy: 2.1 + this.noise(sample + 3) * 4.1,
        vz: Math.sin(angle) * speed,
        gravity: 5.4,
        lifetime: 420 + this.noise(sample + 4) * 360,
        startScale: 0.7 + this.noise(sample + 5) * 0.62,
        endScale: 0.025,
        color: index % 2 === 0 ? 0xf4ffd4 : 0x9dff62,
        spin: angle,
      });
    }
    this.spawnFireballSmoke(now, point, seed);
  }

  private spawnFireballSmoke(now: number, point: Point, seed: number): void {
    for (let index = 0; index < 12; index += 1) {
      const sample = seed + 10_003 + index * 67;
      const angle = this.noise(sample) * Math.PI * 2;
      const radial = 0.32 + this.noise(sample + 1) * 1.15;
      this.spawnSmokeParticle({
        now,
        x: point.x + Math.cos(angle) * (0.2 + this.noise(sample + 2) * 0.65),
        y: 0.48 + this.noise(sample + 3) * 0.85,
        z: point.z + Math.sin(angle) * (0.2 + this.noise(sample + 4) * 0.65),
        vx: Math.cos(angle) * radial,
        vy: 1.35 + this.noise(sample + 5) * 1.75,
        vz: Math.sin(angle) * radial,
        gravity: 0.32,
        lifetime: 1_550 + this.noise(sample + 6) * 950,
        startScale: 0.72 + this.noise(sample + 7) * 0.55,
        endScale: 2.8 + this.noise(sample + 8) * 1.25,
        color: index % 3 === 0 ? 0x30462b : index % 2 === 0 ? 0x506746 : 0x6d8154,
        spin: angle,
      });
    }
  }

  private spawnLightningCharge(now: number, point: Point, seed: number): void {
    this.spawnSpellRing(now, point.x, 0.2, point.z, 0.25, 2.35, 360, 0x8edfff);
    this.spawnSpellRing(now, point.x, 0.22, point.z, 1.7, 0.5, 330, 0xe8fbff);
    this.spawnLightningNode(now, point.x, 0.58, point.z, 430, 0x9de9ff, seed);
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
    this.spawnLightningNode(now, point.x, 0.68, point.z, 660, 0xc8f5ff, seed);
    targets.forEach((target, index) => {
      this.spawnLightningNode(
        now,
        target.x,
        Math.max(0.4, target.y * 0.68),
        target.z,
        620,
        index % 2 === 0 ? 0xb8f4ff : 0x86d9ff,
        seed + 4_099 + index * 149,
      );
    });
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
      } else {
        const branchFrom: Point = {
          x: THREE.MathUtils.lerp(connection.from.x, connection.to.x, 0.72),
          y: THREE.MathUtils.lerp(connection.from.y, connection.to.y, 0.72),
          z: THREE.MathUtils.lerp(connection.from.z, connection.to.z, 0.72),
          owner: connection.to.owner,
        };
        for (const sign of [-1, 1]) {
          const branchTo: Point = {
            x: connection.to.x + sign * (0.34 + this.noise(connection.seed + sign * 53) * 0.38),
            y: connection.to.y + 0.22 + this.noise(connection.seed + sign * 71) * 0.42,
            z: connection.to.z - sign * (0.18 + this.noise(connection.seed + sign * 97) * 0.32),
            owner: connection.to.owner,
          };
          this.addJaggedConnection(
            slot.segments,
            branchFrom,
            branchTo,
            connection.seed + sign * 11_123 + jitterStep * 2_971,
          );
        }
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

  private spawnDeathParticle(options: ParticleOptions): void {
    this.deathParticleCursor = this.writeParticle(this.deathParticles, this.deathParticleCursor, options);
  }

  private spawnSpellParticle(options: ParticleOptions): void {
    this.spellParticleCursor = this.writeParticle(this.spellParticles, this.spellParticleCursor, options);
  }

  private spawnSmokeParticle(options: ParticleOptions): void {
    this.smokeParticleCursor = this.writeParticle(this.smokeParticles, this.smokeParticleCursor, options);
  }

  private spawnAcidDrop(options: ParticleOptions): void {
    this.acidDropCursor = this.writeParticle(this.acidDrops, this.acidDropCursor, options);
  }

  private spawnSpawnParticle(options: ParticleOptions): void {
    this.spawnParticleCursor = this.writeParticle(
      this.spawnParticles,
      this.spawnParticleCursor,
      options,
    );
  }

  private spawnLightningNode(
    now: number,
    x: number,
    y: number,
    z: number,
    lifetime: number,
    color: number,
    seed: number,
  ): void {
    const slot = this.lightningNodes[this.lightningNodeCursor];
    this.lightningNodeCursor = (this.lightningNodeCursor + 1) % this.lightningNodes.length;
    if (slot) Object.assign(slot, { active: true, bornAt: now, lifetime, x, y, z, color, seed });
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

  private spawnDeathRing(
    now: number, x: number, y: number, z: number,
    startScale: number, endScale: number, lifetime: number, color: number,
  ): void {
    this.deathRingCursor = this.writeRing(this.deathRings, this.deathRingCursor, now, x, y, z, startScale, endScale, lifetime, color);
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

  private spawnSpawnRing(
    now: number,
    x: number,
    y: number,
    z: number,
    startScale: number,
    endScale: number,
    lifetime: number,
    color: number,
  ): void {
    this.spawnRingCursor = this.writeRing(
      this.spawnRings,
      this.spawnRingCursor,
      now,
      x,
      y,
      z,
      startScale,
      endScale,
      lifetime,
      color,
    );
  }

  private spawnBurnMark(now: number, x: number, z: number, seed: number): void {
    const slot = this.burnMarks[this.burnMarkCursor];
    this.burnMarkCursor = (this.burnMarkCursor + 1) % this.burnMarks.length;
    if (!slot) return;
    Object.assign(slot, {
      active: true, bornAt: now, lifetime: 18_000, x, y: 0.085, z,
      scale: 2.55 + this.noise(seed + 50_021) * 0.75,
      rotation: this.noise(seed + 50_023) * Math.PI * 2,
      color: this.noise(seed + 50_027) > 0.5 ? 0x294023 : 0x3f5629,
    });
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
      this.quaternion.setFromEuler(
        this.euler.set(slot.spin * age * 2.1, slot.spin + age * 3.4, slot.spin * 0.37),
      );
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

  private updateBurnMarks(now: number): void {
    let count = 0;
    for (const slot of this.burnMarks) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        continue;
      }
      const appear = THREE.MathUtils.smoothstep(progress, 0, 0.035);
      const release = 1 - THREE.MathUtils.smoothstep(progress, 0.88, 1);
      const size = slot.scale * appear * (0.78 + release * 0.22);
      this.position.set(slot.x, slot.y, slot.z);
      this.quaternion.setFromAxisAngle(UP, slot.rotation).multiply(this.horizontalRing);
      this.scale.set(size, size, size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.burnMarkMesh.setMatrixAt(count, this.matrix);
      this.burnMarkMesh.setColorAt(count, this.color.setHex(slot.color));
      count += 1;
    }
    this.burnMarkMesh.count = count;
    this.burnMarkMesh.instanceMatrix.needsUpdate = true;
    if (this.burnMarkMesh.instanceColor) this.burnMarkMesh.instanceColor.needsUpdate = true;
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

  private updateLightningNodes(now: number): void {
    let count = 0;
    for (const slot of this.lightningNodes) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        continue;
      }
      const appear = THREE.MathUtils.smoothstep(progress, 0, 0.08);
      const release = 1 - THREE.MathUtils.smoothstep(progress, 0.56, 1);
      const flicker = 0.82 + Math.sin(now * 0.072 + slot.seed * 0.013) * 0.18;
      const intensity = Math.max(0.035, appear * release * flicker);
      const pulse = 0.78 + Math.abs(Math.sin(now * 0.036 + slot.seed)) * 0.42;
      this.position.set(
        slot.x,
        slot.y + Math.sin(now * 0.018 + slot.seed * 0.1) * 0.035,
        slot.z,
      );
      this.quaternion.setFromEuler(
        this.euler.set(now * 0.002 + slot.seed, now * 0.0031, now * 0.0017),
      );
      this.scale.setScalar(pulse * (0.78 + appear * 0.22));
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.lightningNodeCoreMesh.setMatrixAt(count, this.matrix);
      this.lightningNodeCoreMesh.setColorAt(
        count,
        this.color.setHex(0xf4ffff).multiplyScalar(intensity),
      );

      this.scale.setScalar(pulse * 1.9 * (0.72 + release * 0.28));
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.lightningNodeHaloMesh.setMatrixAt(count, this.matrix);
      this.lightningNodeHaloMesh.setColorAt(
        count,
        this.color.setHex(slot.color).multiplyScalar(Math.max(0.025, intensity * 0.78)),
      );
      count += 1;
    }
    for (const mesh of [this.lightningNodeCoreMesh, this.lightningNodeHaloMesh]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private updateSpawnCocoons(now: number): void {
    let count = 0;
    for (const slot of this.spawnCocoons) {
      if (!slot.active) continue;
      const progress = (now - slot.bornAt) / slot.lifetime;
      if (progress >= 1) {
        slot.active = false;
        continue;
      }
      const appear = THREE.MathUtils.smoothstep(progress, 0, 0.15);
      const split = THREE.MathUtils.smoothstep(progress, 0.48, 1);
      const fade = 1 - THREE.MathUtils.smoothstep(progress, 0.68, 1);
      const breathe = 1 + Math.sin(now * 0.022 + slot.seed * 0.01) * 0.075;
      const width = (0.54 + split * 0.34) * breathe;
      this.position.set(slot.x, Math.max(0.42, slot.height * 0.49), slot.z);
      this.quaternion.setFromEuler(
        this.euler.set(0, slot.seed * 0.001 + progress * 0.82, split * 0.24),
      );
      this.scale.set(
        width * appear,
        Math.max(0.05, slot.height * 0.68 * appear * (1 - split * 0.18)),
        width * appear,
      );
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.spawnCocoonMesh.setMatrixAt(count, this.matrix);
      this.spawnCocoonMesh.setColorAt(
        count,
        this.color.setHex(slot.color).multiplyScalar(Math.max(0.025, fade * 0.82)),
      );
      count += 1;
    }
    this.spawnCocoonMesh.count = count;
    this.spawnCocoonMesh.instanceMatrix.needsUpdate = true;
    if (this.spawnCocoonMesh.instanceColor) this.spawnCocoonMesh.instanceColor.needsUpdate = true;
  }

  private noise(seed: number): number {
    let value = seed | 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 4_294_967_295;
  }
}
