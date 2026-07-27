export interface HealthBarUnitState {
  health: number;
  maxHealth: number;
  state: string;
}

/**
 * Retimes a cyclic attack animation so its authored contact pose lands on the
 * deterministic simulation contact tick. Both halves remain monotonic, which
 * preserves anticipation before damage and recovery after it.
 */
export function remapMotionPhaseAtContact(
  phaseQ: number,
  simulationContactPhase: number,
  authoredContactPhase = 0.5,
): number {
  const phase = Math.min(1, Math.max(0, Math.trunc(phaseQ) / 65_535));
  const sourceContact = Math.min(0.999, Math.max(0.001, simulationContactPhase));
  const targetContact = Math.min(0.999, Math.max(0.001, authoredContactPhase));
  const remapped = phase <= sourceContact
    ? phase / sourceContact * targetContact
    : targetContact + (phase - sourceContact) / (1 - sourceContact) * (1 - targetContact);
  return Math.round(Math.min(1, Math.max(0, remapped)) * 65_535);
}

/**
 * Keeps combat information readable without covering the whole battlefield.
 * A full-health unit gets a bar while actively exchanging blows; damage keeps
 * the bar visible afterwards. Corpses never retain a misleading health sliver.
 */
export function shouldShowHealthBar(unit: HealthBarUnitState): boolean {
  if (unit.state === "death" || unit.health <= 0 || unit.maxHealth <= 0) return false;
  return unit.health < unit.maxHealth || unit.state === "attack" || unit.state === "hit";
}

export function healthRatio(unit: Pick<HealthBarUnitState, "health" | "maxHealth">): number {
  if (unit.maxHealth <= 0) return 0;
  return Math.min(1, Math.max(0, unit.health / unit.maxHealth));
}

/** Semantic green → amber → red ramp returned as an sRGB hexadecimal value. */
export function healthBarColor(ratio: number): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  if (clamped > 0.6) return 0x78df73;
  if (clamped > 0.3) return 0xf0bd4f;
  return 0xe45445;
}
