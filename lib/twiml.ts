/**
 * lib/twiml.ts
 *
 * Pure TwiML builder functions. No I/O, no side-effects — each function
 * accepts plain data and returns a TwiML XML string. This keeps the voice
 * logic testable without mocking HTTP or Twilio.
 *
 * <Gather> convention throughout:
 *   input="speech"  speechTimeout="auto"  method="POST"
 *   action → /api/voice/turn  (absolute URL built from baseUrl)
 *
 * When the caller says nothing the verb times out and falls through to
 * <Redirect method="POST">, which re-posts to /api/voice/turn with an empty
 * SpeechResult — the silence counter in the turn handler increments and
 * eventually triggers silenceGoodbyeTwiml().
 */

import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

function turnUrl(baseUrl: string): string {
  return `${baseUrl}/api/voice/turn`;
}

// ---------------------------------------------------------------------------
// GREETING state — opening gather
// ---------------------------------------------------------------------------

/**
 * Initial TwiML for an unrecognised caller.
 * Speaks the persona's fixed opening line, then listens.
 */
export function greetingTwiml(familyName: string, baseUrl: string): string {
  const r = new VoiceResponse();
  const gather = r.gather({
    input: ["speech"],
    speechTimeout: "auto",
    action: turnUrl(baseUrl),
    method: "POST",
  });
  gather.say(
    `You've reached the ${familyName} residence. ` +
      "This call is screened by Ghostline. " +
      "Please say your name and why you're calling.",
  );
  r.redirect({ method: "POST" }, turnUrl(baseUrl));
  return r.toString();
}

// ---------------------------------------------------------------------------
// Mid-conversation — reply and re-gather
// ---------------------------------------------------------------------------

/**
 * Speak one persona line, then open a fresh <Gather> for the next response.
 * Used for IDENTIFY, SAFE_WORD, SCREEN, and TIME_WASTE turns.
 */
export function replyTwiml(text: string, baseUrl: string): string {
  const r = new VoiceResponse();
  const gather = r.gather({
    input: ["speech"],
    speechTimeout: "auto",
    action: turnUrl(baseUrl),
    method: "POST",
  });
  gather.say(text);
  r.redirect({ method: "POST" }, turnUrl(baseUrl));
  return r.toString();
}

// ---------------------------------------------------------------------------
// Terminal outcomes
// ---------------------------------------------------------------------------

/**
 * CONNECT — immediately dial the senior's phone number.
 * callerId is the Twilio number so the senior sees a recognisable number.
 */
export function connectTwiml(seniorPhone: string, twilioNumber: string): string {
  const r = new VoiceResponse();
  const dial = r.dial({ callerId: twilioNumber });
  dial.number(seniorPhone);
  return r.toString();
}

/**
 * BLOCK — speak the persona's refusal line and hang up.
 * Never says "scam" or accuses the caller directly.
 */
export function blockTwiml(): string {
  const r = new VoiceResponse();
  r.say("I'm not able to connect this call. Goodbye.");
  r.hangup();
  return r.toString();
}

/**
 * GOODBYE — speak one final line, then hang up (no voicemail, no gather).
 * Used when the engine ends the call, e.g. the time-waster limit.
 */
export function goodbyeTwiml(line: string): string {
  const r = new VoiceResponse();
  r.say(line);
  r.hangup();
  return r.toString();
}

/**
 * MESSAGE — could not connect; invite the caller to leave a voicemail.
 * Used for MEDIUM risk or when the caller claims to be family and fails
 * the safe-word challenge.
 */
export function messageTwiml(): string {
  const r = new VoiceResponse();
  r.say(
    "I'm not able to connect this call right now. " +
      "Please leave a message after the tone.",
  );
  r.record({ maxLength: 120, playBeep: true });
  return r.toString();
}

/**
 * TIME_WASTE — same shape as replyTwiml; the conversation engine supplies
 * the grandmother's rambling line. Exported separately for clarity.
 */
