"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isNearBottom } from "@/lib/live-format";
import type { LiveTranscriptLine } from "@/lib/live-status";

const SPEAKER = { caller: "CALLER", ghostline: "GHOSTLINE" } as const;

export function Transcript({ lines }: { lines: LiveTranscriptLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  // Auto-scroll on new lines, only while the viewer is at the bottom.
  useEffect(() => {
    const el = box.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines.length, following]);

  const onScroll = () => {
    const el = box.current;
    if (el) setFollowing(isNearBottom(el));
  };

  const jump = () => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
    setFollowing(true);
  };

  return (
    <div className="relative">
      <div
        ref={box}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Call transcript"
        tabIndex={0}
        className="h-80 space-y-3 overflow-y-auto rounded-lg bg-muted/40 p-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">Nothing said yet.</p>
        ) : (
          lines.map((l) => (
            <p key={l.id}>
              <span className="mr-2 font-mono text-sm font-bold">{SPEAKER[l.speaker]}</span>
              {l.text}
            </p>
          ))
        )}
      </div>
      {!following ? (
        <Button className="absolute right-3 bottom-3 h-10 px-4 text-base" onClick={jump}>
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}
