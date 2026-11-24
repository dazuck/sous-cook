"use client";

import { useEffect } from "react";
import { forgetDevice } from "@/lib/auth/device";

export interface ReplaceNavigation {
  replace(url: string): void;
}

export interface ForgetAndEnterProps {
  navigation?: ReplaceNavigation;
}

export function ForgetAndEnter({ navigation }: ForgetAndEnterProps) {
  useEffect(() => {
    forgetDevice();
    (navigation ?? window.location).replace("/kitchen");
  }, [navigation]);

  return null;
}
