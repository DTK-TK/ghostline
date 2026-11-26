import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateReply } from "@/lib/scoring/reply-guard";

describe("validateReply", () => {
  it("accepts a short, polite reply", () => {
    expect(validateReply("Thank you. Could you tell me more?")).toBe(
      "Thank you. Could you tell me more?",
    );
  });

  it("rejects more than 2 sentences", () => {
    expect(validateReply("Hello. Who is this? Why are you calling.")).toBeNull();
  });

  it("rejects 25 or more words, accepts 24", () => {
    const w = (n: number) => Array(n).fill("word").join(" ");
    expect(validateReply(w(25))).toBeNull();
    expect(validateReply(w(24))).toBe(w(24));
  });

  it.each(["scam", "scammer", "fraud", "fraudster", "criminal"])(
    "rejects accusatory word %s",
    (word) => {
      expect(validateReply(`I think this is a ${word}.`)).toBeNull();
    },
  );

  it("rejects repeated opening lines", () => {
    expect(validateReply("This call is screened by Ghostline.")).toBeNull();
    expect(validateReply("You've reached the Smith residence.")).toBeNull();
  });

  it("rejects empty text", () => {
    expect(validateReply("   ")).toBeNull();
  });

  it("property: any accepted reply is under 25 words and at most 2 sentences", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const out = validateReply(s);
        if (out !== null) {
          expect(out.split(/\s+/).length).toBeLessThan(25);
          expect(out.split(/[.!?]+(?:\s+|$)/).filter((x) => x.trim()).length).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 200 },
    );
  });
});
