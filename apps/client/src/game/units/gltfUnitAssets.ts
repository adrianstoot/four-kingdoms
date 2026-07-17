import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { FACTIONS, UNIT_ARCHETYPES, UNIT_METRICS, type UnitArchetype } from "../procedural";

export const UNIT_MOTIONS = ["idle", "walk", "attack", "hit", "death", "spawn"] as const;
export type UnitMotion = (typeof UNIT_MOTIONS)[number];
export type UnitForwardAxis = "+z" | "-z" | "+x" | "-x";

interface UnitAnimationSourceManifest {
  /** Optional GLBs containing additional clips bound to the same bone names. */
  animationUrls?: Partial<Record<UnitMotion, string | string[]>>;
  /** Explicit clip names win over the automatic, multilingual name matcher. */
  clips?: Partial<Record<UnitMotion, string | string[]>>;
  /** Direction the authored character faces before normalization. */
  forwardAxis?: UnitForwardAxis;
}

interface UnitSamplingManifest {
  /** Number of baked instancing frames for each complete source clip. */
  sampleFrames?: number | Partial<Record<UnitMotion, number>>;
  /** Material-name fragments that receive the owner's faction accent. */
  tintMaterials?: string[];
}

export interface SingleUnitAssetManifestEntry extends UnitAnimationSourceManifest, UnitSamplingManifest {
  type?: "single";
  /** GLB containing the mesh, skeleton and optionally all clips. */
  url: string;
}

export interface MountedUnitPartManifestEntry extends UnitAnimationSourceManifest {
  /** Independently rigged horse or rider GLB. */
  url: string;
  /** Optional local scale used to match horse and rider authoring units. */
  scale?: number | [number, number, number];
}

export interface RiderSocketManifest {
  /** Horse bone/object name. Exact normalized matches are preferred. */
  bone?: string | string[];
  /** Rider-root offset in horse-socket local coordinates. */
  position?: [number, number, number];
  /** Rider-root Euler correction in degrees. */
  rotationDegrees?: [number, number, number];
  /** Final local rider scale, applied after its authored-axis correction. */
  scale?: number | [number, number, number];
}

export interface MountedUnitAssetManifestEntry extends UnitSamplingManifest {
  type: "mounted";
  horse: MountedUnitPartManifestEntry;
  rider: MountedUnitPartManifestEntry;
  riderSocket?: RiderSocketManifest;
}

export type UnitAssetManifestEntry = SingleUnitAssetManifestEntry | MountedUnitAssetManifestEntry;

export interface UnitAssetManifest {
  version: 1;
  units: Partial<Record<UnitArchetype, UnitAssetManifestEntry>>;
}

export interface BakedUnitFrame {
  /** Normalized [0, 1] source-clip time represented by this frame. */
  phase: number;
  geometry: THREE.BufferGeometry;
}

export interface ExternalUnitAsset {
  archetype: UnitArchetype;
  sourceUrl: string;
  sourceScene: THREE.Group;
  /** Complete clips are retained for galleries, close LODs and future VAT baking. */
  rawClips: readonly THREE.AnimationClip[];
  clips: ReadonlyMap<UnitMotion, THREE.AnimationClip>;
  /** Both independently authored clip sets for a mounted composite. */
  componentClips?: ReadonlyMap<"horse" | "rider", ReadonlyMap<UnitMotion, THREE.AnimationClip>>;
  frames: ReadonlyMap<UnitMotion, readonly BakedUnitFrame[]>;
  materials: readonly THREE.Material[];
  tintMaterials: readonly string[];
  targetHeight: number;
}

export interface ExternalUnitLibrary {
  assets: ReadonlyMap<UnitArchetype, ExternalUnitAsset>;
  errors: ReadonlyMap<UnitArchetype, Error>;
  dispose(): void;
}

export interface LoadExternalUnitLibraryOptions {
  manifestUrl?: string;
  onProgress?: (progress: number, label: string) => void;
  /** Test seam. Production uses GLTFLoader.loadAsync. */
  loadGltf?: (url: string) => Promise<GLTF>;
}

