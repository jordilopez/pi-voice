import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
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
    if (cfg.speaker) Object.assign(speaker, cfg.speaker);
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

/** Returns { matched, phrase }. `phrase` is the text to send if matched. */
function stripCatchphrase(text: string): { matched: boolean; phrase: string } {
  const raw = (text ?? "").trim();
  const cp = dictation.catchphrase.trim().toLowerCase();
  if (!cp) return { matched: false, phrase: raw };

  const core = raw.replace(/[.!?\s]+$/g, ""); // drop trailing punctuation/space
  const low = core.toLowerCase();
  if (low === cp) return { matched: true, phrase: "" }; // said only the trigger
  const before = low.slice(0, Math.max(0, low.length - cp.length));
  // require the trigger to be its own trailing word (preceded by space/punct)
  if (low.endsWith(cp) && /(^|[\s,;:])$/.test(before)) {
    const phrase = core.slice(0, core.length - cp.length).replace(/[\s,;:.!?]+$/g, "").trim();
    return { matched: true, phrase };
  }
  return { matched: false, phrase: raw };
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

/** Resolve the model to use for summarization (optional cheaper model, else active). */
function pickSummaryModel(ctx: ExtensionContext) {
  const reg = ctx?.modelRegistry;
  if (!reg) return null;
  if (typeof speaker.summaryModel === "string" && speaker.summaryModel.includes("/")) {
    const [provider, id] = speaker.summaryModel.split("/", 2);
    return reg.find(provider, id) ?? null;
  }
  return ctx.model ?? null;
}

/** Trim to at most `maxWords` words at a word boundary. */
function shortPhrase(text: string, maxWords = 5): string {
  const plain = text.replace(/\s+/g, " ").trim();
  const words = plain.split(" ");
  if (words.length <= maxWords) return plain;
  return words.slice(0, maxWords).join(" ");
}

/**
 * Condense the assistant's reply into ONE short spoken phrase that summarizes
 * the outcome. Returns null on any failure so the caller can fall back.
 */
async function summarizeToPhrase(ctx: ExtensionContext, text: string): Promise<string | null> {
  const model = pickSummaryModel(ctx);
  if (!model) return null;
  if (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(model)) {
    return null;
  }
  const prompt = [
    "Condense the assistant's reply below into a HEADLINE of 3 to 5 words max.",
    "It should convey the outcome so the user notices when they look back.",
    "No quotes, no ending punctuation, no articles (a/an/the).",
    "Output ONLY the words — nothing else.",
    "",
    "<reply>",
    text.slice(0, 4000),
    "</reply>",
  ].join("\n");
  const messages = [
    { role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
  ];
  const resp = await ctx.modelRegistry.complete(model, { messages }, {
    cacheRetention: "none",
    sessionId: uuidv7(),
  });
  const phrase = resp.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join(" ")
    .replace(/^[\s"']+|[\s"']+\.?$/g, "")
    .trim();
  return phrase ? shortPhrase(phrase, 5) : null;
}

export default function (pi: ExtensionAPI) {
  // ---- OUTBOUND: speak a short summary of the outcome each turn -----------
  // Use agent_settled (not agent_end) because agent_end fires on every low-level
  // run, including retries/compaction. agent_settled fires only when Pi won't
  // continue automatically.
  pi.on("agent_settled", async (_event, ctx) => {
    const text = lastAssistantText(ctx.sessionManager.getBranch());
    if (!text || text === lastSpoken) return;

    let phrase: string;
    let cap: number;
    if (speaker.mode === "full") {
      phrase = text;
      cap = 500;
    } else if (speaker.mode === "cue") {
      phrase = shortPhrase(text, 5);
      cap = 40;
      if (text.length > speaker.shortReplyChars) {
        phrase = shortPhrase(
          (await summarizeToPhrase(ctx, text).catch(() => null)) ?? phrase,
          5,
        );
      }
    } else {
      return; // off
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

  // When the agent asks the user something, announce it immediately.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ask_user") return;
    if (speaker.mode === "off") return;
    await speak("I've got a question", speaker, { force: true, maxChars: 60 }).catch(
      (err) => ctx.ui?.notify?.(`voice TTS failed: ${err.message}`, "error"),
    );
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
      const { matched, phrase } = stripCatchphrase(text);
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
        `Summary model (now: ${speaker.summaryModel ?? "active"})`,
        `STT backend (now: ${transcriber.kind})`,
      ]);
      if (!choice) return;
      if (choice.startsWith("Feedback mode")) {
        const mode = await ctx.ui.select(
          "Feedback mode",
          ["cue — one short summary phrase", "full — speak the answer", "off — silent"],
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
      } else if (choice.startsWith("Summary model")) {
        const v = await ctx.ui.input(
          "Summary model (provider/model, blank = active model)",
          speaker.summaryModel ?? "",
        );
        if (v === undefined) return;
        speaker.summaryModel = v.trim() || undefined;
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
