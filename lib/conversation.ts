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
import type { CallState, CallOutcome, RiskLevel, CallEventRow } from "@/lib/db";
import {
  ENTRY_LINE,
  GRANDMOTHER_LINES,
  GOODBYE_LINE,
  limitSeconds,
  elapsedSeconds,
  startedAtFrom,
  enterHighRisk,
} from "@/lib/time-waster";
import { scoreRules, QUOTE_MAX_CHARS } from "@/lib/scoring/rules";
import { callGemini, GeminiUnavailableError } from "@/lib/scoring/ai";
import type { ConversationTurn } from "@/lib/scoring/ai";
import { combineScores, creditsFromEvents, scoreToLevel } from "@/lib/scoring/combine";
import { validateReply } from "@/lib/scoring/reply-guard";
import { filterKnownFlags } from "@/lib/scoring/known-flags";
import { alertCall } from "@/lib/alert-call";
import { extractAmount, extractPaymentMethod, nonEmpty } from "@/lib/extract-evidence";
import { checkSafeWord } from "@/lib/safe-word";
import { startCallback, HOLD_REPLY } from "@/lib/callback";
import { claimsFamilyByPattern } from "@/lib/family-claim";
import {
  SAFE_WORD_CHALLENGE,
  SAFE_WORD_RETRY,
  SAFE_WORD_REDACTED,
  VERIFIED_REPLY,
  BLOCKED_REPLY,
  TIME_WASTER_REPLY,
  MAX_SAFE_WORD_ATTEMPTS,
  inChallengePhase,
  isChallengeLine,
} from "@/lib/safe-word-phase";
import type { CallRow, HouseholdRow } from "@/lib/db";

// ---------------------------------------------------------------------------
// Public contract ??matches conversation-engine.ts TurnInput / TurnOutput
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
  /** True when the callback was just started: the route holds the caller. */
  hold?: boolean;
  /** True when the route should say `reply` and hang up. */
  hangup?: boolean;
  /** Call outcome to store when this turn ends the call. */
  outcome?: CallOutcome;
  /** Extra fields for the state_change payload (started_at, ended_at, ...). */
  stateChangeExtra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scripted fallback replies (Gemini unavailable)
// ---------------------------------------------------------------------------

const FALLBACK_REPLIES: Record<string, string> = {
  low:    "Thank you. Could you tell me more about why you're calling?",
  medium: "I need a moment. Could you tell me your name and reason for calling?",
  high:   "I'm not able to connect this call. Goodbye.",
};

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
 * The engine never moves a call backwards ??once verified or blocked it stays.
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

function cutQuote(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, QUOTE_MAX_CHARS);
}

function newFlags(current: string[], prior: string[]): string[] {
  const priorSet = new Set(prior);
  return current.filter((f) => !priorSet.has(f));
}

// ---------------------------------------------------------------------------
// Safe word attempt turn
// ---------------------------------------------------------------------------

/**
 * The caller answered the family word challenge. The attempt is compared with
 * the stored hash and is never sent to the AI provider. Only "[redacted]" is
 * stored. When the attempt FAILS, it is also scanned in memory by the rules
 * and the payment/amount extractors (a scammer's wrong "answer" often is the
 * pitch); a MATCHED attempt is never scanned. Replies are fixed lines that
 * never hint at how close the attempt was.
 */
