import { describe, it } from "node:test";
import assert from "node:assert";

import { QUESTION_CUES, sanitize, shortPhrase, stripCatchphrase, pickQuestionCue, topicFallback } from "./text.ts";

describe("stripCatchphrase", () => {
  it("matches trailing catchphrase after a comma", () => {
    const r = stripCatchphrase("refactor the auth module, copy", "copy");
    assert.deepStrictEqual(r, { matched: true, phrase: "refactor the auth module" });
  });

  it("matches catchphrase after a space", () => {
    const r = stripCatchphrase("run the tests copy", "copy");
    assert.deepStrictEqual(r, { matched: true, phrase: "run the tests" });
  });

  it("matches catchphrase with trailing punctuation", () => {
    const r = stripCatchphrase("deploy to staging, copy.", "copy");
    assert.deepStrictEqual(r, { matched: true, phrase: "deploy to staging" });
  });

  it("returns an empty phrase when only the catchphrase is spoken", () => {
    const r = stripCatchphrase("copy", "copy");
    assert.deepStrictEqual(r, { matched: true, phrase: "" });
  });

  it("does not match a catchphrase embedded mid-word", () => {
    const r = stripCatchphrase("I am copying the file", "copy");
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.phrase, "I am copying the file");
  });

  it("does not match when the catchphrase is not last", () => {
    const r = stripCatchphrase("copy that and do the thing", "copy");
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.phrase, "copy that and do the thing");
  });

  it("handles an empty catchphrase (auto-send disabled)", () => {
    const r = stripCatchphrase("anything copy", "");
    assert.strictEqual(r.matched, false);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(stripCatchphrase("", "copy"), { matched: false, phrase: "" });
    assert.deepStrictEqual(stripCatchphrase("   ", "copy"), { matched: false, phrase: "" });
  });
});

describe("shortPhrase", () => {
  it("returns text unchanged when under the limit", () => {
    assert.strictEqual(shortPhrase("one two three"), "one two three");
  });

  it("truncates to maxWords at a word boundary", () => {
    assert.strictEqual(shortPhrase("one two three four five six seven"), "one two three four five");
  });

  it("honours a custom maxWords", () => {
    assert.strictEqual(shortPhrase("one two three four five", 3), "one two three");
  });

  it("normalizes whitespace", () => {
    assert.strictEqual(shortPhrase("one   two    three"), "one two three");
  });

  it("handles empty input", () => {
    assert.strictEqual(shortPhrase(""), "");
  });
});

describe("sanitize", () => {
  it("strips code blocks", () => {
    assert.strictEqual(sanitize("before ```code``` after"), "before code block after");
  });

  it("strips inline code", () => {
    assert.strictEqual(sanitize("use `foo()` here"), "use foo() here");
  });

  it("strips markdown links down to their label", () => {
    assert.strictEqual(sanitize("[click here](https://example.com)"), "click here");
  });

  it("replaces bare URLs with 'link'", () => {
    assert.strictEqual(sanitize("visit https://example.com now"), "visit link now");
  });

  it("strips markdown emphasis markers", () => {
    assert.strictEqual(sanitize("**bold** and *italic*"), "bold and italic");
  });

  it("strips list bullets and numbers", () => {
    assert.strictEqual(sanitize("- first\n- second"), "first second");
    assert.strictEqual(sanitize("1. first\n2. second"), "first second");
  });

  it("normalizes whitespace", () => {
    assert.strictEqual(sanitize("one   two\n\nthree"), "one two three");
  });
});

describe("topicFallback", () => {
  it("strips a leading 'should I'", () => {
    assert.strictEqual(topicFallback("Should I use Postgres or MySQL?"), "use Postgres or MySQL");
  });

  it("strips a leading 'how do I'", () => {
    assert.strictEqual(topicFallback("How do I configure the cache?"), "configure the cache");
  });

  it("strips a leading 'what'", () => {
    assert.strictEqual(topicFallback("What database should we pick?"), "database should we pick");
  });

  it("leaves a plain topic untouched", () => {
    assert.strictEqual(topicFallback("Postgres versus MySQL"), "Postgres versus MySQL");
  });

  it("caps the result at six words", () => {
    const r = topicFallback("one two three four five six seven eight");
    assert.strictEqual(r.split(" ").length, 6);
  });

  it("falls back to the raw question when stripping empties it", () => {
    assert.strictEqual(topicFallback("Should I?"), "Should I");
  });
});

describe("QUESTION_CUES", () => {
  it("contains 7 phrases", () => {
    assert.strictEqual(QUESTION_CUES.length, 7);
  });

  it("includes the original 'I've got a question'", () => {
    assert.ok(QUESTION_CUES.includes("I've got a question"));
  });

  it("contains only non-empty strings", () => {
    for (const cue of QUESTION_CUES) {
      assert.ok(cue.length > 0, `Empty cue in pool`);
    }
  });
});

describe("pickQuestionCue", () => {
  it("returns a string from QUESTION_CUES", () => {
    const cue = pickQuestionCue();
    assert.ok(QUESTION_CUES.includes(cue as typeof QUESTION_CUES[number]), `Unexpected cue: "${cue}"`);
  });

  it("returns different values over many calls", () => {
    const results = new Set(Array.from({ length: 100 }, () => pickQuestionCue()));
    // With 7 cues and 100 random picks, we should see at least 4 distinct values
    // (statistically guaranteed — chance of seeing <4 is astronomically low)
    assert.ok(results.size >= 4, `Only saw ${results.size} distinct cues out of 100 picks`);
  });

  it("sometimes picks each cue over a large sample", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const cue = pickQuestionCue();
      counts[cue] = (counts[cue] ?? 0) + 1;
    }
    // Each of the 7 cues should appear at least once in 1000 draws
    for (const cue of QUESTION_CUES) {
      assert.ok(
        (counts[cue] ?? 0) > 0,
        `Cue "${cue}" never picked in 1000 draws`,
      );
    }
  });
});