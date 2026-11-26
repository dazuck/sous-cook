"use client";

import { useId, useState } from "react";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import {
  ACTION,
  ACTION_AT_REST,
  FOCUS,
  FOOT_FILL,
  FOOT_FILL_WAITS,
} from "@/components/kitchen/control-style";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { useSignInMode } from "@/components/kitchen/SignInMode";
import { trpc } from "@/lib/trpc";

const ABOUT_LIMIT = 2000;
const TOKEN_LABEL_LIMIT = 80;
const MAX_LIVE_TOKENS = 10;

interface CreatedTokenBanner {
  id: string;
  label: string;
  token: string;
}

function formatTokenDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SendingTokensSection() {
  const tokenLabelId = useId();
  const utils = trpc.useUtils();
  const tokensQuery = trpc.listKitchenWebhookTokens.useQuery();
  const [labelDraft, setLabelDraft] = useState("");
  const [createdBanner, setCreatedBanner] = useState<CreatedTokenBanner | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [tokenFeedback, setTokenFeedback] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);

  const createToken = trpc.createKitchenWebhookToken.useMutation({
    onSuccess: (created) => {
      setLabelDraft("");
      setCopyFeedback(null);
      setTokenFeedback(null);
      setCreatedBanner({
        id: created.id,
        label: created.label,
        token: created.token,
      });
      void utils.listKitchenWebhookTokens.invalidate();
    },
    onError: (err) => {
      setTokenFeedback({
        text: err.message || "Could not make token.",
        isError: true,
      });
    },
  });

  const revokeToken = trpc.revokeKitchenWebhookToken.useMutation({
    onSuccess: (revoked) => {
      setCreatedBanner((current) =>
        current && current.id === revoked.id ? null : current,
      );
      setTokenFeedback({
        text: `Revoked "${revoked.label}".`,
        isError: false,
      });
      void utils.listKitchenWebhookTokens.invalidate();
    },
    onError: (err) => {
      setTokenFeedback({
        text: err.message || "Could not revoke token.",
        isError: true,
      });
    },
  });

  const tokens = tokensQuery.data ?? [];
  const atLimit = tokens.length >= MAX_LIVE_TOKENS;
  const trimmedLabel = labelDraft.trim();

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedLabel || atLimit || createToken.isPending) return;
    setTokenFeedback(null);
    createToken.mutate({ label: trimmedLabel });
  };

  const onCopy = async () => {
    if (!createdBanner) return;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        setCopyFeedback("Select and copy the token above.");
        return;
      }
      await navigator.clipboard.writeText(createdBanner.token);
      setCopyFeedback("Copied.");
    } catch {
      setCopyFeedback("Select and copy the token above.");
    }
  };

  return (
    <section
      aria-labelledby="sending-tokens-heading"
      className="mt-[var(--space-8)] border-t border-ink/[.11] pt-[var(--space-6)]"
    >
      <h2
        id="sending-tokens-heading"
        className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]"
      >
        Sending tokens
      </h2>
      <p className={`mt-[var(--space-2)] ${LABEL} leading-[1.35]`}>
        Let another program or assistant send recipes to this kitchen. Each token is shown once when you make it. Up to {MAX_LIVE_TOKENS} live tokens per kitchen.
      </p>

      <form onSubmit={onCreate} className="mt-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-3)]">
        <label htmlFor={tokenLabelId} className="sr-only">
          Token label
        </label>
        <input
          id={tokenLabelId}
          type="text"
          data-holds-keys
          aria-label="Token label"
          maxLength={TOKEN_LABEL_LIMIT}
          value={labelDraft}
          disabled={atLimit || createToken.isPending}
          onChange={(e) => {
            setLabelDraft(e.target.value);
            setTokenFeedback(null);
          }}
          placeholder="For example: Kitchen assistant"
          className={`h-[var(--target)] min-w-[min(100%,calc(320*var(--cpx)))] flex-1 rounded-[var(--radius-2)] border border-ink/[.2] bg-transparent px-[calc(16*var(--cpx))] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft ${FOCUS}`}
        />

        <button
          type="submit"
          disabled={createToken.isPending || trimmedLabel.length === 0 || atLimit}
          aria-disabled={createToken.isPending || trimmedLabel.length === 0 || atLimit}
          className={`${FOOT_FILL} px-[calc(28*var(--cpx))] ${
            createToken.isPending || trimmedLabel.length === 0 || atLimit
              ? FOOT_FILL_WAITS
              : "bg-ember text-paper"
          }`}
        >
          {createToken.isPending ? "Making…" : "Make token"}
        </button>
      </form>

      {atLimit && (
        <p className={`mt-[var(--space-3)] ${LABEL} leading-[1.35]`}>
          You have {MAX_LIVE_TOKENS} live tokens. Revoke one before making another.
        </p>
      )}

      {createdBanner && (
        <div
          data-webhook-token-reveal
          className="mt-[var(--space-4)] rounded-[var(--radius-2)] border border-ink/[.2] p-[var(--space-4)]"
        >
          <p className="text-[length:var(--type-meta)] font-semibold text-ink">
            Token made for &ldquo;{createdBanner.label}&rdquo;
          </p>
          <p className={`mt-[var(--space-1)] ${LABEL} leading-[1.35]`}>
            Save this token now. You will not be able to see it again.
          </p>
          <code
            data-webhook-token-value
            className="mt-[var(--space-3)] block overflow-x-auto rounded-[var(--radius-1)] border border-ink/[.14] px-[calc(12*var(--cpx))] py-[calc(10*var(--cpx))] font-mono text-[length:var(--type-meta)] text-ink select-all"
          >
            {createdBanner.token}
          </code>
          <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)]">
            <button
              type="button"
              onClick={onCopy}
              className={`${ACTION} ${ACTION_AT_REST}`}
            >
              Copy token
            </button>
            <button
              type="button"
              onClick={() => {
                setCreatedBanner(null);
                setCopyFeedback(null);
              }}
              className={`${ACTION} ${ACTION_AT_REST}`}
            >
              Done
            </button>
            {copyFeedback && (
              <span className={LABEL}>{copyFeedback}</span>
            )}
          </div>
        </div>
      )}

      {tokenFeedback && (
        <p
          role="status"
          className={`mt-[var(--space-3)] text-[length:var(--type-meta)] font-medium ${
            tokenFeedback.isError ? "text-ink" : "text-ink-soft"
          }`}
        >
          {tokenFeedback.text}
        </p>
      )}

      <div className="mt-[var(--space-5)]">
        {tokensQuery.error ? (
          <p role="status" className={LABEL}>
            Could not load sending tokens just now.
          </p>
        ) : !tokensQuery.data ? (
          <p role="status" className={LABEL}>
            Loading sending tokens…
          </p>
        ) : (
          <>
            <p className={LABEL}>
              Live tokens ({tokens.length} of {MAX_LIVE_TOKENS})
            </p>
            {tokens.length === 0 ? (
              <p className={`mt-[var(--space-3)] ${LABEL}`}>
                No live tokens yet.
              </p>
            ) : (
              <ul aria-label="Sending tokens" className="mt-[var(--space-3)]">
                {tokens.map((t) => (
                  <li
                    key={t.id}
                    data-webhook-token={t.id}
                    className="flex flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-ink/[.11] py-[var(--space-4)]"
                  >
                    <div>
                      <p className="text-[length:var(--type-meta)] font-semibold text-ink">
                        {t.label}
                      </p>
                      <p className={`mt-[var(--space-1)] ${LABEL}`}>
                        Made {formatTokenDate(t.createdAt)} · Last used{" "}
                        {t.lastUsedAt ? formatTokenDate(t.lastUsedAt) : "never"}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Revoke ${t.label}`}
                      disabled={revokeToken.isPending}
                      onClick={() => {
                        setTokenFeedback(null);
                        revokeToken.mutate({ id: t.id });
                      }}
                      className={`${ACTION} ${ACTION_AT_REST}`}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Kitchen settings page (`/kitchen/settings`), reached from the home rail's
 * names panel. Holds the per-kitchen "About my kitchen" text sent to Ask Sous
 * and, for kitchen owners in sign-in mode, webhook sending tokens.
 */
export default function KitchenSettingsPage() {
  const fieldId = useId();
  const signInMode = useSignInMode();
  const utils = trpc.useUtils();
  const settings = trpc.getKitchenSettings.useQuery();
  const [draft, setDraft] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const save = trpc.updateKitchenAbout.useMutation({
    onSuccess: (updated) => {
      setDraft(updated.about);
      setStatusText("Saved.");
      setIsError(false);
      void utils.getKitchenSettings.invalidate();
    },
    onError: (err) => {
      setStatusText(err.message || "Could not save settings.");
      setIsError(true);
    },
  });

  const about = draft ?? settings.data?.about ?? "";
  const charCount = [...about].length;
  const overLimit = charCount > ABOUT_LIMIT;
  const canManageTokens =
    signInMode && settings.data?.memberRole === "owner";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (overLimit || save.isPending) return;
    setStatusText(null);
    save.mutate({ about });
  };

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind="Settings"
        back={{ label: "Back to the kitchen", href: "/kitchen" }}
        ready={settings.data !== undefined}
      >
        <div className={`min-h-0 flex-1 overflow-y-auto pb-[calc(48*var(--cpx))] ${EDGE_X}`}>
          <div className="max-w-[calc(720*var(--cpx))] pt-[var(--space-4)]">
            {settings.error ? (
              <p role="status" className={LABEL}>
                Could not load settings just now.
              </p>
            ) : !settings.data ? (
              <p role="status" className={LABEL}>
                Loading settings…
              </p>
            ) : (
              <>
                <form onSubmit={onSubmit} className="flex flex-col gap-[var(--space-4)]">
                  <div>
                    <label
                      htmlFor={fieldId}
                      className="block font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]"
                    >
                      About my kitchen
                    </label>
                    <p className={`mt-[var(--space-2)] ${LABEL} leading-[1.35]`}>
                      Who eats here, allergies, or what you avoid. Ask Sous keeps this in mind.
                    </p>
                  </div>

                  <textarea
                    id={fieldId}
                    data-holds-keys
                    rows={6}
                    maxLength={ABOUT_LIMIT}
                    value={about}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setStatusText(null);
                    }}
                    placeholder="For example: Four of us, one vegetarian. Nobody eats peanuts."
                    className={`w-full rounded-[var(--radius-2)] border border-ink/[.2] bg-transparent p-[var(--space-4)] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] leading-[1.45] font-medium text-ink placeholder:text-ink-soft ${FOCUS}`}
                  />

                  <div className="flex flex-wrap items-center justify-between gap-[var(--space-4)]">
                    <span className={LABEL}>
                      {charCount} / {ABOUT_LIMIT}
                    </span>

                    <button
                      type="submit"
                      disabled={save.isPending || overLimit}
                      aria-disabled={save.isPending || overLimit}
                      className={`${FOOT_FILL} px-[calc(32*var(--cpx))] ${
                        save.isPending || overLimit
                          ? FOOT_FILL_WAITS
                          : "bg-ember text-paper"
                      }`}
                    >
                      {save.isPending ? "Saving…" : "Save"}
                    </button>
                  </div>

                  {statusText && (
                    <p
                      role="status"
                      className={`text-[length:var(--type-meta)] font-medium ${
                        isError ? "text-ink" : "text-ink-soft"
                      }`}
                    >
                      {statusText}
                    </p>
                  )}
                </form>

                {canManageTokens && <SendingTokensSection />}
              </>
            )}
          </div>
        </div>
      </BorrowedPage>
    </div>
  );
}
