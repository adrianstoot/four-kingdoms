import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Internal archetype IDs stay stable for deterministic snapshots. Their visual
 * identities are, respectively: soldier ant, stinger bee, hunting mantis,
 * rhinoceros beetle and monarch butterfly.
 */
export const DETAILED_UNIT_ARCHETYPES = ["guard", "archer", "knight", "giant", "commander"] as const;
export type DetailedUnitArchetype = (typeof DETAILED_UNIT_ARCHETYPES)[number];
export type DetailedUnitPose =
  | "idle"
  | "walkA"
  | "walkB"
  | "attackWindup"
  | "attack"
  | "attackRecover"
  | "hit"
  | "death"
  | "spawn";

export const DETAILED_UNIT_METRICS: Readonly<Record<DetailedUnitArchetype, {
  height: number;
  radius: number;
  eyeHeight: number;
}>> = {
  guard: { height: 1.15, radius: 0.38, eyeHeight: 0.82 },
  archer: { height: 1.2, radius: 0.4, eyeHeight: 0.88 },
  knight: { height: 1.55, radius: 0.56, eyeHeight: 1.32 },
  giant: { height: 2.2, radius: 0.86, eyeHeight: 1.35 },
  commander: { height: 1.6, radius: 0.52, eyeHeight: 1.05 },
};

interface Palette {
  team: number;
  teamLight: number;
  teamDark: number;
  shell: number;
  shellLight: number;
  shellDark: number;
  joint: number;
  ink: number;
  eye: number;
  wing: number;
  wingVein: number;
  glow: number;
  gold: number;
}

function palette(factionColor: number): Palette {
  const team = new THREE.Color(factionColor);
  return {
    team: factionColor,
    teamLight: team.clone().offsetHSL(0, 0.08, 0.2).getHex(),
    teamDark: team.clone().offsetHSL(0, 0.03, -0.25).getHex(),
    shell: 0x352c26,
    shellLight: 0x695345,
    shellDark: 0x171513,
    joint: 0x211c18,
    ink: 0x090c0b,
    eye: 0x9af4de,
    wing: 0xb9e7d9,
    wingVein: 0x4d6f69,
    glow: 0x80f7dd,
    gold: 0xe2b33f,
  };
}

function part(
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
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotationX, rotationY, rotationZ)),
    new THREE.Vector3(scaleX, scaleY, scaleZ),
  );
  geometry.applyMatrix4(matrix);
  const count = geometry.getAttribute("position").count;
  const value = new THREE.Color(color);
  const colors = new Float32Array(count * 3);
  const groups = new Float32Array(count);
  groups.fill(poseGroup);
  for (let index = 0; index < count; index += 1) {
    colors[index * 3] = value.r;
    colors[index * 3 + 1] = value.g;
    colors[index * 3 + 2] = value.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("poseGroup", new THREE.BufferAttribute(groups, 1));
  return geometry;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const compatible = parts.map((entry) => entry.index ? entry.toNonIndexed() : entry);
  const geometry = mergeGeometries(compatible, false);
  for (const entry of new Set([...parts, ...compatible])) entry.dispose();
  if (!geometry) throw new Error("Could not merge procedural insect geometry.");
  return geometry;
}

function normalize(geometry: THREE.BufferGeometry, archetype: DetailedUnitArchetype): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return geometry;
  const authoredHeight = Math.max(0.001, bounds.max.y - bounds.min.y);
  const scale = DETAILED_UNIT_METRICS[archetype].height / authoredHeight;
  const centerX = (bounds.min.x + bounds.max.x) * 0.5;
  const centerZ = (bounds.min.z + bounds.max.z) * 0.5;
  geometry.translate(-centerX, -bounds.min.y, -centerZ);
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function ellipsoid(
  group: number,
  color: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  detail = 10,
): THREE.BufferGeometry {
  return part(group, new THREE.SphereGeometry(0.5, detail, Math.max(6, detail - 3)), color, x, y, z, 0, 0, 0, sx, sy, sz);
}

