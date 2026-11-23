import { NextResponse } from "next/server";
import { toNextJsHandler } from "better-auth/next-js";
import { getAuth, type AppAuth } from "@/lib/auth/auth";
import { db } from "@/lib/db";
import {
  DeploymentConfigError,
  ensureDeploymentReady,
  getDeploymentMode,
} from "@/lib/kitchens/deployment";

const handlerByAuth = new WeakMap<
  AppAuth,
  ReturnType<typeof toNextJsHandler>
>();

function getHandler(): ReturnType<typeof toNextJsHandler> {
  const auth = getAuth();
  let handler = handlerByAuth.get(auth);
  if (!handler) {
    handler = toNextJsHandler(auth);
    handlerByAuth.set(auth, handler);
  }
  return handler;
}

async function handleAuthRequest(
  method: "GET" | "POST",
  request: Request,
): Promise<Response> {
  let mode: "sign-in" | "single-kitchen";
  try {
    mode = getDeploymentMode();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid deployment configuration";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (mode === "single-kitchen") {
    return new Response("Not Found", { status: 404 });
  }

  try {
    await ensureDeploymentReady(db);
  } catch (err) {
    if (err instanceof DeploymentConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    throw err;
  }

  const handler = getHandler();
  return handler[method](request);
}

export async function GET(request: Request): Promise<Response> {
  return handleAuthRequest("GET", request);
}

export async function POST(request: Request): Promise<Response> {
  return handleAuthRequest("POST", request);
}
