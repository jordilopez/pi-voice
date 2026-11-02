import { describe, it } from "node:test";
import assert from "node:assert";

import {
  APP,
  DEFAULT_BLOCKED_MESSAGE,
  MAX_MESSAGE_BYTES,
  formatBlocked,
  formatClear,
  isHerdrHost,
  shouldReport,
  writeStatus,
} from "./program-status.ts";

const decodeMsg = (seq: string): string => {
  const m = /:msg=([^]*)\x1b\\$/.exec(seq);
  assert.ok(m, `no msg field in ${JSON.stringify(seq)}`);
  return Buffer.from(m[1], "base64").toString("utf8");
};

describe("formatBlocked", () => {
  it("emits the exact OSC 7501 sequence", () => {
    assert.strictEqual(
      formatBlocked("hi"),
      `\x1b]7501;state=blocked:app=${APP}:kind=question:msg=${Buffer.from("hi").toString("base64")}\x1b\\`,
    );
  });

  it("starts with the OSC introducer and ends with ST", () => {
    const seq = formatBlocked(DEFAULT_BLOCKED_MESSAGE);
    assert.ok(seq.startsWith("\x1b]7501;"));
    assert.ok(seq.endsWith("\x1b\\"));
  });

  it("uses the documented fields", () => {
    const seq = formatBlocked("hi");
    assert.ok(seq.includes("state=blocked"));
    assert.ok(seq.includes(`app=${APP}`));
    assert.ok(seq.includes("kind=question"));
    assert.match(APP, /^[A-Za-z0-9_.+-]{1,32}$/);
  });

  it("base64-encodes UTF-8", () => {
    const seq = formatBlocked("héllo ✓");
    assert.strictEqual(decodeMsg(seq), "héllo ✓");
    assert.strictEqual(
      seq,
      `\x1b]7501;state=blocked:app=pi:kind=question:msg=${Buffer.from("héllo ✓", "utf8").toString("base64")}\x1b\\`,
    );
  });

  it("defaults to the fixed waiting message", () => {
    assert.strictEqual(decodeMsg(formatBlocked()), DEFAULT_BLOCKED_MESSAGE);
  });

  it("strips control characters", () => {
    const seq = formatBlocked("a\x1b]7501;evil\x07b\u009bc");
    assert.strictEqual(decodeMsg(seq), "a]7501;evilbc");
  });

  it("caps the decoded message at 2048 bytes", () => {
    const seq = formatBlocked("x".repeat(5000));
    assert.strictEqual(Buffer.byteLength(decodeMsg(seq), "utf8"), MAX_MESSAGE_BYTES);
  });

  it("does not split a multi-byte code point at the cap", () => {
    // 3-byte chars: 683 fit in 2048 (2049 > cap), so 2049 bytes must become 2046.
    const seq = formatBlocked("✓".repeat(1000));
    const decoded = decodeMsg(seq);
    assert.ok(Buffer.byteLength(decoded, "utf8") <= MAX_MESSAGE_BYTES);
    assert.strictEqual(decoded, "✓".repeat(682));
  });
});

describe("formatClear", () => {
  it("emits an idle report with the app id", () => {
    assert.strictEqual(formatClear(), `\x1b]7501;state=idle:app=${APP}\x1b\\`);
  });
});

const herdrEnv = { HC_TERMINAL_ID: "t1" };

describe("isHerdrHost", () => {
  it("accepts either Herdr env var", () => {
    assert.strictEqual(isHerdrHost({ HC_TERMINAL_ID: "t9" }), true);
    assert.strictEqual(isHerdrHost({ HC_TERMINAL_SOCKET: "/tmp/herdr.sock" }), true);
  });

  it("rejects a normal terminal", () => {
    assert.strictEqual(isHerdrHost({}), false);
    assert.strictEqual(isHerdrHost({ TERM: "xterm-256color" }), false);
  });
});

describe("shouldReport", () => {
  it("reports only in TUI mode on a Herdr TTY", () => {
    assert.strictEqual(shouldReport("tui", true, herdrEnv), true);
    assert.strictEqual(shouldReport("tui", true, {}), false);
    assert.strictEqual(shouldReport("tui", false, herdrEnv), false);
    assert.strictEqual(shouldReport("rpc", true, herdrEnv), false);
    assert.strictEqual(shouldReport("json", true, herdrEnv), false);
    assert.strictEqual(shouldReport("print", true, herdrEnv), false);
  });
});

describe("writeStatus", () => {
  it("swallows a synchronous write failure", () => {
    assert.doesNotThrow(() =>
      writeStatus("seq", () => {
        throw new Error("EPIPE");
      }),
    );
  });

  it("passes an error callback that ignores write errors", () => {
    let onError: ((err?: Error | null) => void) | undefined;
    assert.doesNotThrow(() =>
      writeStatus("seq", (_chunk, callback) => {
        onError = callback;
        return false;
      }),
    );
    assert.ok(onError);
    assert.doesNotThrow(() => onError?.(new Error("EPIPE")));
  });
});

