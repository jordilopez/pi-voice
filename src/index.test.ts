import { describe, it } from "node:test";
import assert from "node:assert";

// Test stripCatchphrase logic
describe("stripCatchphrase", () => {
  const dictation = { catchphrase: "copy" };

  function stripCatchphrase(text: string): { matched: boolean; phrase: string } {
    const raw = (text ?? "").trim();
    const cp = dictation.catchphrase.trim().toLowerCase();
    if (!cp) return { matched: false, phrase: raw };

    const core = raw.replace(/[.!?\s]+$/g, "");
    const low = core.toLowerCase();
    if (low === cp) return { matched: true, phrase: "" };
    const before = low.slice(0, Math.max(0, low.length - cp.length));
    if (low.endsWith(cp) && /(^|[\s,;:])$/.test(before)) {
      const phrase = core.slice(0, core.length - cp.length).replace(/[\s,;:.!?]+$/g, "").trim();
      return { matched: true, phrase };
    }
    return { matched: false, phrase: raw };
  }

  it("matches trailing catchphrase", () => {
    const result = stripCatchphrase("refactor the auth module, copy");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.phrase, "refactor the auth module");
  });

  it("matches catchphrase with space separator", () => {
    const result = stripCatchphrase("run the tests copy");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.phrase, "run the tests");
  });

  it("matches catchphrase with trailing punctuation", () => {
    const result = stripCatchphrase("deploy to staging, copy.");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.phrase, "deploy to staging");
  });

  it("returns empty phrase when only catchphrase is spoken", () => {
    const result = stripCatchphrase("copy");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.phrase, "");
  });

  it("does not match mid-sentence catchphrase", () => {
    const result = stripCatchphrase("I am copying the file");
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.phrase, "I am copying the file");
  });

  it("does not match when catchphrase is not at end", () => {
    const result = stripCatchphrase("copy that and do the thing");
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.phrase, "copy that and do the thing");
  });

  it("handles empty input", () => {
    const result = stripCatchphrase("");
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.phrase, "");
  });

  it("handles whitespace-only input", () => {
    const result = stripCatchphrase("   ");
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.phrase, "");
  });
});

// Test shortPhrase logic
describe("shortPhrase", () => {
  function shortPhrase(text: string, maxWords = 5): string {
    const plain = text.replace(/\s+/g, " ").trim();
    const words = plain.split(" ");
    if (words.length <= maxWords) return plain;
    return words.slice(0, maxWords).join(" ");
  }

  it("returns text unchanged when under limit", () => {
    assert.strictEqual(shortPhrase("one two three"), "one two three");
  });

  it("truncates to maxWords", () => {
    assert.strictEqual(shortPhrase("one two three four five six seven"), "one two three four five");
  });

  it("handles custom maxWords", () => {
    assert.strictEqual(shortPhrase("one two three four five", 3), "one two three");
  });

  it("normalizes whitespace", () => {
    assert.strictEqual(shortPhrase("one   two    three"), "one two three");
  });
});

// Test sanitize logic
describe("sanitize", () => {
  function sanitize(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "link")
      .replace(/[*_#>~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  it("strips code blocks", () => {
    assert.strictEqual(sanitize("before ```code``` after"), "before code block after");
  });

  it("strips inline code", () => {
    assert.strictEqual(sanitize("use `foo()` here"), "use foo() here");
  });

  it("strips markdown links", () => {
    assert.strictEqual(sanitize("[click here](https://example.com)"), "click here");
  });

  it("replaces URLs with 'link'", () => {
    assert.strictEqual(sanitize("visit https://example.com now"), "visit link now");
  });

  it("strips markdown formatting", () => {
    assert.strictEqual(sanitize("**bold** and *italic*"), "bold and italic");
  });

  it("normalizes whitespace", () => {
    assert.strictEqual(sanitize("one   two\n\nthree"), "one two three");
  });
});