export function timeWasteTwiml(line: string, baseUrl: string): string {
  return replyTwiml(line, baseUrl);
}

// ---------------------------------------------------------------------------
// Callback hold loop
// ---------------------------------------------------------------------------

function holdCheckUrl(baseUrl: string, n: number): string {
  return `${baseUrl}/api/voice/hold-check?n=${n}`;
}

/**
 * Hold the caller while the family member's phone rings. `say` is spoken on
 * the first pass only; later passes are silence. 10 seconds, then re-check.
 */
export function holdTwiml(baseUrl: string, n: number, say?: string): string {
  const r = new VoiceResponse();
  if (say) r.say(say);
  r.pause({ length: 10 });
  r.redirect({ method: "POST" }, holdCheckUrl(baseUrl, n));
  return r.toString();
}

/**
 * The hold is over and the call is not blocked: thank the caller, then ask
 * the (fixed) safe word challenge line and listen.
 */
export function holdEndTwiml(challenge: string, baseUrl: string): string {
  const r = new VoiceResponse();
  r.say("Thank you for waiting.");
  const gather = r.gather({
    input: ["speech"],
    speechTimeout: "auto",
    action: turnUrl(baseUrl),
    method: "POST",
  });
  gather.say(challenge);
  r.redirect({ method: "POST" }, turnUrl(baseUrl));
  return r.toString();
}

/** Ends the call with no speech (hold-check on a call that already ended). */
export function hangupTwiml(): string {
  const r = new VoiceResponse();
  r.hangup();
  return r.toString();
}

// ---------------------------------------------------------------------------
// Family member's phone (outbound callback leg)
// ---------------------------------------------------------------------------

/**
 * The prompt the family member hears. `claimedName` and `familyName` must
 * already be sanitised (lib/callback.ts cleanName).
 */
export function callbackPromptText(claimedName: string, familyName: string): string {
  return (
    `This is Ghostline. Someone saying they are ${claimedName} is calling the ` +
    `${familyName} family right now. Press 1 if you are safe and NOT calling. ` +
    "Press 2 if it really is you."
  );
}

export function callbackPromptTwiml(
  claimedName: string,
  familyName: string,
  resultUrl: string,
): string {
  const r = new VoiceResponse();
  const gather = r.gather({
    input: ["dtmf"],
    numDigits: 1,
    timeout: 10,
    action: resultUrl,
    method: "POST",
  });
  gather.say(callbackPromptText(claimedName, familyName));
  r.say("We did not get a response. Goodbye.");
  r.hangup();
  return r.toString();
}

/** Spoken to the family member after a digit; also the empty status reply. */
export function callbackThanksTwiml(): string {
  const r = new VoiceResponse();
  r.say("Thank you. Goodbye.");
  r.hangup();
  return r.toString();
}

/** Empty reply for status callbacks, which ignore the body. */
export function emptyTwiml(): string {
  return new VoiceResponse().toString();
}

// ---------------------------------------------------------------------------
// Silence handling
// ---------------------------------------------------------------------------

/**
 * Called after two consecutive empty SpeechResult turns.
 * Says goodbye and records a voicemail as a courtesy.
 */
export function silenceGoodbyeTwiml(): string {
  const r = new VoiceResponse();
  r.say("I'm sorry, I couldn't hear you. Please call back. Goodbye.");
  r.record({ maxLength: 120, playBeep: true });
  return r.toString();
}

// ---------------------------------------------------------------------------
// Error fallback — always safe
// ---------------------------------------------------------------------------

/**
 * Returned by any route handler that catches an unexpected error.
 * Records a voicemail so the caller never hears dead air and the senior
 * never misses a legitimate message.
 */
export function errorFallbackTwiml(): string {
  const r = new VoiceResponse();
  r.say(
    "We're experiencing a brief interruption. " +
      "Please leave a message after the tone.",
  );
  r.record({ maxLength: 120, playBeep: true });
  return r.toString();
}
