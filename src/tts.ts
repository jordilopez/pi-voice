// Text-to-speech via macOS `say`.
// Fire-and-forget: does not block the agent event loop.

import { sanitize } from "./text.js";

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
  /** Predefined phrases spoken (randomly) when a long reply finishes. */
  cues: string[];
  /** If a reply is shorter than this many chars, speak it directly without a cue. */
  shortReplyChars: number;
}

export const DEFAULT_SPEAKER: Speaker = {
  mode: "cue",
  voice: "Samantha",
  rate: 190,
  cues: [
    "job done",
    "waiting for your orders",
    "that's a wrap",
    "all sorted",
    "tasks slain",
    "back to you",
    "mic drop",
    "over to you",
    "at your service",
    "nothing more from me",
  ],
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
