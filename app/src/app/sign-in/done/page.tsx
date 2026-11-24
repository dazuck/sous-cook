import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionCookie } from "better-auth/cookies";
import { getDeploymentMode } from "@/lib/kitchens/mode";
import { ForgetAndEnter } from "./ForgetAndEnter";

export default async function SignInDonePage() {
  await connection();

  if (getDeploymentMode(process.env) === "single-kitchen") {
    redirect("/kitchen");
  }

  const requestHeaders = await headers();
  if (getSessionCookie(requestHeaders) === null) {
    redirect("/sign-in");
  }

  return (
    <main className="cook-edge min-h-screen bg-ground flex flex-col justify-center">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-[var(--space-4)] px-[var(--edge)] py-[var(--space-6)]">
        <h1 className="font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-tight font-normal text-ink [font-synthesis:none]">
          Sous
        </h1>
        <p className="font-[family-name:var(--font-text)] text-[length:var(--type-chip)] leading-[1.35] font-medium text-ink">
          Signing in...
        </p>
        <ForgetAndEnter />
      </div>
    </main>
  );
}
