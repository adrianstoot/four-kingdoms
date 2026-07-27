import { describe, expect, it } from 'vitest';
import { ARCHETYPES_BY_ID, MAP_GRAPH, buildRoutePaths, createGame, teamForPlayer } from '../src';

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

  it('keeps every directed route topologically connected and aimed at an enemy castle', () => {
    expect(MAP_GRAPH.routes).toHaveLength(20);
    const kingdomNodeByPlayer = new Map(MAP_GRAPH.nodes
      .filter((node) => node.kind === 'kingdom' && node.playerId !== undefined)
      .map((node) => [node.playerId!, node.id]));
    const laneById = new Map(MAP_GRAPH.lanes.map((lane) => [lane.id, lane]));
    const centerRoutes = MAP_GRAPH.routes.filter((route) => route.kind === 'center');

    expect(centerRoutes).toHaveLength(4);
    expect(centerRoutes.map((route) => route.destinationPlayerId)).toEqual([1, 2, 3, 0]);
    for (const route of MAP_GRAPH.routes) {
      expect(teamForPlayer(route.destinationPlayerId)).not.toBe(teamForPlayer(route.playerId));
      let nodeId = kingdomNodeByPlayer.get(route.playerId);
      for (const step of route.steps) {
        const lane = laneById.get(step.laneId)!;
        const entryNode = step.reverse ? lane.to : lane.from;
        const exitNode = step.reverse ? lane.from : lane.to;
        expect(entryNode, `${route.id} has a disconnected step`).toBe(nodeId);
        nodeId = exitNode;
      }
      expect(nodeId, `${route.id} ends at the wrong castle`).toBe(
        kingdomNodeByPlayer.get(route.destinationPlayerId),
      );
    }
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
    let after = game.step();
    for (let tick = 0; tick < 30; tick += 1) after = game.step();
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

  it('gives allied crossing formations deterministic right of way without leaving their centerlines', () => {
    const paths = new Map(buildRoutePaths().map((path) => [path.routeId, path]));
    const north = paths.get('p0_center')!;
    const south = paths.get('p2_center')!;
    const game = createGame({ seed: 0xa11e5, botPlayers: [], maxEntities: 16 });
    const northId = game.spawnDebugCombatant('p0_center', 'guard', north.centerDistance - 2.5);
    const southId = game.spawnDebugCombatant('p2_center', 'guard', south.centerDistance - 2.5);
    let minimumSeparation = Number.POSITIVE_INFINITY;
    let minimumFrame = '';
    let bothClearedCenter = false;

    for (let tick = 0; tick < 360 && !bothClearedCenter; tick += 1) {
      const snapshot = game.step();
      const northIndex = [...snapshot.entities.id].indexOf(northId);
      const southIndex = [...snapshot.entities.id].indexOf(southId);
      if (northIndex < 0 || southIndex < 0) break;
      const separation = Math.hypot(
        snapshot.entities.x[northIndex]! / 100 - snapshot.entities.x[southIndex]! / 100,
        snapshot.entities.z[northIndex]! / 100 - snapshot.entities.z[southIndex]! / 100,
      );
      if (separation < minimumSeparation) {
        minimumSeparation = separation;
        minimumFrame = `${snapshot.tick}:${snapshot.entities.x[northIndex]! / 100},${snapshot.entities.z[northIndex]! / 100}:${snapshot.entities.x[southIndex]! / 100},${snapshot.entities.z[southIndex]! / 100}`;
      }
      bothClearedCenter = Math.hypot(
        snapshot.entities.x[northIndex]! / 100,
        snapshot.entities.z[northIndex]! / 100,
      ) > 1.5 && Math.hypot(
        snapshot.entities.x[southIndex]! / 100,
        snapshot.entities.z[southIndex]! / 100,
      ) > 1.5 && snapshot.tick > 150;
    }

    const expectedClearance = ARCHETYPES_BY_ID.guard.physicalRadius * 2 + 0.09;
    expect(minimumSeparation, minimumFrame).toBeGreaterThanOrEqual(expectedClearance);
    expect(bothClearedCenter).toBe(true);
  });

  it('keeps allied capture progress when the active contributor changes', () => {
    const game = createGame({ seed: 125, botPlayers: [] });
    for (let tick = 0; tick < 250; tick += 1) game.step();
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'guards', routeId: 'p0_center',
      sequence: 1, tick: game.getSnapshot().tick, position: routeStart('p0_center'),
    }).accepted).toBe(true);
    for (let tick = 0; tick < 70; tick += 1) game.step();
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
      z: 0,
    };
    expect(game.queueCommand({
      type: 'spell', playerId: 1, cardId: 'fireball',
      sequence: 1, tick: before.tick, position: target,
    }).accepted).toBe(true);

    let after = game.step();
    for (let tick = 0; tick < 30 && !after.events.some((event) => event.type === 'spell-impact'); tick += 1) {
      after = game.step();
    }
    const living = (playerId: number) => [...after.entities.owner].filter((owner, index) => (
      owner === playerId && after.entities.state[index] !== 4
    )).length;
    expect(after.events.some((event) => event.type === 'spell-impact')).toBe(true);
    for (let tick = 0; tick < 160 && !(living(0) === 0 && after.center.capturingPlayerId === 2 && after.center.progressTicks > 30); tick += 1) {
      after = game.step();
    }
    expect(living(0)).toBe(0);
    expect(living(2)).toBeGreaterThan(0);
    expect(after.center.capturingPlayerId).toBe(2);
    expect(after.center.progressTicks).toBeGreaterThan(30);
  });
});
