import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  FACTIONS,
  createToonMaterial,
  type CastleVisual,
  type CenterVisual,
  type LaneVisual,
  type VegetationBatch,
} from "../procedural";

function transformed(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.BufferGeometry {
  geometry.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  ));
  return geometry;
}

function colored(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const count = geometry.getAttribute("position").count;
  const value = new THREE.Color(color);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    colors[index * 3] = value.r;
    colors[index * 3 + 1] = value.g;
    colors[index * 3 + 2] = value.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const compatible = parts.map((entry) => entry.index ? entry.toNonIndexed() : entry);
  const result = mergeGeometries(compatible, false);
  for (const entry of new Set([...parts, ...compatible])) entry.dispose();
  if (!result) throw new Error("Could not merge insect environment geometry.");
  result.computeVertexNormals();
  result.computeBoundingSphere();
  return result;
}

function meshFromParts(
  group: THREE.Group,
  parts: THREE.BufferGeometry[],
  material: THREE.Material,
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(merged(parts), material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createAnthill(owner: number): CastleVisual {
  const faction = FACTIONS[owner] ?? FACTIONS[0];
  const group = new THREE.Group();
  group.name = `anthill-${owner}`;
  group.position.set(faction.x, 0, faction.z);
  group.userData.baseScale = 1;
  group.userData.baseScaleY = 1;

  const soil = createToonMaterial({ color: 0xffffff, vertexColors: true });
  const root = createToonMaterial({ color: 0x50351f });
  const dark = createToonMaterial({ color: 0x0b100c });
  const resin = createToonMaterial({
    color: faction.color,
    emissive: faction.dark,
    emissiveIntensity: 0.28,
  });
  const glow = createToonMaterial({
    color: faction.accent,
    emissive: faction.color,
    emissiveIntensity: 0.85,
  });

  const moundParts: THREE.BufferGeometry[] = [
    colored(transformed(new THREE.SphereGeometry(3.8, 16, 10), 0, 1.48, 0, 0, 0, 0, 1.45, 0.58, 1.3), 0x6e4a2d),
    colored(transformed(new THREE.SphereGeometry(2.9, 14, 9), -1.4, 2.05, -0.45, 0, 0.25, 0, 1.1, 0.72, 1.12), 0x815738),
    colored(transformed(new THREE.SphereGeometry(2.5, 14, 9), 1.45, 1.9, 0.15, 0, -0.2, 0, 1.08, 0.66, 1.0), 0x5d3e28),
    colored(transformed(new THREE.SphereGeometry(1.85, 12, 8), 0.2, 3.05, -0.4, 0, 0.1, 0, 1.0, 0.9, 0.95), 0x8d6240),
  ];
  for (let index = 0; index < 18; index += 1) {
    const angle = index / 18 * Math.PI * 2;
    const radius = 2.5 + (index % 3) * 0.5;
    moundParts.push(colored(
      transformed(
        new THREE.DodecahedronGeometry(0.42 + (index % 4) * 0.06, 0),
        Math.cos(angle) * radius,
        0.35 + (index % 2) * 0.12,
        Math.sin(angle) * radius,
        0,
        angle,
        (index % 5) * 0.17,
        1.15,
        0.72,
        0.95,
      ),
      index % 2 ? 0x4d3424 : 0x9a6d47,
    ));
  }
  meshFromParts(group, moundParts, soil, "layered-earth");

  const rootParts: THREE.BufferGeometry[] = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2 + 0.22;
    rootParts.push(transformed(
      new THREE.CylinderGeometry(0.16, 0.34, 4.5, 7),
      Math.cos(angle) * 2.7,
      1.05,
      Math.sin(angle) * 2.7,
      Math.PI * 0.5,
      angle,
      0.08 * Math.sin(index * 2.1),
    ));
  }
  meshFromParts(group, rootParts, root, "supporting-roots");

  const entranceParts: THREE.BufferGeometry[] = [];
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI * 0.5;
    entranceParts.push(transformed(
      new THREE.TorusGeometry(0.76, 0.25, 8, 16, Math.PI),
      Math.sin(angle) * 3.9,
      0.82,
      Math.cos(angle) * 3.9,
      Math.PI * 0.5,
      angle,
      0,
      1.25,
      1.15,
      1,
    ));
    entranceParts.push(transformed(
      new THREE.CircleGeometry(0.7, 16),
      Math.sin(angle) * 3.82,
      0.68,
      Math.cos(angle) * 3.82,
      0,
      angle,
      0,
      1.15,
      1.15,
      1,
    ));
  }
  meshFromParts(group, entranceParts, dark, "tunnel-entrances");

  const chimneyParts: THREE.BufferGeometry[] = [];
  const resinParts: THREE.BufferGeometry[] = [];
  const glowParts: THREE.BufferGeometry[] = [];
  const chimneyPositions = [
    [-1.7, -0.35, 4.4],
    [1.4, -0.2, 3.8],
    [-0.35, 1.2, 5.3],
    [1.7, 1.0, 4.1],
  ] as const;
  chimneyPositions.forEach(([x, z, height], index) => {
    chimneyParts.push(colored(
      transformed(new THREE.CylinderGeometry(0.46, 0.78, height, 8), x, height * 0.5, z, 0.04 * index, 0, 0.08 * (index - 1.5)),
      index % 2 ? 0x765035 : 0x8f6441,
    ));
    chimneyParts.push(colored(
      transformed(new THREE.TorusGeometry(0.5, 0.13, 6, 12), x, height + 0.04, z, Math.PI * 0.5),
      0x3d2a1d,
    ));
    resinParts.push(transformed(new THREE.TorusGeometry(0.55, 0.08, 6, 14), x, height * 0.72, z, Math.PI * 0.5));
    glowParts.push(
      transformed(new THREE.OctahedronGeometry(0.18, 0), x, height + 0.35, z),
      transformed(new THREE.SphereGeometry(0.07, 7, 5), x, height + 0.75, z),
    );
  });
  meshFromParts(group, chimneyParts, soil, "fungal-chimneys");
  meshFromParts(group, resinParts, resin, "faction-resin");
  meshFromParts(group, glowParts, glow, "pheromone-lights");

  const banner = new THREE.Mesh(new THREE.RingGeometry(3.05, 3.32, 32), resin);
  banner.rotation.x = -Math.PI * 0.5;
  banner.position.y = 0.24;
  group.add(banner);

  const healthBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x11150f, depthWrite: false }));
  const healthFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: faction.accent, depthWrite: false }));
  healthBack.position.set(0, 7.45, 0);
  healthFill.position.set(0, 7.45, 0.02);
  healthBack.scale.set(5.6, 0.5, 1);
  healthFill.scale.set(5.18, 0.27, 1);
  healthBack.visible = false;
  healthFill.visible = false;
  group.add(healthBack, healthFill);
  return { group, healthBack, healthFill, owner };
}

