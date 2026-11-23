import { describe, expect, it } from "vitest";
import { filesToKeep, urlsInFontSrc } from "./offline-cook";

describe("urlsInFontSrc", () => {
  it("reads every url in a face's src, quoted or not, against its stylesheet", () => {
    expect(
      urlsInFontSrc(
        `url("/fonts/figtree-latin.woff2") format("woff2"), url(../media/x.woff) format("woff"), local(Figtree)`,
        `${"https://kitchen.example.com"}/_next/static/css/a.css`,
      ),
    ).toEqual([
      "https://kitchen.example.com/fonts/figtree-latin.woff2",
      "https://kitchen.example.com/_next/static/media/x.woff",
    ]);
  });
});

// The files a cook page asks the service worker to keep (B5b, E4): the page
// itself and its build files, never the API or another origin.

const ORIGIN = "https://kitchen.example.com";

describe("filesToKeep", () => {
  it("keeps the page, without its hash, and its scripts, styles and fonts", () => {
    expect(
      filesToKeep(`${ORIGIN}/kitchen/queue/abc#x`, [
        `${ORIGIN}/_next/static/chunks/0a1b.js`,
        `${ORIGIN}/_next/static/chunks/0a1b.js`,
        `${ORIGIN}/_next/static/css/9f.css`,
        `${ORIGIN}/fonts/figtree-latin.woff2`,
      ], ORIGIN),
    ).toEqual([
      `${ORIGIN}/kitchen/queue/abc`,
      `${ORIGIN}/_next/static/chunks/0a1b.js`,
      `${ORIGIN}/_next/static/css/9f.css`,
      `${ORIGIN}/fonts/figtree-latin.woff2`,
    ]);
  });

  it("leaves out the API, other origins, other paths and junk", () => {
    expect(
      filesToKeep(`${ORIGIN}/kitchen/queue/abc`, [
        `${ORIGIN}/api/trpc/getKitchenQueueItem?batch=1`,
        "https://fonts.example.com/x.woff2",
        `${ORIGIN}/kitchen/cookpacks`,
        "http://[bad",
      ], ORIGIN),
    ).toEqual([`${ORIGIN}/kitchen/queue/abc`]);
  });
});
