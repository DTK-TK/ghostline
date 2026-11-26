/**
 * lib/conversation.ts
 *
 * The conversation engine: given a CallSid and the latest speech utterance,
 * loads full history from call_events, runs both scoring layers, writes
 * back to the DB, and returns the next reply + state.
 *
 * This module fulfils
 * the contract expected by app/api/voice/turn/route.ts.
 *
 * Fallback policy:
 *   If Gemini times out (> 6 s) or returns invalid JSON, GeminiUnavailableError
 *   is caught here. The engine falls back to rules-only scoring and a scripted
 *   safe reply so the call continues without dead air.
 */

import {
  getCallBySid,
  getCallEvents,
  getHousehold,
  updateCall,
  appendEvent,
} from "@/lib/db";
import type { CallState, RiskLevel, CallEventRow } from "@/lib/db";
import { scoreRules } from "@/lib/scoring/rules";
import { callGemini, GeminiUnavailableError } from "@/lib/scoring/ai";
import type { ConversationTurn } from "@/lib/scoring/ai";
import { combineScores, scoreToLevel } from "@/lib/scoring/combine";
import { validateReply } from "@/lib/scoring/reply-guard";
import { filterKnownFlags } from "@/lib/scoring/known-flags";
import { sendAlerts } from "@/lib/alerts";
import { extractAmount, extractPaymentMethod, nonEmpty } from "@/lib/extract-evidence";

// ---------------------------------------------------------------------------
// Public contract �?matches conversation-engine.ts TurnInput / TurnOutput
// ---------------------------------------------------------------------------

export interface EngineInput {
  callSid: string;
  speechResult: string;
  currentState: CallState;
  currentRiskScore: number;
}

export interface EngineOutput {
  reply: string;
  nextState: CallState;
  riskUpdate: { score: number; level: RiskLevel };
}

// ---------------------------------------------------------------------------
// Scripted fallback replies (Gemini unavailable)
// ---------------------------------------------------------------------------

const FALLBACK_REPLIES: Record<string, string> = {
  low:    "Thank you. Could you tell me more about why you're calling?",
  medium: "I need a moment. Could you tell me your name and reason for calling?",
  high:   "I'm not able to connect this call. Goodbye.",
};

const SAFE_WORD_CHALLENGE = "What's the family word?";

const SAFE_WORD_FAIL_POINTS = 50;

/** MEDIUM calls screen for this many caller turns, then take a message. */
const MEDIUM_SCREEN_TURNS = 3;

function fallbackReply(level: RiskLevel): string {
  return FALLBACK_REPLIES[level] ?? FALLBACK_REPLIES["low"]!;
}

// ---------------------------------------------------------------------------
// History loader
// ---------------------------------------------------------------------------

/**
 * Pull transcript and red_flag events from call_events and shape them into
 * ConversationTurn[] for the Gemini prompt.
 */
