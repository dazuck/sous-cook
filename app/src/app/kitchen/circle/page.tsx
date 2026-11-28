"use client";

import Link from "next/link";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { FOCUS } from "@/components/kitchen/control-style";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { useSignInMode } from "@/components/kitchen/SignInMode";
import { formatCircleDay } from "@/lib/kitchen/circle-format";
import { trpc } from "@/lib/trpc";

const LINK_TEXT =
  "font-medium text-ink underline decoration-ink/[.3] decoration-1 underline-offset-[calc(6*var(--cpx))] active:bg-sand";

/**
 * Dedicated circle page ("Friends' kitchens"): lists the viewer's circle
 * members and every friend's most recent showing dish. Single-kitchen mode
 * never fires circle queries and answers plain "Not available".
 */
export default function CirclePage() {
  const signInMode = useSignInMode();

  const overviewQuery = trpc.getCircleOverview.useQuery(undefined, {
    enabled: signInMode,
    refetchInterval: 30_000,
  });
  const dishesQuery = trpc.getCircleDishes.useQuery(undefined, {
    enabled: signInMode,
    refetchInterval: 30_000,
  });

  const loading =
    signInMode && (overviewQuery.isPending || dishesQuery.isPending);

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind="Friends' kitchens"
        back={{ label: "Back to the kitchen", href: "/kitchen" }}
        ready={!loading}
      >
        <div className={`min-h-0 flex-1 overflow-y-auto pb-[calc(48*var(--cpx))] ${EDGE_X}`}>
          <div className="max-w-[calc(760*var(--cpx))] pt-[var(--space-4)]">
            {!signInMode ? (
              <p role="status" data-not-available className={LABEL}>
                Not available
              </p>
            ) : overviewQuery.error || dishesQuery.error ? (
              <p role="status" className={LABEL}>
                Could not load friends&apos; kitchens just now.
              </p>
            ) : loading ? (
              <p role="status" className={LABEL}>
                Loading friends&apos; kitchens…
              </p>
            ) : !overviewQuery.data?.inCircle ? (
              <p data-circle-empty className={LABEL}>
                You&apos;re not in a circle yet.
              </p>
            ) : (
              <>
                <section aria-label="Circle details">
                  <h2 className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]">
                    {overviewQuery.data.circleName ?? "Your circle"}
                  </h2>
                  <p className={`mt-[var(--space-2)] ${LABEL} leading-[1.4]`}>
                    {overviewQuery.data.members
                      .map((m) => (m.isSelf ? `${m.name} (this kitchen)` : m.name))
                      .join(" · ")}
                  </p>
                </section>

                <section
                  aria-label="Recent dishes"
                  className="mt-[var(--space-6)] border-t border-ink/[.11] pt-[var(--space-4)]"
                >
                  {dishesQuery.data && dishesQuery.data.length > 0 ? (
                    <ul className="flex flex-col gap-y-[var(--space-3)]">
                      {dishesQuery.data.map((dish) => (
                        <li
                          key={dish.logId}
                          data-circle-dish={dish.logId}
                          className="flex flex-col gap-y-[calc(4*var(--cpx))] border-b border-ink/[.08] pb-[var(--space-3)] last:border-b-0"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-[calc(10*var(--cpx))] gap-y-[calc(2*var(--cpx))] text-[length:var(--type-meta)] leading-snug text-ink-soft">
                            {dish.canOpenRecipe ? (
                              <Link
                                href={`/kitchen/circle/dish/${dish.logId}`}
                                className={`inline-flex min-h-[var(--target)] items-center rounded-[var(--radius-1)] ${LINK_TEXT} ${FOCUS}`}
                              >
                                {dish.recipeTitle}
                              </Link>
                            ) : (
                              <span className="font-medium text-ink">
                                {dish.recipeTitle}
                              </span>
                            )}
                            <span>{dish.kitchenName}</span>
                            <span>{formatCircleDay(dish.cookedDay)}</span>
                          </div>
                          {dish.note && (
                            <p className="text-[length:var(--type-meta)] leading-[1.4] text-ink">
                              {dish.note}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={LABEL}>
                      Nothing shared from friends&apos; kitchens since joining yet.
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </BorrowedPage>
    </div>
  );
}
