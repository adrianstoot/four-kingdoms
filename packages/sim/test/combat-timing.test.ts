import { describe, expect, it } from "vitest";
import {
  EntityStateCode,
  buildRoutePaths,
  createGame,
  type GameSnapshot,
} from "../src";

const paths = new Map(buildRoutePaths().map((path) => [path.routeId, path]));

function entityIndex(snapshot: GameSnapshot, entityId: number): number {
  return [...snapshot.entities.id].indexOf(entityId);
}

function commanderAgainstArcher() {
  const attackerPath = paths.get("p0_outer_e")!;
  const defenderPath = paths.get("p1_outer_n")!;
  const game = createGame({ seed: 0xc07ac7, botPlayers: [], maxEntities: 32 });
  const commanderId = game.spawnDebugCombatant(
    attackerPath.routeId,
    "commander",
    attackerPath.length * 0.5 - 1.5,
  );
  const archerId = game.spawnDebugCombatant(
    defenderPath.routeId,
    "archer",
    defenderPath.length * 0.5 - 1.5,
  );
  return { game, commanderId, archerId };
}

function stepUntilDeath(game: ReturnType<typeof createGame>, entityId: number): GameSnapshot {
  for (let tick = 0; tick < 240; tick += 1) {
    const snapshot = game.step();
    if (snapshot.events.some((event) => event.type === "death" && event.entityId === entityId)) {
      return snapshot;
    }
  }
  throw new Error(`entity ${entityId} never died`);
}

describe("professional combat timing", () => {
  it("finishes the attack recovery before resuming locomotion after a kill", () => {
    const { game, commanderId, archerId } = commanderAgainstArcher();
    let snapshot = stepUntilDeath(game, archerId);
    let commanderIndex = entityIndex(snapshot, commanderId);
    expect(snapshot.entities.state[commanderIndex]).toBe(EntityStateCode.Attack);

    const recoveryStates: number[] = [];
    for (let elapsed = 1; elapsed <= 3; elapsed += 1) {
      snapshot = game.step();
      commanderIndex = entityIndex(snapshot, commanderId);
      const state = snapshot.entities.state[commanderIndex]!;
      expect(
        [EntityStateCode.Attack, EntityStateCode.Hit],
        `locomotion resumed at tick +${elapsed}`,
      ).toContain(state);
      recoveryStates.push(state);
    }
    expect(recoveryStates).toContain(EntityStateCode.Attack);

    let resumedWalking = false;
    for (let elapsed = 0; elapsed < 8; elapsed += 1) {
      snapshot = game.step();
      commanderIndex = entityIndex(snapshot, commanderId);
      resumedWalking ||= snapshot.entities.state[commanderIndex] === EntityStateCode.Walk;
    }
    expect(resumedWalking).toBe(true);
  });

  it("retains a defeated entity for the complete readable death clip", () => {
    const { game, archerId } = commanderAgainstArcher();
    let snapshot = stepUntilDeath(game, archerId);
    let index = entityIndex(snapshot, archerId);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(snapshot.entities.state[index]).toBe(EntityStateCode.Death);
    expect(snapshot.entities.stateTick[index]).toBe(0);

    let previousPhase = snapshot.entities.motionPhase[index]!;
    for (let elapsed = 1; elapsed < 32; elapsed += 1) {
      snapshot = game.step();
      index = entityIndex(snapshot, archerId);
      expect(index, `corpse removed at tick +${elapsed}`).toBeGreaterThanOrEqual(0);
      expect(snapshot.entities.state[index]).toBe(EntityStateCode.Death);
      expect(snapshot.entities.stateTick[index]).toBe(elapsed);
      expect(snapshot.entities.motionPhase[index]).toBeGreaterThan(previousPhase);
      previousPhase = snapshot.entities.motionPhase[index]!;
    }

    snapshot = game.step();
    expect(entityIndex(snapshot, archerId)).toBe(-1);
  });
});
