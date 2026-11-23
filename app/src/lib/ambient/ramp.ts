import { ambientEngine } from "./engine";

/**
 * Ambient light ramp calculation (P67).
 *
 * Progress t (0 to 1):
 * - Before 30 min before sunset: t = 0 (day)
 * - From 30 min before sunset to 60 min after sunset (90 min total):
 *   t rises from 0 to 1
 * - From 60 min after sunset through the night: t = 1 (night stop holds)
 * - Morning: at 6:00 AM household time, eases from 1 back to 0 by 7:00 AM.
 *
 * "Household time" is the zone in `NEXT_PUBLIC_KITCHEN_TZ` (location.ts),
 * never the device's. Overrides for tests and previews: `?ambient=dusk|day`,
 * and `NEXT_PUBLIC_AMBIENT_FORCE` where `getAmbientForce` allows it.
 */
const engine = ambientEngine();

export const calculateAmbientProgress = engine.calculateAmbientProgress;
export const ambientProgressAt = engine.ambientProgressAt;
export const ambientOverride = engine.overrideOf;
