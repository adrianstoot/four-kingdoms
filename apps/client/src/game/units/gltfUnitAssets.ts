import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import {
  FACTIONS, UNIT_ARCHETYPES, UNIT_METRICS, createToonMaterial, type UnitArchetype,
} from "../procedural";

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
  death: ["death", "dead", "die", "dying", "defeat", "muerte", "caer"],
  spawn: ["spawn", "summon", "appear", "enter", "deploy", "invocar", "aparicion"],
};

/**
 * Mass-battle assets are expanded to non-indexed geometry for the instanced
 * animation frames. Reject unsuitable source art before that expansion can
 * freeze a tab or consume hundreds of megabytes.
 */
const MAX_SINGLE_SOURCE_TRIANGLES = 40_000;
const MAX_MOUNTED_SOURCE_TRIANGLES = 60_000;
const MAX_SOURCE_GPU_BYTES = 96 * 1024 * 1024;
const MAX_BAKED_GEOMETRY_BYTES = 128 * 1024 * 1024;
const BAKED_BYTES_PER_TRIANGLE = 3 * 11 * Float32Array.BYTES_PER_ELEMENT;
const MIN_VISIBLE_VERTEX_DELTA_SQ = 0.003 ** 2;
const MIN_VISIBLE_RMS_DELTA_SQ = 0.0005 ** 2;
const LOOPING_MOTIONS = new Set<UnitMotion>(["idle", "walk", "attack"]);

class UnitAssetValidationError extends Error {
  override name = "UnitAssetValidationError";
}


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

function isExportHelperMesh(object: THREE.Object3D): boolean {
  const name = normalizedName(object.name);
  return name === "icosphere" || name.startsWith("icosphere ");
}

function isRenderableUnitMesh(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh && object.visible && !isExportHelperMesh(object);
}

function stringList(value: string | string[] | undefined): readonly string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function manifestError(path: string, message: string): never {
  throw new UnitAssetValidationError(`Invalid unit asset manifest at ${path}: ${message}`);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) manifestError(path, `unexpected field(s): ${unexpected.join(", ")}.`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) manifestError(path, "expected a non-empty string.");
  const trimmed = value.trim();
  if (trimmed.length > 2_048 || /[\u0000-\u001f]/.test(trimmed)) {
    manifestError(path, "contains control characters or is longer than 2048 characters.");
  }
  return trimmed;
}

function parseStringChoice(value: unknown, path: string): string | string[] {
  if (typeof value === "string") return nonEmptyString(value, path);
  if (!Array.isArray(value) || value.length === 0) {
    return manifestError(path, "expected a string or a non-empty string array.");
  }
  const unique = [...new Set(value.map((item, index) => nonEmptyString(item, `${path}[${index}]`)))];
  if (unique.length > 16) manifestError(path, "contains more than 16 alternatives.");
  return unique;
}

function parseMotionMap(
  value: unknown,
  path: string,
): Partial<Record<UnitMotion, string | string[]>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return manifestError(path, "expected an object keyed by motion.");
  assertKnownKeys(value, UNIT_MOTIONS, path);
  const parsed: Partial<Record<UnitMotion, string | string[]>> = {};
  for (const motion of UNIT_MOTIONS) {
    if (value[motion] !== undefined) parsed[motion] = parseStringChoice(value[motion], `${path}.${motion}`);
  }
  return parsed;
}

function parseForwardAxis(value: unknown, path: string): UnitForwardAxis | undefined {
  if (value === undefined) return undefined;
  if (value === "+z" || value === "-z" || value === "+x" || value === "-x") return value;
  return manifestError(path, 'expected one of "+z", "-z", "+x" or "-x".');
}

