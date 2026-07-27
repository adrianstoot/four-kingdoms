import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import {
  createExternalToonMaterial,
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

function fullyAnimatedSyntheticGltf(): GLTF {
  const gltf = syntheticGltf();
  const source = gltf.animations[0];
  if (!source) throw new Error("Synthetic walk clip is missing.");
  const motions = ["Idle", "Walk", "Attack", "Hit", "Death", "Spawn"];
  gltf.animations = motions.map((name) => {
    const clip = source.clone();
    clip.name = name;
    return clip;
  });
  const helper = new THREE.Mesh(
    new THREE.IcosahedronGeometry(8, 2),
    new THREE.MeshStandardMaterial({ color: 0xff00ff }),
  );
  helper.name = "Icosphere";
  gltf.scene.add(helper);
  gltf.scene.updateMatrixWorld(true);
  return gltf;
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

function denseSyntheticGltf(
  triangleCount: number,
  animations: readonly THREE.AnimationClip[] = [],
): GLTF {
  const scene = new THREE.Group();
  const positions = new Float32Array(triangleCount * 9);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 9;
    positions[offset] = triangle % 100 * 0.001;
    positions[offset + 1] = 0;
    positions[offset + 2] = 0;
    positions[offset + 3] = positions[offset] + 0.01;
    positions[offset + 4] = 0;
    positions[offset + 5] = 0;
    positions[offset + 6] = positions[offset];
    positions[offset + 7] = 0.02;
    positions[offset + 8] = 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const character = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x5276a5, name: "team cloth" }),
  );
  character.name = "Character";
  scene.add(character);
  scene.updateMatrixWorld(true);
  return {
    scene,
    scenes: [scene],
    animations: [...animations],
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
  guard: 1.15,
  archer: 1.2,
  knight: 1.55,
  giant: 2.2,
  commander: 1.6,
} as const;

