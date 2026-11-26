/**
 * app/reports/[id]/page.tsx
 *
 * Fraud report view — PDF/print friendly.
 *
 * Shows the full structured fraud report and a "Copy for CAFC report"
 * textarea the family can copy and paste into the CAFC online form.
 * Nothing is submitted automatically from this page.
 *
 * URL: /reports/{fraud_reports.id}
 *
 * Print: add  ?print=1  to open with the print dialog, or use the browser's
 * built-in Print (Ctrl/Cmd+P). The page uses Tailwind's print: variants to
 * hide the action buttons and show the full transcript.
 */

import { notFound } from "next/navigation";
import { loadReport, buildCafcText } from "@/lib/report";
import ReportClient from "./report-client";

// params is a Promise in Next.js 15+.
interface PageParams {
  params: Promise<{ id: string }>;
}

export default async function ReportPage({ params }: PageParams) {
  const { id } = await params;

  const result = await loadReport(id);
  if (!result) notFound();

  const { row, data } = result;
  const cafcText = buildCafcText(data);

  return (
    <main className="min-h-screen bg-white p-8 max-w-3xl mx-auto font-sans">
      {/* Print header */}
      <header className="mb-8 border-b pb-4">
        {data.is_simulated && (
          <p
            role="note"
            className="mb-4 border-2 border-red-600 bg-red-50 p-3 text-base font-bold text-red-800"
          >
            SIMULATED: this report comes from a test call. Do not file it with the
            police or the CAFC.
          </p>
        )}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Ghostline Fraud Report
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Report ID: {row.id}
            </p>
          </div>
          {/* Risk badge */}
          <span
            className={`px-3 py-1 rounded-full text-sm font-semibold uppercase ${
              data.risk_level === "high"
                ? "bg-red-100 text-red-800"
                : data.risk_level === "medium"
                  ? "bg-yellow-100 text-yellow-800"
                  : "bg-green-100 text-green-800"
            }`}
          >
            {data.risk_level} risk · {data.risk_score}/100
          </span>
        </div>
      </header>

      {/* Summary section */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Summary</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Dt>Date &amp; time</Dt>
          <Dd>{new Date(data.date_time).toLocaleString("en-CA")}</Dd>

          <Dt>Caller number</Dt>
          <Dd>{data.caller_number}</Dd>

          <Dt>Claimed identity</Dt>
          <Dd>{data.claimed_identity ?? "—"}</Dd>

          <Dt>Scam type</Dt>
          <Dd>{data.scam_type}</Dd>

          <Dt>Amount requested</Dt>
          <Dd>{data.amount ?? "—"}</Dd>

          <Dt>Payment method</Dt>
          <Dd>{data.payment_method ?? "—"}</Dd>

          <Dt>Safe word</Dt>
          <Dd>
            <span
              className={
                data.safe_word_result === "passed"
                  ? "text-green-700 font-medium"
                  : data.safe_word_result === "failed"
                    ? "text-red-700 font-medium"
                    : "text-gray-500"
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
                  ? "text-red-700 font-medium"
                  : data.callback_result === "confirmed"
                    ? "text-green-700 font-medium"
                    : "text-gray-500"
              }
            >
              {data.callback_result}
            </span>
          </Dd>
        </dl>
        {data.summary && (
          <p className="mt-3 text-sm text-gray-700 italic border-l-4 border-gray-300 pl-3">
            {data.summary}
          </p>
        )}
      </section>

      {/* Red flags */}
      {data.red_flags.length > 0 && (
        <section className="mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">
            Red flags detected
          </h2>
          <ul className="space-y-1">
            {data.red_flags.map((f, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="font-mono bg-red-50 text-red-700 px-2 py-0.5 rounded text-xs">
                  {f.flag_id}
                </span>
                <span className="text-gray-700">{f.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Transcript */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">
          Full transcript
        </h2>
        <ol className="space-y-2">
          {data.transcript.map((t, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span
                className={`w-20 shrink-0 font-semibold ${
                  t.speaker === "caller" ? "text-orange-700" : "text-blue-700"
                }`}
              >
                {t.speaker.toUpperCase()}
              </span>
              <span className="text-gray-800">{t.text}</span>
            </li>
          ))}
          {data.transcript.length === 0 && (
            <li className="text-gray-400 italic text-sm">No transcript recorded.</li>
          )}
        </ol>
      </section>

      {/* Client-side: CAFC copy button + print button */}
      <ReportClient cafcText={cafcText} />

      {/* Legal footer */}
      <footer className="mt-12 pt-4 border-t text-xs text-gray-400 print:block">
        <p>
          Generated by Ghostline · Report a fraud at{" "}
          <a
            href="https://antifraudcentre-centreantifraude.ca/reportincident-signalerincident-eng.htm"
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            antifraudcentre-centreantifraude.ca
          </a>
        </p>
        <p className="mt-1">
          This report is for your records only. Nothing has been submitted automatically.
        </p>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Tiny layout helpers (keep the JSX above readable)
// ---------------------------------------------------------------------------

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-gray-500">{children}</dt>;
}

function Dd({ children }: { children: React.ReactNode }) {
  return <dd className="text-gray-900 font-medium">{children}</dd>;
}
