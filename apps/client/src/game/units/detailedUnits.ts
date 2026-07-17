import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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
  guard: { height: 1.7, radius: 0.42, eyeHeight: 1.48 },
  archer: { height: 1.7, radius: 0.4, eyeHeight: 1.48 },
  knight: { height: 2.2, radius: 0.68, eyeHeight: 1.97 },
  giant: { height: 2.5, radius: 0.82, eyeHeight: 2.15 },
  commander: { height: 1.9, radius: 0.5, eyeHeight: 1.63 },
};

interface Palette {
  team: number;
  teamLight: number;
  teamDark: number;
  skin: number;
  skinLight: number;
  skinDark: number;
  metal: number;
  metalLight: number;
  metalDark: number;
  leather: number;
  leatherLight: number;
  leatherDark: number;
  boot: number;
  ink: number;
  hair: number;
  hairLight: number;
  gold: number;
  goldLight: number;
  goldDark: number;
}

function palette(factionColor: number): Palette {
  const team = new THREE.Color(factionColor);
  return {
    team: factionColor,
    teamLight: team.clone().offsetHSL(0, 0.06, 0.2).getHex(),
    teamDark: team.clone().offsetHSL(0, 0.02, -0.24).getHex(),
    skin: 0xe2ad76,
    skinLight: 0xf3c994,
    skinDark: 0xa96e49,
    metal: 0xbec4bd,
    metalLight: 0xede8d5,
    metalDark: 0x434b4b,
    leather: 0x704629,
    leatherLight: 0x9b6338,
    leatherDark: 0x3f2b20,
    boot: 0x2d2722,
    ink: 0x171c1a,
    hair: 0x38251c,
    hairLight: 0x65402b,
    gold: 0xe0b34b,
    goldLight: 0xffdc72,
    goldDark: 0x7c5421,
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
  if (!geometry) throw new Error("Could not merge detailed unit geometry.");
  return geometry;
}

function addFeet(parts: THREE.BufferGeometry[], p: Palette, spread: number, legHeight: number, legRadius: number): void {
  parts.push(
    part(1, new THREE.CylinderGeometry(legRadius * 0.86, legRadius, legHeight, 6), p.boot, -spread, legHeight * 0.54, 0),
    part(2, new THREE.CylinderGeometry(legRadius * 0.86, legRadius, legHeight, 6), p.boot, spread, legHeight * 0.54, 0),
    part(1, new THREE.BoxGeometry(legRadius * 2.05, 0.11, legRadius * 2.75), p.leatherDark, -spread, 0.065, legRadius * 0.45),
    part(2, new THREE.BoxGeometry(legRadius * 2.05, 0.11, legRadius * 2.75), p.leatherDark, spread, 0.065, legRadius * 0.45),
  );
}

function addEyes(parts: THREE.BufferGeometry[], p: Palette, y: number, z: number, spacing: number, size = 0.05): void {
  parts.push(
    part(5, new THREE.BoxGeometry(size, size * 0.78, 0.03), p.ink, -spacing, y, z),
    part(5, new THREE.BoxGeometry(size, size * 0.78, 0.03), p.ink, spacing, y, z),
  );
}

function normalize(geometry: THREE.BufferGeometry, archetype: DetailedUnitArchetype): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return geometry;
  const authoredHeight = Math.max(0.001, bounds.max.y - bounds.min.y);
  const scale = DETAILED_UNIT_METRICS[archetype].height / authoredHeight;
  geometry.translate(0, -bounds.min.y, 0);
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function rotateX(y: number, z: number, pivotY: number, pivotZ: number, angle: number): [number, number] {
  const oy = y - pivotY;
  const oz = z - pivotZ;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [pivotY + oy * cosine - oz * sine, pivotZ + oy * sine + oz * cosine];
}

function rotateY(x: number, z: number, pivotX: number, pivotZ: number, angle: number): [number, number] {
  const ox = x - pivotX;
  const oz = z - pivotZ;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [pivotX + ox * cosine + oz * sine, pivotZ - ox * sine + oz * cosine];
}

function poseGeometry(
  geometry: THREE.BufferGeometry,
  pose: DetailedUnitPose,
  archetype: DetailedUnitArchetype,
): THREE.BufferGeometry {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const groups = geometry.getAttribute("poseGroup") as THREE.BufferAttribute;
  if (pose === "idle") {
    geometry.deleteAttribute("poseGroup");
    geometry.computeBoundingSphere();
    return geometry;
  }

  const height = DETAILED_UNIT_METRICS[archetype].height;
  const mounted = archetype === "knight";
  const walkDirection = pose === "walkA" ? 1 : pose === "walkB" ? -1 : 0;
  const hipY = height * (mounted ? 0.25 : 0.31);
  const shoulderY = height * (mounted ? 0.67 : archetype === "giant" ? 0.61 : 0.58);

  for (let index = 0; index < positions.count; index += 1) {
    let x = positions.getX(index);
    let y = positions.getY(index);
    let z = positions.getZ(index);
    const group = Math.round(groups.getX(index));

    if (walkDirection !== 0) {
      if (group === 1 || group === 2 || group === 8 || group === 9) {
        const diagonal = group === 1 || group === 9 ? walkDirection : -walkDirection;
        const swing = diagonal * (mounted ? 0.42 : archetype === "giant" ? 0.29 : 0.39);
        [y, z] = rotateX(y, z, hipY, 0, swing);
      }
      if (group === 3 || group === 4) {
        const direction = group === 3 ? -walkDirection : walkDirection;
        const swing = mounted ? 0.09 : archetype === "giant" ? 0.18 : 0.27;
        [y, z] = rotateX(y, z, shoulderY, 0, direction * swing);
      }
      if (group === 7) [x, z] = rotateY(x, z, 0, -height * 0.28, walkDirection * 0.18);
      if (group === 10) [y, z] = rotateX(y, z, height * 0.54, height * 0.25, walkDirection * 0.045);
    }

    const attackStage = pose === "attackWindup"
      ? "windup"
      : pose === "attack"
        ? "strike"
        : pose === "attackRecover"
          ? "recover"
          : null;
    if (attackStage) {
      if (archetype === "archer") {
        if (group === 3) {
          const angle = attackStage === "windup" ? 0.88 : attackStage === "strike" ? 0.5 : 0.18;
          [y, z] = rotateX(y, z, shoulderY, 0, angle);
          x -= attackStage === "recover" ? 0.025 : 0.08;
          z -= attackStage === "windup" ? 0.16 : attackStage === "strike" ? 0.05 : 0;
        } else if (group === 4) {
          const angle = attackStage === "windup" ? -0.94 : attackStage === "strike" ? -0.62 : -0.2;
          [y, z] = rotateX(y, z, shoulderY, 0, angle);
          z += attackStage === "windup" ? 0.06 : attackStage === "strike" ? 0.18 : 0.04;
        } else if (group === 6) {
          z += attackStage === "windup" ? -0.08 : attackStage === "strike" ? 0.48 : 0.14;
        }
      } else if (archetype === "knight") {
        if (group === 3) {
          const angle = attackStage === "windup" ? 0.56 : attackStage === "strike" ? -0.42 : -0.08;
          [y, z] = rotateX(y, z, shoulderY, height * 0.12, angle);
          z += attackStage === "strike" ? 0.28 : attackStage === "recover" ? 0.08 : -0.08;
        } else if (group === 4) {
          const angle = attackStage === "windup" ? 0.24 : attackStage === "strike" ? -0.24 : -0.06;
          [y, z] = rotateX(y, z, shoulderY, 0, angle);
        } else if (group === 10) {
          const angle = attackStage === "windup" ? 0.05 : attackStage === "strike" ? -0.14 : -0.04;
          [y, z] = rotateX(y, z, height * 0.54, height * 0.25, angle);
        }
      } else if (archetype === "giant" && (group === 3 || group === 4)) {
        const side = group === 3 ? -1 : 1;
        const angle = attackStage === "windup"
          ? 0.48 - side * 0.06
          : attackStage === "strike"
            ? -1.18 + side * 0.08
            : -0.24 + side * 0.03;
        [y, z] = rotateX(y, z, shoulderY, 0, angle);
        x -= side * (attackStage === "strike" ? 0.08 : 0.025);
        z += attackStage === "strike" ? 0.24 : attackStage === "recover" ? 0.06 : -0.08;
      } else if (group === 3 || group === 4) {
        const weaponArm = group === 3;
        const angle = attackStage === "windup"
          ? (weaponArm ? 0.72 : 0.22)
          : attackStage === "strike"
            ? (weaponArm ? -1.08 : -0.24)
            : (weaponArm ? -0.22 : -0.07);
        [y, z] = rotateX(y, z, shoulderY, 0, angle);
        if (weaponArm) {
          z += attackStage === "strike" ? 0.17 : attackStage === "recover" ? 0.04 : -0.07;
        }
      }
    }

    if (pose === "spawn") {
      const lift = THREE.MathUtils.clamp(y / Math.max(0.001, height), 0, 1);
      x *= THREE.MathUtils.lerp(0.84, 1, lift);
      z *= THREE.MathUtils.lerp(0.84, 1, lift);
      if (group === 3 || group === 4) [y, z] = rotateX(y, z, shoulderY, 0, group === 3 ? 0.34 : -0.34);
    }

    if (pose === "hit") {
      [y, z] = rotateX(y, z, height * 0.08, 0, 0.19);
      z -= height * (group === 5 ? 0.09 : 0.055);
    } else if (pose === "death") {
      const angle = archetype === "giant" ? -1.08 : archetype === "knight" ? 1.22 : -1.28;
      const pivotX = archetype === "giant" ? -0.09 : 0.04;
      const ox = x - pivotX;
      const oy = y - height * 0.035;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      x = pivotX + ox * cosine - oy * sine;
      y = Math.max(0.025, height * 0.035 + ox * sine + oy * cosine);
      z *= 1.04;
    }

    positions.setXYZ(index, x, Math.max(0.018, y), z);
  }

  positions.needsUpdate = true;
  geometry.deleteAttribute("poseGroup");
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function guard(p: Palette): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  addFeet(parts, p, 0.13, 0.42, 0.1);
  parts.push(
    part(0, new THREE.CylinderGeometry(0.27, 0.34, 0.62, 8), p.team, 0, 0.72, 0),
    part(0, new THREE.BoxGeometry(0.42, 0.48, 0.055), p.teamLight, 0, 0.72, 0.285),
    part(0, new THREE.CylinderGeometry(0.34, 0.34, 0.09, 8), p.leatherDark, 0, 0.54, 0),
    part(0, new THREE.BoxGeometry(0.16, 0.1, 0.075), p.goldDark, 0, 0.55, 0.32),
    part(5, new THREE.SphereGeometry(0.245, 9, 6), p.skin, 0, 1.18, 0.035),
    part(5, new THREE.BoxGeometry(0.11, 0.045, 0.05), p.hair, -0.052, 1.1, 0.255, 0, 0, -0.16),
    part(5, new THREE.BoxGeometry(0.11, 0.045, 0.05), p.hair, 0.052, 1.1, 0.255, 0, 0, 0.16),
    part(5, new THREE.SphereGeometry(0.27, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.58), p.metal, 0, 1.31, 0.02),
    part(5, new THREE.CylinderGeometry(0.29, 0.29, 0.075, 10), p.metalDark, 0, 1.35, 0),
    part(5, new THREE.BoxGeometry(0.065, 0.25, 0.07), p.metalLight, 0, 1.27, 0.26),
    part(5, new THREE.DodecahedronGeometry(0.13, 0), p.teamDark, 0, 1.57, -0.08, -0.28, 0, 0, 0.86, 1.55, 1.08),
    part(5, new THREE.DodecahedronGeometry(0.11, 0), p.teamDark, 0, 1.48, -0.26, -0.58, 0, 0, 0.82, 1.42, 1.2),
    part(3, new THREE.CylinderGeometry(0.065, 0.085, 0.43, 6), p.skinDark, -0.31, 0.82, 0.035, 0, 0, -0.22),
    part(4, new THREE.CylinderGeometry(0.065, 0.085, 0.43, 6), p.skinDark, 0.31, 0.82, 0.035, 0, 0, 0.22),
    part(4, new THREE.DodecahedronGeometry(0.105, 0), p.skinDark, 0.39, 0.62, 0.08),
    part(3, new THREE.BoxGeometry(0.07, 0.7, 0.045), p.metalLight, -0.45, 1, 0.12, 0, 0, -0.14),
    part(3, new THREE.BoxGeometry(0.15, 0.07, 0.09), p.goldDark, -0.39, 0.69, 0.12, 0, 0, -0.14),
    part(3, new THREE.CylinderGeometry(0.045, 0.05, 0.19, 6), p.leather, -0.35, 0.59, 0.12, 0, 0, -0.14),
  );
  addEyes(parts, p, 1.21, 0.255, 0.078, 0.055);
  return parts;
}

function archer(p: Palette): THREE.BufferGeometry[] {
  const green = 0x3f793e;
  const greenDark = 0x244e2b;
  const parts: THREE.BufferGeometry[] = [];
  addFeet(parts, p, 0.12, 0.43, 0.088);
  parts.push(
    part(0, new THREE.CylinderGeometry(0.235, 0.3, 0.61, 8), green, 0, 0.7, 0),
    part(0, new THREE.BoxGeometry(0.33, 0.37, 0.055), 0x6c9a4b, 0, 0.69, 0.265),
    part(0, new THREE.CylinderGeometry(0.3, 0.3, 0.075, 8), p.leatherDark, 0, 0.52, 0),
    part(0, new THREE.BoxGeometry(0.19, 0.08, 0.06), p.team, 0, 0.52, 0.29),
    part(0, new THREE.CylinderGeometry(0.12, 0.15, 0.52, 7), p.leather, -0.24, 0.82, -0.19, -0.2, 0, -0.2),
    part(0, new THREE.BoxGeometry(0.035, 0.68, 0.035), 0xc6aa68, -0.24, 1.02, -0.2, 0.14),
    part(0, new THREE.BoxGeometry(0.035, 0.65, 0.035), 0xc6aa68, -0.18, 1.01, -0.21, 0.1),
    part(5, new THREE.SphereGeometry(0.27, 8, 5), greenDark, 0, 1.27, -0.025, 0, 0, 0, 1.04, 1.08, 1.02),
    part(5, new THREE.ConeGeometry(0.29, 0.42, 8), green, 0, 1.43, -0.08, -0.08),
    part(5, new THREE.SphereGeometry(0.19, 8, 5), p.skinLight, 0, 1.17, 0.14, 0, 0, 0, 0.9, 0.92, 0.68),
    part(5, new THREE.ConeGeometry(0.052, 0.19, 5), p.skinLight, -0.205, 1.2, 0.14, 0, 0, Math.PI * 0.5, 0.72, 1, 0.58),
    part(5, new THREE.ConeGeometry(0.052, 0.19, 5), p.skinLight, 0.205, 1.2, 0.14, 0, 0, -Math.PI * 0.5, 0.72, 1, 0.58),
    part(5, new THREE.ConeGeometry(0.045, 0.1, 5), p.skinDark, 0, 1.13, 0.32, Math.PI * 0.5),
    part(3, new THREE.CylinderGeometry(0.052, 0.07, 0.4, 6), p.skin, -0.27, 0.85, 0.065, 0, 0, 0.45),
    part(4, new THREE.CylinderGeometry(0.052, 0.07, 0.4, 6), p.skin, 0.27, 0.85, 0.065, 0, 0, -0.45),
    part(4, new THREE.TorusGeometry(0.4, 0.035, 5, 18, Math.PI * 1.62), p.leatherDark, 0.4, 0.91, 0.16, 0, 0, -0.78),
    part(4, new THREE.BoxGeometry(0.028, 0.72, 0.025), 0xd6caa4, 0.37, 0.91, 0.16, 0, 0, -0.1),
    part(6, new THREE.BoxGeometry(0.035, 0.035, 0.9), 0xd8ba72, -0.17, 0.98, 0.36),
    part(6, new THREE.ConeGeometry(0.065, 0.16, 5), p.metalDark, -0.17, 0.98, 0.85, Math.PI * 0.5),
    part(6, new THREE.BoxGeometry(0.14, 0.025, 0.025), p.team, -0.17, 0.98, -0.03),
  );
  addEyes(parts, p, 1.2, 0.29, 0.07, 0.045);
  return parts;
}

function knight(p: Palette): THREE.BufferGeometry[] {
  const horse = 0x7b4c2d;
  const horseLight = 0x966440;
  return [
    part(0, new THREE.DodecahedronGeometry(0.64, 0), horse, 0, 0.68, 0, 0, 0, 0, 0.98, 0.72, 1.48),
    part(0, new THREE.BoxGeometry(0.92, 0.24, 1.12), p.team, 0, 0.91, -0.02),
    part(0, new THREE.BoxGeometry(0.7, 0.12, 0.72), p.leatherDark, 0, 1.02, -0.05),
    part(10, new THREE.CylinderGeometry(0.25, 0.34, 0.78, 7), 0x704329, 0, 1.06, 0.65, -0.55),
    part(10, new THREE.DodecahedronGeometry(0.34, 0), horse, 0, 1.3, 1.03, 0, 0, 0, 0.88, 0.78, 1.18),
    part(10, new THREE.BoxGeometry(0.4, 0.25, 0.46), horseLight, 0, 1.22, 1.3),
    part(10, new THREE.ConeGeometry(0.065, 0.22, 5), p.leatherDark, -0.17, 1.58, 1.03, -0.14),
    part(10, new THREE.ConeGeometry(0.065, 0.22, 5), p.leatherDark, 0.17, 1.58, 1.03, -0.14),
    part(10, new THREE.BoxGeometry(0.055, 0.045, 0.03), p.ink, -0.13, 1.37, 1.33),
    part(10, new THREE.BoxGeometry(0.055, 0.045, 0.03), p.ink, 0.13, 1.37, 1.33),
    part(10, new THREE.TorusGeometry(0.24, 0.025, 4, 12, Math.PI), p.teamDark, 0, 1.31, 1.28, 0, 0, Math.PI * 0.5),
    part(1, new THREE.BoxGeometry(0.19, 0.65, 0.2), 0x5b3525, -0.31, 0.34, 0.55),
    part(2, new THREE.BoxGeometry(0.19, 0.65, 0.2), 0x5b3525, 0.31, 0.34, 0.55),
    part(8, new THREE.BoxGeometry(0.19, 0.65, 0.2), 0x5b3525, -0.31, 0.34, -0.55),
    part(9, new THREE.BoxGeometry(0.19, 0.65, 0.2), 0x5b3525, 0.31, 0.34, -0.55),
    part(1, new THREE.BoxGeometry(0.24, 0.12, 0.32), p.boot, -0.31, 0.065, 0.62),
    part(2, new THREE.BoxGeometry(0.24, 0.12, 0.32), p.boot, 0.31, 0.065, 0.62),
    part(8, new THREE.BoxGeometry(0.24, 0.12, 0.32), p.boot, -0.31, 0.065, -0.62),
    part(9, new THREE.BoxGeometry(0.24, 0.12, 0.32), p.boot, 0.31, 0.065, -0.62),
    part(7, new THREE.CylinderGeometry(0.055, 0.11, 0.68, 6), p.hair, 0, 0.72, -0.92, -1.05),
    part(0, new THREE.CylinderGeometry(0.25, 0.31, 0.55, 7), p.metal, 0, 1.4, 0.02),
    part(0, new THREE.BoxGeometry(0.47, 0.42, 0.055), p.teamLight, 0, 1.39, 0.3),
    part(5, new THREE.SphereGeometry(0.22, 8, 5), p.skin, 0, 1.76, 0.05),
    part(5, new THREE.DodecahedronGeometry(0.18, 0), p.hair, 0, 1.66, 0.18, 0, 0, 0, 0.92, 0.9, 0.62),
    part(5, new THREE.SphereGeometry(0.245, 8, 5), p.metal, 0, 1.81, 0.02),
    part(5, new THREE.ConeGeometry(0.25, 0.35, 8), p.metalLight, 0, 2.01, 0.02),
    part(5, new THREE.BoxGeometry(0.29, 0.055, 0.035), p.ink, 0, 1.79, 0.24),
    part(5, new THREE.ConeGeometry(0.075, 0.3, 6), p.team, 0, 2.22, -0.03, 0.2),
    part(10, new THREE.DodecahedronGeometry(0.13, 0), p.hair, 0, 1.44, 0.72, -0.34, 0, 0, 0.72, 1.16, 0.58),
    part(10, new THREE.DodecahedronGeometry(0.12, 0), p.hair, 0, 1.52, 0.9, -0.3, 0, 0, 0.7, 1.08, 0.56),
    part(3, new THREE.CylinderGeometry(0.055, 0.075, 0.44, 6), p.metal, -0.3, 1.48, 0.07, 0, 0, -0.3),
    part(4, new THREE.CylinderGeometry(0.055, 0.075, 0.44, 6), p.metal, 0.3, 1.48, 0.07, 0, 0, 0.3),
    part(3, new THREE.CylinderGeometry(0.04, 0.05, 1.18, 7), p.leatherDark, -0.34, 1.49, 0.2, 0, 0, -0.62),
    part(3, new THREE.CylinderGeometry(0.075, 0.075, 0.52, 7), p.metalDark, -0.69, 1.96, 0.2, 0, 0, 0.95),
    part(3, new THREE.ConeGeometry(0.21, 0.38, 5), p.metalLight, -0.88, 2.08, 0.2, 0, 0, -0.62),
    part(3, new THREE.ConeGeometry(0.21, 0.38, 5), p.metalLight, -0.5, 1.84, 0.2, Math.PI, 0, -0.62),
  ];
}

function giant(p: Palette): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(
    part(1, new THREE.CylinderGeometry(0.2, 0.25, 0.56, 7), p.skin, -0.28, 0.36, 0),
    part(2, new THREE.CylinderGeometry(0.2, 0.25, 0.56, 7), p.skin, 0.28, 0.36, 0),
    part(1, new THREE.DodecahedronGeometry(0.23, 0), p.skin, -0.28, 0.1, 0.11, 0, 0, 0, 1.08, 0.48, 1.5),
    part(2, new THREE.DodecahedronGeometry(0.23, 0), p.skin, 0.28, 0.1, 0.11, 0, 0, 0, 1.08, 0.48, 1.5),
    part(1, new THREE.DodecahedronGeometry(0.085, 0), p.skinLight, -0.41, 0.07, 0.32, 0, 0, 0, 1.05, 0.72, 1.18),
    part(1, new THREE.DodecahedronGeometry(0.09, 0), p.skinLight, -0.28, 0.065, 0.36, 0, 0, 0, 1.08, 0.72, 1.22),
    part(1, new THREE.DodecahedronGeometry(0.075, 0), p.skinLight, -0.16, 0.07, 0.31, 0, 0, 0, 1, 0.7, 1.15),
    part(2, new THREE.DodecahedronGeometry(0.075, 0), p.skinLight, 0.16, 0.07, 0.31, 0, 0, 0, 1, 0.7, 1.15),
    part(2, new THREE.DodecahedronGeometry(0.09, 0), p.skinLight, 0.28, 0.065, 0.36, 0, 0, 0, 1.08, 0.72, 1.22),
    part(2, new THREE.DodecahedronGeometry(0.085, 0), p.skinLight, 0.41, 0.07, 0.32, 0, 0, 0, 1.05, 0.72, 1.18),
    part(1, new THREE.TorusGeometry(0.22, 0.045, 5, 10), p.leatherDark, -0.28, 0.24, 0, Math.PI * 0.5),
    part(2, new THREE.TorusGeometry(0.22, 0.045, 5, 10), p.leatherDark, 0.28, 0.24, 0, Math.PI * 0.5),
    part(0, new THREE.CylinderGeometry(0.52, 0.67, 0.58, 8), p.leatherDark, 0, 0.68, 0),
    part(0, new THREE.DodecahedronGeometry(0.7, 0), p.skin, 0, 1.28, 0, 0, 0, 0, 1.1, 1.18, 0.82),
    part(0, new THREE.BoxGeometry(1.28, 0.2, 0.18), p.leatherDark, 0, 0.93, 0.5),
    part(0, new THREE.BoxGeometry(0.22, 0.2, 0.08), p.gold, 0, 0.93, 0.61),
    part(0, new THREE.BoxGeometry(0.46, 0.5, 0.075), p.team, 0, 0.67, 0.59),
    part(0, new THREE.BoxGeometry(0.5, 0.075, 0.085), p.teamDark, 0, 0.44, 0.595),
    part(0, new THREE.DodecahedronGeometry(0.1, 0), p.teamLight, 0, 0.7, 0.66, 0, 0, Math.PI * 0.25, 0.8, 1.12, 0.45),
    part(3, new THREE.CylinderGeometry(0.255, 0.255, 0.22, 8), p.leatherDark, -0.77, 0.96, 0.12, 0, 0, -0.2),
    part(3, new THREE.CylinderGeometry(0.2, 0.27, 0.9, 7), p.skin, -0.69, 1.16, 0.04, 0, 0, -0.2),
    part(4, new THREE.CylinderGeometry(0.2, 0.27, 0.9, 7), p.skin, 0.69, 1.16, 0.04, 0, 0, 0.2),
    part(4, new THREE.CylinderGeometry(0.255, 0.255, 0.22, 8), p.leatherDark, 0.77, 0.96, 0.12, 0, 0, 0.2),
    part(3, new THREE.DodecahedronGeometry(0.32, 0), p.skin, -0.83, 0.72, 0.18, 0, 0, 0, 1.18, 1, 1),
    part(4, new THREE.DodecahedronGeometry(0.32, 0), p.skin, 0.83, 0.72, 0.18, 0, 0, 0, 1.18, 1, 1),
    part(5, new THREE.SphereGeometry(0.4, 9, 6), p.skin, 0, 1.9, 0.02),
    part(5, new THREE.SphereGeometry(0.42, 8, 5), p.hair, 0, 2.03, -0.09, 0, 0, 0, 1.03, 0.85, 1),
    part(5, new THREE.DodecahedronGeometry(0.31, 0), p.hairLight, 0, 1.68, 0.25, 0, 0, 0, 1.05, 1, 0.72),
    part(5, new THREE.SphereGeometry(0.12, 7, 5), p.skinDark, 0, 1.91, 0.4),
    part(5, new THREE.BoxGeometry(0.19, 0.055, 0.055), p.hair, -0.09, 1.84, 0.38, 0, 0, -0.16),
    part(5, new THREE.BoxGeometry(0.19, 0.055, 0.055), p.hair, 0.09, 1.84, 0.38, 0, 0, 0.16),
    part(5, new THREE.SphereGeometry(0.075, 6, 4), p.skinDark, -0.4, 1.9, 0.02),
    part(5, new THREE.SphereGeometry(0.075, 6, 4), p.skinDark, 0.4, 1.9, 0.02),
  );
  addEyes(parts, p, 2.01, 0.37, 0.13, 0.07);
  return parts;
}