function parsePositiveScale(
  value: unknown,
  path: string,
): number | [number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (
    Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return manifestError(path, "expected a positive number or three positive finite numbers.");
}

function parseFiniteTriple(value: unknown, path: string): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (
    Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return manifestError(path, "expected exactly three finite numbers.");
}

function parseSampleFrames(
  value: unknown,
  path: string,
): number | Partial<Record<UnitMotion, number>> | undefined {
  if (value === undefined) return undefined;
  const parseCount = (candidate: unknown, candidatePath: string): number => {
    if (!Number.isInteger(candidate) || (candidate as number) < 2 || (candidate as number) > 12) {
      return manifestError(candidatePath, "expected an integer from 2 to 12.");
    }
    return candidate as number;
  };
  if (typeof value === "number") return parseCount(value, path);
  if (!isRecord(value)) return manifestError(path, "expected a frame count or an object keyed by motion.");
  assertKnownKeys(value, UNIT_MOTIONS, path);
  const parsed: Partial<Record<UnitMotion, number>> = {};
  for (const motion of UNIT_MOTIONS) {
    if (value[motion] !== undefined) parsed[motion] = parseCount(value[motion], `${path}.${motion}`);
  }
  return parsed;
}

function parseTintMaterials(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    return manifestError(path, "expected between 1 and 32 material-name fragments.");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = nonEmptyString(value[index], `${path}[${index}]`);
    const normalized = normalizedName(item);
    if (!seen.has(normalized)) {
      result.push(item);
      seen.add(normalized);
    }
  }
  return result;
}

function parseAnimationSource(
  value: Record<string, unknown>,
  path: string,
  allowScale: boolean,
): UnitAnimationSourceManifest & { scale?: number | [number, number, number] } {
  return {
    animationUrls: parseMotionMap(value.animationUrls, `${path}.animationUrls`),
    clips: parseMotionMap(value.clips, `${path}.clips`),
    forwardAxis: parseForwardAxis(value.forwardAxis, `${path}.forwardAxis`),
    scale: allowScale ? parsePositiveScale(value.scale, `${path}.scale`) : undefined,
  };
}

function parseSingleEntry(value: Record<string, unknown>, path: string): SingleUnitAssetManifestEntry {
  assertKnownKeys(
    value,
    ["type", "url", "animationUrls", "clips", "forwardAxis", "sampleFrames", "tintMaterials"],
    path,
  );
  if (value.type !== undefined && value.type !== "single") manifestError(`${path}.type`, 'expected "single".');
  const animation = parseAnimationSource(value, path, false);
  return {
    type: value.type === "single" ? "single" : undefined,
    url: nonEmptyString(value.url, `${path}.url`),
    animationUrls: animation.animationUrls,
    clips: animation.clips,
    forwardAxis: animation.forwardAxis,
    sampleFrames: parseSampleFrames(value.sampleFrames, `${path}.sampleFrames`),
    tintMaterials: parseTintMaterials(value.tintMaterials, `${path}.tintMaterials`),
  };
}

function parseMountedPart(value: unknown, path: string): MountedUnitPartManifestEntry {
  if (!isRecord(value)) return manifestError(path, "expected an object.");
  assertKnownKeys(value, ["url", "animationUrls", "clips", "forwardAxis", "scale"], path);
  const animation = parseAnimationSource(value, path, true);
  return {
    url: nonEmptyString(value.url, `${path}.url`),
    animationUrls: animation.animationUrls,
    clips: animation.clips,
    forwardAxis: animation.forwardAxis,
    scale: animation.scale,
  };
}

function parseRiderSocket(value: unknown, path: string): RiderSocketManifest | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return manifestError(path, "expected an object.");
  assertKnownKeys(value, ["bone", "position", "rotationDegrees", "scale"], path);
  return {
    bone: value.bone === undefined ? undefined : parseStringChoice(value.bone, `${path}.bone`),
    position: parseFiniteTriple(value.position, `${path}.position`),
    rotationDegrees: parseFiniteTriple(value.rotationDegrees, `${path}.rotationDegrees`),
    scale: parsePositiveScale(value.scale, `${path}.scale`),
  };
}

function parseMountedEntry(value: Record<string, unknown>, path: string): MountedUnitAssetManifestEntry {
  assertKnownKeys(value, ["type", "horse", "rider", "riderSocket", "sampleFrames", "tintMaterials"], path);
  if (value.type !== "mounted") manifestError(`${path}.type`, 'expected "mounted".');
  return {
    type: "mounted",
    horse: parseMountedPart(value.horse, `${path}.horse`),
    rider: parseMountedPart(value.rider, `${path}.rider`),
    riderSocket: parseRiderSocket(value.riderSocket, `${path}.riderSocket`),
    sampleFrames: parseSampleFrames(value.sampleFrames, `${path}.sampleFrames`),
    tintMaterials: parseTintMaterials(value.tintMaterials, `${path}.tintMaterials`),
  };
}