function addEyes(parts: THREE.BufferGeometry[], p: Palette, y: number, z: number, spread: number, radius: number): void {
  parts.push(
    ellipsoid(12, p.eye, -spread, y, z, radius, radius * 0.78, radius * 0.42, 8),
    ellipsoid(12, p.eye, spread, y, z, radius, radius * 0.78, radius * 0.42, 8),
    ellipsoid(12, p.ink, -spread, y, z + radius * 0.38, radius * 0.34, radius * 0.42, radius * 0.18, 7),
    ellipsoid(12, p.ink, spread, y, z + radius * 0.38, radius * 0.34, radius * 0.42, radius * 0.18, 7),
  );
}

function addAntennae(
  parts: THREE.BufferGeometry[],
  p: Palette,
  y: number,
  z: number,
  spread: number,
  length: number,
): void {
  for (const side of [-1, 1] as const) {
    const group = 12;
    parts.push(
      part(group, new THREE.CylinderGeometry(0.018, 0.024, length * 0.58, 5), p.joint, side * spread, y, z, -0.62, 0, side * -0.26),
      part(group, new THREE.CylinderGeometry(0.013, 0.019, length * 0.52, 5), p.shellDark, side * (spread + length * 0.18), y + length * 0.31, z + length * 0.22, -0.78, 0, side * -0.48),
      ellipsoid(group, p.teamLight, side * (spread + length * 0.34), y + length * 0.5, z + length * 0.42, 0.052, 0.052, 0.07, 7),
    );
  }
}

function addLeg(
  parts: THREE.BufferGeometry[],
  p: Palette,
  group: number,
  side: -1 | 1,
  z: number,
  y: number,
  reach: number,
  thickness: number,
  forwardBias = 0,
): void {
  const coxaX = side * 0.2;
  const kneeX = side * (0.2 + reach * 0.42);
  const footX = side * (0.2 + reach);
  const femurRotationZ = side * -0.92;
  const tibiaRotationZ = side * 0.78;
  parts.push(
    ellipsoid(group, p.joint, coxaX, y, z, thickness * 1.3, thickness, thickness * 1.15, 7),
    part(group, new THREE.CylinderGeometry(thickness * 0.68, thickness, reach * 0.58, 6), p.shell, side * (0.2 + reach * 0.22), y - reach * 0.05, z + forwardBias, 0, 0, femurRotationZ),
    ellipsoid(group, p.teamDark, kneeX, y - reach * 0.13, z + forwardBias * 1.3, thickness * 1.05, thickness * 1.05, thickness, 7),
    part(group, new THREE.CylinderGeometry(thickness * 0.5, thickness * 0.72, reach * 0.72, 6), p.shellDark, side * (0.2 + reach * 0.7), y - reach * 0.32, z + forwardBias * 1.8, 0, 0, tibiaRotationZ),
    part(group, new THREE.BoxGeometry(reach * 0.36, thickness * 0.42, thickness * 0.95), p.joint, footX, 0.035, z + forwardBias * 2.2, 0, side * 0.08, 0),
  );
}

function addSixLegs(
  parts: THREE.BufferGeometry[],
  p: Palette,
  y: number,
  reach: number,
  thickness: number,
  spacing: number,
): void {
  const rows = [
    { z: spacing, bias: reach * 0.18, left: 1, right: 2 },
    { z: 0, bias: 0, left: 3, right: 4 },
    { z: -spacing, bias: -reach * 0.18, left: 5, right: 6 },
  ] as const;
  for (const row of rows) {
    addLeg(parts, p, row.left, -1, row.z, y, reach, thickness, row.bias);
    addLeg(parts, p, row.right, 1, row.z, y, reach, thickness, row.bias);
  }
}

function addWing(
  parts: THREE.BufferGeometry[],
  p: Palette,
  group: 9 | 10,
  side: -1 | 1,
  x: number,
  y: number,
  z: number,
  length: number,
  width: number,
  sweep: number,
  color = p.wing,
): void {
  parts.push(
    ellipsoid(group, color, x + side * length * 0.42, y, z + sweep, length, 0.055, width, 12),
    part(group, new THREE.BoxGeometry(length * 0.82, 0.018, 0.018), p.wingVein, x + side * length * 0.4, y + 0.012, z + sweep, 0, -side * 0.18, 0),
    part(group, new THREE.BoxGeometry(length * 0.5, 0.014, 0.014), p.wingVein, x + side * length * 0.42, y + 0.01, z + sweep + width * 0.18, 0, -side * 0.55, 0),
  );
}

