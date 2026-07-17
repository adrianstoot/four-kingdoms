import * as THREE from "three";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { toonOutlinePass } from "three/tsl";
import { CONTENT, MAP_GRAPH, type CardId } from "@kingdoms/content";
import { findBestPlacement, type GameSnapshot } from "@kingdoms/sim";
import { CombatEffects } from "./CombatEffects";
import { normalizeGameSnapshot } from "./normalizeSimSnapshot";
import {
  FACTIONS,
  LOCAL_PLAYER_ID,
  MAP_HALF_SIZE,
  MAX_RENDERED_UNITS,
  UNIT_ARCHETYPES,
  UNIT_POSES,
  buildLanes,
  createCannonTowerGeometry,
  createCastle,
  createCenterObjective,
  createGroundDetails,
  createTerrain,
  createToonMaterial,
  createUnitGeometry,
  createVegetation,
  unitArchetype,
  type CastleVisual,
  type CenterVisual,
  type LaneVisual,
  type UnitArchetype,
  type UnitPose,
  type VegetationBatch,
} from "./procedural";
import {
  cloneFactionMaterials,
  frameIndexForPhase,
  loadExternalUnitLibrary,
  unitMotion,
  type ExternalUnitAsset,
  type ExternalUnitLibrary,
} from "./units/gltfUnitAssets";
import { visualUnitPose } from "./units/visualUnitPose";
import type { CameraPose, NormalizedSnapshot, NormalizedUnit, QualityPreset } from "./types";

export type { QualityPreset } from "./types";

export type RendererBackend = "webgpu" | "webgl2";
export type PlacementKind = "unit" | "building" | "spell";

export interface RendererPlacement {
  x: number;
  z: number;
  routeId: string | null;
  valid: boolean;
}

/** Rich placement retained for the first UI integration; the four base fields are the stable API. */
export interface PlacementPreview {
  cardId: string;
  kind: PlacementKind;
  playerId: number;
  x: number;
  z: number;
  routeId: string;
  valid: boolean;
  laneId: string;
  routeT: number;
  direction: 1 | -1;
  reason?: "outside-map" | "outside-lane" | "enemy-zone" | "invalid-pad";
}

export interface WorldRendererMetrics {
  fps: number;
  frameMs: number;
  frameTimeMs: number;
  p95FrameMs: number;
  p95FrameTimeMs: number;
  drawCalls: number;
  triangles: number;
  backend: RendererBackend;
  units: number;
  quality: QualityPreset;
  pixelRatio: number;
}

/** Both callback spellings are accepted while the React shell migrates to the compact contract. */
export interface WorldRendererCallbacks {
  onPlace?: (placement: RendererPlacement) => void;
  onHover?: (placement: RendererPlacement) => void;
  onMetrics?: (metrics: WorldRendererMetrics) => void;
  onDeploy?: (placement: PlacementPreview) => void;
  onPlacementChange?: (placement: PlacementPreview | null) => void;
  onReady?: (backend: RendererBackend) => void;
  onResourcesReady?: () => void;
  onResourceProgress?: (progress: { progress: number; label?: string }) => void;
  /** Published only after a snapshot from this session has been rendered. */
  onFirstFrame?: (sessionId: number) => void;
  onCameraPoseChange?: (pose: CameraPose) => void;
  onCancelSelection?: () => void;
  onError?: (error: Error) => void;
}

interface QualitySettings {
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  vegetationDensity: number;
}

interface UnitBatch {
  units: Map<UnitVisualKey, THREE.InstancedMesh>;
  outlines: Map<UnitVisualKey, THREE.InstancedMesh>;
  buildings: THREE.InstancedMesh;
}

type UnitVisualKey = string;

interface PlacementPad {
  point: THREE.Vector3;
  laneId: string;
  routeId: string;
  direction: 1 | -1;
}

interface GhostVisual {
  group: THREE.Group;
  unit: THREE.Mesh;
  building: THREE.Mesh;
  spell: THREE.Mesh;
  materials: THREE.Material[];
}

const QUALITY: Record<QualityPreset, QualitySettings> = {
  low: { maxPixelRatio: 1, shadows: false, shadowMapSize: 512, vegetationDensity: 0.42 },
  medium: { maxPixelRatio: 1, shadows: true, shadowMapSize: 1024, vegetationDensity: 0.72 },
  high: { maxPixelRatio: 1.25, shadows: true, shadowMapSize: 1536, vegetationDensity: 0.86 },
  ultra: { maxPixelRatio: 1.5, shadows: true, shadowMapSize: 2048, vegetationDensity: 1 },
};

const EMPTY_SNAPSHOT = normalizeGameSnapshot(null);
const CAMERA_FOV = 38;
const MIN_CAMERA_PITCH = THREE.MathUtils.degToRad(28);
const MAX_CAMERA_PITCH = THREE.MathUtils.degToRad(65);
const MIN_CAMERA_DISTANCE = 32;
const MAX_CAMERA_DISTANCE = 145;
const CAMERA_TARGET_LIMIT = 52;
const EDGE_PAN_SIZE = 14;

