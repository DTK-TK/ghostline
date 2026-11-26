import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import fc from "fast-check";
import { normalise, stripLeadIn, checkSafeWord } from "@/lib/safe-word";

// Test-only word. Never printed or logged.
const RIGHT = "test-only-word";
const WRONG = "another-test-word";

describe("bcryptjs hash prefix compatibility (pgcrypto emits $2a$)", () => {
  // Cost 4 keeps the test fast; production seed uses cost 12.
  const hash = bcrypt.hashSync(RIGHT, 4);

  it("generates a standard bcrypt hash to rewrite", () => {
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
  });

  for (const prefix of ["$2a$", "$2b$", "$2y$"]) {
    it(`verifies the right word and rejects a wrong one under ${prefix}`, async () => {
      const rewritten = prefix + hash.slice(4);
      expect(rewritten.startsWith(prefix)).toBe(true);
      expect(await bcrypt.compare(RIGHT, rewritten)).toBe(true);
      expect(await bcrypt.compare(WRONG, rewritten)).toBe(false);
    });
  }
});

describe("lib/safe-word", () => {
  // Cost 4 hash of the normalised demo word.
  const hash = bcrypt.hashSync("pumpkin", 4);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalise lowercases, strips punctuation and singularises", () => {
    expect(normalise("  Pumpkins! ")).toBe("pumpkin");
    expect(normalise("Pumpkin   Pie.")).toBe("pumpkin pie");
  });

  it("stripLeadIn removes spoken lead-ins", () => {
    expect(stripLeadIn("It's pumpkin")).toBe("pumpkin");
    expect(stripLeadIn("The family word is pumpkin")).toBe("pumpkin");
  });

  for (const attempt of ["PUMPKIN ", "Pumpkin!", "pumpkins", "it's pumpkin"]) {
    it(`matches "${attempt}"`, async () => {
      expect(await checkSafeWord(attempt, hash)).toBe(true);
    });
  }

  for (const attempt of ["pumpkin pie", "pump", "", "   "]) {
    it(`does not match "${attempt}"`, async () => {
      expect(await checkSafeWord(attempt, hash)).toBe(false);
    });
  }

  it("returns false and logs neither hash nor attempt for an invalid hash", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const bad = "not-a-real-hash-zzz";
    const attempt = "secret-attempt-xyz";
    expect(await checkSafeWord(attempt, bad)).toBe(false);
    expect(await checkSafeWord(attempt, null)).toBe(false);
    const output = JSON.stringify([...err.mock.calls, ...log.mock.calls]);
    expect(output).not.toContain(bad);
    expect(output).not.toContain(attempt);
  });

  it("makes at most 2 bcrypt compares per attempt", async () => {
    const spy = vi.spyOn(bcrypt, "compare");
    await checkSafeWord("it's pumpkin pie", hash);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockClear();
    await checkSafeWord("the family word is some other long thing", hash);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockClear();
    await checkSafeWord("wrong", hash);
    expect(spy.mock.calls.length).toBe(1);
  });

  it("normalise is idempotent (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalise(s);
        expect(normalise(once)).toBe(once);
      }),
    );
  });
});