function isMountedEntry(entry: UnitAssetManifestEntry): entry is MountedUnitAssetManifestEntry {
  return entry.type === "mounted";
}

function parseManifest(value: unknown): UnitAssetManifest {
  if (!isRecord(value)) manifestError("$", "expected an object.");
  assertKnownKeys(value, ["version", "units"], "$");
  if (value.version !== 1) manifestError("$.version", "expected 1.");
  if (!isRecord(value.units)) manifestError("$.units", "expected an object.");
  const knownArchetypes = new Set<string>(UNIT_ARCHETYPES);
  const unknown = Object.keys(value.units).filter((key) => !knownArchetypes.has(key));
  if (unknown.length > 0) manifestError("$.units", `unknown archetype(s): ${unknown.join(", ")}.`);

  const units: Partial<Record<UnitArchetype, UnitAssetManifestEntry>> = {};
  for (const archetype of UNIT_ARCHETYPES) {
    const raw = value.units[archetype];
    if (raw === undefined) continue;
    if (!isRecord(raw)) manifestError(`$.units.${archetype}`, "expected an object.");
    if (raw.type === "mounted") {
      if (archetype !== "knight") {
        manifestError(`$.units.${archetype}.type`, "mounted composites are only supported for knight.");
      }
      units[archetype] = parseMountedEntry(raw, `$.units.${archetype}`);
    } else {
      units[archetype] = parseSingleEntry(raw, `$.units.${archetype}`);
    }
  }
  return { version: 1, units };
}

interface ManifestFetchResult {
  manifest: UnitAssetManifest | null;
  error: Error | null;
}

async function fetchManifest(url: string): Promise<ManifestFetchResult> {
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      if (response.status === 404) return { manifest: null, error: null };
      return {
        manifest: null,
        error: new UnitAssetValidationError(`Unit asset manifest request failed with HTTP ${response.status}.`),
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      return {
        manifest: null,
        error: new UnitAssetValidationError(
          `Unit asset manifest must be JSON; received ${contentType || "an unknown content type"}.`,
        ),
      };
    }
    return { manifest: parseManifest(await response.json()), error: null };
  } catch (error) {
    return {
      manifest: null,
      error: error instanceof Error ? error : new UnitAssetValidationError(String(error)),
    };
  }
}

function resolveUrl(url: string, relativeTo: string): string {
  const documentUrl = typeof window !== "undefined" ? window.location.href : "http://localhost/";
  const absoluteBase = new URL(relativeTo, documentUrl);
  const resolved = new URL(url, absoluteBase);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:" && resolved.protocol !== "blob:") {
    throw new UnitAssetValidationError(`Unsupported unit asset URL protocol: ${resolved.protocol}`);
  }
  return resolved.href;
}

function findNamedClip(
  clips: readonly THREE.AnimationClip[],
  names: readonly string[],
): THREE.AnimationClip | null {
  const normalized = names.map(normalizedName);
  for (const name of normalized) {
    const exact = clips.find((clip) => normalizedName(clip.name) === name);
    if (exact) return exact;
  }
  for (const name of normalized) {
    const partial = clips.find((clip) => normalizedName(clip.name).includes(name));
    if (partial) return partial;
  }
  return null;
}

function chooseClip(
  motion: UnitMotion,
  clips: readonly THREE.AnimationClip[],
  configured: string | string[] | undefined,
): THREE.AnimationClip | null {
  const requested = stringList(configured);
  return findNamedClip(clips, requested.length > 0 ? requested : DEFAULT_CLIP_ALIASES[motion]);
}

function frameCount(entry: UnitAssetManifestEntry, motion: UnitMotion, hasClip: boolean): number {
  if (!hasClip) return 1;
  const configured = typeof entry.sampleFrames === "number" ? entry.sampleFrames : entry.sampleFrames?.[motion];
  return THREE.MathUtils.clamp(Math.trunc(configured ?? DEFAULT_FRAME_COUNTS[motion]), 2, 12);
}

interface SourceAssetStats {
  renderedTriangles: number;
  sourceBytes: number;
}

function arrayBufferByteLength(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  const array = attribute instanceof THREE.InterleavedBufferAttribute
    ? attribute.data.array
    : attribute.array;
  return array.byteLength;
}

