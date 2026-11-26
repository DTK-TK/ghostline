/**
 * lib/conversation.ts
 *
 * The conversation engine: given a CallSid and the latest speech utterance,
 * loads full history from call_events, runs both scoring layers, writes
 * back to the DB, and returns the next reply + state.
 *
 * This module replaces the stub in lib/conversation-engine.ts and fulfils
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

// ---------------------------------------------------------------------------
// Public contract — matches conversation-engine.ts TurnInput / TurnOutput
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
 * The engine never moves a call backwards — once verified or blocked it stays.
 */
function computeNextState(
  current: CallState,
  level: RiskLevel,
  claimsFamily: boolean,
  timeWasterEnabled: boolean,
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

  if (level === "medium") {
    // Keep screening but don't connect yet.
    return "screening";
  }

  // LOW risk — if the caller says they're family, stay in screening for the
  // safe-word challenge; otherwise connect.
  if (claimsFamily) {
    return "screening";
  }

  return "verified";
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

  // 6. AI layer — with fallback on GeminiUnavailableError.
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
  const aiFlagsIds = geminiResult?.flags ?? [];
  const allFlagIds = Array.from(new Set([...rulesResult.flags, ...aiFlagsIds]));

  const combined = combineScores({
    rulesScore: rulesResult.score,
    aiScore,
    allFlags: allFlagIds,
    safeWordCorrect: false, // safe-word check is handled by the turn route
    callbackDenied: false,  // callback result is handled separately
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

  // 9. Update calls row with latest risk.
  await updateCall(callSid, {
    risk_score: combined.score,
    risk_level: combined.level,
    claimed_identity: geminiResult?.claimed_identity ?? call.claimed_identity,
    summary: geminiResult?.summary ?? call.summary,
  });

  // 10. Determine next state.
  const claimsFamily = geminiResult?.claims_family ?? false;
  const nextState = computeNextState(
    currentState,
    combined.level,
    claimsFamily,
    household.time_waster_enabled,
  );

  // 11. Build reply.
  const reply = usedFallback
    ? fallbackReply(combined.level)
    : (geminiResult?.reply ?? fallbackReply(combined.level));

  return {
    reply,
    nextState,
    riskUpdate: { score: combined.score, level: combined.level },
  };
}
