// OSC 7501 program-status reports for Herdr.
// Pure formatters + guards only — the extension writes the returned strings to
// process.stdout. See README for the protocol.

// Local mirror of Pi's ExtensionMode — the package root does not re-export it.
export type ProgramStatusMode = "tui" | "rpc" | "json" | "print";

/** App id shown by the host. Must match /^[A-Za-z0-9_.+-]{1,32}$/. */
export const APP = "pi";

/** Herdr shows `msg` verbatim in a narrow header, so keep it short. */
export const DEFAULT_BLOCKED_MESSAGE = "Waiting for your answer";

/** Decoded `msg` payload cap from the OSC 7501 spec. */
export const MAX_MESSAGE_BYTES = 2048;

// C0 controls, DEL, and C1 controls. ESC/BEL inside `msg` would otherwise
// terminate or corrupt the sequence.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Strip control characters and truncate to a valid UTF-8 boundary. */
function sanitizeMessage(message: string): string {
  const clean = (message ?? "").replace(CONTROL_CHARS, "");
  if (Buffer.byteLength(clean, "utf8") <= MAX_MESSAGE_BYTES) return clean;

  // Walk characters so the cut never splits a multi-byte code point.
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > MAX_MESSAGE_BYTES) break;
    out += ch;
    used += n;
  }
  return out;
}

/** OSC 7501 blocked report, terminated with ST (`ESC \`). */
export function formatBlocked(
  message: string = DEFAULT_BLOCKED_MESSAGE,
): string {
  const msg = Buffer.from(sanitizeMessage(message), "utf8").toString("base64");
  return `\x1b]7501;state=blocked:app=${APP}:kind=question:msg=${msg}\x1b\\`;
}

/** OSC 7501 idle report, used to clear the blocked badge. */
export function formatClear(): string {
  return `\x1b]7501;state=idle:app=${APP}\x1b\\`;
}

/**
 * Herdr injects these into every pane. Either one is enough; both missing
 * means this is some other terminal and the sequence must not be written.
 */
export function isHerdrHost(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.HC_TERMINAL_ID || env.HC_TERMINAL_SOCKET);
}

/**
 * Only write program status into a Herdr TTY attached to the TUI.
 * Never emit escapes into print/json/rpc output, a redirected stdout, or a
 * terminal that will not consume OSC 7501.
 */
export function shouldReport(
  mode: ProgramStatusMode,
  isTTY: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return mode === "tui" && isTTY && isHerdrHost(env);
}

/**
 * Write a status sequence. A missing or closed stdout must not fail the
 * ask_user flow — the badge is best-effort. The error callback keeps a closed
 * pipe from surfacing as an unhandled stream error.
 */
export function writeStatus(
  sequence: string,
  write: (
    chunk: string,
    onError?: (err?: Error | null) => void,
  ) => boolean = (chunk, onError) => process.stdout.write(chunk, onError),
): void {
  try {
    write(sequence, () => {});
  } catch {
    // Host went away, or stdout is not writable. Drop the badge.
  }
}