function soldierAnt(p: Palette): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    ellipsoid(0, p.shell, 0, 0.43, 0, 0.56, 0.48, 0.62),
    ellipsoid(11, p.shellLight, 0, 0.47, -0.62, 0.7, 0.56, 0.82, 12),
    ellipsoid(11, p.teamDark, 0, 0.5, -0.75, 0.52, 0.38, 0.62, 10),
    ellipsoid(12, p.shellDark, 0, 0.55, 0.55, 0.52, 0.46, 0.5, 11),
    part(0, new THREE.TorusGeometry(0.29, 0.075, 6, 14), p.team, 0, 0.5, -0.08, Math.PI * 0.5),
    part(7, new THREE.ConeGeometry(0.09, 0.5, 6), p.shellLight, -0.26, 0.43, 0.94, Math.PI * 0.5, 0, 0.45),
    part(8, new THREE.ConeGeometry(0.09, 0.5, 6), p.shellLight, 0.26, 0.43, 0.94, Math.PI * 0.5, 0, -0.45),
    ellipsoid(7, p.joint, -0.2, 0.47, 0.72, 0.1, 0.1, 0.12, 7),
    ellipsoid(8, p.joint, 0.2, 0.47, 0.72, 0.1, 0.1, 0.12, 7),
  ];
  addSixLegs(parts, p, 0.38, 0.72, 0.075, 0.37);
  addEyes(parts, p, 0.62, 0.91, 0.18, 0.1);
  addAntennae(parts, p, 0.78, 0.68, 0.17, 0.58);
  return parts;
}

function stingerBee(p: Palette): THREE.BufferGeometry[] {
  const yellow = 0xe0ad2f;
  const amber = 0xf5cb52;
  const parts: THREE.BufferGeometry[] = [
    ellipsoid(0, yellow, 0, 0.66, 0.04, 0.56, 0.52, 0.62, 12),
    ellipsoid(11, amber, 0, 0.68, -0.52, 0.57, 0.49, 0.78, 12),
    ellipsoid(12, p.shellDark, 0, 0.7, 0.53, 0.48, 0.46, 0.46, 11),
    part(0, new THREE.TorusGeometry(0.31, 0.08, 6, 16), p.shellDark, 0, 0.69, -0.38, Math.PI * 0.5),
    part(0, new THREE.TorusGeometry(0.32, 0.075, 6, 16), p.team, 0, 0.69, -0.05, Math.PI * 0.5),
    part(11, new THREE.ConeGeometry(0.085, 0.46, 7), p.shellDark, 0, 0.67, -1.07, -Math.PI * 0.5),
  ];
  addSixLegs(parts, p, 0.58, 0.52, 0.055, 0.3);
  addWing(parts, p, 9, -1, -0.15, 0.95, -0.08, 0.92, 0.42, -0.05);
  addWing(parts, p, 10, 1, 0.15, 0.95, -0.08, 0.92, 0.42, -0.05);
  addEyes(parts, p, 0.78, 0.79, 0.17, 0.12);
  addAntennae(parts, p, 0.92, 0.67, 0.15, 0.42);
  return parts;
}