const DEFAULT_CLIP_ALIASES: Readonly<Record<UnitMotion, readonly string[]>> = {
  idle: ["idle", "breathe", "breathing", "stand", "reposo"],
  walk: ["walk", "walking", "run", "locomotion", "caminar", "marcha", "trot"],
  attack: ["attack", "shoot", "bow", "arrow", "slash", "strike", "charge", "melee", "ataque", "disparo"],
  hit: ["hit", "hurt", "damage", "impact", "golpe", "herido"],
  death: ["death", "die", "dying", "defeat", "muerte", "caer"],
  spawn: ["spawn", "summon", "appear", "enter", "deploy", "invocar", "aparicion"],
};

const DEFAULT_TINT_MATERIALS = ["team", "faction", "accent", "primary", "blue"];
const DEFAULT_FRAME_COUNTS: Readonly<Record<UnitMotion, number>> = {
  idle: 4,
  walk: 6,
  attack: 6,
  hit: 4,
  death: 6,
  spawn: 6,
};

function normalizedName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stringList(value: string | string[] | undefined): readonly string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasAssetUrl(value: unknown): value is { url: string } {
  return isRecord(value) && typeof value.url === "string" && value.url.trim().length > 0;
}

function isMountedEntry(entry: UnitAssetManifestEntry): entry is MountedUnitAssetManifestEntry {
  return entry.type === "mounted";
}

function parseManifest(value: unknown): UnitAssetManifest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.units)) {
    throw new Error("Invalid unit asset manifest; expected { version: 1, units: {...} }.");
  }
  const units: Partial<Record<UnitArchetype, UnitAssetManifestEntry>> = {};
  for (const archetype of UNIT_ARCHETYPES) {
    const raw = value.units[archetype];
    if (raw === undefined) continue;
    if (!isRecord(raw)) throw new Error(`Invalid GLB entry for ${archetype}.`);
    if (raw.type === "mounted") {
      if (archetype !== "knight" || !hasAssetUrl(raw.horse) || !hasAssetUrl(raw.rider)) {
        throw new Error("A mounted composite is only valid for knight and requires horse.url plus rider.url.");
      }
      units[archetype] = raw as unknown as MountedUnitAssetManifestEntry;
      continue;
    }
    if ((raw.type !== undefined && raw.type !== "single") || !hasAssetUrl(raw)) {
      throw new Error(`Invalid GLB entry for ${archetype}.`);
    }
    units[archetype] = raw as unknown as SingleUnitAssetManifestEntry;
  }
  return { version: 1, units };
}

async function fetchManifest(url: string): Promise<UnitAssetManifest | null> {
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return null;
    return parseManifest(await response.json());
  } catch {
    return null;
  }
}

function resolveUrl(url: string, relativeTo: string): string {
  const documentUrl = typeof window !== "undefined" ? window.location.href : "http://localhost/";
  const absoluteBase = new URL(relativeTo, documentUrl);
  return new URL(url, absoluteBase).href;
}

