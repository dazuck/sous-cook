/**
 * Where the kitchen is, for the ambient light: `NEXT_PUBLIC_KITCHEN_LAT`,
 * `NEXT_PUBLIC_KITCHEN_LNG` and `NEXT_PUBLIC_KITCHEN_TZ` (an IANA zone).
 * Never geolocation, and never the device's zone: the kitchen is where it is
 * whatever the tablet's clock is set to.
 *
 * The default is a placeholder (Greenwich), there so the sunset has a real
 * place to be computed for; set the three variables to your own kitchen.
 */
export const DEFAULT_KITCHEN_LOCATION = {
  lat: 51.48,
  lng: 0,
  tz: "Europe/London",
  name: "Greenwich",
} as const;

export interface KitchenPlace {
  lat: number;
  lng: number;
  tz: string;
}

/** Pure, for tests: the place an environment describes. */
export function kitchenPlaceFrom(env: { lat?: string; lng?: string; tz?: string }): KitchenPlace {
  const lat = env.lat ? Number.parseFloat(env.lat) : DEFAULT_KITCHEN_LOCATION.lat;
  const lng = env.lng ? Number.parseFloat(env.lng) : DEFAULT_KITCHEN_LOCATION.lng;
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_KITCHEN_LOCATION.lat,
    lng: Number.isFinite(lng) ? lng : DEFAULT_KITCHEN_LOCATION.lng,
    tz: env.tz || DEFAULT_KITCHEN_LOCATION.tz,
  };
}

export function getKitchenPlace(): KitchenPlace {
  // Literal reads: Next inlines NEXT_PUBLIC_* only when written out in full.
  return kitchenPlaceFrom({
    lat: process.env.NEXT_PUBLIC_KITCHEN_LAT,
    lng: process.env.NEXT_PUBLIC_KITCHEN_LNG,
    tz: process.env.NEXT_PUBLIC_KITCHEN_TZ,
  });
}

/**
 * `NEXT_PUBLIC_AMBIENT_FORCE` (`dusk` or `day`) pins the light. It is a
 * build-time variable, so it could ride into a production build and stick
 * the kitchen at one stop for good: it is ignored unless the build is not a
 * production one, or `NEXT_PUBLIC_E2E=1` says it is the e2e build.
 */
export function ambientForceFrom(env: { nodeEnv?: string; e2e?: string; force?: string }): string | null {
  if (env.nodeEnv === "production" && env.e2e !== "1") return null;
  return env.force === "dusk" || env.force === "day" ? env.force : null;
}

export function getAmbientForce(): string | null {
  return ambientForceFrom({
    nodeEnv: process.env.NODE_ENV,
    e2e: process.env.NEXT_PUBLIC_E2E,
    force: process.env.NEXT_PUBLIC_AMBIENT_FORCE,
  });
}
