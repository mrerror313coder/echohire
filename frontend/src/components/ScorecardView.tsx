"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, Download, Zap } from "lucide-react";
import type { EvaluationResponse } from "@/lib/api";

const GAUGES = [
  { key: "overall_score", label: "Overall Score" },
  { key: "clarity_score", label: "Clarity" },
  { key: "confidence_score", label: "Confidence" },
  { key: "star_alignment_score", label: "STAR Alignment" },
] as const;

const FILLER_ORDER = ["um", "uh", "like", "basically", "actually", "you know", "literally"];

interface ScorecardViewProps {
  result: EvaluationResponse;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function ringColor(score: number): string {
  if (score >= 8) return "#34d399";
  if (score >= 5) return "#818cf8";
  return "#fb7185";
}

function RadialGauge({ label, score }: { label: string; score: number }) {
  const clamped = Math.max(0, Math.min(10, score));
  const percent = (clamped / 10) * 100;
  const color = ringColor(clamped);
  return (
    <figure className="flex flex-col items-center gap-2 rounded-3xl border border-white/10 bg-slate-950/60 p-4">
      <svg viewBox="0 0 120 120" className="h-28 w-28" role="img" aria-label={`${label}: ${clamped} out of 10`}>
        <title>{`${label}: ${clamped} out of 10`}</title>
        <circle cx="60" cy="60" r="46" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r="46"
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap={percent >= 99.9 ? "butt" : "round"}
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={100 - percent}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="56" textAnchor="middle" fill="#f1f5f9" fontSize="22" fontWeight="600">
          {clamped}
        </text>
        <text x="60" y="74" textAnchor="middle" fill="#94a3b8" fontSize="10">
          out of 10
        </text>
      </svg>
      <figcaption className="text-center text-sm text-slate-300">{label}</figcaption>
    </figure>
  );
}

function AnnotatedTranscript({ text }: { text: string }) {
  if (!text.trim()) {
    return <p className="text-sm text-slate-500">No transcript was captured for this take.</p>;
  }
  const pattern = /\b(you know|basically|actually|literally|like|um|uh)\b/gi;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const index = match.index;
    if (index > cursor) pieces.push(text.slice(cursor, index));
    pieces.push(
      <mark
        key={`${index}-${match[0]}`}
        className="mx-0.5 inline-block rounded-full bg-rose-500 px-2 py-0.5 text-xs font-medium text-white"
      >
        {match[0]}
      </mark>,
    );
    cursor = index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <p className="text-sm leading-7 text-slate-200">{pieces}</p>;
}

function fillerLines(result: EvaluationResponse): string[] {
  const counts = result.heuristics.filler_words_found;
  const words = Math.max(result.heuristics.word_count, 1);
  const keys = [...FILLER_ORDER.filter((word) => word in counts), ...Object.keys(counts).filter((word) => !FILLER_ORDER.includes(word))];
  return keys.map((word) => {
    const count = counts[word] ?? 0;
    const share = result.heuristics.word_count === 0 ? 0 : Math.round((count / words) * 1000) / 10;
    return `${word}: ${count} (${share}% of words)`;
  });
}

export function scorecardMarkdown(result: EvaluationResponse): string {
  const evaluation = result.evaluation;
  const lines = [
    "# EchoHire scorecard",
    "",
    `- **Role:** ${result.role}`,
    `- **Mode:** ${result.mode}`,
    `- **Question:** ${result.question}`,
    `- **Scorer:** ${result.evaluation_source}`,
    "",
    "## Scores",
    "",
    `- Overall: ${evaluation.overall_score}/10`,
    `- Clarity: ${evaluation.clarity_score}/10`,
    `- Confidence: ${evaluation.confidence_score}/10`,
    `- STAR alignment: ${evaluation.star_alignment_score}/10`,
    "",
    "## Delivery telemetry",
    "",
    `- Words: ${result.heuristics.word_count}`,
    `- WPM: ${result.heuristics.wpm}`,
    `- Duration seconds: ${result.duration_seconds}`,
    ...fillerLines(result).map((line) => `- ${line}`),
    "",
    "## Transcript",
    "",
    result.transcript.trim() || "_empty_",
    "",
    "## What worked",
    "",
    ...evaluation.strengths.map((item) => `- ${item}`),
    "",
    "## Lazy fixes",
    "",
    ...evaluation.lazy_fixes.map((item) => `- ${item}`),
    "",
    "## AI rewritten STAR answer",
    "",
    evaluation.rewritten_ideal_answer,
    "",
  ];
  return lines.join("\n");
}

function telemetryPayload(result: EvaluationResponse) {
  return {
    role: result.role,
    mode: result.mode,
    question: result.question,
    transcript: result.transcript,
    transcript_source: result.transcript_source,
    duration_seconds: result.duration_seconds,
    evaluation_source: result.evaluation_source,
    heuristics: result.heuristics,
    evaluation: result.evaluation,
  };
}

export default function ScorecardView({ result }: ScorecardViewProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const evaluation = result.evaluation;
  const fillerCounts = result.heuristics.filler_words_found;
  const fillerKeys = [
    ...FILLER_ORDER.filter((word) => word in fillerCounts),
    ...Object.keys(fillerCounts).filter((word) => !FILLER_ORDER.includes(word)),
  ];
  const source = result.evaluation_source;
  const groqScored = source.startsWith("groq:");
  const gemmaScored = source === "gemma2:2b";
  const scoreNote = groqScored
    ? `Scored by Groq (${source.slice(5)}). The transcript text was sent to Groq. The recording stayed in this browser.`
    : gemmaScored
      ? "Scored by Gemma 2B on this machine."
      : result.mode === "browser-fallback"
        ? "The API was unreachable, so this scorecard was filled in the browser."
        : "The model was unreachable, so this scorecard uses the delivery heuristics.";

  async function copyReport() {
    const markdown = scorecardMarkdown(result);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = markdown;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(area);
        setCopyState(copied ? "copied" : "failed");
      } catch {
        setCopyState("failed");
      }
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  }

