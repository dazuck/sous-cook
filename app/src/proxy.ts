import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { getDeploymentMode, SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";

const SIGN_IN_MODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function proxy(request: NextRequest): NextResponse {
  const mode = getDeploymentMode(process.env);

  if (mode === "single-kitchen") {
    const response = NextResponse.next();
    if (request.cookies.has(SIGN_IN_MODE_COOKIE)) {
      response.cookies.delete(SIGN_IN_MODE_COOKIE);
    }
    return response;
  }

  const isQueuePath = request.nextUrl.pathname.startsWith("/kitchen/queue/");
  const hasSessionCookie = getSessionCookie(request) !== null;

  const response =
    isQueuePath || hasSessionCookie
      ? NextResponse.next()
      : NextResponse.redirect(new URL("/sign-in", request.url));

  if (request.cookies.get(SIGN_IN_MODE_COOKIE)?.value !== "1") {
    response.cookies.set({
      name: SIGN_IN_MODE_COOKIE,
      value: "1",
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      secure: request.nextUrl.protocol === "https:",
      maxAge: SIGN_IN_MODE_COOKIE_MAX_AGE_SECONDS,
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/kitchen",
    "/kitchen/((?!.*\\.(?:webp|png|jpg|jpeg|gif|svg|ico|avif)$).*)",
  ],
};