function textureMemoryBytes(texture: THREE.Texture): number {
  const mipmaps = texture.mipmaps as Array<{ data?: ArrayBufferView }> | undefined;
  if (mipmaps && mipmaps.length > 0) {
    return mipmaps.reduce((total, mip) => total + (mip.data?.byteLength ?? 0), 0);
  }
  const image = texture.image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  } | undefined;
  const width = image?.width ?? image?.naturalWidth ?? 0;
  const height = image?.height ?? image?.naturalHeight ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.ceil(width * height * 4 * 4 / 3);
}

function inspectSourceAssets(roots: readonly THREE.Object3D[]): SourceAssetStats {
  let renderedTriangles = 0;
  let sourceBytes = 0;
  const measuredGeometries = new Set<THREE.BufferGeometry>();
  const measuredTextures = new Set<THREE.Texture>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!isRenderableUnitMesh(object)) return;
      const geometry = object.geometry;
      const position = geometry.getAttribute("position");
      if (!position || position.itemSize < 3 || position.count < 3) {
        throw new UnitAssetValidationError(`Visible mesh "${object.name || "(unnamed)"}" has no valid position attribute.`);
      }
      const elementCount = geometry.index?.count ?? position.count;
      renderedTriangles += Math.floor(elementCount / 3);
      if (!measuredGeometries.has(geometry)) {
        measuredGeometries.add(geometry);
        const measuredBuffers = new Set<ArrayBufferLike>();
        const attributes = Object.values(geometry.attributes) as Array<
          THREE.BufferAttribute | THREE.InterleavedBufferAttribute
        >;
        for (const attribute of attributes) {
          const array = attribute instanceof THREE.InterleavedBufferAttribute
            ? attribute.data.array
            : attribute.array;
          if (!measuredBuffers.has(array.buffer)) {
            sourceBytes += array.buffer.byteLength;
            measuredBuffers.add(array.buffer);
          }
        }
        if (geometry.index && !measuredBuffers.has(geometry.index.array.buffer)) {
          sourceBytes += geometry.index.array.byteLength;
        }
      }
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const candidate of Object.values(material)) {
          if (candidate instanceof THREE.Texture && !measuredTextures.has(candidate)) {
            measuredTextures.add(candidate);
            sourceBytes += textureMemoryBytes(candidate);
          }
        }
      }
    });
  }
  return { renderedTriangles, sourceBytes };
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function assertSourceBudget(
  label: string,
  roots: readonly THREE.Object3D[],
  maxTriangles: number,
): SourceAssetStats {
  const stats = inspectSourceAssets(roots);
  if (stats.renderedTriangles <= 0) {
    throw new UnitAssetValidationError(`${label} contains no visible triangles.`);
  }
  if (stats.renderedTriangles > maxTriangles) {
    throw new UnitAssetValidationError(
      `${label} has ${stats.renderedTriangles.toLocaleString("en-US")} rendered triangles; `
      + `the mass-battle limit is ${maxTriangles.toLocaleString("en-US")}. Optimize or decimate the GLB first.`,
    );
  }
  if (stats.sourceBytes > MAX_SOURCE_GPU_BYTES) {
    throw new UnitAssetValidationError(
      `${label} needs approximately ${formatMebibytes(stats.sourceBytes)} of source geometry/textures; `
      + `the limit is ${formatMebibytes(MAX_SOURCE_GPU_BYTES)}.`,
    );
  }
  return stats;
}

function predictedFrameCount(
  entry: UnitAssetManifestEntry,
  clips: ReadonlyMap<UnitMotion, THREE.AnimationClip>,
): number {
  let total = 0;
  let missingMotion = false;
  const sampled = new Map<THREE.AnimationClip, Set<number>>();
  for (const motion of UNIT_MOTIONS) {
    const clip = clips.get(motion);
    if (!clip) {
      missingMotion = true;
      continue;
    }
    const count = frameCount(entry, motion, true);
    const cacheKey = LOOPING_MOTIONS.has(motion) ? count : -count;
    const counts = sampled.get(clip) ?? new Set<number>();
    if (!counts.has(cacheKey)) {
      total += count;
      counts.add(cacheKey);
      sampled.set(clip, counts);
    }
  }
  if (missingMotion && !clips.has("idle")) total += 1;
  return Math.max(1, total);
}