  function downloadTelemetry() {
    const blob = new Blob([JSON.stringify(telemetryPayload(result), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "echohire-telemetry.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="flex flex-col gap-5" aria-label="Scorecard">
      <div>
        <h2 className="text-lg font-medium text-slate-100">Scorecard</h2>
        <p className="text-sm text-indigo-200">
          {scoreNote}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {GAUGES.map((gauge) => (
          <RadialGauge key={gauge.key} label={gauge.label} score={evaluation[gauge.key]} />
        ))}
      </div>

      <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
        <h3 className="text-sm font-medium uppercase tracking-wide text-slate-300">Delivery Telemetry</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">WPM</p>
            <p className="font-mono text-xl text-emerald-300">{result.heuristics.wpm}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Duration</p>
            <p className="font-mono text-xl text-slate-100">
              {formatClock(result.duration_seconds)}
              <span className="ml-2 text-sm text-slate-400">{result.duration_seconds}s</span>
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Words</p>
            <p className="font-mono text-xl text-slate-100">{result.heuristics.word_count}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Filler word frequency">
          {fillerKeys.map((word) => {
            const count = fillerCounts[word] ?? 0;
            return (
              <span
                key={word}
                className={`rounded-full px-3 py-1 text-sm ${
                  count > 0 ? "bg-rose-500 text-white" : "border border-white/10 bg-white/5 text-slate-500"
                }`}
              >
                {word} · {count}
              </span>
            );
          })}
        </div>
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/50 p-4">
          <AnnotatedTranscript text={result.transcript} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-3xl border border-emerald-400/30 bg-emerald-400/5 p-5">
          <h3 className="text-base font-medium text-emerald-100">What Worked (Strengths)</h3>
          <p className="mt-1 text-xs uppercase tracking-wide text-emerald-300/80">Gemma 2B</p>
          <ul className="mt-4 space-y-3">
            {evaluation.strengths.map((item) => (
              <li key={item} className="flex gap-2 text-sm leading-6 text-slate-200">
                <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </article>
        <article className="rounded-3xl border border-amber-400/30 bg-amber-400/5 p-5">
          <h3 className="text-base font-medium text-amber-100">
            3 Lazy Fixes (High-Impact, Low-Effort Improvements)
          </h3>
          <p className="mt-1 text-xs uppercase tracking-wide text-amber-200/80">Gemma 2B</p>
          <ul className="mt-4 space-y-3">
            {evaluation.lazy_fixes.map((item) => (
              <li key={item} className="flex gap-2 text-sm leading-6 text-slate-200">
                <Zap className="mt-1 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </article>
      </div>

      <article className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
        <h3 className="text-base font-medium text-slate-100">AI Rewritten STAR Answer</h3>
        <p className="mt-1 text-sm text-slate-400">The same response, restructured into a 10/10 STAR answer.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Your response</p>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              {result.transcript.trim() || "No transcript was captured."}
            </p>
          </div>
          <div className="rounded-2xl border border-indigo-400/30 bg-indigo-500/10 p-4">
            <p className="text-xs uppercase tracking-wide text-indigo-200">10/10 rewrite</p>
            <p className="mt-2 text-sm leading-6 text-slate-100">{evaluation.rewritten_ideal_answer}</p>
          </div>
        </div>
      </article>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={copyReport}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100"
        >
          {copyState === "copied" ? <Check className="h-4 w-4 text-emerald-400" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy Markdown Report"}
        </button>
        <button
          type="button"
          onClick={downloadTelemetry}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100"
        >
          <Download className="h-4 w-4" aria-hidden />
          Download JSON Telemetry
        </button>
      </div>
      <p className="sr-only" aria-live="polite">
        {copyState === "copied" ? "Markdown report copied." : copyState === "failed" ? "Could not copy the report." : ""}
      </p>
    </section>
  );
}
