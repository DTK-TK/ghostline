import { callbackText, formatDuration, safeWordText, stateText } from "@/lib/live-format";
import type { LiveStatus } from "@/lib/live-status";

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="font-medium sm:text-right">{children}</dd>
    </div>
  );
}

export function StatusRows({ status }: { status: LiveStatus }) {
  const tw = status.timeWasted;
  return (
    <dl aria-live="polite" className="space-y-3 text-base">
      <Row term="Call state">{stateText(status.state)}</Row>
      <Row term="Safe word">{safeWordText(status.safeWord, status.attempts)}</Row>
      <Row term="Family check">{callbackText(status.callback, status.callbackTarget)}</Row>
      {tw ? (
        <Row term="Scammer time wasted">
          <span className="font-mono">{formatDuration(tw.seconds)}</span>
          {tw.running ? "" : " (stopped)"}
        </Row>
      ) : null}
    </dl>
  );
}
