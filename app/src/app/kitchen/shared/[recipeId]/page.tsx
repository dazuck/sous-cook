"use client";

import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { ReadOnlyRecipeView } from "@/components/kitchen/ReadOnlyRecipeView";
import { trpc } from "@/lib/trpc";

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

interface PageProps {
  params: Promise<{ recipeId: string }>;
}

/**
 * Share link target (`/kitchen/shared/[recipeId]`). Opens only for a
 * signed-in member of a kitchen in the same circle when the recipe is not
 * private; otherwise shows plain "Not available".
 */
export default function SharedRecipePage({ params }: PageProps) {
  const { recipeId: raw } = use(params);
  const recipeId = decoded(raw);
  const router = useRouter();
  const [queueError, setQueueError] = useState<string | null>(null);

  const sharedQuery = trpc.getSharedRecipe.useQuery(
    { recipeId },
    { retry: false },
  );

  const queueMutation = trpc.queueSharedRecipe.useMutation({
    onSuccess: (item) => {
      router.push(`/kitchen/queue/${item.id}`);
    },
    onError: () => {
      setQueueError("Could not add this recipe to your queue just now.");
    },
  });

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind="Shared recipe"
        back={{ label: "Back to the kitchen", href: "/kitchen" }}
        ready={!sharedQuery.isPending}
      >
        {sharedQuery.isPending ? (
          <p role="status" className={`pt-[var(--space-4)] ${EDGE_X} ${LABEL}`}>
            Loading recipe…
          </p>
        ) : sharedQuery.error || !sharedQuery.data ? (
          <p
            role="status"
            data-not-available
            className={`pt-[var(--space-4)] ${EDGE_X} ${LABEL}`}
          >
            Not available
          </p>
        ) : (
          <ReadOnlyRecipeView
            title={sharedQuery.data.title}
            kitchenName={sharedQuery.data.kitchenName}
            recipe={sharedQuery.data.recipe}
            queuing={queueMutation.isPending}
            queueError={queueError}
            onQueue={() => {
              setQueueError(null);
              queueMutation.mutate({ recipeId });
            }}
          />
        )}
      </BorrowedPage>
    </div>
  );
}
