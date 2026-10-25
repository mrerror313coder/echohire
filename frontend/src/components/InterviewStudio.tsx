"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Mic, Sparkles, Square, Volume2 } from "lucide-react";
import {
  computeHeuristics,
  evaluateInterview,
  type EvaluationResponse,
  type RoleConfig,
} from "@/lib/api";
import type { InterviewMode } from "@/components/RoleSelector";

interface InterviewStudioProps {
  role: string;
  mode: InterviewMode;
  questionBank: RoleConfig[];
  focusToken: number;
  baseUrl: string;
  onEvaluated: (result: EvaluationResponse) => void;
  onInvalidate: () => void;
}

const FILLER_RADAR = ["um", "uh", "like", "basically", "actually", "you know"] as const;

const STAR_BEATS = [
  { key: "situation", letter: "S", label: "Situation" },
  { key: "task", letter: "T", label: "Task" },
  { key: "action", letter: "A", label: "Action" },
  { key: "result", letter: "R", label: "Result" },
] as const;

const WAVE_BARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: BrowserSpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface BrowserSpeechEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

function recognitionConstructor(): (new () => BrowserSpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function preferredMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return "";
}

function sampleCandidateResponse(role: string, question: string): string {
  return [
    `The situation was a busy week in my ${role} role.`,
    `The context for this answer is: ${question}`,
    "At the time the team needed one clear owner.",
    "My task was to reach a measurable goal, and that responsibility was mine.",
    "I built a small slice first, and I led the follow-through with the people affected.",
    "I would like, um, you know, to basically keep this concrete, and I actually did.",
    "The result improved the outcome by 18 percent, and I learned what I would repeat.",
  ].join(" ");
}

