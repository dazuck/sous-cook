"use client";

import { useEffect } from "react";
import { installPressIn } from "./press-in";

/** Mounts the press-in seam once for the whole app (P66). Draws nothing. */
export function PressIn() {
  useEffect(() => installPressIn(), []);
  return null;
}
