"use client";

import {
  MutationCache,
  onlineManager,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useEffect, useState } from "react";
import {
  authErrorKind,
  handleAuthError,
  type AuthErrorDeps,
} from "@/lib/kitchen/auth-errors";
import { installErrorCapture } from "@/lib/kitchen/report-events";
import { trpc } from "@/lib/trpc";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:3000`;
}

export function makeQueryClient(deps?: AuthErrorDeps): QueryClient {
  // React Query starts out believing it's online and only hears later
  // changes, so a page loaded offline (the cook's offline reload, B5b) would
  // fetch and fail through its retries. Told the browser's state, it pauses
  // instead, as it does when the connection drops after load.
  if (typeof navigator !== "undefined") onlineManager.setOnline(navigator.onLine);
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => handleAuthError(error, deps),
    }),
    mutationCache: new MutationCache({
      onError: (error) => handleAuthError(error, deps),
    }),
    defaultOptions: {
      queries: {
        // Imperative fetches (queryClient.fetchQuery, prefetchQuery, ensureQueryData, and tRPC's utils fetch, prefetch and ensureData) inherit this default, so they retry other errors three times; pass retry: false where no retry is meant. Nothing calls them today.
        retry: (failureCount, error) =>
          authErrorKind(error) === null && failureCount < 3,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({ url: `${getBaseUrl()}/api/trpc` }),
      ],
    }),
  );

  // Window errors join the event log a report carries.
  useEffect(() => installErrorCapture(), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
