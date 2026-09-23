import { describe, it } from "node:test";
import assert from "node:assert";

import { QUESTION_CUES, OUTCOME_CUES, sanitize, stripCatchphrase, pickFromPool, pickOutcomeCue, pickQuestionCue } from "./text.ts";

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

describe("OUTCOME_CUES", () => {
  it("contains 7 phrases", () => {
    assert.strictEqual(OUTCOME_CUES.length, 7);
  });

  it("contains only non-empty strings", () => {
    for (const cue of OUTCOME_CUES) {
      assert.ok(cue.length > 0, `Empty cue in pool`);
    }
  });
});

describe("pickOutcomeCue", () => {
  it("returns a string from OUTCOME_CUES", () => {
    const cue = pickOutcomeCue();
    assert.ok(OUTCOME_CUES.includes(cue as typeof OUTCOME_CUES[number]), `Unexpected cue: "${cue}"`);
  });

  it("returns different values over many calls", () => {
    const results = new Set(Array.from({ length: 100 }, () => pickOutcomeCue()));
    assert.ok(results.size >= 4, `Only saw ${results.size} distinct cues out of 100 picks`);
  });

  it("sometimes picks each cue over a large sample", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const cue = pickOutcomeCue();
      counts[cue] = (counts[cue] ?? 0) + 1;
    }
    for (const cue of OUTCOME_CUES) {
      assert.ok(
        (counts[cue] ?? 0) > 0,
        `Cue "${cue}" never picked in 1000 draws`,
      );
    }
  });
});

describe("pickFromPool", () => {
  it("returns a value from the supplied pool", () => {
    const pool = ["a", "b", "c"] as const;
    const picked = pickFromPool(pool);
    assert.ok(pool.includes(picked as (typeof pool)[number]), `Picked "${picked}" not in pool`);
  });

  it("preserves the pool's element type as the return type", () => {
    // If the generic isn't tight, this assignment would error.
    const pool = ["x", "y"] as const;
    const picked: "x" | "y" = pickFromPool(pool);
    assert.ok(picked === "x" || picked === "y");
  });

  it("works with any-element pools (numeric)", () => {
    const pool = [1, 2, 3] as const;
    const picked: 1 | 2 | 3 = pickFromPool(pool);
    assert.ok(picked === 1 || picked === 2 || picked === 3);
  });

  it("picks values from the same pool over many calls", () => {
    const pool = ["alpha", "beta", "gamma", "delta"] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pickFromPool(pool));
    // With 4 elements and 200 draws, all 4 should show up.
    assert.strictEqual(seen.size, pool.length);
  });
});