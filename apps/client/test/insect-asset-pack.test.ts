import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const REQUIRED_CLIPS = ["attack", "death", "hit", "idle", "spawn", "walk"] as const;
const PACK_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/models/insects",
);

const EXPECTED_UNITS = {
  guard: "generated-v1/ant.glb",
  archer: "generated-v1/bee.glb",
  knight: "generated-v1/mantis.glb",
  giant: "generated-v1/beetle.glb",
  commander: "generated-v1/butterfly.glb",
} as const;

interface UnitManifestEntry {
  url: string;
  clips: Record<string, string>;
}

interface InsectManifest {
  version: number;
  units: Record<string, UnitManifestEntry>;
}

interface GltfDocument {
  asset?: { version?: string };
  scenes?: unknown[];
  nodes?: Array<{ name?: string }>;
  meshes?: Array<{
    primitives?: Array<{
      attributes?: Record<string, number>;
    }>;
  }>;
  skins?: Array<{
    inverseBindMatrices?: number;
    joints?: number[];
    name?: string;
  }>;
  animations?: Array<{
    name?: string;
    channels?: Array<{ target?: { node?: number } }>;
    samplers?: unknown[];
  }>;
  buffers?: Array<{ byteLength?: number; uri?: string }>;
  images?: Array<{ uri?: string }>;
}

function parseGlb(filePath: string): {
  document: GltfDocument;
  binaryChunkCount: number;
  byteLength: number;
} {
  const file = readFileSync(filePath);
  expect(file.length, filePath).toBeGreaterThan(32);
  expect(file.readUInt32LE(0), `${filePath} magic`).toBe(GLB_MAGIC);
  expect(file.readUInt32LE(4), `${filePath} GLB version`).toBe(2);
  expect(file.readUInt32LE(8), `${filePath} declared length`).toBe(file.length);

  let offset = 12;
  let document: GltfDocument | undefined;
  let binaryChunkCount = 0;
  while (offset < file.length) {
    expect(offset + 8, `${filePath} truncated chunk header`).toBeLessThanOrEqual(file.length);
    const chunkLength = file.readUInt32LE(offset);
    const chunkType = file.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + chunkLength;
    expect(chunkLength % 4, `${filePath} chunk alignment`).toBe(0);
    expect(chunkEnd, `${filePath} truncated chunk`).toBeLessThanOrEqual(file.length);
    if (chunkType === JSON_CHUNK) {
      expect(document, `${filePath} duplicate JSON chunk`).toBeUndefined();
      const source = file
        .subarray(offset + 8, chunkEnd)
        .toString("utf8")
        .replace(/\0+$/, "")
        .trimEnd();
      document = JSON.parse(source) as GltfDocument;
    } else if (chunkType === BIN_CHUNK) {
      binaryChunkCount += 1;
    }
    offset = chunkEnd;
  }

  expect(offset, `${filePath} chunk coverage`).toBe(file.length);
  expect(document, `${filePath} JSON chunk`).toBeDefined();
  return { document: document!, binaryChunkCount, byteLength: file.length };
}

function localPackPath(url: string): string {
  expect(url).not.toMatch(/^(?:[a-z]+:)?\/\//i);
  expect(url).not.toMatch(/^[a-z]+:/i);
  expect(isAbsolute(url)).toBe(false);
  const path = resolve(PACK_ROOT, url);
  const insidePack = relative(PACK_ROOT, path);
  expect(insidePack).not.toBe("");
  expect(insidePack).not.toMatch(/^\.\.(?:[\\/]|$)/);
  expect(isAbsolute(insidePack)).toBe(false);
  return path;
}

describe("production insect GLB pack", () => {
  it("maps exactly five insect species to local, self-contained GLB assets", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PACK_ROOT, "manifest.json"), "utf8"),
    ) as InsectManifest;

    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.units).sort()).toEqual(Object.keys(EXPECTED_UNITS).sort());
    expect(JSON.stringify(manifest)).not.toMatch(/https?:|data:|blob:|\/\//i);

    for (const [archetype, expectedUrl] of Object.entries(EXPECTED_UNITS)) {
      const entry = manifest.units[archetype];
      expect(entry, archetype).toBeDefined();
      expect(entry.url).toBe(expectedUrl);
      expect(Object.keys(entry.clips).sort(), `${archetype} manifest clips`).toEqual(
        [...REQUIRED_CLIPS],
      );
      expect(Object.values(entry.clips).sort(), `${archetype} clip targets`).toEqual(
        [...REQUIRED_CLIPS],
      );
      localPackPath(entry.url);
    }
  });

  it.each(Object.entries(EXPECTED_UNITS))(
    "%s ships a skinned armature and the complete combat animation set",
    (archetype, url) => {
      const filePath = localPackPath(url);
      const { document, binaryChunkCount, byteLength } = parseGlb(filePath);

      expect(byteLength, `${archetype} is not a real binary asset`).toBeGreaterThan(100_000);
      expect(document.asset?.version).toBe("2.0");
      expect(document.scenes?.length).toBeGreaterThan(0);
      expect(binaryChunkCount, `${archetype} embedded binary chunk`).toBe(1);
      expect(JSON.stringify(document), `${archetype} external URL`).not.toMatch(
        /https?:|data:|blob:|\/\//i,
      );
      expect(document.buffers).toHaveLength(1);
      expect(document.buffers?.[0]?.uri, `${archetype} external buffer`).toBeUndefined();
      for (const image of document.images ?? []) {
        expect(image.uri, `${archetype} external image`).toBeUndefined();
      }

      expect(document.skins, `${archetype} armature`).toHaveLength(1);
      const skin = document.skins?.[0];
      expect(skin?.name, `${archetype} named rig`).toMatch(/rig$/i);
      expect(skin?.inverseBindMatrices, `${archetype} inverse bind matrices`).toEqual(
        expect.any(Number),
      );
      expect(skin?.joints?.length, `${archetype} articulated joints`).toBeGreaterThanOrEqual(30);

      const primitives = (document.meshes ?? []).flatMap((mesh) => mesh.primitives ?? []);
      expect(primitives.length, `${archetype} render primitives`).toBeGreaterThan(0);
      for (const primitive of primitives) {
        expect(primitive.attributes, `${archetype} skin indices`).toHaveProperty("JOINTS_0");
        expect(primitive.attributes, `${archetype} skin weights`).toHaveProperty("WEIGHTS_0");
      }

      const animations = document.animations ?? [];
      expect(animations.map((animation) => animation.name).sort()).toEqual(
        [...REQUIRED_CLIPS],
      );
      const joints = new Set(skin?.joints ?? []);
      for (const animation of animations) {
        expect(animation.channels?.length, `${archetype}/${animation.name} channels`).toBeGreaterThan(0);
        expect(animation.samplers?.length, `${archetype}/${animation.name} samplers`).toBeGreaterThan(0);
        expect(
          animation.channels?.some((channel) => {
            const node = channel.target?.node;
            return typeof node === "number" && joints.has(node);
          }),
          `${archetype}/${animation.name} must animate its armature`,
        ).toBe(true);
      }
    },
  );
});
