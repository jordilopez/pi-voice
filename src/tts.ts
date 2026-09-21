// Text-to-speech via macOS `say`.
// Fire-and-forget: does not block the agent event loop.

export type Voice = string;

/**
 * How much the agent "says" when it finishes a turn:
 * - "cue"  : a single short phrase summarizing the outcome (default)
 * - "full" : the assistant's final text (truncated)
 * - "off"  : silent
 */
export type FeedbackMode = "cue" | "full" | "off";

export interface Speaker {
  mode: FeedbackMode;
  voice: Voice;
  rate: number; // words per minute for `say`
  /** Optional "provider/model" id to use for summarizing; defaults to the active model. */
  summaryModel?: string;
  /** If a reply is shorter than this many chars, speak it directly without summarizing. */
  shortReplyChars: number;
}

export const DEFAULT_SPEAKER: Speaker = {
  mode: "cue",
  voice: "Samantha",
  rate: 190,
  shortReplyChars: 60,
};

import type { ChildProcess } from "node:child_process";

let currentProcess: ChildProcess | null = null;

/** Speak `text`. Truncates to keep responses snappy. Cancels any in-flight speech first. */
export async function speak(
  text: string,
  speaker: Speaker,
  opts: { maxChars?: number; force?: boolean } = {},
): Promise<void> {
  if (speaker.mode === "off" && !opts.force) return;
  const clean = sanitize(text).slice(0, opts.maxChars ?? 500);
  if (!clean) return;

  stopSpeaking();

  const { spawn } = await import("node:child_process");
  currentProcess = spawn(
    "say",
    ["-v", speaker.voice, "-r", String(speaker.rate), clean],
    { stdio: "ignore" },
  );
  currentProcess.on("exit", () => {
    currentProcess = null;
  });
  currentProcess.on("error", () => {
    currentProcess = null;
  });
}

/** Stop any currently playing speech (e.g. when a new turn starts). */
export function stopSpeaking(): void {
  if (currentProcess) {
    currentProcess.kill("SIGTERM");
    currentProcess = null;
  }
}

/** Strip markdown/code noise so speech is not full of backticks and URLs. */
function sanitize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown links -> label
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^[\s]*[-*+]\s+/gm, "") // list bullets
    .replace(/^[\s]*\d+\.\s+/gm, "") // numbered lists
    .replace(/[*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
