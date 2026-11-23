"use client";

import { useState, useRef, useCallback, type ChangeEvent } from "react";
import { Button } from "@/components/ui";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";
import { EDGE_X } from "./cook-edge";
import {
  isServesEstimateFailure,
  isUnreadableRecipe,
  QUEUE_REFUSAL_COPY,
} from "@/lib/kitchen/queue-refusal";
import type {
  ExtractionNotice,
  ImportedRecipe,
  RecipeExtraction,
} from "@/lib/recipe-import";
import type {
  KitchenQueueRecipeData,
  KitchenQueueStatus,
} from "../../../drizzle/schema";

// =============================================================================
// Types
// =============================================================================

type TabType = "url" | "paste" | "photo";

// Type for queue items (dates may be strings or Date objects depending on serialization)
export interface SerializedKitchenQueueItem {
  id: string;
  recipeNotionId: string | null;
  recipeData: KitchenQueueRecipeData | null;
  targetUser: string;
  status: KitchenQueueStatus;
  createdAt: string | Date;
  /** The derived cook plan as stored; checked with `isCurrentCookPlan` before use. */
  cookPlan?: unknown;
}

interface RecipeImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Queues the recipe; rejects when the add fails or is refused. */
  onImport: (recipe: ImportedRecipe) => Promise<void>;
  /** Queues the recipe and opens it; rejects when the add fails or is refused. */
  onStartCooking: (recipe: ImportedRecipe) => Promise<void>;
  onSaveAsInspiration?: (recipe: ImportedRecipe) => void;
  onSaveToRecipeBook?: (recipe: ImportedRecipe) => void;
  onImportFromUrl: (url: string) => Promise<RecipeExtraction | null>;
  onImportFromText: (text: string) => Promise<RecipeExtraction | null>;
  onImportFromImage?: (imageBase64: string) => Promise<RecipeExtraction | null>;
  isLoading?: boolean;
}

/**
 * The reading width each band of the import stops at: a form's measure,
 * which the library kept until its rows took the reports panel's width (V
 * fix round 1, item 6).
 */
const WIDTH = "max-w-3xl";

// =============================================================================
// Icons
// =============================================================================

const CloseIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const LinkIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const DocumentIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const CameraIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

// =============================================================================
// Tab Button Component
// =============================================================================

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

// A sand pill; the chosen tab in ink (DS §6 Lists, as the library's tabs).
function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-2)] rounded-full px-[calc(28*var(--cpx))] py-[var(--space-2)] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] leading-tight font-semibold transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
        active
          ? "bg-ink text-paper"
          : "bg-sand text-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)]"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// =============================================================================
// Recipe Preview Component
// =============================================================================

interface RecipePreviewProps {
  recipe: ImportedRecipe;
  notices: ExtractionNotice[];
  onAddToQueue: () => void;
  onStartCooking: () => void;
  onSaveAsInspiration?: () => void;
  onSaveToRecipeBook?: () => void;
  isLoading?: boolean;
}

