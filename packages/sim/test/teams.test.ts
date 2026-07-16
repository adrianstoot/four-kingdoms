import { describe, expect, it } from 'vitest';
import { MAP_GRAPH, createGame } from '../src';

function routeStart(routeId: string) {
  const route = MAP_GRAPH.routes.find((candidate) => candidate.id === routeId)!;
  const zone = MAP_GRAPH.deploymentZones.find((candidate) => candidate.routeIds.includes(route.id))!;
  const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === zone.laneId)!;
  return lane.points[0]!;
}

describe('local 2v2 teams', () => {
  it('assigns the human and Esmeralda to the same team', () => {
    const snapshot = createGame({ botPlayers: [] }).getSnapshot();
    expect(snapshot.players.map((player) => player.teamId)).toEqual([0, 1, 0, 1]);
  });

  it('prevents friendly fire between Azur and Esmeralda', () => {
    const game = createGame({ seed: 21, botPlayers: [] });
    expect(game.queueCommand({
      type: 'deploy', playerId: 2, cardId: 'guards', routeId: 'p2_center',
      sequence: 1, tick: 0, position: routeStart('p2_center'),
    }).accepted).toBe(true);
    const before = game.step();
    const target = { x: before.entities.x[0]! / 100, z: before.entities.z[0]! / 100 };
    const healthBefore = [...before.entities.hp];

    expect(game.queueCommand({
      type: 'spell', playerId: 0, cardId: 'fireball',
      sequence: 1, tick: before.tick, position: target,
    }).accepted).toBe(true);
    const after = game.step();
    expect([...after.entities.hp]).toEqual(healthBefore);
  });

  it('lets allied troops capture the center together', () => {
    const game = createGame({ seed: 22, botPlayers: [] });
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'guards', routeId: 'p0_center',
      sequence: 1, tick: 0, position: routeStart('p0_center'),
    }).accepted).toBe(true);
    expect(game.queueCommand({
      type: 'deploy', playerId: 2, cardId: 'guards', routeId: 'p2_center',
      sequence: 1, tick: 0, position: routeStart('p2_center'),
    }).accepted).toBe(true);
    for (let tick = 0; tick < 900; tick += 1) game.step();
    expect([0, 2]).toContain(game.getSnapshot().center.ownerPlayerId);
  });

  it('keeps allied capture progress when the active contributor changes', () => {
    const game = createGame({ seed: 125, botPlayers: [] });
    for (let tick = 0; tick < 250; tick += 1) game.step();
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'guards', routeId: 'p0_center',
      sequence: 1, tick: game.getSnapshot().tick, position: routeStart('p0_center'),
    }).accepted).toBe(true);
    expect(game.queueCommand({
      type: 'deploy', playerId: 2, cardId: 'guards', routeId: 'p2_center',
      sequence: 1, tick: game.getSnapshot().tick, position: routeStart('p2_center'),
    }).accepted).toBe(true);

    let before = game.getSnapshot();
    for (let tick = 0; tick < 700 && before.center.progressTicks < 30; tick += 1) before = game.step();
    expect(before.center.capturingPlayerId).toBe(0);
    expect(before.center.progressTicks).toBe(30);
    const contributorIndex = [...before.entities.owner].findIndex((owner) => owner === 0);
    const target = {
      x: before.entities.x[contributorIndex]! / 100,
      z: before.entities.z[contributorIndex]! / 100,
    };
    expect(game.queueCommand({
      type: 'spell', playerId: 1, cardId: 'fireball',
      sequence: 1, tick: before.tick, position: target,
    }).accepted).toBe(true);

    const after = game.step();
    const living = (playerId: number) => [...after.entities.owner].filter((owner, index) => (
      owner === playerId && after.entities.state[index] !== 4
    )).length;
    expect(living(0)).toBe(0);
    expect(living(2)).toBeGreaterThan(0);
    expect(after.center.capturingPlayerId).toBe(2);
    expect(after.center.progressTicks).toBe(31);
  });
});
