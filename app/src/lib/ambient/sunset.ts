import { ambientEngine } from "./engine";

/**
 * Official sunset (zenith 90°50') on the household's civil day containing
 * `date`, by the NOAA solar algorithm. The civil date is read in `tz` (the
 * household's IANA zone), never the device's.
 */
export const calculateSunset = ambientEngine().calculateSunset;
