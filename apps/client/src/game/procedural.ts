import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import terrainMapUrl from "../assets/terrain-map.png";

export const MAP_HALF_SIZE = 72;
export const LOCAL_PLAYER_ID = 0;
export const MAX_RENDERED_UNITS = 768;

export const FACTIONS = [
  { id: "north", name: "Reino Azul", color: 0x2f8fd1, dark: 0x153c63, accent: 0x9adfff, x: 0, z: -50 },
  { id: "east", name: "Pacto Esmeralda", color: 0x43a85f, dark: 0x214d2e, accent: 0xa7f2b5, x: 50, z: 0 },
  { id: "south", name: "Dominio Áureo", color: 0xd69a2d, dark: 0x6e4619, accent: 0xffdf86, x: 0, z: 50 },
  { id: "west", name: "Legión Carmesí", color: 0xc94a3d, dark: 0x65251f, accent: 0xffa097, x: -50, z: 0 },
] as const;
export const UNIT_ARCHETYPES = ["guard", "archer", "knight", "giant", "commander"] as const;
export type UnitArchetype = (typeof UNIT_ARCHETYPES)[number];
export const UNIT_POSES = ["idle", "walkA", "walkB", "attack", "hit", "death"] as const;
export type UnitPose = (typeof UNIT_POSES)[number];

export interface RoadSample {
  laneId: string;
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  t: number;
  fromPlayer: number | null;
  toPlayer: number | null;
}

export interface LaneVisual {
  id: string;
  from: string;
  to: string;
  fromPlayer: number | null;
  toPlayer: number | null;
  kind: "outer" | "inner" | "center";
  width: number;
  curve: THREE.CatmullRomCurve3;
  samples: RoadSample[];
}

export interface TowerPadVisual {
  laneId: string;
  routeT: number;
  direction: 1 | -1;
  point: THREE.Vector3;
}

export interface CastleVisual {
  group: THREE.Group;
  healthBack: THREE.Sprite;
  healthFill: THREE.Sprite;
  owner: number;
}

export interface CenterVisual {
  group: THREE.Group;
  ringMaterial: THREE.MeshToonMaterial;
  crystalMaterial: THREE.MeshToonMaterial;
  crystal: THREE.Mesh;
  progressRing: THREE.Mesh;
}

export interface VegetationBatch {
  group: THREE.Group;
  trunks: THREE.InstancedMesh;
  crowns: THREE.InstancedMesh;
  crownBaseMatrices: Float32Array;
  fullCount: number;
  shadows: THREE.InstancedMesh;
}
let toonGradient: THREE.DataTexture | null = null;

function getToonGradient(): THREE.DataTexture {
  if (toonGradient) return toonGradient;
  const data = new Uint8Array([
    42, 42, 42, 255,
    104, 104, 104, 255,
    178, 178, 178, 255,
    246, 246, 246, 255,
  ]);
  toonGradient = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  toonGradient.colorSpace = THREE.NoColorSpace;
  toonGradient.magFilter = THREE.NearestFilter;
  toonGradient.minFilter = THREE.NearestFilter;
  toonGradient.generateMipmaps = false;
  toonGradient.needsUpdate = true;
  return toonGradient;
}

export function createToonMaterial(
  parameters: THREE.MeshToonMaterialParameters,
): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({
    gradientMap: getToonGradient(),
    ...parameters,
  });
  return material;
}

