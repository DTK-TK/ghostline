"use client";

/**
 * usePolledCall(callId, intervalMs)
 *
 * Polls GET /api/live. With callId null it follows the active call and locks
 * onto it once found. Events are merged by id (lib/merge-events.ts). Polling
 * stops after the ended call's final state was fetched, or on 401/404.
 */

import { useEffect, useState } from "react";
import { mergeEvents } from "@/lib/merge-events";
import { isReconnecting, shouldKeepPolling } from "@/lib/poll-state";
import type { LivePayload } from "@/lib/live-poll";
import type { PublicCall, PublicEvent } from "@/lib/live-public";

export interface PolledCall {
  call: PublicCall | null;
  events: PublicEvent[];
  reportId: string | null;
  /** Time of the last successful poll, or null before the first. */
  lastUpdated: Date | null;
  reconnecting: boolean;
  /** Set when polling stopped for good: "unauthorized", "not_found" or "ended". */
  stopped: null | "unauthorized" | "not_found" | "ended";
}

export function usePolledCall(callId: string | null, intervalMs = 2000): PolledCall {
  const [state, setState] = useState<PolledCall>({
    call: null,
    events: [],
    reportId: null,
    lastUpdated: null,
    reconnecting: false,
    stopped: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let endedFetches = 0;
    let lockedId: string | null = callId;

    const finish = (patch: Partial<PolledCall>) => setState((s) => ({ ...s, ...patch }));

    const poll = async () => {
      let next = true;
      try {
        const qs = lockedId ? `?callId=${encodeURIComponent(lockedId)}` : "";
        const res = await fetch(`/api/live${qs}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          finish({ stopped: "unauthorized" });
          return;
        }
        if (res.status === 404 || res.status === 400) {
          finish({ stopped: "not_found" });
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as LivePayload;
        if (cancelled) return;
        failures = 0;
        if (data.call) {
          lockedId = data.call.id;
          if (data.call.ended_at) endedFetches += 1;
          next = shouldKeepPolling(endedFetches);
        }
        setState((s) => ({
          call: data.call ?? s.call,
          events: data.call ? mergeEvents(s.call?.id === data.call.id ? s.events : [], data.events) : s.events,
          reportId: data.reportId ?? (data.call && s.call?.id === data.call.id ? s.reportId : null),
          lastUpdated: new Date(),
          reconnecting: false,
          stopped: next ? null : "ended",
        }));
      } catch {
        if (cancelled) return;
        failures += 1;
        if (isReconnecting(failures)) setState((s) => ({ ...s, reconnecting: true }));
      }
      if (next && !cancelled) timer = setTimeout(poll, intervalMs);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [callId, intervalMs]);

  return state;
}
