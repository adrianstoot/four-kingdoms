import { describe, expect, it } from "vitest";
import { EntityStateCode, buildRoutePaths, createGame } from "../src";

interface CombatDebugSurface {
  entities: {
    indexForId(id: number): number;
    state: Uint8Array;
    stateTick: Uint16Array;
    staggerImmunity: Uint8Array;
  };
  damageEntity(index: number, amount: number, sourceId: number): void;
}

describe("formation poise", () => {
  it("takes every damage event without being animation-locked by repeated stagger", () => {
    const route = buildRoutePaths().find((candidate) => candidate.routeId === "p0_outer_e")!;
    const game = createGame({ seed: 0x57066e, botPlayers: [], maxEntities: 16 });
    const guardId = game.spawnDebugCombatant(route.routeId, "guard", 2);
    for (let tick = 0; tick < 9; tick += 1) game.step();

    const debug = game as unknown as CombatDebugSurface;
    const index = debug.entities.indexForId(guardId);
    debug.damageEntity(index, 1, 0);
    expect(debug.entities.state[index]).toBe(EntityStateCode.Hit);
    expect(debug.entities.stateTick[index]).toBe(0);

    // Repeated light contacts keep reducing HP but do not restart the hit clip.
    for (let tick = 1; tick <= 6; tick += 1) {
      game.step();
      debug.damageEntity(index, 1, 0);
      if (tick <= 5) expect(debug.entities.stateTick[index]).toBe(tick);
    }
    expect(debug.entities.state[index]).toBe(EntityStateCode.Walk);

    while (debug.entities.staggerImmunity[index]! > 0) game.step();
    debug.damageEntity(index, 1, 0);
    expect(debug.entities.state[index]).toBe(EntityStateCode.Hit);
    expect(debug.entities.stateTick[index]).toBe(0);
  });
});