export function unitArchetype(kind: string): UnitArchetype {
  if (kind.includes("archer")) return "archer";
  if (kind.includes("knight")) return "knight";
  if (kind.includes("giant")) return "giant";
  if (kind.includes("commander")) return "commander";
  return "guard";
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function factionAtNode(id: string): number | null {
  const normalized = id.toLowerCase();
  if (normalized === "north" || normalized.includes("north")) return 0;
  if (normalized === "east" || normalized.includes("east")) return 1;
  if (normalized === "south" || normalized.includes("south")) return 2;
  if (normalized === "west" || normalized.includes("west")) return 3;
  return null;
}

function pointForNode(id: string): THREE.Vector3 {
  const faction = FACTIONS.find((item) => item.id === id);
  return faction ? new THREE.Vector3(faction.x, 0.08, faction.z) : new THREE.Vector3(0, 0.08, 0);
}

function fallbackLaneDefinitions(): Array<{
  id: string;
  from: string;
  to: string;
  kind: "outer" | "inner" | "center";
  width: number;
  points: THREE.Vector3[];
}> {
  const pairs = [
    ["north", "east", -45],
    ["east", "south", 45],
    ["south", "west", 135],
    ["west", "north", 225],
  ] as const;
  const result: Array<{
    id: string;
    from: string;
    to: string;
    kind: "outer" | "inner" | "center";
    width: number;
    points: THREE.Vector3[];
  }> = [];
  for (const [from, to, angle] of pairs) {
    const radians = THREE.MathUtils.degToRad(angle);
    result.push({
      id: `outer_${from}_${to}`,
      from,
      to,
      kind: "outer",
      width: 2.35,
      points: [
        pointForNode(from),
        new THREE.Vector3(Math.cos(radians) * 42, 0.08, Math.sin(radians) * 42),
        pointForNode(to),
      ],
    });
    result.push({
      id: `inner_${from}_${to}`,
      from,
      to,
      kind: "inner",
      width: 2.5,
      points: [pointForNode(from), pointForNode(to)],
    });
  }
  for (const faction of FACTIONS) {
    result.push({
      id: `center_${faction.id}`,
      from: faction.id,
      to: "center",
      kind: "center",
      width: 2.65,
      points: [pointForNode(faction.id), pointForNode("center")],
    });
  }
  return result;
}

function definitionsFromMapGraph(mapGraph: unknown): ReturnType<typeof fallbackLaneDefinitions> {
  const graph = asRecord(mapGraph);
  if (!graph || !Array.isArray(graph.lanes) || graph.lanes.length !== 12) return fallbackLaneDefinitions();
  const definitions: ReturnType<typeof fallbackLaneDefinitions> = [];
  for (let index = 0; index < graph.lanes.length; index += 1) {
    const lane = asRecord(graph.lanes[index]);
    if (!lane || !Array.isArray(lane.points) || lane.points.length < 2) return fallbackLaneDefinitions();
    const id = asString(lane.id, `lane_${index}`);
    const from = asString(lane.from, "center");
    const to = asString(lane.to, "center");
    const rawKind = asString(lane.kind, "inner");
    const kind = rawKind.includes("outer") ? "outer" : from === "center" || to === "center" || rawKind.includes("center") || rawKind.includes("radial") ? "center" : "inner";
    const points = lane.points.map((rawPoint) => {
      const point = asRecord(rawPoint);
      return new THREE.Vector3(asNumber(point?.x, 0), 0.08, asNumber(point?.z, asNumber(point?.y, 0)));
    });
    definitions.push({ id, from, to, kind, width: asNumber(lane.width, kind === "center" ? 2.65 : 2.45), points });
  }
  return definitions;
}

export function buildLanes(mapGraph?: unknown): LaneVisual[] {
  return definitionsFromMapGraph(mapGraph).map((definition) => {
    const curve = new THREE.CatmullRomCurve3(definition.points, false, "centripetal", 0.5);
    const lane: LaneVisual = {
      id: definition.id,
      from: definition.from,
      to: definition.to,
      fromPlayer: factionAtNode(definition.from),
      toPlayer: factionAtNode(definition.to),
      kind: definition.kind,
      width: definition.width,
      curve,
      samples: [],
    };
    for (let sampleIndex = 0; sampleIndex <= 96; sampleIndex += 1) {
      const t = sampleIndex / 96;
      lane.samples.push({
        laneId: lane.id,
        point: curve.getPointAt(t),
        tangent: curve.getTangentAt(t).normalize(),
        t,
        fromPlayer: lane.fromPlayer,
        toPlayer: lane.toPlayer,
      });
    }
    return lane;
  });
}

export function buildLocalTowerPads(lanes: readonly LaneVisual[]): TowerPadVisual[] {
  const pads: TowerPadVisual[] = [];
  for (const lane of lanes) {
    let routeT: number | null = null;
    let direction: 1 | -1 = 1;
    if (lane.fromPlayer === LOCAL_PLAYER_ID) routeT = 0.145;
    if (lane.toPlayer === LOCAL_PLAYER_ID) {
      routeT = 0.855;
      direction = -1;
    }
    if (routeT === null) continue;
    const point = lane.curve.getPointAt(routeT);
    const tangent = lane.curve.getTangentAt(routeT).normalize().multiplyScalar(direction);
    const side = pads.length % 2 === 0 ? 1 : -1;
    point.x += -tangent.z * 2.4 * side;
    point.z += tangent.x * 2.4 * side;
    point.y = 0.17;
    pads.push({ laneId: lane.id, routeT, direction, point });
  }
  return pads;
}

export function createPixelTexture(
  palette: readonly string[],
  seed: number,
  repeatX: number,
  repeatY: number,
): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is required to create procedural textures.");
  const random = mulberry32(seed);
  context.imageSmoothingEnabled = false;
  context.fillStyle = palette[0] ?? "#ffffff";
  context.fillRect(0, 0, size, size);

  for (let index = 0; index < 260; index += 1) {
    const tone = palette[Math.floor(random() * palette.length)] ?? palette[0] ?? "#ffffff";
    const x = Math.floor(random() * size / 2) * 2;
    const y = Math.floor(random() * size / 2) * 2;
    const width = 2 + Math.floor(random() * 10);
    const height = 2 + Math.floor(random() * 7);
    context.globalAlpha = 0.08 + random() * 0.22;
    context.fillStyle = tone;
    context.fillRect(x, y, width, height);
  }

  context.lineWidth = 1;
  for (let index = 0; index < 48; index += 1) {
    const tone = palette[1 + Math.floor(random() * Math.max(1, palette.length - 1))] ?? palette[0] ?? "#ffffff";
    const x = Math.floor(random() * size);
    const y = Math.floor(random() * size);
    context.globalAlpha = 0.12 + random() * 0.18;
    context.strokeStyle = tone;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + Math.floor(random() * 9) - 4, y + Math.floor(random() * 9) - 4);
    context.stroke();
  }
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

