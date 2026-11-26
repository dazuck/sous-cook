/**
 * The Cookpacks words (slice S). Every string here is placeholder copy
 * awaiting a rewrite. Sentence case for every word the app sets itself;
 * names keep their own case (DS §4).
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const COOKPACKS_COPY = {
  /** The kind line on the shelf and in a pack. */
  kind: "Cookpacks",
  backToKitchen: "Back to the kitchen",
  backToCookpacks: "Back to Cookpacks",

  // --- The shelf ---
  /** A pack's count of recipes that cook. */
  recipes: (n: number) => plural(n, "recipe"),
  /** Attribution for a pack shared by another kitchen. */
  fromKitchen: (name: string) => `From ${name}`,
  /** "Synced Oct 4", said of the household pack's last Refresh. */
  synced: (date: string) => `synced ${date}`,
  /** The household's label under the shelf when nothing has been synced. */
  emptyLabel: "Nothing synced yet · open the book to Refresh",
  /** The household's label when it has recipes but none came through. */
  noneCookLabel: (n: number) => `None of its ${plural(n, "recipe")} came through · open the book to see why`,
  /** The household's contents when its library couldn't be read. */
  unreadable: "Couldn't read your household book just now.",
  /** The slip tucked into the household's book that opens the ideas list. */
  saved: "Saved for later",
  savedCount: (n: number) => plural(n, "idea"),

  shelfLoading: "Taking the books down…",
  shelfFailed: "Couldn't reach the shelf just now. Try again in a minute.",

  // --- Saved for later (the ideas list, moved from the library) ---
  ideasFrom: (n: number) => `${plural(n, "idea")} in your saved ideas`,
  ideasNone: "No recipe ideas yet. Save a recipe as inspiration to add it here.",
  ideasStale: "Showing a cached copy: your saved ideas couldn't be reached.",
  ideasLoading: "Loading ideas…",
  ideasFailed: "Couldn't reach your saved ideas, and there's no copy saved yet.",

  // --- A pack ---
  search: "Search this book",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  chapters: "Chapters",
  /** The chapters menu's button, for a screen reader: what it opens. */
  chapterLabel: (chapter: string) => `Chapter: ${chapter}. Show the chapters`,
  missingCount: (n: number) => `${n} didn't come through`,
  missingFilter: (n: number) =>
    `${plural(n, "recipe")} didn't come through. Fix their tabs in your recipe library, then Refresh.`,
  showAll: "Show all",
  matches: (n: number, query: string) => `${plural(n, "recipe")} ${n === 1 ? "matches" : "match"} “${query}”`,
  noMatches: (query: string) => `No recipes match “${query}”`,
  sending: "Sending…",
  sendFailed: "Couldn't send that recipe. Try again.",
  notOnShelf: "That book isn't on the shelf.",
  loading: "Opening the book…",
  /** The household pack before anything has been synced. */
  empty: "Nothing has come in from your recipe library yet.",
  /** The household pack when it has recipes but none of them came through. */
  noneCook: (n: number) =>
    `None of your recipe library's ${plural(n, "recipe")} came through on the last Refresh. Each says why below.`,
  emptyHow: "Refresh reads every recipe tab in your recipe library. It takes a minute or two.",
  /** The household pack when its library can't be read. */
  unreadableView: "Couldn't read your household book just now. Try again in a minute.",

  // --- Refresh's one status line (S-D13) ---
  refreshRunning:
    "Reading your recipe library. It takes a minute or two; the recipes below stay as they are until it's done.",
} as const;
