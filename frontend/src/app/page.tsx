"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { History, Mic, Radio } from "lucide-react";
import InterviewStudio from "@/components/InterviewStudio";
import QuestionEditor from "@/components/QuestionEditor";
import RoleSelector, { type InterviewMode } from "@/components/RoleSelector";
import ScorecardView from "@/components/ScorecardView";
import {
  mergeQuestionBank,
  QUESTION_BANK,
  checkBackendHealth,
  type AddedQuestion,
  type EvaluationResponse,
  type HealthResponse,
} from "@/lib/api";

const SESSIONS_KEY = "echohire.sessions";
const QUESTIONS_KEY = "echohire.questions";
const URL_KEY = "echohire.backendUrl";
const QUESTION_LIMIT = 40;
const DEFAULT_BACKEND = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const HOSTED_API = "https://echohire-api-mzrq.onrender.com";
const SESSION_LIMIT = 30;

interface SavedSession {
  id: string;
  savedAt: string;
  result: EvaluationResponse;
}

function isEvaluation(value: unknown): value is EvaluationResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EvaluationResponse>;
  return Boolean(record.evaluation && record.heuristics && typeof record.transcript === "string");
}

function isSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SavedSession>;
  return typeof record.id === "string" && typeof record.savedAt === "string" && isEvaluation(record.result);
}

function isAddedQuestion(value: unknown): value is AddedQuestion {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AddedQuestion>;
  return (
    typeof record.id === "string" &&
    typeof record.role === "string" &&
    (record.mode === "behavioral" || record.mode === "technical") &&
    typeof record.text === "string"
  );
}

function readAddedQuestions(): AddedQuestion[] {
  try {
    const raw = localStorage.getItem(QUESTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAddedQuestion).slice(0, QUESTION_LIMIT);
  } catch {
    return [];
  }
}

function writeAddedQuestions(questions: AddedQuestion[]) {
  try {
    localStorage.setItem(QUESTIONS_KEY, JSON.stringify(questions));
  } catch {
    // Private mode keeps the list for this tab.
  }
}

function readSessions(): SavedSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSession).slice(0, SESSION_LIMIT);
  } catch {
    return [];
  }
}

function preferIpv4Loopback(url: string): string {
  try {
    const parsed = new URL(url);
    // Windows tries the name localhost as IPv6 first. Leave every other host alone,
    // including a Render URL such as https://echohire-api.onrender.com.
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString().replace(/\/$/, "");
    }
    return url.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function readBackendUrl(): string {
  try {
    const stored = localStorage.getItem(URL_KEY)?.trim() || DEFAULT_BACKEND;
    return preferIpv4Loopback(stored);
  } catch {
    return DEFAULT_BACKEND;
  }
}

function writeSessions(sessions: SavedSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // Private mode and full storage keep the in-memory list for this tab.
  }
}

