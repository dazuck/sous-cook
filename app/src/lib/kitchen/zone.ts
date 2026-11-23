import { DEFAULT_KITCHEN_LOCATION } from "../ambient/location";

/**
 * The kitchen's time zone, for anything dated by the household's day rather
 * than the device's or the server's: the Cook Log's timestamps, "today" for
 * the kitchen's ask, a sync's date on the shelf.
 *
 * `NEXT_PUBLIC_KITCHEN_TZ` (an IANA zone, e.g. "Europe/Lisbon"), the same
 * setting the kitchen's clock reads (`lib/ambient/location.ts`), and the same
 * default when it isn't set: the placeholder place's zone. A zone the runtime
 * doesn't know throws where it is first used.
 */
export const KITCHEN_TIME_ZONE = process.env.NEXT_PUBLIC_KITCHEN_TZ || DEFAULT_KITCHEN_LOCATION.tz;