function huntingMantis(p: Palette): THREE.BufferGeometry[] {
  const green = 0x598f43;
  const greenLight = 0x88b85a;
  const parts: THREE.BufferGeometry[] = [
    ellipsoid(0, green, 0, 0.86, 0.02, 0.42, 0.92, 0.38, 10),
    ellipsoid(11, greenLight, 0, 0.73, -0.55, 0.52, 0.58, 0.78, 12),
    ellipsoid(12, greenLight, 0, 1.28, 0.47, 0.58, 0.38, 0.5, 10),
    part(0, new THREE.BoxGeometry(0.16, 0.58, 0.18), p.team, 0, 1.04, 0.06, -0.2),
    part(7, new THREE.CylinderGeometry(0.055, 0.085, 0.86, 6), green, -0.34, 1.02, 0.37, -0.5, 0, -0.32),
    part(7, new THREE.CylinderGeometry(0.04, 0.07, 0.72, 6), greenLight, -0.55, 0.76, 0.78, 0.75, 0, 0.08),
    part(7, new THREE.ConeGeometry(0.06, 0.5, 5), p.shellDark, -0.58, 0.65, 1.08, Math.PI * 0.5, 0, 0.12),
    part(8, new THREE.CylinderGeometry(0.055, 0.085, 0.86, 6), green, 0.34, 1.02, 0.37, -0.5, 0, 0.32),
    part(8, new THREE.CylinderGeometry(0.04, 0.07, 0.72, 6), greenLight, 0.55, 0.76, 0.78, 0.75, 0, -0.08),
    part(8, new THREE.ConeGeometry(0.06, 0.5, 5), p.shellDark, 0.58, 0.65, 1.08, Math.PI * 0.5, 0, -0.12),
  ];
  // Four walking legs plus the two raptorial forelegs above.
  addLeg(parts, p, 3, -1, 0.05, 0.66, 0.82, 0.065, 0.04);
  addLeg(parts, p, 4, 1, 0.05, 0.66, 0.82, 0.065, 0.04);
  addLeg(parts, p, 5, -1, -0.42, 0.6, 0.9, 0.07, -0.12);
  addLeg(parts, p, 6, 1, -0.42, 0.6, 0.9, 0.07, -0.12);
  addWing(parts, p, 9, -1, -0.1, 1.02, -0.4, 0.62, 0.28, -0.15, 0x789e54);
  addWing(parts, p, 10, 1, 0.1, 1.02, -0.4, 0.62, 0.28, -0.15, 0x89ae5c);
  addEyes(parts, p, 1.35, 0.75, 0.22, 0.15);
  addAntennae(parts, p, 1.48, 0.62, 0.18, 0.68);
  return parts;
}

function rhinocerosBeetle(p: Palette): THREE.BufferGeometry[] {
  const bronze = 0x4b3328;
  const bronzeLight = 0x80604a;
  const parts: THREE.BufferGeometry[] = [
    ellipsoid(11, bronze, 0, 0.75, -0.46, 1.08, 0.78, 1.18, 14),
    ellipsoid(0, bronzeLight, 0, 0.74, 0.34, 0.9, 0.68, 0.72, 12),
    ellipsoid(12, p.shellDark, 0, 0.76, 0.92, 0.68, 0.6, 0.62, 11),
    part(11, new THREE.BoxGeometry(0.08, 0.72, 1.75), p.shellDark, 0, 0.83, -0.45),
    part(0, new THREE.TorusGeometry(0.55, 0.1, 7, 18), p.team, 0, 0.77, 0.32, Math.PI * 0.5),
    part(12, new THREE.ConeGeometry(0.18, 1.55, 8), bronzeLight, 0, 1.23, 1.34, Math.PI * 0.4),
    part(12, new THREE.ConeGeometry(0.13, 0.82, 7), p.shell, 0, 0.84, 1.57, Math.PI * 0.5),
    part(7, new THREE.ConeGeometry(0.1, 0.62, 6), p.shellDark, -0.3, 0.58, 1.45, Math.PI * 0.5, 0, 0.25),
    part(8, new THREE.ConeGeometry(0.1, 0.62, 6), p.shellDark, 0.3, 0.58, 1.45, Math.PI * 0.5, 0, -0.25),
  ];
  addSixLegs(parts, p, 0.55, 1.05, 0.11, 0.52);
  addEyes(parts, p, 0.82, 1.2, 0.25, 0.1);
  addAntennae(parts, p, 0.98, 1.16, 0.22, 0.48);
  return parts;
}

