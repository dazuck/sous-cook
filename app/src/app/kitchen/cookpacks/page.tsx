"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { COOKPACKS_COPY } from "@/components/cookpacks/copy";
import { SavedForLater } from "@/components/cookpacks/SavedForLater";
import { Shelf } from "@/components/cookpacks/Shelf";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { trpc } from "@/lib/trpc";

/**
 * The Cookpacks shelf (slice S, S-D1): a route in the borrowed-screen
 * grammar, "Cookpacks" over the shelf and "Back to the kitchen" on the
 * ledge. "Saved for later" is a borrowed screen over it. An old
 * `/kitchen?browse=true` link lands here (next.config.ts), its query
 * dropped from the URL.
 */
export default function CookpacksPage() {
  const router = useRouter();
  const { data, error } = trpc.getShelf.useQuery();
  const [saved, setSaved] = useState(false);
  const ideas = trpc.getRecipeIdeas.useQuery(undefined, { enabled: saved });

  // A redirected ?browse=true (and any import=true with it) is dropped.
  useEffect(() => {
    if (window.location.search !== "") router.replace("/kitchen/cookpacks", { scroll: false });
  }, [router]);

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind={COOKPACKS_COPY.kind}
        back={{ label: COOKPACKS_COPY.backToKitchen, href: "/kitchen" }}
        returnKey="cookpacks"
        ready={data !== undefined}
      >
        <div className={`min-h-0 flex-1 overflow-y-auto pb-[calc(24*var(--cpx))] ${EDGE_X}`}>
          {data ? (
            <Shelf view={data} onOpenSaved={() => setSaved(true)} />
          ) : (
            <p role="status" className={`pt-[calc(64*var(--cpx))] ${LABEL}`}>
              {error ? COOKPACKS_COPY.shelfFailed : COOKPACKS_COPY.shelfLoading}
            </p>
          )}
        </div>
      </BorrowedPage>
      {saved && (
        <SavedForLater
          data={ideas.data && { ideas: ideas.data.ideas, stale: ideas.data.stale }}
          failed={ideas.error !== null}
          onClose={() => setSaved(false)}
        />
      )}
    </div>
  );
}
