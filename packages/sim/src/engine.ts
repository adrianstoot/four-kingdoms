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
  type SpellCardId,
} from './types';

const playerIds: readonly PlayerId[] = [0, 1, 2, 3];
const SPATIAL_CELL_SIZE = 8;
const BOT_DECISION_INTERVAL = 24;
const BOT_DEFENSE_RADIUS = 31;
const BOT_URGENT_THREAT_SCORE = 145;
const HIT_RECOVERY_TICKS = 4;
const TARGET_LOCK_RANGE_MULTIPLIER = 1.45;
const BODY_CLEARANCE = 0.1;
const GIANT_BLOCKER_MARGIN = 0.55;
const KNIGHT_CHARGE_MIN_TICKS = 20;
const KNIGHT_CHARGE_DAMAGE_BPS = 16_000;
const ARROW_SPEED_METERS_PER_SECOND = 24;
const MIN_ARROW_FLIGHT_TICKS = 3;
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

interface PendingSpell {
  castId: number;
  playerId: PlayerId;
  cardId: SpellCardId;
  origin: Vec2;
  destination: Vec2;
  impactTick: number;
}
interface PendingProjectile {
  projectileId: number;
  sourceId: number;
  targetType: 'entity' | 'castle';
  targetId: number;
  origin: Vec2;
  destination: Vec2;
  damage: number;
  impactTick: number;
}

interface EntityHitIntent {
  sourceId: number;
  targetId: number;
  damage: number;
}

interface CastleHitIntent {
  sourceId: number;
  targetId: PlayerId;
  damage: number;
}



type CombatDefinition = UnitDefinition | BuildingDefinition;