function chooseClip(
  motion: UnitMotion,
  clips: readonly THREE.AnimationClip[],
  configured: string | string[] | undefined,
): THREE.AnimationClip | null {
  const requested = stringList(configured).map(normalizedName);
  const aliases = [...requested, ...DEFAULT_CLIP_ALIASES[motion]];
  for (const alias of aliases) {
    const exact = clips.find((clip) => normalizedName(clip.name) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const partial = clips.find((clip) => normalizedName(clip.name).includes(alias));
    if (partial) return partial;
  }
  return null;
}

function frameCount(entry: UnitAssetManifestEntry, motion: UnitMotion, hasClip: boolean): number {
  if (!hasClip) return 1;
  const configured = typeof entry.sampleFrames === "number" ? entry.sampleFrames : entry.sampleFrames?.[motion];
  return THREE.MathUtils.clamp(Math.trunc(configured ?? DEFAULT_FRAME_COUNTS[motion]), 2, 12);
}

function ensureFloatAttribute(
  geometry: THREE.BufferGeometry,
  name: "position" | "normal" | "uv" | "color",
  itemSize: number,
  defaults: readonly number[],
): void {
  const count = geometry.getAttribute("position").count;
  const source = geometry.getAttribute(name);
  const values = new Float32Array(count * itemSize);
  if (source) {
    for (let index = 0; index < count; index += 1) {
      for (let component = 0; component < itemSize; component += 1) {
        values[index * itemSize + component] = source.getComponent(index, component);
      }
    }
  } else {
    for (let index = 0; index < count; index += 1) {
      for (let component = 0; component < itemSize; component += 1) {
        values[index * itemSize + component] = defaults[component] ?? 0;
      }
    }
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
}

function retainRenderableAttributes(geometry: THREE.BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv" && name !== "color") geometry.deleteAttribute(name);
  }
  geometry.morphAttributes = {};
  ensureFloatAttribute(geometry, "position", 3, [0, 0, 0]);
  ensureFloatAttribute(geometry, "normal", 3, [0, 1, 0]);
  ensureFloatAttribute(geometry, "uv", 2, [0, 0]);
  ensureFloatAttribute(geometry, "color", 3, [1, 1, 1]);
}

function sliceNonIndexedGeometry(source: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const result = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"] as const) {
    const attribute = source.getAttribute(name);
    const values = new Float32Array(count * attribute.itemSize);
    for (let index = 0; index < count; index += 1) {
      for (let component = 0; component < attribute.itemSize; component += 1) {
        values[index * attribute.itemSize + component] = attribute.getComponent(start + index, component);
      }
    }
    result.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  return result;
}

function bakeMesh(mesh: THREE.Mesh): THREE.BufferGeometry {
  const originalGeometry = mesh.geometry;
  const expanded = originalGeometry.index ? originalGeometry.toNonIndexed() : originalGeometry.clone();
  mesh.geometry = expanded;
  const positions = expanded.getAttribute("position") as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld);
    positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }
  mesh.geometry = originalGeometry;
  expanded.morphAttributes = {};
  expanded.deleteAttribute("skinIndex");
  expanded.deleteAttribute("skinWeight");
  expanded.computeVertexNormals();
  retainRenderableAttributes(expanded);
  return expanded;
}

interface BakedScene {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}

function bakeScene(scene: THREE.Group): BakedScene {
  scene.updateMatrixWorld(true);
  const primitives: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    const baked = bakeMesh(object);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const groups = baked.groups.length > 0
      ? baked.groups
      : [{ start: 0, count: baked.getAttribute("position").count, materialIndex: 0 }];
    for (const group of groups) {
      if (group.count <= 0) continue;
      primitives.push(sliceNonIndexedGeometry(baked, group.start, group.count));
      materials.push(meshMaterials[group.materialIndex ?? 0] ?? meshMaterials[0]!);
    }
    baked.dispose();
  });
  if (primitives.length === 0) throw new Error("The GLB contains no visible meshes.");
  const geometry = mergeGeometries(primitives, true);
  for (const primitive of primitives) primitive.dispose();
  if (!geometry) throw new Error("Could not merge the GLB meshes into an instanced unit geometry.");
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, materials };
}

function forwardTurn(forwardAxis: UnitForwardAxis): number {
  return forwardAxis === "-z"
    ? Math.PI
    : forwardAxis === "+x"
      ? -Math.PI * 0.5
      : forwardAxis === "-x"
        ? Math.PI * 0.5
        : 0;
}

