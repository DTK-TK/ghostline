/**
 * lib/providers/telephony.ts
 *
 * Telephony provider abstraction — allows Ghostline to run without Twilio.
 *
 * Interface:
 *   sendSms(to, body) — sends an SMS alert
 *   startCallbackCall(to, callSid, claimedName) — initiates an outbound callback
 *   connectCall(callSid, toNumber) — transfers the screening call to the senior
 *   endCall(callSid) — hangs up an active call
 *
 * Implementations:
 *   TwilioTelephony — production, uses Twilio REST API
 *   MockTelephony — dev/test, writes to mock_messages table and console
 */

import twilio from "twilio";
import { adminDb } from "@/lib/db";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TelephonyProvider {
  /**
   * Send an SMS message.
   * @param to - E.164 phone number
   * @param body - Message body (≤ 320 chars recommended)
   */
  sendSms(to: string, body: string): Promise<void>;

  /**
   * Initiate an outbound callback call to verify a family member.
   * @param to - E.164 phone number of the family member
   * @param callSid - Original screening call's SID (for context)
   * @param claimedName - What the caller claimed their name was
   */
  startCallbackCall(to: string, callSid: string, claimedName: string): Promise<void>;

  /**
   * Transfer an in-progress call to the senior's phone.
   * In Twilio this is done via TwiML <Dial>; for mock this is a no-op.
   * @param callSid - Twilio CallSid of the screening call
   * @param toNumber - Senior's phone number
   */
  connectCall(callSid: string, toNumber: string): Promise<void>;

  /**
   * End an active call immediately.
   * @param callSid - Twilio CallSid
   */
  endCall(callSid: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Twilio implementation (production)
// ---------------------------------------------------------------------------

export class TwilioTelephony implements TelephonyProvider {
  private client: ReturnType<typeof twilio>;
  private fromNumber: string;
  private baseUrl: string;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const baseUrl = process.env.PUBLIC_BASE_URL;

    if (!accountSid || !authToken || !fromNumber || !baseUrl) {
      throw new Error(
        "Missing Twilio credentials: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
        "TWILIO_PHONE_NUMBER, or PUBLIC_BASE_URL",
      );
    }

    this.client = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
    this.baseUrl = baseUrl;
  }

  async sendSms(to: string, body: string): Promise<void> {
    await this.client.messages.create({
      to,
      from: this.fromNumber,
      body,
    });
  }

  async startCallbackCall(to: string, callSid: string, claimedName: string): Promise<void> {
    // Twilio REST API creates an outbound call that hits our callback webhook.
    // The webhook will present DTMF options to the family member.
    await this.client.calls.create({
      to,
      from: this.fromNumber,
      url: `${this.baseUrl}/api/voice/callback?originalCallSid=${encodeURIComponent(callSid)}&claimedName=${encodeURIComponent(claimedName)}`,
      statusCallback: `${this.baseUrl}/api/voice/callback/status?originalCallSid=${encodeURIComponent(callSid)}`,
      statusCallbackEvent: ["completed"],
      method: "POST",
    });
  }

  async connectCall(callSid: string, toNumber: string): Promise<void> {
    // For Twilio, connecting a call is done via TwiML (<Dial> verb) in the
    // response to the turn webhook. The turn route handles this by returning
    // connectTwiml(). This method is a no-op for Twilio because the connection
    // happens declaratively in the TwiML, not via the REST API.
    //
    // We keep this method in the interface for symmetry and for mock
    // implementations that may need to track state.
    void callSid;
    void toNumber;
  }

  async endCall(callSid: string): Promise<void> {
    await this.client.calls(callSid).update({ status: "completed" });
  }
}

// ---------------------------------------------------------------------------
// Mock implementation (dev/test)
// ---------------------------------------------------------------------------

export class MockTelephony implements TelephonyProvider {
  async sendSms(to: string, body: string): Promise<void> {
    console.log(`[MockTelephony] SMS → ${to}: ${body}`);

    await adminDb().from("mock_messages").insert({
      to_number: to,
      body,
      kind: "sms",
    });
  }

  async startCallbackCall(to: string, callSid: string, claimedName: string): Promise<void> {
    console.log(
      `[MockTelephony] Callback call initiated → ${to} ` +
      `(originalCallSid: ${callSid}, claimedName: ${claimedName})`,
    );

    await adminDb().from("mock_messages").insert({
      to_number: to,
      body: JSON.stringify({ originalCallSid: callSid, claimedName }),
      kind: "callback_call",
    });
  }

  async connectCall(callSid: string, toNumber: string): Promise<void> {
    console.log(`[MockTelephony] Call ${callSid} connected → ${toNumber}`);
  }

  async endCall(callSid: string): Promise<void> {
    console.log(`[MockTelephony] Call ${callSid} ended.`);
  }
}