function buildHistory(events: CallEventRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const ev of events) {
    if (ev.type === "transcript") {
      const text = typeof ev.payload["text"] === "string" ? ev.payload["text"] : "";
      const speaker =
        ev.payload["speaker"] === "system" ? "system" : ("caller" as const);
      if (text) turns.push({ speaker, text });
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// State transition logic
// ---------------------------------------------------------------------------

/**
 * Determine the next call state from the combined risk level, the AI output,
 * and whether the caller claims to be family.
 *
 * The engine never moves a call backwards �?once verified or blocked it stays.
 */
function computeNextState(
  current: CallState,
  level: RiskLevel,
  claimsFamily: boolean,
  timeWasterEnabled: boolean,
  callerTurns: number,
  safeWordPassed: boolean,
): CallState {
  // Terminal states don't transition.
  if (
    current === "scam_blocked" ||
    current === "completed" ||
    current === "verified" ||
    current === "transferring"
  ) {
    return current;
  }

  if (level === "high") {
    return timeWasterEnabled ? "time_wasted" : "scam_blocked";
  }

  // A family claim connects only after a matched safe word, and never on the
  // first caller turn. (A denied callback is HIGH through the score above.)
  if (claimsFamily) {
    return safeWordPassed && callerTurns >= 2 ? "verified" : "screening";
  }

  // No family claim (LOW or MEDIUM): screen for up to MEDIUM_SCREEN_TURNS
  // caller turns, then take a message. An unknown caller is never connected.
  return callerTurns >= MEDIUM_SCREEN_TURNS ? "completed" : "screening";
}

// ---------------------------------------------------------------------------
// New flags detection (for red_flag events)
// ---------------------------------------------------------------------------

function newFlags(current: string[], prior: string[]): string[] {
  const priorSet = new Set(prior);
  return current.filter((f) => !priorSet.has(f));
}

// ---------------------------------------------------------------------------
// Main engine function
// ---------------------------------------------------------------------------

export async function engine(input: EngineInput): Promise<EngineOutput> {
  const { callSid, speechResult, currentState, currentRiskScore } = input;

  // 1. Load call record and household.
  const call = await getCallBySid(callSid);
  if (!call) throw new Error(`Call not found: ${callSid}`);

  const household = await getHousehold(call.household_id);
  if (!household) throw new Error(`Household not found: ${call.household_id}`);

  // 2. Load event history.
  const events = await getCallEvents(call.id);

  // 3. Extract prior flags (from existing red_flag events).
  const priorFlagIds: string[] = events
    .filter((e) => e.type === "red_flag")
    .map((e) => (typeof e.payload["flag"] === "string" ? e.payload["flag"] : ""))
    .filter(Boolean);

  // 4. Rules-layer scoring (synchronous, no network).
  const callerTranscripts = events
    .filter(
      (e) => e.type === "transcript" && e.payload["speaker"] === "caller",
    )
    .map((e) => (typeof e.payload["text"] === "string" ? e.payload["text"] : ""))
    .concat(speechResult);

  const rulesResult = scoreRules(callerTranscripts);

  // 5. Build conversation history for Gemini.
  const history = buildHistory(events);

  // 6. AI layer �?with fallback on GeminiUnavailableError.
  let geminiResult: Awaited<ReturnType<typeof callGemini>> | null = null;
  let usedFallback = false;

  try {
    geminiResult = await callGemini(household.family_name, history, speechResult);
  } catch (err) {
    if (err instanceof GeminiUnavailableError) {
      usedFallback = true;
      console.error("[conversation] Gemini unavailable, using rules fallback:", err.message);
    } else {
      throw err;
    }
  }

  // 7. Combine scores.
  const aiScore = geminiResult?.risk_score ?? 0;
  const aiFlagsIds = filterKnownFlags(geminiResult?.flags ?? []);

  // Each failed safe-word attempt adds 50 to the rules score (scam-rules.md).
  // The flag goes through the same priorFlagIds dedup as every other flag, so
  // an existing safe_word_fail red_flag event is never written twice.
  const failedAttempts = events.filter(
    (e) => e.type === "safe_word_attempt" && e.payload["matched"] === false,
  ).length;
  const rulesScore = rulesResult.score + SAFE_WORD_FAIL_POINTS * failedAttempts;
  const allFlagIds = Array.from(
    new Set([
      ...rulesResult.flags,
      ...(failedAttempts > 0 ? ["safe_word_fail"] : []),
      ...aiFlagsIds,
    ]),
  );

  const safeWordCorrect = events.some(
    (e) => e.type === "safe_word_attempt" && e.payload["matched"] === true,
  );
  const callbackDenied = events.some(
    (e) => e.type === "callback_result" && e.payload["outcome"] === "denied",
  );

  const combined = combineScores({
    rulesScore,
    aiScore,
    allFlags: allFlagIds,
    safeWordCorrect,
    callbackDenied,
    priorScore: currentRiskScore,
  });

  // 8. Persist new red_flag events for flags not seen before.
  const freshFlags = newFlags(combined.flags, priorFlagIds);
  for (const flagId of freshFlags) {
    await appendEvent({
      call_id: call.id,
      type: "red_flag",
      payload: {
        type: "red_flag",
        flag: flagId,
        detail: usedFallback ? "rules-only" : "ai+rules",
      },
    });
  }

  // 9. Update calls row with latest risk. Amount and payment method: the
  // latest non-empty AI value, else rules extraction when the AI is down,
  // else keep what is stored (never overwrite with an empty value).
  const requestedAmount =
    nonEmpty(geminiResult?.requested_amount) ??
    (usedFallback ? extractAmount(speechResult) : null) ??
    call.requested_amount ??
    null;
  const paymentMethod =
    nonEmpty(geminiResult?.payment_method) ??
    (usedFallback ? extractPaymentMethod(speechResult) : null) ??
    call.payment_method ??
    null;

  await updateCall(callSid, {
    risk_score: combined.score,
    risk_level: combined.level,
    ...(requestedAmount ? { requested_amount: requestedAmount } : {}),
    ...(paymentMethod ? { payment_method: paymentMethod } : {}),
    claimed_identity: geminiResult?.claimed_identity ?? call.claimed_identity ?? undefined,
    summary: geminiResult?.summary ?? call.summary ?? undefined,
  });

  // 10. Determine next state. The route stores the current caller turn
  // before calling engine(), so events already include it.
  const callerTurnCount = events.filter(
    (e) =>
      e.type === "transcript" &&
      e.payload["speaker"] === "caller" &&
      typeof e.payload["text"] === "string" &&
      e.payload["text"].trim() !== "",
  ).length;
  // The claim sticks once challenged: the last system reply was the challenge.
  const lastSystem = [...events]
    .reverse()
    .find((e) => e.type === "transcript" && e.payload["speaker"] === "system");
  const claimsFamily =
    (geminiResult?.claims_family ?? false) ||
    lastSystem?.payload["text"] === SAFE_WORD_CHALLENGE;
  const nextState = computeNextState(
    currentState,
    combined.level,
    claimsFamily,
    household.time_waster_enabled,
    callerTurnCount,
    safeWordCorrect,
  );

  // 10b. MEDIUM message taken: alert the family once. Fires only on the
  // transition into "completed"; sendAlerts is also idempotent per recipient.
  if (
    nextState === "completed" &&
    currentState !== "completed" &&
    combined.level === "medium"
  ) {
    const callbackOutcome = events.find((e) => e.type === "callback_result")?.payload["outcome"];
    try {
      await sendAlerts({
        call,
        level: combined.level,
        claimedIdentity: geminiResult?.claimed_identity ?? call.claimed_identity ?? null,
        requestedAmount,
        paymentMethod,
        safeWordResult: safeWordCorrect ? "passed" : failedAttempts > 0 ? "failed" : "not asked",
        callbackResult:
          callbackOutcome === "denied" || callbackOutcome === "confirmed" || callbackOutcome === "no_answer"
            ? callbackOutcome
            : "not initiated",
      });
    } catch (err) {
      // Never drop the call because an SMS failed.
      console.error("[conversation] alert failed:", err instanceof Error ? err.message : "unknown");
    }
  }

  // 11. Build reply.
  // A family claim awaiting the safe word always gets the fixed challenge
  // line (R7.6, R7.11), so the AI reply cannot hint at the safe word.
  const challenging =
    claimsFamily && nextState === "screening" && combined.level !== "high";
  const reply = challenging
    ? SAFE_WORD_CHALLENGE
    : ((!usedFallback && geminiResult ? validateReply(geminiResult.reply) : null) ??
      fallbackReply(combined.level));

  // 12. Persist Ghostline's reply so later turns see it in history.
  // Scoring and silence counting only read speaker === "caller".
  await appendEvent({
    call_id: call.id,
    type: "transcript",
    payload: { type: "transcript", text: reply, speaker: "system" },
  });

  return {
    reply,
    nextState,
    riskUpdate: { score: combined.score, level: combined.level },
  };
}
