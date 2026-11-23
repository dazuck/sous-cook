"use client";

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useEffect, useState } from "react";
import { reportOutbox } from "@/hooks/useReportOutbox";
import { installErrorCapture } from "@/lib/kitchen/report-events";
import { trpc } from "@/lib/trpc";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:3000`;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => {
    // React Query starts out believing it's online and only hears later
    // changes, so a page loaded offline (the cook's offline reload, B5b) would
    // fetch and fail through its retries. Told the browser's state, it pauses
    // instead, as it does when the connection drops after load.
    if (typeof navigator !== "undefined") onlineManager.setOnline(navigator.onLine);
    return new QueryClient();
  });
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({ url: `${getBaseUrl()}/api/trpc` }),
      ],
    }),
  );

  // The dogfood flag's background (B2): window errors join the event log a
  // flag carries, and reports a past visit left waiting go now and on each
  // return to the network.
  useEffect(() => {
    const stopErrors = installErrorCapture();
    const stopOutbox = reportOutbox().start();
    return () => {
      stopOutbox();
      stopErrors();
    };
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
