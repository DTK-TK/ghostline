/**
 * lib/live-poll.ts
 *
 * Logic behind GET /api/live. The route file only adapts the Request.
 * Passcode checking is done by proxy.ts before this runs.
 */

import { z } from "zod";
import {
  getActiveCall,
  getCallById,
  getCallEvents,
  getFraudReportId,
  type CallEventRow,
  type CallRow,
} from "@/lib/db";
import { toPublicCall, toPublicEvent, type PublicCall, type PublicEvent } from "@/lib/live-public";

export interface LivePayload {
  call: PublicCall | null;
  events: PublicEvent[];
  reportId: string | null;
  serverTime: string;
}

export type LiveResult =
  | { status: 200; body: LivePayload }
  | { status: 400 | 404 | 500; body: { error: string } };

export interface LiveDeps {
  getCallById(id: string): Promise<CallRow | null>;
  getActiveCall(now: Date): Promise<CallRow | null>;
  getCallEvents(callId: string): Promise<CallEventRow[]>;
  getFraudReportId(callId: string): Promise<string | null>;
  now(): Date;
}

const defaultDeps: LiveDeps = {
  getCallById,
  getActiveCall: (now) => getActiveCall(now),
  getCallEvents,
  getFraudReportId,
  now: () => new Date(),
};

const CallIdSchema = z.uuid();

export async function getLivePayload(callId: string | null, deps: LiveDeps = defaultDeps): Promise<LiveResult> {
  const now = deps.now();
  try {
    let call: CallRow | null;
    if (callId === null) {
      call = await deps.getActiveCall(now);
      if (!call) {
        return { status: 200, body: { call: null, events: [], reportId: null, serverTime: now.toISOString() } };
      }
    } else {
      const parsed = CallIdSchema.safeParse(callId);
      if (!parsed.success) return { status: 400, body: { error: "Invalid callId" } };
      call = await deps.getCallById(parsed.data);
      if (!call) return { status: 404, body: { error: "Call not found" } };
    }

    const [events, reportId] = await Promise.all([deps.getCallEvents(call.id), deps.getFraudReportId(call.id)]);
    return {
      status: 200,
      body: {
        call: toPublicCall(call),
        events: events.map(toPublicEvent),
        reportId,
        serverTime: now.toISOString(),
      },
    };
  } catch (err) {
    console.error("[live] error:", err instanceof Error ? err.message : "unknown");
    return { status: 500, body: { error: "Internal server error" } };
  }
}