export function createTermiteTowerGeometry(factionColor = 0x2d8fd5): THREE.BufferGeometry {
  const team = new THREE.Color(factionColor);
  const darkTeam = team.clone().offsetHSL(0, 0.02, -0.24).getHex();
  const parts: THREE.BufferGeometry[] = [
    colored(transformed(new THREE.SphereGeometry(0.9, 12, 8), 0, 0.48, 0, 0, 0, 0, 1.05, 0.65, 1.0), 0x785337),
    colored(transformed(new THREE.CylinderGeometry(0.52, 0.78, 2.55, 8), 0, 1.55, 0, 0.03, 0, 0.04), 0x8f6743),
    colored(transformed(new THREE.SphereGeometry(0.62, 10, 7), 0, 2.66, 0, 0, 0, 0, 1.0, 0.7, 1.0), 0x6b482f),
    colored(transformed(new THREE.TorusGeometry(0.56, 0.1, 6, 14), 0, 2.6, 0, Math.PI * 0.5), factionColor),
    colored(transformed(new THREE.CylinderGeometry(0.15, 0.24, 1.25, 8), 0, 2.62, 0.48, Math.PI * 0.5), darkTeam),
    colored(transformed(new THREE.TorusGeometry(0.25, 0.08, 6, 12), 0, 2.62, 1.08, Math.PI * 0.5), 0x252018),
    colored(transformed(new THREE.OctahedronGeometry(0.2, 0), 0, 3.34, 0), team.clone().offsetHSL(0, 0.08, 0.2).getHex()),
  ];
  for (let index = 0; index < 7; index += 1) {
    const angle = index / 7 * Math.PI * 2;
    parts.push(colored(
      transformed(new THREE.DodecahedronGeometry(0.26, 0), Math.cos(angle) * 0.78, 0.2, Math.sin(angle) * 0.78),
      index % 2 ? 0x60412d : 0x9b704a,
    ));
  }
  return merged(parts);
}