function normalizeGeometry(
  geometry: THREE.BufferGeometry,
  targetHeight: number,
  forwardAxis: UnitForwardAxis,
): void {
  const turn = forwardTurn(forwardAxis);
  if (turn !== 0) geometry.rotateY(turn);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) throw new Error("Could not measure the baked GLB geometry.");
  const sourceHeight = Math.max(0.001, bounds.max.y - bounds.min.y);
  const scale = targetHeight / sourceHeight;
  const centerX = (bounds.min.x + bounds.max.x) * 0.5;
  const centerZ = (bounds.min.z + bounds.max.z) * 0.5;
  geometry.translate(-centerX, -bounds.min.y, -centerZ);
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

function sampleTimes(clip: THREE.AnimationClip | null, count: number): number[] {
  if (!clip || count <= 1 || clip.duration <= 0) return [0];
  return Array.from({ length: count }, (_, index) => clip.duration * index / (count - 1));
}

function samplePhases(count: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, index) => index / (count - 1));
}

function materialList(materials: readonly THREE.Material[]): THREE.Material[] {
  return materials.map((material) => {
    const clone = material.clone();
    if ("vertexColors" in clone) (clone as THREE.MeshStandardMaterial).vertexColors = true;
    return clone;
  });
}

interface SupplementalClips {
  all: THREE.AnimationClip[];
  preferred: Map<UnitMotion, THREE.AnimationClip[]>;
}

async function loadAnimationClips(
  entry: UnitAnimationSourceManifest,
  manifestUrl: string,
  loadGltf: (url: string) => Promise<GLTF>,
): Promise<SupplementalClips> {
  const all: THREE.AnimationClip[] = [];
  const preferred = new Map<UnitMotion, THREE.AnimationClip[]>();
  for (const motion of UNIT_MOTIONS) {
    for (const relativeUrl of stringList(entry.animationUrls?.[motion])) {
      const animated = await loadGltf(resolveUrl(relativeUrl, manifestUrl));
      all.push(...animated.animations);
      const current = preferred.get(motion) ?? [];
      current.push(...animated.animations);
      preferred.set(motion, current);
      disposeObject(animated.scene);
    }
  }
  return { all, preferred };
}

function selectedClips(
  entry: UnitAnimationSourceManifest,
  base: readonly THREE.AnimationClip[],
  supplemental: SupplementalClips,
): {
  rawClips: THREE.AnimationClip[];
  clips: Map<UnitMotion, THREE.AnimationClip>;
} {
  const rawClips = [...base, ...supplemental.all];
  const clips = new Map<UnitMotion, THREE.AnimationClip>();
  for (const motion of UNIT_MOTIONS) {
    const clip = chooseClip(motion, rawClips, entry.clips?.[motion])
      ?? supplemental.preferred.get(motion)?.[0]
      ?? null;
    if (clip) clips.set(motion, clip);
  }
  return { rawClips, clips };
}

function playClip(
  mixer: THREE.AnimationMixer,
  clip: THREE.AnimationClip | null,
): void {
  if (!clip) return;
  const action = mixer.clipAction(clip);
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
}

function positiveScale(
  value: number | [number, number, number] | undefined,
  label: string,
): THREE.Vector3 {
  if (value === undefined) return new THREE.Vector3(1, 1, 1);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new THREE.Vector3(value, value, value);
  }
  if (Array.isArray(value) && value.length === 3 && value.every((item) => Number.isFinite(item) && item > 0)) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  throw new Error(label + " must contain positive finite scale values.");
}

function finiteVector(
  value: [number, number, number] | undefined,
  label: string,
): THREE.Vector3 {
  if (value === undefined) return new THREE.Vector3();
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  throw new Error(label + " must contain three finite numbers.");
}

function preparePartRoot(
  root: THREE.Group,
  entry: MountedUnitPartManifestEntry,
): void {
  root.rotateY(forwardTurn(entry.forwardAxis ?? "+z"));
  root.scale.multiply(positiveScale(entry.scale, "Mounted part scale"));
}

const DEFAULT_RIDER_SOCKET_NAMES = ["saddle", "seat", "rider socket", "rider mount"];