export default function Home() {
  const [role, setRole] = useState(QUESTION_BANK[0].role);
  const [mode, setMode] = useState<InterviewMode>("behavioral");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BACKEND);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_BACKEND);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [addedQuestions, setAddedQuestions] = useState<AddedQuestion[]>([]);
  const [focusToken, setFocusToken] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const urlPanelRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let storedUrl = readBackendUrl();
    if (window.location.hostname.endsWith(".onrender.com")) {
      // Same-origin proxy. The browser no longer calls the API host directly,
      // so a saved laptop address cannot leave the pill offline.
      storedUrl = `${window.location.origin}/echo-api`;
      try {
        localStorage.setItem(URL_KEY, storedUrl);
      } catch {
        // This visit still uses the proxy.
      }
    }
    setBaseUrl(storedUrl);
    setDraftUrl(storedUrl);
    setSessions(readSessions());
    setAddedQuestions(readAddedQuestions());
    setReady(true);
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === SESSIONS_KEY) setSessions(readSessions());
      if (event.key === QUESTIONS_KEY) setAddedQuestions(readAddedQuestions());
      if (event.key === URL_KEY) {
        const next = readBackendUrl();
        setBaseUrl(next);
        setDraftUrl(next);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    async function ping() {
      let next = await checkBackendHealth(baseUrl);
      if (!next && window.location.hostname.endsWith(".onrender.com")) {
        const proxy = `${window.location.origin}/echo-api`;
        if (baseUrl !== proxy) next = await checkBackendHealth(proxy);
        if (!next) next = await checkBackendHealth(HOSTED_API);
      }
      if (cancelled) return;
      setHealth(next);
      setHealthChecked(true);
    }
    setHealthChecked(false);
    void ping();
    const timer = window.setInterval(() => void ping(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [baseUrl, ready]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (urlOpen && urlPanelRef.current && !urlPanelRef.current.contains(target)) setUrlOpen(false);
      if (historyOpen && historyPanelRef.current && !historyPanelRef.current.contains(target)) setHistoryOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [urlOpen, historyOpen]);

  const saveEvaluation = useCallback((result: EvaluationResponse) => {
    const session: SavedSession = {
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
      result,
    };
    setSessions((current) => {
      const next = [session, ...current].slice(0, SESSION_LIMIT);
      writeSessions(next);
      return next;
    });
    setActiveId(session.id);
    setHistoryOpen(false);
  }, []);

  const clearScorecard = useCallback(() => setActiveId(null), []);

  const questionBank = useMemo(() => mergeQuestionBank(addedQuestions), [addedQuestions]);

  function addQuestion(question: AddedQuestion) {
    setAddedQuestions((current) => {
      const next = [question, ...current].slice(0, QUESTION_LIMIT);
      writeAddedQuestions(next);
      return next;
    });
    setRole(question.role);
    setMode(question.mode);
    setFocusToken((current) => current + 1);
    setActiveId(null);
  }

  function removeQuestion(id: string) {
    setAddedQuestions((current) => {
      const next = current.filter((item) => item.id !== id);
      writeAddedQuestions(next);
      const bank = mergeQuestionBank(next);
      setRole((selected) => (bank.some((item) => item.role === selected) ? selected : bank[0].role));
      return next;
    });
  }

  function changeRole(nextRole: string) {
    setRole(nextRole);
    setActiveId(null);
  }

  function changeMode(nextMode: InterviewMode) {
    setMode(nextMode);
    setActiveId(null);
  }

  function saveBackendUrl(event: FormEvent) {
    event.preventDefault();
    const next = preferIpv4Loopback(draftUrl.trim() || DEFAULT_BACKEND);
    setBaseUrl(next);
    setDraftUrl(next);
    try {
      localStorage.setItem(URL_KEY, next);
    } catch {
      // The URL still applies for this tab.
    }
    setUrlOpen(false);
  }

  const active = sessions.find((session) => session.id === activeId) ?? null;
  const groqUp = Boolean(health?.groq_online);
  const ollamaUp = Boolean(health?.ollama_online);
  const connected = groqUp || ollamaUp;
  const apiUp = health !== null;
  const statusLabel = !healthChecked
    ? "Checking"
    : groqUp
      ? "FastAPI + Groq"
      : ollamaUp
        ? "FastAPI + Ollama"
        : apiUp
          ? "API up · model offline"
          : "Backend offline";
  const statusClass = !healthChecked
    ? "border-white/10 bg-white/5 text-slate-300"
    : connected
      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-200"
      : apiUp
        ? "border-amber-400/40 bg-amber-400/15 text-amber-200"
        : "border-rose-400/40 bg-rose-400/15 text-rose-200";

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Mic className="h-5 w-5 text-emerald-400" aria-hidden />
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight text-slate-100">EchoHire</p>
              <p className="hidden text-xs text-indigo-300 sm:block">Local interview practice</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative" ref={urlPanelRef}>
              <button
                type="button"
                onClick={() => {
                  setUrlOpen((open) => !open);
                  setHistoryOpen(false);
                }}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs sm:text-sm ${statusClass}`}
                aria-expanded={urlOpen}
              >
                <Radio className={`h-3.5 w-3.5 ${connected ? "text-emerald-300" : ""}`} aria-hidden />
                {statusLabel}
              </button>
              {urlOpen ? (
                <form
                  onSubmit={saveBackendUrl}
                  className="absolute right-0 z-40 mt-2 w-72 rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-xl shadow-black/40"
                >
                  <label htmlFor="backend-url" className="text-xs uppercase tracking-wide text-slate-400">
                    Backend URL
                  </label>
                  <input
                    id="backend-url"
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-emerald-400/40 focus:ring-2"
                  />
                  <p className="mt-2 text-xs leading-5 text-slate-400">
                    FastAPI on this URL. Groq scores when a key is configured. Ollama scores when gemma2:2b is installed.
                  </p>
                  <button
                    type="submit"
                    className="mt-3 w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-950"
                  >
                    Save URL
                  </button>
                </form>
              ) : null}
            </div>

            <div className="relative" ref={historyPanelRef}>
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen((open) => !open);
                  setUrlOpen(false);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-100 sm:text-sm"
                aria-expanded={historyOpen}
              >
                <History className="h-3.5 w-3.5 text-indigo-300" aria-hidden />
                History
                <span className="rounded-full bg-indigo-500 px-2 py-0.5 text-[11px] font-medium text-white">
                  {sessions.length}
                </span>
              </button>
              {historyOpen ? (
                <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-white/10 bg-slate-900 p-3 shadow-xl shadow-black/40">
                  <p className="px-1 text-xs uppercase tracking-wide text-slate-400">Saved sessions</p>
                  {sessions.length === 0 ? (
                    <p className="px-1 py-4 text-sm text-slate-400">
                      No saved sessions yet. Finish an evaluation and it will land here.
                    </p>
                  ) : (
                    <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto">
                      {sessions.map((session) => {
                        const selected = session.id === activeId;
                        return (
                          <li key={session.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveId(session.id);
                                setHistoryOpen(false);
                              }}
                              className={`w-full rounded-xl px-3 py-2 text-left ${
                                selected ? "bg-emerald-400/15" : "hover:bg-white/5"
                              }`}
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="text-sm text-slate-100">{session.result.role}</span>
                                <span className="text-sm text-emerald-300">
                                  {session.result.evaluation.overall_score}/10
                                </span>
                              </span>
                              <span className="mt-1 block truncate text-xs text-slate-400">
                                {session.result.question}
                              </span>
                              <span className="mt-1 block text-[11px] text-slate-500">
                                {new Date(session.savedAt).toLocaleString()}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
        <RoleSelector
          roles={questionBank}
          selectedRole={role}
          mode={mode}
          onRoleChange={changeRole}
          onModeChange={changeMode}
        />
        <QuestionEditor
          role={role}
          mode={mode}
          roles={questionBank.map((item) => item.role)}
          added={addedQuestions}
          onAdd={addQuestion}
          onRemove={removeQuestion}
        />
        <InterviewStudio
          key={`${role}:${mode}`}
          role={role}
          mode={mode}
          questionBank={questionBank}
          focusToken={focusToken}
          baseUrl={baseUrl}
          onEvaluated={saveEvaluation}
          onInvalidate={clearScorecard}
        />
        {active ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-400">
              Saved {new Date(active.savedAt).toLocaleString()} · {active.result.role}
            </p>
            <ScorecardView result={active.result} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
