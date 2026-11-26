"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { connectionView } from "@/lib/live-format";
import { deriveLiveStatus } from "@/lib/live-status";
import { useNow } from "@/lib/use-now";
import { usePolledCall } from "@/lib/use-polled-call";
import { FlagChips } from "./flag-chips";
import { RiskMeter } from "./risk-meter";
import { SimulateButton, type ScenarioOption } from "./simulate-button";
import { StatusRows } from "./status-rows";
import { Transcript } from "./transcript";

export function LiveCall({ simulator = null }: { simulator?: { scenarios: ScenarioOption[] } | null }) {
  const polled = usePolledCall(null, 2000);
  const now = useNow(1000);
  const { call, events } = polled;

  const status = useMemo(() => (call ? deriveLiveStatus(call, events, now) : null), [call, events, now]);
  const conn = connectionView(polled.lastUpdated, polled.reconnecting, now);
  const ended = Boolean(call?.ended_at);

  if (polled.stopped === "unauthorized") {
    return (
      <p className="text-base">
        Your session expired. <Link className="underline" href="/unlock">Enter the passcode again</Link>.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-base" aria-live="polite">
        <span
          className={`inline-block size-3 rounded-full ${conn.ok ? "bg-green-500" : "bg-amber-500"}`}
          aria-hidden="true"
        />
        <span>{conn.label}</span>
      </div>

      <div id="simulate-slot">{simulator ? <SimulateButton scenarios={simulator.scenarios} /> : null}</div>

      {!call || !status ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">No active call</CardTitle>
          </CardHeader>
          <CardContent className="text-base text-muted-foreground">
            Waiting for the next call. This page updates by itself.
          </CardContent>
        </Card>
      ) : (
        <>
          {ended ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-xl">No active call</CardTitle>
              </CardHeader>
              <CardContent className="text-base text-muted-foreground">Showing the last call below.</CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3 text-xl">
                <span>{call.claimed_identity ?? "Unknown caller"}</span>
                <span className="font-mono text-base font-normal text-muted-foreground">{call.from_number}</span>
                {status.simulated ? (
                  <Badge variant="outline" className="h-auto px-3 py-1 text-base">
                    SIMULATED
                  </Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RiskMeter level={status.level} score={status.score} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-xl">Transcript</CardTitle>
              </CardHeader>
              <CardContent>
                <Transcript lines={status.transcript} />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl">Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <StatusRows status={status} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl">Warning signs</CardTitle>
                </CardHeader>
                <CardContent aria-live="polite">
                  <FlagChips flags={status.flags} />
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
