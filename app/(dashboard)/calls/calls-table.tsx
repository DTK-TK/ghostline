"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CallsPageData } from "@/lib/calls-list";
import { formatStart } from "@/lib/format-start";
import { riskDisplay } from "@/lib/risk-display";

const linkClass =
  "rounded text-base font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export function CallsTable({ initial }: { initial: CallsPageData }) {
  const [rows, setRows] = useState(initial.rows);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/calls?before=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const page = (await res.json()) as CallsPageData;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return <p className="text-base text-muted-foreground">No calls yet.</p>;
  }

  return (
    <div className="space-y-4">
      <Table className="text-base">
        <TableHeader>
          <TableRow>
            <TableHead className="text-base">Started</TableHead>
            <TableHead className="text-base">Caller</TableHead>
            <TableHead className="text-base">Claimed identity</TableHead>
            <TableHead className="text-base">Risk</TableHead>
            <TableHead className="text-base">Score</TableHead>
            <TableHead className="text-base">Outcome</TableHead>
            <TableHead className="text-base">Links</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const risk = r.level ? riskDisplay(r.level) : null;
            return (
              <TableRow key={r.id}>
                <TableCell suppressHydrationWarning>{formatStart(r.startedAt)}</TableCell>
                <TableCell className="font-mono">{r.from}</TableCell>
                <TableCell>{r.claimedIdentity ?? "Unknown"}</TableCell>
                <TableCell>
                  {risk ? (
                    <span className={`font-bold ${risk.text}`}>{risk.label}</span>
                  ) : (
                    <span className="text-muted-foreground">Not scored</span>
                  )}
                </TableCell>
                <TableCell>{r.score ?? "-"}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {r.outcome ?? "In progress"}
                    {r.simulated && (
                      <Badge variant="outline" className="h-auto text-base">
                        SIMULATED
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-4">
                    <Link href={`/calls/${r.id}`} className={linkClass}>
                      Details
                    </Link>
                    {r.reportId && (
                      <Link href={`/reports/${r.reportId}`} className={linkClass}>
                        Report
                      </Link>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {error && (
        <p role="alert" className="text-base text-red-500">
          Could not load more calls. Try again.
        </p>
      )}
      {cursor && (
        <Button type="button" variant="outline" onClick={loadMore} disabled={loading} className="h-auto px-4 py-2 text-base">
          {loading ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}