export function createRibbonGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  width: number,
  segments = 96,
  jitter = 0,
  phase = 0,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let distance = 0;
  let previous = curve.getPointAt(0);
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const point = curve.getPointAt(t);
    if (index > 0) distance += point.distanceTo(previous);
    previous = point;
    const tangent = curve.getTangentAt(t).normalize();
    const normalX = -tangent.z;
    const normalZ = tangent.x;
    const endpointFade = Math.sin(Math.PI * t);
    const leftNoise = (Math.sin(index * 0.61 + phase) + Math.sin(index * 0.19 + phase * 1.7) * 0.45) * jitter * endpointFade;
    const rightNoise = (Math.sin(index * 0.53 + phase * 2.1) + Math.cos(index * 0.23 + phase) * 0.4) * jitter * endpointFade;
    const leftWidth = width * 0.5 + leftNoise;
    const rightWidth = width * 0.5 + rightNoise;
    positions.push(point.x + normalX * leftWidth, point.y, point.z + normalZ * leftWidth);
    positions.push(point.x - normalX * rightWidth, point.y, point.z - normalZ * rightWidth);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(distance / 4.2, 0, distance / 4.2, 1);
    if (index < segments) {
      const current = index * 2;
      indices.push(current, current + 2, current + 1, current + 2, current + 3, current + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const BOARD_POINTS = [
  new THREE.Vector2(-66, -72),
  new THREE.Vector2(66, -72),
  new THREE.Vector2(72, -66),
  new THREE.Vector2(72, 66),
  new THREE.Vector2(66, 72),
  new THREE.Vector2(-66, 72),
  new THREE.Vector2(-72, 66),
  new THREE.Vector2(-72, -66),
] as const;

function boardShape(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(BOARD_POINTS[0]!.x, BOARD_POINTS[0]!.y);
  for (let index = 1; index < BOARD_POINTS.length; index += 1) {
    const point = BOARD_POINTS[index]!;
    shape.lineTo(point.x, point.y);
  }
  shape.closePath();
  return shape;
}

function createBoardSideGeometry(topY: number, bottomY: number, bottomScale: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < BOARD_POINTS.length; index += 1) {
    const next = (index + 1) % BOARD_POINTS.length;
    const a = BOARD_POINTS[index]!;
    const b = BOARD_POINTS[next]!;
    const offset = positions.length / 3;
    positions.push(
      a.x, topY, a.y,
      b.x, topY, b.y,
      a.x * bottomScale, bottomY, a.y * bottomScale,
      b.x * bottomScale, bottomY, b.y * bottomScale,
    );
    indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createBoardTopGeometry(textureWorldSize = 144): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(boardShape());
  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    // The texture's outer junctions sit at about 9%/91%; 122 world units aligns them to the ±50 nodes.
    uv[index * 2] = 0.5 + position.getX(index) / textureWorldSize;
    uv[index * 2 + 1] = 0.5 + position.getY(index) / textureWorldSize;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

export function createTerrain(): THREE.Group {
  const group = new THREE.Group();
  group.name = "illustrated-board";
  const baseTexture = createPixelTexture(
    ["#465d12", "#53691a", "#3e5610", "#5d7221", "#354d0e"],
    0x51a7,
    11,
    11,
  );
  const base = new THREE.Mesh(
    createBoardTopGeometry(144),
    new THREE.MeshBasicMaterial({ color: 0xffffff, map: baseTexture, toneMapped: false }),
  );
  base.rotation.x = -Math.PI * 0.5;
  base.position.y = 0.018;
  base.receiveShadow = true;
  group.add(base);

  const terrainTexture = new THREE.TextureLoader().load(terrainMapUrl);
  terrainTexture.colorSpace = THREE.SRGBColorSpace;
  terrainTexture.wrapS = THREE.ClampToEdgeWrapping;
  terrainTexture.wrapT = THREE.ClampToEdgeWrapping;
  terrainTexture.minFilter = THREE.LinearMipmapLinearFilter;
  terrainTexture.magFilter = THREE.LinearFilter;
  terrainTexture.anisotropy = 8;
  terrainTexture.generateMipmaps = true;
  const illustratedLayer = new THREE.Mesh(
    createBoardTopGeometry(144),
    new THREE.MeshBasicMaterial({ color: 0xffffff, map: terrainTexture, toneMapped: false }),
  );
  illustratedLayer.rotation.x = -Math.PI * 0.5;
  illustratedLayer.position.y = 0.036;
  group.add(illustratedLayer);

  const side = new THREE.Mesh(
    createBoardSideGeometry(0, -2.7, 1.025),
    createToonMaterial({ color: 0x263a25 }),
  );
  side.castShadow = true;
  side.receiveShadow = true;
  group.add(side);

  const underlay = new THREE.Mesh(
    new THREE.ShapeGeometry(boardShape()),
    new THREE.MeshBasicMaterial({ color: 0x0b1512 }),
  );
  underlay.rotation.x = -Math.PI * 0.5;
  underlay.position.y = -2.82;
  underlay.scale.setScalar(1.045);
  group.add(underlay);

  return group;
}

export function createRoads(lanes: readonly LaneVisual[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "painted-twelve-road-network";
  const roadTexture = createPixelTexture(["#ad8a54", "#c09a61", "#8e6d42", "#d0aa6b", "#765a37"], 0xc0a57, 1, 1);
  const roadMaterial = createToonMaterial({ color: 0xd0ad74, map: roadTexture });
  const vergeMaterial = createToonMaterial({ color: 0x3c552c });
  const vergeGeometries: THREE.BufferGeometry[] = [];
  const roadGeometries: THREE.BufferGeometry[] = [];

  lanes.forEach((lane, index) => {
    vergeGeometries.push(createRibbonGeometry(lane.curve, lane.width + 1.0, 96, 0.16, index * 2.37));
    roadGeometries.push(createRibbonGeometry(lane.curve, lane.width, 96, 0.22, index * 2.37 + 0.9));
  });
  const vergeGeometry = mergeGeometries(vergeGeometries, false);
  const roadGeometry = mergeGeometries(roadGeometries, false);
  vergeGeometries.forEach((geometry) => geometry.dispose());
  roadGeometries.forEach((geometry) => geometry.dispose());
  if (!vergeGeometry || !roadGeometry) throw new Error("Could not merge the procedural road network.");

  const verge = new THREE.Mesh(vergeGeometry, vergeMaterial);
  verge.position.y = 0.01;
  verge.receiveShadow = true;
  group.add(verge);

  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.position.y = 0.075;
  road.receiveShadow = true;
  group.add(road);

  const uniqueJunctions = new Map<string, THREE.Vector3>();
  for (const lane of lanes) {
    for (const t of [0, 1]) {
      const point = lane.curve.getPointAt(t);
      const key = `${Math.round(point.x)}:${Math.round(point.z)}`;
      uniqueJunctions.set(key, point);
    }
  }
  const junctionGeometry = new THREE.CircleGeometry(1, 18);
  const junctions = new THREE.InstancedMesh(junctionGeometry, roadMaterial, uniqueJunctions.size);
  let junctionIndex = 0;
  for (const point of uniqueJunctions.values()) {
    matrixForGroundDisc.setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, junctionIndex * 0.7));
    sharedMatrix.compose(
      new THREE.Vector3(point.x, 0.17, point.z),
      matrixForGroundDisc,
      new THREE.Vector3(point.length() < 2 ? 3.8 : 3.3, point.length() < 2 ? 3.8 : 3.3, 1),
    );
    junctions.setMatrixAt(junctionIndex, sharedMatrix);
    junctionIndex += 1;
  }
  junctions.instanceMatrix.needsUpdate = true;
  junctions.receiveShadow = true;
  group.add(junctions);
  return group;
}

const sharedMatrix = new THREE.Matrix4();
const matrixForGroundDisc = new THREE.Quaternion();

function buildingMaterial(color: number, map?: THREE.Texture): THREE.MeshToonMaterial {
  return createToonMaterial(map ? { color, map } : { color });
}

function addPart(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function transformedGeometry(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rotationX = 0,
  rotationY = 0,
  rotationZ = 0,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1,
): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotationX, rotationY, rotationZ)),
    new THREE.Vector3(scaleX, scaleY, scaleZ),
  );
  geometry.applyMatrix4(matrix);
  return geometry;
}

function colorGeometry(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const vertexCount = geometry.getAttribute("position").count;
  const value = new THREE.Color(color);
  const colors = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) {
    colors[index * 3] = value.r;
    colors[index * 3 + 1] = value.g;
    colors[index * 3 + 2] = value.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const compatible = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const geometry = mergeGeometries(compatible, false);
  for (const part of new Set([...parts, ...compatible])) part.dispose();
  if (!geometry) throw new Error("Could not merge procedural model parts.");
  geometry.computeBoundingSphere();
  return geometry;
}

