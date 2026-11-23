import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { getDeploymentMode } from "@/lib/kitchens/mode";

interface NotInvitedPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NotInvitedPage({
  searchParams,
}: NotInvitedPageProps) {
  await connection();

  if (getDeploymentMode(process.env) === "single-kitchen") {
    redirect("/kitchen");
  }

  const params = await searchParams;
  const rawError = params.error;
  const error = Array.isArray(rawError) ? rawError[0] : rawError;
  const isNotInvited = error === undefined || error === "" || error === "not_invited";

  const message = isNotInvited
    ? "This Google account isn't on this Sous's invite list. Ask the person who runs it to invite you."
    : "Sign-in didn't finish. Try again.";
  const buttonLabel = isNotInvited ? "Use another Google account" : "Try again";

  return (
    <main className="cook-edge min-h-screen bg-ground flex flex-col justify-center">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-[var(--space-4)] px-[var(--edge)] py-[var(--space-6)]">
        <h1 className="font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-tight font-normal text-ink [font-synthesis:none]">
          Sous
        </h1>
        <p className="font-[family-name:var(--font-text)] text-[length:var(--type-chip)] leading-[1.35] font-medium text-ink">
          {message}
        </p>
        <div className="mt-[var(--space-2)]">
          <Button variant="primary" href="/sign-in">
            {buttonLabel}
          </Button>
        </div>
      </div>
    </main>
  );
}
