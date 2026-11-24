/**
 * Sue's recorded confirmations, made once with Google's speech model and kept
 * as small audio files (`public/sounds/sue/`), so a confirmation plays at once
 * and offline. The words, names and the timer lengths with a read-back are
 * `src/lib/kitchen/ack-clips.ts`; the voice, the style line and the checks
 * are `scripts/sue-clips.ts`; what a run made is recorded in
 * `scripts/data/sue-clips.json` (voice, style, model, and each clip's length,
 * peak, level, size and SHA-256). A run's calls and spend are printed, not
 * recorded.
 *
 * One voice and one style line for every clip, so they sound like one person
 * in one register. "Yes, chef." is generated in several takes and three that
 * differ in pace are kept. Each clip is trimmed of silence, brought to one
 * level, encoded (MP3, 24 kHz mono, so any browser decodes it), decoded again
 * and measured: length, peak and level must pass `problemsWith`, or the run
 * ends non-zero and says which clip. Nobody has *heard* a clip by running
 * this; the checks are measurements, and a person's ear is still owed.
 *
 * The repository ships the clips and their record. A build offers "Sounds and
 * voice" only when every clip is here, so build the app again after a run
 * (`src/lib/kitchen/ack-clips-build.ts`, read by `next.config.ts`;
 * `docs/voice-replies.md`).
 *
 *   From app/ (needs ffmpeg and ffprobe on the PATH, and GOOGLE_AI_API_KEY in the environment):
 *     npx tsx scripts/generate-sue-clips.ts [flags]
 *   --dry-run  list what would be generated and the most it could cost; calls nothing.
 *   --force    regenerate every clip, not only the ones missing.
 *   --takes N  takes of "Yes, chef." to choose three from (default 6).
 *   --raw DIR  keep the model's raw takes there (default: a temp folder, removed).
 *
 * The key is read from GOOGLE_AI_API_KEY and never printed or written.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIP_TEXT, YES_CHEF_TAKES, clipUrl } from "../src/lib/kitchen/ack-clips";
import {
  LIMITS,
  PRICE,
  SUE_VOICE,
  callCostUsd,
  gainToTarget,
  pickTakesByPace,
  problemsWith,
  type Measured,
} from "./sue-clips";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "sounds", "sue");
const RECORD = join(HERE, "data", "sue-clips.json");
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

interface Spoken {
  wav: Buffer;
  inputTokens: number;
  outputTokens: number;
}

interface ClipRecord {
  name: string;
  text: string;
  take?: number;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  bytes: number;
  sha256: string;
}

/** What the record keeps of a finished clip file: its size and its SHA-256. */
function fileFacts(path: string): { bytes: number; sha256: string } {
  return { bytes: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

const flag = (name: string) => process.argv.includes(name);
const value = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

let calls = 0;
let spend = 0;

/** One call: the words in, a 24 kHz WAV out. Retries a busy or failing server twice. */
async function speak(text: string): Promise<Spoken> {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error("GOOGLE_AI_API_KEY is not set: nothing was called.");
  const body = JSON.stringify({
    model: SUE_VOICE.model,
    input: [
      {
        type: "user_input",
        content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: SUE_VOICE.style }] }],
      },
    ],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: SUE_VOICE.voice }] },
  });
  for (let attempt = 0; ; attempt++) {
    calls += 1;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`The speech model answered ${res.status} for "${text}": ${detail}`);
    }
    const json = (await res.json()) as {
      steps?: { type: string; content?: { data?: string; mime_type?: string }[] }[];
      usage?: { total_input_tokens?: number; total_output_tokens?: number };
    };
    const part = (json.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .at(-1);
    if (!part?.data || part.mime_type !== "audio/wav") {
      throw new Error(`The speech model gave no WAV for "${text}" (${part?.mime_type ?? "no content"}).`);
    }
    const inputTokens = json.usage?.total_input_tokens ?? 0;
    const outputTokens = json.usage?.total_output_tokens ?? 0;
    spend += callCostUsd(inputTokens, outputTokens);
    return { wav: Buffer.from(part.data, "base64"), inputTokens, outputTokens };
  }
}

const ffmpeg = (args: string[]): string => {
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new Error(`ffmpeg ${args.join(" ")} failed: ${stderr.slice(-400)}`);
  }
};

/** Length, peak and level of an audio file, by decoding it. */
function measure(file: string): Measured {
  // astats reports on stderr, so keep both streams.
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", file, "-af", "astats=metadata=0", "-f", "null", "-"], {
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`${file} does not decode: ${run.stderr.slice(-300)}`);
  const last = (label: string): number => {
    const found = [...run.stderr.matchAll(new RegExp(`${label}: (-?[0-9.]+|-inf)`, "g"))].at(-1);
    return found ? Number(found[1].replace("-inf", "-Infinity")) : NaN;
  };
  const seconds = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], {
      encoding: "utf8",
    }).trim(),
  );
  return { seconds, peakDb: last("Peak level dB"), rmsDb: last("RMS level dB") };
}

/** Trim the silence off both ends of a raw take. */
function trim(raw: string, out: string): void {
  const edge = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03";
  ffmpeg(["-i", raw, "-af", `${edge},areverse,${edge},areverse`, out]);
}