function monarchButterfly(p: Palette): THREE.BufferGeometry[] {
  const orange = 0xe46f24;
  const orangeLight = 0xffa339;
  const parts: THREE.BufferGeometry[] = [
    ellipsoid(0, p.shellDark, 0, 0.73, -0.02, 0.28, 0.66, 0.46, 10),
    ellipsoid(11, p.shell, 0, 0.69, -0.48, 0.3, 0.55, 0.68, 10),
    ellipsoid(12, p.shellDark, 0, 0.78, 0.42, 0.36, 0.4, 0.38, 10),
    part(0, new THREE.TorusGeometry(0.24, 0.05, 5, 14), p.team, 0, 0.78, 0.02, Math.PI * 0.5),
  ];
  addSixLegs(parts, p, 0.58, 0.5, 0.043, 0.26);
  addWing(parts, p, 9, -1, -0.12, 0.9, -0.08, 1.35, 0.9, 0.15, orange);
  addWing(parts, p, 10, 1, 0.12, 0.9, -0.08, 1.35, 0.9, 0.15, orangeLight);
  // Bold monarch cells and factional eyespots.
  for (const side of [-1, 1] as const) {
    const group = side < 0 ? 9 : 10;
    parts.push(
      ellipsoid(group, p.ink, side * 0.72, 0.93, 0.06, 0.5, 0.035, 0.12, 8),
      ellipsoid(group, p.teamLight, side * 0.88, 0.95, -0.02, 0.16, 0.045, 0.18, 8),
      ellipsoid(group, p.ink, side * 0.88, 0.96, -0.01, 0.075, 0.05, 0.085, 7),
      ellipsoid(group, p.gold, side * 0.48, 0.95, 0.42, 0.09, 0.045, 0.11, 7),
    );
  }
  addEyes(parts, p, 0.82, 0.67, 0.13, 0.09);
  addAntennae(parts, p, 0.98, 0.58, 0.12, 0.72);
  parts.push(part(7, new THREE.CylinderGeometry(0.018, 0.024, 0.62, 5), p.glow, 0, 0.63, 0.75, Math.PI * 0.5));
  return parts;
}

function archetypeFor(kind: string): DetailedUnitArchetype {
  if (kind.includes("archer")) return "archer";
  if (kind.includes("knight")) return "knight";
  if (kind.includes("giant")) return "giant";
  if (kind.includes("commander")) return "commander";
  return "guard";
}

function unitParts(archetype: DetailedUnitArchetype, p: Palette): THREE.BufferGeometry[] {
  if (archetype === "guard") return soldierAnt(p);
  if (archetype === "archer") return stingerBee(p);
  if (archetype === "knight") return huntingMantis(p);
  if (archetype === "giant") return rhinocerosBeetle(p);
  return monarchButterfly(p);
}

function rotateAroundX(position: THREE.Vector3, pivot: THREE.Vector3, angle: number): void {
  const y = position.y - pivot.y;
  const z = position.z - pivot.z;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  position.y = pivot.y + y * cosine - z * sine;
  position.z = pivot.z + y * sine + z * cosine;
}

function rotateAroundY(position: THREE.Vector3, pivot: THREE.Vector3, angle: number): void {
  const x = position.x - pivot.x;
  const z = position.z - pivot.z;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  position.x = pivot.x + x * cosine + z * sine;
  position.z = pivot.z - x * sine + z * cosine;
}

function rotateAroundZ(position: THREE.Vector3, pivot: THREE.Vector3, angle: number): void {
  const x = position.x - pivot.x;
  const y = position.y - pivot.y;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  position.x = pivot.x + x * cosine - y * sine;
  position.y = pivot.y + x * sine + y * cosine;
}

function legPivot(group: number, height: number): THREE.Vector3 {
  const side = group % 2 === 1 ? -1 : 1;
  const row = group <= 2 ? 0.2 : group <= 4 ? 0 : -0.2;
  return new THREE.Vector3(side * height * 0.12, height * 0.34, row * height);
}

