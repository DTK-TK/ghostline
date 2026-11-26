/**
 * lib/conversation-engine.ts
 *
 * Stub for the conversation engine (spec 3 — not yet implemented).
 *
 * The turn route handler calls runTurn() and receives a typed result that
 * drives the next TwiML response and any state/risk updates to persist.
 *
 * This file is intentionally minimal — it exports the shared types and a
 * stub that returns safe defaults so the voice flow compiles and runs end-
 * to-end before spec 3 is built.  Replace the stub body when implementing
 * the Gemini-powered engine.
 */

import type { CallState, RiskLevel } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types shared between this module and the turn route handler
// ---------------------------------------------------------------------------

export interface TurnInput {
  /** Twilio CallSid — used to load full conversation history. */
  callSid: string;
  /** Caller's latest speech turn, empty string if no audio was detected. */
  speechResult: string;
  /** Current state before this turn is processed. */
  currentState: CallState;
  /** Accumulated risk score so far (0–100). */
  currentRiskScore: number;
}

export interface TurnOutput {
  /** Text the persona should speak next. */
  reply: string;
  /**
   * State the call should move to after this turn.
   * Returning the same state keeps the conversation in the current phase.
   */
  nextState: CallState;
  /**
   * Risk score update to merge into calls.risk_score.
   * The score monotonically increases (rules layer enforces the floor).
   */
  riskUpdate: {
    score: number;
    level: RiskLevel;
  };
}

// ---------------------------------------------------------------------------
// Stub implementation — replaced by spec 3
// ---------------------------------------------------------------------------

/**
 * Process one conversation turn.
 *
 * Production implementation will:
 *   1. Load call history from call_events (transcripts + red flags).
 *   2. Run the rules scorer (lib/scoring/) for immediate red flags.
 *   3. Call Gemini with a short system prompt and the history.
 *   4. Validate the JSON response with Zod.
 *   5. Return the typed TurnOutput.
 *
 * The stub keeps every call in SCREEN state with a low-risk response so
 * the routing layer and TwiML builders can be tested independently.
 */
export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  // Stub: acknowledge the caller and stay in screening.
  void input; // suppress unused-param lint until spec 3 fills this in
  return {
    reply: "Thank you. Could you tell me more about why you're calling?",
    nextState: "screening",
    riskUpdate: { score: 0, level: "low" },
  };
}
