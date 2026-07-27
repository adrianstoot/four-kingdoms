import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  FACTION_COLORS,
  FACTION_CSS_COLORS,
  FACTION_STYLES,
} from "../src/game/factions";
import {
  DETAILED_UNIT_METRICS,
  createDetailedUnitGeometry,
  createDetailedUnitRigGeometry,
} from "../src/game/units/detailedUnits";
import { visualUnitPose } from "../src/game/units/visualUnitPose";

function verticesWithColor(geometry: THREE.BufferGeometry, hex: number): number {
  const colors = geometry.getAttribute("color");
  const expected = new THREE.Color(hex);
  let matches = 0;
  for (let index = 0; index < colors.count; index += 1) {
    if (
      Math.abs(colors.getX(index) - expected.r) < 1e-5
      && Math.abs(colors.getY(index) - expected.g) < 1e-5
      && Math.abs(colors.getZ(index) - expected.b) < 1e-5
    ) {
      matches += 1;
    }
  }
  return matches;
}

function largestPositionDelta(left: THREE.BufferGeometry, right: THREE.BufferGeometry): number {
  const a = left.getAttribute("position");
  const b = right.getAttribute("position");
  expect(a.count).toBe(b.count);
  let largest = 0;
  for (let index = 0; index < a.count; index += 1) {
    largest = Math.max(
      largest,
      Math.abs(a.getX(index) - b.getX(index)),
      Math.abs(a.getY(index) - b.getY(index)),
      Math.abs(a.getZ(index) - b.getZ(index)),
    );
  }
  return largest;
}

describe("canonical faction visuals", () => {
  it("uses the HUD blue, red, green and violet palette for every owner", () => {
    expect(FACTION_STYLES.map((faction) => faction.color)).toEqual([...FACTION_COLORS]);
    expect(FACTION_STYLES.map((faction) => faction.cssColor)).toEqual([...FACTION_CSS_COLORS]);
    expect(FACTION_STYLES.map((faction) => faction.name)).toEqual([
      "COLONIA ZAFIRO",
      "ENJAMBRE RUBÍ",
      "NIDO ESMERALDA",
      "COLMENA AMATISTA",
    ]);
  });

  it.each(["giant", "commander"] as const)(
    "gives the %s a visible faction insignia without tinting its dark chitin",
    (archetype) => {
      const blue = createDetailedUnitRigGeometry(archetype, FACTION_COLORS[0]);
      const red = createDetailedUnitRigGeometry(archetype, FACTION_COLORS[1]);
      const blueInsignia = verticesWithColor(blue, FACTION_COLORS[0]);
      const redInsignia = verticesWithColor(red, FACTION_COLORS[1]);
      const blueChitin = verticesWithColor(blue, 0x171513);
      const redChitin = verticesWithColor(red, 0x171513);

      expect(blueInsignia).toBeGreaterThan(20);
      expect(redInsignia).toBe(blueInsignia);
      expect(blueInsignia / blue.getAttribute("position").count).toBeLessThan(0.18);
      expect(blueChitin).toBeGreaterThan(20);
      expect(redChitin).toBe(blueChitin);

      blue.computeBoundingBox();
      const height = (blue.boundingBox?.max.y ?? 0) - (blue.boundingBox?.min.y ?? 0);
      expect(Math.abs(height - DETAILED_UNIT_METRICS[archetype].height)).toBeLessThanOrEqual(0.02);
      blue.dispose();
      red.dispose();
    },
  );
});

describe("deterministic procedural unit poses", () => {
  it("synchronizes the two walk silhouettes with simulation motionPhase", () => {
    expect(visualUnitPose("walk", 3, 0)).toBe("walkA");
    expect(visualUnitPose("walk", 3, 32_767)).toBe("walkA");
    expect(visualUnitPose("walk", 3, 32_768)).toBe("walkB");
    expect(visualUnitPose("walk", 3, 65_535)).toBe("walkB");
  });

  it("maps attack phase through windup, contact and recovery and uses stateTick fallback", () => {
    expect(visualUnitPose("attack", 2, 6_000)).toBe("attackWindup");
    expect(visualUnitPose("attack", 7, 24_000)).toBe("attack");
    expect(visualUnitPose("attack", 15, 50_000)).toBe("attackRecover");
    expect(visualUnitPose("attack", 8, 0)).toBe("attack");
    expect(visualUnitPose("attack", 0, 24_000)).toBe("attack");
  });

  it("bakes visibly different windup, contact and recovery geometry", () => {
    const windup = createDetailedUnitGeometry("commander", FACTION_COLORS[0], "attackWindup");
    const contact = createDetailedUnitGeometry("commander", FACTION_COLORS[0], "attack");
    const recover = createDetailedUnitGeometry("commander", FACTION_COLORS[0], "attackRecover");

    expect(largestPositionDelta(windup, contact)).toBeGreaterThan(0.08);
    expect(largestPositionDelta(contact, recover)).toBeGreaterThan(0.05);
    windup.dispose();
    contact.dispose();
    recover.dispose();
  });
});