/** A trimmed take to its final file: one level, a short fade each end, a short tail, MP3. */
function finish(trimmed: string, out: string): Measured {
  const before = measure(trimmed);
  const gain = gainToTarget(before);
  const fadeOutAt = Math.max(0, before.seconds - 0.05);
  ffmpeg([
    "-i",
    trimmed,
    "-af",
    `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=disabled,afade=t=in:d=0.012,afade=t=out:st=${fadeOutAt.toFixed(3)}:d=0.05,apad=pad_dur=0.04`,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "48k",
    out,
  ]);
  return measure(out);
}

async function main() {
  const takes = Number(value("--takes") ?? 6);
  const force = flag("--force");
  const wanted = Object.entries(CLIP_TEXT).filter(([name]) => !(YES_CHEF_TAKES as readonly string[]).includes(name));
  const missing = (name: string) => force || !existsSync(join(OUT_DIR, `${name}.mp3`));
  const needChef = YES_CHEF_TAKES.some(missing);
  const plan = [...wanted.filter(([name]) => missing(name)).map(([name, text]) => ({ name, text, n: 1 })), ...(needChef ? [{ name: "yes-chef", text: CLIP_TEXT[YES_CHEF_TAKES[0]], n: takes }] : [])];
  const callsPlanned = plan.reduce((sum, p) => sum + p.n, 0);
  // At most ~3 s of audio a call: 25 audio tokens a second, at today's listed price.
  const mostUsd = callsPlanned * callCostUsd(10, 3 * 25);
  console.log(`Model ${SUE_VOICE.model}, voice ${SUE_VOICE.voice}.`);
  console.log(`Style: ${SUE_VOICE.style}`);
  console.log(`${callsPlanned} calls planned (${plan.map((p) => `${p.name}×${p.n}`).join(", ") || "none"}); at most $${mostUsd.toFixed(4)} at $${PRICE.audioOutputPerM}/M audio tokens.`);
  if (flag("--dry-run") || callsPlanned === 0) return;

  const raw = value("--raw") ?? mkdtempSync(join(tmpdir(), "sue-clips-"));
  mkdirSync(raw, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const records: ClipRecord[] = [];
  const problems: string[] = [];

  try {
    for (const { name, text, n } of plan) {
      if (name === "yes-chef") {
        const made: { take: number; seconds: number; trimmed: string }[] = [];
        for (let take = 1; take <= n; take++) {
          const spoken = await speak(text);
          const file = join(raw, `yes-chef-take-${take}.wav`);
          writeFileSync(file, spoken.wav);
          const trimmed = join(raw, `yes-chef-take-${take}-trimmed.wav`);
          trim(file, trimmed);
          made.push({ take, seconds: measure(trimmed).seconds, trimmed });
          console.log(`  yes-chef take ${take}: ${made.at(-1)?.seconds.toFixed(2)} s`);
        }
        // Quickest to slowest, named in that order.
        const kept = pickTakesByPace(made, YES_CHEF_TAKES.length);
        if (kept.length < YES_CHEF_TAKES.length) problems.push(`yes-chef: only ${kept.length} takes differ in pace; run again with more --takes`);
        kept.forEach((k, i) => {
          const clip = YES_CHEF_TAKES[i];
          const out = join(OUT_DIR, `${clip}.mp3`);
          const m = finish(made.find((t) => t.take === k.take)?.trimmed ?? "", out);
          problems.push(...problemsWith(clip, m));
          records.push({ name: clip, text, take: k.take, ...m, ...fileFacts(out) });
        });
        continue;
      }
      const spoken = await speak(text);
      const file = join(raw, `${name}.wav`);
      writeFileSync(file, spoken.wav);
      const trimmed = join(raw, `${name}-trimmed.wav`);
      trim(file, trimmed);
      const out = join(OUT_DIR, `${name}.mp3`);
      const m = finish(trimmed, out);
      problems.push(...problemsWith(name, m));
      records.push({ name, text, ...m, ...fileFacts(out) });
      console.log(`  ${name}: ${m.seconds.toFixed(2)} s, peak ${m.peakDb.toFixed(1)} dB, level ${m.rmsDb.toFixed(1)} dB`);
    }
  } finally {
    if (!value("--raw")) rmSync(raw, { recursive: true, force: true });
  }

  // The record keeps every clip from earlier runs that this one didn't redo.
  const earlier: { clips?: ClipRecord[] } = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
  const byName = new Map((earlier.clips ?? []).map((c) => [c.name, c]));
  for (const r of records) byName.set(r.name, r);
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(
    RECORD,
    `${JSON.stringify(
      {
        note: "Written by scripts/generate-sue-clips.ts. Generated speech; measured, not yet heard by a person.",
        model: SUE_VOICE.model,
        voice: SUE_VOICE.voice,
        style: SUE_VOICE.style,
        generatedAt: new Date().toISOString(),
        limits: LIMITS,
        clips: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${calls} calls, about $${spend.toFixed(5)} at the listed price. Files in ${OUT_DIR}; record in ${RECORD}.`);
  console.log(`Served as ${clipUrl("<name>")}.`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