async function handleSafeWordAttempt(args: {
  call: CallRow;
  household: HouseholdRow;
  events: CallEventRow[];
  speechResult: string;
  currentState: CallState;
  currentRiskScore: number;
}): Promise<EngineOutput> {
  const { call, household, events, speechResult, currentState, currentRiskScore } = args;

  const matched = await checkSafeWord(speechResult, household.safe_word_hash);
  await appendEvent({
    call_id: call.id,
    type: "safe_word_attempt",
    payload: { type: "safe_word_attempt", matched, attempt: SAFE_WORD_REDACTED },
  });

  const priorFailed = events.filter(
    (e) => e.type === "safe_word_attempt" && e.payload["matched"] === false,
  ).length;
  const failedAttempts = priorFailed + (matched ? 0 : 1);

  // Rules score comes from stored (redacted) caller turns only.
  const storedCaller = events
    .filter((e) => e.type === "transcript" && e.payload["speaker"] === "caller")
    .map((e) => (typeof e.payload["text"] === "string" ? e.payload["text"] : ""));
  const storedRules = scoreRules(storedCaller);

  // A FAILED attempt is scanned in memory only (rules and the payment/amount
  // extractors). The text is never stored, logged or sent anywhere. A matched
  // attempt is the safe word itself and is never scanned.
  const rulesResult = matched ? storedRules : scoreRules([...storedCaller, speechResult]);
  const attemptFlags = new Set(
    matched ? [] : rulesResult.flags.filter((f) => !storedRules.flags.includes(f)),
  );
  const attemptPayment = matched ? null : extractPaymentMethod(speechResult);
  const attemptAmount = matched ? null : extractAmount(speechResult);

  const priorFlagIds = events
    .filter((e) => e.type === "red_flag")
    .map((e) => (typeof e.payload["flag"] === "string" ? e.payload["flag"] : ""));
  const combined = combineScores({
    rulesScore: rulesResult.score + SAFE_WORD_FAIL_POINTS * failedAttempts,
    aiScore: 0,
    allFlags: [...rulesResult.flags, ...(failedAttempts > 0 ? ["safe_word_fail"] : [])],
    safeWordCorrect: matched,
    callbackDenied: events.some(
      (e) => e.type === "callback_result" && e.payload["outcome"] === "denied",
    ),
    callbackConfirmed: events.some(
      (e) => e.type === "callback_result" && e.payload["outcome"] === "confirmed",
    ),
    priorScore: currentRiskScore,
    priorCredits: creditsFromEvents(events),
  });

  // Quotes come from STORED caller turns only. A flag first found in the
  // spoken attempt gets "[redacted]" so the attempt text is never stored.
  const storedQuotes = new Map(storedRules.matches.map((m) => [m.flag, m.quote]));
  for (const flagId of newFlags(combined.flags, priorFlagIds)) {
    const quote = attemptFlags.has(flagId) ? SAFE_WORD_REDACTED : storedQuotes.get(flagId);
    await appendEvent({
      call_id: call.id,
      type: "red_flag",
      payload: {
        type: "red_flag",
        flag: flagId,
        detail: "rules-only",
        ...(quote ? { quote } : {}),
      },
    });
  }
  await updateCall(call.call_sid, {
    risk_score: combined.score,
    risk_level: combined.level,
    ...(attemptPayment ? { payment_method: attemptPayment } : {}),
    ...(attemptAmount ? { requested_amount: attemptAmount } : {}),
  });
  if (combined.level === "high") await alertCall(call.id);

  const callerTurns = events.filter(
    (e) =>
      e.type === "transcript" &&
      e.payload["speaker"] === "caller" &&
      typeof e.payload["text"] === "string" &&
      e.payload["text"].trim() !== "",
  ).length;
  const nextState = computeNextState(
    currentState,
    combined.level,
    true,
    household.time_waster_enabled,
    callerTurns,
    matched,
  );

  const reply =
    nextState === "verified" || nextState === "transferring"
      ? VERIFIED_REPLY
      : nextState === "time_wasted"
        ? TIME_WASTER_REPLY
        : nextState === "scam_blocked"
          ? BLOCKED_REPLY
          : failedAttempts < MAX_SAFE_WORD_ATTEMPTS
            ? SAFE_WORD_RETRY
            : SAFE_WORD_CHALLENGE;

  await appendEvent({
    call_id: call.id,
    type: "transcript",
    payload: { type: "transcript", text: reply, speaker: "system" },
  });

  // Same shared HIGH transition as the main path (entry event, blocked outcome).
  const high =
    combined.level === "high" && currentState !== "time_wasted"
      ? enterHighRisk({ call: { state: currentState }, household, now: new Date() })
      : null;
  const highApplies = high !== null && high.state === nextState && nextState !== currentState;

  return {
    reply,
    nextState,
    riskUpdate: { score: combined.score, level: combined.level },
    ...(highApplies && high.hangup ? { hangup: true } : {}),
    ...(highApplies && high.outcome ? { outcome: high.outcome } : {}),
    ...(highApplies && Object.keys(high.extra).length > 0
      ? { stateChangeExtra: high.extra }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Time-waster helpers
// ---------------------------------------------------------------------------

/** Words the grandmother never says (R4/R5). */
const PERSONA_FORBIDDEN = /scam|fraud|police|report|suspicious|risk|record/i;

/** Persona AI replies: under 20 words, 2 sentences, no accusatory vocabulary. */
function validatePersonaReply(text: string | undefined): string | null {
  const ok = text === undefined ? null : validateReply(text, { maxWords: 20 });
  return ok && !PERSONA_FORBIDDEN.test(ok) ? ok : null;
}

/** Scripted persona line: ENTRY_LINE on entry, then rotated by turn index. */
function scriptedPersonaLine(events: CallEventRow[], entering: boolean): string {
  if (entering) return ENTRY_LINE;
  let entryIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "state_change" && e.payload["to"] === "time_wasted") {
      entryIdx = i;
      break;
    }
  }
  const callerTurns = events
    .slice(entryIdx + 1)
    .filter((e) => e.type === "transcript" && e.payload["speaker"] === "caller").length;
  const idx = Math.max(0, callerTurns - 1);
  return GRANDMOTHER_LINES[idx % GRANDMOTHER_LINES.length]!;
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

  // 2a. Time limit: checked before any AI call. The persona ends the call.
  const now = new Date();
  if (currentState === "time_wasted") {
    const limit = limitSeconds();
    const elapsed = elapsedSeconds(events, now);
    if (elapsed >= limit) {
      const startedAt = startedAtFrom(events)!;
      const seconds = Math.min(elapsed, limit);
      await appendEvent({
        call_id: call.id,
        type: "transcript",
        payload: { type: "transcript", text: GOODBYE_LINE, speaker: "system" },
      });
      return {
        reply: GOODBYE_LINE,
        nextState: "completed",
        riskUpdate: {
          score: call.risk_score ?? currentRiskScore,
          level: (call.risk_level ?? "high") as RiskLevel,
        },
        hangup: true,
        outcome: "time_wasted",
        stateChangeExtra: {
          started_at: startedAt,
          ended_at: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
          seconds,
          reason: "limit",
        },
      };
    }
  }

  // 2b. Safe word attempt turn: handled apart from the AI and rules layers.
  if (inChallengePhase(events)) {
    return handleSafeWordAttempt({ call, household, events, speechResult, currentState, currentRiskScore });
  }

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

  // 6. AI layer ??with fallback on GeminiUnavailableError.
  // Persona: already in it, or the rules alone reach HIGH with the setting on.
  // If only the AI raises the score to HIGH, this turn's reply is a normal
  // screening reply and the engine uses ENTRY_LINE instead (no second call).
  const failedAttemptsPre = events.filter(
    (e) => e.type === "safe_word_attempt" && e.payload["matched"] === false,
  ).length;
  const rulesHigh =
    scoreToLevel(rulesResult.score + SAFE_WORD_FAIL_POINTS * failedAttemptsPre) === "high";
  const persona =
    currentState === "time_wasted" || (rulesHigh && household.time_waster_enabled);

  let geminiResult: Awaited<ReturnType<typeof callGemini>> | null = null;
  let usedFallback = false;

  try {
    geminiResult = await callGemini(household.family_name, history, speechResult, persona);
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
    callbackConfirmed: events.some(
      (e) => e.type === "callback_result" && e.payload["outcome"] === "confirmed",
    ),
    priorScore: currentRiskScore,
    priorCredits: creditsFromEvents(events),
  });

  // 8. Persist new red_flag events for flags not seen before.
  const freshFlags = newFlags(combined.flags, priorFlagIds);
  // The quote is the caller's own words: the rules match when the rules found
  // the flag, else the utterance the AI was answering. Flags that are not
  // caller speech (safe_word_fail, callback_denied) carry no quote.
  const ruleQuotes = new Map(rulesResult.matches.map((m) => [m.flag, m.quote]));
  for (const flagId of freshFlags) {
    const quote =
      flagId === "safe_word_fail" || flagId === "callback_denied"
        ? ""
        : ruleQuotes.get(flagId) || cutQuote(speechResult);
    await appendEvent({
      call_id: call.id,
      type: "red_flag",
      payload: {
        type: "red_flag",
        flag: flagId,
        detail: usedFallback ? "rules-only" : "ai+rules",
        ...(quote ? { quote } : {}),
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
    (usedFallback && claimsFamilyByPattern(speechResult)) ||
    isChallengeLine(lastSystem?.payload["text"]) ||
    lastSystem?.payload["text"] === HOLD_REPLY;
  // Once in the persona the call stays there until the limit, hang-up or silence.
  const nextState: CallState =
    currentState === "time_wasted"
      ? "time_wasted"
      : computeNextState(
          currentState,
          combined.level,
          claimsFamily,
          household.time_waster_enabled,
          callerTurnCount,
          safeWordCorrect,
        );

  // HIGH transition fields (entry event, blocked outcome) come from the shared helper.
  const high =
    combined.level === "high" && currentState !== "time_wasted"
      ? enterHighRisk({ call: { state: currentState }, household, now })
      : null;
  const highApplies = high !== null && high.state === nextState && nextState !== currentState;

  // 10b. Alerts, via the one entry point (best effort, never throws).
  // HIGH goes out now. MEDIUM goes out on the transition into "completed"
  // (message taken). Repeats are harmless: sending is once per recipient.
  if (combined.level === "high") {
    await alertCall(call.id);
  } else if (
    nextState === "completed" &&
    currentState !== "completed" &&
    combined.level === "medium"
  ) {
    await alertCall(call.id, { messageTaken: true });
  }
  // 11. Build reply.
  // A family claim awaiting the safe word always gets the fixed challenge
  // line (R7.6, R7.11), so the AI reply cannot hint at the safe word.
  const challenging =
    claimsFamily && nextState === "screening" && combined.level !== "high";
  // First family claim on a real call: phone a family member and hold the
  // caller. startCallback is once per call and needs a target and a clean
  // name; otherwise the caller simply gets the challenge. Simulated calls
  // never place a real call.
  const hold =
    challenging &&
    !call.is_simulated &&
    (await startCallback({
      call,
      household,
      claimedName: geminiResult?.claimed_identity ?? call.claimed_identity,
    })) === "started";
  const entering = nextState === "time_wasted" && currentState !== "time_wasted";
  const reply = hold
    ? HOLD_REPLY
    : challenging
    ? SAFE_WORD_CHALLENGE
    : highApplies && high.hangup
    ? fallbackReply("high")
    : nextState === "time_wasted"
    ? ((persona && !usedFallback && geminiResult
        ? validatePersonaReply(geminiResult.reply)
        : null) ?? scriptedPersonaLine(events, entering))
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
    ...(hold ? { hold: true } : {}),
    ...(highApplies && high.hangup ? { hangup: true } : {}),
    ...(highApplies && high.outcome ? { outcome: high.outcome } : {}),
    ...(highApplies && Object.keys(high.extra).length > 0
      ? { stateChangeExtra: high.extra }
      : {}),
  };
}