function materialArray(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function lerpAngle(from: number, to: number, alpha: number): number {
  const delta = THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
  return from + delta * alpha;
}

function unitVisualKey(archetype: UnitArchetype, pose: UnitPose): UnitVisualKey {
  return `${archetype}:${pose}`;
}
function externalUnitVisualKey(archetype: UnitArchetype, motion: string, frame: number): UnitVisualKey {
  return `${archetype}:${motion}:${frame}`;
}


function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

export class WorldRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 360);

  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: WorldRendererCallbacks;
  private renderer: WebGPURenderer | null = null;
  private renderPipeline: RenderPipeline | null = null;
  private backend: RendererBackend = "webgl2";
  private disposed = false;
  private initialized = false;
  private worldBuilt = false;

  private readonly lanes: LaneVisual[] = buildLanes(MAP_GRAPH);
  private readonly towerPads: PlacementPad[] = MAP_GRAPH.towerPads
    .filter((pad) => pad.playerId === LOCAL_PLAYER_ID)
    .map((pad) => {
      const route = MAP_GRAPH.routes.find((candidate) => candidate.id === pad.routeIds[0]);
      return {
        point: new THREE.Vector3(pad.position.x, 0.16, pad.position.z),
        laneId: pad.laneId,
        routeId: pad.routeIds[0] ?? pad.laneId,
        direction: route?.steps[0]?.reverse ? -1 : 1,
      };
    });
  private vegetation: VegetationBatch[] = [];
  private towerPadMarkers: THREE.InstancedMesh | null = null;
  private castles: CastleVisual[] = [];
  private center: CenterVisual | null = null;
  private sun: THREE.DirectionalLight | null = null;

  private readonly unitBatches: UnitBatch[] = [];
  private shadowInstances: THREE.InstancedMesh | null = null;
  private healthBackInstances: THREE.InstancedMesh | null = null;
  private healthFillInstances: THREE.InstancedMesh | null = null;
  private combatEffects: CombatEffects | null = null;
  private externalUnitLibrary: ExternalUnitLibrary | null = null;

  private ghost: GhostVisual | null = null;
  private selectedCard: string | null = null;
  private selectedKind: PlacementKind = "unit";
  private currentPlacement: PlacementPreview | null = null;

  private previousSnapshot: NormalizedSnapshot = EMPTY_SNAPSHOT;
  private currentSnapshot: NormalizedSnapshot = EMPTY_SNAPSHOT;
  private snapshotReceivedAt = 0;
  private interpolationDuration = 50;

  private qualityPreset: QualityPreset = "medium";
  private pixelRatio = 1;
  private resizeObserver: ResizeObserver | null = null;

  private readonly cameraTarget = new THREE.Vector3(0, 0, 0);
  private readonly desiredCameraTarget = new THREE.Vector3(0, 0, 0);
  private yaw = THREE.MathUtils.degToRad(225);
  private targetYaw = this.yaw;
  private pitch = THREE.MathUtils.degToRad(45);
  private targetPitch = this.pitch;
  private distance = 118;
  private targetDistance = this.distance;
  private readonly pressedKeys = new Set<string>();

  private pointerDown = false;
  private pointerDragged = false;
  private pointerId = -1;
  private pointerButton = -1;
  private pointerX = 0;
  private pointerY = 0;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly pointerWorld = new THREE.Vector3();

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly shadowQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));
  private readonly cameraRight = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly zoomAnchor = new THREE.Vector3();
  private pointerInside = false;
  private pendingFrameSessionId = 0;
  private reportedFrameSessionId = 0;
  private lastPoseSignature = "";

  private lastFrameAt = 0;
  private lastMetricsAt = 0;
  private readonly frameTimes: number[] = [];

  constructor(canvas: HTMLCanvasElement, callbacks: WorldRendererCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.scene.background = new THREE.Color(0x1d2924);
    this.scene.fog = new THREE.FogExp2(0x243427, 0.0008);
    this.camera.up.set(0, 1, 0);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error("Cannot initialize a disposed WorldRenderer.");
    this.callbacks.onResourceProgress?.({ progress: 0.08, label: "Preparando terreno" });
    await this.buildWorld();
    if (this.disposed) throw new Error("WorldRenderer was disposed while loading terrain resources.");
    this.callbacks.onResourceProgress?.({ progress: 0.28, label: "Terreno ilustrado listo" });
    await this.loadRiggedUnitAssets();
    if (this.disposed) throw new Error("WorldRenderer was disposed while loading unit resources.");
    this.callbacks.onResourceProgress?.({ progress: 0.55, label: "Construyendo los reinos" });

    const requestWebGPU = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("webgpu");
    const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator && requestWebGPU;
    try {
      this.renderer = await this.createRenderer(!hasWebGPU);
      this.backend = hasWebGPU ? "webgpu" : "webgl2";
    } catch (error) {
      if (!hasWebGPU) throw error;
      this.renderer?.dispose();
      this.renderer = await this.createRenderer(true);
      this.backend = "webgl2";
    }
    if (!this.renderer) throw new Error("Renderer initialization did not complete.");
    this.callbacks.onResourceProgress?.({ progress: 0.82, label: "Preparando iluminaci?n" });
    this.renderPipeline = new RenderPipeline(this.renderer);
    this.renderPipeline.outputNode = toonOutlinePass(this.scene, this.camera, new THREE.Color(0x172019), 0.0018, 0.82);
    this.renderPipeline.needsUpdate = true;


    this.applyQuality();
    this.bindEvents();
    this.resize();
    this.applyCamera(0);
    this.callbacks.onResourceProgress?.({ progress: 0.92, label: "Compilando recursos graficos" });
    await this.renderer.compileAsync(this.scene, this.camera);
    if (this.disposed) throw new Error("WorldRenderer was disposed while compiling renderer resources.");
    // Force creation of the TSL/post-processing pipeline before declaring the
    // renderer resource set ready. The loading overlay still covers this warm-up.
    this.renderPipeline.render();
    this.initialized = true;
    await this.renderer.setAnimationLoop(this.onFrame);
    if (this.disposed) throw new Error("WorldRenderer was disposed before its render loop became ready.");
    this.callbacks.onReady?.(this.backend);
    this.callbacks.onResourceProgress?.({ progress: 1, label: "Campo de batalla listo" });
    this.callbacks.onResourcesReady?.();
    this.emitCameraPose(true);
  }

  setSnapshot(snapshot: GameSnapshot | null, sessionId = 0): void {
    const receivedAt = performance.now();
    if (this.snapshotReceivedAt > 0) {
      this.interpolationDuration = THREE.MathUtils.clamp(receivedAt - this.snapshotReceivedAt, 35, 120);
    }
    const previous = this.currentSnapshot;
    const current = snapshot ? normalizeGameSnapshot(snapshot) : EMPTY_SNAPSHOT;
    this.previousSnapshot = previous;
    this.currentSnapshot = current;
    this.snapshotReceivedAt = receivedAt;
    this.combatEffects?.consume(snapshot?.events ?? [], current, previous, snapshot?.tick ?? 0);
    this.updateStrategicObjects();
    this.updateVegetationOcclusion();
    if (!snapshot || sessionId <= 0) {
      this.pendingFrameSessionId = 0;
    } else if (sessionId !== this.reportedFrameSessionId) {
      this.pendingFrameSessionId = sessionId;
    }
  }

  setSelectedCard(card: string | null): void {
    this.selectedCard = card;
    this.selectedKind = this.cardKind(card);
    if (this.towerPadMarkers) this.towerPadMarkers.visible = card !== null && this.selectedKind === "building";
    if (this.ghost && card && this.selectedKind === "unit") {
      const definition = CONTENT.cards.find((candidate) => candidate.id === card);
      const visualKind = definition && "archetypeId" in definition ? definition.archetypeId : card;
      const previousGeometry = this.ghost.unit.geometry;
      this.ghost.unit.geometry = createUnitGeometry(visualKind, FACTIONS[0].color);
      previousGeometry.dispose();
    }

    if (this.ghost) this.ghost.group.visible = card !== null;
    if (!card) {
      this.currentPlacement = null;
      this.callbacks.onPlacementChange?.(null);
      this.canvas.style.cursor = "grab";
      return;
    }
    this.canvas.style.cursor = "crosshair";
    this.updatePlacementFromClient(this.pointerX, this.pointerY);
  }

  rotate(direction: -1 | 1): void {
    this.targetYaw += direction * THREE.MathUtils.degToRad(15);
  }

  recalculatePlacement(): void {
    if (this.selectedCard) this.updatePlacementFromClient(this.pointerX, this.pointerY);
  }

  setQuality(quality: QualityPreset): void {
    if (!(quality in QUALITY)) return;
    this.qualityPreset = quality;
    this.applyQuality();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindEvents();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderPipeline?.dispose();
    this.renderPipeline = null;
    if (this.renderer) {
      void this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer = null;
    }
    this.combatEffects?.dispose();
    this.combatEffects = null;

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) {
        for (const material of materialArray(mesh.material)) {
          materials.add(material);
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) textures.add(value);
          }
        }
      }
    });
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.scene.clear();
    this.externalUnitLibrary?.dispose();
    this.externalUnitLibrary = null;
  }

  private async createRenderer(forceWebGL: boolean): Promise<WebGPURenderer> {
    const renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: this.qualityPreset !== "low",
      samples: this.qualityPreset === "ultra" || this.qualityPreset === "high" ? 4 : 2,
      alpha: false,
      forceWebGL,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    await renderer.init();
    return renderer;
  }

  private async buildWorld(): Promise<void> {
    if (this.worldBuilt) return;
    const terrain = await createTerrain();
    this.scene.add(terrain);
    this.worldBuilt = true;
    this.scene.add(createGroundDetails(this.lanes));

    const hemisphere = new THREE.HemisphereLight(0xd9e4c9, 0x263323, 1.25);
    this.scene.add(hemisphere);
    this.sun = new THREE.DirectionalLight(0xffdfaa, 2.65);
    this.sun.position.set(-54, 82, 42);
    this.sun.castShadow = true;
    this.sun.shadow.camera.left = -82;
    this.sun.shadow.camera.right = 82;
    this.sun.shadow.camera.top = 82;
    this.sun.shadow.camera.bottom = -82;
    this.sun.shadow.camera.near = 8;
    this.sun.shadow.camera.far = 210;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.045;
    this.scene.add(this.sun, this.sun.target);

    this.vegetation = createVegetation(this.lanes);
    for (const batch of this.vegetation) this.scene.add(batch.group);

    for (let owner = 0; owner < 4; owner += 1) {
      const castle = createCastle(owner);
      const node = MAP_GRAPH.nodes.find((candidate) => candidate.playerId === owner);
      if (node) castle.group.position.set(node.position.x, 0, node.position.z);
      castle.group.rotation.y = Math.atan2(-castle.group.position.x, -castle.group.position.z);
      this.castles.push(castle);
      this.scene.add(castle.group);
    }

    this.center = createCenterObjective();
    this.scene.add(this.center.group);
    this.createTowerPadMarkers();
    this.createUnitInstances();
    this.combatEffects = new CombatEffects(this.scene);
    this.ghost = this.createGhost();
    this.scene.add(this.ghost.group);
    this.updateStrategicObjects();
  }
  private async loadRiggedUnitAssets(): Promise<void> {
    const library = await loadExternalUnitLibrary({
      onProgress: (progress, label) => {
        this.callbacks.onResourceProgress?.({ progress: 0.1 + progress * 0.3, label });
      },
    });
    if (this.disposed) {
      library.dispose();
      return;
    }
    this.externalUnitLibrary = library;
    for (const asset of library.assets.values()) this.installExternalUnitAsset(asset);
    for (const [archetype, error] of library.errors) {
      console.warn(`Could not load the rigged ${archetype}; keeping its procedural fallback.`, error);
    }
  }

  private installExternalUnitAsset(asset: ExternalUnitAsset): void {
    for (let owner = 0; owner < this.unitBatches.length; owner += 1) {
      const batch = this.unitBatches[owner];
      if (!batch) continue;
      const materials = cloneFactionMaterials(asset, owner);
      for (const [motion, frames] of asset.frames) {
        frames.forEach((frame, frameIndex) => {
          const key = externalUnitVisualKey(asset.archetype, motion, frameIndex);
          if (batch.units.has(key)) return;
          const mesh = new THREE.InstancedMesh(frame.geometry, materials, MAX_RENDERED_UNITS);
          mesh.name = `rigged-${owner}-${key}`;
          mesh.count = 0;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.castShadow = false;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          const outline = new THREE.InstancedMesh(
            frame.geometry,
            new THREE.MeshBasicMaterial({ color: 0x171d18, side: THREE.BackSide }),
            MAX_RENDERED_UNITS,
          );
          outline.name = `rigged-outline-${owner}-${key}`;
          outline.count = 0;
          outline.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          outline.castShadow = false;
          outline.receiveShadow = false;
          outline.frustumCulled = false;
          outline.renderOrder = -1;
          batch.units.set(key, mesh);
          batch.outlines.set(key, outline);
          this.scene.add(outline, mesh);
        });
      }
    }
  }

  private riggedUnitVisualKey(
    asset: ExternalUnitAsset,
    unit: NormalizedUnit,
    timeSeconds: number,
  ): UnitVisualKey {
    const motion = unitMotion(unit.state);
    const frames = asset.frames.get(motion) ?? asset.frames.get("idle") ?? [];
    let phase = unit.motionPhase;
    if (phase === 0 && unit.stateTick === 0 && (motion === "walk" || motion === "idle")) {
      const cyclesPerSecond = motion === "walk" ? 1.45 : 0.42;
      phase = Math.floor((timeSeconds * cyclesPerSecond + unit.id * 0.173) % 1 * 65_535);
    }
    return externalUnitVisualKey(asset.archetype, motion, frameIndexForPhase(frames.length, phase));
  }
  private createTowerPadMarkers(): void {
    const geometry = new THREE.CylinderGeometry(1.45, 1.65, 0.18, 12);
    const material = createToonMaterial({
      color: FACTIONS[0].color,
      emissive: FACTIONS[0].dark,
      emissiveIntensity: 0.18,
    });
    const pads = new THREE.InstancedMesh(geometry, material, Math.max(1, this.towerPads.length));
    this.towerPadMarkers = pads;
    pads.visible = false;
    this.towerPads.forEach((pad, index) => {
      this.matrix.compose(pad.point, this.quaternion.identity(), this.scale.set(1, 1, 1));
      pads.setMatrixAt(index, this.matrix);
    });
    pads.count = this.towerPads.length;
    pads.instanceMatrix.needsUpdate = true;
    pads.receiveShadow = true;
    this.scene.add(pads);
  }

  private createUnitInstances(): void {
    for (let owner = 0; owner < 4; owner += 1) {
      const faction = FACTIONS[owner] ?? FACTIONS[0];
      const units = new Map<UnitVisualKey, THREE.InstancedMesh>();
      const outlines = new Map<UnitVisualKey, THREE.InstancedMesh>();
      const unitMaterial = createToonMaterial({ color: 0xffffff, vertexColors: true });
      const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x1b201a, side: THREE.BackSide });
      for (const archetype of UNIT_ARCHETYPES) {
        for (const pose of UNIT_POSES) {
          const key = unitVisualKey(archetype, pose);
          const geometry = createUnitGeometry(archetype, faction.color, pose);
          const mesh = new THREE.InstancedMesh(
            geometry,
            unitMaterial,
            MAX_RENDERED_UNITS,
          );
          mesh.count = 0;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.castShadow = false;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          const outline = new THREE.InstancedMesh(geometry, outlineMaterial, MAX_RENDERED_UNITS);
          outline.count = 0;
          outline.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          outline.castShadow = false;
          outline.receiveShadow = false;
          outline.frustumCulled = false;
          outline.renderOrder = -1;
          units.set(key, mesh);
          outlines.set(key, outline);
          this.scene.add(outline, mesh);
        }
      }

      const buildings = new THREE.InstancedMesh(
        createCannonTowerGeometry(faction.color),
        createToonMaterial({ color: 0xffffff, vertexColors: true }),
        256,
      );
      buildings.count = 0;
      buildings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      buildings.castShadow = true;
      buildings.receiveShadow = true;
      buildings.frustumCulled = false;
      this.unitBatches.push({ units, outlines, buildings });
      this.scene.add(buildings);
    }

    const shadowGeometry = new THREE.CircleGeometry(0.48, 12);
    const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x11140f, transparent: true, opacity: 0.32, depthWrite: false });
    this.shadowInstances = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, MAX_RENDERED_UNITS);
    this.shadowInstances.count = 0;
    this.shadowInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowInstances.frustumCulled = false;

    const barGeometry = new THREE.PlaneGeometry(1, 0.12);
    this.healthBackInstances = new THREE.InstancedMesh(
      barGeometry,
      new THREE.MeshBasicMaterial({ color: 0x171b16, depthWrite: false, transparent: true, opacity: 0.9 }),
      MAX_RENDERED_UNITS,
    );
    this.healthFillInstances = new THREE.InstancedMesh(
      barGeometry,
      new THREE.MeshBasicMaterial({ color: 0x86e16f, depthWrite: false }),
      MAX_RENDERED_UNITS,
    );
    this.healthBackInstances.count = 0;
    this.healthFillInstances.count = 0;
    this.healthBackInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.healthFillInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.healthBackInstances.frustumCulled = false;
    this.healthFillInstances.frustumCulled = false;
    this.healthBackInstances.renderOrder = 20;
    this.healthFillInstances.renderOrder = 21;
    this.scene.add(this.shadowInstances, this.healthBackInstances, this.healthFillInstances);
  }

  private createGhost(): GhostVisual {
    const group = new THREE.Group();
    group.name = "deployment-ghost";
    group.visible = false;
    const unitMaterial = createToonMaterial({ color: 0x75ef9d, transparent: true, opacity: 0.62, depthWrite: false });
    const buildingMaterial = unitMaterial.clone();
    const spellMaterial = new THREE.MeshBasicMaterial({ color: 0x75ef9d, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false });
    const unit = new THREE.Mesh(createUnitGeometry("guard", FACTIONS[0].color), unitMaterial);
    const building = new THREE.Mesh(createCannonTowerGeometry(FACTIONS[0].color), buildingMaterial);
    const spell = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), spellMaterial);
    spell.rotation.x = -Math.PI * 0.5;
    spell.position.y = 0.18;
    group.add(unit, building, spell);
    return { group, unit, building, spell, materials: [unitMaterial, buildingMaterial, spellMaterial] };
  }

  private cardKind(cardId: string | null): PlacementKind {
    if (!cardId) return "unit";
    const card = CONTENT.cards.find((candidate) => candidate.id === cardId);
    if (card?.kind === "spell") return "spell";
    if (card?.kind === "building") return "building";
    return "unit";
  }

  private updateStrategicObjects(): void {
    for (const visual of this.castles) {
      const castle = this.currentSnapshot.castles[visual.owner];
      const ratio = castle ? THREE.MathUtils.clamp(castle.health / castle.maxHealth, 0, 1) : 1;
      visual.healthFill.scale.x = 5.15 * ratio;
      const showHealth = ratio < 0.995 && castle?.alive !== false;
      visual.healthBack.visible = showHealth;
      visual.healthFill.visible = showHealth && ratio > 0;
      const baseScale = Number(visual.group.userData.baseScale ?? 1);
      const baseScaleY = Number(visual.group.userData.baseScaleY ?? baseScale);
      visual.group.scale.set(baseScale, castle?.alive === false ? baseScaleY * 0.62 : baseScaleY, baseScale);
    }
    if (!this.center) return;
    const owner = this.currentSnapshot.centerOwner;
    const color = owner >= 0 && owner <= 3 ? (FACTIONS[owner] ?? FACTIONS[0]).color : 0xc49642;
    this.center.ringMaterial.color.setHex(color);
    this.center.crystalMaterial.emissive.setHex(owner >= 0 ? color : 0x5e1680);
    const geometry = this.center.progressRing.geometry;
    const total = geometry.index?.count ?? geometry.getAttribute("position").count;
    geometry.setDrawRange(0, Math.max(0, Math.floor(total * this.currentSnapshot.centerProgress)));
    this.center.progressRing.visible = this.currentSnapshot.centerProgress > 0.005;
  }

  private updateVegetationOcclusion(): void {
    const cellSize = 7;
    const nearby = new Map<string, Array<{ x: number; z: number }>>();
    for (const unit of this.currentSnapshot.units) {
      if (unit.state === "death" || unit.kind.includes("tower") || unit.kind.includes("castle")) continue;
      const key = `${Math.floor(unit.x / cellSize)}:${Math.floor(unit.z / cellSize)}`;
      const bucket = nearby.get(key);
      if (bucket) bucket.push(unit);
      else nearby.set(key, [unit]);
    }

    for (const batch of this.vegetation) {
      for (let index = 0; index < batch.fullCount; index += 1) {
        this.matrix.fromArray(batch.crownBaseMatrices, index * 16);
        this.matrix.decompose(this.position, this.quaternion, this.scale);
        const cellX = Math.floor(this.position.x / cellSize);
        const cellZ = Math.floor(this.position.z / cellSize);
        let nearestSquared = Number.POSITIVE_INFINITY;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
            const bucket = nearby.get(`${cellX + offsetX}:${cellZ + offsetZ}`);
            if (!bucket) continue;
            for (const unit of bucket) {
              const dx = unit.x - this.position.x;
              const dz = unit.z - this.position.z;
              nearestSquared = Math.min(nearestSquared, dx * dx + dz * dz);
            }
          }
        }
        if (nearestSquared < 49) {
          const distance = Math.sqrt(nearestSquared);
          const reveal = THREE.MathUtils.smoothstep(distance, 2.4, 7);
          const horizontal = THREE.MathUtils.lerp(0.24, 1, reveal);
          const vertical = THREE.MathUtils.lerp(0.12, 1, reveal);
          this.scale.set(this.scale.x * horizontal, this.scale.y * vertical, this.scale.z * horizontal);
          this.position.y -= (1 - vertical) * 0.72;
          this.matrix.compose(this.position, this.quaternion, this.scale);
        }
        batch.crowns.setMatrixAt(index, this.matrix);
      }
      batch.crowns.instanceMatrix.needsUpdate = true;
    }
  }

  private updateUnitInstances(now: number): void {
    if (!this.shadowInstances || !this.healthBackInstances || !this.healthFillInstances) return;
    const ownerUnitCounts = Array.from({ length: 4 }, () => new Map<UnitVisualKey, number>());
    const ownerBuildingCounts = [0, 0, 0, 0];
    let renderedCount = 0;
    let healthCount = 0;
    const alpha = this.snapshotReceivedAt === 0 ? 1 : THREE.MathUtils.clamp((now - this.snapshotReceivedAt) / this.interpolationDuration, 0, 1);
    const timeSeconds = now * 0.001;

    for (const current of this.currentSnapshot.units) {
      if (renderedCount >= MAX_RENDERED_UNITS) break;
      const previous = this.previousSnapshot.unitById.get(current.id);
      const x = previous ? THREE.MathUtils.lerp(previous.x, current.x, alpha) : current.x;
      const z = previous ? THREE.MathUtils.lerp(previous.z, current.z, alpha) : current.z;
      const rotation = previous ? lerpAngle(previous.rotation, current.rotation, alpha) : current.rotation;
      const owner = THREE.MathUtils.clamp(Math.trunc(current.owner), 0, 3);
      const batch = this.unitBatches[owner];
      const counts = ownerUnitCounts[owner];
      if (!batch || !counts) continue;
      const isBuilding = current.kind.includes("cannon") || current.kind.includes("tower");
      const size = isBuilding ? 1.3 : 1;
      const walkCycle = current.motionPhase / 65_535 * Math.PI * 2;
      const bob = current.state === "walk" ? Math.abs(Math.sin(walkCycle)) * 0.045 : 0;
      const hitShake = current.state === "hit" ? Math.sin(timeSeconds * 42 + current.id) * 0.11 : 0;
      const buildingPulse = current.state === "attack" ? 1 + Math.max(0, Math.sin(timeSeconds * 11 + current.id)) * 0.1 : 1;
      this.quaternion.setFromEuler(new THREE.Euler(0, rotation, 0));

      if (isBuilding) {
        const index = ownerBuildingCounts[owner] ?? 0;
        if (index >= 256) continue;
        this.position.set(x, 0.08, z);
        this.scale.set(size * buildingPulse, size, size * buildingPulse);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        batch.buildings.setMatrixAt(index, this.matrix);
        ownerBuildingCounts[owner] = index + 1;
      } else {
        const archetype = unitArchetype(current.kind);
        const asset = this.externalUnitLibrary?.assets.get(archetype);
        const key = asset ? this.riggedUnitVisualKey(asset, current, timeSeconds)
          : unitVisualKey(archetype, visualUnitPose(current.state, current.stateTick, current.motionPhase));
        const mesh = batch.units.get(key);
        const outline = batch.outlines.get(key);
        const index = counts.get(key) ?? 0;
        if (!mesh || !outline || index >= MAX_RENDERED_UNITS) continue;
        this.position.set(x + hitShake, 0.08 + bob, z);
        this.scale.set(size, size, size);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        mesh.setMatrixAt(index, this.matrix);
        this.scale.multiplyScalar(1.075);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        outline.setMatrixAt(index, this.matrix);
        counts.set(key, index + 1);
      }

      this.position.set(x, 0.09, z);
      const shadowScale = isBuilding ? 1.55 : size * (current.kind.includes("giant") ? 1.45 : 1.08);
      this.scale.set(shadowScale, shadowScale * 0.72, shadowScale);
      this.matrix.compose(this.position, this.shadowQuaternion, this.scale);
      this.shadowInstances.setMatrixAt(renderedCount, this.matrix);

      const healthRatio = THREE.MathUtils.clamp(current.health / Math.max(1, current.maxHealth), 0.015, 1);
      if (healthRatio < 0.995 || current.state === "hit") {
        const barWidth = isBuilding ? 1.8 : 1.1 * size;
        const barY = isBuilding ? 2.65 : current.kind.includes("giant") ? 2.65 : 2.1 * size;
        this.position.set(x, barY, z);
        this.scale.set(barWidth, 1, 1);
        this.matrix.compose(this.position, this.camera.quaternion, this.scale);
        this.healthBackInstances.setMatrixAt(healthCount, this.matrix);
        this.cameraRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
        this.position.addScaledVector(this.cameraRight, -barWidth * (1 - healthRatio) * 0.5);
        this.scale.set(barWidth * healthRatio, 0.62, 1);
        this.matrix.compose(this.position, this.camera.quaternion, this.scale);
        this.healthFillInstances.setMatrixAt(healthCount, this.matrix);
        healthCount += 1;
      }
      renderedCount += 1;
    }

    for (let owner = 0; owner < 4; owner += 1) {
      const batch = this.unitBatches[owner];
      const counts = ownerUnitCounts[owner];
      if (!batch || !counts) continue;
      for (const [key, mesh] of batch.units) {
        const outline = batch.outlines.get(key);
        if (!outline) continue;
        mesh.count = counts.get(key) ?? 0;
        outline.count = mesh.count;
        mesh.instanceMatrix.needsUpdate = true;
        outline.instanceMatrix.needsUpdate = true;
      }
      batch.buildings.count = ownerBuildingCounts[owner] ?? 0;
      batch.buildings.instanceMatrix.needsUpdate = true;
    }
    this.shadowInstances.count = renderedCount;
    this.healthBackInstances.count = healthCount;
    this.healthFillInstances.count = healthCount;
    this.shadowInstances.instanceMatrix.needsUpdate = true;
    this.healthBackInstances.instanceMatrix.needsUpdate = true;
    this.healthFillInstances.instanceMatrix.needsUpdate = true;
  }
  private updateGhost(now: number): void {
    if (!this.ghost || !this.selectedCard) return;
    const pulse = 1 + Math.sin(now * 0.006) * 0.045;
    this.ghost.unit.visible = this.selectedKind === "unit";
    this.ghost.building.visible = this.selectedKind === "building";
    this.ghost.spell.visible = this.selectedKind === "spell";
    if (this.selectedKind === "spell") {
      const card = CONTENT.cards.find((candidate) => candidate.id === this.selectedCard);
      const radius = card?.kind === "spell" ? card.radius : 5;
      this.ghost.spell.scale.setScalar(radius * pulse);
    } else {
      this.ghost.group.scale.setScalar(pulse);
    }
  }

  private updateCenter(now: number): void {
    if (!this.center) return;
    this.center.crystal.rotation.y = now * 0.0007;
    this.center.crystal.position.y = 2.58 + Math.sin(now * 0.0023) * 0.12;
    for (let index = 0; index < this.vegetation.length; index += 1) {
      const batch = this.vegetation[index];
      if (batch) batch.crowns.position.y = Math.sin(now * 0.0011 + index * 1.7) * 0.025;
    }
  }

  private updateControls(deltaSeconds: number): void {
    let horizontal = 0;
    let vertical = 0;
    if (this.pressedKeys.has("KeyA") || this.pressedKeys.has("ArrowLeft")) horizontal -= 1;
    if (this.pressedKeys.has("KeyD") || this.pressedKeys.has("ArrowRight")) horizontal += 1;
    if (this.pressedKeys.has("KeyW") || this.pressedKeys.has("ArrowUp")) vertical += 1;
    if (this.pressedKeys.has("KeyS") || this.pressedKeys.has("ArrowDown")) vertical -= 1;

    const rect = this.canvas.getBoundingClientRect();
    if (this.pointerInside && !this.pointerDown && rect.width > 0 && rect.height > 0) {
      const localX = this.pointerX - rect.left;
      const localY = this.pointerY - rect.top;
      if (localX <= EDGE_PAN_SIZE) horizontal -= 1;
      else if (localX >= rect.width - EDGE_PAN_SIZE) horizontal += 1;
      if (localY <= EDGE_PAN_SIZE) vertical += 1;
      else if (localY >= rect.height - EDGE_PAN_SIZE) vertical -= 1;
    }

    const rotationInput = (this.pressedKeys.has("KeyE") ? 1 : 0) - (this.pressedKeys.has("KeyQ") ? 1 : 0);
    if (rotationInput !== 0) this.targetYaw += rotationInput * THREE.MathUtils.degToRad(72) * deltaSeconds;

    if (horizontal !== 0 || vertical !== 0) {
      const length = Math.hypot(horizontal, vertical) || 1;
      horizontal /= length;
      vertical /= length;
      this.cameraRight.set(Math.cos(this.targetYaw), 0, -Math.sin(this.targetYaw));
      this.cameraForward.set(-Math.sin(this.targetYaw), 0, -Math.cos(this.targetYaw));
      const speed = (9 + this.targetDistance * 0.18) * deltaSeconds;
      this.desiredCameraTarget
        .addScaledVector(this.cameraRight, horizontal * speed)
        .addScaledVector(this.cameraForward, vertical * speed);
      this.clampCameraTarget();
    }

    const cameraBlend = 1 - Math.exp(-10 * deltaSeconds);
    const targetBlend = 1 - Math.exp(-8 * deltaSeconds);
    this.yaw = lerpAngle(this.yaw, this.targetYaw, cameraBlend);
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.targetPitch, cameraBlend);
    this.distance = THREE.MathUtils.lerp(this.distance, this.targetDistance, cameraBlend);
    this.cameraTarget.lerp(this.desiredCameraTarget, targetBlend);
  }

  private applyCamera(_now: number): void {
    const horizontalDistance = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.cameraTarget.x + Math.sin(this.yaw) * horizontalDistance,
      this.cameraTarget.y + Math.sin(this.pitch) * this.distance,
      this.cameraTarget.z + Math.cos(this.yaw) * horizontalDistance,
    );
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
    this.emitCameraPose();
    if (this.selectedCard) this.updatePlacementFromClient(this.pointerX, this.pointerY);
  }

  private clampCameraTarget(): void {
    this.desiredCameraTarget.x = THREE.MathUtils.clamp(this.desiredCameraTarget.x, -CAMERA_TARGET_LIMIT, CAMERA_TARGET_LIMIT);
    this.desiredCameraTarget.z = THREE.MathUtils.clamp(this.desiredCameraTarget.z, -CAMERA_TARGET_LIMIT, CAMERA_TARGET_LIMIT);
    this.desiredCameraTarget.y = 0;
  }

  private emitCameraPose(force = false): void {
    const signature = [
      this.yaw.toFixed(3),
      this.pitch.toFixed(3),
      this.distance.toFixed(2),
      this.cameraTarget.x.toFixed(2),
      this.cameraTarget.z.toFixed(2),
    ].join(":");
    if (!force && signature === this.lastPoseSignature) return;
    this.lastPoseSignature = signature;
    this.callbacks.onCameraPoseChange?.({
      yaw: THREE.MathUtils.euclideanModulo(this.yaw, Math.PI * 2),
      pitch: this.pitch,
      distance: this.distance,
      target: { x: this.cameraTarget.x, y: this.cameraTarget.y, z: this.cameraTarget.z },
    });
  }

  private resize = (): void => {
    if (!this.renderer) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width || this.canvas.clientWidth || 1));
    const height = Math.max(1, Math.floor(rect.height || this.canvas.clientHeight || 1));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  };

  private applyQuality(): void {
    const settings = QUALITY[this.qualityPreset];
    this.pixelRatio = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, settings.maxPixelRatio);
    if (this.renderer) {
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.shadowMap.enabled = settings.shadows;
    }
    if (this.sun) {
      this.sun.castShadow = settings.shadows;
      this.sun.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
      this.sun.shadow.map?.dispose();
    }
    for (const batch of this.vegetation) {
      const count = Math.floor(batch.fullCount * settings.vegetationDensity);
      batch.trunks.count = count;
      batch.crowns.count = count;
      batch.shadows.count = count;
    }
    this.resize();
  }

  private onFrame = (now: number): void => {
    if (this.disposed || !this.renderer) return;
    const deltaMs = this.lastFrameAt === 0 ? 16.67 : Math.min(100, now - this.lastFrameAt);
    this.lastFrameAt = now;
    this.frameTimes.push(deltaMs);
    if (this.frameTimes.length > 240) this.frameTimes.shift();

    this.updateControls(deltaMs / 1000);
    this.applyCamera(now);
    this.resizeProjectionOnly();
    this.updateUnitInstances(now);
    this.combatEffects?.update(now);
    this.updateGhost(now);
    this.updateCenter(now);
    if (this.renderPipeline) {
      this.renderPipeline.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    if (this.pendingFrameSessionId > 0) {
      const renderedSessionId = this.pendingFrameSessionId;
      this.pendingFrameSessionId = 0;
      this.reportedFrameSessionId = renderedSessionId;
      this.callbacks.onFirstFrame?.(renderedSessionId);
    }
    this.publishMetrics(now);
  };

  private resizeProjectionOnly(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const aspect = width / height;
    if (Math.abs(this.camera.aspect - aspect) < 0.0001) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private publishMetrics(now: number): void {
    if (!this.renderer || now - this.lastMetricsAt < 500) return;
    this.lastMetricsAt = now;
    const values = [...this.frameTimes].sort((a, b) => a - b);
    const average = this.frameTimes.length > 0 ? this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length : 16.67;
    const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? average;
    this.callbacks.onMetrics?.({
      fps: Math.round(1000 / Math.max(0.01, average)),
      frameMs: average,
      frameTimeMs: average,
      p95FrameMs: p95,
      p95FrameTimeMs: p95,
      drawCalls: this.renderer.info.render.drawCalls,
      triangles: this.renderer.info.render.triangles,
      backend: this.backend,
      units: this.currentSnapshot.units.length,
      quality: this.qualityPreset,
      pixelRatio: this.pixelRatio,
    });
  }

  private computePlacement(world: THREE.Vector3): PlacementPreview | null {
    if (!this.selectedCard) return null;
    const insideMap = Math.abs(world.x) <= MAP_HALF_SIZE && Math.abs(world.z) <= MAP_HALF_SIZE;
    const result = findBestPlacement(
      LOCAL_PLAYER_ID,
      this.selectedCard as CardId,
      { x: world.x, z: world.z },
      { preferredRouteId: this.currentPlacement?.routeId || undefined },
    );
    const route = result.routeId
      ? MAP_GRAPH.routes.find((candidate) => candidate.id === result.routeId)
      : undefined;
    const direction: 1 | -1 = route?.steps[0]?.reverse ? -1 : 1;
    const valid = insideMap && result.valid;
    const reason: PlacementPreview["reason"] = !insideMap
      ? "outside-map"
      : valid
        ? undefined
        : this.selectedKind === "building"
          ? "invalid-pad"
          : result.reason === "too-far-from-lane" || result.reason === "no-placement-zone"
            ? "outside-lane"
            : "enemy-zone";
    return {
      cardId: this.selectedCard,
      kind: this.selectedKind,
      playerId: LOCAL_PLAYER_ID,
      x: result.position.x,
      z: result.position.z,
      laneId: result.laneId ?? "",
      routeId: result.routeId ?? "",
      routeT: result.routeDistance,
      direction,
      valid,
      reason,
    };
  }

  private updatePlacementFromClient(clientX: number, clientY: number): void {
    if (!this.selectedCard || !this.ghost) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.pointerWorld)) return;
    const placement = this.computePlacement(this.pointerWorld);
    if (!placement) return;
    this.currentPlacement = placement;
    this.ghost.group.visible = true;
    this.ghost.group.position.set(placement.x, 0.12, placement.z);
    const color = placement.valid ? 0x75ef9d : 0xff625f;
    for (const material of this.ghost.materials) {
      const colored = material as THREE.MeshBasicMaterial;
      colored.color.setHex(color);
    }
    const modern: RendererPlacement = { x: placement.x, z: placement.z, routeId: placement.routeId || null, valid: placement.valid };
    this.callbacks.onHover?.(modern);
    this.callbacks.onPlacementChange?.(placement);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button < 0 || event.button > 2) return;
    if (event.button === 1 || event.button === 2) event.preventDefault();
    this.canvas.focus({ preventScroll: true });
    this.pointerInside = true;
    this.pointerDown = true;
    this.pointerDragged = false;
    this.pointerId = event.pointerId;
    this.pointerButton = event.button;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
    if (event.button === 0 && this.selectedCard) this.updatePlacementFromClient(event.clientX, event.clientY);
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = event.button === 2 ? "grabbing" : event.button === 1 ? "move" : this.selectedCard ? "crosshair" : "grab";
  };

  private onPointerMove = (event: PointerEvent): void => {
    const previousX = this.pointerX;
    const previousY = this.pointerY;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.pointerInside = true;
    if (this.pointerDown && event.pointerId === this.pointerId) {
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      const totalDistance = Math.hypot(event.clientX - this.pointerDownX, event.clientY - this.pointerDownY);
      if (totalDistance > 4) this.pointerDragged = true;
      if (this.pointerDragged && this.pointerButton === 2) {
        this.targetYaw -= dx * 0.006;
        this.targetPitch = THREE.MathUtils.clamp(
          this.targetPitch + dy * 0.0045,
          MIN_CAMERA_PITCH,
          MAX_CAMERA_PITCH,
        );
      } else if (this.pointerDragged && this.pointerButton === 1) {
        const rect = this.canvas.getBoundingClientRect();
        const worldHeight = 2 * this.targetDistance * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) * 0.5);
        const unitsPerPixel = worldHeight / Math.max(1, rect.height);
        this.cameraRight.set(Math.cos(this.targetYaw), 0, -Math.sin(this.targetYaw));
        this.cameraForward.set(-Math.sin(this.targetYaw), 0, -Math.cos(this.targetYaw));
        this.desiredCameraTarget
          .addScaledVector(this.cameraRight, -dx * unitsPerPixel)
          .addScaledVector(this.cameraForward, dy * unitsPerPixel);
        this.clampCameraTarget();
      }
    }
    if (this.selectedCard) this.updatePlacementFromClient(event.clientX, event.clientY);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    const releasedButton = this.pointerButton;
    if (releasedButton === 0 && this.selectedCard) this.updatePlacementFromClient(event.clientX, event.clientY);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const shouldPlace = releasedButton === 0
      && !this.pointerDragged
      && this.selectedCard !== null
      && this.currentPlacement?.valid === true;
    const shouldCancel = releasedButton === 2 && !this.pointerDragged && this.selectedCard !== null;
    this.pointerDown = false;
    this.pointerId = -1;
    this.pointerButton = -1;
    this.canvas.style.cursor = this.selectedCard ? "crosshair" : "grab";
    if (shouldCancel) {
      this.callbacks.onCancelSelection?.();
      return;
    }
    if (shouldPlace && this.currentPlacement) {
      const placement = this.currentPlacement;
      this.callbacks.onDeploy?.(placement);
      this.callbacks.onPlace?.({ x: placement.x, z: placement.z, routeId: placement.routeId || null, valid: placement.valid });
    }
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasAnchor = this.raycaster.ray.intersectPlane(this.groundPlane, this.zoomAnchor) !== null;
    const previousDistance = this.targetDistance;
    const nextDistance = THREE.MathUtils.clamp(
      previousDistance * Math.exp(event.deltaY * 0.00115),
      MIN_CAMERA_DISTANCE,
      MAX_CAMERA_DISTANCE,
    );
    if (hasAnchor && previousDistance > 0.001) {
      const ratio = nextDistance / previousDistance;
      this.desiredCameraTarget.x += (this.zoomAnchor.x - this.desiredCameraTarget.x) * (1 - ratio);
      this.desiredCameraTarget.z += (this.zoomAnchor.z - this.desiredCameraTarget.z) * (1 - ratio);
      this.clampCameraTarget();
    }
    this.targetDistance = nextDistance;
    if (this.selectedCard) this.updatePlacementFromClient(event.clientX, event.clientY);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTextInput(event.target)) return;
    if (event.code === "Escape") {
      this.callbacks.onCancelSelection?.();
      event.preventDefault();
      return;
    }
    if (["KeyQ", "KeyE", "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      this.pressedKeys.add(event.code);
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.pressedKeys.delete(event.code);
  };

  private onPointerEnter = (event: PointerEvent): void => {
    this.pointerInside = true;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
  };

  private onPointerLeave = (): void => {
    if (!this.pointerDown) this.pointerInside = false;
  };
  private onContextMenu = (event: MouseEvent): void => event.preventDefault();

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerenter", this.onPointerEnter);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.canvas);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerenter", this.onPointerEnter);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.pressedKeys.clear();
  }
}

