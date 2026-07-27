import { describe, expect, it } from 'vitest';
import { buildRoutePaths, createGame } from '../src';
import type { PlayerId, Route } from '@kingdoms/content';

type LaneStrength = { friendly: number; enemy: number };

interface LaneAiDebugSurface {
  analyzeLaneStrengths(playerId: PlayerId): Map<string, LaneStrength>;
  chooseBotPushRoute(
    playerId: PlayerId,
    laneStrengths: Map<string, LaneStrength>,
    targetPlayerId: PlayerId | null,
  ): Route | null;
  chooseBotFlankRoute(
    playerId: PlayerId,
    lastRouteId: string | null,
    targetPlayerId: PlayerId | null,
  ): Route | null;
  entities: {
    indexForId(id: number): number;
    x: Float32Array;
    z: Float32Array;
  };
}

const paths = new Map(buildRoutePaths().map((path) => [path.routeId, path]));

function middle(routeId: string): number {
  const path = paths.get(routeId);
  if (!path) throw new Error(`Missing route ${routeId}`);
  return path.length * 0.5;
}

describe('bot lane analysis', () => {
  it('classifies reciprocal-route units on exactly one physical lane', () => {
    const game = createGame({ botPlayers: [] });
    const debug = game as unknown as LaneAiDebugSurface;

    game.spawnDebugCombatant('p0_outer_e', 'guard', middle('p0_outer_e'));
    game.spawnDebugCombatant('p1_outer_n', 'archer', middle('p1_outer_n'));
    game.spawnDebugCombatant('p1_inner_n', 'guard', middle('p1_inner_n'));
    game.spawnDebugCombatant('p0_center', 'giant', middle('p0_center'));

    const strengths = debug.analyzeLaneStrengths(0);
    expect(strengths.get('p0_outer_e')?.friendly).toBeGreaterThan(0);
    expect(strengths.get('p0_outer_e')?.enemy).toBeGreaterThan(0);
    expect(strengths.get('p0_inner_e')?.enemy).toBeGreaterThan(0);
    expect(strengths.get('p0_inner_e')?.friendly).toBe(0);
    expect(strengths.get('p0_inner_w')).toEqual({ friendly: 0, enemy: 0 });
    expect(strengths.get('p0_outer_w')).toEqual({ friendly: 0, enemy: 0 });
  });

  it('uses real spline projection and excludes an entity outside its lane corridor', () => {
    const game = createGame({ botPlayers: [] });
    const debug = game as unknown as LaneAiDebugSurface;
    const id = game.spawnDebugCombatant('p1_outer_n', 'guard', middle('p1_outer_n'));
    const index = debug.entities.indexForId(id);

    expect(debug.analyzeLaneStrengths(0).get('p0_outer_e')?.enemy).toBeGreaterThan(0);

    // Keep the recorded route but move the body far away from its actual spline.
    // Lane-id-only classification would still count it; projection must reject it.
    debug.entities.x[index] = 0;
    debug.entities.z[index] = 0;

    expect(debug.analyzeLaneStrengths(0).get('p0_outer_e')?.enemy).toBe(0);
  });

  it('selects the least-defended route toward the requested enemy deterministically', () => {
    const game = createGame({ botPlayers: [] });
    const debug = game as unknown as LaneAiDebugSurface;

    game.spawnDebugCombatant('p1_outer_n', 'guard', middle('p1_outer_n'));
    let strengths = debug.analyzeLaneStrengths(0);
    expect(debug.chooseBotPushRoute(0, strengths, 1)?.id).toBe('p0_inner_e');
    expect(debug.chooseBotFlankRoute(0, 'p0_outer_w', 1)?.id).toBe('p0_inner_e');

    game.spawnDebugCombatant('p1_inner_n', 'giant', middle('p1_inner_n'));
    strengths = debug.analyzeLaneStrengths(0);
    expect(
      strengths.get('p0_inner_e')!.enemy,
    ).toBeGreaterThan(strengths.get('p0_outer_e')!.enemy);
    expect(debug.chooseBotPushRoute(0, strengths, 1)?.id).toBe('p0_outer_e');
    expect(debug.chooseBotFlankRoute(0, 'p0_outer_w', 1)?.id).toBe('p0_outer_e');

    const empty = createGame({ botPlayers: [] }) as unknown as LaneAiDebugSurface;
    const emptyStrengths = empty.analyzeLaneStrengths(0);
    expect(empty.chooseBotPushRoute(0, emptyStrengths, 1)?.id).toBe('p0_inner_e');
  });
});
