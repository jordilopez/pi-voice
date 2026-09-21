// Push-to-talk speech-to-text.
// 1. Record mic to a temp WAV with `ffmpeg` (macOS AVFoundation input).
// 2. Transcribe the WAV with a pluggable backend.
//
// Recording is toggled: start() spawns ffmpeg, stop() sends SIGINT so the file
// finalizes, then we transcribe.

import type { ChildProcess } from "node:child_process";

export interface Recorder {
  /** ffmpeg AVFoundation audio device index ("0" -> "-i :0"). */
  audioDevice: string;
  /** Hard cap on a single recording (ms) so a stuck/denied mic can't run forever. */
  maxRecordMs: number;
}

export const DEFAULT_RECORDER: Recorder = {
  // AVFoundation wants a numeric index; 0 is the built-in mic on most Macs.
  audioDevice: "0",
  maxRecordMs: 30_000,
};

let recordProcess: ChildProcess | null = null;
let currentTempFile: string | null = null;
let recordTimer: ReturnType<typeof setTimeout> | null = null;
let stopResolve: (() => void) | null = null;
let lastRecordingError: string | null = null;

/** Last reason recording failed to start, if any. */
export function getRecordingError(): string | null {
  return lastRecordingError;
}

/** Start recording from the microphone. Returns true if recording began. */
export async function startRecording(recorder: Recorder): Promise<boolean> {
  if (recordProcess) return false; // already recording
  lastRecordingError = null;

  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  currentTempFile = path.join(tmpdir(), `pi-voice-${Date.now()}.wav`);

  // -f avfoundation audio-only capture; "-i :<device>" selects the input.
  const proc = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      `:${recorder.audioDevice}`,
      "-ac",
      "1", // mono
      "-ar",
      "16000", // 16k, ideal for whisper
      "-y",
      currentTempFile,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  recordProcess = proc;

  const stderr: Buffer[] = [];
  proc.stderr?.on("data", (d) => stderr.push(d));

  proc.on("exit", (code) => {
    recordProcess = null;
    if (code !== 0) {
      const out = Buffer.concat(stderr).toString("utf8").trim();
      lastRecordingError = out
        ? `ffmpeg exited (${code}): ${out.split("\n").slice(-3).join(" ")}`
        : `ffmpeg exited with code ${code}`;
    }
    stopResolve?.();
    stopResolve = null;
  });
  proc.on("error", (err) => {
    recordProcess = null;
    lastRecordingError = `could not start ffmpeg: ${err.message}`;
    stopResolve?.();
    stopResolve = null;
  });

  // Wait until ffmpeg either dies (failed to open the device) or stays alive
  // long enough to assume the mic opened successfully.
  const alive = await new Promise<boolean>((resolve) => {
    const to = setTimeout(() => resolve(true), 500);
    const onExit = () => {
      clearTimeout(to);
      resolve(false);
    };
    proc.on("exit", onExit);
    proc.on("error", onExit);
  });
  if (!alive) {
    recordProcess = null;
    currentTempFile = null;
    return false;
  }

  // Auto-stop safety: if the user forgets to press again (or the mic is
  // blocked by a permission prompt), don't record forever.
  recordTimer = setTimeout(() => {
    if (recordProcess) recordProcess.kill("SIGINT");
  }, recorder.maxRecordMs);
  return true;
}

/**
 * Stop recording and return the temp WAV path, or null if nothing was ever
 * recorded. Works even if the safety timer already auto-stopped ffmpeg.
 */
export async function stopRecording(): Promise<string | null> {
  if (recordTimer) {
    clearTimeout(recordTimer);
    recordTimer = null;
  }
  if (!currentTempFile) return null; // never started
  const file = currentTempFile;
  currentTempFile = null;

  // If ffmpeg is still running, SIGINT flushes the WAV trailer and we await exit.
  if (recordProcess) {
    await new Promise<void>((resolve) => {
      stopResolve = resolve;
      recordProcess?.kill("SIGINT");
      const timeout = setTimeout(() => {
        stopResolve = null;
        resolve();
      }, 1500);
      // Clear the timeout if the process exits before 1500ms.
      recordProcess?.once("exit", () => {
        clearTimeout(timeout);
        stopResolve?.();
        stopResolve = null;
      });
    });
  }
  return file;
}

