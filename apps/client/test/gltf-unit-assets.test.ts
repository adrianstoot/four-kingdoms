import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import {
  frameIndexForPhase,
  loadExternalUnitLibrary,
  unitMotion,
} from "../src/game/units/gltfUnitAssets";

function syntheticGltf(): GLTF {
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(0.5, 2, 0.8);
  const positions = geometry.getAttribute("position");
  const skinIndices = new Uint16Array(positions.count * 4);
  const skinWeights = new Float32Array(positions.count * 4);
  for (let index = 0; index < positions.count; index += 1) {
    skinIndices[index * 4] = positions.getY(index) > 0 ? 1 : 0;
    skinWeights[index * 4] = 1;
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  const character = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x5276a5, name: "team cloth" }),
  );
  character.name = "Character";
  character.position.y = 1;
  const hips = new THREE.Bone();
  hips.name = "Hips";
  const chest = new THREE.Bone();
  chest.name = "Chest";
  hips.add(chest);
  character.add(hips);
  character.bind(new THREE.Skeleton([hips, chest]));
  scene.add(character);
  scene.updateMatrixWorld(true);
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.35));
  const walk = new THREE.AnimationClip("Walk", 1, [
    new THREE.QuaternionKeyframeTrack("Chest.quaternion", [0, 0.5, 1], [
      ...q0.toArray(), ...q1.toArray(), ...q0.toArray(),
    ]),
  ]);
  return {
    scene,
    scenes: [scene],
    animations: [walk],
    cameras: [],
    asset: { version: "2.0" },
    parser: {} as GLTF["parser"],
    userData: {},
  };
}

function mountedSyntheticGltf(part: "horse" | "rider"): GLTF {
  const scene = new THREE.Group();
  const animations: THREE.AnimationClip[] = [];
  const motions = ["idle", "walk", "attack", "hit", "death", "spawn"] as const;
  if (part === "horse") {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.1, 0.72),
      new THREE.MeshStandardMaterial({ color: 0x6f4931, name: "horse body" }),
    );
    body.geometry.clearGroups();
    body.name = "HorseBody";
    body.position.y = 0.55;
    scene.add(body);
    const saddle = new THREE.Bone();
    saddle.name = "Saddle";
    saddle.position.y = 1.1;
    scene.add(saddle);
    for (const motion of motions) {
      animations.push(new THREE.AnimationClip(`Horse ${motion}`, 2, [
        new THREE.VectorKeyframeTrack("Saddle.position", [0, 1, 2], [
          0, 1.1, 0,
          0.34, 1.2, 0,
          0, 1.1, 0,
        ]),
      ]));
    }
  } else {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 1, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x315f99, name: "team rider cloth" }),
    );
    body.geometry.clearGroups();
    body.name = "RiderBody";
    body.position.y = 0.5;
    scene.add(body);
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.16, 0, -0.22));
    for (const motion of motions) {
      animations.push(new THREE.AnimationClip(`Rider ${motion}`, 1, [
        new THREE.QuaternionKeyframeTrack("RiderBody.quaternion", [0, 0.5, 1], [
          ...q0.toArray(), ...q1.toArray(), ...q0.toArray(),
        ]),
      ]));
    }
  }
  scene.updateMatrixWorld(true);
  return {
    scene,
    scenes: [scene],
    animations,
    cameras: [],
    asset: { version: "2.0" },
    parser: {} as GLTF["parser"],
    userData: {},
  };
}

function groupYBounds(geometry: THREE.BufferGeometry, groupIndex: number): { min: number; max: number } {
  const positions = geometry.getAttribute("position");
  const group = geometry.groups[groupIndex];
  if (!group) throw new Error(`Missing geometry group ${groupIndex}.`);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = group.start; index < group.start + group.count; index += 1) {
    min = Math.min(min, positions.getY(index));
    max = Math.max(max, positions.getY(index));
  }
  return { min, max };
}

const TARGET_HEIGHTS = {
  guard: 1.7,
  archer: 1.7,
  knight: 2.2,
  giant: 2.5,
  commander: 1.9,
} as const;

