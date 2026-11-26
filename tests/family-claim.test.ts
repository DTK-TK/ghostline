import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { claimsFamilyByPattern } from "@/lib/family-claim";

describe("claimsFamilyByPattern", () => {
  it.each([
    "Grandma it's me, I need help",
    "Hi Grandma, it's Emma. I'm coming to visit on Saturday.",
    "Grandpa, it's Noah. My car had a flat tire.",
    "Hi Nana, it's Sophie.",
    "Hello Grandma",
    "It's me",
    "this is me, please pick up",
    "Hi, I'm your grandson",
    "This is your granddaughter",
    "It's your son",
    "Hi, your daughter here",
    "I am a grandson of Mrs. Whitfield",
    "This is Margaret's grandson",
    "Hi Mom, it's Alex",
  ])("detects %j", (s) => {
    expect(claimsFamilyByPattern(s)).toBe(true);
  });

  it.each([
    "I'm calling about your grandson's prescription",
    "Hello, this is Maple Clinic calling for Mrs. Whitfield.",
    "Hi, it's Sam from Lakeview Pharmacy. Your refill is due next week.",
    "Hi Margaret, it's Bob from next door.",
    "Please don't tell mom or dad",
    "We have a message for your son",
    "It's meant for the person who lives here",
    "The reason is personal",
    "Your sons name is on the account",
    "",
  ])("ignores %j", (s) => {
    expect(claimsFamilyByPattern(s)).toBe(false);
  });

  it("never throws and is deterministic", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(claimsFamilyByPattern(s)).toBe(claimsFamilyByPattern(s));
      }),
    );
  });
});
