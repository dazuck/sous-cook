import { isAheadPart, timeLineText } from "@/lib/kitchen/time-line";

/**
 * The time line's words (`timeLine`, slice T2), as the kitchen's rows, Prep
 * and the info sheet draw them: the minutes as plain words, then the ahead
 * job held as one piece, so where the line must break it breaks at its "+"
 * and the job reads whole on the next line (T2 fix round 1, critic gap 7).
 * A job longer than the line still wraps inside itself.
 */
export function TimeLineWords({ parts }: { parts: string[] }) {
  const ahead = parts.length > 1 && isAheadPart(parts[parts.length - 1]!);
  if (!ahead) return <>{timeLineText(parts)}</>;
  return (
    <>
      {`${timeLineText(parts.slice(0, -1))} `}
      <span className="inline-block">{parts[parts.length - 1]}</span>
    </>
  );
}