describe("rigged GLB unit pipeline", () => {
  it("loads multiple animation samples and normalizes all five archetypes within 2 cm", async () => {
    const archetypes = Object.keys(TARGET_HEIGHTS) as Array<keyof typeof TARGET_HEIGHTS>;
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: Object.fromEntries(archetypes.map((archetype) => [archetype, {
        url: `https://example.test/${archetype}.glb`,
        clips: { walk: "Walk" },
        sampleFrames: { walk: 3 },
      }])),
    }));
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async () => syntheticGltf(),
    });
    const guard = library.assets.get("guard");
    expect(guard).toBeDefined();
    expect(guard?.rawClips[0]?.name).toBe("Walk");
    const firstPositions = guard?.frames.get("walk")?.[0]?.geometry.getAttribute("position");
    const middlePositions = guard?.frames.get("walk")?.[1]?.geometry.getAttribute("position");
    let largestDelta = 0;
    if (firstPositions && middlePositions) {
      for (let index = 0; index < firstPositions.count; index += 1) {
        largestDelta = Math.max(largestDelta, Math.abs(firstPositions.getX(index) - middlePositions.getX(index)));
      }
    }
    expect(largestDelta).toBeGreaterThan(0.01);
    expect(guard?.frames.get("walk")).toHaveLength(3);
    for (const archetype of archetypes) {
      const asset = library.assets.get(archetype);
      expect(asset, `${archetype} asset`).toBeDefined();
      const geometry = asset?.frames.get("walk")?.[1]?.geometry;
      geometry?.computeBoundingBox();
      const height = (geometry?.boundingBox?.max.y ?? 0) - (geometry?.boundingBox?.min.y ?? 0);
      expect(Math.abs(height - TARGET_HEIGHTS[archetype]), `${archetype} height`).toBeLessThanOrEqual(0.02);
    }
    library.dispose();
  });

  it("assembles and synchronously bakes an independently rigged horse and rider at 2.20 m", async () => {
    const motions = ["idle", "walk", "attack", "hit", "death", "spawn"] as const;
    const horseClips = Object.fromEntries(motions.map((motion) => [motion, `Horse ${motion}`]));
    const riderClips = Object.fromEntries(motions.map((motion) => [motion, `Rider ${motion}`]));
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: {
        knight: {
          type: "mounted",
          horse: {
            url: "https://example.test/horse.glb",
            clips: horseClips,
            forwardAxis: "+z",
          },
          rider: {
            url: "https://example.test/rider.glb",
            clips: riderClips,
            forwardAxis: "+z",
          },
          riderSocket: {
            bone: ["Saddle", "saddle_socket"],
            position: [0, 0.2, 0],
            rotationDegrees: [0, 0, 0],
            scale: 1,
          },
          sampleFrames: 3,
          tintMaterials: ["team rider"],
        },
      },
    }));
    const requestedUrls: string[] = [];
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async (url) => {
        requestedUrls.push(url);
        return mountedSyntheticGltf(url.includes("horse.glb") ? "horse" : "rider");
      },
    });

    expect(library.errors.size).toBe(0);
    expect(requestedUrls.some((url) => url.endsWith("/horse.glb"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/rider.glb"))).toBe(true);
    const knight = library.assets.get("knight");
    expect(knight).toBeDefined();
    expect(knight?.componentClips?.get("horse")?.size).toBe(6);
    expect(knight?.componentClips?.get("rider")?.size).toBe(6);
    expect(knight?.rawClips).toHaveLength(12);
    for (const motion of motions) {
      const frames = knight?.frames.get(motion);
      expect(frames, motion).toHaveLength(3);
      expect(frames?.map((frame) => frame.phase)).toEqual([0, 0.5, 1]);
    }

    const first = knight?.frames.get("walk")?.[0]?.geometry;
    const middle = knight?.frames.get("walk")?.[1]?.geometry;
    expect(first?.groups).toHaveLength(2);
    first?.computeBoundingBox();
    const height = (first?.boundingBox?.max.y ?? 0) - (first?.boundingBox?.min.y ?? 0);
    expect(Math.abs(height - 2.2)).toBeLessThanOrEqual(0.02);
    if (!first || !middle) throw new Error("Mounted frames were not baked.");
    const horseBounds = groupYBounds(first, 0);
    const riderBounds = groupYBounds(first, 1);
    expect(riderBounds.min).toBeGreaterThan(horseBounds.max);
    const firstPositions = first.getAttribute("position");
    const middlePositions = middle.getAttribute("position");
    let largestDelta = 0;
    for (let index = 0; index < firstPositions.count; index += 1) {
      largestDelta = Math.max(
        largestDelta,
        Math.abs(firstPositions.getX(index) - middlePositions.getX(index)),
        Math.abs(firstPositions.getY(index) - middlePositions.getY(index)),
      );
    }
    expect(largestDelta).toBeGreaterThan(0.02);
    library.dispose();
  });

  it("keeps the procedural knight fallback when either mounted component fails", async () => {
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: {
        knight: {
          type: "mounted",
          horse: { url: "https://example.test/horse.glb" },
          rider: { url: "https://example.test/missing-rider.glb" },
          riderSocket: { bone: "Saddle" },
        },
      },
    }));
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async (url) => {
        if (url.includes("missing-rider")) throw new Error("rider download failed");
        return mountedSyntheticGltf("horse");
      },
    });
    expect(library.assets.has("knight")).toBe(false);
    expect(library.errors.get("knight")?.message).toContain("rider download failed");
    library.dispose();
  });

  it("selects deterministic instanced frames from quantized motion phase", () => {
    expect(frameIndexForPhase(6, 0)).toBe(0);
    expect(frameIndexForPhase(6, 32_768)).toBe(3);
    expect(frameIndexForPhase(6, 65_535)).toBe(5);
    expect(unitMotion("attack")).toBe("attack");
    expect(unitMotion("unknown-state")).toBe("idle");
  });
});
