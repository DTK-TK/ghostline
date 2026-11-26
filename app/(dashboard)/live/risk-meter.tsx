import { clampScore, riskDisplay, RISK_MARKS } from "@/lib/risk-display";
import type { LiveLevel } from "@/lib/live-status";

export function RiskMeter({ level, score }: { level: LiveLevel; score: number }) {
  const d = riskDisplay(level);
  const value = clampScore(score);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-2xl font-bold ${d.text}`}>{d.label}</span>
        <span className="text-base">Score {value} / 100</span>
      </div>
      <div
        role="meter"
        aria-label="Scam risk"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${d.label} risk, score ${value} of 100`}
        className="relative h-4 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full transition-all ${d.bar}`} style={{ width: `${value}%` }} />
        {RISK_MARKS.map((m) => (
          <div
            key={m}
            aria-hidden="true"
            className="absolute top-0 h-full w-0.5 bg-foreground/70"
            style={{ left: `${m}%` }}
          />
        ))}
      </div>
      <div className="relative h-5 text-base text-muted-foreground" aria-hidden="true">
        {RISK_MARKS.map((m) => (
          <span key={m} className="absolute -translate-x-1/2" style={{ left: `${m}%` }}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}
