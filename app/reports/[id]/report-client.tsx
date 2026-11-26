"use client";

/**
 * app/reports/[id]/report-client.tsx
 *
 * Client-side part of the report page: read-only CAFC text, a copy button
 * and a print button. Nothing is submitted anywhere; the family copies the
 * text and files the report themselves.
 *
 * Opening the page with ?print=1 opens the browser print dialog once.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

export default function ReportClient({ cafcText }: { cafcText: string }) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("print") === "1") {
      window.print();
    }
  }, []);

  async function handleCopy() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(cafcText);
      toast.add({ title: "Copied", description: "CAFC text copied.", type: "success" });
    } catch {
      // Clipboard may be blocked: select the text so the user can press Ctrl/Cmd+C.
      textareaRef.current?.focus();
      textareaRef.current?.select();
      setCopyError("Could not copy automatically. The text is selected: press Ctrl+C (Cmd+C on Mac).");
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold">Copy for CAFC report</h2>
      <textarea
        ref={textareaRef}
        readOnly
        value={cafcText}
        rows={14}
        aria-label="CAFC report text"
        className="w-full rounded-lg border border-input bg-card p-3 font-mono text-base text-card-foreground"
      />
      <div className="mt-3 flex flex-wrap gap-3 print:hidden">
        <Button type="button" onClick={handleCopy} className="text-base">
          Copy for CAFC report
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => window.print()}
          className="text-base"
        >
          Print
        </Button>
      </div>
      {copyError && (
        <p role="alert" className="mt-3 text-base font-medium text-red-500 print:hidden">
          {copyError}
        </p>
      )}
    </section>
  );
}