/** Abort recording without producing output. */
export async function cancelRecording(): Promise<void> {
  if (recordTimer) {
    clearTimeout(recordTimer);
    recordTimer = null;
  }
  if (recordProcess) recordProcess.kill("SIGKILL");
  recordProcess = null;
  // Clean up the temp file if it exists.
  if (currentTempFile) {
    const { unlink } = await import("node:fs/promises");
    await unlink(currentTempFile).catch(() => {});
    currentTempFile = null;
  }
}

export interface Transcriber {
  kind: "whisper-cli" | "openai";
  /** For whisper-cli: resolved binary name/path. */
  whisperBin?: string;
  /** For whisper-cli: path to a ggml model (e.g. ggml-base.en.bin). If omitted, the binary's default is used. */
  whisperModel?: string;
  /** For openai: model + key. Key read from env if omitted. */
  model?: string;
  apiKeyEnv?: string;
}

export const DEFAULT_TRANSCRIBER: Transcriber = {
  kind: "whisper-cli",
  whisperBin: undefined, // resolved by detectTranscriber
  whisperModel: undefined,
  model: "whisper-1",
  apiKeyEnv: "OPENAI_API_KEY",
};

const WHISPER_CANDIDATES = ["whisper-cpp", "whisper-cli", "whisper", "main"];

/** Look for a ggml model in the usual Homebrew/cache locations. */
async function findWhisperModel(): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  // Specific paths where whisper.cpp models are typically installed.
  const dirs = [
    "/opt/homebrew/share/whisper-cpp/models",
    "/opt/homebrew/share/whisper-cpp",
    process.env.HOME ? join(process.env.HOME, ".cache/whisper-cpp") : undefined,
  ].filter(Boolean) as string[];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir);
      const model = entries.find((e) => /^ggml-.*\.bin$/.test(e));
      if (model) return join(dir, model);
    } catch {
      /* ignore */
    }
  }
  // Also check $HOME directly for a model file (user downloaded manually).
  if (process.env.HOME) {
    try {
      const entries = await readdir(process.env.HOME);
      const model = entries.find((e) => /^ggml-.*\.bin$/.test(e));
      if (model) return join(process.env.HOME, model);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Pick a usable backend: prefer a local whisper.cpp binary, otherwise the
 * OpenAI API when a key is present. Returns null if neither is available.
 */
export async function detectTranscriber(
  t: Transcriber,
): Promise<Transcriber | null> {
  const { execFile } = await import("node:child_process");
  const candidates = t.whisperBin ? [t.whisperBin] : WHISPER_CANDIDATES;
  let bin: string | undefined;
  for (const c of candidates) {
    const found = await new Promise<boolean>((resolve) => {
      // `command -v` resolves on PATH regardless of the binary's exit code.
      execFile("bash", ["-lc", `command -v ${JSON.stringify(c)}`], (err) =>
        resolve(!err),
      );
    });
    if (found) {
      bin = c;
      break;
    }
  }
  if (bin) {
    const model = t.whisperModel ?? (await findWhisperModel());
    return { ...t, kind: "whisper-cli", whisperBin: bin, whisperModel: model };
  }
  if (process.env[t.apiKeyEnv ?? "OPENAI_API_KEY"]) {
    return { ...t, kind: "openai" };
  }
  return null;
}

/** Transcribe a WAV file into text using the configured backend. */
export async function transcribe(
  wavPath: string,
  t: Transcriber,
): Promise<string> {
  if (t.kind === "whisper-cli") {
    return transcribeWhisperCli(wavPath, t);
  }
  return transcribeOpenAI(wavPath, t);
}

async function transcribeWhisperCli(
  wavPath: string,
  t: Transcriber,
): Promise<string> {
  const { spawn } = await import("node:child_process");
  const bin = t.whisperBin ?? "whisper-cpp";
  const args = ["-f", wavPath, "-nt", "-np"]; // no timestamps, no system prints
  if (t.whisperModel) args.push("-m", t.whisperModel);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(bin, args);
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", () => {});
    proc.on("error", (err) =>
      reject(new Error(`Failed to run ${bin}: ${err.message}`)),
    );
    proc.on("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function transcribeOpenAI(
  wavPath: string,
  t: Transcriber,
): Promise<string> {
  const key = process.env[t.apiKeyEnv ?? "OPENAI_API_KEY"];
  if (!key) throw new Error(`Missing ${t.apiKeyEnv ?? "OPENAI_API_KEY"} env var`);

  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(wavPath);

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "pi-voice.wav");
  form.append("model", t.model ?? "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