function findRiderSocket(
  horse: THREE.Group,
  manifest: RiderSocketManifest | undefined,
): THREE.Object3D {
  const configured = stringList(manifest?.bone).map(normalizedName).filter(Boolean);
  const aliases = configured.length > 0 ? configured : DEFAULT_RIDER_SOCKET_NAMES;
  const objects: THREE.Object3D[] = [];
  horse.traverse((object) => objects.push(object));
  for (const alias of aliases) {
    const exact = objects.find((object) => normalizedName(object.name) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const partial = objects.find((object) => normalizedName(object.name).includes(alias));
    if (partial) return partial;
  }
  if (configured.length > 0) {
    throw new Error("Horse rider socket not found: " + stringList(manifest?.bone).join(", "));
  }
  return horse;
}

interface MountedRig {
  root: THREE.Group;
  horse: THREE.Group;
  rider: THREE.Group;
}

function assembleMountedRig(
  horse: THREE.Group,
  rider: THREE.Group,
  entry: MountedUnitAssetManifestEntry,
): MountedRig {
  const root = new THREE.Group();
  root.name = "mounted-knight";
  preparePartRoot(horse, entry.horse);
  root.add(horse);
  const socket = findRiderSocket(horse, entry.riderSocket);
  socket.add(rider);
  preparePartRoot(rider, entry.rider);
  const position = finiteVector(entry.riderSocket?.position, "Rider socket position");
  const rotation = finiteVector(entry.riderSocket?.rotationDegrees, "Rider socket rotation");
  rider.position.add(position);
  rider.rotation.x += THREE.MathUtils.degToRad(rotation.x);
  rider.rotation.y += THREE.MathUtils.degToRad(rotation.y);
  rider.rotation.z += THREE.MathUtils.degToRad(rotation.z);
  rider.scale.multiply(positiveScale(entry.riderSocket?.scale, "Rider socket scale"));
  return { root, horse, rider };
}

function disposeBakedFrames(frames: ReadonlyMap<UnitMotion, readonly BakedUnitFrame[]>): void {
  for (const sampled of frames.values()) for (const frame of sampled) frame.geometry.dispose();
}

async function loadSingleAsset(
  archetype: UnitArchetype,
  entry: SingleUnitAssetManifestEntry,
  manifestUrl: string,
  loadGltf: (url: string) => Promise<GLTF>,
): Promise<ExternalUnitAsset> {
  const sourceUrl = resolveUrl(entry.url, manifestUrl);
  const gltf = await loadGltf(sourceUrl);
  const frames = new Map<UnitMotion, readonly BakedUnitFrame[]>();
  let materials: THREE.Material[] | null = null;
  try {
    const supplemental = await loadAnimationClips(entry, manifestUrl, loadGltf);
    const selected = selectedClips(entry, gltf.animations, supplemental);
    const targetHeight = UNIT_METRICS[archetype].height;
    for (const motion of UNIT_MOTIONS) {
      const clip = selected.clips.get(motion) ?? null;
      const times = sampleTimes(clip, frameCount(entry, motion, clip !== null));
      const rig = cloneSkeleton(gltf.scene) as THREE.Group;
      const mixer = new THREE.AnimationMixer(rig);
      playClip(mixer, clip);
      const sampled: BakedUnitFrame[] = [];
      for (let index = 0; index < times.length; index += 1) {
        mixer.setTime(times[index]!);
        rig.updateMatrixWorld(true);
        const baked = bakeScene(rig);
        normalizeGeometry(baked.geometry, targetHeight, entry.forwardAxis ?? "+z");
        materials ??= materialList(baked.materials);
        sampled.push({
          phase: times.length <= 1 ? 0 : index / (times.length - 1),
          geometry: baked.geometry,
        });
      }
      mixer.stopAllAction();
      mixer.uncacheRoot(rig);
      frames.set(motion, sampled);
    }

    if (!materials) throw new Error("No renderable material was found in " + sourceUrl + ".");
    return {
      archetype,
      sourceUrl,
      sourceScene: gltf.scene,
      rawClips: selected.rawClips,
      clips: selected.clips,
      frames,
      materials,
      tintMaterials: entry.tintMaterials ?? DEFAULT_TINT_MATERIALS,
      targetHeight,
    };
  } catch (error) {
    disposeBakedFrames(frames);
    for (const material of materials ?? []) material.dispose();
    disposeObject(gltf.scene);
    throw error;
  }
}

async function loadMountedAsset(
  archetype: "knight",
  entry: MountedUnitAssetManifestEntry,
  manifestUrl: string,
  loadGltf: (url: string) => Promise<GLTF>,
): Promise<ExternalUnitAsset> {
  const horseUrl = resolveUrl(entry.horse.url, manifestUrl);
  const riderUrl = resolveUrl(entry.rider.url, manifestUrl);
  let horseGltf: GLTF | null = null;
  let riderGltf: GLTF | null = null;
  const frames = new Map<UnitMotion, readonly BakedUnitFrame[]>();
  let materials: THREE.Material[] | null = null;
  try {
    horseGltf = await loadGltf(horseUrl);
    riderGltf = await loadGltf(riderUrl);
    const horseSupplemental = await loadAnimationClips(entry.horse, manifestUrl, loadGltf);
    const riderSupplemental = await loadAnimationClips(entry.rider, manifestUrl, loadGltf);
    const horseSelected = selectedClips(entry.horse, horseGltf.animations, horseSupplemental);
    const riderSelected = selectedClips(entry.rider, riderGltf.animations, riderSupplemental);
    const representative = new Map<UnitMotion, THREE.AnimationClip>();
    for (const motion of UNIT_MOTIONS) {
      const clip = riderSelected.clips.get(motion) ?? horseSelected.clips.get(motion);
      if (clip) representative.set(motion, clip);
    }

    const targetHeight = UNIT_METRICS[archetype].height;
    for (const motion of UNIT_MOTIONS) {
      const horseClip = horseSelected.clips.get(motion) ?? null;
      const riderClip = riderSelected.clips.get(motion) ?? null;
      const phases = samplePhases(frameCount(entry, motion, horseClip !== null || riderClip !== null));
      const horseRig = cloneSkeleton(horseGltf.scene) as THREE.Group;
      const riderRig = cloneSkeleton(riderGltf.scene) as THREE.Group;
      const mounted = assembleMountedRig(horseRig, riderRig, entry);
      const horseMixer = new THREE.AnimationMixer(mounted.horse);
      const riderMixer = new THREE.AnimationMixer(mounted.rider);
      playClip(horseMixer, horseClip);
      playClip(riderMixer, riderClip);
      const sampled: BakedUnitFrame[] = [];
      for (const phase of phases) {
        horseMixer.setTime((horseClip?.duration ?? 0) * phase);
        riderMixer.setTime((riderClip?.duration ?? 0) * phase);
        mounted.root.updateMatrixWorld(true);
        const baked = bakeScene(mounted.root);
        normalizeGeometry(baked.geometry, targetHeight, "+z");
        materials ??= materialList(baked.materials);
        sampled.push({ phase, geometry: baked.geometry });
      }
      horseMixer.stopAllAction();
      riderMixer.stopAllAction();
      horseMixer.uncacheRoot(mounted.horse);
      riderMixer.uncacheRoot(mounted.rider);
      frames.set(motion, sampled);
    }

    if (!materials) throw new Error("No renderable material was found in the mounted knight.");
    const source = assembleMountedRig(horseGltf.scene, riderGltf.scene, entry).root;
    return {
      archetype,
      sourceUrl: horseUrl + "#" + riderUrl,
      sourceScene: source,
      rawClips: [...horseSelected.rawClips, ...riderSelected.rawClips],
      clips: representative,
      componentClips: new Map([
        ["horse", horseSelected.clips],
        ["rider", riderSelected.clips],
      ]),
      frames,
      materials,
      tintMaterials: entry.tintMaterials ?? DEFAULT_TINT_MATERIALS,
      targetHeight,
    };
  } catch (error) {
    disposeBakedFrames(frames);
    for (const material of materials ?? []) material.dispose();
    if (horseGltf) disposeObject(horseGltf.scene);
    if (riderGltf) disposeObject(riderGltf.scene);
    throw error;
  }
}

async function loadAsset(
  archetype: UnitArchetype,
  entry: UnitAssetManifestEntry,
  manifestUrl: string,
  loadGltf: (url: string) => Promise<GLTF>,
): Promise<ExternalUnitAsset> {
  if (isMountedEntry(entry)) {
    if (archetype !== "knight") throw new Error("Mounted composites are only supported for knight.");
    return loadMountedAsset(archetype, entry, manifestUrl, loadGltf);
  }
  return loadSingleAsset(archetype, entry, manifestUrl, loadGltf);
}
function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export function cloneFactionMaterials(asset: ExternalUnitAsset, owner: number): THREE.Material[] {
  const faction = FACTIONS[THREE.MathUtils.clamp(Math.trunc(owner), 0, FACTIONS.length - 1)] ?? FACTIONS[0];
  const tint = new THREE.Color(faction.color);
  const patterns = asset.tintMaterials.map(normalizedName);
  return asset.materials.map((source) => {
    const material = source.clone();
    const name = normalizedName(source.name);
    if (patterns.some((pattern) => pattern.length > 0 && name.includes(pattern)) && "color" in material) {
      const color = (material as THREE.MeshStandardMaterial).color;
      if (color instanceof THREE.Color) color.lerp(tint, 0.72);
    }
    if ("vertexColors" in material) (material as THREE.MeshStandardMaterial).vertexColors = true;
    return material;
  });
}

export function unitMotion(state: string): UnitMotion {
  return UNIT_MOTIONS.includes(state as UnitMotion) ? state as UnitMotion : "idle";
}

export function frameIndexForPhase(frameTotal: number, phaseQ: number): number {
  if (frameTotal <= 1) return 0;
  const phase = THREE.MathUtils.clamp(phaseQ / 65_535, 0, 1);
  return Math.min(frameTotal - 1, Math.floor(phase * frameTotal));
}

export async function loadExternalUnitLibrary(
  options: LoadExternalUnitLibraryOptions = {},
): Promise<ExternalUnitLibrary> {
  const manifestUrl = options.manifestUrl ?? `${import.meta.env.BASE_URL}models/units/manifest.json`;
  const manifest = await fetchManifest(manifestUrl);
  const assets = new Map<UnitArchetype, ExternalUnitAsset>();
  const errors = new Map<UnitArchetype, Error>();
  const loader = new GLTFLoader();
  const loadGltf = options.loadGltf ?? ((url: string) => loader.loadAsync(url));
  const entries = UNIT_ARCHETYPES.flatMap((archetype) => {
    const entry = manifest?.units[archetype];
    return entry ? [[archetype, entry] as const] : [];
  });
  if (entries.length === 0) {
    options.onProgress?.(1, "Modelos procedurales listos");
  } else {
    for (let index = 0; index < entries.length; index += 1) {
      const [archetype, entry] = entries[index]!;
      options.onProgress?.(index / entries.length, `Cargando ${archetype}`);
      try {
        assets.set(archetype, await loadAsset(archetype, entry, manifestUrl, loadGltf));
      } catch (error) {
        errors.set(archetype, error instanceof Error ? error : new Error(String(error)));
      }
    }
    options.onProgress?.(1, assets.size > 0 ? "Personajes 3D listos" : "Usando modelos procedurales");
  }

  return {
    assets,
    errors,
    dispose() {
      for (const asset of assets.values()) {
        for (const frames of asset.frames.values()) for (const frame of frames) frame.geometry.dispose();
        for (const material of asset.materials) material.dispose();
        disposeObject(asset.sourceScene);
      }
      assets.clear();
      errors.clear();
    },
  };
}
