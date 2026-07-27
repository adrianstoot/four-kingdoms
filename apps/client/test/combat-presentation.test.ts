import { describe, expect, it } from "vitest";
import {
  healthBarColor,
  healthRatio,
  remapMotionPhaseAtContact,
  shouldShowHealthBar,
} from "../src/game/units/combatPresentation";

describe("combat presentation", () => {
  it("shows bars throughout combat and after damage but never over corpses", () => {
    expect(shouldShowHealthBar({ health: 100, maxHealth: 100, state: "walk" })).toBe(false);
    expect(shouldShowHealthBar({ health: 100, maxHealth: 100, state: "attack" })).toBe(true);
    expect(shouldShowHealthBar({ health: 100, maxHealth: 100, state: "hit" })).toBe(true);
    expect(shouldShowHealthBar({ health: 72, maxHealth: 100, state: "walk" })).toBe(true);
    expect(shouldShowHealthBar({ health: 0, maxHealth: 100, state: "death" })).toBe(false);
  });

  it("clamps health and uses an unambiguous green, amber and red ramp", () => {
    expect(healthRatio({ health: 120, maxHealth: 100 })).toBe(1);
    expect(healthRatio({ health: -5, maxHealth: 100 })).toBe(0);
    expect(healthBarColor(0.9)).toBe(0x78df73);
    expect(healthBarColor(0.5)).toBe(0xf0bd4f);
    expect(healthBarColor(0.1)).toBe(0xe45445);
  });

  it("aligns the authored strike pose with the simulation damage tick", () => {
    const simulationContact = 7 / 20;
    const atContact = remapMotionPhaseAtContact(
      Math.round(simulationContact * 65_535),
      simulationContact,
    );
    expect(atContact / 65_535).toBeCloseTo(0.5, 3);
    expect(remapMotionPhaseAtContact(0, simulationContact)).toBe(0);
    expect(remapMotionPhaseAtContact(65_535, simulationContact)).toBe(65_535);

    const samples = [0, 8_000, 16_000, 24_000, 32_000, 48_000, 65_535]
      .map((phase) => remapMotionPhaseAtContact(phase, simulationContact));
    expect(samples).toEqual([...samples].sort((left, right) => left - right));
  });
});
