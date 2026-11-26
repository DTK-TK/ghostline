/**
 * app/reports/[id]/page.tsx
 *
 * Fraud report view. Dark on screen, white in print (see the @media print
 * token remap in app/globals.css). Text is 16 px or larger.
 *
 * Shows the structured fraud report and a "Copy for CAFC report" textarea the
 * family can paste into the CAFC online form. Nothing is submitted
 * automatically from this page.
 *
 * URL: /reports/{fraud_reports.id}
 *
 * Print: use the Print button or the browser's own print (Ctrl/Cmd+P). Open
 * with ?print=1 to start the print dialog (handled in report-client.tsx).
 *
 * Cache Components is on, so the route-segment `dynamic` export is not
 * available. The data read happens inside <Suspense>, per request.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { loadReport, buildCafcText } from "@/lib/report";
import { formatReportTime, parseReportId, riskDisplay } from "@/lib/report-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReportClient from "./report-client";

export const metadata: Metadata = {
  title: "Fraud report | Ghostline",
  robots: { index: false, follow: false },
};

// params is a Promise in Next.js 15+.
interface PageParams {
  params: Promise<{ id: string }>;
}

export default function ReportPage({ params }: PageParams) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl p-8 text-base">Loading report...</main>
      }
    >
      <ReportContent params={params} />
    </Suspense>
  );
}

async function ReportContent({ params }: PageParams) {
  const { id: raw } = await params;
  const id = parseReportId(raw);
  if (!id) notFound();

  const result = await loadReport(id);
  if (!result) notFound();

  const { row, data } = result;
  const cafcText = buildCafcText(data);
  const risk = riskDisplay(data.risk_level);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl space-y-6 p-8 text-base">
      <header className="space-y-4 border-b pb-4">
        {data.is_simulated && (
          <p
            role="note"
            className="border-2 border-red-500 p-3 text-base font-bold text-red-500 print:text-black"
          >
            SIMULATED: this report comes from a test call. Do not file it with the
            police or the CAFC.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-2xl font-bold">Ghostline Fraud Report</h1>
            <p className="mt-1 text-base text-muted-foreground">Report ID: {row.id}</p>
          </div>
          <Badge
            variant="outline"
            className={`h-auto px-3 py-1 text-base font-semibold ${risk.className}`}
          >
            {risk.label} risk - {data.risk_score}/100
          </Badge>
        </div>
      </header>

      <Card className="text-base">
        <CardHeader>
          <CardTitle className="text-lg">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 print:grid-cols-2">
            <Dt>Date and time (UTC)</Dt>
            <Dd>{formatReportTime(data.date_time)}</Dd>

            <Dt>Caller number</Dt>
            <Dd>{data.caller_number}</Dd>

            <Dt>Claimed identity</Dt>
            <Dd>{data.claimed_identity ?? "not stated"}</Dd>

            <Dt>Scam type</Dt>
            <Dd>{data.scam_type}</Dd>

            <Dt>Amount requested</Dt>
            <Dd>{data.amount ?? "not stated"}</Dd>

            <Dt>Payment method</Dt>
            <Dd>{data.payment_method ?? "not stated"}</Dd>

            <Dt>Safe word</Dt>
            <Dd>
              <span
                className={
                  data.safe_word_result === "passed"
                    ? "text-green-500 print:text-black"
                    : data.safe_word_result === "failed"
                      ? "text-red-500 print:text-black"
                      : "text-muted-foreground"
                }
              >
                {data.safe_word_result}
              </span>
            </Dd>

            <Dt>Callback</Dt>
            <Dd>
              <span
                className={
                  data.callback_result === "denied"
                    ? "text-red-500 print:text-black"
                    : data.callback_result === "confirmed"
                      ? "text-green-500 print:text-black"
                      : "text-muted-foreground"
                }
              >
                {data.callback_result}
              </span>
            </Dd>
          </dl>
          {data.summary && (
            <p className="mt-4 border-l-4 border-border pl-3 italic">{data.summary}</p>
          )}
        </CardContent>
      </Card>

      {data.red_flags.length > 0 && (
        <Card className="text-base">
          <CardHeader>
            <CardTitle className="text-lg">Red flags detected</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.red_flags.map((f, i) => (
                <li key={i} className="flex flex-wrap gap-2">
                  <Badge
                    variant="outline"
                    className="h-auto border-red-500 px-2 py-0.5 font-mono text-base text-red-500 print:border-black print:text-black"
                  >
                    {f.flag_id}
                  </Badge>
                  {f.quote ? <span>&quot;{f.quote}&quot;</span> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="text-base">
        <CardHeader>
          <CardTitle className="text-lg">Full transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2">
            {data.transcript.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-24 shrink-0 font-semibold">
                  {t.speaker.toUpperCase()}
                </span>
                <span>{t.text}</span>
              </li>
            ))}
            {data.transcript.length === 0 && (
              <li className="italic text-muted-foreground">No transcript recorded.</li>
            )}
          </ol>
        </CardContent>
      </Card>

      {/* Client side: CAFC copy button + print button */}
      <ReportClient cafcText={cafcText} />

      <footer className="space-y-1 border-t pt-4 text-base text-muted-foreground">
        <p>
          Generated by Ghostline. Report a fraud at{" "}
          <a
            href="https://antifraudcentre-centreantifraude.ca/reportincident-signalerincident-eng.htm"
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            antifraudcentre-centreantifraude.ca
          </a>
        </p>
        <p>This report is for your records only. Nothing has been submitted automatically.</p>
      </footer>
    </main>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function Dd({ children }: { children: React.ReactNode }) {
  return <dd className="font-medium">{children}</dd>;
}
