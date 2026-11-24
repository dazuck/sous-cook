/**
 * Local HTML recipe server for the URL-import browser test.
 * Serves a schema.org Recipe JSON-LD page for Weeknight Pea Soup on 127.0.0.1
 * using an ephemeral port.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { WEEKNIGHT_PEA_SOUP_JSON_LD } from "./seed-data";

export function buildWeeknightPeaSoupHtml(): string {
  const jsonLd = JSON.stringify(WEEKNIGHT_PEA_SOUP_JSON_LD);
  const ingredients = WEEKNIGHT_PEA_SOUP_JSON_LD.recipeIngredient
    .map((line) => `<li>${line}</li>`)
    .join("");
  const steps = WEEKNIGHT_PEA_SOUP_JSON_LD.recipeInstructions
    .map((step) => `<li>${step.text}</li>`)
    .join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${WEEKNIGHT_PEA_SOUP_JSON_LD.name}</title>`,
    `<script type="application/ld+json">${jsonLd}</script>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${WEEKNIGHT_PEA_SOUP_JSON_LD.name}</h1>`,
    `<p>Serves ${WEEKNIGHT_PEA_SOUP_JSON_LD.recipeYield}</p>`,
    `<ul>${ingredients}</ul>`,
    `<ol>${steps}</ol>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

export interface RecipeSiteHandle {
  url: string;
  peaSoupUrl: string;
  close: () => Promise<void>;
}

export async function startRecipeSite(): Promise<RecipeSiteHandle> {
  const html = buildWeeknightPeaSoupHtml();
  const server = http.createServer((req, res) => {
    if (req.url === "/pea-soup") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    peaSoupUrl: `${url}/pea-soup`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