function RecipePreview({
  recipe,
  notices,
  onAddToQueue,
  onStartCooking,
  onSaveAsInspiration,
  onSaveToRecipeBook,
  isLoading,
}: RecipePreviewProps) {
  return (
    <div className="font-[family-name:var(--font-text)]">
      <h3 className="mb-[var(--space-4)] font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-tight font-normal text-ink [font-synthesis:none]">
        {recipe.name}
      </h3>

      {/* Quiet sentence-case meta line on ground (DS §5 v1.14: no Prep/Cook/Serves pills) */}
      {(recipe.estimatedTime?.total ||
        recipe.estimatedTime?.active ||
        recipe.serves) && (
        <p
          data-times
          className="-mt-[calc(6*var(--cpx))] mb-[var(--space-4)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft"
        >
          {[
            recipe.estimatedTime?.total ? `${recipe.estimatedTime.total}\u00A0min` : null,
            recipe.estimatedTime?.active
              ? `${recipe.estimatedTime.active}\u00A0min hands-on`
              : null,
            recipe.serves ? `Serves\u00A0${recipe.serves}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {recipe.tags && recipe.tags.length > 0 && (
        <div className="mb-[var(--space-4)] flex flex-wrap gap-[var(--space-2)]">
          {recipe.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-sand px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-medium text-ink"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Parts of the extraction left out because the source doesn't give
          them, so the cook knows the recipe is incomplete before saving it */}
      {notices.length > 0 && (
        <ul className="mb-[var(--space-4)] space-y-1 text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
          {notices.map((notice) => (
            <li key={notice.kind}>{notice.message}</li>
          ))}
        </ul>
      )}

      {/* Ingredients summary */}
      {recipe.ingredients && recipe.ingredients.length > 0 && (
        <div className="mb-[var(--space-4)]">
          <h4 className="mb-1 text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
            Ingredients ({recipe.ingredients.length})
          </h4>
          <p className="line-clamp-2 text-[length:var(--type-chip)] leading-[1.35] text-ink">
            {recipe.ingredients.map((i) => i.item).join(", ")}
          </p>
        </div>
      )}

      {/* Steps summary */}
      {recipe.steps && recipe.steps.length > 0 && (
        <div className="mb-[var(--space-5)]">
          <h4 className="mb-1 text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
            Steps ({recipe.steps.length})
          </h4>
          <p className="line-clamp-2 text-[length:var(--type-chip)] leading-[1.35] text-ink">{recipe.steps[0]}</p>
        </div>
      )}

      {/* Actions - Primary row */}
      <div className="flex gap-3 mb-3">
        <Button
          variant="secondary"
          size="md"
          onClick={onAddToQueue}
          disabled={isLoading}
          className="flex-1"
        >
          Add to queue
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={onStartCooking}
          disabled={isLoading}
          className="flex-1"
        >
          Start cooking
        </Button>
      </div>

      {/* Actions - Save options */}
      <div className="flex gap-3">
        {onSaveAsInspiration && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSaveAsInspiration}
            disabled={isLoading}
            className="flex-1"
          >
            Save as inspiration
          </Button>
        )}
        {onSaveToRecipeBook && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSaveToRecipeBook}
            disabled={isLoading}
            className="flex-1"
          >
            Save to recipe book
          </Button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Main Modal Component
// =============================================================================

export function RecipeImportModal({
  isOpen,
  onClose,
  onImport,
  onStartCooking,
  onSaveAsInspiration,
  onSaveToRecipeBook,
  onImportFromUrl,
  onImportFromText,
  onImportFromImage,
  isLoading = false,
}: RecipeImportModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>("url");
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [preview, setPreview] = useState<RecipeExtraction | null>(null);
  const previewRecipe = preview?.recipe ?? null;
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // An add on its way: the preview's actions wait for it.
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle file selection for photo import
  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Validate file type
      if (!file.type.startsWith("image/")) {
        setError("Please select an image file");
        return;
      }

      // Validate file size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        setError("Image must be less than 10MB");
        return;
      }

      setError(null);

      // Read file as base64
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        setImagePreview(base64);
      };

      reader.onerror = () => {
        setError("Failed to read image file");
      };

      reader.readAsDataURL(file);
    },
    [],
  );

  // Clear selected image
  const clearImage = useCallback(() => {
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  if (!isOpen) return null;

  const handleImportUrl = async () => {
    if (!url.trim()) {
      setError("Please enter a URL");
      return;
    }

    setError(null);
    setImporting(true);

    try {
      const extraction = await onImportFromUrl(url.trim());
      if (extraction) {
        setPreview(extraction);
      } else {
        setError("No recipe found at this URL");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import recipe");
    } finally {
      setImporting(false);
    }
  };

  const handleImportText = async () => {
    if (!pastedText.trim()) {
      setError("Please paste recipe text");
      return;
    }

    setError(null);
    setImporting(true);

    try {
      const extraction = await onImportFromText(pastedText.trim());
      if (extraction) {
        setPreview(extraction);
      } else {
        setError("Could not extract a recipe from the text");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import recipe");
    } finally {
      setImporting(false);
    }
  };

  const handleImportImage = async () => {
    if (!imagePreview) {
      setError("Please select an image");
      return;
    }

    if (!onImportFromImage) {
      setError("Image import is not available");
      return;
    }

    setError(null);
    setImporting(true);

    try {
      const extraction = await onImportFromImage(imagePreview);
      if (extraction) {
        setPreview(extraction);
      } else {
        setError("Could not extract a recipe from the image");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import recipe");
    } finally {
      setImporting(false);
    }
  };

  /**
   * Sends the previewed recipe and waits for the answer (B4 fix round 1,
   * MED 3). A refusal or failure keeps the modal open on the recipe, with one
   * plain line; the server's words go to the console. On success Add to queue
   * closes the modal, and Start cooking leaves it to the page, which is on its
   * way to the recipe.
   */
  const send = async (add: (recipe: ImportedRecipe) => Promise<void>, close: boolean) => {
    if (!previewRecipe || adding) return;
    setError(null);
    setAdding(true);
    try {
      await add(previewRecipe);
    } catch (err) {
      console.error("Add to queue error:", err);
      setError(
        isUnreadableRecipe(err)
          ? QUEUE_REFUSAL_COPY.notAdded
          : isServesEstimateFailure(err)
            ? QUEUE_REFUSAL_COPY.servesNotEstimated
            : QUEUE_REFUSAL_COPY.addFailed,
      );
      setAdding(false);
      return;
    }
    if (close) {
      setAdding(false);
      resetState();
      onClose();
    }
  };

  const handleAddToQueue = () => void send(onImport, true);

  const handleStartCooking = () => void send(onStartCooking, false);

  const handleSaveAsInspiration = () => {
    if (previewRecipe && onSaveAsInspiration) {
      onSaveAsInspiration(previewRecipe);
      resetState();
      onClose();
    }
  };

  const handleSaveToRecipeBook = () => {
    if (previewRecipe && onSaveToRecipeBook) {
      onSaveToRecipeBook(previewRecipe);
      resetState();
      onClose();
    }
  };

  const resetState = () => {
    setUrl("");
    setPastedText("");
    setImagePreview(null);
    setPreview(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  // DS §6: a borrowed screen of whole paper, as the library's. No scrim and
  // no ×: the kind line names it and the ledge is the way back.
  return (
    <BorrowedScreen
      kind="Import recipe"
      back={BACK_TO_KITCHEN}
      onClose={handleClose}
    >
      {/* The tabs stay put; what is under them scrolls. Each band hangs
          off the edge and stops at the reading width. */}
      <div className={`shrink-0 ${EDGE_X}`}>
        <div className={`flex gap-2 ${WIDTH}`}>
          <TabButton
            active={activeTab === "url"}
            onClick={() => {
              setActiveTab("url");
              setError(null);
            }}
            icon={<LinkIcon />}
            label="URL"
          />
          <TabButton
            active={activeTab === "paste"}
            onClick={() => {
              setActiveTab("paste");
              setError(null);
            }}
            icon={<DocumentIcon />}
            label="Paste"
          />
          {onImportFromImage && (
            <TabButton
              active={activeTab === "photo"}
              onClick={() => {
                setActiveTab("photo");
                setError(null);
              }}
              icon={<CameraIcon />}
              label="Photo"
            />
          )}
        </div>
      </div>

      {/* Content */}
      <div className={`min-h-0 flex-1 overflow-y-auto py-6 ${EDGE_X}`}>
        <div className={WIDTH}>
          {/* Error display */}
          {error && (
            <p className="mb-4 text-[length:var(--type-meta)] font-medium text-ink">
              {error}
            </p>
          )}

          {/* URL Tab */}
          {activeTab === "url" && !previewRecipe && (
            <div className="space-y-4">
              <p className="text-[length:var(--type-meta)] font-medium text-ink-soft">
                Paste a recipe URL from your favorite cooking site (e.g., NYT
                Cooking, Serious Eats, Bon Appetit)
              </p>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://cooking.nytimes.com/recipes/..."
                className="min-h-[var(--target)] w-full rounded-full bg-sand px-6 py-4 text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                onKeyDown={(e) => e.key === "Enter" && handleImportUrl()}
              />
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onClick={handleImportUrl}
                loading={importing}
                disabled={!url.trim()}
              >
                Import recipe
              </Button>
            </div>
          )}

          {/* Paste Tab */}
          {activeTab === "paste" && !previewRecipe && (
            <div className="space-y-4">
              <p className="text-[length:var(--type-meta)] font-medium text-ink-soft">
                Paste the full recipe text including ingredients and
                instructions
              </p>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste your recipe here...

Example:
Chocolate Chip Cookies

Ingredients:
- 2 cups flour
- 1 cup butter
- 1 cup chocolate chips

Instructions:
1. Preheat oven to 350F
2. Mix ingredients..."
                className="h-64 w-full resize-none rounded-[var(--radius-2)] bg-sand px-5 py-4 text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onClick={handleImportText}
                loading={importing}
                disabled={!pastedText.trim()}
              >
                Extract recipe
              </Button>
            </div>
          )}

          {/* Photo Tab */}
          {activeTab === "photo" && !previewRecipe && (
            <div className="space-y-4">
              <p className="text-[length:var(--type-meta)] font-medium text-ink-soft">
                Take a photo of a recipe or upload an image (recipe card,
                cookbook page, handwritten notes)
              </p>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="hidden"
              />

              {/* Image preview or upload button */}
              {imagePreview ? (
                <div className="relative">
                  <img
                    src={imagePreview}
                    alt="Recipe to import"
                    className="max-h-64 w-full rounded-[var(--radius-2)] object-contain"
                  />
                  <button
                    onClick={clearImage}
                    className="absolute top-2 right-2 flex min-h-[var(--target)] min-w-[var(--target)] cursor-pointer items-center justify-center rounded-full bg-paper text-ink transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:bg-sand"
                    aria-label="Clear image"
                  >
                    <CloseIcon />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex min-h-[var(--target)] w-full cursor-pointer flex-col items-center gap-3 rounded-[var(--radius-3)] bg-sand py-12 text-ink transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)]"
                >
                  <CameraIcon />
                  <span className="text-[length:var(--type-chip)] font-semibold">
                    Take photo or upload image
                  </span>
                  <span className="text-[length:var(--type-meta)] font-medium text-ink-soft">
                    Supports JPG, PNG, HEIC (max 10MB)
                  </span>
                </button>
              )}

              {/* Process button */}
              {imagePreview && (
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  onClick={handleImportImage}
                  loading={importing}
                >
                  {importing ? "Extracting recipe..." : "Extract recipe"}
                </Button>
              )}
            </div>
          )}

          {/* Recipe Preview */}
          {preview && (
            <div className="space-y-4">
              <div className="flex">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreview(null)}
                  className="-ml-4"
                >
                  &larr; Back to import
                </Button>
              </div>
              <RecipePreview
                recipe={preview.recipe}
                notices={preview.notices}
                onAddToQueue={handleAddToQueue}
                onStartCooking={handleStartCooking}
                onSaveAsInspiration={
                  onSaveAsInspiration ? handleSaveAsInspiration : undefined
                }
                onSaveToRecipeBook={
                  onSaveToRecipeBook ? handleSaveToRecipeBook : undefined
                }
                isLoading={isLoading || adding}
              />
            </div>
          )}
        </div>
      </div>
    </BorrowedScreen>
  );
}

export default RecipeImportModal;
