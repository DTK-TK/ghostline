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