export function createNectarHeart(): CenterVisual {
  const group = new THREE.Group();
  group.name = "nectar-heart";
  const ringMaterial = createToonMaterial({ color: 0x426b35 });
  const crystalMaterial = createToonMaterial({
    color: 0x7ff5ca,
    emissive: 0x2bc99d,
    emissiveIntensity: 0.7,
  });
  const petalMaterial = createToonMaterial({ color: 0xffffff, vertexColors: true });
  const petals: THREE.BufferGeometry[] = [];
  const colors = [0xe76ea9, 0xf08db8, 0xd65e9e, 0xffa2cc, 0xcb528f, 0xef7cad];
  for (let index = 0; index < 12; index += 1) {
    const angle = index / 12 * Math.PI * 2;
    petals.push(colored(
      transformed(
        new THREE.SphereGeometry(0.65, 10, 6),
        Math.cos(angle) * 1.45,
        0.18,
        Math.sin(angle) * 1.45,
        0,
        -angle,
        0,
        1.65,
        0.18,
        0.72,
      ),
      colors[index % colors.length] ?? 0xe76ea9,
    ));
  }
  const petalMesh = new THREE.Mesh(merged(petals), petalMaterial);
  petalMesh.receiveShadow = true;
  group.add(petalMesh);
  const disk = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.22, 0.28, 20), ringMaterial);
  disk.position.y = 0.18;
  disk.receiveShadow = true;
  group.add(disk);
  const crystal = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 9), crystalMaterial);
  crystal.position.y = 0.62;
  crystal.scale.set(1, 0.65, 1);
  crystal.castShadow = true;
  group.add(crystal);
  const progressRing = new THREE.Mesh(
    new THREE.RingGeometry(2.55, 2.82, 48, 1, Math.PI * 0.5, Math.PI * 2),
    new THREE.MeshBasicMaterial({ color: 0xc8ff9b, transparent: true, opacity: 0.86, side: THREE.DoubleSide }),
  );
  progressRing.rotation.x = -Math.PI * 0.5;
  progressRing.position.y = 0.08;
  progressRing.visible = false;
  group.add(progressRing);
  return { group, ringMaterial, crystalMaterial, crystal, progressRing };
}

function laneDistanceSquared(x: number, z: number, lanes: readonly LaneVisual[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    for (let index = 0; index < lane.samples.length; index += 4) {
      const sample = lane.samples[index];
      if (!sample) continue;
      const dx = x - sample.point.x;
      const dz = z - sample.point.z;
      best = Math.min(best, dx * dx + dz * dz);
    }
  }
  return best;
}

function clearOfObjectives(x: number, z: number, radius = 8): boolean {
  if (x * x + z * z < 7.5 * 7.5) return false;
  return FACTIONS.every((faction) => {
    const dx = x - faction.x;
    const dz = z - faction.z;
    return dx * dx + dz * dz >= radius * radius;
  });
}

