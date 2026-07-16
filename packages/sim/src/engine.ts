import {
  ARCHETYPES_BY_ID,
  CARDS_BY_ID,
  CONTENT,
  MAP_GRAPH,
  getRoutesForPlayer,
  type ArchetypeId,
  type BuildingDefinition,
  type CardId,
  type PlayerId,
  type Route,
  type UnitDefinition,
  type Vec2,
} from '@kingdoms/content';
import {
  buildRoutePaths,
  findPlacement,
  findSpellPlacement,
  laneCenterClearance,
  nearestOnRoutePath,
  pointOnPolyline,
  sampleRoutePath,
  type RoutePath,
} from './placement';
import {
  ArchetypeCode,
  EntityKindCode,
  EntityStateCode,
  POSITION_SCALE,
  teamForPlayer,
  TICK_RATE,
  YAW_SCALE,
  type CastleSnapshot,
  type CenterSnapshot,
  type CommandRejectionReason,
  type CommandResult,
  type GameCommand,
  type GameOptions,
  type GameSnapshot,
  type PlayerSnapshot,
  type SimEvent,
} from './types';

const playerIds: readonly PlayerId[] = [0, 1, 2, 3];
const SPATIAL_CELL_SIZE = 8;
const BOT_DECISION_INTERVAL = 24;
const BOT_DEFENSE_RADIUS = 31;
const BOT_URGENT_THREAT_SCORE = 145;
const archetypeCodes: Record<ArchetypeId, ArchetypeCode> = {
  guard: ArchetypeCode.Guard,
  archer: ArchetypeCode.Archer,
  knight: ArchetypeCode.Knight,
  giant: ArchetypeCode.Giant,
  commander: ArchetypeCode.Commander,
  cannon_tower: ArchetypeCode.CannonTower,
};
const archetypeIds: Record<number, ArchetypeId> = {
  [ArchetypeCode.Guard]: 'guard',
  [ArchetypeCode.Archer]: 'archer',
  [ArchetypeCode.Knight]: 'knight',
  [ArchetypeCode.Giant]: 'giant',
  [ArchetypeCode.Commander]: 'commander',
  [ArchetypeCode.CannonTower]: 'cannon_tower',
};

interface PlayerState {
  id: PlayerId;
  elixirMilli: number;
  alive: boolean;
  lastSequence: number;
  cooldowns: Record<CardId, number>;
}

interface CastleState {
  playerId: PlayerId;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

interface CenterState {
  ownerPlayerId: PlayerId | null;
  capturingPlayerId: PlayerId | null;
  progressTicks: number;
}

interface QueuedCommand {
  command: GameCommand;
  placement: Vec2;
  pathDistance: number;
}


type CombatDefinition = UnitDefinition | BuildingDefinition;

interface BotThreatSummary {
  castle: CastleState | null;
  indices: number[];
  score: number;
  sourcePlayerId: PlayerId | null;
}

interface BotSpellAim {
  position: Vec2;
  score: number;
  hits: number;
}

interface BotTacticsState {
  commanderDeployed: boolean;
  towerDeployed: boolean;
  fireballCast: boolean;
  chainLightningCast: boolean;
  supportWaves: number;
}

class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  integer(maximum: number): number {
    return Math.floor(this.next() * Math.max(1, maximum));
  }
}

class EntityStore {
  readonly capacity: number;
  readonly active: Uint8Array;
  readonly id: Uint32Array;
  readonly kind: Uint8Array;
  readonly archetype: Uint8Array;
  readonly owner: Int8Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly hp: Int32Array;
  readonly maxHp: Int32Array;
  readonly state: Uint8Array;
  readonly stateTick: Uint16Array;
  readonly targetId: Int32Array;
  readonly routeIndex: Int16Array;
  readonly routeDistance: Float32Array;
  readonly laneOffset: Float32Array;
  readonly attackCooldown: Int16Array;
  readonly lifetime: Int32Array;
  readonly cardCost: Uint8Array;
  private readonly idToIndex = new Map<number, number>();
  private nextId = 1;
  count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.active = new Uint8Array(capacity);
    this.id = new Uint32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.owner = new Int8Array(capacity);
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.hp = new Int32Array(capacity);
    this.maxHp = new Int32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.stateTick = new Uint16Array(capacity);
    this.targetId = new Int32Array(capacity);
    this.routeIndex = new Int16Array(capacity);
    this.routeDistance = new Float32Array(capacity);
    this.laneOffset = new Float32Array(capacity);
    this.attackCooldown = new Int16Array(capacity);
    this.lifetime = new Int32Array(capacity);
    this.cardCost = new Uint8Array(capacity);
    this.routeIndex.fill(-1);
    this.targetId.fill(-1);
  }

  spawn(values: {
    kind: EntityKindCode;
    archetype: ArchetypeCode;
    owner: PlayerId;
    x: number;
    z: number;
    yaw: number;
    hp: number;
    routeIndex: number;
    routeDistance: number;
    laneOffset: number;
    lifetime?: number;
    cardCost: number;
  }): number {
    let index = -1;
    for (let candidate = 0; candidate < this.capacity; candidate += 1) {
      if (this.active[candidate] === 0) { index = candidate; break; }
    }
    if (index < 0) return -1;
    const id = this.nextId++;
    this.active[index] = 1;
    this.id[index] = id;
    this.kind[index] = values.kind;
    this.archetype[index] = values.archetype;
    this.owner[index] = values.owner;
    this.x[index] = values.x;
    this.z[index] = values.z;
    this.yaw[index] = values.yaw;
    this.hp[index] = values.hp;
    this.maxHp[index] = values.hp;
    this.state[index] = EntityStateCode.Spawn;
    this.stateTick[index] = 0;
    this.targetId[index] = -1;
    this.routeIndex[index] = values.routeIndex;
    this.routeDistance[index] = values.routeDistance;
    this.laneOffset[index] = values.laneOffset;
    this.attackCooldown[index] = 0;
    this.lifetime[index] = values.lifetime ?? -1;
    this.cardCost[index] = values.cardCost;
    this.idToIndex.set(id, index);
    this.count += 1;
    return id;
  }

  indexForId(id: number): number {
    return this.idToIndex.get(id) ?? -1;
  }

  remove(index: number): void {
    if (index < 0 || this.active[index] === 0) return;
    this.idToIndex.delete(this.id[index]!);
    this.active[index] = 0;
    this.targetId[index] = -1;
    this.routeIndex[index] = -1;
    this.count -= 1;
  }
}

export class GameSimulation {
  readonly maxEntities: number;
  private readonly entities: EntityStore;
  private readonly random: Random;
  private readonly routePaths: RoutePath[];
  private readonly routeById = new Map<string, number>();
  private readonly players: PlayerState[];
  private readonly castles: CastleState[];
  private readonly center: CenterState = { ownerPlayerId: null, capturingPlayerId: null, progressTicks: 0 };
  private readonly queued: QueuedCommand[] = [];
  private readonly botTactics: BotTacticsState[] = playerIds.map(() => ({
    commanderDeployed: false,
    towerDeployed: false,
    fireballCast: false,
    chainLightningCast: false,
    supportWaves: 0,
  }));
  private bots = new Set<PlayerId>();
  private events: SimEvent[] = [];
  private paused = false;
  private tick = 0;
  private phase: 'playing' | 'finished' = 'playing';
  private winnerPlayerId: PlayerId | null = null;
  private draw = false;

  constructor(options: GameOptions = {}) {
    this.maxEntities = Math.max(64, Math.min(8_192, options.maxEntities ?? 2_048));
    this.entities = new EntityStore(this.maxEntities);
    this.random = new Random(options.seed ?? 0x4f55524b);
    this.routePaths = buildRoutePaths();
    this.routePaths.forEach((route, index) => this.routeById.set(route.routeId, index));
    this.players = playerIds.map((id) => ({
      id,
      elixirMilli: CONTENT.balance.initialElixir * 1_000,
      alive: true,
      lastSequence: 0,
      cooldowns: Object.fromEntries(CONTENT.cards.map((card) => [card.id, 0])) as Record<CardId, number>,
    }));
    this.castles = playerIds.map((playerId) => {
      const node = MAP_GRAPH.nodes.find((candidate) => candidate.playerId === playerId);
      return {
        playerId,
        x: node?.position.x ?? 0,
        z: node?.position.z ?? 0,
        hp: CONTENT.balance.castleMaxHp,
        maxHp: CONTENT.balance.castleMaxHp,
        alive: true,
      };
    });
    this.setBotPlayers(options.botPlayers ?? [1, 2, 3]);
  }