function addMergedParts(
  group: THREE.Group,
  parts: THREE.BufferGeometry[],
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(mergeParts(parts), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

export function createCastle(owner: number): CastleVisual {
  const faction = FACTIONS[owner] ?? FACTIONS[0];
  const group = new THREE.Group();
  group.name = `castle-${owner}`;
  group.position.set(faction.x, 0, faction.z);
  group.rotation.y = Math.atan2(-faction.x, -faction.z);

  group.userData.baseScale = 1.1;
  group.userData.baseScaleY = 1.32;
  group.scale.set(1.1, 1.32, 1.1);
  const stoneTexture = createPixelTexture(["#9da092", "#c8c3ad", "#7f857b", "#ddd3b8"], 0xca571e + owner, 3, 3);
  const stoneMaterial = buildingMaterial(0xffffff, stoneTexture);
  const lightStoneMaterial = buildingMaterial(0xded8c2, stoneTexture);
  stoneMaterial.emissive.setHex(0x8e8a78);
  stoneMaterial.emissiveIntensity = 0.1;
  lightStoneMaterial.emissive.setHex(0x9a927d);
  lightStoneMaterial.emissiveIntensity = 0.08;
  const darkMaterial = buildingMaterial(0x62665c);
  const roofMaterial = buildingMaterial(faction.color);
  roofMaterial.emissive.setHex(faction.dark);
  roofMaterial.emissiveIntensity = 0.22;
  const goldMaterial = buildingMaterial(0xe0b85a);

  const darkParts: THREE.BufferGeometry[] = [
    transformedGeometry(new THREE.CylinderGeometry(5.45, 5.75, 0.62, 8), 0, 0.31, 0),
    transformedGeometry(new THREE.BoxGeometry(1.45, 2.25, 0.28), 0, 2.0, -2.18),
    transformedGeometry(new THREE.BoxGeometry(4.46, 0.16, 4.46), 0, 1.62, 0),
    transformedGeometry(new THREE.BoxGeometry(4.34, 0.15, 4.34), 0, 2.28, 0),
    transformedGeometry(new THREE.BoxGeometry(4.34, 0.15, 4.34), 0, 4.16, 0),
  ];
  const stoneParts: THREE.BufferGeometry[] = [
    transformedGeometry(new THREE.CylinderGeometry(5.0, 5.25, 0.68, 8), 0, 0.82, 0),
    transformedGeometry(new THREE.BoxGeometry(4.2, 4.55, 4.2), 0, 3.15, 0),
  ];
  const lightParts: THREE.BufferGeometry[] = [
    transformedGeometry(new THREE.BoxGeometry(3.55, 3.8, 0.34), 0, 3.2, -2.18),
    transformedGeometry(new THREE.CylinderGeometry(5.08, 5.18, 0.18, 12), 0, 1.2, 0),
    transformedGeometry(new THREE.BoxGeometry(4.36, 0.18, 4.36), 0, 4.88, 0),
    transformedGeometry(new THREE.BoxGeometry(0.24, 2.35, 0.38), -0.91, 2.05, -2.38),
    transformedGeometry(new THREE.BoxGeometry(0.24, 2.35, 0.38), 0.91, 2.05, -2.38),
  ];
  const roofParts: THREE.BufferGeometry[] = [];
  const goldParts: THREE.BufferGeometry[] = [];
  const windowParts: THREE.BufferGeometry[] = [];
  const battlement = () => new THREE.BoxGeometry(0.58, 0.7, 0.58);

  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI * 0.5 + Math.PI * 0.25;
    const x = Math.cos(angle) * 3.35;
    const z = Math.sin(angle) * 3.35;
    stoneParts.push(transformedGeometry(new THREE.CylinderGeometry(1.18, 1.32, 4.65, 8), x, 3.17, z));
    darkParts.push(
      transformedGeometry(new THREE.CylinderGeometry(1.52, 1.52, 0.24, 10), x, 5.48, z),
      transformedGeometry(new THREE.CylinderGeometry(1.29, 1.29, 0.13, 10), x, 2.22, z),
      transformedGeometry(new THREE.CylinderGeometry(1.25, 1.25, 0.13, 10), x, 4.12, z),
    );
    lightParts.push(transformedGeometry(new THREE.CylinderGeometry(1.37, 1.42, 0.2, 10), x, 5.22, z));
    roofParts.push(transformedGeometry(new THREE.ConeGeometry(1.52, 2.25, 8), x, 6.62, z, 0, Math.PI / 8));
    goldParts.push(
      transformedGeometry(new THREE.CylinderGeometry(0.07, 0.08, 1.25, 5), x, 8.22, z),
      transformedGeometry(new THREE.SphereGeometry(0.13, 6, 4), x, 7.66, z),
    );
    const bannerDirection = index % 2 === 0 ? 1 : -1;
    roofParts.push(transformedGeometry(new THREE.BoxGeometry(1.12, 0.54, 0.07), x + 0.48 * bannerDirection, 8.45, z));
    const windowX = x + Math.cos(angle) * 1.22;
    const windowZ = z + Math.sin(angle) * 1.22;
    const windowRotation = Math.PI * 0.5 - angle;
    windowParts.push(
      transformedGeometry(new THREE.BoxGeometry(0.29, 0.58, 0.09), windowX, 3.35, windowZ, 0, windowRotation, 0),
      transformedGeometry(new THREE.BoxGeometry(0.25, 0.5, 0.09), windowX, 4.28, windowZ, 0, windowRotation, 0),
    );
  }

  for (let index = -2; index <= 2; index += 1) {
    stoneParts.push(
      transformedGeometry(battlement(), index * 0.82, 5.78, -1.82),
      transformedGeometry(battlement(), index * 0.82, 5.78, 1.82),
    );
    if (index > -2 && index < 2) {
      windowParts.push(transformedGeometry(new THREE.BoxGeometry(0.3, 0.72, 0.1), index * 0.92, 3.35, -2.23));
    }
  }
  for (let index = -1; index <= 1; index += 1) {
    stoneParts.push(
      transformedGeometry(battlement(), -1.82, 5.78, index * 0.9),
      transformedGeometry(battlement(), 1.82, 5.78, index * 0.9),
    );
  }

  darkParts.push(transformedGeometry(new THREE.CylinderGeometry(1.48, 1.48, 0.22, 10), 0, 5.72, 0));
  roofParts.push(transformedGeometry(new THREE.ConeGeometry(1.42, 1.9, 8), 0, 6.75, 0, 0, Math.PI / 8));
  goldParts.push(
    transformedGeometry(new THREE.CylinderGeometry(0.09, 0.11, 1.55, 6), 0, 8.4, 0),
    transformedGeometry(new THREE.SphereGeometry(0.18, 7, 5), 0, 7.75, 0),
  );
  roofParts.push(transformedGeometry(new THREE.BoxGeometry(1.3, 0.62, 0.08), 0.62, 8.72, 0));

  const castleMeshes = [
    addMergedParts(group, darkParts, darkMaterial),
    addMergedParts(group, stoneParts, stoneMaterial),
    addMergedParts(group, lightParts, lightStoneMaterial),
    addMergedParts(group, roofParts, roofMaterial),
    addMergedParts(group, goldParts, goldMaterial),
    addMergedParts(group, windowParts, darkMaterial),
  ];
  const inkMaterial = new THREE.LineBasicMaterial({ color: 0x20231c, transparent: true, opacity: 0.58, depthWrite: false });
  for (const mesh of castleMeshes) {
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 32), inkMaterial);
    outline.renderOrder = 3;
    group.add(outline);
  }

  const backMaterial = new THREE.SpriteMaterial({ color: 0x171912, depthTest: true, depthWrite: false });
  const fillMaterial = new THREE.SpriteMaterial({ color: faction.accent, depthTest: true, depthWrite: false });
  const healthBack = new THREE.Sprite(backMaterial);
  const healthFill = new THREE.Sprite(fillMaterial);
  healthBack.position.set(0, 9.65, 0);
  healthFill.position.set(0, 9.65, 0.02);
  healthBack.scale.set(5.5, 0.52, 1);
  healthFill.scale.set(5.15, 0.28, 1);
  healthBack.visible = false;
  healthFill.visible = false;
  group.add(healthBack, healthFill);
  return { group, healthBack, healthFill, owner };
}

