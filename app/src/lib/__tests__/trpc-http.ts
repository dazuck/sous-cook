import { GET, POST } from "@/app/api/trpc/[trpc]/route";

export interface HttpCallOptions {
  method?: "GET" | "POST";
  headers?: HeadersInit;
  baseUrl?: string;
}

export interface HttpCallResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * Sends a single call through the real tRPC Next.js fetch route handler
 * (`app/src/app/api/trpc/[trpc]/route.ts`) so `errorFormatter`, headers,
 * cookies, and cross-site checks execute exactly as over HTTP.
 */
export async function httpCall<T = unknown>(
  path: string,
  input?: unknown,
  options: HttpCallOptions = {},
): Promise<HttpCallResult<T>> {
  const method = options.method ?? "GET";
  const baseUrl = (options.baseUrl ?? "https://app.example.com").replace(
    /\/+$/,
    "",
  );
  const headers = new Headers(options.headers);

  let url = `${baseUrl}/api/trpc/${path}`;
  let reqBody: string | undefined;

  if (method === "GET") {
    if (input !== undefined) {
      url += `?input=${encodeURIComponent(JSON.stringify(input))}`;
    }
  } else {
    headers.set("content-type", "application/json");
    reqBody = JSON.stringify(input ?? {});
  }

  const req = new Request(url, {
    method,
    headers,
    ...(reqBody !== undefined ? { body: reqBody } : {}),
  });

  const res = method === "GET" ? await GET(req) : await POST(req);
  const body = (await res.json()) as T;
  return {
    status: res.status,
    body,
    headers: res.headers,
  };
}
