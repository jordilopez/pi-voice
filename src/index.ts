import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { stat, unlink, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  DEFAULT_SPEAKER,
  type Speaker,
  speak,
  stopSpeaking,
} from "./tts.js";
import { pickOutcomeCue, pickQuestionCue, stripCatchphrase } from "./text.js";
import {
  cancelRecording,
  DEFAULT_RECORDER,
  DEFAULT_TRANSCRIBER,
  detectTranscriber,
  getRecordingError,
  type Recorder,
  startRecording,
  stopRecording,
  transcribe,
  type Transcriber,
} from "./stt.js";

// ---- in-memory config (toggle with /voice-config) --------------------------
const speaker: Speaker = { ...DEFAULT_SPEAKER };
const recorder: Recorder = { ...DEFAULT_RECORDER };
const transcriber: Transcriber = { ...DEFAULT_TRANSCRIBER };

// Dictation behavior: if a transcribed phrase ENDS with this trigger word
// (e.g. "copy"), the catchphrase is stripped and the rest is SENT directly to the
// model (no Enter). Otherwise the text just goes to the editor for review.
// Set to "" to disable auto-send.
const dictation = { catchphrase: "copy" };

// Config persistence
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-voice.json");

async function loadConfig(): Promise<void> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg.speaker) {
      // Whitelist known keys so stale fields (summaryModel, shortReplyChars)
      // never creep back into the saved config.
      if (cfg.speaker.mode) speaker.mode = cfg.speaker.mode;
      if (cfg.speaker.voice) speaker.voice = cfg.speaker.voice;
      if (typeof cfg.speaker.rate === "number") speaker.rate = cfg.speaker.rate;
    }
    if (cfg.recorder) Object.assign(recorder, cfg.recorder);
    if (cfg.transcriber) Object.assign(transcriber, cfg.transcriber);
    if (cfg.dictation) Object.assign(dictation, cfg.dictation);
  } catch {
    // Config file doesn't exist or is invalid — use defaults.
  }
}

async function saveConfig(): Promise<void> {
  try {
    await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    const cfg = { speaker, recorder, transcriber, dictation };
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    // Silently fail — config persistence is best-effort.
  }
}

/** Extract the last assistant text from session entries. */
function lastAssistantText(entries: any[] | undefined): string {
  if (!entries) return "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const content = e.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const t = content
        .filter((b: any) => b?.type === "text" && b.text)
        .map((b: any) => b.text)
        .join(" ");
      if (t.trim()) return t;
    }
  }
  return "";
}

let lastSpoken = "";

/** Speak a randomly-picked cue for an `ask_user` prompt without making another LLM call. */
async function announceQuestion(ctx: ExtensionContext): Promise<void> {
  await speak(pickQuestionCue(), speaker, { force: true, maxChars: 100 }).catch((err) =>
    ctx.ui?.notify?.(`voice TTS failed: ${err.message}`, "error"),
  );
}

