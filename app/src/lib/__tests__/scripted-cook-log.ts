/**
 * A Cook Log for tests that script it one call at a time: a `CookLogGrid`
 * (`lib/hooks/types.ts`) over a transport the test supplies, usually a
 * `vi.fn()`. Each grid call makes exactly one request, so a test can answer
 * the first read one way and the next another, hold a request open, fail
 * one, or count them:
 *
 *   read()                 GET  .../values/'Cook Log'!A:E
 *                          answers { values: string[][] }
 *   append(row)            POST .../values/'Cook Log'!A1:append, body { values: [row] }
 *                          answers { updates: { updatedRange: "'Cook Log'!A4:E4" } }
 *   write(row, col, vals)  PUT  .../values/'Cook Log'!D4:E4, body { values: [vals] }
 *
 * The range is URL-encoded, as a spreadsheet API would have it. An answer
 * with `ok: false` is the failure "Cook Log API <status>: <text>", and a
 * transport that rejects fails the call with its own error, as any store
 * behind the hook would.
 */

import type { CookLogGrid } from "../hooks/types";

export interface ScriptedResponse {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

export type ScriptedTransport = (url: string, init?: RequestInit) => Promise<ScriptedResponse>;

const column = (col: number) => String.fromCharCode("A".charCodeAt(0) + col - 1);

export function scriptedCookLog(transport: ScriptedTransport): CookLogGrid {
  async function request(range: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await transport(`cook-log/values/${encodeURIComponent(`'Cook Log'!${range}`)}`, init);
    if (!response.ok) {
      const text = response.text ? await response.text() : "";
      throw new Error(`Cook Log API ${response.status}: ${text.slice(0, 300)}`);
    }
    return (response.json ? await response.json() : {}) as Record<string, unknown>;
  }

  return {
    async read() {
      const data = await request("A:E");
      return (data.values ?? []) as string[][];
    },
    async append(row) {
      const data = await request("A1:append", { method: "POST", body: JSON.stringify({ values: [row] }) });
      const updatedRange = (data.updates as { updatedRange?: unknown } | undefined)?.updatedRange;
      const match = typeof updatedRange === "string" ? /!A(\d+)/.exec(updatedRange) : null;
      // No row named: the grid's answer is then no number, which the app refuses.
      return match ? Number(match[1]) : Number.NaN;
    },
    async write(row, col, values) {
      const last = column(col + values.length - 1);
      const range = values.length === 1 ? `${column(col)}${row}` : `${column(col)}${row}:${last}${row}`;
      await request(range, { method: "PUT", body: JSON.stringify({ values: [values] }) });
    },
  };
}