function assertBakedBudget(
  label: string,
  renderedTriangles: number,
  uniqueFrameCount: number,
): void {
  const estimated = renderedTriangles * BAKED_BYTES_PER_TRIANGLE * uniqueFrameCount;
  if (estimated > MAX_BAKED_GEOMETRY_BYTES) {
    throw new UnitAssetValidationError(
      `${label} would bake about ${formatMebibytes(estimated)} across ${uniqueFrameCount} animation frames; `
      + `the per-unit limit is ${formatMebibytes(MAX_BAKED_GEOMETRY_BYTES)}. Reduce triangles or sampleFrames.`,
    );
  }
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
    if (!isRenderableUnitMesh(object)) return;
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

function sampleTimes(clip: THREE.AnimationClip | null, count: number, looping = false): number[] {
  if (!clip || count <= 1 || clip.duration <= 0) return [0];
  return samplePhases(count, looping).map((phase) => clip.duration * phase);
}

function samplePhases(count: number, looping = false): number[] {
  if (count <= 1) return [0];
  // Omit the duplicated end pose in loops, otherwise three samples become
  // bind/contact/bind and the unit looks frozen during most of its stride.
  const divisor = looping ? count : count - 1;
  return Array.from({ length: count }, (_, index) => index / divisor);
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
  const allSet = new Set<THREE.AnimationClip>();
  const preferred = new Map<UnitMotion, THREE.AnimationClip[]>();
  const loadedByUrl = new Map<string, readonly THREE.AnimationClip[]>();
  for (const motion of UNIT_MOTIONS) {
    const motionClips: THREE.AnimationClip[] = [];
    const urls = [...new Set(stringList(entry.animationUrls?.[motion]))];
    for (const relativeUrl of urls) {
      const url = resolveUrl(relativeUrl, manifestUrl);
      let loaded = loadedByUrl.get(url);
      if (!loaded) {
        const animated = await loadGltf(url);
        loaded = [...animated.animations];
        disposeObject(animated.scene);
        if (loaded.length === 0) {
          throw new UnitAssetValidationError(`Supplemental animation ${url} contains no clips.`);
        }
        loadedByUrl.set(url, loaded);
      }
      for (const clip of loaded) {
        motionClips.push(clip);
        if (!allSet.has(clip)) {
          allSet.add(clip);
          all.push(clip);
        }
      }
    }
    if (motionClips.length > 0) preferred.set(motion, motionClips);
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
  const rawClips = [...new Set([...base, ...supplemental.all])];
  const clips = new Map<UnitMotion, THREE.AnimationClip>();
  for (const motion of UNIT_MOTIONS) {
    const configured = entry.clips?.[motion];
    const preferred = supplemental.preferred.get(motion) ?? [];
    const clip = configured !== undefined
      ? chooseClip(motion, rawClips, configured)
      : preferred[0] ?? chooseClip(motion, rawClips, undefined);
    if (configured !== undefined && !clip) {
      throw new UnitAssetValidationError(
        `Configured ${motion} clip not found: ${stringList(configured).join(", ")}.`,
      );
    }
    if (clip) {
      if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.tracks.length === 0) {
        throw new UnitAssetValidationError(
          `Animation clip "${clip.name || "(unnamed)"}" for ${motion} has no usable duration or tracks.`,
        );
      }
      clips.set(motion, clip);
    }
  }
  return { rawClips, clips };
}

function assertClipTargetsScene(
  root: THREE.Object3D,
  clip: THREE.AnimationClip,
  label: string,
): void {
  const hasTarget = clip.tracks.some((track) => {
    try {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (parsed.objectName === "bones" && parsed.objectIndex) {
        return THREE.PropertyBinding.findNode(root, parsed.objectIndex) !== null;
      }
      if (!parsed.nodeName || parsed.nodeName === ".") return true;
      return THREE.PropertyBinding.findNode(root, parsed.nodeName) !== null;
    } catch {
      return false;
    }
  });
  if (!hasTarget) {
    throw new UnitAssetValidationError(
      `${label} clip "${clip.name || "(unnamed)"}" does not target this model's rig or scene hierarchy.`,
    );
  }
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
  const geometries = new Set<THREE.BufferGeometry>();
  for (const sampled of frames.values()) {
    for (const frame of sampled) geometries.add(frame.geometry);
  }
  for (const geometry of geometries) geometry.dispose();
}

function framesContainDeformation(frames: readonly BakedUnitFrame[]): boolean {
  const first = frames[0]?.geometry.getAttribute("position");
  if (!first) return false;
  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const current = frames[frameIndex]?.geometry.getAttribute("position");
    if (!current || current.count !== first.count || current.itemSize !== first.itemSize) return true;
    let largestDeltaSq = 0;
    let totalDeltaSq = 0;
    for (let vertex = 0; vertex < first.count; vertex += 1) {
      const dx = current.getX(vertex) - first.getX(vertex);
      const dy = current.getY(vertex) - first.getY(vertex);
      const dz = current.getZ(vertex) - first.getZ(vertex);
      const deltaSq = dx * dx + dy * dy + dz * dz;
      largestDeltaSq = Math.max(largestDeltaSq, deltaSq);
      totalDeltaSq += deltaSq;
    }
    if (
      largestDeltaSq >= MIN_VISIBLE_VERTEX_DELTA_SQ
      && totalDeltaSq / Math.max(1, first.count) >= MIN_VISIBLE_RMS_DELTA_SQ
    ) return true;
  }
  return false;
}

