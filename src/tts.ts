// Text-to-speech via macOS `say`.
// Fire-and-forget: does not block the agent event loop.

import { sanitize } from "./text.js";

export type Voice = string;

/**
 * How much the agent "says" when it finishes a turn:
 * - "cue"  : a random attention-getting phrase from a static pool (default)
 * - "full" : the assistant's final text (truncated)
 * - "off"  : silent
 */
export type FeedbackMode = "cue" | "full" | "off";

export interface Speaker {
  mode: FeedbackMode;
  voice: Voice;
  rate: number; // words per minute for `say`
}

export const DEFAULT_SPEAKER: Speaker = {
  mode: "cue",
  voice: "Samantha",
  rate: 190,
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
