import type { UnitPose } from "../procedural";

const MAX_MOTION_PHASE = 65_535;
const LEGACY_ATTACK_CYCLE_TICKS = 24;

function phase01(motionPhase: number): number {
  if (!Number.isFinite(motionPhase)) return 0;
  return Math.min(1, Math.max(0, Math.trunc(motionPhase)) / MAX_MOTION_PHASE);
}

/**
 * Selects a pre-baked procedural pose from deterministic simulation data.
 * Walk uses travelled-distance phase, so feet stay synchronized with movement.
 * Attack reserves a readable anticipation, contact and recovery silhouette.
 */
export function visualUnitPose(state: string, stateTick: number, motionPhase: number): UnitPose {
  const tick = Number.isFinite(stateTick) ? Math.max(0, Math.trunc(stateTick)) : 0;
  const phase = phase01(motionPhase);

  if (state === "walk") return phase < 0.5 ? "walkA" : "walkB";
  if (state === "attack") {
    // Legacy or transition snapshots can carry stateTick before their first
    // quantized phase. Keep those snapshots deterministic instead of falling
    // back to wall-clock time.
    const attackPhase = phase > 0
      ? phase
      : Math.min(1, (tick % LEGACY_ATTACK_CYCLE_TICKS) / LEGACY_ATTACK_CYCLE_TICKS);
    // On the impact tick the simulation resets stateTick but deliberately
    // retains the contact phase calculated for that frame.
    if (tick === 0 && attackPhase >= 0.24) return "attack";
    if (attackPhase < 0.3) return "attackWindup";
    if (attackPhase < 0.48) return "attack";
    return "attackRecover";
  }
  if (state === "hit") return "hit";
  if (state === "death") return "death";
  if (state === "spawn") return "spawn";
  return "idle";
}
