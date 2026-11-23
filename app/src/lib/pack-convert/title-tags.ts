/**
 * The family Doc's title conventions (slice S, S-D11; brief "Title
 * conventions from the Doc"): a trailing season or occasion
 * ("(summer)", "(holiday)") is a tag, not part of the dish's name. Any
 * other parenthetical stays in the title as written ("Lentil stew
 * (Indian-spiced)", "Lemon cupcakes (pale-ish)").
 *
 * The vocabulary is closed and is the executor's reading of the Doc; the
 * staging live check prints every trailing parenthetical in the real Doc,
 * and a season or occasion missing here goes in before release.
 */

/** Every word that comes off a title as a tag, lowercase. */
export const TITLE_TAG_VOCABULARY = [
  "spring",
  "summer",
  "fall",
  "autumn",
  "winter",
  "holiday",
  "holidays",
  "thanksgiving",
  "christmas",
  "diwali",
  "easter",
  "new year's",
] as const;

export type TitleTag = (typeof TITLE_TAG_VOCABULARY)[number];

const VOCABULARY: ReadonlySet<string> = new Set(TITLE_TAG_VOCABULARY);

/** A curly apostrophe reads as the straight one the vocabulary holds. */
function vocabularyKey(words: string): string {
  return words.trim().replace(/\s+/g, " ").replace(/[‘’]/g, "'").toLowerCase();
}

/** Whether a tag is one of the title vocabulary's words (any case). */
export function isTitleTag(tag: string): tag is TitleTag {
  return VOCABULARY.has(vocabularyKey(tag));
}

const TRAILING = /\s*\(([^()]*)\)\s*$/;

/**
 * Strips trailing parentheticals one at a time while each is in the
 * vocabulary (case-insensitive), and returns the title left and the tags in
 * title order, lowercase. The scan stops at the first parenthetical that
 * isn't, so "Soup (holiday) (old)" keeps both. A title that is nothing but a
 * tag keeps it: an empty title is never made.
 */
export function titleTags(name: string): { title: string; tags: TitleTag[] } {
  let title = name.trim();
  const tags: TitleTag[] = [];
  for (;;) {
    const match = TRAILING.exec(title);
    if (!match) break;
    const key = vocabularyKey(match[1]!);
    if (!VOCABULARY.has(key)) break;
    const rest = title.slice(0, match.index).trim();
    if (rest === "") break;
    tags.unshift(key as TitleTag);
    title = rest;
  }
  return { title, tags };
}

/** Words that are names, and keep a name's case when shown (DS §4). */
const SHOWN: Partial<Record<TitleTag, string>> = {
  thanksgiving: "Thanksgiving",
  christmas: "Christmas",
  diwali: "Diwali",
  easter: "Easter",
  "new year's": "New Year's",
};

/**
 * How a title tag reads in a row's fact: a season or occasion as its word,
 * a holiday's name in a name's case.
 */
export function titleTagWord(tag: TitleTag): string {
  return SHOWN[tag] ?? tag;
}
