"use client";

import { useState, useRef, useEffect, useLayoutEffect, type ChangeEvent } from "react";
import { Button } from "@/components/ui";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { allowanceSentence } from "@/lib/kitchen/allowance";
import { trpc } from "@/lib/trpc";
import type { ParsedGroceryItem } from "@/lib/pantry-reconciliation";

interface AddIngredientsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type IntakeTab = "voice" | "photo" | "text";

const FOOD_SECTIONS = [
  "Fridge",
  "Freezer",
  "Pantry",
  "Produce",
  "Spice Rack",
  "Oils, Vinegars & Sauces",
];

const MicIcon = ({ recording }: { recording?: boolean }) => (
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
    className={recording ? "animate-dot-breathe text-ink motion-reduce:animate-none" : ""}
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
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
  </svg>
);

const TrashIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const WIDTH = "max-w-3xl";

interface EditableGroceryItem extends ParsedGroceryItem {
  id: string;
  checked: boolean;
}

export function AddIngredientsModal({
  isOpen,
  onClose,
  onSuccess,
}: AddIngredientsModalProps) {
  const [activeTab, setActiveTab] = useState<IntakeTab>("voice");
  const [textInput, setTextInput] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [parsedItems, setParsedItems] = useState<EditableGroceryItem[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    isListening,
    transcript,
    startListening,
    stopListening,
    resetTranscript,
    isSupported: isSpeechSupported,
  } = useSpeechRecognition({
    continuous: true,
    interimResults: true,
  });

  const pantryQuery = trpc.getPantry.useQuery(undefined, { enabled: isOpen });
  const parseMutation = trpc.parseGroceryInput.useMutation();
  const addMutation = trpc.addIngredientsToPantry.useMutation();

  const resetTranscriptRef = useRef(resetTranscript);
  useLayoutEffect(() => {
    resetTranscriptRef.current = resetTranscript;
  });

  // Reset when modal opens
  /* eslint-disable react-hooks/set-state-in-effect -- kept in the effect: a reset made while rendering can be lost when React replays updates it queued without rendering (KitchenTimers lost one that way) */
  useEffect(() => {
    if (isOpen) {
      setActiveTab("voice");
      setTextInput("");
      setImagePreview(null);
      setParsedItems(null);
      setErrorMessage(null);
      resetTranscriptRef.current?.();
    }
  }, [isOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleStartVoice = () => {
    setErrorMessage(null);
    resetTranscript();
    startListening();
  };

  const handleStopVoice = () => {
    stopListening();
  };

  const handleImageSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setErrorMessage("Please select an image file (JPEG, PNG, etc.)");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage("Image must be smaller than 10MB");
      return;
    }

    setErrorMessage(null);
    const reader = new FileReader();
    reader.onload = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleParseInput = async () => {
    setErrorMessage(null);
    const type: "voice" | "photo" | "text" = activeTab;
    let content = "";

    if (activeTab === "voice") {
      stopListening();
      content = transcript.trim();
      if (!content) {
        setErrorMessage("No voice transcript captured yet. Tap record and speak.");
        return;
      }
    } else if (activeTab === "text") {
      content = textInput.trim();
      if (!content) {
        setErrorMessage("Please type or paste some ingredients first.");
        return;
      }
    } else if (activeTab === "photo") {
      if (!imagePreview) {
        setErrorMessage("Please select or capture a grocery photo first.");
        return;
      }
      content = imagePreview;
    }

    setIsParsing(true);
    try {
      const res = await parseMutation.mutateAsync({
        type: type === "photo" ? "image" : type,
        content,
      });

      if (!res.items || res.items.length === 0) {
        setErrorMessage("Could not identify any food items. Try typing them out.");
        return;
      }

      setParsedItems(
        res.items.map((item, index) => ({
          id: `${Date.now()}-${index}`,
          text: item.text,
          suggestedSection: item.suggestedSection || "Fridge",
          checked: true,
        })),
      );
    } catch (err) {
      console.error("Failed to parse groceries:", err);
      setErrorMessage(
        allowanceSentence(err) ??
          "Extraction failed. Check your network connection or enter text.",
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleSaveToPantry = async () => {
    if (!parsedItems) return;
    const selected = parsedItems.filter((i) => i.checked && i.text.trim().length > 0);
    if (selected.length === 0) {
      setErrorMessage("Select at least one ingredient to add.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    try {
      await addMutation.mutateAsync({
        items: selected.map((i) => ({
          text: i.text.trim(),
          section: i.suggestedSection,
        })),
      });

      void pantryQuery.refetch();
      onSuccess?.();
      onClose();
    } catch (err) {
      console.error("Failed to save pantry items:", err);
      setErrorMessage("Could not save to the pantry. Try again in a moment.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleItem = (id: string) => {
    setParsedItems((prev) =>
      prev
        ? prev.map((item) =>
            item.id === id ? { ...item, checked: !item.checked } : item,
          )
        : null,
    );
  };

  const handleUpdateItemText = (id: string, text: string) => {
    setParsedItems((prev) =>
      prev
        ? prev.map((item) => (item.id === id ? { ...item, text } : item))
        : null,
    );
  };

  const handleUpdateItemSection = (id: string, section: string) => {
    setParsedItems((prev) =>
      prev
        ? prev.map((item) =>
            item.id === id ? { ...item, suggestedSection: section } : item,
          )
        : null,
    );
  };

  const handleDeleteItem = (id: string) => {
    setParsedItems((prev) => (prev ? prev.filter((item) => item.id !== id) : null));
  };

  const handleAddNewItem = () => {
    setParsedItems((prev) => [
      ...(prev ?? []),
      {
        id: `${Date.now()}-${Math.random()}`,
        text: "",
        suggestedSection: "Fridge",
        checked: true,
      },
    ]);
  };

  const handleStartManualEntry = () => {
    setErrorMessage(null);
    setParsedItems([
      {
        id: `${Date.now()}-0`,
        text: "",
        suggestedSection: "Fridge",
        checked: true,
      },
    ]);
  };

  const nonEmptySections = (pantryQuery.data?.sections ?? []).filter(
    (s) => s.items.length > 0,
  );

  if (!isOpen) return null;

  return (
    <BorrowedScreen
      kind="Add ingredients"
      back={BACK_TO_KITCHEN}
      onClose={onClose}
    >
      <div className={`mx-auto min-h-0 w-full flex-1 overflow-y-auto ${WIDTH} px-4 py-6 font-[family-name:var(--font-text)]`}>
        {/* Error message */}
        {errorMessage && (
          <div className="mb-[var(--space-5)] rounded-[var(--radius-2)] border border-ink/[.14] bg-sand p-[var(--space-4)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink">
            {errorMessage}
          </div>
        )}

        {/* State 1: Input intake */}
        {!parsedItems && (
          <div className="space-y-[var(--space-5)]">
            <p className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
              Add things you got at the store or market to the pantry.
            </p>

            {/* Tabs */}
            <div role="tablist" aria-label="Input methods" className="flex flex-wrap gap-[var(--space-2)]">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "voice"}
                onClick={() => setActiveTab("voice")}
                className={`flex min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-2)] rounded-full px-[calc(28*var(--cpx))] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  activeTab === "voice"
                    ? "bg-ink text-paper"
                    : "bg-sand text-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)]"
                }`}
              >
                <MicIcon recording={isListening} />
                <span>Voice</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "photo"}
                onClick={() => setActiveTab("photo")}
                className={`flex min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-2)] rounded-full px-[calc(28*var(--cpx))] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  activeTab === "photo"
                    ? "bg-ink text-paper"
                    : "bg-sand text-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)]"
                }`}
              >
                <CameraIcon />
                <span>Photo</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "text"}
                onClick={() => setActiveTab("text")}
                className={`flex min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-2)] rounded-full px-[calc(28*var(--cpx))] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  activeTab === "text"
                    ? "bg-ink text-paper"
                    : "bg-sand text-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)]"
                }`}
              >
                <DocumentIcon />
                <span>Text</span>
              </button>
            </div>

            {/* Tab content */}
            {activeTab === "voice" && (
              <div className="space-y-[var(--space-4)] rounded-[var(--radius-3)] border border-ink/[.11] bg-paper p-[var(--space-5)] text-center">
                {!isSpeechSupported ? (
                  <p className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                    Speech recognition is not supported in this browser. Please use the Text or Photo tab.
                  </p>
                ) : (
                  <>
                    <p className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                      Speak your grocery list clearly (e.g. &quot;I bought two avocados, cilantro, sour cream, and limes&quot;).
                    </p>

                    <div className="min-h-24 rounded-[var(--radius-2)] border border-ink/[.11] bg-sand p-[var(--space-4)] text-left">
                      {transcript ? (
                        <p className="text-[length:var(--type-chip)] leading-[1.35] font-medium text-ink">{transcript}</p>
                      ) : (
                        <p className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                          {isListening ? "Listening... speak now" : "Transcript will appear here..."}
                        </p>
                      )}
                    </div>

                    <div className="flex justify-center gap-[var(--space-3)]">
                      {!isListening ? (
                        <Button
                          variant="secondary"
                          onClick={handleStartVoice}
                        >
                          <MicIcon /> Start speaking
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={handleStopVoice}
                        >
                          <MicIcon recording /> Stop recording
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {activeTab === "photo" && (
              <div className="space-y-[var(--space-4)] rounded-[var(--radius-3)] border border-ink/[.11] bg-paper p-[var(--space-5)] text-center">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                />

                {imagePreview ? (
                  <div className="space-y-[var(--space-4)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={imagePreview}
                      alt="Grocery preview"
                      className="mx-auto max-h-80 rounded-[var(--radius-2)] border border-ink/[.11] object-contain"
                    />
                    <Button
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Choose another photo
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-[var(--space-4)] py-6">
                    <p className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                      Take a photo of a store receipt or groceries on your counter.
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <CameraIcon /> Snap or upload photo
                    </Button>
                  </div>
                )}
              </div>
            )}

            {activeTab === "text" && (
              <div className="space-y-[var(--space-3)]">
                <label htmlFor="grocery-text" className="block text-[length:var(--type-meta)] leading-tight font-semibold text-ink">
                  Type or paste items (one per line, or comma-separated)
                </label>
                <textarea
                  id="grocery-text"
                  rows={6}
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="2 avocados&#10;1 bunch cilantro&#10;sour cream&#10;corn tortillas&#10;5 lbs russet potatoes"
                  className="w-full rounded-[var(--radius-2)] border border-ink/[.14] bg-sand p-[var(--space-4)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                />
              </div>
            )}

            {/* Parse button (the single ember CTA) + manual add */}
            <div className="space-y-[var(--space-3)] pt-2">
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onClick={handleParseInput}
                disabled={isParsing}
              >
                {isParsing ? "Extracting items..." : "Review items"}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                onClick={handleStartManualEntry}
              >
                Add items by hand
              </Button>
            </div>

            {/* Current pantry contents */}
            <section
              aria-label="In the pantry"
              className="space-y-[var(--space-3)] border-t border-ink/[.11] pt-[var(--space-5)]"
            >
              <h3 className="text-[length:var(--type-meta)] leading-tight font-semibold text-ink">
                In the pantry
              </h3>
              {pantryQuery.isLoading ? (
                <p
                  role="status"
                  className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft"
                >
                  Reading the pantry…
                </p>
              ) : pantryQuery.error ? (
                <p
                  role="status"
                  className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft"
                >
                  Couldn&apos;t reach the pantry.
                </p>
              ) : nonEmptySections.length === 0 ? (
                <p
                  role="status"
                  className="text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft"
                >
                  Nothing in the pantry yet.
                </p>
              ) : (
                <div className="space-y-[var(--space-4)]">
                  {nonEmptySections.map((section) => (
                    <div key={section.rawHeading} className="space-y-[var(--space-2)]">
                      <h4 className="text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
                        {section.rawHeading}
                      </h4>
                      <ul>
                        {section.items.map((item, idx) => (
                          <li
                            key={`${section.rawHeading}-${idx}-${item}`}
                            className="border-t border-ink/[.11] py-[var(--space-2)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink"
                          >
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* State 2: Review & confirmation checklist */}
        {parsedItems && (
          <div className="space-y-[var(--space-5)]">
            <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
              <div>
                <h3 className="font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-tight font-normal text-ink [font-synthesis:none]">
                  Review ingredients
                </h3>
                <p className="mt-1 text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                  Confirm the items and where they should be saved in your pantry.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setParsedItems(null)}
                className="min-h-[var(--target)] cursor-pointer rounded-full bg-sand px-[calc(24*var(--cpx))] text-[length:var(--type-meta)] leading-tight font-semibold text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                Start over
              </button>
            </div>

            <div className="space-y-[var(--space-3)]">
              {parsedItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex min-h-[var(--target)] flex-wrap items-center gap-[var(--space-3)] rounded-[var(--radius-2)] border px-[var(--space-3)] py-[var(--space-2)] transition-colors duration-[320ms] ease-[var(--ease)] ${
                    item.checked
                      ? "border-ink/[.14] bg-sand text-ink"
                      : "border-ink/[.11] bg-transparent text-ink-soft"
                  }`}
                >
                  <label className="flex min-h-[var(--target)] min-w-[var(--target)] shrink-0 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() => handleToggleItem(item.id)}
                      className="size-[calc(28*var(--cpx))] cursor-pointer rounded-[var(--radius-1)] border-ink/30 accent-ink"
                    />
                  </label>

                  <input
                    type="text"
                    value={item.text}
                    onChange={(e) => handleUpdateItemText(item.id, e.target.value)}
                    placeholder="Ingredient name and quantity"
                    className="min-h-[var(--target)] min-w-[200px] flex-1 bg-transparent px-[var(--space-2)] text-[length:var(--type-chip)] leading-tight font-medium text-ink placeholder:text-ink-soft focus:border-b focus:border-ink focus:outline-none"
                  />

                  <select
                    value={item.suggestedSection}
                    onChange={(e) => handleUpdateItemSection(item.id, e.target.value)}
                    className="min-h-[var(--target)] cursor-pointer rounded-full border border-ink/[.14] bg-paper px-[calc(20*var(--cpx))] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    {FOOD_SECTIONS.map((sec) => (
                      <option key={sec} value={sec}>
                        {sec}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => handleDeleteItem(item.id)}
                    aria-label="Remove item"
                    className="flex min-h-[var(--target)] min-w-[var(--target)] shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] active:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleAddNewItem}
                className="min-h-[var(--target)] cursor-pointer rounded-full bg-sand px-[calc(28*var(--cpx))] text-[length:var(--type-meta)] leading-tight font-semibold text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                + Add another item
              </button>
            </div>

            <div className="flex flex-wrap gap-[var(--space-3)] border-t border-ink/[.11] pt-[var(--space-4)]">
              <Button
                variant="primary"
                size="lg"
                onClick={handleSaveToPantry}
                disabled={isSaving || parsedItems.filter((i) => i.checked).length === 0}
                className="flex-1"
              >
                {isSaving
                  ? "Saving to pantry..."
                  : `Add ${parsedItems.filter((i) => i.checked).length} item${parsedItems.filter((i) => i.checked).length === 1 ? "" : "s"} to pantry`}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={onClose}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </BorrowedScreen>
  );
}
