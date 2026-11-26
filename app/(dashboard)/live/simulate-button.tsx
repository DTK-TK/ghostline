"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";

export const STEP_DELAY_MS = 1500;

export interface ScenarioOption {
  id: string;
  label: string;
}

type Phase = "idle" | "running" | "done" | "error";

export function SimulateButton({ scenarios }: { scenarios: ScenarioOption[] }) {
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<{ callSid: string; total: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function fail(message: string) {
    setPhase("error");
    setProgress(message);
  }

  async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function runStep(callSid: string, index: number, total: number) {
    if (cancelled.current) return;
    setProgress(`Line ${index + 1} of ${total}`);
    post("/api/simulate/step", { callSid, index })
      .then((r) => {
        if (cancelled.current) return;
        if (!r.ok) return fail(r.data?.error ?? "The simulation stopped");
        if (r.data.done) {
          setPhase("done");
          setProgress("Simulation finished");
          return;
        }
        timer.current = setTimeout(() => runStep(callSid, index + 1, total), STEP_DELAY_MS);
      })
      .catch(() => fail("The simulation stopped. Check your connection."));
  }

  /** Ask first when the start response would send real SMS. */
  async function onClick() {
    // The start response carries willSendRealSms, so the dialog sits after it:
    // the call row exists, but no line plays (and no SMS goes out) until the
    // user confirms.
    setPhase("running");
    setProgress("Starting...");
    try {
      const r = await post("/api/simulate", { scenarioId });
      if (!r.ok) return fail(r.data?.error ?? "Could not start");
      if (r.data.willSendRealSms) {
        setPending({ callSid: r.data.callSid, total: r.data.total });
        setConfirmOpen(true);
        setProgress("Waiting for confirmation");
        return;
      }
      runStep(r.data.callSid, 0, r.data.total);
    } catch {
      fail("Could not start. Check your connection.");
    }
  }

  function confirm() {
    if (!pending) return;
    setConfirmOpen(false);
    runStep(pending.callSid, 0, pending.total);
    setPending(null);
  }

  function decline() {
    setConfirmOpen(false);
    setPending(null);
    setPhase("idle");
    setProgress("");
  }

  const busy = phase === "running";

  return (
    <div className="flex flex-wrap items-center gap-3 text-base">
      <Badge variant="outline" className="h-auto px-3 py-1 text-base">
        SIMULATED
      </Badge>
      <label htmlFor="scenario" className="sr-only">
        Scenario
      </label>
      <NativeSelect
        id="scenario"
        className="w-auto min-w-64"
        value={scenarioId}
        disabled={busy}
        onChange={(e) => setScenarioId(e.target.value)}
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </NativeSelect>
      <Button type="button" className="h-9 px-4 text-base" disabled={busy || !scenarioId} onClick={onClick}>
        Simulate a call
      </Button>
      <span role="status" aria-live="polite" className={phase === "error" ? "text-red-500" : "text-muted-foreground"}>
        {progress}
      </span>

      <Dialog open={confirmOpen} onOpenChange={(open) => (open ? undefined : decline())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-lg">Send real text messages?</DialogTitle>
            <DialogDescription className="text-base">This sends real SMS to the demo family.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="text-base" onClick={decline}>
              Cancel
            </Button>
            <Button type="button" className="text-base" onClick={confirm}>
              Send and run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
