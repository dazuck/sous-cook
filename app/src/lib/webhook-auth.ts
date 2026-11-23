import { NextResponse } from "next/server";

/**
 * The agent's endpoints' auth (`/api/kitchen-queue`, its sweep, `/api/packs`):
 * in production, a Bearer token equal to KITCHEN_QUEUE_API_TOKEN. Answers the
 * refusal to send, or null to go on. A server without the token set refuses
 * every call (500) rather than take one unauthenticated. Development and
 * tests skip it.
 */
export function webhookAuthRefusal(request: Request): Response | null {
  if (process.env.NODE_ENV !== "production") return null;
  const token = process.env.KITCHEN_QUEUE_API_TOKEN;
  if (!token) {
    console.error("KITCHEN_QUEUE_API_TOKEN environment variable not set");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