function commander(p: Palette): THREE.BufferGeometry[] {
  const red = 0x9e3d32;
  const redDark = 0x57251f;
  const parts: THREE.BufferGeometry[] = [];
  addFeet(parts, p, 0.14, 0.46, 0.1);
  parts.push(
    part(0, new THREE.CylinderGeometry(0.29, 0.36, 0.69, 8), red, 0, 0.79, 0),
    part(0, new THREE.BoxGeometry(0.29, 0.23, 0.045), p.metalDark, 0, 0.49, 0.275),
    part(0, new THREE.BoxGeometry(0.49, 0.5, 0.065), redDark, 0, 0.79, -0.29),
    part(0, new THREE.BoxGeometry(0.15, 0.48, 0.055), p.team, 0, 0.82, 0.305),
    part(0, new THREE.DodecahedronGeometry(0.085, 0), p.teamLight, 0, 0.88, 0.35, 0, 0, Math.PI * 0.25, 0.78, 1.1, 0.42),
    part(0, new THREE.DodecahedronGeometry(0.12, 0), p.teamDark, -0.34, 1.01, 0.12, 0, 0, 0, 1.2, 0.72, 0.9),
    part(0, new THREE.DodecahedronGeometry(0.12, 0), p.teamDark, 0.34, 1.01, 0.12, 0, 0, 0, 1.2, 0.72, 0.9),
    part(7, new THREE.ConeGeometry(0.48, 0.86, 8, 1, true, 0, Math.PI), red, 0, 0.85, -0.22, Math.PI * 0.5),
    part(0, new THREE.CylinderGeometry(0.36, 0.36, 0.085, 8), p.leatherDark, 0, 0.58, 0),
    part(0, new THREE.BoxGeometry(0.17, 0.12, 0.08), p.gold, 0, 0.58, 0.35),
    part(0, new THREE.SphereGeometry(0.11, 7, 5), p.gold, -0.32, 1.02, 0),
    part(0, new THREE.SphereGeometry(0.11, 7, 5), p.gold, 0.32, 1.02, 0),
    part(0, new THREE.DodecahedronGeometry(0.14, 0), 0xe8dcc3, -0.27, 1.12, -0.04, 0, 0, 0, 1.16, 0.72, 0.9),
    part(0, new THREE.DodecahedronGeometry(0.14, 0), 0xf1e7d4, 0, 1.15, -0.08, 0, 0, 0, 1.22, 0.75, 0.92),
    part(0, new THREE.DodecahedronGeometry(0.14, 0), 0xe8dcc3, 0.27, 1.12, -0.04, 0, 0, 0, 1.16, 0.72, 0.9),
    part(5, new THREE.SphereGeometry(0.26, 9, 6), p.skin, 0, 1.31, 0.035),
    part(5, new THREE.SphereGeometry(0.27, 8, 5), p.hair, 0, 1.39, -0.055, 0, 0, 0, 1.02, 0.92, 1),
    part(5, new THREE.DodecahedronGeometry(0.235, 0), p.hairLight, 0, 1.16, 0.2, 0, 0, 0, 1, 1.05, 0.72),
    part(5, new THREE.ConeGeometry(0.048, 0.1, 5), p.skinDark, 0, 1.29, 0.31, Math.PI * 0.5),
    part(5, new THREE.CylinderGeometry(0.245, 0.29, 0.18, 8), p.goldDark, 0, 1.55, -0.01),
    part(5, new THREE.CylinderGeometry(0.28, 0.28, 0.075, 10), p.gold, 0, 1.62, -0.01),
    part(5, new THREE.ConeGeometry(0.065, 0.25, 5), p.goldLight, -0.19, 1.78, -0.01),
    part(5, new THREE.ConeGeometry(0.07, 0.31, 5), p.goldLight, 0, 1.82, -0.01),
    part(5, new THREE.ConeGeometry(0.065, 0.25, 5), p.goldLight, 0.19, 1.78, -0.01),
    part(5, new THREE.SphereGeometry(0.045, 6, 4), 0xb22f2f, 0, 1.63, 0.27),
    part(3, new THREE.CylinderGeometry(0.065, 0.085, 0.46, 6), p.skin, -0.32, 0.9, 0.04, 0, 0, -0.26),
    part(4, new THREE.CylinderGeometry(0.065, 0.085, 0.46, 6), p.skin, 0.32, 0.9, 0.04, 0, 0, 0.26),
    part(3, new THREE.BoxGeometry(0.075, 0.91, 0.045), p.metalLight, -0.47, 1.1, 0.14, 0, 0, -0.18),
    part(3, new THREE.BoxGeometry(0.17, 0.075, 0.1), p.gold, -0.39, 0.73, 0.14, 0, 0, -0.18),
    part(3, new THREE.CylinderGeometry(0.05, 0.055, 0.2, 6), p.leatherDark, -0.35, 0.62, 0.14, 0, 0, -0.18),
    part(4, new THREE.DodecahedronGeometry(0.12, 0), p.skinDark, 0.43, 0.72, 0.12),
  );
  addEyes(parts, p, 1.36, 0.275, 0.085);
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
  return archetype === "guard"
    ? guard(p)
    : archetype === "archer"
      ? archer(p)
      : archetype === "knight"
        ? knight(p)
        : archetype === "giant"
          ? giant(p)
          : commander(p);
}

/**
 * Bind-pose geometry with a rigid poseGroup attribute retained for a future
 * single-draw TSL vertex rig.
 */
export function createDetailedUnitRigGeometry(
  kind = "guard",
  factionColor = 0x397fb8,
): THREE.BufferGeometry {
  const archetype = archetypeFor(kind);
  return normalize(merge(unitParts(archetype, palette(factionColor))), archetype);
}

export function createDetailedUnitGeometry(
  kind = "guard",
  factionColor = 0x397fb8,
  pose: DetailedUnitPose = "idle",
): THREE.BufferGeometry {
  return poseGeometry(createDetailedUnitRigGeometry(kind, factionColor), pose, archetypeFor(kind));
}
