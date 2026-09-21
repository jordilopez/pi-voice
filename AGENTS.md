# AGENTS.md

## Project: /Users/jordi/development/pi-voice

Voice commands (push-to-talk STT) and spoken feedback (TTS) for pi-coding-agent,
distributed as a Pi package.

## Platform support

**Tested on macOS only.** TTS uses macOS `say`; mic capture uses ffmpeg's
AVFoundation input. Linux and Windows are untested and will not work as-is —
supporting them means swapping the TTS and capture backends.

## Selected modules
- Git
- npm
- .nvmrc
- Environment
- Prettier
- ESLint
- EditorConfig
- README
- AGENTS
- TypeScript

## Structure

```
index.ts        auto-discovery entry (re-exports src/index.ts)
src/index.ts    extension factory: events, shortcut, commands
src/tts.ts      macOS `say` speech synthesis (cancellable)
src/stt.ts      ffmpeg AVFoundation capture + pluggable transcription
src/text.ts     pure text helpers (shortPhrase, stripCatchphrase, sanitize, topicFallback)
src/index.test.ts  tests for src/text.ts
```

## Working on this project

Run these before committing:

```bash
npm run check                 # tsc --noEmit
node --test src/index.test.ts # unit tests
pi -e ./index.ts              # smoke test: loads without errors
```

Runtime requirements are listed in `README.md` (whisper.cpp or `OPENAI_API_KEY`,
plus macOS Microphone permission for the terminal app).

User-facing settings persist to `~/.pi/agent/pi-voice.json`. Do not commit that
file; it's user state, not project state.

## Conventions

Keep changes focused, documented, and consistent with the project's existing patterns.
Pure logic lives in `src/text.ts` so it stays unit-testable without the pi runtime;
pi-runtime-dependent code (events, `ctx.*`, spawning binaries) stays in the
feature modules.