export function createCenterObjective(): CenterVisual {
  const group = new THREE.Group();
  group.name = "center-objective";
  group.scale.set(1.25, 1.6, 1.25);
  const stone = buildingMaterial(0xb5ae98);
  stone.emissive.setHex(0x514d43);
  stone.emissiveIntensity = 0.34;
  const gold = buildingMaterial(0xb99755);
  const ringMaterial = buildingMaterial(0x514b3b);
  const crystalMaterial = createToonMaterial({
    color: 0xd34aff,
    emissive: 0x7b1896,
    emissiveIntensity: 1.45,
  });
  addPart(group, new THREE.CylinderGeometry(3.25, 3.55, 0.5, 14), stone, 0, 0.25, 0);
  addPart(group, new THREE.CylinderGeometry(2.72, 2.95, 0.3, 14), gold, 0, 0.64, 0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.82, 0.15, 5, 28), ringMaterial);
  ring.rotation.x = Math.PI * 0.5;
  ring.position.y = 0.86;
  ring.castShadow = true;
  group.add(ring);
  const progressRing = new THREE.Mesh(
    new THREE.RingGeometry(3.35, 3.62, 48, 1, Math.PI * 0.5, Math.PI * 2),
    new THREE.MeshBasicMaterial({ color: 0xf2d68c, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  progressRing.rotation.x = -Math.PI * 0.5;
  progressRing.position.y = 0.14;
  progressRing.visible = false;
  group.add(progressRing);
  const crystal = addPart(group, new THREE.OctahedronGeometry(0.76, 0), crystalMaterial, 0, 2.58, 0);
  addPart(group, new THREE.CylinderGeometry(0.82, 1.08, 1.32, 8), stone, 0, 1.48, 0);
  return { group, ringMaterial, crystalMaterial, crystal, progressRing };
}
function squaredDistanceToSamples(x: number, z: number, lanes: readonly LaneVisual[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    for (let index = 0; index < lane.samples.length; index += 4) {
      const sample = lane.samples[index];
      if (!sample) continue;
      const dx = x - sample.point.x;
      const dz = z - sample.point.z;
      nearest = Math.min(nearest, dx * dx + dz * dz);
    }
  }
  return nearest;
}

function outsideStrategicClearings(x: number, z: number, radius = 8.5): boolean {
  if (x * x + z * z < 7.5 * 7.5) return false;
  for (const faction of FACTIONS) {
    const dx = x - faction.x;
    const dz = z - faction.z;
    if (dx * dx + dz * dz < radius * radius) return false;
  }
  return true;
}

export function createGroundDetails(lanes: readonly LaneVisual[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "rocks-flowers-and-ground-detail";
  const random = mulberry32(0xdec042);
  const rockEntries: Array<{ x: number; z: number; scale: number; rotation: number }> = [];
  const flowerEntries: Array<{ x: number; z: number; scale: number; color: number }> = [];
  let attempts = 0;
  while ((rockEntries.length < 62 || flowerEntries.length < 175) && attempts < 9_000) {
    attempts += 1;
    const x = random() * 136 - 68;
    const z = random() * 136 - 68;
    if (!outsideStrategicClearings(x, z, 6.5)) continue;
    if (squaredDistanceToSamples(x, z, lanes) < 4.3 ** 2) continue;
    if (rockEntries.length < 62 && random() < 0.16) {
      rockEntries.push({ x, z, scale: 0.35 + random() * 0.75, rotation: random() * Math.PI * 2 });
    } else if (flowerEntries.length < 175) {
      const colors = [0xf0d87b, 0xe8a2b9, 0xc6d7ff, 0xf1eee0];
      flowerEntries.push({ x, z, scale: 0.55 + random() * 0.9, color: colors[Math.floor(random() * colors.length)] ?? 0xf1eee0 });
    }
  }

  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.55, 0),
    createToonMaterial({ color: 0x8b8b79 }),
    Math.max(1, rockEntries.length),
  );
  const flowers = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(0.11, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    Math.max(1, flowerEntries.length),
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  rockEntries.forEach((entry, index) => {
    quaternion.setFromEuler(new THREE.Euler(0, entry.rotation, 0));
    scale.set(entry.scale, entry.scale * (0.65 + random() * 0.35), entry.scale * (0.8 + random() * 0.4));
    matrix.compose(new THREE.Vector3(entry.x, 0.2 * entry.scale, entry.z), quaternion, scale);
    rocks.setMatrixAt(index, matrix);
  });
  flowerEntries.forEach((entry, index) => {
    quaternion.setFromEuler(new THREE.Euler(0, random() * Math.PI * 2, 0));
    scale.setScalar(entry.scale);
    matrix.compose(new THREE.Vector3(entry.x, 0.18, entry.z), quaternion, scale);
    flowers.setMatrixAt(index, matrix);
    flowers.setColorAt(index, new THREE.Color(entry.color));
  });
  rocks.count = rockEntries.length;
  flowers.count = flowerEntries.length;
  rocks.instanceMatrix.needsUpdate = true;
  flowers.instanceMatrix.needsUpdate = true;
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
  rocks.castShadow = false;
  rocks.receiveShadow = true;
  group.add(rocks, flowers);
  return group;
}

export function createVegetation(lanes: readonly LaneVisual[]): VegetationBatch[] {
  const random = mulberry32(0x4f525354);
  const clusterCenters = Array.from({ length: 56 }, () => ({
    x: random() * 122 - 61,
    z: random() * 122 - 61,
  }));
  const positions: Array<Array<{ x: number; z: number; scale: number; rotation: number }>> = [[], [], [], []];
  let attempts = 0;
  while (positions.reduce((sum, chunk) => sum + chunk.length, 0) < 480 && attempts < 14_000) {
    attempts += 1;
    const cluster = clusterCenters[Math.floor(random() * clusterCenters.length)] ?? { x: 0, z: 0 };
    const spreadX = (random() + random() + random() - 1.5) * 10.5;
    const spreadZ = (random() + random() + random() - 1.5) * 10.5;
    const x = attempts % 7 === 0 ? random() * 136 - 68 : cluster.x + spreadX;
    const z = attempts % 7 === 0 ? random() * 136 - 68 : cluster.z + spreadZ;
    if (Math.abs(x) > 68 || Math.abs(z) > 68) continue;
    if (!outsideStrategicClearings(x, z)) continue;
    if (squaredDistanceToSamples(x, z, lanes) < 5.2 ** 2) continue;
    const quadrant = (x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0);
    positions[quadrant]?.push({ x, z, scale: 0.75 + random() * 0.55, rotation: random() * Math.PI * 2 });
  }

  const crownGeometry = mergeParts([
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(1.18, 9, 6), -0.86, 0.1, 0.05, 0, 0.2, 0, 1.08, 0.96, 1.0), 0x4b643b),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(1.2, 9, 6), 0.84, 0.08, 0.12, 0, -0.25, 0, 1.06, 1.0, 1.0), 0x5b7442),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(1.1, 9, 6), -0.18, 0.25, -0.86, 0, 0.1, 0, 1.0, 0.94, 1.08), 0x3f5734),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(1.05, 9, 6), 0.22, 0.2, 0.86, 0, -0.1, 0, 1.04, 0.96, 1.0), 0x627b47),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(1.28, 9, 6), 0, 0.88, -0.08, 0, 0.1, 0, 1.08, 1.02, 1.08), 0x6a824b),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(0.48, 9, 6), -0.58, 0.96, 0.76, 0, 0.15, 0, 1.05, 0.72, 0.92), 0x9aaa68),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(0.38, 9, 6), 0.74, 0.62, 0.58, 0, -0.2, 0, 1.0, 0.7, 0.95), 0x81945a),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(0.42, 9, 6), -0.74, 0.02, -0.8, 0, 0.25, 0, 1.08, 0.72, 1.0), 0x30482c),
    colorGeometry(transformedGeometry(new THREE.SphereGeometry(0.4, 9, 6), 0.02, 1.36, 0.24, 0, -0.1, 0, 1.0, 0.68, 0.94), 0x899b60),
  ]);
  const trunkGeometry = new THREE.CylinderGeometry(0.24, 0.4, 2.25, 6);
  const shadowGeometry = new THREE.CircleGeometry(1, 12);
  const trunkMaterial = buildingMaterial(0x563a26);
  const crownMaterial = createToonMaterial({ color: 0xffffff, vertexColors: true });
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x17231a,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  const crownTints = [0xe2e8d1, 0xd4dfc3, 0xe9ead5, 0xcbd9ba];
  const batches: VegetationBatch[] = [];

  for (let quadrant = 0; quadrant < positions.length; quadrant += 1) {
    const entries = positions[quadrant] ?? [];
    const group = new THREE.Group();
    group.name = `forest-chunk-${quadrant}`;
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, Math.max(1, entries.length));
    const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, Math.max(1, entries.length));
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, Math.max(1, entries.length));
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    entries.forEach((entry, index) => {
      quaternion.setFromEuler(new THREE.Euler(0, entry.rotation, 0));
      scale.set(entry.scale, entry.scale, entry.scale);
      matrix.compose(new THREE.Vector3(entry.x, 1.12 * entry.scale, entry.z), quaternion, scale);
      trunks.setMatrixAt(index, matrix);

      const crownScale = entry.scale * (0.9 + random() * 0.18);
      scale.set(crownScale, crownScale * (0.92 + random() * 0.15), crownScale);
      matrix.compose(new THREE.Vector3(entry.x, 2.72 * entry.scale, entry.z), quaternion, scale);
      crowns.setMatrixAt(index, matrix);
      crowns.setColorAt(index, new THREE.Color(crownTints[(index + quadrant) % crownTints.length] ?? 0xffffff));

      quaternion.setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, entry.rotation + 0.3));
      scale.set(entry.scale * 1.75, entry.scale * 0.9, 1);
      matrix.compose(new THREE.Vector3(entry.x + 0.42, 0.09, entry.z + 0.32), quaternion, scale);
      shadows.setMatrixAt(index, matrix);
    });
    const crownBaseMatrices = new Float32Array(crowns.instanceMatrix.array);
    trunks.count = entries.length;
    crowns.count = entries.length;
    shadows.count = entries.length;
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    shadows.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    trunks.castShadow = false;
    trunks.receiveShadow = true;
    crowns.castShadow = false;
    crowns.receiveShadow = true;
    trunks.computeBoundingSphere();
    crowns.computeBoundingSphere();
    shadows.computeBoundingSphere();
    group.add(shadows, trunks, crowns);
    batches.push({ group, trunks, crowns, crownBaseMatrices, shadows, fullCount: entries.length });
  }
  return batches;
}
function unitPart(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  x: number,
  y: number,
  z: number,
  rotationX = 0,
  rotationY = 0,
  rotationZ = 0,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1,
  poseGroup = 0,
): THREE.BufferGeometry {
  const part = colorGeometry(
    transformedGeometry(geometry, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ),
    color,
  );
  const groups = new Float32Array(part.getAttribute("position").count);
  groups.fill(poseGroup);
  part.setAttribute("poseGroup", new THREE.BufferAttribute(groups, 1));
  return part;
}