export function createForestFloorDetails(lanes: readonly LaneVisual[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "forest-floor-macro-detail";
  const random = mulberry32(0x1a5ec7);
  const leaves: Array<{ x: number; z: number; scale: number; rotation: number; color: number }> = [];
  const mushrooms: Array<{ x: number; z: number; scale: number; color: number }> = [];
  const dew: Array<{ x: number; z: number; scale: number }> = [];
  let attempts = 0;
  while ((leaves.length < 82 || mushrooms.length < 58 || dew.length < 70) && attempts < 10_000) {
    attempts += 1;
    const x = random() * 136 - 68;
    const z = random() * 136 - 68;
    if (!clearOfObjectives(x, z, 7.2) || laneDistanceSquared(x, z, lanes) < 4.7 ** 2) continue;
    const roll = random();
    if (leaves.length < 82 && roll < 0.45) {
      const leafColors = [0x9f6438, 0xbd7c3e, 0x6d8c43, 0xc55331, 0x84733a];
      leaves.push({ x, z, scale: 0.65 + random() * 1.25, rotation: random() * Math.PI * 2, color: leafColors[Math.floor(random() * leafColors.length)] ?? 0x9f6438 });
    } else if (mushrooms.length < 58 && roll < 0.78) {
      const capColors = [0xe7c8a0, 0xc55743, 0x9b77bf, 0xe49d4e];
      mushrooms.push({ x, z, scale: 0.45 + random() * 0.85, color: capColors[Math.floor(random() * capColors.length)] ?? 0xe7c8a0 });
    } else if (dew.length < 70) {
      dew.push({ x, z, scale: 0.25 + random() * 0.6 });
    }
  }

  const leafGeometry = new THREE.SphereGeometry(0.7, 10, 6);
  leafGeometry.scale(1.7, 0.08, 0.72);
  const leafMesh = new THREE.InstancedMesh(leafGeometry, new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }), leaves.length);
  const stemMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.12, 0.72, 6), createToonMaterial({ color: 0xe6d3b4 }), mushrooms.length);
  const capMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.52, 10, 6), new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }), mushrooms.length);
  const dewMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.3, 10, 7),
    new THREE.MeshPhysicalMaterial({ color: 0xb8efff, roughness: 0.04, transmission: 0.35, transparent: true, opacity: 0.72 }),
    dew.length,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  leaves.forEach((entry, index) => {
    quaternion.setFromEuler(new THREE.Euler(0, entry.rotation, (random() - 0.5) * 0.18));
    scale.setScalar(entry.scale);
    matrix.compose(new THREE.Vector3(entry.x, 0.13, entry.z), quaternion, scale);
    leafMesh.setMatrixAt(index, matrix);
    leafMesh.setColorAt(index, new THREE.Color(entry.color));
  });
  mushrooms.forEach((entry, index) => {
    quaternion.setFromEuler(new THREE.Euler(0, random() * Math.PI * 2, (random() - 0.5) * 0.16));
    scale.set(entry.scale, entry.scale, entry.scale);
    matrix.compose(new THREE.Vector3(entry.x, 0.36 * entry.scale, entry.z), quaternion, scale);
    stemMesh.setMatrixAt(index, matrix);
    scale.set(entry.scale, entry.scale * 0.45, entry.scale);
    matrix.compose(new THREE.Vector3(entry.x, 0.86 * entry.scale, entry.z), quaternion, scale);
    capMesh.setMatrixAt(index, matrix);
    capMesh.setColorAt(index, new THREE.Color(entry.color));
  });
  dew.forEach((entry, index) => {
    quaternion.identity();
    scale.set(entry.scale, entry.scale * 0.55, entry.scale);
    matrix.compose(new THREE.Vector3(entry.x, 0.15, entry.z), quaternion, scale);
    dewMesh.setMatrixAt(index, matrix);
  });
  for (const mesh of [leafMesh, stemMesh, capMesh, dewMesh]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
  if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
  return group;
}