export default function (pi: ExtensionAPI) {
  // ---- OUTBOUND: speak a random attention-getting phrase after each turn ---
  // Use agent_settled (not agent_end) because agent_end fires on every low-level
  // run, including retries/compaction. agent_settled fires only when Pi won't
  // continue automatically. In "full" mode we speak the reply verbatim; in
  // "cue" mode we pick a random phrase from the static OUTCOME_CUES pool.
  pi.on("agent_settled", async (_event, ctx) => {
    if (speaker.mode === "off") return;

    const text = lastAssistantText(ctx.sessionManager.getBranch());
    if (!text || text === lastSpoken) return;

    let phrase: string;
    let cap: number;
    if (speaker.mode === "full") {
      phrase = text;
      cap = 500;
    } else {
      // "cue" — pick a random attention-getting phrase from the static pool.
      // No LLM call: the cue is a pure notification that the agent's turn
      // has settled; the user reads the outcome from the terminal.
      phrase = pickOutcomeCue();
      cap = 40;
    }

    // Only update lastSpoken when we're actually going to speak.
    lastSpoken = text;
    await speak(phrase, speaker, { force: true, maxChars: cap }).catch((err) =>
      ctx.ui?.notify?.(`voice TTS failed: ${err.message}`, "error"),
    );
  });

  // Cancel stale speech the moment a new user prompt starts.
  pi.on("before_agent_start", async () => {
    stopSpeaking();
  });

  // When the agent asks the user something, announce the topic immediately.
  // Don't await the model round-trip here: the ask_user prompt should appear
  // without waiting on summarization. The speech catches up on its own.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ask_user" || speaker.mode === "off") return;
    void announceQuestion(ctx);
  });

  // ---- INBOUND: push-to-talk dictation -------------------------------------
  let recording = false;
  async function toggleDictation(ctx: ExtensionContext) {
    if (!recording) {
      recording = true;
      const started = await startRecording(recorder);
      if (!started) {
        recording = false;
        const detail = getRecordingError() ?? "unknown error";
        ctx.ui.notify(
          `Could not start mic recording — ${detail}. ` +
            `Check Microphone permission for your terminal ` +
            `(System Settings ▸ Privacy & Security ▸ Microphone) and the audio device index in src/index.ts.`,
          "error",
        );
        return;
      }
      ctx.ui.setStatus?.("voice", "🎙 recording — press again to stop");
      ctx.ui.notify("Recording… press Ctrl+Shift+V again to send", "info");
      return;
    }

    // second press: stop + transcribe + inject
    recording = false;
    const wav = await stopRecording();
    ctx.ui.setStatus?.("voice", "transcribing…");
    if (!wav) {
      ctx.ui.notify?.("Nothing recorded", "error");
      return;
    }
    try {
      // A denied/empty capture yields a tiny file; bail out early.
      const size = wav ? (await stat(wav)).size : 0;
      if (!wav || size < 1024) {
        ctx.ui.notify(
          "No audio captured — check Terminal has Microphone permission (System Settings ▸ Privacy & Security ▸ Microphone)",
          "error",
        );
        return;
      }
      const text = await transcribe(wav, transcriber);
      if (!text) {
        ctx.ui.notify("No speech detected", "info");
        return;
      }
      const { matched, phrase } = stripCatchphrase(text, dictation.catchphrase);
      if (matched) {
        if (phrase) {
          // Trigger word present → send straight to the model (no Enter).
          // Guard against streaming: if agent is busy, queue as followUp.
          const opts = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
          pi.sendUserMessage(phrase, opts);
          ctx.ui.notify(`🎤 Sent: ${phrase}`, "info");
        } else {
          ctx.ui.notify(`Heard only "${dictation.catchphrase}" — nothing to send`, "info");
        }
      } else {
        // No trigger → drop in the editor so you can review before sending.
        ctx.ui.setEditorText?.(text);
        ctx.ui.notify(`Heard (in editor, add "${dictation.catchphrase || "<trigger>"}" to send): ${text}`, "info");
      }
    } catch (err: any) {
      ctx.ui.notify(`Voice input failed: ${err.message}`, "error");
    } finally {
      ctx.ui.setStatus?.("voice", undefined);
      await unlink(wav).catch(() => {});
    }
  }

  pi.registerShortcut(Key.ctrlShift("v"), {
    description: "Push-to-talk dictation (start/stop)",
    handler: async (ctx) => {
      await toggleDictation(ctx);
    },
  });

  // ---- commands -------------------------------------------------------------
  pi.registerCommand("speak", {
    description: "Speak the given text aloud",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /speak <text>", "info");
        return;
      }
      await speak(args, speaker, { force: true });
    },
  });

  pi.registerCommand("voice-stop", {
    description: "Stop current speech / cancel recording",
    handler: async (_args, ctx) => {
      stopSpeaking();
      if (recording) {
        cancelRecording();
        recording = false;
        ctx.ui.setStatus?.("voice", undefined);
      }
      ctx.ui.notify("Voice stopped", "info");
    },
  });

  pi.registerCommand("voice-config", {
    description: "Choose voice feedback mode / TTS voice / STT backend",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Voice config", [
        `Feedback mode (now: ${speaker.mode})`,
        `TTS voice (now: ${speaker.voice})`,
        `Send catchphrase (now: ${dictation.catchphrase || "off"})`,
        `STT backend (now: ${transcriber.kind})`,
      ]);
      if (!choice) return;
      if (choice.startsWith("Feedback mode")) {
        const mode = await ctx.ui.select(
          "Feedback mode",
          ["cue — one short attention phrase", "full — speak the answer", "off — silent"],
        );
        if (mode?.startsWith("cue")) speaker.mode = "cue";
        else if (mode?.startsWith("full")) speaker.mode = "full";
        else if (mode?.startsWith("off")) {
          speaker.mode = "off";
          stopSpeaking();
        }
      } else if (choice.startsWith("TTS voice")) {
        const v = await ctx.ui.input("TTS voice name", speaker.voice);
        if (v) speaker.voice = v;
      } else if (choice.startsWith("Send catchphrase")) {
        const v = await ctx.ui.input(
          "Trigger word that, when it ends a phrase, sends it to the model (blank = disable auto-send)",
          dictation.catchphrase,
        );
        if (v === undefined) return;
        dictation.catchphrase = v.trim();
        ctx.ui.notify(
          dictation.catchphrase
            ? `Auto-send on "${dictation.catchphrase}"`
            : "Auto-send disabled (always drops in editor)",
          "info",
        );
        return;
      } else if (choice.startsWith("STT backend")) {
        const kind = await ctx.ui.select("STT backend", [
          "whisper-cli (local whisper.cpp)",
          "openai (cloud, needs OPENAI_API_KEY)",
        ]);
        if (kind?.startsWith("openai")) transcriber.kind = "openai";
        else if (kind) transcriber.kind = "whisper-cli";
      }
      ctx.ui.notify(
        `feedback=${speaker.mode}, stt=${transcriber.kind}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_e, ctx) => {
    await loadConfig();
    const detected = await detectTranscriber(transcriber);
    let sttNote = "";
    if (detected) {
      transcriber.kind = detected.kind;
      if (detected.whisperBin) transcriber.whisperBin = detected.whisperBin;
      if (detected.whisperModel) transcriber.whisperModel = detected.whisperModel;
      sttNote =
        transcriber.kind === "whisper-cli" && !transcriber.whisperModel
          ? "stt=whisper-cli (no model found; set whisperModel)"
          : `stt=${transcriber.kind}`;
    } else {
      sttNote = "no STT backend — install whisper.cpp or set OPENAI_API_KEY";
    }
    ctx.ui.notify(
      `pi-voice ready (${sttNote}) — Ctrl+Shift+V dictate · /speak · /voice-config`,
      detected ? "info" : "warning",
    );
  });

  // Clean up any mic/voice process on shutdown and persist config.
  pi.on("session_shutdown", async () => {
    stopSpeaking();
    cancelRecording();
    await saveConfig();
  });
}