function assertFramesDeform(
  label: string,
  motion: UnitMotion,
  clipNames: readonly string[],
  frames: readonly BakedUnitFrame[],
): void {
  if (framesContainDeformation(frames)) return;
  throw new UnitAssetValidationError(
    `${label} ${motion} clip(s) [${clipNames.join(", ")}] produce no visible deformation. `
    + "Check the skeleton/bone names and export a genuinely rigged animation.",
  );
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
    const sourceStats = assertSourceBudget(
      `${archetype} GLB`,
      [gltf.scene],
      MAX_SINGLE_SOURCE_TRIANGLES,
    );
    const supplemental = await loadAnimationClips(entry, manifestUrl, loadGltf);
    const selected = selectedClips(entry, gltf.animations, supplemental);
    if (selected.rawClips.length === 0) {
      throw new UnitAssetValidationError(
        `${archetype} GLB contains no animation clips. Keep the procedural fallback until the model is genuinely rigged.`,
      );
    }
    if (selected.rawClips.length > 0 && selected.clips.size === 0) {
      throw new UnitAssetValidationError(
        `${archetype} GLB contains animations, but none match the supported motions: ${UNIT_MOTIONS.join(", ")}.`,
      );
    }
    for (const [motion, clip] of selected.clips) {
      assertClipTargetsScene(gltf.scene, clip, `${archetype} ${motion}`);
    }
    assertBakedBudget(
      `${archetype} GLB`,
      sourceStats.renderedTriangles,
      predictedFrameCount(entry, selected.clips),
    );

    const targetHeight = UNIT_METRICS[archetype].height;
    const cache = new Map<THREE.AnimationClip, Map<number, readonly BakedUnitFrame[]>>();
    for (const motion of UNIT_MOTIONS) {
      const clip = selected.clips.get(motion);
      if (!clip) continue;
      const count = frameCount(entry, motion, true);
      const looping = LOOPING_MOTIONS.has(motion);
      const cacheKey = looping ? count : -count;
      const byCount = cache.get(clip) ?? new Map<number, readonly BakedUnitFrame[]>();
      let sampled = byCount.get(cacheKey);
      if (!sampled) {
        const phases = samplePhases(count, looping);
        const times = sampleTimes(clip, count, looping);
        const rig = cloneSkeleton(gltf.scene) as THREE.Group;
        const mixer = new THREE.AnimationMixer(rig);
        playClip(mixer, clip);
        const bakedFrames: BakedUnitFrame[] = [];
        for (let index = 0; index < times.length; index += 1) {
          mixer.setTime(times[index]!);
          rig.updateMatrixWorld(true);
          const baked = bakeScene(rig);
          normalizeGeometry(baked.geometry, targetHeight, entry.forwardAxis ?? "+z");
          materials ??= materialList(baked.materials);
          bakedFrames.push({
            phase: phases[index] ?? 0,
            geometry: baked.geometry,
          });
        }
        mixer.stopAllAction();
        mixer.uncacheRoot(rig);
        assertFramesDeform(`${archetype} GLB`, motion, [clip.name], bakedFrames);
        sampled = bakedFrames;
        byCount.set(cacheKey, sampled);
        cache.set(clip, byCount);
      }
      frames.set(motion, sampled);
    }

    let fallback = frames.get("idle");
    if (!fallback) {
      const rig = cloneSkeleton(gltf.scene) as THREE.Group;
      rig.updateMatrixWorld(true);
      const baked = bakeScene(rig);
      normalizeGeometry(baked.geometry, targetHeight, entry.forwardAxis ?? "+z");
      materials ??= materialList(baked.materials);
      fallback = [{ phase: 0, geometry: baked.geometry }];
    }
    for (const motion of UNIT_MOTIONS) {
      if (!frames.has(motion)) frames.set(motion, fallback);
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
    const sourceStats = assertSourceBudget(
      "mounted knight GLBs",
      [horseGltf.scene, riderGltf.scene],
      MAX_MOUNTED_SOURCE_TRIANGLES,
    );
    const horseSupplemental = await loadAnimationClips(entry.horse, manifestUrl, loadGltf);
    const riderSupplemental = await loadAnimationClips(entry.rider, manifestUrl, loadGltf);
    const horseSelected = selectedClips(entry.horse, horseGltf.animations, horseSupplemental);
    const riderSelected = selectedClips(entry.rider, riderGltf.animations, riderSupplemental);
    if (horseSelected.rawClips.length === 0 || riderSelected.rawClips.length === 0) {
      const missing = horseSelected.rawClips.length === 0 ? "horse" : "rider";
      throw new UnitAssetValidationError(
        `Mounted knight ${missing} GLB contains no animation clips; both components must be independently rigged.`,
      );
    }
    if (horseSelected.rawClips.length > 0 && horseSelected.clips.size === 0) {
      throw new UnitAssetValidationError("Horse GLB has animations, but none match a supported motion.");
    }
    if (riderSelected.rawClips.length > 0 && riderSelected.clips.size === 0) {
      throw new UnitAssetValidationError("Rider GLB has animations, but none match a supported motion.");
    }
    for (const [motion, clip] of horseSelected.clips) {
      assertClipTargetsScene(horseGltf.scene, clip, `horse ${motion}`);
    }
    for (const [motion, clip] of riderSelected.clips) {
      assertClipTargetsScene(riderGltf.scene, clip, `rider ${motion}`);
    }

    const representative = new Map<UnitMotion, THREE.AnimationClip>();
    let predictedFrames = 0;
    let missingMotion = false;
    for (const motion of UNIT_MOTIONS) {
      const horseClip = horseSelected.clips.get(motion);
      const riderClip = riderSelected.clips.get(motion);
      const clip = riderClip ?? horseClip;
      if (clip) {
        representative.set(motion, clip);
        predictedFrames += frameCount(entry, motion, true);
      } else {
        missingMotion = true;
      }
    }
    if (missingMotion && !representative.has("idle")) predictedFrames += 1;
    assertBakedBudget("mounted knight GLBs", sourceStats.renderedTriangles, Math.max(1, predictedFrames));

    const targetHeight = UNIT_METRICS[archetype].height;
    for (const motion of UNIT_MOTIONS) {
      const horseClip = horseSelected.clips.get(motion) ?? null;
      const riderClip = riderSelected.clips.get(motion) ?? null;
      if (!horseClip && !riderClip) continue;
      const phases = samplePhases(frameCount(entry, motion, true), LOOPING_MOTIONS.has(motion));
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
      assertFramesDeform(
        "mounted knight GLBs",
        motion,
        [horseClip?.name, riderClip?.name].filter((name): name is string => Boolean(name)),
        sampled,
      );
      frames.set(motion, sampled);
    }

    let fallback = frames.get("idle");
    if (!fallback) {
      const horseRig = cloneSkeleton(horseGltf.scene) as THREE.Group;
      const riderRig = cloneSkeleton(riderGltf.scene) as THREE.Group;
      const mounted = assembleMountedRig(horseRig, riderRig, entry);
      mounted.root.updateMatrixWorld(true);
      const baked = bakeScene(mounted.root);
      normalizeGeometry(baked.geometry, targetHeight, "+z");
      materials ??= materialList(baked.materials);
      fallback = [{ phase: 0, geometry: baked.geometry }];
    }
    for (const motion of UNIT_MOTIONS) {
      if (!frames.has(motion)) frames.set(motion, fallback);
    }

    if (!materials) throw new Error("No renderable material was found in the mounted knight.");
    const source = assembleMountedRig(horseGltf.scene, riderGltf.scene, entry).root;
    return {
      archetype,
      sourceUrl: horseUrl + "#" + riderUrl,
      sourceScene: source,
      rawClips: [...new Set([...horseSelected.rawClips, ...riderSelected.rawClips])],
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

/**
 * Give the renderer an independently owned material while retaining the GLB's
 * compatible texture channels. MeshStandard/Physical inputs are converted to
 * the shared banded toon material; unsupported material families are cloned.
 * Textures intentionally remain shared because disposing a material does not
 * dispose its textures.
 */
export function createExternalToonMaterial(source: THREE.Material): THREE.Material {
  if (source instanceof THREE.MeshToonMaterial) return source.clone();
  if (!(source instanceof THREE.MeshStandardMaterial)) return source.clone();

  const material = createToonMaterial({
    color: source.color,
    map: source.map,
    lightMap: source.lightMap,
    lightMapIntensity: source.lightMapIntensity,
    aoMap: source.aoMap,
    aoMapIntensity: source.aoMapIntensity,
    emissive: source.emissive,
    emissiveIntensity: source.emissiveIntensity,
    emissiveMap: source.emissiveMap,
    bumpMap: source.bumpMap,
    bumpScale: source.bumpScale,
    normalMap: source.normalMap,
    normalMapType: source.normalMapType,
    normalScale: source.normalScale.clone(),
    displacementMap: source.displacementMap,
    displacementScale: source.displacementScale,
    displacementBias: source.displacementBias,
    alphaMap: source.alphaMap,
    wireframe: source.wireframe,
    wireframeLinewidth: source.wireframeLinewidth,
    wireframeLinecap: source.wireframeLinecap,
    wireframeLinejoin: source.wireframeLinejoin,
    fog: source.fog,
  });
  const copyBase = THREE.Material.prototype.copy as (
    this: THREE.Material,
    input: THREE.Material,
  ) => THREE.Material;
  copyBase.call(material, source);
  material.needsUpdate = true;
  return material;
}

export function unitMotion(state: string): UnitMotion {
  if (state === "dead") return "death";
  return UNIT_MOTIONS.includes(state as UnitMotion) ? state as UnitMotion : "idle";
}

export function frameIndexForPhase(frameTotal: number, phaseQ: number, looping = true): number {
  if (frameTotal <= 1) return 0;
  const quantized = THREE.MathUtils.clamp(Math.trunc(phaseQ), 0, 65_535);
  if (looping) {
    // 65,536 is the phase ring size; the maximum quantized value therefore
    // stays in the final sample instead of wrapping one tick early.
    return Math.min(frameTotal - 1, Math.floor(quantized / 65_536 * frameTotal));
  }
  return Math.min(frameTotal - 1, Math.round(quantized / 65_535 * (frameTotal - 1)));
}

export async function loadExternalUnitLibrary(
  options: LoadExternalUnitLibraryOptions = {},
): Promise<ExternalUnitLibrary> {
  const manifestUrl = options.manifestUrl ?? `${import.meta.env.BASE_URL}models/units/manifest.json`;
  const assets = new Map<UnitArchetype, ExternalUnitAsset>();
  const errors = new Map<UnitArchetype, Error>();
  const manifestResult = await fetchManifest(manifestUrl);
  if (manifestResult.error) {
    for (const archetype of UNIT_ARCHETYPES) errors.set(archetype, manifestResult.error);
  }
  const loader = new GLTFLoader();
  const loadGltf = options.loadGltf ?? ((url: string) => loader.loadAsync(url));
  const entries = UNIT_ARCHETYPES.flatMap((archetype) => {
    const entry = manifestResult.manifest?.units[archetype];
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
        disposeBakedFrames(asset.frames);
        for (const material of new Set(asset.materials)) material.dispose();
        disposeObject(asset.sourceScene);
      }
      assets.clear();
      errors.clear();
    },
  };
}