describe("rigged GLB unit pipeline", () => {
  it("bakes visibly distinct geometry for every combat clip and ignores the Icosphere helper", async () => {
    const motions = ["idle", "walk", "attack", "hit", "death", "spawn"] as const;
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: {
        guard: {
          url: "https://example.test/animated-guard.glb",
          clips: Object.fromEntries(motions.map((motion) => [
            motion,
            motion[0]!.toUpperCase() + motion.slice(1),
          ])),
          sampleFrames: 3,
        },
      },
    }));
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async () => fullyAnimatedSyntheticGltf(),
    });

    expect(library.errors.size).toBe(0);
    const guard = library.assets.get("guard");
    expect(guard).toBeDefined();
    for (const motion of motions) {
      const frames = guard?.frames.get(motion);
      expect(frames, motion).toHaveLength(3);
      const first = frames?.[0]?.geometry.getAttribute("position");
      const animated = frames?.[1]?.geometry.getAttribute("position");
      if (!first || !animated) throw new Error(`Missing ${motion} geometry.`);
      let largestDelta = 0;
      for (let vertex = 0; vertex < first.count; vertex += 1) {
        largestDelta = Math.max(
          largestDelta,
          Math.abs(first.getX(vertex) - animated.getX(vertex)),
          Math.abs(first.getY(vertex) - animated.getY(vertex)),
          Math.abs(first.getZ(vertex) - animated.getZ(vertex)),
        );
      }
      expect(largestDelta, motion).toBeGreaterThan(0.003);
    }

    const geometry = guard?.frames.get("walk")?.[0]?.geometry;
    // BoxGeometry expands to 12 triangles / 36 vertices. The large visible
    // Icosphere would add thousands if the runtime helper filter regressed.
    expect(geometry?.getAttribute("position").count).toBe(36);
    library.dispose();
  });

  it("owns the external toon material independently without losing compatible GLB channels", () => {
    const map = new THREE.DataTexture(new Uint8Array([82, 118, 165, 255]), 1, 1);
    const normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    const aoMap = new THREE.DataTexture(new Uint8Array([220, 220, 220, 255]), 1, 1);
    const source = new THREE.MeshStandardMaterial({
      color: 0x5276a5,
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.7, 0.8),
      aoMap,
      aoMapIntensity: 0.65,
      transparent: true,
      opacity: 0.72,
      alphaTest: 0.15,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    source.name = "team cloth";
    let sourceDisposals = 0;
    let toonDisposals = 0;
    source.addEventListener("dispose", () => { sourceDisposals += 1; });

    const converted = createExternalToonMaterial(source);
    converted.addEventListener("dispose", () => { toonDisposals += 1; });

    expect(converted).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(converted).not.toBe(source);
    const toon = converted as THREE.MeshToonMaterial;
    expect(toon.name).toBe(source.name);
    expect(toon.color.getHex()).toBe(source.color.getHex());
    expect(toon.map).toBe(map);
    expect(toon.normalMap).toBe(normalMap);
    expect(toon.normalScale.equals(source.normalScale)).toBe(true);
    expect(toon.aoMap).toBe(aoMap);
    expect(toon.aoMapIntensity).toBe(source.aoMapIntensity);
    expect(toon.gradientMap).toBeInstanceOf(THREE.Texture);
    expect(toon.transparent).toBe(true);
    expect(toon.opacity).toBe(0.72);
    expect(toon.side).toBe(THREE.DoubleSide);

    source.dispose();
    expect(sourceDisposals).toBe(1);
    expect(toonDisposals).toBe(0);
    expect(toon.map).toBe(map);
    converted.dispose();
    expect(toonDisposals).toBe(1);
    map.dispose();
    normalMap.dispose();
    aoMap.dispose();
  });

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

  it("assembles and synchronously bakes an independently rigged composite at the current knight height", async () => {
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
      const expected = motion === "idle" || motion === "walk" || motion === "attack"
        ? [0, 1 / 3, 2 / 3]
        : [0, 0.5, 1];
      expect(frames?.map((frame) => frame.phase)).toEqual(expected);
    }

    const first = knight?.frames.get("walk")?.[0]?.geometry;
    const middle = knight?.frames.get("walk")?.[1]?.geometry;
    expect(first?.groups).toHaveLength(2);
    first?.computeBoundingBox();
    const height = (first?.boundingBox?.max.y ?? 0) - (first?.boundingBox?.min.y ?? 0);
    expect(Math.abs(height - TARGET_HEIGHTS.knight)).toBeLessThanOrEqual(0.02);
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
    expect(frameIndexForPhase(6, 10_000, true)).toBe(0);
    expect(frameIndexForPhase(6, 10_000, false)).toBe(1);
    expect(unitMotion("attack")).toBe("attack");
    expect(unitMotion("unknown-state")).toBe("idle");
  });

  it("rejects an unrigged static GLB instead of installing a T-pose", async () => {
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: { guard: { url: "https://example.test/static-guard.glb" } },
    }));
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async () => denseSyntheticGltf(12),
    });
    expect(library.assets.has("guard")).toBe(false);
    expect(library.errors.get("guard")?.message).toContain("no animation clips");
    library.dispose();
  });

  it("rejects a combined mounted source above the mass-battle triangle budget", async () => {
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: {
        knight: {
          type: "mounted",
          horse: { url: "https://example.test/dense-horse.glb" },
          rider: { url: "https://example.test/dense-rider.glb" },
        },
      },
    }));
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async () => denseSyntheticGltf(30_001),
    });
    expect(library.assets.has("knight")).toBe(false);
    expect(library.errors.get("knight")?.message).toContain("mass-battle limit is 60,000");
    library.dispose();
  });

  it("rejects a rig whose configured mounted clips do not visibly deform", async () => {
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: {
        knight: {
          type: "mounted",
          horse: {
            url: "https://example.test/static-horse.glb",
            clips: { walk: "Horse walk" },
          },
          rider: {
            url: "https://example.test/static-rider.glb",
            clips: { walk: "Rider walk" },
          },
          riderSocket: { bone: "Saddle" },
          sampleFrames: { walk: 3 },
        },
      },
    }));
    const identity = new THREE.Quaternion().toArray();
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async (url) => {
        const part = url.includes("horse") ? "horse" : "rider";
        const gltf = mountedSyntheticGltf(part);
        const target = part === "horse" ? "Saddle.quaternion" : "RiderBody.quaternion";
        gltf.animations = [new THREE.AnimationClip(
          part === "horse" ? "Horse walk" : "Rider walk",
          1,
          [new THREE.QuaternionKeyframeTrack(target, [0, 1], [...identity, ...identity])],
        )];
        return gltf;
      },
    });
    expect(library.assets.has("knight")).toBe(false);
    expect(library.errors.get("knight")?.message).toContain("produce no visible deformation");
    library.dispose();
  });

  it("rejects animation sampling that would exceed the baked-memory budget", async () => {
    const motions = ["idle", "walk", "attack", "hit", "death", "spawn"] as const;
    const clips = motions.map((motion, index) => new THREE.AnimationClip(motion, 1, [
      new THREE.VectorKeyframeTrack("Character.position", [0, 1], [
        0, 0, 0,
        0.01 * (index + 1), 0, 0,
      ]),
    ]));
    const manifest = encodeURIComponent(JSON.stringify({
      version: 1,
      units: {
        commander: {
          url: "https://example.test/overbaked-commander.glb",
          clips: Object.fromEntries(motions.map((motion) => [motion, motion])),
          sampleFrames: 12,
        },
      },
    }));
    const library = await loadExternalUnitLibrary({
      manifestUrl: `data:application/json,${manifest}`,
      loadGltf: async () => denseSyntheticGltf(20_000, clips),
    });
    expect(library.assets.has("commander")).toBe(false);
    expect(library.errors.get("commander")?.message).toContain("per-unit limit");
    library.dispose();
  });
});
