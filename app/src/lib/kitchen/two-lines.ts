/**
 * Where a foot word breaks when its row is too short to hold it on one line
 * (`useFootFit`): at the space that keeps the longer line shortest, counted
 * in characters, the earlier space on a tie. The two lines are drawn as two
 * boxes, so the word's box is as wide as its longer line; a wrap the browser
 * makes keeps the one-line width. One word stays on one line ("" second).
 */
export function twoLines(text: string): [string, string] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [words[0] ?? "", ""];
  let best: [string, string] = [words[0], words.slice(1).join(" ")];
  for (let i = 2; i < words.length; i++) {
    const split: [string, string] = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const longest = (s: [string, string]) => Math.max(s[0].length, s[1].length);
    if (longest(split) < longest(best)) best = split;
  }
  return best;
}