function poseGeometry(
  geometry: THREE.BufferGeometry,
  pose: DetailedUnitPose,
  archetype: DetailedUnitArchetype,
): THREE.BufferGeometry {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const groups = geometry.getAttribute("poseGroup") as THREE.BufferAttribute;
  const height = DETAILED_UNIT_METRICS[archetype].height;
  const point = new THREE.Vector3();
  const walkDirection = pose === "walkA" ? 1 : pose === "walkB" ? -1 : 0;
  const attackStage = pose === "attackWindup"
    ? "windup"
    : pose === "attack"
      ? "contact"
      : pose === "attackRecover"
        ? "recover"
        : null;

  for (let index = 0; index < positions.count; index += 1) {
    point.set(positions.getX(index), positions.getY(index), positions.getZ(index));
    const group = Math.round(groups.getX(index));

    if (walkDirection !== 0 && group >= 1 && group <= 6) {
      // Biomechanical alternating tripod: LF+RM+LR versus RF+LM+RR.
      const tripodA = group === 1 || group === 4 || group === 5;
      const stride = (tripodA ? walkDirection : -walkDirection) * (archetype === "giant" ? 0.28 : 0.4);
      rotateAroundX(point, legPivot(group, height), stride);
      if ((tripodA && walkDirection > 0) || (!tripodA && walkDirection < 0)) point.y += height * 0.025;
    }

    if ((archetype === "archer" || archetype === "commander") && (group === 9 || group === 10)) {
      const side = group === 9 ? -1 : 1;
      const flap = pose === "walkA" ? 0.58 : pose === "walkB" ? -0.16 : attackStage ? 0.32 : 0;
      rotateAroundZ(point, new THREE.Vector3(side * height * 0.08, height * 0.62, -height * 0.06), side * flap);
    }

    if (attackStage) {
      const contact = attackStage === "contact";
      const windup = attackStage === "windup";
      if (archetype === "guard" && (group === 7 || group === 8)) {
        const side = group === 7 ? -1 : 1;
        const angle = windup ? side * -0.48 : contact ? side * 0.34 : side * 0.08;
        rotateAroundY(point, new THREE.Vector3(side * height * 0.1, height * 0.45, height * 0.45), angle);
      } else if (archetype === "archer" && group === 11) {
        point.z += windup ? -height * 0.12 : contact ? height * 0.24 : height * 0.05;
      } else if (archetype === "knight" && (group === 7 || group === 8)) {
        const side = group === 7 ? -1 : 1;
        const angle = windup ? 0.72 : contact ? -1.05 : -0.18;
        rotateAroundX(point, new THREE.Vector3(side * height * 0.2, height * 0.72, height * 0.12), angle);
        if (contact) point.z += height * 0.12;
      } else if (archetype === "giant" && (group === 7 || group === 8 || group === 12)) {
        point.z += windup ? -height * 0.08 : contact ? height * 0.2 : height * 0.04;
        if (group === 12) rotateAroundX(point, new THREE.Vector3(0, height * 0.42, height * 0.2), contact ? -0.2 : 0.08);
      } else if (archetype === "commander" && (group === 9 || group === 10)) {
        const side = group === 9 ? -1 : 1;
        rotateAroundZ(point, new THREE.Vector3(side * height * 0.08, height * 0.62, 0), side * (contact ? 0.8 : windup ? -0.25 : 0.18));
      }
    }

    if (pose === "hit") {
      rotateAroundX(point, new THREE.Vector3(0, height * 0.08, 0), 0.22);
      point.z -= height * 0.07;
    } else if (pose === "death") {
      if (group >= 1 && group <= 8) {
        const side = group % 2 === 1 ? -1 : 1;
        rotateAroundY(point, legPivot(Math.min(group, 6), height), side * 0.55);
      }
      rotateAroundZ(point, new THREE.Vector3(0, height * 0.06, 0), archetype === "commander" ? 1.36 : -1.42);
      point.y = Math.max(0.025, point.y);
    } else if (pose === "spawn") {
      const lift = THREE.MathUtils.clamp(point.y / Math.max(0.001, height), 0, 1);
      point.x *= THREE.MathUtils.lerp(0.35, 1, lift);
      point.z *= THREE.MathUtils.lerp(0.35, 1, lift);
      point.y *= 0.42;
    }

    positions.setXYZ(index, point.x, Math.max(0.018, point.y), point.z);
  }

  positions.needsUpdate = true;
  geometry.deleteAttribute("poseGroup");
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Bind-pose geometry retaining a rigid poseGroup attribute. This is the
 * zero-network fallback and the source for instanced pose frames.
 */
export function createDetailedUnitRigGeometry(
  kind = "guard",
  factionColor = 0x2d8fd5,
): THREE.BufferGeometry {
  const archetype = archetypeFor(kind);
  return normalize(merge(unitParts(archetype, palette(factionColor))), archetype);
}

export function createDetailedUnitGeometry(
  kind = "guard",
  factionColor = 0x2d8fd5,
  pose: DetailedUnitPose = "idle",
): THREE.BufferGeometry {
  return poseGeometry(createDetailedUnitRigGeometry(kind, factionColor), pose, archetypeFor(kind));
}
