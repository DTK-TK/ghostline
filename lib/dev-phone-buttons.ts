/**
 * Dev phone callback buttons. Labels and digits match the spoken callback
 * prompt: 1 = not me / denied, 2 = it's really me / confirmed, 0 = no answer.
 */

import type { CallbackOutcome } from "@/lib/callback";

export type CallbackDigit = "1" | "2" | "0";

export interface CallbackButton {
  label: string;
  digit: CallbackDigit;
  outcome: CallbackOutcome;
}

export const CALLBACK_BUTTONS: readonly CallbackButton[] = [
  { label: "Press 1: not me, I'm safe", digit: "1", outcome: "denied" },
  { label: "Press 2: it's really me", digit: "2", outcome: "confirmed" },
  { label: "No answer", digit: "0", outcome: "no_answer" },
];
