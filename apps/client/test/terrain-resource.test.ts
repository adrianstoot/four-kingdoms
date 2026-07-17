import { describe, expect, it } from "vitest";
import { validateTerrainImage } from "../src/game/terrainResource";

describe("terrain resource validation", () => {
  it("accepts a decoded square image using browser natural dimensions", () => {
    expect(validateTerrainImage({ naturalWidth: 1254, naturalHeight: 1254, width: 0, height: 0 }))
      .toEqual({ width: 1254, height: 1254 });
  });

  it("rejects an image that has not decoded", () => {
    expect(() => validateTerrainImage({ naturalWidth: 0, naturalHeight: 0 }))
      .toThrow(/invalid decoded dimensions/);
  });

  it("rejects a resource that cannot match the square terrain UV layout", () => {
    expect(() => validateTerrainImage({ width: 1024, height: 512 }))
      .toThrow(/must be square/);
  });
});
