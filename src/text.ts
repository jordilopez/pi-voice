// Pure text helpers shared by the extension and its tests.
// No pi/runtime dependencies — safe to unit test in isolation.

/**
 * If `text` ends with `catchphrase` (as its own trailing word), strip it and
 * return the remainder. Returns `{ matched: false }` when it doesn't end with
 * the catchphrase. A lone catchphrase yields `{ matched: true, phrase: "" }`.
 */
export function stripCatchphrase(
  text: string,
  catchphrase: string,
): { matched: boolean; phrase: string } {
  const raw = (text ?? "").trim();
  const cp = catchphrase.trim().toLowerCase();
  if (!cp) return { matched: false, phrase: raw };

  const core = raw.replace(/[.!?\s]+$/g, ""); // drop trailing punctuation/space
  const low = core.toLowerCase();
  if (low === cp) return { matched: true, phrase: "" }; // said only the trigger
  const before = low.slice(0, Math.max(0, low.length - cp.length));
  // require the trigger to be its own trailing word (preceded by space/punct)
  if (low.endsWith(cp) && /(^|[\s,;:])$/.test(before)) {
    const phrase = core
      .slice(0, core.length - cp.length)
      .replace(/[\s,;:.!?]+$/g, "")
      .trim();
    return { matched: true, phrase };
  }
  return { matched: false, phrase: raw };
}

/** Strip markdown/code noise so speech is not full of backticks and URLs. */
export function sanitize(text: string): string {
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

// ---- Question announcement cue pool ------------------------------------------

/**
 * Attention-getting phrases for `ask_user` announcements.
 * A random one is picked each time to avoid monotony.
 */
export const QUESTION_CUES = [
  "I've got a question",
  "A question for you",
  "Hey, I need your input",
  "Your attention please",
  "Question incoming",
  "Quick question",
  "Ping!",
] as const satisfies readonly string[];

export type QuestionCue = (typeof QUESTION_CUES)[number];

/** Pick a random element from a pool. The return type mirrors the pool's element type. */
export function pickFromPool<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Pick a random question cue from the pool. */
export function pickQuestionCue(): QuestionCue {
  return pickFromPool(QUESTION_CUES);
}

// ---- Outcome announcement cue pool ------------------------------------------

/**
 * Attention-getting phrases said when an agent turn has settled.
 * Pure attention-cue; does not summarise the outcome — the user reads that
 * from the terminal. Picked randomly so consecutive turns don't repeat.
 */
export const OUTCOME_CUES = [
  "I'm done",
  "Ready for you",
  "That's it",
  "Back to you",
  "All done",
  "Your turn",
  "Finished",
] as const satisfies readonly string[];

export type OutcomeCue = (typeof OUTCOME_CUES)[number];

/** Pick a random outcome cue from the pool. */
export function pickOutcomeCue(): OutcomeCue {
  return pickFromPool(OUTCOME_CUES);
}