  setBotPlayers(ids: readonly number[]): void {
    this.bots = new Set(ids.filter((id): id is PlayerId => id === 0 || id === 1 || id === 2 || id === 3));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  queueCommand(command: GameCommand): CommandResult {
    const rejection = this.validateCommand(command);
    if (rejection) return this.reject(command, rejection);
    const player = this.players[command.playerId]!;
    const card = CARDS_BY_ID[command.cardId];
    let placement: Vec2 = command.position;
    let pathDistance = 0;
    if (command.type === 'deploy') {
      const result = findPlacement(command.playerId, command.cardId, command.routeId, command.position);
      if (!result.valid) return this.reject(command, 'invalid-position');
      placement = result.position;
      pathDistance = result.pathDistance;
    } else {
      const result = findSpellPlacement(command.position);
      if (!result.valid) return this.reject(command, 'invalid-position');
      placement = result.position;
    }
    player.elixirMilli -= card.cost * 1_000;
    player.cooldowns[command.cardId] = command.cardId === 'commander' ? 0 : card.cooldownTicks;
    player.lastSequence = command.sequence;
    this.queued.push({ command, placement, pathDistance });
    return { accepted: true, executeTick: this.tick + 1, snappedPosition: placement };
  }

  private reject(command: GameCommand, reason: CommandRejectionReason): CommandResult {
    this.events.push({ type: 'command-rejected', tick: this.tick, playerId: command.playerId, sequence: command.sequence, reason });
    return { accepted: false, reason };
  }

  private validateCommand(command: GameCommand): CommandRejectionReason | null {
    if (this.phase === 'finished') return 'game-finished';
    if (this.paused) return 'paused';
    if (!playerIds.includes(command.playerId)) return 'invalid-player';
    const player = this.players[command.playerId];
    if (!player?.alive) return 'eliminated';
    if (command.sequence <= player.lastSequence) return 'invalid-sequence';
    if (command.tick < this.tick - 40) return 'stale-tick';
    if (command.tick > this.tick + 40) return 'future-tick';
    const card = CARDS_BY_ID[command.cardId];
    if (!card) return 'unknown-card';
    if ((command.type === 'spell') !== (card.kind === 'spell')) return 'card-kind';
    if (player.elixirMilli < card.cost * 1_000) return 'insufficient-elixir';
    if ((player.cooldowns[command.cardId] ?? 0) > 0) return 'cooldown';
    if (
      command.cardId === 'commander'
      && (
        this.hasActiveCommander(command.playerId)
        || this.queued.some((queued) => queued.command.playerId === command.playerId && queued.command.cardId === 'commander')
      )
    ) return 'hero-active';
    if (command.type === 'deploy') {
      const route = this.routePaths[this.routeById.get(command.routeId) ?? -1];
      if (!route || route.playerId !== command.playerId) return 'invalid-route';
      const count = card.kind === 'troop' || card.kind === 'building' ? card.count : 0;
      if (this.entities.count + count > this.maxEntities) return 'entity-capacity';
    }
    return null;
  }

  step(): GameSnapshot {
    if (this.paused || this.phase === 'finished') return this.getSnapshot();
    this.tick += 1;
    this.events = [];
    this.updateEconomy();
    this.updateBots();
    this.executeCommands();
    this.updateEntities();
    this.updateCenter();
    this.updateAttrition();
    this.resolveEliminations();
    return this.getSnapshot();
  }

  private updateEconomy(): void {
    for (const player of this.players) {
      if (!player.alive) continue;
      const double = this.tick >= CONTENT.balance.doubleElixirTick ? 2 : 1;
      const centerBonus = this.center.ownerPlayerId !== null && teamForPlayer(this.center.ownerPlayerId) === teamForPlayer(player.id) ? 12_500 : 10_000;
      const milliPerTick = Math.round((1_000 / CONTENT.balance.elixirRegenTicks) * double * centerBonus / 10_000);
      player.elixirMilli = Math.min(CONTENT.balance.maxElixir * 1_000, player.elixirMilli + milliPerTick);
      for (const card of CONTENT.cards) {
        player.cooldowns[card.id] = Math.max(0, (player.cooldowns[card.id] ?? 0) - 1);
      }
    }
  }

  private updateBots(): void {
    const orderedBots = [...this.bots]
      .filter((playerId) => (this.tick + playerId * 7) % BOT_DECISION_INTERVAL === 0)
      .sort((left, right) => left - right);
    if (orderedBots.length === 0) return;
    const spatial = this.buildSpatialHash();
    for (const playerId of orderedBots) {
      const player = this.players[playerId];
      if (!player?.alive) continue;

      const affordableIds = CONTENT.cards
        .filter((card) =>
          player.elixirMilli >= card.cost * 1_000
          && (player.cooldowns[card.id] ?? 0) === 0
          && !(card.id === 'commander' && this.hasActiveCommander(playerId)),
        )
        .map((card) => card.id);
      if (affordableIds.length === 0) continue;

      const threat = this.analyzeTeamThreats(playerId);
      const enemies = this.activeEnemyIndices(playerId);
      const spellCandidates = threat.indices.length > 0 ? threat.indices : enemies;
      const tactics = this.botTactics[playerId]!;
      const urgentDefense = threat.castle !== null && threat.score >= BOT_URGENT_THREAT_SCORE;
      const fireAim = this.findBestFireballAim(playerId, spellCandidates, spatial);
      const fireWorthwhile = fireAim !== null
        && (fireAim.hits >= 3 || (urgentDefense && fireAim.hits >= 2) || fireAim.score >= 690);
      const chainAim = this.findBestChainAim(playerId, spellCandidates, spatial);
      const chainWorthwhile = chainAim !== null
        && (chainAim.hits >= 3 || (urgentDefense && chainAim.hits >= 2) || chainAim.score >= 470);
      const teamOwnsCenter = this.center.ownerPlayerId !== null
        && teamForPlayer(this.center.ownerPlayerId) === teamForPlayer(playerId);
      const setupObjective: 'center' | 'offense' = teamOwnsCenter ? 'offense' : 'center';

      // Medium bots open with a hero, a lane tower and a grouped support wave.
      // They wait for the required elixir instead of spending every three points,
      // but an urgent attack always breaks the reserve and is defended immediately.
      if (!tactics.commanderDeployed) {
        const objective: 'defense' | 'center' = urgentDefense ? 'defense' : 'center';
        const route = this.chooseBotRoute(playerId, objective, threat.sourcePlayerId);
        if (
          affordableIds.includes('commander')
          && route
          && this.queueBotDeployment(playerId, 'commander', route)
        ) {
          tactics.commanderDeployed = true;
          continue;
        }
        if (!urgentDefense) continue;
      }

      if (!tactics.towerDeployed && this.tick >= 80) {
        const protectsCurrentTarget = !urgentDefense || threat.castle?.playerId === playerId;
        const route = this.chooseBotRoute(
          playerId,
          urgentDefense ? 'defense' : 'offense',
          urgentDefense ? threat.sourcePlayerId : this.weakestEnemyCastle(playerId)?.playerId ?? null,
        );
        if (
          protectsCurrentTarget
          && affordableIds.includes('cannon_tower')
          && route
          && this.queueBotDeployment(playerId, 'cannon_tower', route)
        ) {
          tactics.towerDeployed = true;
          continue;
        }
        if (!urgentDefense) continue;
      }

      if (tactics.supportWaves < 1) {
        const objective: 'defense' | 'center' | 'offense' = urgentDefense ? 'defense' : setupObjective;
        const route = this.chooseBotRoute(
          playerId,
          objective,
          urgentDefense ? threat.sourcePlayerId : this.weakestEnemyCastle(playerId)?.playerId ?? null,
        );
        if (affordableIds.includes('guards') && route && this.queueBotDeployment(playerId, 'guards', route)) {
          tactics.supportWaves += 1;
          continue;
        }
        if (!urgentDefense) continue;
      }

      if (!tactics.fireballCast) {
        if (affordableIds.includes('fireball') && fireAim && fireWorthwhile && this.queueCommand({
          type: 'spell', playerId, cardId: 'fireball', sequence: player.lastSequence + 1,
          tick: this.tick, position: fireAim.position,
        }).accepted) {
          tactics.fireballCast = true;
          continue;
        }
        if (!urgentDefense) {
          const route = this.chooseBotRoute(playerId, setupObjective, this.weakestEnemyCastle(playerId)?.playerId ?? null);
          if (player.elixirMilli >= 8_000 && route && this.queueBotDeployment(playerId, 'archers', route)) {
            tactics.supportWaves += 1;
            continue;
          }
          continue;
        }
      }

      if (!tactics.chainLightningCast) {
        if (affordableIds.includes('chain_lightning') && chainAim && chainWorthwhile && this.queueCommand({
          type: 'spell', playerId, cardId: 'chain_lightning', sequence: player.lastSequence + 1,
          tick: this.tick, position: chainAim.position,
        }).accepted) {
          tactics.chainLightningCast = true;
          continue;
        }
        if (!urgentDefense) {
          const route = this.chooseBotRoute(playerId, setupObjective, this.weakestEnemyCastle(playerId)?.playerId ?? null);
          if (player.elixirMilli >= 8_000 && route && this.queueBotDeployment(playerId, 'guards', route)) {
            tactics.supportWaves += 1;
            continue;
          }
          continue;
        }
      }

      if (affordableIds.includes('fireball') && fireAim && fireWorthwhile && this.queueCommand({
        type: 'spell', playerId, cardId: 'fireball', sequence: player.lastSequence + 1,
        tick: this.tick, position: fireAim.position,
      }).accepted) {
        tactics.fireballCast = true;
        continue;
      }
      if (affordableIds.includes('chain_lightning') && chainAim && chainWorthwhile && this.queueCommand({
        type: 'spell', playerId, cardId: 'chain_lightning', sequence: player.lastSequence + 1,
        tick: this.tick, position: chainAim.position,
      }).accepted) {
        tactics.chainLightningCast = true;
        continue;
      }

      const focus = this.weakestEnemyCastle(playerId);
      const centerStrength = this.centerStrengths();
      const teamId = teamForPlayer(playerId);
      const enemyTeamId = teamId === 0 ? 1 : 0;
      const teamControlsCenter = this.center.ownerPlayerId !== null
        && teamForPlayer(this.center.ownerPlayerId) === teamId;
      const centerNeedsHelp = !teamControlsCenter
        && centerStrength[teamId] < Math.max(3, centerStrength[enemyTeamId] + 1);
      const centerResponder = this.centerResponder(teamId);

      if (
        affordableIds.includes('cannon_tower')
        && threat.castle?.playerId === playerId
        && threat.score >= BOT_URGENT_THREAT_SCORE
        && !this.hasDefensiveTower(playerId)
      ) {
        const route = this.chooseBotRoute(playerId, 'defense', threat.sourcePlayerId ?? focus?.playerId ?? null);
        if (route && this.queueBotDeployment(playerId, 'cannon_tower', route)) {
          tactics.towerDeployed = true;
          continue;
        }
      }

      const objective: 'defense' | 'center' | 'offense' = urgentDefense
        ? 'defense'
        : centerNeedsHelp && centerResponder === playerId
          ? 'center'
          : 'offense';
      const cardId = this.chooseBotTroop(playerId, affordableIds, objective, threat);
      if (!cardId) continue;
      const targetPlayerId = objective === 'defense'
        ? threat.sourcePlayerId ?? focus?.playerId ?? null
        : focus?.playerId ?? null;
      const route = this.chooseBotRoute(playerId, objective, targetPlayerId);
      if (route && this.queueBotDeployment(playerId, cardId, route)) {
        if (cardId === 'commander') tactics.commanderDeployed = true;
      }
    }
  }

  private analyzeTeamThreats(playerId: PlayerId): BotThreatSummary {
    const teamId = teamForPlayer(playerId);
    const summaries = this.castles
      .filter((castle) => castle.alive && teamForPlayer(castle.playerId) === teamId)
      .map((castle) => {
        const indices: number[] = [];
        const sourceScores = new Map<PlayerId, number>();
        let score = 0;
        for (let index = 0; index < this.entities.capacity; index += 1) {
          if (!this.isLivingEnemy(index, playerId)) continue;
          const dx = this.entities.x[index]! - castle.x;
          const dz = this.entities.z[index]! - castle.z;
          const distance = Math.hypot(dx, dz);
          if (distance > BOT_DEFENSE_RADIUS) continue;
          const definition = this.definitionAt(index);
          const proximity = 1 - distance / BOT_DEFENSE_RADIUS;
          const damagePerSecond = definition.damage * TICK_RATE / definition.attackCooldownTicks;
          const siegeBonus = this.entities.archetype[index] === ArchetypeCode.Giant ? 54 : 0;
          const value = 18 + this.entities.cardCost[index]! * 7 + damagePerSecond * 0.34 + siegeBonus;
          const weighted = value * (0.35 + proximity * 0.9);
          indices.push(index);
          score += weighted;
          const source = this.entities.owner[index] as PlayerId;
          sourceScores.set(source, (sourceScores.get(source) ?? 0) + weighted);
        }
        const healthPressure = (1 - castle.hp / castle.maxHp) * 65;
        const sourcePlayerId = [...sourceScores.entries()]
          .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
        return { castle, indices, score: score + healthPressure, sourcePlayerId } satisfies BotThreatSummary;
      })
      .sort((left, right) => right.score - left.score || (left.castle?.playerId ?? 0) - (right.castle?.playerId ?? 0));

    const botTeam = [...this.bots]
      .filter((candidate) => this.players[candidate]?.alive && teamForPlayer(candidate) === teamId)
      .sort((left, right) => left - right);
    const rank = Math.max(0, botTeam.indexOf(playerId));
    const activeThreats = summaries.filter((summary) => summary.indices.length > 0);
    if (activeThreats.length > 1 && botTeam.length > 1) return activeThreats[rank % activeThreats.length]!;
    return activeThreats[0] ?? summaries[0] ?? { castle: null, indices: [], score: 0, sourcePlayerId: null };
  }

  private weakestEnemyCastle(playerId: PlayerId): CastleState | null {
    const candidates = this.castles.filter((castle) => castle.alive && this.isEnemyPlayer(playerId, castle.playerId));
    candidates.sort((left, right) => {
      const leftPressure = this.friendlyPressureNearCastle(playerId, left);
      const rightPressure = this.friendlyPressureNearCastle(playerId, right);
      const leftScore = left.hp / left.maxHp - leftPressure * 0.012;
      const rightScore = right.hp / right.maxHp - rightPressure * 0.012;
      return leftScore - rightScore || left.playerId - right.playerId;
    });
    return candidates[0] ?? null;
  }

  private friendlyPressureNearCastle(playerId: PlayerId, castle: CastleState): number {
    let pressure = 0;
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0 || this.entities.state[index] === EntityStateCode.Death) continue;
      if (teamForPlayer(this.entities.owner[index] as PlayerId) !== teamForPlayer(playerId)) continue;
      if (Math.hypot(this.entities.x[index]! - castle.x, this.entities.z[index]! - castle.z) > 25) continue;
      pressure += 1 + this.entities.cardCost[index]! * 0.25;
    }
    return pressure;
  }

  private centerStrengths(): [number, number] {
    const strengths: [number, number] = [0, 0];
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0 || this.entities.kind[index] !== EntityKindCode.Unit || this.entities.state[index] === EntityStateCode.Death) continue;
      const route = this.routePaths[this.entities.routeIndex[index]!];
      const nearCenter = Math.hypot(this.entities.x[index]!, this.entities.z[index]!) <= 13;
      const approachingCenter = route?.kind === 'center'
        && this.entities.routeDistance[index]! <= route.centerDistance + 4;
      if (!nearCenter && !approachingCenter) continue;
      const owner = this.entities.owner[index] as PlayerId;
      strengths[teamForPlayer(owner)] += this.definitionAt(index).captureWeight;
    }
    return strengths;
  }

  private centerResponder(teamId: 0 | 1): PlayerId | null {
    const teamBots = [...this.bots]
      .filter((playerId) => this.players[playerId]?.alive && teamForPlayer(playerId) === teamId)
      .sort((left, right) => left - right);
    if (teamBots.length === 0) return null;
    const phase = Math.floor(this.tick / (BOT_DECISION_INTERVAL * 5));
    return teamBots[(phase + teamId) % teamBots.length] ?? null;
  }
  private chooseBotTroop(
    playerId: PlayerId,
    affordableIds: readonly CardId[],
    objective: 'defense' | 'center' | 'offense',
    threat: BotThreatSummary,
  ): Exclude<CardId, 'cannon_tower' | 'fireball' | 'chain_lightning'> | null {
    const troopIds: readonly Exclude<CardId, 'cannon_tower' | 'fireball' | 'chain_lightning'>[] = [
      'guards', 'archers', 'knight', 'giant', 'commander',
    ];
    const player = this.players[playerId]!;
    const enemyMelee = threat.indices.filter((index) => {
      const code = this.entities.archetype[index]!;
      return code === ArchetypeCode.Guard || code === ArchetypeCode.Knight || code === ArchetypeCode.Giant || code === ArchetypeCode.Commander;
    }).length;
    let best: typeof troopIds[number] | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let order = 0; order < troopIds.length; order += 1) {
      const cardId = troopIds[order]!;
      if (!affordableIds.includes(cardId)) continue;
      let score = 0;
      if (objective === 'defense') {
        score = { guards: 78, archers: 65 + enemyMelee * 8, knight: 88, giant: 18, commander: 82 }[cardId];
      } else if (objective === 'center') {
        score = { guards: 88, archers: 72, knight: 66, giant: 28, commander: 92 }[cardId];
      } else {
        score = { guards: 58, archers: 64, knight: 75, giant: 96, commander: 84 }[cardId];
      }
      const cost = CARDS_BY_ID[cardId].cost;
      if (player.elixirMilli >= 25_000) score += cost * 3;
      if (player.elixirMilli < 8_000) score -= cost * 2;
      score += this.random.integer(7) - 3;
      if (score > bestScore) { best = cardId; bestScore = score; }
    }
    return best;
  }

  private chooseBotRoute(
    playerId: PlayerId,
    objective: 'defense' | 'center' | 'offense',
    targetPlayerId: PlayerId | null,
  ): Route | null {
    const routes = getRoutesForPlayer(playerId);
    if (objective === 'center') return routes.find((route) => route.kind === 'center') ?? null;
    let candidates = routes.filter((route) =>
      route.kind === 'direct'
      && this.castles[route.destinationPlayerId]?.alive
      && this.isEnemyPlayer(playerId, route.destinationPlayerId),
    );
    if (targetPlayerId !== null) {
      const focused = candidates.filter((route) => route.destinationPlayerId === targetPlayerId);
      if (focused.length > 0) candidates = focused;
    }
    const routePressure = (route: Route) => {
      const routeIndex = this.routeById.get(route.id) ?? -1;
      let count = 0;
      for (let index = 0; index < this.entities.capacity; index += 1) {
        if (this.entities.active[index] && this.entities.owner[index] === playerId && this.entities.routeIndex[index] === routeIndex) count += 1;
      }
      return count;
    };
    candidates.sort((left, right) => {
      const pressureDifference = routePressure(left) - routePressure(right);
      return pressureDifference || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
    return candidates[0] ?? null;
  }

  private queueBotDeployment(
    playerId: PlayerId,
    cardId: Exclude<CardId, 'fireball' | 'chain_lightning'>,
    route: Route,
  ): boolean {
    const player = this.players[playerId]!;
    let desired: Vec2 | null = null;
    if (cardId === 'cannon_tower') {
      desired = MAP_GRAPH.towerPads.find((pad) => pad.playerId === playerId && pad.routeIds.includes(route.id))?.position ?? null;
    } else {
      const zone = MAP_GRAPH.deploymentZones.find((candidate) => candidate.playerId === playerId && candidate.routeIds.includes(route.id));
      const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === zone?.laneId);
      if (zone && lane) desired = pointOnPolyline(lane.points, (zone.startT + zone.endT) * 0.5).position;
    }
    if (!desired) return false;
    return this.queueCommand({
      type: 'deploy', playerId, cardId, routeId: route.id,
      sequence: player.lastSequence + 1, tick: this.tick, position: desired,
    }).accepted;
  }

  private hasDefensiveTower(playerId: PlayerId): boolean {
    const castle = this.castles[playerId]!;
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (
        this.entities.active[index]
        && this.entities.owner[index] === playerId
        && this.entities.archetype[index] === ArchetypeCode.CannonTower
        && this.entities.state[index] !== EntityStateCode.Death
        && Math.hypot(this.entities.x[index]! - castle.x, this.entities.z[index]! - castle.z) <= 18
      ) return true;
    }
    return false;
  }
  private findBestFireballAim(
    playerId: PlayerId,
    candidates: readonly number[],
    spatial: Map<string, number[]>,
  ): BotSpellAim | null {
    const card = CARDS_BY_ID.fireball;
    if (card.kind !== 'spell' || card.spell !== 'area') return null;
    let best: BotSpellAim | null = null;
    let bestTieId = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (!this.isLivingEnemy(candidate, playerId)) continue;
      const position = { x: this.entities.x[candidate]!, z: this.entities.z[candidate]! };
      const nearby = this.indicesNear(position.x, position.z, card.radius, spatial);
      let hits = 0;
      let score = 0;
      for (const index of nearby) {
        if (!this.isLivingEnemy(index, playerId)) continue;
        hits += 1;
        const effectiveDamage = Math.min(card.damage, this.entities.hp[index]!);
        const killBonus = this.entities.hp[index]! <= card.damage ? 105 : 0;
        const heroBonus = this.entities.archetype[index] === ArchetypeCode.Commander ? 90 : 0;
        const buildingBonus = this.entities.kind[index] === EntityKindCode.Building ? 65 : 0;
        score += effectiveDamage + killBonus + heroBonus + buildingBonus + this.entities.cardCost[index]! * 11;
      }
      const tieId = this.entities.id[candidate]!;
      if (!best || score > best.score || (score === best.score && tieId < bestTieId)) {
        best = { position, score, hits };
        bestTieId = tieId;
      }
    }
    return best;
  }

  private findBestChainAim(
    playerId: PlayerId,
    candidates: readonly number[],
    spatial: Map<string, number[]>,
  ): BotSpellAim | null {
    const card = CARDS_BY_ID.chain_lightning;
    if (card.kind !== 'spell' || card.spell !== 'chain') return null;
    let best: BotSpellAim | null = null;
    let bestTieId = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (!this.isLivingEnemy(candidate, playerId)) continue;
      const start = { x: this.entities.x[candidate]!, z: this.entities.z[candidate]! };
      const used = new Set<number>();
      let cursor = start;
      let damage = card.damage;
      let score = 0;
      let hits = 0;
      for (let jump = 0; jump < card.maxTargets; jump += 1) {
        const range = jump === 0 ? card.radius : card.chainRange;
        let target = -1;
        let targetScore = Number.NEGATIVE_INFINITY;
        for (const index of this.indicesNear(cursor.x, cursor.z, range, spatial)) {
          if (!this.isLivingEnemy(index, playerId) || used.has(index)) continue;
          const distance = Math.hypot(this.entities.x[index]! - cursor.x, this.entities.z[index]! - cursor.z);
          const value = Math.min(damage, this.entities.hp[index]!)
            + (this.entities.hp[index]! <= damage ? 85 : 0)
            + this.entities.cardCost[index]! * 9
            - distance * 2;
          if (value > targetScore || (value === targetScore && this.entities.id[index]! < (target >= 0 ? this.entities.id[target]! : Number.POSITIVE_INFINITY))) {
            target = index;
            targetScore = value;
          }
        }
        if (target < 0) break;
        used.add(target);
        hits += 1;
        score += targetScore;
        cursor = { x: this.entities.x[target]!, z: this.entities.z[target]! };
        damage = Math.max(1, Math.round(damage * card.falloffBps / 10_000));
      }
      const tieId = this.entities.id[candidate]!;
      if (!best || score > best.score || (score === best.score && tieId < bestTieId)) {
        best = { position: start, score, hits };
        bestTieId = tieId;
      }
    }
    return best;
  }
  private executeCommands(): void {
    while (this.queued.length > 0) {
      const queued = this.queued.shift()!;
      if (queued.command.type === 'spell') this.castSpell(queued.command.playerId, queued.command.cardId, queued.placement);
      else this.deploy(queued.command.playerId, queued.command.cardId, queued.command.routeId, queued.placement, queued.pathDistance);
    }
  }

  private deploy(playerId: PlayerId, cardId: Exclude<CardId, 'fireball' | 'chain_lightning'>, routeId: string, position: Vec2, pathDistance: number): void {
    const card = CARDS_BY_ID[cardId];
    if (card.kind === 'spell') return;
    const routeIndex = this.routeById.get(routeId) ?? -1;
    const route = this.routePaths[routeIndex];
    const archetypeId = card.archetypeId;
    const definition = ARCHETYPES_BY_ID[archetypeId];
    const archetype = archetypeCodes[archetypeId];
    const kind = definition.kind === 'building' ? EntityKindCode.Building : EntityKindCode.Unit;
    for (let member = 0; member < card.count; member += 1) {
      const requestedOffset = card.count === 1 ? 0 : (member - (card.count - 1) / 2) * 0.85;
      const routeDistance = route ? Math.min(route.length, pathDistance + member * 0.32) : pathDistance;
      const sample = route ? sampleRoutePath(route, routeDistance) : null;
      const maximumOffset = sample && kind === EntityKindCode.Unit
        ? laneCenterClearance(sample.laneWidth, definition.radius)
        : 0;
      const laneOffset = Math.max(-maximumOffset, Math.min(maximumOffset, requestedOffset));
      const unitPosition = kind === EntityKindCode.Unit && sample
        ? {
          x: sample.position.x + Math.cos(sample.yaw) * laneOffset,
          z: sample.position.z - Math.sin(sample.yaw) * laneOffset,
        }
        : position;
      const id = this.entities.spawn({
        kind,
        archetype,
        owner: playerId,
        x: unitPosition.x,
        z: unitPosition.z,
        yaw: sample?.yaw ?? 0,
        hp: definition.maxHp,
        routeIndex,
        routeDistance,
        laneOffset,
        lifetime: definition.kind === 'building' ? definition.lifetimeTicks : -1,
        cardCost: card.cost,
      });
      if (id >= 0) this.events.push({ type: 'spawn', tick: this.tick, entityId: id, playerId, archetype });
    }
  }

  private castSpell(playerId: PlayerId, cardId: 'fireball' | 'chain_lightning', position: Vec2): void {
    const card = CARDS_BY_ID[cardId];
    if (card.kind !== 'spell') return;
    const targets: number[] = [];
    if (card.spell === 'area') {
      for (let index = 0; index < this.entities.capacity; index += 1) {
        if (!this.isLivingEnemy(index, playerId)) continue;
        if (Math.hypot(this.entities.x[index]! - position.x, this.entities.z[index]! - position.z) <= card.radius) {
          targets.push(this.entities.id[index]!);
          this.damageEntity(index, card.damage, 0);
        }
      }
    } else {
      let cursor = position;
      let damage = card.damage;
      const used = new Set<number>();
      for (let jump = 0; jump < card.maxTargets; jump += 1) {
        let best = -1;
        let bestDistance = jump === 0 ? card.radius : card.chainRange;
        for (let index = 0; index < this.entities.capacity; index += 1) {
          if (!this.isLivingEnemy(index, playerId) || used.has(index)) continue;
          const distance = Math.hypot(this.entities.x[index]! - cursor.x, this.entities.z[index]! - cursor.z);
          if (distance <= bestDistance) { best = index; bestDistance = distance; }
        }
        if (best < 0) break;
        used.add(best);
        targets.push(this.entities.id[best]!);
        cursor = { x: this.entities.x[best]!, z: this.entities.z[best]! };
        this.damageEntity(best, damage, 0);
        damage = Math.max(1, Math.round(damage * card.falloffBps / 10_000));
      }
    }
    this.events.push({ type: 'spell', tick: this.tick, playerId, cardId, position, targetIds: targets });
  }

  private updateEntities(): void {
    const spatial = this.buildSpatialHash();
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0) continue;
      this.entities.stateTick[index] = Math.min(65_535, this.entities.stateTick[index]! + 1);
      if (this.entities.state[index] === EntityStateCode.Death) {
        if (this.entities.stateTick[index]! >= 14) this.entities.remove(index);
        continue;
      }
      if (this.entities.state[index] === EntityStateCode.Spawn && this.entities.stateTick[index]! > 8) this.setEntityState(index, EntityStateCode.Idle);
      if (this.entities.attackCooldown[index]! > 0) this.entities.attackCooldown[index] = this.entities.attackCooldown[index]! - 1;
      if (this.entities.lifetime[index]! > 0) {
        this.entities.lifetime[index] = this.entities.lifetime[index]! - 1;
        if (this.entities.lifetime[index] === 0) { this.killEntity(index); continue; }
      }

      const owner = this.entities.owner[index] as PlayerId;
      const definition = this.definitionAt(index);
      const target = this.findCombatTarget(index, definition, spatial);
      if (target >= 0) {
        const dx = this.entities.x[target]! - this.entities.x[index]!;
        const dz = this.entities.z[target]! - this.entities.z[index]!;
        const distance = Math.hypot(dx, dz);
        const targetRadius = this.definitionAt(target).radius;
        this.entities.targetId[index] = this.entities.id[target]!;
        if (distance <= definition.attackRange + targetRadius) {
          this.setEntityState(index, EntityStateCode.Attack);
          this.entities.yaw[index] = Math.atan2(dx, dz);
          if (this.entities.attackCooldown[index]! <= 0) {
            this.damageEntity(target, definition.damage, this.entities.id[index]!);
            this.entities.attackCooldown[index] = definition.attackCooldownTicks;
          }
          continue;
        }
        if (definition.kind === 'unit' && this.canPursue(index, target, definition)) {
          this.setEntityState(index, EntityStateCode.Walk);
          this.moveEntityToward(
            index,
            this.entities.x[target]!,
            this.entities.z[target]!,
            definition.moveSpeed / TICK_RATE,
            spatial,
            0.45,
          );
          continue;
        }
        this.entities.targetId[index] = -1;
      } else {
        this.entities.targetId[index] = -1;
      }

      if (this.entities.kind[index] === EntityKindCode.Building) {
        this.setEntityState(index, EntityStateCode.Idle);
        continue;
      }
      const route = this.routePaths[this.entities.routeIndex[index]!];
      if (!route || definition.kind !== 'unit') continue;
      const atCenter = route.kind === 'center' && Math.abs(this.entities.routeDistance[index]! - route.centerDistance) < 2.2;
      const teamControlsCenter = this.center.ownerPlayerId !== null && !this.isEnemyPlayer(owner, this.center.ownerPlayerId);
      if (atCenter && !teamControlsCenter) {
        this.setEntityState(index, EntityStateCode.Idle);
        continue;
      }
      if (this.entities.routeDistance[index]! >= route.length - 2.2) {
        const castle = this.castles[route.destinationPlayerId];
        if (castle?.alive && this.isEnemyPlayer(owner, castle.playerId)) {
          const distance = Math.hypot(castle.x - this.entities.x[index]!, castle.z - this.entities.z[index]!);
          if (distance > definition.attackRange + 2.4) {
            this.setEntityState(index, EntityStateCode.Walk);
            this.moveEntityToward(index, castle.x, castle.z, definition.moveSpeed / TICK_RATE, spatial, 0.35);
            continue;
          }
          this.setEntityState(index, EntityStateCode.Attack);
          this.entities.yaw[index] = Math.atan2(castle.x - this.entities.x[index]!, castle.z - this.entities.z[index]!);
          if (this.entities.attackCooldown[index]! <= 0) {
            const multiplier = this.tick >= CONTENT.balance.doubleElixirTick ? 1.5 : 1;
            const damage = Math.round(definition.damage * multiplier);
            castle.hp = Math.max(0, castle.hp - damage);
            this.entities.attackCooldown[index] = definition.attackCooldownTicks;
            this.events.push({ type: 'damage', tick: this.tick, sourceId: this.entities.id[index]!, targetType: 'castle', targetId: castle.playerId, amount: damage });
          }
        } else {
          this.retargetAtNode(index, route.destinationPlayerId);
        }
        continue;
      }

      this.setEntityState(index, EntityStateCode.Walk);
      const currentSample = sampleRoutePath(route, this.entities.routeDistance[index]!);
      const currentLaneOffset = this.clampedLaneOffset(index, currentSample.laneWidth);
      const currentTargetX = currentSample.position.x + Math.cos(currentSample.yaw) * currentLaneOffset;
      const currentTargetZ = currentSample.position.z - Math.sin(currentSample.yaw) * currentLaneOffset;
      const displaced = Math.hypot(this.entities.x[index]! - currentTargetX, this.entities.z[index]! - currentTargetZ) > 1.15;
      if (displaced) {
        this.moveEntityToward(index, currentTargetX, currentTargetZ, definition.moveSpeed / TICK_RATE, spatial, 0.25);
        continue;
      }
      this.entities.routeDistance[index] = Math.min(route.length, this.entities.routeDistance[index]! + definition.moveSpeed / TICK_RATE);
      const sample = sampleRoutePath(route, this.entities.routeDistance[index]!);
      const laneOffset = this.clampedLaneOffset(index, sample.laneWidth);
      const targetX = sample.position.x + Math.cos(sample.yaw) * laneOffset;
      const targetZ = sample.position.z - Math.sin(sample.yaw) * laneOffset;
      this.moveEntityToward(index, targetX, targetZ, definition.moveSpeed / TICK_RATE, spatial, 0.3);
    }
  }
  private retargetAtNode(index: number, nodePlayerId: PlayerId): void {
    const owner = this.entities.owner[index] as PlayerId;
    const alternatives = this.routePaths.filter((route) => route.playerId === nodePlayerId && this.castles[route.destinationPlayerId]?.alive && this.isEnemyPlayer(owner, route.destinationPlayerId));
    if (alternatives.length === 0) { this.killEntity(index); return; }
    const route = alternatives.sort((left, right) => left.destinationPlayerId - right.destinationPlayerId)[0]!;
    this.entities.routeIndex[index] = this.routeById.get(route.routeId) ?? -1;
    this.entities.routeDistance[index] = 0;
  }

  private updateCenter(): void {
    const teamWeights: [number, number] = [0, 0];
    const contributors: [PlayerId | null, PlayerId | null] = [null, null];
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0 || this.entities.state[index] === EntityStateCode.Death || this.entities.kind[index] !== EntityKindCode.Unit) continue;
      if (Math.hypot(this.entities.x[index]!, this.entities.z[index]!) > 7) continue;
      const definition = ARCHETYPES_BY_ID[archetypeIds[this.entities.archetype[index]!]!];
      const playerId = this.entities.owner[index] as PlayerId;
      const teamId = teamForPlayer(playerId);
      teamWeights[teamId] += definition.captureWeight;
      contributors[teamId] ??= playerId;
    }
    const presentTeams = ([0, 1] as const).filter((teamId) => teamWeights[teamId] > 0);
    if (presentTeams.length !== 1) {
      this.center.progressTicks = Math.max(0, this.center.progressTicks - 1);
      if (this.center.progressTicks === 0) this.center.capturingPlayerId = null;
      return;
    }
    const capturingTeam = presentTeams[0]!;
    const owner = contributors[capturingTeam]!;
    if (this.center.ownerPlayerId !== null && teamForPlayer(this.center.ownerPlayerId) === capturingTeam) {
      this.center.capturingPlayerId = null;
      this.center.progressTicks = 0;
      return;
    }
    const previousCapturingTeam = this.center.capturingPlayerId === null
      ? null
      : teamForPlayer(this.center.capturingPlayerId);
    if (previousCapturingTeam !== capturingTeam) {
      this.center.capturingPlayerId = owner;
      this.center.progressTicks = 1;
    } else {
      this.center.capturingPlayerId = owner;
      this.center.progressTicks += 1;
    }
    if (this.center.progressTicks >= CONTENT.balance.centerCaptureTicks) {
      this.center.ownerPlayerId = owner;
      this.center.capturingPlayerId = null;
      this.center.progressTicks = 0;
      this.events.push({ type: 'capture', tick: this.tick, playerId: owner });
    }
  }

  private updateAttrition(): void {
    if (this.tick < CONTENT.balance.attritionTick || this.tick % TICK_RATE !== 0) return;
    const damage = Math.round(CONTENT.balance.castleMaxHp * CONTENT.balance.castleAttritionBpsPerSecond / 10_000);
    for (const castle of this.castles) if (castle.alive) castle.hp = Math.max(0, castle.hp - damage);
  }

  private resolveEliminations(): void {
    for (const castle of this.castles) {
      if (!castle.alive || castle.hp > 0) continue;
      castle.alive = false;
      this.players[castle.playerId]!.alive = false;
      this.events.push({ type: 'elimination', tick: this.tick, playerId: castle.playerId });
    }
    if (this.center.ownerPlayerId !== null && !this.players[this.center.ownerPlayerId]?.alive) {
      const ownerTeam = teamForPlayer(this.center.ownerPlayerId);
      this.center.ownerPlayerId = playerIds.find((id) => this.players[id]?.alive && teamForPlayer(id) === ownerTeam) ?? null;
    }
    const survivingTeams = new Set(this.castles.filter((castle) => castle.alive).map((castle) => teamForPlayer(castle.playerId)));
    if (survivingTeams.size > 1) return;
    this.phase = 'finished';
    const winningTeam = [...survivingTeams][0];
    this.winnerPlayerId = winningTeam === 0 ? 0 : winningTeam === 1 ? 1 : null;
    this.draw = survivingTeams.size === 0;
    this.events.push({ type: 'game-over', tick: this.tick, winnerPlayerId: this.winnerPlayerId, draw: this.draw });
  }

  private definitionAt(index: number): CombatDefinition {
    return ARCHETYPES_BY_ID[archetypeIds[this.entities.archetype[index]!]!];
  }

  private buildSpatialHash(): Map<string, number[]> {
    const cells = new Map<string, number[]>();
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0 || this.entities.state[index] === EntityStateCode.Death) continue;
      const key = `${Math.floor(this.entities.x[index]! / SPATIAL_CELL_SIZE)},${Math.floor(this.entities.z[index]! / SPATIAL_CELL_SIZE)}`;
      const cell = cells.get(key);
      if (cell) cell.push(index); else cells.set(key, [index]);
    }
    return cells;
  }

  private indicesNear(x: number, z: number, range: number, spatial: Map<string, number[]>): number[] {
    const result: number[] = [];
    const cellX = Math.floor(x / SPATIAL_CELL_SIZE);
    const cellZ = Math.floor(z / SPATIAL_CELL_SIZE);
    const cellRadius = Math.max(1, Math.ceil(range / SPATIAL_CELL_SIZE));
    const rangeSquared = range * range;
    for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX += 1) {
      for (let offsetZ = -cellRadius; offsetZ <= cellRadius; offsetZ += 1) {
        for (const candidate of spatial.get(`${cellX + offsetX},${cellZ + offsetZ}`) ?? []) {
          const dx = this.entities.x[candidate]! - x;
          const dz = this.entities.z[candidate]! - z;
          if (dx * dx + dz * dz <= rangeSquared) result.push(candidate);
        }
      }
    }
    return result;
  }

  private findCombatTarget(index: number, definition: CombatDefinition, spatial: Map<string, number[]>): number {
    const owner = this.entities.owner[index] as PlayerId;
    const x = this.entities.x[index]!;
    const z = this.entities.z[index]!;
    const locked = this.entities.indexForId(this.entities.targetId[index]!);
    const lockRange = definition.aggroRange * 1.45;
    const lockIsValid = locked >= 0
      && this.isLivingEnemy(locked, owner)
      && (this.entities.x[locked]! - x) ** 2 + (this.entities.z[locked]! - z) ** 2 <= lockRange * lockRange;

    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestId = Number.POSITIVE_INFINITY;
    for (const candidate of this.indicesNear(x, z, definition.aggroRange, spatial)) {
      if (candidate === index || !this.isLivingEnemy(candidate, owner)) continue;
      const score = this.combatTargetScore(index, candidate, definition);
      const id = this.entities.id[candidate]!;
      if (score < bestScore || (score === bestScore && id < bestId)) {
        best = candidate;
        bestScore = score;
        bestId = id;
      }
    }

    if (!lockIsValid) return best;
    if (
      definition.targetPriority === 'buildings'
      && best >= 0
      && this.entities.kind[best] === EntityKindCode.Building
      && this.entities.kind[locked] !== EntityKindCode.Building
    ) return best;
    return locked;
  }

  private combatTargetScore(index: number, candidate: number, definition: CombatDefinition): number {
    const dx = this.entities.x[candidate]! - this.entities.x[index]!;
    const dz = this.entities.z[candidate]! - this.entities.z[index]!;
    const distanceSquared = dx * dx + dz * dz;
    const rangeSquared = definition.aggroRange * definition.aggroRange;
    let score = distanceSquared;
    if (definition.targetPriority === 'buildings') {
      score += this.entities.kind[candidate] === EntityKindCode.Building ? -rangeSquared * 4 : rangeSquared * 1.5;
    }
    if (this.entities.targetId[candidate] === this.entities.id[index]) score -= rangeSquared * 0.22;
    const healthRatio = this.entities.hp[candidate]! / Math.max(1, this.entities.maxHp[candidate]!);
    score += healthRatio * rangeSquared * 0.12;
    if (this.entities.archetype[candidate] === ArchetypeCode.Commander) score -= rangeSquared * 0.18;
    return score;
  }

  private canPursue(index: number, target: number, definition: UnitDefinition): boolean {
    const route = this.routePaths[this.entities.routeIndex[index]!];
    if (!route) return false;
    const anchorSample = sampleRoutePath(route, this.entities.routeDistance[index]!);
    const anchorLaneOffset = this.clampedLaneOffset(index, anchorSample.laneWidth);
    const anchorX = anchorSample.position.x + Math.cos(anchorSample.yaw) * anchorLaneOffset;
    const anchorZ = anchorSample.position.z - Math.sin(anchorSample.yaw) * anchorLaneOffset;
    const distanceFromAnchor = Math.hypot(this.entities.x[index]! - anchorX, this.entities.z[index]! - anchorZ);
    const targetFromAnchor = Math.hypot(this.entities.x[target]! - anchorX, this.entities.z[target]! - anchorZ);
    const leash = this.entities.archetype[index] === ArchetypeCode.Giant ? 6.25 : 4.75;
    const targetNearest = nearestOnRoutePath(
      route,
      { x: this.entities.x[target]!, z: this.entities.z[target]! },
      Math.max(0, this.entities.routeDistance[index]! - leash),
      Math.min(route.length, this.entities.routeDistance[index]! + definition.aggroRange + leash),
    );
    const targetRadius = this.definitionAt(target).radius;
    const maximumReach = laneCenterClearance(targetNearest.laneWidth, definition.radius)
      + definition.attackRange + targetRadius;
    if (targetNearest.lateralDistance > maximumReach) return false;
    return distanceFromAnchor <= leash && targetFromAnchor <= definition.aggroRange + leash;
  }

  private clampedLaneOffset(index: number, laneWidth: number): number {
    const clearance = laneCenterClearance(laneWidth, this.definitionAt(index).radius);
    const offset = Math.max(-clearance, Math.min(clearance, this.entities.laneOffset[index]!));
    this.entities.laneOffset[index] = offset;
    return offset;
  }

  private constrainUnitToRoute(index: number, desiredX: number, desiredZ: number): Vec2 {
    if (this.entities.kind[index] !== EntityKindCode.Unit) return { x: desiredX, z: desiredZ };
    const route = this.routePaths[this.entities.routeIndex[index]!];
    if (!route) return { x: desiredX, z: desiredZ };
    const routeDistance = this.entities.routeDistance[index]!;
    const nearest = nearestOnRoutePath(
      route,
      { x: desiredX, z: desiredZ },
      Math.max(0, routeDistance - 7),
      Math.min(route.length, routeDistance + 8.5),
    );
    const clearance = laneCenterClearance(nearest.laneWidth, this.definitionAt(index).radius);
    const normalX = Math.cos(nearest.yaw);
    const normalZ = -Math.sin(nearest.yaw);
    const signedLateral = (desiredX - nearest.position.x) * normalX + (desiredZ - nearest.position.z) * normalZ;
    const clampedLateral = Math.max(-clearance, Math.min(clearance, signedLateral));
    if (nearest.routeDistance > routeDistance) {
      this.entities.routeDistance[index] = Math.min(route.length, nearest.routeDistance);
    }
    return {
      x: nearest.position.x + normalX * clampedLateral,
      z: nearest.position.z + normalZ * clampedLateral,
    };
  }

  private moveEntityToward(
    index: number,
    targetX: number,
    targetZ: number,
    maximumStep: number,
    spatial: Map<string, number[]>,
    separationWeight: number,
  ): void {
    const dx = targetX - this.entities.x[index]!;
    const dz = targetZ - this.entities.z[index]!;
    const distance = Math.hypot(dx, dz);
    if (distance <= 0.0001) return;
    const directionX = dx / distance;
    const directionZ = dz / distance;
    const separation = this.separationVector(index, spatial);
    let moveX = directionX + separation.x * separationWeight;
    let moveZ = directionZ + separation.z * separationWeight;
    const forwardDot = moveX * directionX + moveZ * directionZ;
    if (forwardDot < 0.28) { moveX = directionX; moveZ = directionZ; }
    const moveLength = Math.hypot(moveX, moveZ) || 1;
    const step = Math.min(maximumStep, distance);
    const startX = this.entities.x[index]!;
    const startZ = this.entities.z[index]!;
    const constrained = this.constrainUnitToRoute(
      index,
      startX + moveX / moveLength * step,
      startZ + moveZ / moveLength * step,
    );
    const actualX = constrained.x - startX;
    const actualZ = constrained.z - startZ;
    this.entities.x[index] = constrained.x;
    this.entities.z[index] = constrained.z;
    if (Math.hypot(actualX, actualZ) > 0.0001) this.entities.yaw[index] = Math.atan2(actualX, actualZ);
  }

  private separationVector(index: number, spatial: Map<string, number[]>): Vec2 {
    if (this.entities.kind[index] !== EntityKindCode.Unit) return { x: 0, z: 0 };
    const ownerTeam = teamForPlayer(this.entities.owner[index] as PlayerId);
    const definition = this.definitionAt(index);
    const searchRange = definition.radius + 2.1;
    let pushX = 0;
    let pushZ = 0;
    for (const candidate of this.indicesNear(this.entities.x[index]!, this.entities.z[index]!, searchRange, spatial)) {
      if (
        candidate === index
        || this.entities.kind[candidate] !== EntityKindCode.Unit
        || this.entities.state[candidate] === EntityStateCode.Death
        || teamForPlayer(this.entities.owner[candidate] as PlayerId) !== ownerTeam
      ) continue;
      let dx = this.entities.x[index]! - this.entities.x[candidate]!;
      let dz = this.entities.z[index]! - this.entities.z[candidate]!;
      let distance = Math.hypot(dx, dz);
      const minimum = (definition.radius + this.definitionAt(candidate).radius) * 0.92;
      if (distance >= minimum) continue;
      if (distance < 0.0001) {
        const direction = this.entities.id[index]! < this.entities.id[candidate]! ? -1 : 1;
        dx = direction;
        dz = ((this.entities.id[index]! + this.entities.id[candidate]!) & 1) === 0 ? direction : -direction;
        distance = Math.SQRT2;
      }
      const strength = (minimum - distance) / Math.max(0.1, minimum);
      pushX += dx / distance * strength;
      pushZ += dz / distance * strength;
    }
    const length = Math.hypot(pushX, pushZ);
    const result = length > 1 ? { x: pushX / length, z: pushZ / length } : { x: pushX, z: pushZ };
    const route = this.routePaths[this.entities.routeIndex[index]!];
    if (!route || (result.x === 0 && result.z === 0)) return result;
    const routeDistance = this.entities.routeDistance[index]!;
    const nearest = nearestOnRoutePath(
      route,
      { x: this.entities.x[index]!, z: this.entities.z[index]! },
      Math.max(0, routeDistance - 4),
      Math.min(route.length, routeDistance + 4),
    );
    const clearance = laneCenterClearance(nearest.laneWidth, definition.radius);
    const normalX = Math.cos(nearest.yaw);
    const normalZ = -Math.sin(nearest.yaw);
    const signedLateral = (this.entities.x[index]! - nearest.position.x) * normalX
      + (this.entities.z[index]! - nearest.position.z) * normalZ;
    const side = Math.sign(signedLateral);
    if (side === 0) return result;
    const outward = (result.x * normalX + result.z * normalZ) * side;
    if (outward <= 0) return result;
    const remaining = Math.max(0, clearance - Math.abs(signedLateral));
    const outwardScale = Math.min(1, remaining / 0.55);
    const removed = outward * (1 - outwardScale) * side;
    return { x: result.x - normalX * removed, z: result.z - normalZ * removed };
  }
  private damageEntity(index: number, amount: number, sourceId: number): void {
    if (this.entities.active[index] === 0 || this.entities.state[index] === EntityStateCode.Death) return;
    this.entities.hp[index] = Math.max(0, this.entities.hp[index]! - amount);
    this.events.push({ type: 'damage', tick: this.tick, sourceId, targetType: 'entity', targetId: this.entities.id[index]!, amount });
    if (this.entities.hp[index] === 0) this.killEntity(index); else this.setEntityState(index, EntityStateCode.Hit);
  }

  private killEntity(index: number): void {
    if (this.entities.state[index] === EntityStateCode.Death) return;
    this.entities.hp[index] = 0;
    this.setEntityState(index, EntityStateCode.Death);
    this.events.push({ type: 'death', tick: this.tick, entityId: this.entities.id[index]!, playerId: this.entities.owner[index] as PlayerId });
    if (this.entities.archetype[index] === ArchetypeCode.Commander) {
      const owner = this.entities.owner[index] as PlayerId;
      const player = this.players[owner];
      if (player) player.cooldowns.commander = CARDS_BY_ID.commander.cooldownTicks;
    }
  }

  private setEntityState(index: number, state: EntityStateCode): void {
    if (this.entities.state[index] === state) return;
    this.entities.state[index] = state;
    this.entities.stateTick[index] = 0;
  }

  private isEnemyPlayer(left: PlayerId, right: PlayerId): boolean {
    return teamForPlayer(left) !== teamForPlayer(right);
  }

  private isLivingEnemy(index: number, playerId: PlayerId): boolean {
    return this.entities.active[index] !== 0 && this.isEnemyPlayer(playerId, this.entities.owner[index] as PlayerId) && this.entities.state[index] !== EntityStateCode.Death;
  }

  private activeEnemyIndices(playerId: PlayerId): number[] {
    const result: number[] = [];
    for (let index = 0; index < this.entities.capacity; index += 1) if (this.isLivingEnemy(index, playerId)) result.push(index);
    return result;
  }

  private hasActiveCommander(playerId: PlayerId): boolean {
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] && this.entities.owner[index] === playerId && this.entities.archetype[index] === ArchetypeCode.Commander && this.entities.state[index] !== EntityStateCode.Death) return true;
    }
    return false;
  }

  /** Deterministic route harness used by movement regression and performance tests. */
  spawnDebugRouteGroup(routeId: string, count = 4): number {
    const routeIndex = this.routeById.get(routeId) ?? -1;
    const route = this.routePaths[routeIndex];
    if (!route) return 0;
    const definition = ARCHETYPES_BY_ID.guard;
    const limit = Math.min(Math.max(0, Math.floor(count)), this.maxEntities - this.entities.count);
    let spawned = 0;
    for (let member = 0; member < limit; member += 1) {
      const distance = Math.min(route.length, member * 0.32);
      const sample = sampleRoutePath(route, distance);
      const requestedOffset = limit === 1 ? 0 : (member - (limit - 1) / 2) * 0.85;
      const clearance = laneCenterClearance(sample.laneWidth, definition.radius);
      const laneOffset = Math.max(-clearance, Math.min(clearance, requestedOffset));
      const id = this.entities.spawn({
        kind: EntityKindCode.Unit,
        archetype: ArchetypeCode.Guard,
        owner: route.playerId,
        x: sample.position.x + Math.cos(sample.yaw) * laneOffset,
        z: sample.position.z - Math.sin(sample.yaw) * laneOffset,
        yaw: sample.yaw,
        hp: definition.maxHp,
        routeIndex,
        routeDistance: distance,
        laneOffset,
        cardCost: 0,
      });
      if (id >= 0) spawned += 1;
    }
    return spawned;
  }

  spawnDebugCrowd(count: number): number {
    let spawned = 0;
    const limit = Math.min(count, this.maxEntities - this.entities.count);
    for (let index = 0; index < limit; index += 1) {
      const playerId = (index % 4) as PlayerId;
      const route = this.routePaths.filter((candidate) => candidate.playerId === playerId)[index % 5];
      if (!route) continue;
      const distance = (index * 1.73) % Math.max(1, route.length - 4);
      const sample = sampleRoutePath(route, distance);
      const code = ((index % 5) + 1) as ArchetypeCode;
      const definition = ARCHETYPES_BY_ID[archetypeIds[code]!];
      if (this.entities.spawn({ kind: EntityKindCode.Unit, archetype: code, owner: playerId, x: sample.position.x, z: sample.position.z, yaw: sample.yaw, hp: definition.maxHp, routeIndex: this.routeById.get(route.routeId) ?? -1, routeDistance: distance, laneOffset: (index % 3 - 1) * 0.7, cardCost: 0 }) >= 0) spawned += 1;
    }
    return spawned;
  }

  getSnapshot(): GameSnapshot {
    const count = this.entities.count;
    const id = new Uint32Array(count);
    const kind = new Uint8Array(count);
    const archetype = new Uint8Array(count);
    const owner = new Int8Array(count);
    const x = new Int16Array(count);
    const z = new Int16Array(count);
    const yaw = new Uint16Array(count);
    const hp = new Uint16Array(count);
    const maxHp = new Uint16Array(count);
    const state = new Uint8Array(count);
    const stateTick = new Uint16Array(count);
    const targetId = new Int32Array(count);
    let cursor = 0;
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0) continue;
      id[cursor] = this.entities.id[index]!;
      kind[cursor] = this.entities.kind[index]!;
      archetype[cursor] = this.entities.archetype[index]!;
      owner[cursor] = this.entities.owner[index]!;
      x[cursor] = Math.max(-32_768, Math.min(32_767, Math.round(this.entities.x[index]! * POSITION_SCALE)));
      z[cursor] = Math.max(-32_768, Math.min(32_767, Math.round(this.entities.z[index]! * POSITION_SCALE)));
      const normalizedYaw = ((this.entities.yaw[index]! % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      yaw[cursor] = Math.round(normalizedYaw / (Math.PI * 2) * YAW_SCALE);
      hp[cursor] = Math.max(0, Math.min(65_535, this.entities.hp[index]!));
      maxHp[cursor] = Math.max(1, Math.min(65_535, this.entities.maxHp[index]!));
      state[cursor] = this.entities.state[index]!;
      stateTick[cursor] = this.entities.stateTick[index]!;
      targetId[cursor] = this.entities.targetId[index]!;
      cursor += 1;
    }
    const players: PlayerSnapshot[] = this.players.map((player) => ({
      id: player.id,
      teamId: teamForPlayer(player.id),
      elixir: player.elixirMilli / 1_000,
      elixirMilli: player.elixirMilli,
      maxElixir: CONTENT.balance.maxElixir,
      alive: player.alive,
      castleHp: this.castles[player.id]?.hp ?? 0,
      castleMaxHp: this.castles[player.id]?.maxHp ?? CONTENT.balance.castleMaxHp,
      cooldowns: { ...player.cooldowns },
      lastSequence: player.lastSequence,
    }));
    const castles: CastleSnapshot[] = this.castles.map((castle) => ({ ...castle }));
    const center: CenterSnapshot = { ...this.center, requiredTicks: CONTENT.balance.centerCaptureTicks };
    const snapshot: GameSnapshot = {
      version: 1,
      tick: this.tick,
      timeMs: this.tick * 1_000 / TICK_RATE,
      phase: this.phase,
      winnerPlayerId: this.winnerPlayerId,
      draw: this.draw,
      stateHash: 0,
      players,
      castles,
      center,
      entities: { count, id, kind, archetype, owner, x, z, yaw, hp, maxHp, state, stateTick, targetId },
      events: [...this.events],
    };
    snapshot.stateHash = this.hashSnapshot(snapshot);
    return snapshot;
  }

  private hashSnapshot(snapshot: GameSnapshot): number {
    let hash = 0x811c9dc5;
    const add = (value: number) => { hash ^= value | 0; hash = Math.imul(hash, 0x01000193); };
    add(snapshot.tick);
    for (const castle of snapshot.castles) add(castle.hp);
    for (const player of snapshot.players) add(player.elixirMilli);
    for (let index = 0; index < snapshot.entities.count; index += 1) {
      add(snapshot.entities.id[index]!);
      add(snapshot.entities.x[index]!);
      add(snapshot.entities.z[index]!);
      add(snapshot.entities.hp[index]!);
    }
    return hash >>> 0;
  }
}

export function createGame(options: GameOptions = {}): GameSimulation {
  return new GameSimulation(options);
}