function estimatedSeconds(transcript: string): number {
  const words = transcript.match(/[A-Za-z0-9']+/g)?.length ?? 0;
  if (words === 0) return 0;
  return Math.max(15, Math.round((words / 140) * 60));
}

function wpmTone(wpm: number, words: number): "idle" | "amber" | "emerald" | "rose" {
  if (words === 0) return "idle";
  if (wpm < 100) return "amber";
  if (wpm >= 110 && wpm <= 160) return "emerald";
  if (wpm > 170) return "rose";
  return "idle";
}

const TONE_CLASS = {
  idle: "border-white/10 bg-white/5 text-slate-300",
  amber: "border-amber-400/40 bg-amber-400/15 text-amber-200",
  emerald: "border-emerald-400/40 bg-emerald-400/15 text-emerald-200",
  rose: "border-rose-400/40 bg-rose-400/15 text-rose-200",
} as const;

function HighlightedTranscript({ text }: { text: string }) {
  const pattern = /\b(you know|basically|actually|like|um|uh)\b/gi;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const index = match.index;
    if (index > cursor) pieces.push(text.slice(cursor, index));
    pieces.push(
      <mark key={`${index}-${match[0]}`} className="rounded bg-rose-400/25 px-0.5 text-rose-100">
        {match[0]}
      </mark>,
    );
    cursor = index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <>{pieces}</>;
}

export default function InterviewStudio({
  role,
  mode,
  questionBank,
  focusToken,
  baseUrl,
  onEvaluated,
  onInvalidate,
}: InterviewStudioProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sampleSeconds, setSampleSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [micMessage, setMicMessage] = useState("");
  const [canRecognize, setCanRecognize] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(false);

  const transcriptRef = useRef("");
  const shouldListenRef = useRef(false);
  const mountedRef = useRef(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const timerRef = useRef<number | null>(null);

  const roleConfig = questionBank.find((item) => item.role === role) ?? questionBank[0];
  const questions = roleConfig ? (mode === "technical" ? roleConfig.technical : roleConfig.behavioral) : [];
  const safeIndex = questions.length === 0 ? 0 : Math.min(questionIndex, questions.length - 1);
  const question = questions[safeIndex] ?? "";
  const seenFocus = useRef(focusToken);

  useEffect(() => {
    if (focusToken !== seenFocus.current && questions.length > 0) {
      setQuestionIndex(questions.length - 1);
      seenFocus.current = focusToken;
    } else if (questions.length > 0 && questionIndex >= questions.length) {
      setQuestionIndex(questions.length - 1);
    }
  }, [focusToken, questions.length, questionIndex]);
  const spoken = `${transcript} ${interim}`.trim();
  const durationForPace = elapsedSeconds > 0 ? elapsedSeconds : sampleSeconds;

  const heuristics = useMemo(
    () => computeHeuristics(spoken, durationForPace),
    [spoken, durationForPace],
  );
  const tone = wpmTone(heuristics.wpm, heuristics.word_count);

  useEffect(() => {
    setCanRecognize(recognitionConstructor() !== null);
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      shouldListenRef.current = false;
      recognitionRef.current?.stop();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  function rememberTranscript(next: string) {
    transcriptRef.current = next;
    setTranscript(next);
    onInvalidate();
  }

  function stopClock() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function releaseMic() {
    shouldListenRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopClock();
    setRecording(false);
    setInterim("");
  }

  function resetTake() {
    releaseMic();
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    rememberTranscript("");
    setElapsedSeconds(0);
    setSampleSeconds(0);
    setAudioBlob(null);
    onInvalidate();
    setMicMessage("");
  }

  function selectQuestion(nextIndex: number) {
    setQuestionIndex(nextIndex);
    resetTake();
  }

  function readAloud() {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setMicMessage("This browser cannot read the question aloud.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(question);
    utterance.rate = 1;
    utterance.onstart = () => {
      if (mountedRef.current) setSpeaking(true);
    };
    utterance.onend = () => {
      if (mountedRef.current) setSpeaking(false);
    };
    utterance.onerror = () => {
      if (mountedRef.current) setSpeaking(false);
    };
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  function loadSample() {
    releaseMic();
    const text = sampleCandidateResponse(role, question);
    rememberTranscript(text);
    setSampleSeconds(estimatedSeconds(text));
    setElapsedSeconds(0);
    setAudioBlob(null);
    onInvalidate();
    setMicMessage("Sample answer loaded. The pace is estimated at about 140 words per minute.");
  }

  function startRecognition(Ctor: new () => BrowserSpeechRecognition) {
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let finalChunk = "";
      let live = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const piece = event.results[index][0]?.transcript ?? "";
        if (event.results[index].isFinal) finalChunk += piece;
        else live += piece;
      }
      if (finalChunk.trim()) {
        const next = `${transcriptRef.current} ${finalChunk}`.replace(/\s+/g, " ").trim();
        rememberTranscript(next);
      }
      if (mountedRef.current) setInterim(live.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" && mountedRef.current) {
        setMicMessage("Speech recognition was blocked. Type the answer, or load a sample.");
      }
    };
    recognition.onend = () => {
      if (!shouldListenRef.current) return;
      try {
        recognition.start();
      } catch {
        // Chrome throws if start() overlaps the previous session.
      }
    };
    recognitionRef.current = recognition;
    shouldListenRef.current = true;
    try {
      recognition.start();
    } catch {
      setMicMessage("Live speech recognition did not start. The transcript box still works.");
    }
  }

  async function startRecording() {
    if (recording) return;
    setMicMessage("");
    onInvalidate();
    setSampleSeconds(0);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicMessage("This browser cannot open the microphone. Type the answer, or load a sample.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (mountedRef.current) setAudioBlob(blob.size > 0 ? blob : null);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      const startedAt = Date.now();
      setElapsedSeconds(0);
      stopClock();
      timerRef.current = window.setInterval(() => {
        if (!mountedRef.current) return;
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
      setRecording(true);
      const Ctor = recognitionConstructor();
      if (Ctor) startRecognition(Ctor);
      else setMicMessage("Live speech recognition is unavailable here. Type while you record, or load a sample.");
    } catch {
      releaseMic();
      setMicMessage("Microphone permission was blocked. Type the answer, or load a sample.");
    }
  }

  function stopRecording() {
    releaseMic();
  }

  async function evaluate() {
    setPending(true);
    try {
      const response = await evaluateInterview(baseUrl, {
        role,
        mode,
        question,
        transcript: spoken,
        duration_seconds: durationForPace,
        audio: audioBlob,
      });
      if (mountedRef.current) onEvaluated(response);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  const clockSeconds = recording || elapsedSeconds > 0 ? elapsedSeconds : sampleSeconds;
  const canEvaluate = question.length > 0 && (spoken.length > 0 || (audioBlob !== null && audioBlob.size > 0));

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/20 backdrop-blur sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-indigo-400/40 bg-indigo-500/15 px-3 py-1 text-xs font-medium uppercase tracking-wide text-indigo-200">
                {role}
              </span>
              <span className="text-sm text-slate-400">
                {questions.length === 0
                  ? "No questions yet"
                  : `Question ${safeIndex + 1} of ${questions.length}`}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-medium leading-snug text-slate-100 sm:text-2xl">
              {question || "Add a question for this role and mode."}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={readAloud}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 transition hover:border-emerald-400/40 hover:text-emerald-200"
            >
              <Volume2 className="h-4 w-4 text-emerald-400" aria-hidden />
              {speaking ? "Speaking" : "Read Aloud"}
            </button>
            <div
              className="min-w-[5.5rem] rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-center"
              aria-live="polite"
            >
              <p className="font-mono text-2xl tabular-nums text-slate-100">{formatClock(clockSeconds)}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                {recording ? "Recording" : sampleSeconds > 0 && elapsedSeconds === 0 ? "Sample pace" : "Timer"}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => selectQuestion(Math.max(0, safeIndex - 1))}
            disabled={questions.length === 0 || safeIndex === 0}
            className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-slate-300 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => selectQuestion(Math.min(questions.length - 1, safeIndex + 1))}
            disabled={questions.length === 0 || safeIndex >= questions.length - 1}
            className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-slate-300 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/20 backdrop-blur sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`echohire-wave flex h-12 w-28 items-end gap-1 ${recording ? "is-live" : ""}`}
              aria-hidden
            >
              {WAVE_BARS.map((bar) => (
                <span
                  key={bar}
                  className={`w-1.5 rounded-full bg-emerald-400 ${recording ? "h-10" : "h-2 opacity-40"}`}
                  style={{ animationDelay: `${bar * 0.07}s` }}
                />
              ))}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-100">
                {recording ? "Microphone is live" : audioBlob ? "Audio captured" : "Ready to record"}
              </p>
              <p className="text-xs text-slate-400">
                {canRecognize
                  ? "Speech recognition fills the transcript while the microphone records."
                  : "This browser has no live speech recognition. Type the answer instead."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {recording ? (
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-2 rounded-2xl bg-rose-500 px-4 py-3 text-sm font-medium text-slate-950"
              >
                <Square className="h-4 w-4" aria-hidden />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                className="inline-flex items-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-medium text-slate-950"
              >
                <Mic className="h-4 w-4" aria-hidden />
                Record
              </button>
            )}
            <button
              type="button"
              onClick={loadSample}
              className="inline-flex items-center gap-2 rounded-2xl border border-indigo-400/40 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              Load Sample Candidate Response
            </button>
          </div>
        </div>

        {micMessage ? <p className="mt-4 text-sm text-amber-200">{micMessage}</p> : null}

        <label htmlFor="transcript" className="mt-5 block text-sm text-slate-300">
          Live transcript
        </label>
        <textarea
          id="transcript"
          value={transcript}
          onChange={(event) => rememberTranscript(event.target.value)}
          rows={7}
          placeholder="Your answer appears here as you speak. You can also type it."
          className="mt-2 w-full resize-y rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm leading-6 text-slate-100 outline-none ring-emerald-400/40 placeholder:text-slate-500 focus:ring-2"
        />
        {interim ? <p className="mt-2 text-sm italic text-slate-400">{interim}</p> : null}
        {spoken ? (
          <p className="mt-3 text-sm leading-6 text-slate-300">
            <HighlightedTranscript text={spoken} />
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1.5 text-sm ${TONE_CLASS[tone]}`}>
              {heuristics.word_count === 0 ? "WPM —" : `${Math.round(heuristics.wpm)} WPM`}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-400">
              {heuristics.word_count} words
            </span>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Filler word radar">
            {FILLER_RADAR.map((word) => {
              const count = heuristics.filler_words_found[word] ?? 0;
              const active = count > 0;
              return (
                <span
                  key={word}
                  className={`rounded-full border px-3 py-1.5 text-sm ${
                    active
                      ? "border-rose-400/40 bg-rose-400/15 text-rose-100"
                      : "border-white/10 bg-white/5 text-slate-500"
                  }`}
                >
                  {word} · {count}
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2" aria-label="STAR structure">
            {STAR_BEATS.map((beat) => {
              const lit = (heuristics.star_keywords_detected[beat.key] ?? []).length > 0;
              return (
                <span
                  key={beat.key}
                  role="checkbox"
                  aria-checked={lit}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                    lit
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
                      : "border-white/10 bg-white/5 text-slate-500"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
                      lit ? "border-emerald-300 bg-emerald-400 text-slate-950" : "border-slate-600"
                    }`}
                    aria-hidden
                  >
                    {lit ? "✓" : ""}
                  </span>
                  {beat.letter} · {beat.label}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      <button
        type="button"
        onClick={evaluate}
        disabled={!canEvaluate || pending}
        className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-indigo-500 px-5 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        {pending ? "Scoring…" : "Evaluate answer"}
      </button>
    </div>
  );
}
