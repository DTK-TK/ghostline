"use client";

/**
 * app/dev/phone/phone-client.tsx
 *
 * Browser phone simulator.
 *
 * Layout (dark theme, ui.md):
 *   ┌─────────────────────────────────────────────────────┐
 *   │  GHOSTLINE  DEV PHONE                               │  header
 *   ├──────────────────────────────┬──────────────────────┤
 *   │  Chat + controls             │  Mock Inbox          │
 *   │                              │                      │
 *   │  [from number] [household ▾] │  SMS messages        │
 *   │  [Call]                      │  callback_call rows  │
 *   │                              │                      │
 *   │  bubble: GHOSTLINE           │                      │
 *   │  bubble: CALLER              │                      │
 *   │                              │                      │
 *   │  ── Callback card ──         │                      │
 *   │  [Confirmed] [Denied] [—]    │                      │
 *   │                              │                      │
 *   │  [text input] [Talk] [Send]  │                      │
 *   │                              │                      │
 *   │  ── Debug: state/score/flags │                      │
 *   └──────────────────────────────┴──────────────────────┘
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { MockMessageRow } from "@/app/api/dev/phone/inbox/route";
import { displaySeconds, formatMmSs } from "@/lib/time-waster";
import type { TimeWastedView } from "@/lib/time-waster";

// ---------------------------------------------------------------------------
// Web Speech API — full inline declarations.
// The TS "dom" lib covers SpeechSynthesis but not SpeechRecognition on older
// targets. We define exactly what we use to avoid runtime surprises.
// ---------------------------------------------------------------------------

interface SpeechRecognitionResult {
  readonly 0: SpeechRecognitionAlternative;
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  readonly 0: SpeechRecognitionResult;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

declare global {
  interface Window {
    SpeechRecognition: SpeechRecognitionConstructor | undefined;
    webkitSpeechRecognition: SpeechRecognitionConstructor | undefined;
  }
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type CallPhase = "idle" | "active" | "ended";

interface ChatMessage {
  speaker: "caller" | "ghostline" | "system";
  text: string;
}

interface ActiveCall {
  callSid: string;
  state: string;
  riskScore: number;
  riskLevel: string;
  flags: string[];
  timeWasted: TimeWastedView | null;
}

interface CallbackPending {
  name: string;
  phone: string;
  originalCallSid: string;
}

interface HouseholdOption {
  id: string;
  family_name: string;
  senior_phone: string;
}

// API response shapes
interface StartResponse {
  callSid?: string;
  reply?: string;
  state?: string;
  trusted?: boolean;
  error?: string;
}

interface TurnResponse {
  reply?: string;
  state?: string;
  riskScore?: number;
  riskLevel?: string;
  flags?: string[];
  hangup?: boolean;
  timeWasted?: TimeWastedView;
  callbackPending?: CallbackPending;
  error?: string;
}

interface CallbackAnswerResponse {
  outcome?: string;
  riskScore?: number;
  riskLevel?: string;
  state?: string;
  error?: string;
}

interface InboxResponse {
  messages: MockMessageRow[];
}

// ---------------------------------------------------------------------------
// Risk colour helpers (ui.md: colour + text label for accessibility)
// ---------------------------------------------------------------------------

function riskTextColour(level: string): string {
  if (level === "high" || level === "critical") return "text-red-500";
  if (level === "medium") return "text-amber-500";
  return "text-green-500";
}

function riskBorder(level: string): string {
  if (level === "high" || level === "critical") return "border-red-500/40 bg-red-500/10";
  if (level === "medium") return "border-amber-500/40 bg-amber-500/10";
  return "border-green-500/40 bg-green-500/10";
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function PhoneClient({ households }: { households: HouseholdOption[] }) {
  // ── Setup ─────────────────────────────────────────────────────────────────
  const [fromNumber, setFromNumber] = useState("+15550009999");
  const [selectedHousehold, setSelectedHousehold] = useState<HouseholdOption | null>(
    households[0] ?? null,
  );

  // ── Call ──────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [callbackPending, setCallbackPending] = useState<CallbackPending | null>(null);

  // ── Input ─────────────────────────────────────────────────────────────────
  const [inputText, setInputText] = useState("");
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);

  // ── Inbox ─────────────────────────────────────────────────────────────────
  const [inbox, setInbox] = useState<MockMessageRow[]>([]);
  const [lastInboxAt, setLastInboxAt] = useState<string | null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---------------------------------------------------------------------------
  // Mock inbox poller — every 3 s
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;

    const poll = async () => {
      try {
        const qs = lastInboxAt ? `?since=${encodeURIComponent(lastInboxAt)}` : "";
        const res = await fetch(`/api/dev/phone/inbox${qs}`);
        if (!res.ok || !alive) return;
        const json = await res.json() as InboxResponse;
        if (!alive || json.messages.length === 0) return;

        setInbox((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const fresh = json.messages.filter((m) => !seen.has(m.id));
          if (fresh.length === 0) return prev;
          setLastInboxAt(fresh[0]!.created_at);
          return [...fresh, ...prev];
        });
      } catch {
        /* network hiccup — ignore silently */
      }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [lastInboxAt]);

  // ---------------------------------------------------------------------------
  // Speech synthesis — speak a reply aloud
  // ---------------------------------------------------------------------------
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 0.9;
    utt.pitch = 1.0;
    window.speechSynthesis.speak(utt);
  }, []);

  // ---------------------------------------------------------------------------
  // Chat helpers
  // ---------------------------------------------------------------------------
  const pushSystem = (text: string) =>
    setMessages((prev) => [...prev, { speaker: "system" as const, text }]);

  const pushGhostline = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { speaker: "ghostline" as const, text }]);
      speak(text);
    },
    [speak],
  );

  // ---------------------------------------------------------------------------
  // Apply a turn response — shared by handleSend and the listening path
  // ---------------------------------------------------------------------------
  const applyTurnResponse = useCallback(
    (json: TurnResponse, callerText: string) => {
      if (callerText) {
        setMessages((prev) => [...prev, { speaker: "caller" as const, text: callerText }]);
      }

      if (json.reply) pushGhostline(json.reply);

      setActiveCall((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          state:      json.state      ?? prev.state,
          riskScore:  json.riskScore  ?? prev.riskScore,
          riskLevel:  json.riskLevel  ?? prev.riskLevel,
          flags:      json.flags      ?? prev.flags,
          timeWasted: json.timeWasted ?? prev.timeWasted,
        };
      });

      if (json.callbackPending) {
        setCallbackPending(json.callbackPending);
      }

      // time_wasted is NOT terminal: the persona keeps talking until the
      // engine ends the call (state "completed").
      const terminal = ["scam_blocked", "completed", "verified", "transferring"];
      if ((json.state && terminal.includes(json.state)) || json.hangup === true) {
        setPhase("ended");
        // Let the goodbye finish; only cancel speech for a user hang-up.
      }
    },
    [pushGhostline],
  );

  // ---------------------------------------------------------------------------
  // Start a call
  // ---------------------------------------------------------------------------
  const handleCall = async () => {
    if (!selectedHousehold) return;
    setMessages([]);
    setActiveCall(null);
    setCallbackPending(null);
    setPhase("active");
    setSending(true);

    try {
      const res = await fetch("/api/dev/phone/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromNumber,
          householdPhone: selectedHousehold.senior_phone,
        }),
      });
      const json = await res.json() as StartResponse;

      if (!res.ok || !json.callSid) {
        pushSystem(`Error: ${json.error ?? res.statusText}`);
        setPhase("idle");
        return;
      }

      setActiveCall({
        callSid:    json.callSid,
        state:      json.state ?? "screening",
        riskScore:  0,
        riskLevel:  "low",
        flags:      [],
        timeWasted: null,
      });

      if (json.reply) pushGhostline(json.reply);
      if (json.trusted) setPhase("ended");
    } catch (err) {
      pushSystem(`Network error: ${err instanceof Error ? err.message : "unknown"}`);
      setPhase("idle");
    } finally {
      setSending(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Send one typed / recognised turn
  // ---------------------------------------------------------------------------
  const handleSend = async (overrideText?: string) => {
    const speech = (overrideText ?? inputText).trim();
    if (!speech || !activeCall) return;

    setInputText("");
    setSending(true);

    try {
      const res = await fetch("/api/dev/phone/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: activeCall.callSid, speechResult: speech }),
      });
      const json = await res.json() as TurnResponse;

      if (!res.ok) {
        pushSystem(`Error: ${json.error ?? res.statusText}`);
        return;
      }

      applyTurnResponse(json, speech);
    } catch (err) {
      pushSystem(`Network error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSending(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Web Speech input
  // ---------------------------------------------------------------------------
  const startListening = () => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      pushSystem("SpeechRecognition is not available in this browser. Try Chrome or Edge.");
      return;
    }

    const r = new Ctor();
    r.lang = "en-CA";
    r.interimResults = false;
    r.maxAlternatives = 1;

    r.onresult = (ev: SpeechRecognitionEvent) => {
      const transcript = ev.results[0]?.[0]?.transcript ?? "";
      setListening(false);
      recognitionRef.current = null;
      if (transcript) {
        setInputText(transcript);
        void handleSend(transcript);
      }
    };

    r.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    r.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = r;
    r.start();
    setListening(true);
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  // ---------------------------------------------------------------------------
  // Callback card answer
  // ---------------------------------------------------------------------------
  const handleCallbackAnswer = async (digit: "1" | "2" | "0") => {
    if (!activeCall || !callbackPending) return;

    try {
      const res = await fetch("/api/dev/phone/callback-answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: activeCall.callSid, digit }),
      });
      const json = await res.json() as CallbackAnswerResponse;

      setCallbackPending(null);

      if (!res.ok) {
        pushSystem(`Callback error: ${json.error ?? res.statusText}`);
        return;
      }

      const label =
        digit === "2" ? "✅ Confirmed — it's really me"
        : digit === "1" ? "🚫 Denied — that's not me"
        : "📵 No answer";
      pushSystem(`Callback: ${label}`);

      setActiveCall((prev) =>
        prev
          ? {
              ...prev,
              state:     json.state     ?? prev.state,
              riskScore: json.riskScore ?? prev.riskScore,
              riskLevel: json.riskLevel ?? prev.riskLevel,
            }
          : prev,
      );

      if (json.state === "scam_blocked") setPhase("ended");
    } catch (err) {
      pushSystem(`Network error: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Hang up
  // ---------------------------------------------------------------------------
  const handleHangUp = () => {
    window.speechSynthesis?.cancel();
    recognitionRef.current?.stop();
    setPhase("ended");
    pushSystem("Call ended by you.");
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col text-base">
      {/* ── Header ── */}
      <header className="flex items-center gap-3 px-6 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <CassetteIcon />
        <span className="font-mono text-xl tracking-widest text-white select-none">GHOSTLINE</span>
        <span className="ml-1 rounded bg-zinc-700 px-2 py-0.5 text-xs font-mono text-amber-400 uppercase tracking-wider">
          dev phone
        </span>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ════════ Left: Chat panel ════════ */}
        <div className="flex flex-col flex-1 min-w-0 border-r border-zinc-800">

          {/* Setup bar */}
          <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-zinc-400" htmlFor="from-number">
                Call from
              </label>
              <input
                id="from-number"
                type="tel"
                value={fromNumber}
                onChange={(e) => setFromNumber(e.target.value)}
                disabled={phase === "active"}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm font-mono w-44
                           disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                placeholder="+15550009999"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-zinc-400" htmlFor="household-select">
                Household
              </label>
              <select
                id="household-select"
                value={selectedHousehold?.id ?? ""}
                onChange={(e) => {
                  setSelectedHousehold(households.find((h) => h.id === e.target.value) ?? null);
                }}
                disabled={phase === "active"}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm
                           disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-zinc-500"
              >
                {households.length === 0 && <option value="">— no households —</option>}
                {households.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.family_name} · {h.senior_phone}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-auto flex gap-2">
              {phase !== "active" ? (
                <button
                  onClick={() => { void handleCall(); }}
                  disabled={!selectedHousehold || sending || households.length === 0}
                  className="rounded bg-green-600 px-5 py-1.5 text-sm font-semibold text-white
                             hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  📞 Call
                </button>
              ) : (
                <button
                  onClick={handleHangUp}
                  className="rounded bg-red-700 px-5 py-1.5 text-sm font-semibold text-white
                             hover:bg-red-600 transition-colors"
                >
                  🔴 Hang up
                </button>
              )}
            </div>
          </div>

          {/* Chat bubbles */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
            {messages.length === 0 && phase === "idle" && (
              <p className="text-zinc-500 text-sm text-center mt-12">
                Pick a household and press <strong className="text-zinc-300">Call</strong> to begin.
              </p>
            )}
            {messages.map((msg, i) => (
              <ChatBubble key={i} msg={msg} />
            ))}
            <div ref={chatBottomRef} />
          </div>

          {/* Callback card */}
          {callbackPending && (
            <div className="mx-4 mb-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 shrink-0">
              <p className="text-sm font-semibold text-amber-400 mb-1">
                📲 Callback to {callbackPending.name}
              </p>
              <p className="text-xs text-zinc-400 mb-3">
                The caller claims to be this person. How does the family member respond?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { void handleCallbackAnswer("1"); }}
                  className="flex-1 rounded bg-red-700 py-2 text-sm font-semibold text-white
                             hover:bg-red-600 transition-colors"
                >
                  🚫 Not me, I&apos;m safe (press 1)
                </button>
                <button
                  onClick={() => { void handleCallbackAnswer("2"); }}
                  className="flex-1 rounded bg-green-700 py-2 text-sm font-semibold text-white
                             hover:bg-green-600 transition-colors"
                >
                  ✅ It&apos;s me (press 2)
                </button>
                <button
                  onClick={() => { void handleCallbackAnswer("0"); }}
                  className="flex-1 rounded bg-zinc-700 py-2 text-sm font-semibold text-white
                             hover:bg-zinc-600 transition-colors"
                >
                  📵 No answer
                </button>
              </div>
            </div>
          )}

          {/* Input bar */}
          {phase === "active" && (
            <div className="flex items-center gap-2 px-4 py-3 bg-zinc-900 border-t border-zinc-800 shrink-0">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={sending || listening}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono
                           disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                placeholder="Type what the caller says and press Enter…"
                aria-label="Caller speech input"
              />
              <button
                onMouseDown={startListening}
                onMouseUp={stopListening}
                onTouchStart={startListening}
                onTouchEnd={stopListening}
                disabled={sending}
                aria-label={listening ? "Listening — release to send" : "Hold to talk"}
                className={`rounded px-3 py-2 text-sm font-semibold transition-colors select-none
                  ${listening
                    ? "bg-red-600 text-white ring-2 ring-red-400 animate-pulse"
                    : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {listening ? "🎙 Listening…" : "🎤 Talk"}
              </button>
              <button
                onClick={() => { void handleSend(); }}
                disabled={sending || !inputText.trim()}
                className="rounded bg-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200
                           hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {sending ? "…" : "Send"}
              </button>
            </div>
          )}

          {/* Debug panel */}
          {activeCall && <DebugPanel call={activeCall} />}
        </div>

        {/* ════════ Right: Mock Inbox ════════ */}
        <MockInbox messages={inbox} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatBubble
// ---------------------------------------------------------------------------

function ChatBubble({ msg }: { msg: ChatMessage }) {
  if (msg.speaker === "system") {
    return (
      <div className="flex justify-center">
        <span className="text-xs text-zinc-500 italic px-3 py-1 rounded-full bg-zinc-800/80">
          {msg.text}
        </span>
      </div>
    );
  }

  const isGhostline = msg.speaker === "ghostline";
  return (
    <div className={`flex ${isGhostline ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-sm rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isGhostline
            ? "bg-zinc-800 text-zinc-100 rounded-tl-sm"
            : "bg-blue-700 text-white rounded-tr-sm"
        }`}
      >
        <p className={`text-xs font-semibold mb-1 ${
          isGhostline ? "text-zinc-400" : "text-blue-200"
        }`}>
          {isGhostline ? "GHOSTLINE" : "CALLER"}
        </p>
        {msg.text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimeWastedClock — "Scammer time wasted: mm:ss", counts up while running
// ---------------------------------------------------------------------------

function TimeWastedClock({ view }: { view: TimeWastedView }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!view.running) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.running]);

  return (
    <span>
      Scammer time wasted:{" "}
      <span className="text-white">{formatMmSs(displaySeconds(view, nowMs))}</span>
      <span className="text-zinc-400">
        {" "}/ {formatMmSs(view.limitSeconds)}{view.running ? "" : " (ended)"}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// DebugPanel — state, risk (colour + text label per ui.md), flags
// ---------------------------------------------------------------------------

function DebugPanel({ call }: { call: ActiveCall }) {
  const level = call.riskLevel ?? "low";
  return (
    <div className={`mx-4 mb-3 rounded-lg border px-4 py-3 text-xs font-mono shrink-0 ${riskBorder(level)}`}>
      <p className="font-sans text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
        Debug
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span>
          State: <span className="text-white">{call.state}</span>
        </span>
        <span>
          Score: <span className={riskTextColour(level)}>{call.riskScore}</span>
        </span>
        {/* Both colour AND text label — accessibility requirement from ui.md */}
        <span>
          Risk:{" "}
          <span className={`font-bold ${riskTextColour(level)}`}>
            {level.toUpperCase()}
          </span>
        </span>
        {call.timeWasted && <TimeWastedClock view={call.timeWasted} />}
        {call.flags.length > 0 && (
          <span className="flex flex-wrap gap-1 items-center">
            Flags:
            {call.flags.map((f) => (
              <span key={f} className="bg-zinc-700/80 text-red-400 px-1.5 py-0.5 rounded">
                {f}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MockInbox — right panel
// ---------------------------------------------------------------------------

function MockInbox({ messages }: { messages: MockMessageRow[] }) {
  return (
    <aside
      className="w-80 shrink-0 flex flex-col bg-zinc-900"
      aria-label="Mock telephony inbox"
    >
      <div className="px-4 py-3 border-b border-zinc-800 shrink-0">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-zinc-400">
          Mock Inbox
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          SMS and callback calls sent by MockTelephony
        </p>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-zinc-800">
        {messages.length === 0 ? (
          <p className="text-xs text-zinc-600 italic px-4 py-8 text-center">
            No messages yet.
            <br />Start a call to see alerts here.
          </p>
        ) : (
          messages.map((msg) => <InboxRow key={msg.id} msg={msg} />)
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// InboxRow — one SMS or callback_call entry
// ---------------------------------------------------------------------------

interface CallbackBody {
  originalCallSid: string;
  claimedName: string;
}

function InboxRow({ msg }: { msg: MockMessageRow }) {
  const isSms      = msg.kind === "sms";
  const isCallback = msg.kind === "callback_call";

  let cbBody: CallbackBody | null = null;
  if (isCallback) {
    try {
      cbBody = JSON.parse(msg.body) as CallbackBody;
    } catch { /* malformed — ignore */ }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-semibold uppercase rounded px-1.5 py-0.5 ${
          isSms
            ? "bg-green-500/20 text-green-400"
            : "bg-blue-500/20 text-blue-400"
        }`}>
          {isSms ? "SMS" : "Callback call"}
        </span>
        <span className="text-xs text-zinc-500 font-mono">
          {new Date(msg.created_at).toLocaleTimeString("en-CA", { hour12: false })}
        </span>
      </div>

      {/* Show only last 4 digits — privacy rule from privacy.md */}
      <p className="text-xs text-zinc-500 font-mono mb-1.5">
        → ···{msg.to_number.slice(-4)}
      </p>

      {isSms && (
        <p className="text-xs text-zinc-200 leading-relaxed break-words">{msg.body}</p>
      )}

      {isCallback && cbBody && (
        <div className="text-xs space-y-0.5">
          <p className="text-zinc-300">
            Claimed: <span className="text-amber-400 font-medium">{cbBody.claimedName}</span>
          </p>
          <p className="text-zinc-500 font-mono">
            sid …{cbBody.originalCallSid.slice(-8)}
          </p>
        </div>
      )}

      {isCallback && !cbBody && (
        <p className="text-xs text-zinc-500 italic">{msg.body}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cassette tape icon — inline SVG, no external dep
// ---------------------------------------------------------------------------

function CassetteIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-zinc-400 shrink-0"
      aria-hidden="true"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="8"  cy="12" r="2" />
      <circle cx="16" cy="12" r="2" />
      <path d="M8 12h8" />
      <path d="M6 18l1.5-4h9L18 18" />
    </svg>
  );
}
