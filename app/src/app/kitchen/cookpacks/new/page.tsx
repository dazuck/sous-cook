"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  buildCollectionAuthoringPrompt,
  buildCollectionRepairPrompt,
  slugifyCollectionId,
  validateCollectionJson,
  type CollectionAuthoringContext,
} from "@/lib/cookpacks/authoring";
import {
  BROWSER_PROVIDER_LABELS,
  DEFAULT_BROWSER_MODELS,
  DEFAULT_OLLAMA_URL,
  convertCollectionInBrowser,
  forgetBrowserModelKey,
  readBrowserModelKey,
  readBrowserModelPrefs,
  saveBrowserModelKey,
  saveBrowserModelPrefs,
  type BrowserModelProvider,
  type BrowserRecipeImage,
} from "@/lib/cookpacks/browser-llm";
import { trpc } from "@/lib/trpc";

type BuildMode = "in-app" | "chat-app";

const PROVIDERS: readonly BrowserModelProvider[] = [
  "gemini",
  "anthropic",
  "openai",
  "ollama",
];

const MAX_RECIPE_IMAGES = 6;

const INPUT_CLASS = `h-[var(--target)] w-full rounded-[var(--radius-2)] border border-ink/[.2] bg-transparent px-[calc(16*var(--cpx))] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft ${FOCUS}`;
const TEXTAREA_CLASS = `w-full rounded-[var(--radius-2)] border border-ink/[.2] bg-transparent p-[var(--space-4)] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] leading-[1.45] font-medium text-ink placeholder:text-ink-soft ${FOCUS}`;

