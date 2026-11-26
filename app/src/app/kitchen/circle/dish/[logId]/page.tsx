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
  params: Promise<{ logId: string }>;
}

/**
 * Read-only view of a circle friend's shown dish (`/kitchen/circle/dish/[logId]`).
 * Refuses any inaccessible, private, pre-join, or unseen-pack dish with plain
 * "Not available".
 */
export default function CircleDishPage({ params }: PageProps) {
  const { logId: raw } = use(params);
  const logId = decoded(raw);
  const router = useRouter();
  const [queueError, setQueueError] = useState<string | null>(null);

  const dishQuery = trpc.getCircleDish.useQuery(
    { logId },
    { retry: false },
  );

  const queueMutation = trpc.queueCircleDish.useMutation({
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
        kind="Circle dish"
        back={{ label: "Back to the kitchen", href: "/kitchen" }}
        ready={!dishQuery.isPending}
      >
        {dishQuery.isPending ? (
          <p role="status" className={`pt-[var(--space-4)] ${EDGE_X} ${LABEL}`}>
            Loading recipe…
          </p>
        ) : dishQuery.error || !dishQuery.data ? (
          <p
            role="status"
            data-not-available
            className={`pt-[var(--space-4)] ${EDGE_X} ${LABEL}`}
          >
            Not available
          </p>
        ) : (
          <ReadOnlyRecipeView
            title={dishQuery.data.title}
            kitchenName={dishQuery.data.kitchenName}
            cookedDay={dishQuery.data.cookedDay}
            rating={dishQuery.data.rating}
            note={dishQuery.data.note}
            recipe={dishQuery.data.recipe}
            queuing={queueMutation.isPending}
            queueError={queueError}
            onQueue={() => {
              setQueueError(null);
              queueMutation.mutate({ logId });
            }}
          />
        )}
      </BorrowedPage>
    </div>
  );
}
