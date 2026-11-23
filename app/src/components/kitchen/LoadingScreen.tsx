"use client";

import { useEffect, useState } from "react";
import { DotMark } from "./VoiceDot";
import { EDGE_X } from "./cook-edge";

/**
 * Paper and the dot, where the cook header puts it, so a slow load reads as
 * the device thinking and the cook opens with nothing jumping. No words on
 * screen; one for a screen reader. The status region mounts empty and takes
 * its word a tick later, since a live region announces a change, and one that
 * arrives already holding its text may go unread.
 */
export function LoadingScreen() {
  const [said, setSaid] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSaid(true));
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="cook-edge min-h-screen bg-ground">
      <div className={`py-[var(--space-2)] ${EDGE_X}`}>
        <div className="flex h-[var(--target)] items-center">
          <DotMark status="off" />
        </div>
      </div>
      <p role="status" className="sr-only">
        {said ? "Loading" : ""}
      </p>
    </div>
  );
}