function fileToBase64(file: File): Promise<BrowserRecipeImage> {
  return new Promise((resolve, reject) => {
    const mimeType =
      file.type === "image/png" || file.type === "image/webp"
        ? file.type
        : "image/jpeg";
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      resolve({
        mimeType,
        base64: result.slice(comma + 1),
        name: file.name,
      });
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function AddCollectionBuilderInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editPackId = searchParams.get("edit")?.trim() || null;
  const isEditing = editPackId !== null;

  const signInMode = useSignInMode();
  const utils = trpc.useUtils();
  const settings = trpc.getKitchenSettings.useQuery(undefined, {
    enabled: signInMode,
  });
  const canManage =
    !signInMode || settings.data?.memberRole === "owner";

  const authoring = trpc.getCollectionAuthoringInfo.useQuery(undefined, {
    enabled: canManage,
  });
  const existingPack = trpc.getOwnedCollectionRaw.useQuery(
    { packId: editPackId ?? "" },
    { enabled: Boolean(editPackId) && canManage },
  );

  // Field ids for explicit label/error wiring
  const titleInputId = useId();
  const titleErrorId = useId();
  const authorInputId = useId();
  const authorErrorId = useId();
  const descriptionInputId = useId();
  const sourceRecipesId = useId();
  const jsonInputId = useId();
  const jsonErrorId = useId();
  const apiKeyInputId = useId();
  const modelInputId = useId();
  const ollamaUrlInputId = useId();
  const tabInAppId = useId();
  const tabChatAppId = useId();

  const titleInputRef = useRef<HTMLInputElement>(null);
  const authorInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<Record<BuildMode, HTMLButtonElement | null>>({
    "in-app": null,
    "chat-app": null,
  });

  // Collection metadata & JSON draft state (falls back to existingPack when editing)
  const [titleDraft, setTitle] = useState<string | null>(null);
  const [authorDraft, setAuthor] = useState<string | null>(null);
  const [descriptionDraft, setDescription] = useState<string | null>(null);
  const [jsonDraft, setJsonText] = useState<string | null>(null);
  const [sourceRecipesText, setSourceRecipesText] = useState("");
  const [images, setImages] = useState<BrowserRecipeImage[]>([]);

  const loadedPack = existingPack.data?.packJson as
    | { title?: unknown; description?: unknown; creator?: { name?: unknown } }
    | undefined;
  const title =
    titleDraft ??
    (typeof loadedPack?.title === "string" ? loadedPack.title : "");
  const author =
    authorDraft ??
    (typeof loadedPack?.creator?.name === "string" ? loadedPack.creator.name : "");
  const description =
    descriptionDraft ??
    (typeof loadedPack?.description === "string" ? loadedPack.description : "");
  const jsonText = jsonDraft ?? existingPack.data?.jsonText ?? "";

  // Tabs & model state (client-only storage)
  const [mode, setMode] = useState<BuildMode>("in-app");
  const [provider, setProvider] = useState<BrowserModelProvider>(
    () => readBrowserModelPrefs().provider,
  );
  const [modelName, setModelName] = useState(
    () => readBrowserModelPrefs().model,
  );
  const [ollamaUrl, setOllamaUrl] = useState(
    () => readBrowserModelPrefs().ollamaUrl,
  );
  const [apiKey, setApiKey] = useState(() =>
    readBrowserModelKey(readBrowserModelPrefs().provider),
  );
  const [showKey, setShowKey] = useState(false);

  // Validation, interaction & status state
  const [titleInteracted, setTitleInteracted] = useState(false);
  const [authorInteracted, setAuthorInteracted] = useState(false);
  const [jsonInteracted, setJsonInteracted] = useState(false);
  const [liveErrorAnnouncement, setLiveErrorAnnouncement] = useState("");
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertFeedback, setConvertFeedback] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    };
  }, []);

  const authoringContext: CollectionAuthoringContext | null = useMemo(() => {
    if (!authoring.data) return null;
    return {
      commons: authoring.data.commons,
      states: authoring.data.states,
      reservedPackIds: authoring.data.reservedPackIds,
    };
  }, [authoring.data]);

  const effectiveId = useMemo(() => {
    if (isEditing && existingPack.data) return existingPack.data.packId;
    return slugifyCollectionId(
      title || "my-collection",
      authoringContext?.reservedPackIds,
    );
  }, [isEditing, existingPack.data, title, authoringContext]);

  const validation = useMemo(() => {
    if (!authoringContext || !jsonText.trim()) return null;
    return validateCollectionJson(jsonText, authoringContext);
  }, [authoringContext, jsonText]);

  const syncMetadataFromJsonText = useCallback((raw: string) => {
    try {
      const parsed = JSON.parse(raw) as {
        title?: unknown;
        description?: unknown;
        creator?: { name?: unknown };
      };
      if (typeof parsed.title === "string" && parsed.title.trim()) {
        setTitle((cur) => (cur?.trim() ? cur : (parsed.title as string)));
      }
      if (
        typeof parsed.creator?.name === "string" &&
        parsed.creator.name.trim()
      ) {
        setAuthor((cur) =>
          cur?.trim() ? cur : (parsed.creator!.name as string),
        );
      }
      if (typeof parsed.description === "string" && parsed.description.trim()) {
        setDescription((cur) =>
          cur?.trim() ? cur : (parsed.description as string),
        );
      }
    } catch {
      // Incomplete JSON while typing; ignore.
    }
  }, []);

  const scheduleErrorAnnouncement = useCallback((message: string) => {
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    setLiveErrorAnnouncement("");
    announceTimerRef.current = setTimeout(() => {
      setLiveErrorAnnouncement(message);
    }, 450);
  }, []);

  const handleProviderChange = (next: BrowserModelProvider) => {
    const nextModel = DEFAULT_BROWSER_MODELS[next];
    const nextKey = readBrowserModelKey(next);
    setProvider(next);
    setModelName(nextModel);
    setApiKey(nextKey);
    setConvertFeedback(null);
    saveBrowserModelPrefs({
      provider: next,
      model: nextModel,
      ollamaUrl,
    });
  };

  const handleForgetKey = () => {
    forgetBrowserModelKey(provider);
    setApiKey("");
    setConvertFeedback({
      text: `Forgot saved ${BROWSER_PROVIDER_LABELS[provider]} key in this browser.`,
      isError: false,
    });
  };

  const handlePhotoFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setConvertFeedback(null);
    try {
      const list = Array.from(files).slice(0, MAX_RECIPE_IMAGES - images.length);
      const encoded = await Promise.all(list.map(fileToBase64));
      setImages((prev) => [...prev, ...encoded].slice(0, MAX_RECIPE_IMAGES));
    } catch (err) {
      setConvertFeedback({
        text: err instanceof Error ? err.message : "Could not read photo.",
        isError: true,
      });
    }
  };

  const handleJsonFileUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setJsonText(text);
      setJsonInteracted(true);
      setSaveError(null);
      syncMetadataFromJsonText(text);
    } catch {
      setSaveError(`Could not read "${file.name}".`);
    }
  };

  const buildCurrentPrompt = () => {
    const ctx = authoringContext ?? {
      commons: [],
      states: [],
      reservedPackIds: ["household-book", "fannie-farmer-1896", "new"],
    };
    return buildCollectionAuthoringPrompt({
      id: effectiveId,
      title: title.trim() || "My Kitchen Collection",
      creatorName: author.trim() || "Home Cook",
      description,
      sourceText: sourceRecipesText,
      hasImages: images.length > 0,
      existingPackJson: isEditing ? jsonText : undefined,
      commons: ctx.commons,
      states: ctx.states,
    });
  };

  const copyText = async (text: string, label: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        setCopyStatus("Clipboard copy isn't available here.");
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopyStatus(label);
    } catch {
      setCopyStatus("Clipboard copy failed; select and copy the text instead.");
    }
  };

  const handleConvertInApp = async () => {
    if (!authoringContext || converting) return;
    setTitleInteracted(true);
    setAuthorInteracted(true);
    setSaveError(null);

    if (!title.trim()) {
      setConvertFeedback({ text: "Enter a collection title first.", isError: true });
      titleInputRef.current?.focus();
      return;
    }
    if (!author.trim()) {
      setConvertFeedback({ text: "Enter an author or kitchen name first.", isError: true });
      authorInputRef.current?.focus();
      return;
    }
    if (!sourceRecipesText.trim() && images.length === 0) {
      setConvertFeedback({
        text: "Paste recipe text or attach at least one recipe photo before converting.",
        isError: true,
      });
      return;
    }

    saveBrowserModelPrefs({
      provider,
      model: modelName.trim() || DEFAULT_BROWSER_MODELS[provider],
      ollamaUrl: ollamaUrl.trim() || DEFAULT_OLLAMA_URL,
    });
    if (provider !== "ollama") {
      saveBrowserModelKey(provider, apiKey);
    }

    setConverting(true);
    setConvertFeedback({
      text: `Converting with ${BROWSER_PROVIDER_LABELS[provider]} directly from your browser…`,
      isError: false,
    });

    try {
      const prompt = buildCurrentPrompt();
      const result = await convertCollectionInBrowser({
        provider,
        model: modelName.trim() || DEFAULT_BROWSER_MODELS[provider],
        apiKey,
        ollamaUrl,
        prompt,
        images,
        authoringContext,
      });

      setJsonText(result.jsonText);
      setJsonInteracted(true);
      syncMetadataFromJsonText(result.jsonText);

      if (result.ok && result.pack) {
        setConvertFeedback({
          text: `Ready: converted ${result.pack.recipes.length} ${result.pack.recipes.length === 1 ? "recipe" : "recipes"}. Review the contents below and save.`,
          isError: false,
        });
      } else {
        setConvertFeedback({
          text: "Your model returned JSON with formatting issues listed below. Review them or copy the repair instructions.",
          isError: true,
        });
      }
    } catch (err) {
      setConvertFeedback({
        text: err instanceof Error ? err.message : "Model conversion failed.",
        isError: true,
      });
    } finally {
      setConverting(false);
    }
  };

  const saveCollection = trpc.saveOwnedCollection.useMutation({
    onSuccess: (saved) => {
      setSaveError(null);
      void utils.getShelf.invalidate();
      void utils.getPack.invalidate({ packId: saved.packId });
      void utils.getCollectionAuthoringInfo.invalidate();
      router.push(`/kitchen/cookpacks/${encodeURIComponent(saved.packId)}`);
    },
    onError: (err) => {
      setSaveError(err.message || "Could not save this collection.");
    },
  });

  const titleInvalid = titleInteracted && title.trim().length === 0;
  const authorInvalid = authorInteracted && author.trim().length === 0;
  const jsonInvalid =
    jsonInteracted &&
    (jsonText.trim().length === 0 || (validation !== null && !validation.ok));

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const order: BuildMode[] = ["in-app", "chat-app"];
    const idx = order.indexOf(mode);
    let next: BuildMode | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = order[(idx + 1) % order.length]!;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = order[(idx - 1 + order.length) % order.length]!;
    } else if (e.key === "Home") {
      next = order[0]!;
    } else if (e.key === "End") {
      next = order[order.length - 1]!;
    }
    if (!next) return;
    e.preventDefault();
    setMode(next);
    tabRefs.current[next]?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (saveCollection.isPending || converting) return;

    setTitleInteracted(true);
    setAuthorInteracted(true);
    setJsonInteracted(true);
    setSaveError(null);

    if (title.trim().length === 0) {
      scheduleErrorAnnouncement("Collection title is required.");
      titleInputRef.current?.focus();
      return;
    }
    if (author.trim().length === 0) {
      scheduleErrorAnnouncement("Author or kitchen name is required.");
      authorInputRef.current?.focus();
      return;
    }
    if (jsonText.trim().length === 0) {
      setSaveError(
        "Convert your recipes or paste a collection JSON file before saving.",
      );
      scheduleErrorAnnouncement("Collection JSON is missing.");
      if (mode === "chat-app") {
        jsonInputRef.current?.focus();
      }
      return;
    }

    // Apply current Title / Author / Description edits onto the JSON before saving.
    let submissionText = jsonText;
    try {
      const obj = JSON.parse(jsonText) as Record<string, unknown>;
      obj.title = title.trim();
      const existingCreator =
        obj.creator && typeof obj.creator === "object"
          ? (obj.creator as Record<string, unknown>)
          : {};
      obj.creator = { ...existingCreator, name: author.trim() };
      if (description.trim()) {
        obj.description = description.trim();
      }
      if (isEditing && existingPack.data) {
        obj.id = existingPack.data.packId;
      }
      submissionText = JSON.stringify(obj, null, 2);
      setJsonText(submissionText);
    } catch {
      // Leave submissionText to fail cleanly below if not valid JSON.
    }

    if (authoringContext) {
      const checked = validateCollectionJson(submissionText, authoringContext);
      if (!checked.ok) {
        setSaveError(checked.issues[0] ?? "Fix the collection issues below.");
        scheduleErrorAnnouncement(
          checked.issues[0] ?? "Collection has validation issues.",
        );
        if (mode === "chat-app") {
          jsonInputRef.current?.focus();
        }
        return;
      }
    }

    saveCollection.mutate({ packJsonText: submissionText });
  };

  const backHref =
    isEditing && editPackId
      ? `/kitchen/cookpacks/${encodeURIComponent(editPackId)}`
      : "/kitchen/cookpacks";
  const backLabel = isEditing ? "Back to collection" : "Back to Cookpacks";

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind={isEditing ? "Update collection" : "Add a collection"}
        back={{ label: backLabel, href: backHref }}
        returnKey={isEditing && editPackId ? `pack:${editPackId}` : "add-collection"}
        ready={authoring.data !== undefined || !canManage}
      >
        <main
          className={`min-h-0 flex-1 overflow-y-auto pb-[calc(64*var(--cpx))] ${EDGE_X}`}
        >
          <div className="max-w-[calc(760*var(--cpx))] pt-[var(--space-4)]">
            <div aria-live="polite" className="sr-only">
              {liveErrorAnnouncement}
            </div>

            {signInMode && settings.data && settings.data.memberRole !== "owner" ? (
              <div className="py-[var(--space-4)]">
                <p className="text-[length:var(--type-chip)] leading-[1.3] font-medium">
                  Only kitchen owners can add or update collections.
                </p>
                <Link
                  href="/kitchen/cookpacks"
                  className={`mt-[var(--space-4)] inline-flex ${ACTION} ${ACTION_AT_REST}`}
                >
                  Back to Cookpacks
                </Link>
              </div>
            ) : authoring.error ? (
              <p role="status" className={LABEL}>
                Could not load collection authoring tools just now.
              </p>
            ) : !authoring.data || (isEditing && existingPack.isLoading) ? (
              <p role="status" className={LABEL}>
                Loading collection tools…
              </p>
            ) : isEditing && existingPack.error ? (
              <p role="status" className="text-[length:var(--type-meta)] font-medium text-ink">
                {existingPack.error.message || "Could not load that collection."}
              </p>
            ) : (
              <form
                onSubmit={handleSubmit}
                noValidate
                aria-labelledby="collection-form-heading"
                className="flex flex-col gap-[var(--space-6)]"
              >
                <section aria-labelledby="collection-form-heading">
                  <h2
                    id="collection-form-heading"
                    className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]"
                  >
                    {isEditing ? "Collection details" : "New collection"}
                  </h2>
                  <p className={`mt-[var(--space-1)] ${LABEL}`}>
                    Fields marked * are required.
                  </p>

                  <div className="mt-[var(--space-4)] flex flex-col gap-[var(--space-4)]">
                    <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                      <label
                        htmlFor={titleInputId}
                        className="text-[length:var(--type-meta)] font-semibold text-ink"
                      >
                        Collection title <span aria-hidden="true">*</span>
                      </label>
                      <input
                        ref={titleInputRef}
                        id={titleInputId}
                        name="title"
                        type="text"
                        required
                        data-holds-keys
                        value={title}
                        aria-invalid={titleInvalid ? "true" : "false"}
                        aria-describedby={titleInvalid ? titleErrorId : undefined}
                        onBlur={() => {
                          setTitleInteracted(true);
                          if (title.trim().length === 0) {
                            scheduleErrorAnnouncement("Collection title is required.");
                          }
                        }}
                        onChange={(e) => {
                          setTitle(e.target.value);
                          if (e.target.value.trim().length > 0 && announceTimerRef.current) {
                            clearTimeout(announceTimerRef.current);
                            setLiveErrorAnnouncement("");
                          }
                        }}
                        placeholder="For example: Weeknight Favorites"
                        className={`${INPUT_CLASS} ${titleInvalid ? "border-ember" : ""}`}
                      />
                      <p
                        id={titleErrorId}
                        hidden={!titleInvalid}
                        className="text-[length:var(--type-meta)] font-medium text-ember"
                      >
                        Error: Collection title is required.
                      </p>
                    </div>

                    <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                      <label
                        htmlFor={authorInputId}
                        className="text-[length:var(--type-meta)] font-semibold text-ink"
                      >
                        Author or kitchen name <span aria-hidden="true">*</span>
                      </label>
                      <input
                        ref={authorInputRef}
                        id={authorInputId}
                        name="author"
                        type="text"
                        required
                        data-holds-keys
                        value={author}
                        aria-invalid={authorInvalid ? "true" : "false"}
                        aria-describedby={authorInvalid ? authorErrorId : undefined}
                        onBlur={() => {
                          setAuthorInteracted(true);
                          if (author.trim().length === 0) {
                            scheduleErrorAnnouncement("Author or kitchen name is required.");
                          }
                        }}
                        onChange={(e) => {
                          setAuthor(e.target.value);
                          if (e.target.value.trim().length > 0 && announceTimerRef.current) {
                            clearTimeout(announceTimerRef.current);
                            setLiveErrorAnnouncement("");
                          }
                        }}
                        placeholder="For example: River House Kitchen"
                        className={`${INPUT_CLASS} ${authorInvalid ? "border-ember" : ""}`}
                      />
                      <p
                        id={authorErrorId}
                        hidden={!authorInvalid}
                        className="text-[length:var(--type-meta)] font-medium text-ember"
                      >
                        Error: Author or kitchen name is required.
                      </p>
                    </div>

                    <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                      <label
                        htmlFor={descriptionInputId}
                        className="text-[length:var(--type-meta)] font-semibold text-ink"
                      >
                        Short description
                      </label>
                      <input
                        id={descriptionInputId}
                        name="description"
                        type="text"
                        data-holds-keys
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Optional one-line note on the title page"
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>
                </section>

                <section aria-labelledby="how-to-build-heading" className="border-t border-ink/[.11] pt-[var(--space-6)]">
                  <h2
                    id="how-to-build-heading"
                    className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]"
                  >
                    Build recipes
                  </h2>

                  <div
                    role="tablist"
                    aria-label="How to build this collection"
                    className="mt-[var(--space-3)] flex flex-nowrap gap-[var(--space-5)] overflow-x-auto border-b border-ink/[.14]"
                  >
                    <button
                      ref={(el) => {
                        tabRefs.current["in-app"] = el;
                      }}
                      id={tabInAppId}
                      type="button"
                      role="tab"
                      aria-selected={mode === "in-app"}
                      tabIndex={mode === "in-app" ? 0 : -1}
                      onClick={() => setMode("in-app")}
                      onKeyDown={onTabKeyDown}
                      className={`relative h-[var(--target)] shrink-0 cursor-pointer px-[var(--space-1)] text-[length:var(--type-meta)] font-semibold whitespace-nowrap transition-colors duration-[320ms] ease-[var(--ease)] ${FOCUS} ${
                        mode === "in-app"
                          ? "text-ink after:absolute after:inset-x-0 after:bottom-0 after:border-b-[3px] after:border-ink"
                          : "text-ink-soft"
                      }`}
                    >
                      Convert here (your own model)
                    </button>
                    <button
                      ref={(el) => {
                        tabRefs.current["chat-app"] = el;
                      }}
                      id={tabChatAppId}
                      type="button"
                      role="tab"
                      aria-selected={mode === "chat-app"}
                      tabIndex={mode === "chat-app" ? 0 : -1}
                      onClick={() => setMode("chat-app")}
                      onKeyDown={onTabKeyDown}
                      className={`relative h-[var(--target)] shrink-0 cursor-pointer px-[var(--space-1)] text-[length:var(--type-meta)] font-semibold whitespace-nowrap transition-colors duration-[320ms] ease-[var(--ease)] ${FOCUS} ${
                        mode === "chat-app"
                          ? "text-ink after:absolute after:inset-x-0 after:bottom-0 after:border-b-[3px] after:border-ink"
                          : "text-ink-soft"
                      }`}
                    >
                      Use your chat app
                    </button>
                  </div>

                  {/* Tab 1: Convert inside browser with own key or Ollama */}
                  <div
                    role="tabpanel"
                    aria-labelledby={tabInAppId}
                    hidden={mode !== "in-app"}
                  >
                    <div className="flex flex-col gap-[var(--space-4)] pt-[var(--space-5)]">
                      <fieldset>
                        <legend className="text-[length:var(--type-meta)] font-semibold text-ink">
                          Model provider
                        </legend>
                        <div className="mt-[var(--space-2)] flex flex-wrap gap-[var(--space-4)]">
                          {PROVIDERS.map((p) => (
                            <label
                              key={p}
                              className="inline-flex min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-2)] text-[length:var(--type-meta)] font-medium text-ink"
                            >
                              <input
                                type="radio"
                                name="model-provider"
                                value={p}
                                checked={provider === p}
                                onChange={() => handleProviderChange(p)}
                                className="size-4 accent-ember"
                              />
                              <span>{BROWSER_PROVIDER_LABELS[p]}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <div className="grid gap-[var(--space-4)] sm:grid-cols-2">
                        <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                          <label
                            htmlFor={modelInputId}
                            className="text-[length:var(--type-meta)] font-semibold text-ink"
                          >
                            Model
                          </label>
                          <input
                            id={modelInputId}
                            type="text"
                            data-holds-keys
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            value={modelName}
                            onChange={(e) => setModelName(e.target.value)}
                            className={INPUT_CLASS}
                          />
                        </div>

                        {provider === "ollama" ? (
                          <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                            <label
                              htmlFor={ollamaUrlInputId}
                              className="text-[length:var(--type-meta)] font-semibold text-ink"
                            >
                              Ollama URL
                            </label>
                            <input
                              id={ollamaUrlInputId}
                              type="url"
                              data-holds-keys
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              value={ollamaUrl}
                              onChange={(e) => setOllamaUrl(e.target.value)}
                              className={INPUT_CLASS}
                            />
                          </div>
                        ) : (
                          <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                            <label
                              htmlFor={apiKeyInputId}
                              className="text-[length:var(--type-meta)] font-semibold text-ink"
                            >
                              API key
                            </label>
                            <div className="flex items-center gap-[var(--space-2)]">
                              <input
                                id={apiKeyInputId}
                                type={showKey ? "text" : "password"}
                                data-holds-keys
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={`Paste ${BROWSER_PROVIDER_LABELS[provider]} key`}
                                className={INPUT_CLASS}
                              />
                              <button
                                type="button"
                                aria-pressed={showKey}
                                onClick={() => setShowKey((s) => !s)}
                                className={`${ACTION} ${ACTION_AT_REST}`}
                              >
                                {showKey ? "Hide key" : "Show key"}
                              </button>
                              {apiKey.trim().length > 0 && (
                                <button
                                  type="button"
                                  onClick={handleForgetKey}
                                  className={`${ACTION} ${ACTION_AT_REST}`}
                                >
                                  Forget key
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      <p className={LABEL}>
                        {provider === "ollama"
                          ? "Runs from your browser against Ollama on your computer. Nothing touches Sous's server or AI cap."
                          : "Kept only in this browser and cleared when you sign out. Calls go straight from your browser to your provider and never use Sous's AI budget."}
                      </p>

                      <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                        <label
                          htmlFor={sourceRecipesId}
                          className="text-[length:var(--type-meta)] font-semibold text-ink"
                        >
                          Recipes to convert
                        </label>
                        <textarea
                          id={sourceRecipesId}
                          data-holds-keys
                          rows={6}
                          value={sourceRecipesText}
                          onChange={(e) => setSourceRecipesText(e.target.value)}
                          placeholder="Paste one or several recipes (ingredients, instructions, servings)…"
                          className={TEXTAREA_CLASS}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-[var(--space-3)]">
                        <label className={`${ACTION} ${ACTION_AT_REST}`}>
                          <span>Attach photos</span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            multiple
                            className="sr-only"
                            onChange={(e) => {
                              void handlePhotoFiles(e.target.files);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        {images.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setImages([])}
                            className={`${ACTION} ${ACTION_AT_REST}`}
                          >
                            Clear {images.length}{" "}
                            {images.length === 1 ? "photo" : "photos"}
                          </button>
                        )}

                        <button
                          type="button"
                          data-convert-collection
                          disabled={converting}
                          onClick={handleConvertInApp}
                          className={`ml-auto ${FOOT_FILL} px-[calc(28*var(--cpx))] ${
                            converting ? FOOT_FILL_WAITS : "bg-ink text-paper"
                          }`}
                        >
                          {converting ? "Converting…" : "Convert recipes"}
                        </button>
                      </div>

                      {convertFeedback && (
                        <p
                          role="status"
                          className={`text-[length:var(--type-meta)] font-medium ${
                            convertFeedback.isError ? "text-ember" : "text-ink-soft"
                          }`}
                        >
                          {convertFeedback.text}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Tab 2: Copy prompt for any chat app or upload/paste JSON */}
                  <div
                    role="tabpanel"
                    aria-labelledby={tabChatAppId}
                    hidden={mode !== "chat-app"}
                  >
                    <div className="flex flex-col gap-[var(--space-4)] pt-[var(--space-5)]">
                      <p className={`${LABEL} leading-[1.4]`}>
                        Use Claude, ChatGPT, Gemini, or any chat subscription without an API key: copy the formatting instructions, paste the JSON it returns below (or ask a connected MCP assistant using a Sending token from{" "}
                        <Link
                          href="/kitchen/settings"
                          className="text-ink underline underline-offset-4"
                        >
                          Settings
                        </Link>
                        ).
                      </p>

                      <div className="flex flex-wrap items-center gap-[var(--space-3)]">
                        <button
                          type="button"
                          data-copy-prompt
                          onClick={() =>
                            void copyText(
                              buildCurrentPrompt(),
                              "Instructions copied. Paste them into your chat app.",
                            )
                          }
                          className={`${ACTION} ${ACTION_AT_REST}`}
                        >
                          Copy instructions for Claude / ChatGPT
                        </button>

                        <label className={`${ACTION} ${ACTION_AT_REST}`}>
                          <span>Upload .json file</span>
                          <input
                            type="file"
                            accept=".json,application/json"
                            className="sr-only"
                            onChange={(e) => {
                              void handleJsonFileUpload(e.target.files);
                              e.target.value = "";
                            }}
                          />
                        </label>

                        {copyStatus && (
                          <span role="status" className={LABEL}>
                            {copyStatus}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-col gap-[calc(6*var(--cpx))]">
                        <label
                          htmlFor={jsonInputId}
                          className="text-[length:var(--type-meta)] font-semibold text-ink"
                        >
                          Collection JSON
                        </label>
                        <textarea
                          ref={jsonInputRef}
                          id={jsonInputId}
                          name="collectionJson"
                          data-holds-keys
                          rows={8}
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={jsonText}
                          aria-invalid={jsonInvalid ? "true" : "false"}
                          aria-describedby={jsonInvalid ? jsonErrorId : undefined}
                          onBlur={() => setJsonInteracted(true)}
                          onChange={(e) => {
                            setJsonText(e.target.value);
                            setSaveError(null);
                            syncMetadataFromJsonText(e.target.value);
                          }}
                          placeholder='{ "id": "weeknight-favorites", "title": "...", ... }'
                          className={`${TEXTAREA_CLASS} font-mono`}
                        />
                        <p
                          id={jsonErrorId}
                          hidden={!jsonInvalid}
                          className="text-[length:var(--type-meta)] font-medium text-ember"
                        >
                          Error: Collection JSON is required and must pass validation below.
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Validation & Contents Preview */}
                {jsonText.trim().length > 0 && validation && (
                  <section
                    aria-labelledby="preview-heading"
                    data-collection-preview
                    className="border-t border-ink/[.11] pt-[var(--space-6)]"
                  >
                    <h3
                      id="preview-heading"
                      className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]"
                    >
                      {validation.ok ? "Ready for the shelf" : "Needs fixes before saving"}
                    </h3>

                    {validation.ok ? (
                      <>
                        <p className={`mt-[var(--space-2)] ${LABEL}`}>
                          {title.trim() || validation.pack.title} ·{" "}
                          {author.trim() || validation.pack.creator.name} ·{" "}
                          {validation.pack.recipes.length}{" "}
                          {validation.pack.recipes.length === 1 ? "recipe" : "recipes"}
                        </p>
                        <ul className="mt-[var(--space-3)] border-t border-ink/[.11]">
                          {validation.pack.recipes.map((recipe) => (
                            <li
                              key={recipe.id}
                              className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)] border-b border-ink/[.11] py-[var(--space-3)]"
                            >
                              <span className="text-[length:var(--type-meta)] font-semibold text-ink">
                                {recipe.title}
                              </span>
                              <span className={LABEL}>
                                Serves {recipe.serves_base} · {recipe.ingredients.length} ingredients ·{" "}
                                {recipe.steps.length} steps
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <div className="mt-[var(--space-3)] flex flex-col gap-[var(--space-3)]">
                        <ul className="list-disc pl-[var(--space-5)] text-[length:var(--type-meta)] text-ink">
                          {validation.issues.map((issue, idx) => (
                            <li key={idx}>{issue}</li>
                          ))}
                        </ul>
                        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
                          <button
                            type="button"
                            onClick={() =>
                              void copyText(
                                buildCollectionRepairPrompt(
                                  jsonText,
                                  validation.issues,
                                ),
                                "Fix instructions copied.",
                              )
                            }
                            className={`${ACTION} ${ACTION_AT_REST}`}
                          >
                            Copy fix instructions
                          </button>
                          {mode !== "chat-app" && (
                            <button
                              type="button"
                              onClick={() => setMode("chat-app")}
                              className={`${ACTION} ${ACTION_AT_REST}`}
                            >
                              Edit JSON
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {saveError && (
                  <p
                    role="alert"
                    data-save-error
                    className="text-[length:var(--type-meta)] font-medium text-ember"
                  >
                    {saveError}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-[var(--space-4)] border-t border-ink/[.11] pt-[var(--space-5)]">
                  <button
                    type="submit"
                    data-put-on-shelf
                    disabled={saveCollection.isPending || converting}
                    aria-disabled={saveCollection.isPending || converting}
                    className={`${FOOT_FILL} px-[calc(32*var(--cpx))] ${
                      saveCollection.isPending || converting
                        ? FOOT_FILL_WAITS
                        : "bg-ember text-paper"
                    }`}
                  >
                    {saveCollection.isPending
                      ? "Saving…"
                      : isEditing
                        ? "Save changes"
                        : "Put on shelf"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </main>
      </BorrowedPage>
    </div>
  );
}

export default function AddCollectionPage() {
  return (
    <Suspense
      fallback={
        <div className="cook-edge">
          <BorrowedPage
            kind="Add a collection"
            back={{ label: "Back to Cookpacks", href: "/kitchen/cookpacks" }}
            ready={false}
          >
            <p className={`pt-[var(--space-4)] ${EDGE_X} ${LABEL}`}>
              Loading collection tools…
            </p>
          </BorrowedPage>
        </div>
      }
    >
      <AddCollectionBuilderInner />
    </Suspense>
  );
}
