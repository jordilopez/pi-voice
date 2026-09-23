// Pure text helpers shared by the extension and its tests.
// No pi/runtime dependencies — safe to unit test in isolation.

/** Trim `text` to at most `maxWords` words at a word boundary. */
export function shortPhrase(text: string, maxWords = 5): string {
  const plain = text.replace(/\s+/g, " ").trim();
  const words = plain.split(" ");
  if (words.length <= maxWords) return plain;
  return words.slice(0, maxWords).join(" ");
}

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

/**
 * Heuristic fallback topic for a question when no model summary is available:
 * strips leading interrogatives and trailing punctuation so "Should I use
 * Postgres or MySQL?" becomes "use Postgres or MySQL".
 */
export function topicFallback(question: string): string {
  const base = question.replace(/[?!.\s]+$/g, "").trim();
  const cleaned = base
    .replace(
      /^(should (i|we)|do (you|we)|can (you|we)|how (do|should) (i|we)|what|which|where|when|why|is it|are we)\b[,\s]*/i,
      "",
    )
    .trim();
  return shortPhrase(cleaned || base || question.trim(), 6);
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

/** Pick a random question cue from the pool. */
export function pickQuestionCue(): string {
  return QUESTION_CUES[Math.floor(Math.random() * QUESTION_CUES.length)];
}