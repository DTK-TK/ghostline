"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildTimeline, outcomeText } from "@/lib/call-timeline";
import { formatStart } from "@/lib/format-start";
import { connectionView, formatDuration } from "@/lib/live-format";
import type { LivePayload } from "@/lib/live-poll";
import { deriveLiveStatus } from "@/lib/live-status";
import { useNow } from "@/lib/use-now";
import { usePolledCall } from "@/lib/use-polled-call";
import { FlagChips } from "../../live/flag-chips";
import { RiskMeter } from "../../live/risk-meter";
import { StatusRows } from "../../live/status-rows";
import { Transcript } from "../../live/transcript";

const linkClass =
  "rounded text-base font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export function CallDetails({ callId, initial }: { callId: string; initial: LivePayload }) {
  const polled = usePolledCall(callId, 2000);
  const now = useNow(1000);

  // Server data first; polled data once the first poll has landed.
  const call = polled.call ?? initial.call;
  const events = polled.lastUpdated ? polled.events : initial.events;
  const reportId = polled.reportId ?? initial.reportId;

  const status = useMemo(() => (call ? deriveLiveStatus(call, events, now) : null), [call, events, now]);
  const timeline = useMemo(() => buildTimeline(events), [events]);

  if (!call || !status) return <p className="text-base">This call could not be loaded.</p>;

  const ended = Boolean(call.ended_at);
  const conn = connectionView(polled.lastUpdated, polled.reconnecting, now);

  if (polled.stopped === "unauthorized") {
    return (
      <p className="text-base">
        Your session expired. <Link className="underline" href="/unlock">Enter the passcode again</Link>.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {!ended ? (
        <div className="flex flex-wrap items-center gap-3 text-base" aria-live="polite">
          <span
            className={`inline-block size-3 rounded-full ${conn.ok ? "bg-green-500" : "bg-amber-500"}`}
            aria-hidden="true"
          />
          <span>{conn.label}</span>
        </div>
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
          <p className="text-base text-muted-foreground">Started {formatStart(call.started_at)}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <RiskMeter level={status.level} score={status.score} />
          <dl className="space-y-3 text-base">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
              <dt className="text-muted-foreground">Outcome</dt>
              <dd className="font-medium sm:text-right">{outcomeText(call.outcome, ended)}</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
              <dt className="text-muted-foreground">Scammer time wasted</dt>
              <dd className="font-medium sm:text-right">
                {status.timeWasted ? (
                  <span className="font-mono">
                    {formatDuration(status.timeWasted.seconds)}
                    {status.timeWasted.running ? "" : " (stopped)"}
                  </span>
                ) : (
                  "None"
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
              <dt className="text-muted-foreground">Fraud report</dt>
              <dd className="font-medium sm:text-right">
                {reportId ? (
                  <Link className={linkClass} href={`/reports/${reportId}`}>
                    Open the fraud report
                  </Link>
                ) : (
                  "A report is created when a HIGH call ends"
                )}
              </dd>
            </div>
          </dl>
          {call.summary ? <p className="text-base">{call.summary}</p> : null}
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
              <CardTitle className="text-xl">Safe word and family check</CardTitle>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <p className="text-base text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="space-y-2 text-base">
              {timeline.map((t) => (
                <li key={t.id} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                  <time dateTime={t.at} className="font-mono text-muted-foreground">
                    {new Date(t.at).toLocaleTimeString()}
                  </time>
                  <span>{t.text}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
