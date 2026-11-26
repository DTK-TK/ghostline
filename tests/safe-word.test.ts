import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import fc from "fast-check";
import { normalise, stripLeadIn, checkSafeWord, hashSafeWord } from "@/lib/safe-word";
import { processTurn } from "@/lib/turn";

// In-memory database for the engine-level score tests at the end of the file.
const mem = vi.hoisted(() => ({
  call: null as Record<string, any> | null,
  events: [] as Record<string, any>[],
  household: {} as Record<string, any>,
  gemini: vi.fn(),
  seq: 0,
}));

vi.mock("@/lib/db", () => ({
  getHousehold: async () => mem.household,
  getCallBySid: async () => (mem.call ? { ...mem.call } : null),
  updateCall: async (_sid: string, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) mem.call![k] = v;
    return { ...mem.call };
  },
  appendEvent: async (e: Record<string, any>) => {
    const row = { id: String(++mem.seq), created_at: new Date().toISOString(), ...e };
    mem.events.push(row);
    return row;
  },
  getCallEvents: async () => mem.events.slice(),
  getCallbackTargets: async () => [],
}));
vi.mock("@/lib/providers", () => ({
  getTelephony: () => ({ startCallbackCall: vi.fn() }),
}));
vi.mock("@/lib/alert-call", () => ({ alertCall: vi.fn(async () => undefined) }));
vi.mock("@/lib/scoring/ai", async (orig) => {
  const real = await orig<typeof import("@/lib/scoring/ai")>();
  return { ...real, callGemini: (...a: unknown[]) => mem.gemini(...a) };
});

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

describe("engine: a correct safe word lowers the score by exactly 40 (task 3a)", () => {
  const WORD = "kettle"; // test-only, never printed
  const FAMILY_REPLY = {
    reply: "Thank you. Who are you calling for?",
    risk_score: 0,
    flags: [],
    claims_family: true,
    claimed_identity: "Emma",
    summary: "",
    requested_amount: null,
    payment_method: null,
  };

  function setup(storedScore: number) {
    mem.events = [];
    mem.gemini.mockReset();
    mem.gemini.mockResolvedValue(FAMILY_REPLY);
    mem.household = {
      id: "hh",
      family_name: "Sun",
      senior_phone: "+15550000000",
      safe_word_hash: bcrypt.hashSync(WORD, 4),
      time_waster_enabled: false,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    mem.call = {
      id: "call-1",
      call_sid: "CA_sw3",
      household_id: "hh",
      state: "screening",
      risk_score: storedScore,
      risk_level: storedScore >= 70 ? "high" : storedScore >= 40 ? "medium" : "low",
      claimed_identity: null,
      summary: null,
    };
  }

  async function say(speech: string) {
    const r = await processTurn({ callSid: "CA_sw3", speech, source: "simulator" });
    if (r.kind !== "turn") throw new Error("not found");
    mem.call!.state = r.nextState;
    return r;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [45, 5],
    [30, 0],
  ])("stored score %i with the right word gives %i", async (stored, expected) => {
    vi.stubEnv("AI_PROVIDER", "mock");
    setup(stored);
    // The claim turn keeps the stored score (monotonic floor).
    await say("Hi Grandma, it's Emma");
    expect(mem.call!.risk_score).toBe(stored);

    const ok = await say(WORD);
    expect(ok.nextState).toBe("verified");
    expect(ok.riskScore).toBe(expected);
    expect(mem.call!.risk_score).toBe(expected);
    expect(JSON.stringify(mem.events)).not.toContain(WORD);
  });

  it("a wrong word first does not stop the right word from lowering the score by 40", async () => {
    vi.stubEnv("AI_PROVIDER", "mock");
    setup(0);
    await say("Hi Grandma, it's Emma");
    const wrong = await say("not-the-word");
    expect(wrong.riskScore).toBe(50);
    // Gross 50 (the failure points) minus the 40 credit.
    const ok = await say(WORD);
    expect(ok.nextState).toBe("verified");
    expect(ok.riskScore).toBe(10);
  });
});

describe("hashSafeWord", () => {
  it("hashes the normalised word so \"Pumpkins!\" verifies against \"pumpkin\"", async () => {
    const hash = await hashSafeWord("Pumpkins!", 4);
    expect(hash).not.toContain("pumpkin");
    expect(await checkSafeWord("pumpkin", hash)).toBe(true);
    expect(await checkSafeWord("banana", hash)).toBe(false);
  });
});
