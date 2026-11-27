"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { COOKPACKS_COPY } from "@/components/cookpacks/copy";
import { SavedForLater } from "@/components/cookpacks/SavedForLater";
import { Shelf } from "@/components/cookpacks/Shelf";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { useSignInMode } from "@/components/kitchen/SignInMode";
import { trpc } from "@/lib/trpc";

/**
 * The Cookpacks shelf: a route in the borrowed-screen grammar, "Cookpacks"
 * over the shelf and "Back to the kitchen" on the ledge.
 */
export default function CookpacksPage() {
  const router = useRouter();
  const signInMode = useSignInMode();
  const { data, error } = trpc.getShelf.useQuery();
  const settings = trpc.getKitchenSettings.useQuery(undefined, {
    enabled: signInMode,
  });
  const [saved, setSaved] = useState(false);
  const ideas = trpc.getRecipeIdeas.useQuery(undefined, { enabled: saved });

  const addCollectionHref =
    signInMode && settings.data?.memberRole === "owner"
      ? "/kitchen/cookpacks/new"
      : undefined;

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
            <Shelf
              view={data}
              onOpenSaved={() => setSaved(true)}
              addCollectionHref={addCollectionHref}
            />
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