function posedUnitPart(
  poseGroup: number,
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  x: number,
  y: number,
  z: number,
  rotationX = 0,
  rotationY = 0,
  rotationZ = 0,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1,
): THREE.BufferGeometry {
  return unitPart(
    geometry,
    color,
    x,
    y,
    z,
    rotationX,
    rotationY,
    rotationZ,
    scaleX,
    scaleY,
    scaleZ,
    poseGroup,
  );
}

function rotatePoseVertexX(
  y: number,
  z: number,
  pivotY: number,
  pivotZ: number,
  angle: number,
): [number, number] {
  const offsetY = y - pivotY;
  const offsetZ = z - pivotZ;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [pivotY + offsetY * cosine - offsetZ * sine, pivotZ + offsetY * sine + offsetZ * cosine];
}

function applyUnitPose(geometry: THREE.BufferGeometry, pose: UnitPose, archetype: UnitArchetype): THREE.BufferGeometry {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const groups = geometry.getAttribute("poseGroup") as THREE.BufferAttribute;
  if (pose === "idle") {
    geometry.deleteAttribute("poseGroup");
    geometry.computeBoundingSphere();
    return geometry;
  }

  const walkDirection = pose === "walkA" ? 1 : pose === "walkB" ? -1 : 0;
  for (let index = 0; index < positions.count; index += 1) {
    let x = positions.getX(index);
    let y = positions.getY(index);
    let z = positions.getZ(index);
    const group = Math.round(groups.getX(index));

    if (walkDirection !== 0 && (group === 1 || group === 2)) {
      const legDirection = group === 1 ? walkDirection : -walkDirection;
      const swing = legDirection * (archetype === "knight" ? 0.28 : 0.38);
      [y, z] = rotatePoseVertexX(y, z, archetype === "knight" ? 0.58 : 0.52, 0, swing);
    }
    if (walkDirection !== 0 && (group === 3 || group === 4)) {
      const armDirection = group === 3 ? -walkDirection : walkDirection;
      [y, z] = rotatePoseVertexX(y, z, archetype === "giant" ? 1.46 : 1.1, 0, armDirection * 0.22);
    }

    if (pose === "attack" && archetype === "archer" && group === 6) {
      [y, z] = rotatePoseVertexX(y, z, 0.88, 0, -1.45);
      z -= 0.18;
    }
    if (pose === "attack" && (group === 3 || group === 4)) {
      if (archetype === "archer") {
        const angle = group === 3 ? 0.72 : -0.48;
        const offsetX = x;
        const offsetZ = z;
        x = offsetX * Math.cos(angle) + offsetZ * Math.sin(angle);
        z = -offsetX * Math.sin(angle) + offsetZ * Math.cos(angle) - 0.12;
      } else {
        const pivotY = archetype === "giant" ? 1.48 : archetype === "knight" ? 1.25 : 0.78;
        const swing = archetype === "giant" ? 0.95 : group === 3 ? -1.05 : -0.42;
        [y, z] = rotatePoseVertexX(y, z, pivotY, 0, swing);
      }
    }

    if (pose === "hit") {
      const angle = 0.24;
      const offsetY = y - 0.08;
      const rotatedX = x * Math.cos(angle) - offsetY * Math.sin(angle);
      const rotatedY = x * Math.sin(angle) + offsetY * Math.cos(angle);
      x = rotatedX + 0.12;
      y = rotatedY + 0.13;
      z += group === 5 ? 0.12 : 0;
    } else if (pose === "death") {
      const angle = -1.18;
      const offsetY = y - 0.06;
      const rotatedX = x * Math.cos(angle) - offsetY * Math.sin(angle);
      const rotatedY = x * Math.sin(angle) + offsetY * Math.cos(angle);
      x = rotatedX;
      y = Math.max(0.035, rotatedY + 0.16);
      z *= 1.1;
    }

    positions.setXYZ(index, x, y, z);
  }
  positions.needsUpdate = true;
  geometry.deleteAttribute("poseGroup");
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createUnitGeometry(
  kind: string = "guard",
  factionColor: number = 0x397fb8,
  pose: UnitPose = "idle",
): THREE.BufferGeometry {
  const archetype = unitArchetype(kind);
  const team = new THREE.Color(factionColor);
  const teamLight = team.clone().offsetHSL(0, 0.08, 0.22).getHex();
  const teamDark = team.clone().offsetHSL(0, 0.04, -0.22).getHex();
  const teamDeep = team.clone().offsetHSL(0, 0.02, -0.33).getHex();
  const skin = 0xe0ad78;
  const skinLight = 0xf1ca91;
  const skinDark = 0xa56c4a;
  const metal = 0xc9ccbc;
  const metalLight = 0xf0ead0;
  const metalDark = 0x4b5350;
  const leather = 0x744a2d;
  const leatherDark = 0x453023;
  const clothDark = 0x262a26;
  const outline = 0x1e2520;
  const hair = 0x3a2921;
  const gold = 0xe0b64c;
  const goldDark = 0x88632d;
  const parts: THREE.BufferGeometry[] = [];

  if (archetype === "guard") {
    parts.push(
      posedUnitPart(1, new THREE.BoxGeometry(0.14, 0.45, 0.18), clothDark, -0.14, 0.28, 0),
      posedUnitPart(2, new THREE.BoxGeometry(0.14, 0.45, 0.18), clothDark, 0.14, 0.28, 0),
      unitPart(new THREE.CylinderGeometry(0.27, 0.34, 0.65, 6), factionColor, 0, 0.76, 0),
      posedUnitPart(5, new THREE.SphereGeometry(0.28, 7, 5), skin, 0, 1.25, 0),
      posedUnitPart(5, new THREE.CylinderGeometry(0.29, 0.33, 0.23, 7), metal, 0, 1.44, 0),
      posedUnitPart(5, new THREE.ConeGeometry(0.27, 0.3, 7), metalDark, 0, 1.68, 0),
      posedUnitPart(3, new THREE.CylinderGeometry(0.07, 0.09, 0.42, 5), skin, -0.29, 0.86, 0, 0, 0, -0.28),
      posedUnitPart(4, new THREE.CylinderGeometry(0.07, 0.09, 0.42, 5), skin, 0.29, 0.86, 0, 0, 0, 0.28),
      posedUnitPart(4, new THREE.CylinderGeometry(0.29, 0.29, 0.08, 10), teamLight, 0.4, 0.87, -0.03, Math.PI * 0.5),
      posedUnitPart(3, new THREE.BoxGeometry(0.075, 0.82, 0.06), metalLight, -0.42, 0.96, 0, 0, 0, -0.18),
      posedUnitPart(3, new THREE.BoxGeometry(0.12, 0.22, 0.09), leather, -0.33, 0.59, 0, 0, 0, -0.18),
    );
  } else if (archetype === "archer") {
    parts.push(
      posedUnitPart(1, new THREE.BoxGeometry(0.13, 0.44, 0.16), leather, -0.13, 0.27, 0),
      posedUnitPart(2, new THREE.BoxGeometry(0.13, 0.44, 0.16), leather, 0.13, 0.27, 0),
      unitPart(new THREE.CylinderGeometry(0.25, 0.32, 0.63, 6), factionColor, 0, 0.73, 0),
      posedUnitPart(5, new THREE.SphereGeometry(0.27, 7, 5), skin, 0, 1.21, -0.01),
      posedUnitPart(5, new THREE.ConeGeometry(0.38, 0.56, 7), teamDark, 0, 1.43, 0.08),
      posedUnitPart(3, new THREE.CylinderGeometry(0.065, 0.085, 0.4, 5), skin, 0.25, 0.88, -0.03, 0, 0, 0.48),
      posedUnitPart(4, new THREE.CylinderGeometry(0.065, 0.085, 0.4, 5), skin, -0.25, 0.88, -0.03, 0, 0, -0.48),
      posedUnitPart(3, new THREE.TorusGeometry(0.42, 0.04, 4, 14, Math.PI * 1.55), leatherDark, 0.4, 0.88, -0.04, 0, 0, -0.78),
      posedUnitPart(6, new THREE.BoxGeometry(0.045, 0.88, 0.045), 0xd9bd7a, 0.39, 0.88, -0.04, 0, 0, -0.07),
      unitPart(new THREE.BoxGeometry(0.26, 0.5, 0.12), leather, -0.22, 0.9, 0.2, 0, 0, -0.16),
    );
  } else if (archetype === "knight") {
    parts.push(
      unitPart(new THREE.BoxGeometry(0.72, 0.58, 1.12), teamDark, 0, 0.65, 0.04),
      unitPart(new THREE.BoxGeometry(0.36, 0.42, 0.48), teamLight, 0, 0.82, -0.72, -0.18),
      posedUnitPart(1, new THREE.BoxGeometry(0.13, 0.55, 0.15), leather, -0.25, 0.27, -0.3),
      posedUnitPart(2, new THREE.BoxGeometry(0.13, 0.55, 0.15), leather, 0.25, 0.27, -0.3),
      posedUnitPart(2, new THREE.BoxGeometry(0.13, 0.55, 0.15), leather, -0.25, 0.27, 0.36),
      posedUnitPart(1, new THREE.BoxGeometry(0.13, 0.55, 0.15), leather, 0.25, 0.27, 0.36),
      unitPart(new THREE.CylinderGeometry(0.24, 0.3, 0.55, 6), factionColor, 0, 1.2, 0.08),
      posedUnitPart(5, new THREE.SphereGeometry(0.26, 7, 5), skinDark, 0, 1.6, 0.05),
      posedUnitPart(5, new THREE.ConeGeometry(0.31, 0.4, 7), metal, 0, 1.84, 0.05),
      posedUnitPart(4, new THREE.CylinderGeometry(0.3, 0.3, 0.08, 10), factionColor, 0.39, 1.24, -0.02, Math.PI * 0.5),
      posedUnitPart(3, new THREE.CylinderGeometry(0.07, 0.09, 0.42, 5), metal, -0.28, 1.26, -0.04, 0, 0, -0.35),
      posedUnitPart(3, new THREE.CylinderGeometry(0.04, 0.05, 1.85, 5), metalLight, -0.45, 1.28, -0.08, 0, 0, -0.35),
    );
  } else if (archetype === "giant") {
    parts.push(
      posedUnitPart(1, new THREE.BoxGeometry(0.3, 0.72, 0.34), leather, -0.28, 0.38, 0),
      posedUnitPart(2, new THREE.BoxGeometry(0.3, 0.72, 0.34), leather, 0.28, 0.38, 0),
      unitPart(new THREE.DodecahedronGeometry(0.72, 0), leather, 0, 1.12, 0, 0, 0, 0, 1.05, 1.18, 0.78),
      posedUnitPart(3, new THREE.CylinderGeometry(0.22, 0.27, 0.94, 6), skin, -0.68, 1.08, 0, 0, 0, -0.24),
      posedUnitPart(4, new THREE.CylinderGeometry(0.22, 0.27, 0.94, 6), skin, 0.68, 1.08, 0, 0, 0, 0.24),
      posedUnitPart(5, new THREE.SphereGeometry(0.4, 7, 5), skinDark, 0, 1.86, -0.02),
      unitPart(new THREE.BoxGeometry(1.18, 0.2, 0.18), factionColor, 0, 0.88, -0.54),
      posedUnitPart(3, new THREE.CylinderGeometry(0.12, 0.17, 1.5, 6), leather, 0.78, 0.98, 0, 0, 0, 0.42),
      posedUnitPart(3, new THREE.DodecahedronGeometry(0.32, 0), 0x66543c, 1.08, 1.5, 0),
    );
  } else {
    parts.push(
      posedUnitPart(1, new THREE.BoxGeometry(0.16, 0.5, 0.19), clothDark, -0.15, 0.3, 0),
      posedUnitPart(2, new THREE.BoxGeometry(0.16, 0.5, 0.19), clothDark, 0.15, 0.3, 0),
      unitPart(new THREE.CylinderGeometry(0.3, 0.38, 0.72, 7), factionColor, 0, 0.84, 0),
      unitPart(new THREE.BoxGeometry(0.66, 0.78, 0.09), teamDark, 0, 0.88, 0.2),
      posedUnitPart(5, new THREE.SphereGeometry(0.3, 8, 5), skin, 0, 1.39, -0.02),
      posedUnitPart(5, new THREE.CylinderGeometry(0.29, 0.33, 0.26, 7), metalDark, 0, 1.57, -0.02),
      posedUnitPart(5, new THREE.CylinderGeometry(0.33, 0.36, 0.18, 7), gold, 0, 1.75, -0.02),
      posedUnitPart(5, new THREE.ConeGeometry(0.1, 0.26, 5), gold, -0.19, 1.98, -0.02),
      posedUnitPart(5, new THREE.ConeGeometry(0.1, 0.3, 5), gold, 0, 2.03, -0.02),
      posedUnitPart(5, new THREE.ConeGeometry(0.1, 0.26, 5), gold, 0.19, 1.98, -0.02),
      posedUnitPart(3, new THREE.CylinderGeometry(0.075, 0.095, 0.46, 5), skin, -0.29, 0.93, 0, 0, 0, -0.3),
      posedUnitPart(4, new THREE.CylinderGeometry(0.075, 0.095, 0.46, 5), skin, 0.29, 0.93, 0, 0, 0, 0.3),
      posedUnitPart(3, new THREE.BoxGeometry(0.09, 0.96, 0.07), metalLight, -0.45, 1.05, 0, 0, 0, -0.22),
      posedUnitPart(3, new THREE.BoxGeometry(0.16, 0.23, 0.1), gold, -0.35, 0.63, 0, 0, 0, -0.22),
    );
  }

  return applyUnitPose(mergeParts(parts), pose, archetype);
}

export function createCannonTowerGeometry(factionColor: number = 0x397fb8): THREE.BufferGeometry {
  const team = new THREE.Color(factionColor);
  const teamDark = team.clone().offsetHSL(0, 0.02, -0.2).getHex();
  const parts: THREE.BufferGeometry[] = [
    unitPart(new THREE.CylinderGeometry(0.92, 1.12, 0.36, 10), 0x3a3c37, 0, 0.18, 0),
    unitPart(new THREE.CylinderGeometry(0.72, 0.88, 1.45, 8), 0x969486, 0, 0.98, 0),
    unitPart(new THREE.CylinderGeometry(0.86, 0.86, 0.22, 10), teamDark, 0, 1.74, 0),
    unitPart(new THREE.CylinderGeometry(0.12, 0.18, 1.15, 7), 0x4a4d49, 0, 1.78, -0.45, Math.PI * 0.5),
    unitPart(new THREE.CylinderGeometry(0.24, 0.24, 0.25, 8), factionColor, 0, 1.78, -0.95, Math.PI * 0.5),
  ];
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * Math.PI * 2;
    parts.push(unitPart(
      new THREE.BoxGeometry(0.28, 0.34, 0.28),
      0xaaa797,
      Math.cos(angle) * 0.7,
      1.98,
      Math.sin(angle) * 0.7,
      0,
      angle,
    ));
  }
  return mergeParts(parts);
}
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