interface CombatApproach {
  worldDistance: number;
  effectiveRange: number;
  routeDistance: number;
  lateralDistance: number;
  ahead: boolean;
  reachable: boolean;
}

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

  snapshotState(): number {
    return this.state >>> 0;
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
  readonly motionPhase: Uint16Array;
  readonly targetId: Int32Array;
  readonly routeIndex: Int16Array;
  readonly routeDistance: Float32Array;
  readonly laneOffset: Float32Array;
  readonly attackCooldown: Int16Array;
  readonly chargeTicks: Uint16Array;
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
    this.motionPhase = new Uint16Array(capacity);
    this.targetId = new Int32Array(capacity);
    this.routeIndex = new Int16Array(capacity);
    this.routeDistance = new Float32Array(capacity);
    this.laneOffset = new Float32Array(capacity);
    this.attackCooldown = new Int16Array(capacity);
    this.chargeTicks = new Uint16Array(capacity);
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
    this.motionPhase[index] = 0;
    this.targetId[index] = -1;
    this.routeIndex[index] = values.routeIndex;
    this.routeDistance[index] = values.routeDistance;
    this.laneOffset[index] = values.laneOffset;
    this.attackCooldown[index] = 0;
    this.chargeTicks[index] = 0;
    this.lifetime[index] = values.lifetime ?? -1;
    this.cardCost[index] = values.cardCost;
    this.idToIndex.set(id, index);
    this.count += 1;
    return id;
  }

  indexForId(id: number): number {
    return this.idToIndex.get(id) ?? -1;
  }

  nextEntityId(): number {
    return this.nextId;
  }

  remove(index: number): void {
    if (index < 0 || this.active[index] === 0) return;
    this.idToIndex.delete(this.id[index]!);
    this.active[index] = 0;
    this.targetId[index] = -1;
    this.routeIndex[index] = -1;
    this.chargeTicks[index] = 0;
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
  private pendingSpells: PendingSpell[] = [];
  private pendingProjectiles: PendingProjectile[] = [];
  private nextCastId = 1;
  private nextProjectileId = 1;
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
    this.resolvePendingSpells();
    this.resolvePendingProjectiles();
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
        && (fireAim.hits >= 2 || (urgentDefense && fireAim.hits >= 1) || fireAim.score >= 300);
      const chainAim = this.findBestChainAim(playerId, spellCandidates, spatial);
      const chainWorthwhile = chainAim !== null
        && (chainAim.hits >= 2 || (urgentDefense && chainAim.hits >= 1) || chainAim.score >= 200);
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
    const routeDistance = route ? Math.min(route.length, pathDistance) : pathDistance;
    const sample = route ? sampleRoutePath(route, routeDistance) : null;
    const entityPosition = kind === EntityKindCode.Unit && sample ? sample.position : position;
    const id = this.entities.spawn({
      kind,
      archetype,
      owner: playerId,
      x: entityPosition.x,
      z: entityPosition.z,
      yaw: sample?.yaw ?? 0,
      hp: definition.maxHp,
      routeIndex,
      routeDistance,
      laneOffset: 0,
      lifetime: definition.kind === 'building' ? definition.lifetimeTicks : -1,
      cardCost: card.cost,
    });
    if (id >= 0) this.events.push({ type: 'spawn', tick: this.tick, entityId: id, playerId, archetype });
  }

  private castSpell(playerId: PlayerId, cardId: SpellCardId, destination: Vec2): void {
    const castle = this.castles[playerId];
    const origin = { x: castle?.x ?? destination.x, z: castle?.z ?? destination.z };
    const distance = Math.hypot(destination.x - origin.x, destination.z - origin.z);
    const travelTicks = cardId === 'fireball'
      ? Math.max(9, Math.min(24, Math.round(9 + distance * 0.125)))
      : 12;
    const pending: PendingSpell = {
      castId: this.nextCastId++,
      playerId,
      cardId,
      origin,
      destination: { ...destination },
      impactTick: this.tick + travelTicks,
    };
    this.pendingSpells.push(pending);
    this.events.push({
      type: 'spell-cast',
      tick: this.tick,
      castId: pending.castId,
      playerId,
      cardId,
      origin: pending.origin,
      destination: pending.destination,
      impactTick: pending.impactTick,
    });
  }

  private resolvePendingSpells(): void {
    const due = this.pendingSpells
      .filter((pending) => pending.impactTick <= this.tick)
      .sort((left, right) => left.impactTick - right.impactTick || left.castId - right.castId);
    if (due.length === 0) return;
    const dueIds = new Set(due.map((pending) => pending.castId));
    this.pendingSpells = this.pendingSpells.filter((pending) => !dueIds.has(pending.castId));
    for (const pending of due) this.resolveSpellImpact(pending);
  }

  private resolveSpellImpact(pending: PendingSpell): void {
    const card = CARDS_BY_ID[pending.cardId];
    if (card.kind !== 'spell') return;
    const targets: number[] = [];
    if (card.spell === 'area') {
      for (let index = 0; index < this.entities.capacity; index += 1) {
        if (!this.isLivingEnemy(index, pending.playerId)) continue;
        if (Math.hypot(this.entities.x[index]! - pending.destination.x, this.entities.z[index]! - pending.destination.z) <= card.radius) {
          targets.push(this.entities.id[index]!);
          this.damageEntity(index, card.damage, 0);
        }
      }
    } else {
      let cursor = pending.destination;
      let damage = card.damage;
      const used = new Set<number>();
      for (let jump = 0; jump < card.maxTargets; jump += 1) {
        let best = -1;
        let bestDistance = jump === 0 ? card.radius : card.chainRange;
        for (let index = 0; index < this.entities.capacity; index += 1) {
          if (!this.isLivingEnemy(index, pending.playerId) || used.has(index)) continue;
          const distance = Math.hypot(this.entities.x[index]! - cursor.x, this.entities.z[index]! - cursor.z);
          const bestId = best >= 0 ? this.entities.id[best]! : Number.POSITIVE_INFINITY;
          if (distance < bestDistance || (Math.abs(distance - bestDistance) < 1e-6 && this.entities.id[index]! < bestId)) {
            best = index;
            bestDistance = distance;
          }
        }
        if (best < 0) break;
        used.add(best);
        targets.push(this.entities.id[best]!);
        cursor = { x: this.entities.x[best]!, z: this.entities.z[best]! };
        this.damageEntity(best, damage, 0);
        damage = Math.max(1, Math.round(damage * card.falloffBps / 10_000));
      }
    }
    this.events.push({
      type: 'spell-impact',
      tick: this.tick,
      castId: pending.castId,
      playerId: pending.playerId,
      cardId: pending.cardId,
      origin: pending.origin,
      destination: pending.destination,
      impactTick: pending.impactTick,
      targetIds: targets,
    });
  }

  private updateEntities(): void {
    const spatial = this.buildSpatialHash();
    const entityHitIntents: EntityHitIntent[] = [];
    const castleHitIntents: CastleHitIntent[] = [];
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] === 0) continue;
      this.entities.stateTick[index] = Math.min(65_535, this.entities.stateTick[index]! + 1);
      if (this.entities.state[index] === EntityStateCode.Death) {
        this.updateMotionPhase(index, 14);
        if (this.entities.stateTick[index]! >= 14) this.entities.remove(index);
        continue;
      }

      const definition = this.definitionAt(index);
      if (this.entities.state[index] === EntityStateCode.Spawn) {
        this.updateMotionPhase(index, 8);
        if (this.entities.stateTick[index]! <= 8) continue;
        this.setEntityState(index, EntityStateCode.Idle);
      }
      if (this.entities.state[index] !== EntityStateCode.Walk) {
        const cycleTicks = this.entities.state[index] === EntityStateCode.Attack
          ? definition.attackCooldownTicks
          : this.entities.state[index] === EntityStateCode.Hit ? 8 : 40;
        this.updateMotionPhase(index, cycleTicks);
      }
      if (this.entities.attackCooldown[index]! > 0) this.entities.attackCooldown[index] = this.entities.attackCooldown[index]! - 1;
      if (this.entities.lifetime[index]! > 0) {
        this.entities.lifetime[index] = this.entities.lifetime[index]! - 1;
        if (this.entities.lifetime[index] === 0) { this.killEntity(index); continue; }
      }

      if (this.entities.state[index] === EntityStateCode.Hit && this.entities.stateTick[index]! <= HIT_RECOVERY_TICKS) {
        this.updateMotionPhase(index, HIT_RECOVERY_TICKS);
        continue;
      }

      const owner = this.entities.owner[index] as PlayerId;
      const target = this.findCombatTarget(index, definition, spatial);
      if (target >= 0) {
        const dx = this.entities.x[target]! - this.entities.x[index]!;
        const dz = this.entities.z[target]! - this.entities.z[index]!;
        const distance = Math.hypot(dx, dz);
        const targetDefinition = this.definitionAt(target);
        const approach = this.combatApproach(index, target, definition);
        const targetId = this.entities.id[target]!;
        if (this.entities.targetId[index] !== targetId && this.entities.state[index] === EntityStateCode.Attack) {
          this.setEntityState(index, EntityStateCode.Idle);
        }
        this.entities.targetId[index] = targetId;
        if (distance <= approach.effectiveRange + 1e-6) {
          this.setEntityState(index, EntityStateCode.Attack);
          this.entities.yaw[index] = Math.atan2(dx, dz);
          if (
            this.entities.attackCooldown[index]! <= 0
            && this.entities.stateTick[index]! >= definition.attackAnticipationTicks
          ) {
            const damage = this.attackDamage(index, target, definition);
            if (this.entities.archetype[index] === ArchetypeCode.Archer) {
              this.launchProjectile(index, 'entity', targetId, damage, {
                x: this.entities.x[target]!,
                z: this.entities.z[target]!,
              });
            } else {
              entityHitIntents.push({
                sourceId: this.entities.id[index]!,
                targetId,
                damage,
              });
            }
            this.entities.attackCooldown[index] = definition.attackCooldownTicks;
            this.entities.stateTick[index] = 0;
          }
          continue;
        }
        if (definition.kind === 'unit' && approach.reachable && approach.ahead) {
          const route = this.routePaths[this.entities.routeIndex[index]!];
          if (route) {
            const currentDistance = this.entities.routeDistance[index]!;
            const preferredDistance = this.preferredCombatDistance(definition, targetDefinition);
            const longitudinalClearance = Math.sqrt(Math.max(
              0,
              preferredDistance * preferredDistance - approach.lateralDistance * approach.lateralDistance,
            ));
            const stopDistance = Math.max(currentDistance, approach.routeDistance - longitudinalClearance);
            if (stopDistance > currentDistance + 0.001) {
              this.setEntityState(index, EntityStateCode.Walk);
              this.advanceUnitOnRoute(
                index,
                Math.min(stopDistance, currentDistance + definition.moveSpeed / TICK_RATE),
                spatial,
              );
              continue;
            }
            // A crossing opponent can be laterally outside melee range for a
            // few ticks. Hold the exact centerline interception point instead
            // of walking through it or stepping onto the grass.
            this.setEntityState(index, EntityStateCode.Idle);
            continue;
          }
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
      const currentDistance = this.entities.routeDistance[index]!;
      const atCenter = route.kind === 'center' && Math.abs(currentDistance - route.centerDistance) < 0.35;
      const teamControlsCenter = this.center.ownerPlayerId !== null && !this.isEnemyPlayer(owner, this.center.ownerPlayerId);
      if (atCenter && !teamControlsCenter) {
        this.setEntityState(index, EntityStateCode.Idle);
        continue;
      }

      const castleAttackDistance = Math.max(0, route.length - definition.attackRange - 2.4);
      if (currentDistance >= castleAttackDistance) {
        const castle = this.castles[route.destinationPlayerId];
        if (castle?.alive && this.isEnemyPlayer(owner, castle.playerId)) {
          this.setEntityState(index, EntityStateCode.Attack);
          this.entities.yaw[index] = Math.atan2(castle.x - this.entities.x[index]!, castle.z - this.entities.z[index]!);
          if (
            this.entities.attackCooldown[index]! <= 0
            && this.entities.stateTick[index]! >= definition.attackAnticipationTicks
          ) {
            const multiplier = this.tick >= CONTENT.balance.doubleElixirTick ? 1.5 : 1;
            const damage = Math.round(this.attackDamage(index, -1, definition) * multiplier);
            if (this.entities.archetype[index] === ArchetypeCode.Archer) {
              this.launchProjectile(index, 'castle', castle.playerId, damage, { x: castle.x, z: castle.z });
            } else {
              castleHitIntents.push({
                sourceId: this.entities.id[index]!,
                targetId: castle.playerId,
                damage,
              });
            }
            this.entities.attackCooldown[index] = definition.attackCooldownTicks;
            this.entities.stateTick[index] = 0;
          }
        } else {
          this.retargetAtNode(index, route.destinationPlayerId);
        }
        continue;
      }

      this.setEntityState(index, EntityStateCode.Walk);
      this.advanceUnitOnRoute(index, Math.min(route.length, currentDistance + definition.moveSpeed / TICK_RATE), spatial);
    }
    this.resolvePreparedHits(entityHitIntents, castleHitIntents);
  }

  /**
   * Non-projectile attacks are prepared from one immutable combat frame and
   * committed only after every entity has made its decision. This lets two
   * ready combatants exchange lethal blows on the same tick regardless of
   * their pool slot or spawn order.
   */
  private resolvePreparedHits(
    entityIntents: EntityHitIntent[],
    castleIntents: CastleHitIntent[],
  ): void {
    const livingAtCommitStart = new Set<number>();
    for (let index = 0; index < this.entities.capacity; index += 1) {
      if (this.entities.active[index] && this.entities.state[index] !== EntityStateCode.Death) {
        livingAtCommitStart.add(this.entities.id[index]!);
      }
    }

    const validEntityIntents = entityIntents
      .filter((intent) => livingAtCommitStart.has(intent.targetId))
      .sort((left, right) => left.targetId - right.targetId || left.sourceId - right.sourceId);
    for (let cursor = 0; cursor < validEntityIntents.length;) {
      const targetId = validEntityIntents[cursor]!.targetId;
      let end = cursor + 1;
      while (end < validEntityIntents.length && validEntityIntents[end]!.targetId === targetId) end += 1;
      const target = this.entities.indexForId(targetId);
      if (target >= 0 && livingAtCommitStart.has(targetId)) {
        let totalDamage = 0;
        for (let intentIndex = cursor; intentIndex < end; intentIndex += 1) {
          const intent = validEntityIntents[intentIndex]!;
          totalDamage += intent.damage;
          this.events.push({
            type: 'damage',
            tick: this.tick,
            sourceId: intent.sourceId,
            targetType: 'entity',
            targetId,
            amount: intent.damage,
          });
          this.consumeChargeOnImpact(intent.sourceId);
        }
        this.entities.hp[target] = Math.max(0, this.entities.hp[target]! - totalDamage);
        if (this.entities.hp[target] === 0) {
          this.killEntity(target);
        } else {
          this.setEntityState(target, EntityStateCode.Hit);
          this.retargetAfterPreparedDamage(
            target,
            validEntityIntents.slice(cursor, end).map((intent) => intent.sourceId),
          );
        }
      }
      cursor = end;
    }

    const validCastleIntents = castleIntents
      .filter((intent) => {
        const castle = this.castles[intent.targetId];
        return castle?.alive === true && castle.hp > 0;
      })
      .sort((left, right) => left.targetId - right.targetId || left.sourceId - right.sourceId);
    for (let cursor = 0; cursor < validCastleIntents.length;) {
      const targetId = validCastleIntents[cursor]!.targetId;
      let end = cursor + 1;
      while (end < validCastleIntents.length && validCastleIntents[end]!.targetId === targetId) end += 1;
      const castle = this.castles[targetId];
      if (castle?.alive && castle.hp > 0) {
        let totalDamage = 0;
        for (let intentIndex = cursor; intentIndex < end; intentIndex += 1) {
          const intent = validCastleIntents[intentIndex]!;
          totalDamage += intent.damage;
          this.events.push({
            type: 'damage',
            tick: this.tick,
            sourceId: intent.sourceId,
            targetType: 'castle',
            targetId,
            amount: intent.damage,
          });
          this.consumeChargeOnImpact(intent.sourceId);
        }
        castle.hp = Math.max(0, castle.hp - totalDamage);
      }
      cursor = end;
    }
  }

  private consumeChargeOnImpact(sourceId: number): void {
    const source = this.entities.indexForId(sourceId);
    if (source >= 0 && this.entities.archetype[source] === ArchetypeCode.Knight) {
      this.entities.chargeTicks[source] = 0;
    }
  }

  private retargetAfterPreparedDamage(index: number, sourceIds: number[]): void {
    const candidates = sourceIds
      .map((sourceId) => this.entities.indexForId(sourceId))
      .filter((source) => source >= 0 && this.isEnemyPlayer(
        this.entities.owner[index] as PlayerId,
        this.entities.owner[source] as PlayerId,
      ))
      .sort((left, right) => {
        const leftDistance = (this.entities.x[left]! - this.entities.x[index]!) ** 2
          + (this.entities.z[left]! - this.entities.z[index]!) ** 2;
        const rightDistance = (this.entities.x[right]! - this.entities.x[index]!) ** 2
          + (this.entities.z[right]! - this.entities.z[index]!) ** 2;
        return leftDistance - rightDistance
          || this.entities.owner[left]! - this.entities.owner[right]!
          || this.entities.archetype[left]! - this.entities.archetype[right]!
          || this.entities.routeIndex[left]! - this.entities.routeIndex[right]!
          || this.entities.routeDistance[left]! - this.entities.routeDistance[right]!
          || this.entities.id[left]! - this.entities.id[right]!;
      });
    const source = candidates[0];
    if (source === undefined) return;
    const current = this.entities.indexForId(this.entities.targetId[index]!);
    const definition = this.definitionAt(index);
    const currentIsPriorityBuilding = current >= 0
      && this.entities.kind[current] === EntityKindCode.Building
      && this.entities.state[current] !== EntityStateCode.Death;
    if (definition.targetPriority !== 'buildings' || !currentIsPriorityBuilding) {
      this.entities.targetId[index] = this.entities.id[source]!;
    }
  }
  private updateMotionPhase(index: number, cycleTicks: number): void {
    const cycle = Math.max(1, cycleTicks);
    this.entities.motionPhase[index] = Math.round((this.entities.stateTick[index]! % cycle) / cycle * 65_535);
  }

  private advanceUnitOnRoute(index: number, requestedDistance: number, spatial: Map<string, number[]>): void {
    const routeIndex = this.entities.routeIndex[index]!;
    const route = this.routePaths[routeIndex];
    if (!route) return;
    const currentDistance = this.entities.routeDistance[index]!;
    let nextDistance = Math.max(currentDistance, Math.min(route.length, requestedDistance));
    const definition = this.definitionAt(index);
    const nearby = this.indicesNear(this.entities.x[index]!, this.entities.z[index]!, 4.5, spatial);
    for (const candidate of nearby) {
      if (
        candidate === index
        || this.entities.kind[candidate] !== EntityKindCode.Unit
        || this.entities.state[candidate] === EntityStateCode.Death
      ) continue;
      const sameTeam = teamForPlayer(this.entities.owner[candidate] as PlayerId)
        === teamForPlayer(this.entities.owner[index] as PlayerId);
      const gap = definition.physicalRadius + this.definitionAt(candidate).physicalRadius + BODY_CLEARANCE;
      if (sameTeam) {
        if (this.entities.routeIndex[candidate] !== routeIndex) continue;
        const candidateDistance = this.entities.routeDistance[candidate]!;
        const candidateIsAhead = candidateDistance > currentDistance + 0.001
          || (Math.abs(candidateDistance - currentDistance) <= 0.001 && this.entities.id[candidate]! < this.entities.id[index]!);
        if (candidateIsAhead) nextDistance = Math.min(nextDistance, candidateDistance - gap);
        continue;
      }

      // Opponents using reverse or crossing routes do not share routeIndex.
      // Project them onto this unit's own centerline and reserve enough
      // longitudinal room that their physical bodies can never pass through.
      const crossing = nearestOnRoutePath(
        route,
        { x: this.entities.x[candidate]!, z: this.entities.z[candidate]! },
        currentDistance,
        Math.min(route.length, currentDistance + 4.5),
      );
      if (crossing.routeDistance <= currentDistance + 0.001 || crossing.lateralDistance >= gap) continue;
      const clearance = Math.sqrt(Math.max(0, gap * gap - crossing.lateralDistance * crossing.lateralDistance));
      nextDistance = Math.min(nextDistance, crossing.routeDistance - clearance);
    }
    nextDistance = Math.max(currentDistance, nextDistance);
    const travelled = nextDistance - currentDistance;
    const sample = sampleRoutePath(route, nextDistance);
    this.entities.routeDistance[index] = nextDistance;
    this.entities.laneOffset[index] = 0;
    this.entities.x[index] = sample.position.x;
    this.entities.z[index] = sample.position.z;
    this.entities.yaw[index] = sample.yaw;
    if (travelled > 0) {
      if (this.entities.archetype[index] === ArchetypeCode.Knight) {
        this.entities.chargeTicks[index] = Math.min(65_535, this.entities.chargeTicks[index]! + 1);
      }
      const stride = Math.max(0.45, definition.height * 0.55);
      const phaseDelta = Math.round(travelled / stride * 65_535);
      this.entities.motionPhase[index] = (this.entities.motionPhase[index]! + phaseDelta) & 0xffff;
    }
  }
  private retargetAtNode(index: number, nodePlayerId: PlayerId): void {
    const owner = this.entities.owner[index] as PlayerId;
    const alternatives = this.routePaths.filter((route) => route.playerId === nodePlayerId && this.castles[route.destinationPlayerId]?.alive && this.isEnemyPlayer(owner, route.destinationPlayerId));
    if (alternatives.length === 0) { this.killEntity(index); return; }
    const route = alternatives.sort((left, right) => left.destinationPlayerId - right.destinationPlayerId)[0]!;
    this.entities.routeIndex[index] = this.routeById.get(route.routeId) ?? -1;
    this.entities.routeDistance[index] = 0;
    this.entities.laneOffset[index] = 0;
    const sample = sampleRoutePath(route, 0);
    this.entities.x[index] = sample.position.x;
    this.entities.z[index] = sample.position.z;
    this.entities.yaw[index] = sample.yaw;
    this.setEntityState(index, EntityStateCode.Walk);
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

  private combatApproach(index: number, candidate: number, definition: CombatDefinition): CombatApproach {
    const dx = this.entities.x[candidate]! - this.entities.x[index]!;
    const dz = this.entities.z[candidate]! - this.entities.z[index]!;
    const worldDistance = Math.hypot(dx, dz);
    const targetDefinition = this.definitionAt(candidate);
    const effectiveRange = definition.attackRange + targetDefinition.physicalRadius;
    if (definition.kind === 'building') {
      return {
        worldDistance,
        effectiveRange,
        routeDistance: 0,
        lateralDistance: 0,
        ahead: true,
        reachable: worldDistance <= definition.aggroRange * TARGET_LOCK_RANGE_MULTIPLIER,
      };
    }

    const route = this.routePaths[this.entities.routeIndex[index]!];
    if (!route) {
      return { worldDistance, effectiveRange, routeDistance: 0, lateralDistance: worldDistance, ahead: false, reachable: false };
    }
    const currentDistance = this.entities.routeDistance[index]!;
    const projection = nearestOnRoutePath(
      route,
      { x: this.entities.x[candidate]!, z: this.entities.z[candidate]! },
      Math.max(0, currentDistance - effectiveRange),
      Math.min(route.length, currentDistance + definition.aggroRange + effectiveRange),
    );
    const ahead = projection.routeDistance >= currentDistance - 0.04;
    // A target is lane-reachable only if some point on this exact centerline
    // can enter real attack range. A visual corridor margin here creates a
    // permanent stop just outside range at perpendicular crossings.
    const reachable = worldDistance <= effectiveRange + 1e-6
      || (ahead && projection.lateralDistance <= effectiveRange + 1e-6);
    return {
      worldDistance,
      effectiveRange,
      routeDistance: projection.routeDistance,
      lateralDistance: projection.lateralDistance,
      ahead,
      reachable,
    };
  }

  private canAcquireTarget(index: number, candidate: number, definition: CombatDefinition): boolean {
    const approach = this.combatApproach(index, candidate, definition);
    if (!approach.reachable) return false;
    if (definition.targetPriority !== 'buildings' || this.entities.kind[candidate] === EntityKindCode.Building) return true;

    // Giants stay focused on structures. They only stop for infantry that is
    // physically blocking the centerline or actively attacking them.
    return approach.worldDistance <= approach.effectiveRange + GIANT_BLOCKER_MARGIN
      || this.entities.targetId[candidate] === this.entities.id[index]
      || this.entities.targetId[index] === this.entities.id[candidate];
  }

  private findCombatTarget(index: number, definition: CombatDefinition, spatial: Map<string, number[]>): number {
    const owner = this.entities.owner[index] as PlayerId;
    const x = this.entities.x[index]!;
    const z = this.entities.z[index]!;
    const locked = this.entities.indexForId(this.entities.targetId[index]!);
    const lockRange = definition.aggroRange * TARGET_LOCK_RANGE_MULTIPLIER;
    const lockIsValid = locked >= 0
      && this.isLivingEnemy(locked, owner)
      && (this.entities.x[locked]! - x) ** 2 + (this.entities.z[locked]! - z) ** 2 <= lockRange * lockRange
      && this.canAcquireTarget(index, locked, definition);

    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestId = Number.POSITIVE_INFINITY;
    for (const candidate of this.indicesNear(x, z, definition.aggroRange, spatial)) {
      if (
        candidate === index
        || !this.isLivingEnemy(candidate, owner)
        || !this.canAcquireTarget(index, candidate, definition)
      ) continue;
      const score = this.combatTargetScore(index, candidate, definition);
      const id = this.entities.id[candidate]!;
      if (score < bestScore || (score === bestScore && id < bestId)) {
        best = candidate;
        bestScore = score;
        bestId = id;
      }
    }

    let selected = best;
    if (lockIsValid) {
      selected = locked;
      if (
        definition.targetPriority === 'buildings'
        && best >= 0
        && this.entities.kind[best] === EntityKindCode.Building
        && this.entities.kind[locked] !== EntityKindCode.Building
      ) selected = best;
    }
    if (selected < 0) return -1;

    // Target locks are never allowed to pull a unit through another enemy's
    // body. Retarget the first physical obstruction along the attacker's own
    // route, then resume the original tactical target once it is cleared.
    const blocker = this.findFirstLongitudinalBlocker(index, selected, definition, spatial);
    return blocker >= 0 ? blocker : selected;
  }

  private findFirstLongitudinalBlocker(
    index: number,
    selected: number,
    definition: CombatDefinition,
    spatial: Map<string, number[]>,
  ): number {
    if (definition.kind !== 'unit') return -1;
    const selectedApproach = this.combatApproach(index, selected, definition);
    if (selectedApproach.worldDistance <= selectedApproach.effectiveRange + 1e-6) return -1;
    if (!selectedApproach.ahead) return -1;
    const currentDistance = this.entities.routeDistance[index]!;
    const owner = this.entities.owner[index] as PlayerId;
    let blocker = -1;
    let blockerRouteDistance = Number.POSITIVE_INFINITY;
    let blockerLateralDistance = Number.POSITIVE_INFINITY;
    let blockerId = Number.POSITIVE_INFINITY;
    for (const candidate of this.indicesNear(
      this.entities.x[index]!,
      this.entities.z[index]!,
      definition.aggroRange,
      spatial,
    )) {
      if (
        candidate === index
        || candidate === selected
        || !this.isLivingEnemy(candidate, owner)
        || this.entities.kind[candidate] !== EntityKindCode.Unit
      ) continue;
      const approach = this.combatApproach(index, candidate, definition);
      const physicalCorridor = definition.physicalRadius
        + this.definitionAt(candidate).physicalRadius
        + BODY_CLEARANCE;
      if (
        !approach.ahead
        || approach.routeDistance <= currentDistance + 0.001
        || approach.routeDistance >= selectedApproach.routeDistance - 0.001
        || approach.lateralDistance >= physicalCorridor
      ) continue;
      const id = this.entities.id[candidate]!;
      if (
        approach.routeDistance < blockerRouteDistance
        || (approach.routeDistance === blockerRouteDistance && approach.lateralDistance < blockerLateralDistance)
        || (
          approach.routeDistance === blockerRouteDistance
          && approach.lateralDistance === blockerLateralDistance
          && id < blockerId
        )
      ) {
        blocker = candidate;
        blockerRouteDistance = approach.routeDistance;
        blockerLateralDistance = approach.lateralDistance;
        blockerId = id;
      }
    }
    return blocker;
  }
  private combatTargetScore(index: number, candidate: number, definition: CombatDefinition): number {
    const approach = this.combatApproach(index, candidate, definition);
    const distanceSquared = approach.worldDistance * approach.worldDistance;
    const rangeSquared = definition.aggroRange * definition.aggroRange;
    let score = distanceSquared;
    if (definition.targetPriority === 'buildings') {
      score += this.entities.kind[candidate] === EntityKindCode.Building ? -rangeSquared * 4 : rangeSquared * 1.5;
    }
    if (this.entities.targetId[candidate] === this.entities.id[index]) score -= rangeSquared * 0.22;
    score += approach.lateralDistance * approach.lateralDistance * 0.35;
    const healthRatio = this.entities.hp[candidate]! / Math.max(1, this.entities.maxHp[candidate]!);
    score += healthRatio * rangeSquared * 0.12;
    if (this.entities.archetype[candidate] === ArchetypeCode.Commander) score -= rangeSquared * 0.18;
    return score;
  }

  private preferredCombatDistance(definition: UnitDefinition, targetDefinition: CombatDefinition): number {
    const effectiveRange = definition.attackRange + targetDefinition.physicalRadius;
    if (definition.id === 'archer') return effectiveRange * 0.82;
    return Math.max(
      definition.physicalRadius + targetDefinition.physicalRadius + BODY_CLEARANCE,
      effectiveRange * 0.74,
    );
  }

  private attackDamage(index: number, target: number, definition: CombatDefinition): number {
    if (
      this.entities.archetype[index] === ArchetypeCode.Knight
      && this.entities.chargeTicks[index]! >= KNIGHT_CHARGE_MIN_TICKS
      && (target < 0 || this.entities.kind[target] === EntityKindCode.Unit || this.entities.kind[target] === EntityKindCode.Building)
    ) {
      return Math.round(definition.damage * KNIGHT_CHARGE_DAMAGE_BPS / 10_000);
    }
    return definition.damage;
  }

  private launchProjectile(
    sourceIndex: number,
    targetType: 'entity' | 'castle',
    targetId: number,
    damage: number,
    destination: Vec2,
  ): void {
    const origin = { x: this.entities.x[sourceIndex]!, z: this.entities.z[sourceIndex]! };
    const distance = Math.hypot(destination.x - origin.x, destination.z - origin.z);
    const flightTicks = Math.max(
      MIN_ARROW_FLIGHT_TICKS,
      Math.ceil(distance / ARROW_SPEED_METERS_PER_SECOND * TICK_RATE),
    );
    const pending: PendingProjectile = {
      projectileId: this.nextProjectileId++,
      sourceId: this.entities.id[sourceIndex]!,
      targetType,
      targetId,
      origin,
      destination: { ...destination },
      damage,
      impactTick: this.tick + flightTicks,
    };
    this.pendingProjectiles.push(pending);
    this.events.push({
      type: 'projectile-cast',
      tick: this.tick,
      projectileId: pending.projectileId,
      sourceId: pending.sourceId,
      targetType: pending.targetType,
      targetId: pending.targetId,
      origin: pending.origin,
      destination: pending.destination,
      impactTick: pending.impactTick,
    });
  }

  private resolvePendingProjectiles(): void {
    const due = this.pendingProjectiles
      .filter((pending) => pending.impactTick <= this.tick)
      .sort((left, right) => left.impactTick - right.impactTick || left.projectileId - right.projectileId);
    if (due.length === 0) return;
    const dueIds = new Set(due.map((pending) => pending.projectileId));
    this.pendingProjectiles = this.pendingProjectiles.filter((pending) => !dueIds.has(pending.projectileId));
    for (const pending of due) {
      let hit = false;
      let destination = pending.destination;
      if (pending.targetType === 'entity') {
        const target = this.entities.indexForId(pending.targetId);
        if (target >= 0) {
          destination = { x: this.entities.x[target]!, z: this.entities.z[target]! };
          if (this.entities.state[target] !== EntityStateCode.Death) {
            this.damageEntity(target, pending.damage, pending.sourceId);
            hit = true;
          }
        }
      } else {
        const castle = this.castles[pending.targetId];
        if (castle) destination = { x: castle.x, z: castle.z };
        if (castle?.alive && castle.hp > 0) {
          castle.hp = Math.max(0, castle.hp - pending.damage);
          this.events.push({
            type: 'damage',
            tick: this.tick,
            sourceId: pending.sourceId,
            targetType: 'castle',
            targetId: castle.playerId,
            amount: pending.damage,
          });
          hit = true;
        }
      }
      this.events.push({
        type: 'projectile-impact',
        tick: this.tick,
        projectileId: pending.projectileId,
        sourceId: pending.sourceId,
        targetType: pending.targetType,
        targetId: pending.targetId,
        origin: pending.origin,
        destination,
        impactTick: pending.impactTick,
        hit,
      });
    }
  }
  private damageEntity(index: number, amount: number, sourceId: number): void {
    if (this.entities.active[index] === 0 || this.entities.state[index] === EntityStateCode.Death) return;
    this.entities.hp[index] = Math.max(0, this.entities.hp[index]! - amount);
    this.events.push({ type: 'damage', tick: this.tick, sourceId, targetType: 'entity', targetId: this.entities.id[index]!, amount });
    if (this.entities.hp[index] === 0) {
      this.killEntity(index);
      return;
    }

    this.setEntityState(index, EntityStateCode.Hit);
    const source = sourceId > 0 ? this.entities.indexForId(sourceId) : -1;
    if (source < 0 || !this.isLivingEnemy(source, this.entities.owner[index] as PlayerId)) return;
    const current = this.entities.indexForId(this.entities.targetId[index]!);
    const definition = this.definitionAt(index);
    const currentIsPriorityBuilding = current >= 0
      && this.isLivingEnemy(current, this.entities.owner[index] as PlayerId)
      && this.entities.kind[current] === EntityKindCode.Building;
    if (definition.targetPriority !== 'buildings' || !currentIsPriorityBuilding) {
      this.entities.targetId[index] = sourceId;
    }
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
    this.entities.motionPhase[index] = 0;
    // Tactical pauses and target switches preserve a mounted knight's built-up
    // momentum. Charge is consumed by a real impact and reset only across the
    // lifecycle boundaries that invalidate it.
    if (
      state === EntityStateCode.Death
      || state === EntityStateCode.Spawn
    ) this.entities.chargeTicks[index] = 0;
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

  /** Places one exact archetype on a route for deterministic combat regression tests. */
  spawnDebugCombatant(routeId: string, archetypeId: ArchetypeId, routeDistance: number): number {
    const routeIndex = this.routeById.get(routeId) ?? -1;
    const route = this.routePaths[routeIndex];
    const definition = ARCHETYPES_BY_ID[archetypeId];
    if (!route || !definition || definition.kind !== 'unit' || this.entities.count >= this.maxEntities) return -1;
    const distance = Math.max(0, Math.min(route.length, routeDistance));
    const sample = sampleRoutePath(route, distance);
    return this.entities.spawn({
      kind: EntityKindCode.Unit,
      archetype: archetypeCodes[archetypeId],
      owner: route.playerId,
      x: sample.position.x,
      z: sample.position.z,
      yaw: sample.yaw,
      hp: definition.maxHp,
      routeIndex,
      routeDistance: distance,
      laneOffset: 0,
      cardCost: 0,
    });
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
      const distance = Math.min(route.length, member * 1.05);
      const sample = sampleRoutePath(route, distance);
      const id = this.entities.spawn({
        kind: EntityKindCode.Unit,
        archetype: ArchetypeCode.Guard,
        owner: route.playerId,
        x: sample.position.x,
        z: sample.position.z,
        yaw: sample.yaw,
        hp: definition.maxHp,
        routeIndex,
        routeDistance: distance,
        laneOffset: 0,
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
      if (this.entities.spawn({ kind: EntityKindCode.Unit, archetype: code, owner: playerId, x: sample.position.x, z: sample.position.z, yaw: sample.yaw, hp: definition.maxHp, routeIndex: this.routeById.get(route.routeId) ?? -1, routeDistance: distance, laneOffset: 0, cardCost: 0 }) >= 0) spawned += 1;
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
    const motionPhase = new Uint16Array(count);
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
      motionPhase[cursor] = this.entities.motionPhase[index]!;
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
      entities: { count, id, kind, archetype, owner, x, z, yaw, hp, maxHp, state, stateTick, motionPhase, targetId },
      events: [...this.events],
    };
    snapshot.stateHash = this.hashSnapshot(snapshot);
    return snapshot;
  }

  private hashSnapshot(snapshot: GameSnapshot): number {
    let hash = 0x811c9dc5;
    const add = (value: number) => { hash ^= value | 0; hash = Math.imul(hash, 0x01000193); };
    const floatBuffer = new ArrayBuffer(8);
    const floatView = new DataView(floatBuffer);
    const addFloat = (value: number) => {
      floatView.setFloat64(0, value, true);
      add(floatView.getUint32(0, true));
      add(floatView.getUint32(4, true));
    };
    const addString = (value: string) => {
      add(value.length);
      for (let index = 0; index < value.length; index += 1) add(value.charCodeAt(index));
    };

    add(this.maxEntities);
    add(snapshot.tick);
    add(this.paused ? 1 : 0);
    add(this.phase === 'playing' ? 1 : 2);
    add(this.winnerPlayerId ?? -1);
    add(this.draw ? 1 : 0);
    add(this.random.snapshotState());
    add(this.entities.nextEntityId());
    add(this.nextCastId);
    add(this.nextProjectileId);

    const orderedBots = [...this.bots].sort((left, right) => left - right);
    add(orderedBots.length);
    for (const bot of orderedBots) add(bot);

    for (const player of this.players) {
      add(player.id);
      add(player.elixirMilli);
      add(player.alive ? 1 : 0);
      add(player.lastSequence);
      for (const card of CONTENT.cards) {
        addString(card.id);
        add(player.cooldowns[card.id] ?? 0);
      }
    }
    for (const castle of this.castles) {
      add(castle.playerId);
      addFloat(castle.x);
      addFloat(castle.z);
      add(castle.hp);
      add(castle.maxHp);
      add(castle.alive ? 1 : 0);
    }
    add(this.center.ownerPlayerId ?? -1);
    add(this.center.capturingPlayerId ?? -1);
    add(this.center.progressTicks);
    for (const tactics of this.botTactics) {
      add(tactics.commanderDeployed ? 1 : 0);
      add(tactics.towerDeployed ? 1 : 0);
      add(tactics.fireballCast ? 1 : 0);
      add(tactics.chainLightningCast ? 1 : 0);
      add(tactics.supportWaves);
    }

    // Pool-slot occupancy is future-determining because the first free slot is
    // reused and entity updates run in slot order.
    for (let index = 0; index < this.entities.capacity; index += 1) {
      add(index);
      add(this.entities.active[index]!);
      if (this.entities.active[index] === 0) continue;
      add(this.entities.id[index]!);
      add(this.entities.kind[index]!);
      add(this.entities.archetype[index]!);
      add(this.entities.owner[index]!);
      addFloat(this.entities.x[index]!);
      addFloat(this.entities.z[index]!);
      addFloat(this.entities.yaw[index]!);
      add(this.entities.hp[index]!);
      add(this.entities.maxHp[index]!);
      add(this.entities.state[index]!);
      add(this.entities.stateTick[index]!);
      add(this.entities.motionPhase[index]!);
      add(this.entities.targetId[index]!);
      add(this.entities.routeIndex[index]!);
      addFloat(this.entities.routeDistance[index]!);
      addFloat(this.entities.laneOffset[index]!);
      add(this.entities.attackCooldown[index]!);
      add(this.entities.chargeTicks[index]!);
      add(this.entities.lifetime[index]!);
      add(this.entities.cardCost[index]!);
    }

    add(this.queued.length);
    for (const queued of this.queued) {
      const command = queued.command;
      addString(command.type);
      add(command.playerId);
      addString(command.cardId);
      add(command.sequence);
      add(command.tick);
      addFloat(command.position.x);
      addFloat(command.position.z);
      if (command.type === 'deploy') addString(command.routeId);
      addFloat(queued.placement.x);
      addFloat(queued.placement.z);
      addFloat(queued.pathDistance);
    }

    add(this.pendingSpells.length);
    for (const pending of this.pendingSpells) {
      add(pending.castId);
      add(pending.playerId);
      addString(pending.cardId);
      addFloat(pending.origin.x);
      addFloat(pending.origin.z);
      addFloat(pending.destination.x);
      addFloat(pending.destination.z);
      add(pending.impactTick);
    }
    add(this.pendingProjectiles.length);
    for (const pending of this.pendingProjectiles) {
      add(pending.projectileId);
      add(pending.sourceId);
      addString(pending.targetType);
      add(pending.targetId);
      addFloat(pending.origin.x);
      addFloat(pending.origin.z);
      addFloat(pending.destination.x);
      addFloat(pending.destination.z);
      add(pending.damage);
      add(pending.impactTick);
    }
    return hash >>> 0;
  }
}

export function createGame(options: GameOptions = {}): GameSimulation {
  return new GameSimulation(options);
}