export function createMacroVegetation(lanes: readonly LaneVisual[]): VegetationBatch[] {
  const random = mulberry32(0xc10ce42);
  const positions: Array<Array<{ x: number; z: number; scale: number; rotation: number }>> = [[], [], [], []];
  let attempts = 0;
  while (positions.reduce((sum, entries) => sum + entries.length, 0) < 260 && attempts < 14_000) {
    attempts += 1;
    const x = random() * 136 - 68;
    const z = random() * 136 - 68;
    if (!clearOfObjectives(x, z, 9.5) || laneDistanceSquared(x, z, lanes) < 5.4 ** 2) continue;
    const quadrant = (x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0);
    positions[quadrant]?.push({ x, z, scale: 0.75 + random() * 0.9, rotation: random() * Math.PI * 2 });
  }

  const stemGeometry = new THREE.CylinderGeometry(0.18, 0.34, 3.6, 7);
  const crownGeometry = merged([
    colored(transformed(new THREE.SphereGeometry(1.1, 10, 6), -0.85, 0, 0, 0, 0, -0.14, 1.3, 0.16, 0.75), 0x4f873c),
    colored(transformed(new THREE.SphereGeometry(1.1, 10, 6), 0.85, 0, 0, 0, 0, 0.14, 1.3, 0.16, 0.75), 0x5b9743),
    colored(transformed(new THREE.SphereGeometry(1.05, 10, 6), 0, 0.05, -0.78, 0, 0, 0, 1.25, 0.16, 0.72), 0x3f7d39),
    colored(transformed(new THREE.SphereGeometry(1.05, 10, 6), 0, 0.04, 0.78, 0, 0, 0, 1.25, 0.16, 0.72), 0x6ba34a),
    colored(transformed(new THREE.SphereGeometry(0.34, 9, 6), 0, 0.2, 0, 0, 0, 0, 1, 0.45, 1), 0xc6e36e),
  ]);
  const shadowGeometry = new THREE.CircleGeometry(1, 14);
  const stemMaterial = createToonMaterial({ color: 0x416c32 });
  const crownMaterial = createToonMaterial({ color: 0xffffff, vertexColors: true });
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x102516, transparent: true, opacity: 0.25, depthWrite: false });
  const batches: VegetationBatch[] = [];
  for (let quadrant = 0; quadrant < positions.length; quadrant += 1) {
    const entries = positions[quadrant] ?? [];
    const group = new THREE.Group();
    group.name = `macro-clover-chunk-${quadrant}`;
    const trunks = new THREE.InstancedMesh(stemGeometry, stemMaterial, Math.max(1, entries.length));
    const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, Math.max(1, entries.length));
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, Math.max(1, entries.length));
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    entries.forEach((entry, index) => {
      quaternion.setFromEuler(new THREE.Euler(0, entry.rotation, (random() - 0.5) * 0.1));
      scale.set(entry.scale, entry.scale, entry.scale);
      matrix.compose(new THREE.Vector3(entry.x, 1.8 * entry.scale, entry.z), quaternion, scale);
      trunks.setMatrixAt(index, matrix);
      const crownScale = entry.scale * (0.9 + random() * 0.2);
      scale.set(crownScale, crownScale, crownScale);
      matrix.compose(new THREE.Vector3(entry.x, 3.62 * entry.scale, entry.z), quaternion, scale);
      crowns.setMatrixAt(index, matrix);
      crowns.setColorAt(index, new THREE.Color(index % 3 === 0 ? 0xd8f4be : 0xffffff));
      quaternion.setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, entry.rotation));
      scale.set(entry.scale * 1.6, entry.scale * 1.15, 1);
      matrix.compose(new THREE.Vector3(entry.x + 0.2, 0.08, entry.z + 0.15), quaternion, scale);
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
    trunks.receiveShadow = true;
    crowns.receiveShadow = true;
    group.add(shadows, trunks, crowns);
    batches.push({ group, trunks, crowns, crownBaseMatrices, shadows, fullCount: entries.length });
  }
  return batches;
}
