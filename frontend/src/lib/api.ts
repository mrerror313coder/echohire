/**
 * EchoHire client API.
 *
 * Types match the FastAPI models in `backend/main.py`. When that server cannot
 * be reached (a deployed frontend with no localhost:8000), scoring falls back
 * to the same delivery heuristics the backend uses, and the response is flagged
 * with `mode: "browser-fallback"`.
 */

export interface RoleConfig {
  role: string;
  behavioral: string[];
  technical: string[];
}

export interface AddedQuestion {
  id: string;
  role: string;
  mode: "behavioral" | "technical";
  text: string;
}

export interface EvaluationRequest {
  role: string;
  mode: string;
  question: string;
  transcript: string;
  duration_seconds: number;
  audio?: Blob | null;
}

export interface HealthResponse {
  status: string;
  ollama_online: boolean;
  groq_online?: boolean;
  model: string;
  stt: string;
}

export interface Heuristics {
  word_count: number;
  wpm: number;
  filler_words_found: Record<string, number>;
  star_keywords_detected: Record<string, string[]>;
}

export interface Evaluation {
  overall_score: number;
  clarity_score: number;
  confidence_score: number;
  star_alignment_score: number;
  strengths: string[];
  lazy_fixes: string[];
  rewritten_ideal_answer: string;
}

export interface EvaluationResponse {
  role: string;
  mode: string;
  question: string;
  transcript: string;
  transcript_source: string;
  duration_seconds: number;
  heuristics: Heuristics;
  evaluation: Evaluation;
  evaluation_source: string;
}

const LOCAL_HEALTH_TIMEOUT_MS = 4000;
const REMOTE_HEALTH_TIMEOUT_MS = 45000;
/** Local Gemma is allowed 90s. A CPU instance on Render is allowed 180s. */
const LOCAL_EVALUATE_TIMEOUT_MS = 120_000;
const REMOTE_EVALUATE_TIMEOUT_MS = 240_000;

const FILLER_PHRASES = ["you know"] as const;
const FILLER_WORDS = ["um", "uh", "like", "basically", "actually", "literally"] as const;

const STAR_INDICATORS: Record<string, readonly string[]> = {
  situation: [
    "situation",
    "context",
    "background",
    "scenario",
    "at the time",
    "back when",
    "when i",
    "while i",
  ],
  task: [
    "task",
    "responsibility",
    "responsible",
    "objective",
    "goal",
    "i needed",
    "i was asked",
    "my role",
    "assigned",
    "challenge",
  ],
  action: [
    "action",
    "i implemented",
    "i decided",
    "i built",
    "i led",
    "i created",
    "i wrote",
    "i designed",
    "i coordinated",
    "i took",
    "i started",
    "i fixed",
    "i shipped",
  ],
  result: [
    "result",
    "outcome",
    "impact",
    "improved",
    "increased",
    "reduced",
    "decreased",
    "achieved",
    "as a result",
    "learned",
    "saved",
    "percent",
    "%",
  ],
};

export const QUESTION_BANK: RoleConfig[] = [
  {
    role: "Software Engineer",
    behavioral: [
      "Tell me about a time a change you shipped caused an incident. What was the situation, what did you own, what did you do, and how did it end?",
      "Describe a disagreement with a teammate about a design. How did you work through it?",
      "Tell me about delivering when the deadline was close and the requirements were still incomplete.",
    ],
    technical: [
      "How does a request travel from the browser to a JSON response in an API you have built?",
      "When do you add a database index, and what does that index cost on writes?",
      "How do you find an N+1 query and remove it?",
    ],
  },
  {
    role: "Data Scientist",
    behavioral: [
      "Tell me about a time your analysis changed a decision that was already leaning the other way.",
      "Describe a time a stakeholder wanted a number you did not trust. What did you do?",
      "Tell me about explaining a metric or a model to someone who does not work with data.",
    ],
    technical: [
      "How do you tell overfitting apart from a real improvement when a model looks strong in training?",
      "How would you set up an A/B test, including the metric and what would make the sample too small?",
      "What is data leakage, and how do you keep it out of a feature pipeline?",
    ],
  },
  {
    role: "AI Engineer",
    behavioral: [
      "Tell me about a time a model looked good in a notebook and failed for real users.",
      "Describe a time you traded answer quality for latency or cost. What did you give up, and what improved?",
      "Tell me about a time you refused to ship a model you could not evaluate.",
    ],
    technical: [
      "How do you get a small open model to return JSON that another program can parse?",
      "When would you use retrieval instead of fine-tuning, and what does each approach fail at?",
      "How would you judge a speech-to-text or interview scorer without treating one number as the whole story?",
    ],
  },
  {
    role: "Product Manager",
    behavioral: [
      "Tell me about a time you cut scope so a team could ship.",
      "Describe a time customer evidence contradicted the roadmap. What changed?",
      "Tell me about aligning engineering and design on a problem they did not agree was worth solving.",
    ],
    technical: [
      "How do you write the problem and the success metric before you propose a solution?",
      "How do you order a backlog when every request arrives marked urgent?",
      "How would you instrument a new feature so you know whether it worked after launch?",
    ],
  },
];

export function mergeQuestionBank(added: AddedQuestion[]): RoleConfig[] {
  const roles: RoleConfig[] = QUESTION_BANK.map((item) => ({
    role: item.role,
    behavioral: [...item.behavioral],
    technical: [...item.technical],
  }));
  for (const item of added) {
    const text = item.text.trim();
    const roleName = item.role.trim();
    if (!text || !roleName) continue;
    let role = roles.find((entry) => entry.role.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      role = { role: roleName, behavioral: [], technical: [] };
      roles.push(role);
    }
    const list = item.mode === "technical" ? role.technical : role.behavioral;
    if (!list.some((existing) => existing.toLowerCase() === text.toLowerCase())) {
      list.push(text);
    }
  }
  return roles;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clampScore(value: number, fallback = 5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(10, Math.round(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseRegExp(phrase: string): RegExp {
  const body = phrase.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`\\b${body}\\b`, "gi");
}

function phraseFound(text: string, phrase: string): boolean {
  if (phrase === "%") return text.includes("%");
  return phraseRegExp(phrase).test(text);
}

function countMatches(text: string, phrase: string): number {
  const matches = text.match(phraseRegExp(phrase));
  return matches ? matches.length : 0;
}

function countFillerWords(transcript: string): Record<string, number> {
  const lowered = transcript.toLowerCase();
  const counts: Record<string, number> = {};
  for (const phrase of FILLER_PHRASES) counts[phrase] = countMatches(lowered, phrase);
  for (const word of FILLER_WORDS) counts[word] = countMatches(lowered, word);
  return counts;
}

function detectStarKeywords(transcript: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [beat, phrases] of Object.entries(STAR_INDICATORS)) {
    found[beat] = phrases.filter((phrase) => phraseFound(transcript, phrase));
  }
  return found;
}

function emptyHeuristics(): Heuristics {
  return {
    word_count: 0,
    wpm: 0,
    filler_words_found: Object.fromEntries(
      [...FILLER_PHRASES, ...FILLER_WORDS].map((phrase) => [phrase, 0]),
    ),
    star_keywords_detected: Object.fromEntries(
      Object.keys(STAR_INDICATORS).map((beat) => [beat, []]),
    ),
  };
}

export function computeHeuristics(transcript: string, durationSeconds: number): Heuristics {
  const words = transcript.match(/[A-Za-z0-9']+/g) ?? [];
  const minutes = durationSeconds > 0 ? durationSeconds / 60 : 0;
  const wpm = minutes > 0 ? Math.round((words.length / minutes) * 10) / 10 : 0;
  return {
    word_count: words.length,
    wpm,
    filler_words_found: countFillerWords(transcript),
    star_keywords_detected: detectStarKeywords(transcript),
  };
}

function padUnique(lines: string[], backups: string[]): string[] {
  const chosen: string[] = [];
  for (const line of [...lines, ...backups]) {
    const text = line.trim();
    if (text && !chosen.includes(text)) chosen.push(text);
    if (chosen.length === 3) break;
  }
  while (chosen.length < 3) {
    chosen.push(backups[chosen.length % backups.length]);
  }
  return chosen.slice(0, 3);
}

function topFiller(counts: Record<string, number>): string {
  let top = "";
  let best = -1;
  for (const [word, count] of Object.entries(counts)) {
    if (count > best) {
      best = count;
      top = word;
    }
  }
  return top;
}

function heuristicEvaluation(
  role: string,
  question: string,
  transcript: string,
  heuristics: Heuristics,
): Evaluation {
  const fillerTotal = Object.values(heuristics.filler_words_found).reduce((sum, count) => sum + count, 0);
  const words = heuristics.word_count;
  const wpm = heuristics.wpm;
  const fillerRate = words ? fillerTotal / words : 1;
  const present = Object.entries(heuristics.star_keywords_detected)
    .filter(([, hits]) => hits.length > 0)
    .map(([beat]) => beat);

  let clarity = 8;
  if (words < 25) clarity -= 3;
  else if (words < 50) clarity -= 1;
  if (fillerRate > 0.08) clarity -= 3;
  else if (fillerRate > 0.04) clarity -= 2;
  else if (fillerRate > 0.015) clarity -= 1;
  if (wpm && (wpm < 90 || wpm > 190)) clarity -= 2;
  else if (wpm && (wpm < 110 || wpm > 170)) clarity -= 1;
  if (!wpm) clarity -= 1;

  let confidence = 7;
  if (wpm >= 110 && wpm <= 160) confidence += 1;
  if (wpm && (wpm < 80 || wpm > 200)) confidence -= 2;
  if (fillerRate > 0.05) confidence -= 2;
  else if (fillerRate > 0.02) confidence -= 1;
  if (words >= 80) confidence += 1;
  if (words < 20) confidence -= 2;

  const starScore = [2, 4, 6, 8, 10][Math.min(present.length, 4)];
  const roleName = role.trim() || "this role";
  const roleLabel = `${/^[aeiou]/i.test(roleName) ? "an" : "a"} ${roleName}`;
  const questionLabel = question.trim().replace(/\?+$/, "") || "the question that was asked";

  const strengthLines: string[] = [];
  if (present.length >= 3) {
    strengthLines.push(`The answer already touches ${present.length} STAR beats: ${present.join(", ")}.`);
  } else if (present.length > 0) {
    strengthLines.push(`You signaled ${present.join(", ")}, so the story has a place to start.`);
  } else {
    strengthLines.push("You answered in your own words, which is enough to reshape into STAR.");
  }
  if (wpm >= 110 && wpm <= 170) {
    strengthLines.push(`Pace is in a listenable range at about ${Math.round(wpm)} words per minute.`);
  } else if (words >= 60) {
    strengthLines.push(`There is enough tape to coach (${words} words), rather than a one-line reply.`);
  } else {
    strengthLines.push("The answer is short, so a second pass can add the missing beat without a ramble.");
  }
  if (fillerTotal === 0 && words >= 15) {
    strengthLines.push("None of the tracked filler words showed up.");
  } else if (fillerRate < 0.02) {
    strengthLines.push("Filler words are sparse enough that the point still comes through.");
  } else {
    strengthLines.push("The story is still recoverable; the fillers are a surface edit.");
  }

  const fixLines: string[] = [];
  if (!present.includes("situation")) {
    fixLines.push("Open with one sentence of situation: when, where, and what was at stake.");
  }
  if (!present.includes("task")) {
    fixLines.push("Name the task that was yours before you describe what you did.");
  }
  if (!present.includes("action")) {
    fixLines.push("Add two concrete actions you personally took, with verbs a listener can picture.");
  }
  if (!present.includes("result")) {
    fixLines.push("Close with a result: a number, a changed decision, or what you would repeat.");
  }
  if (fillerTotal) {
    const top = topFiller(heuristics.filler_words_found);
    fixLines.push(
      `Swap each "${top}" for a short pause; it showed up ${heuristics.filler_words_found[top]} time(s).`,
    );
  }
  if (wpm > 180) {
    fixLines.push(`Slow down from about ${Math.round(wpm)} WPM toward 130 so the result can land.`);
  } else if (wpm > 0 && wpm < 90) {
    fixLines.push(`Pick up the pace from about ${Math.round(wpm)} WPM toward 130 so the answer feels decisive.`);
  }
  if (words < 40) {
    fixLines.push("Add about 30 to 50 words so both the situation and the result are on the tape.");
  }

  const ideal = transcript.trim()
    ? `Situation: As ${roleLabel}, I hit a moment that matches this question: ${questionLabel}. Task: It was mine to handle, with a clear outcome expected of me. Action: I named the constraint, took the next concrete step myself, and told the people affected what I was doing. Result: The change was visible, I could point to what moved, and I kept the part that worked.`
    : `Situation: As ${roleLabel}, I would set the scene for "${questionLabel}" in one sentence. Task: I would state the outcome I personally owned. Action: I would name two steps I took, in order. Result: I would end on a number or a decision that changed.`;

  return {
    overall_score: clampScore(Math.round(0.35 * clarity + 0.25 * confidence + 0.4 * starScore)),
    clarity_score: clampScore(clarity),
    confidence_score: clampScore(confidence),
    star_alignment_score: clampScore(starScore),
    strengths: padUnique(strengthLines, [
      "The answer is specific enough to coach.",
      "You stayed on the question that was asked.",
      "A local replay can tighten this without another live interview.",
    ]),
    lazy_fixes: padUnique(fixLines, [
      "Record it once more at a calm pace and stop after the result sentence.",
      "Cut any sentence that does not serve Situation, Task, Action, or Result.",
      "Lead with the result if the listener will only remember one line.",
    ]),
    rewritten_ideal_answer: ideal,
  };
}

function safeHeuristics(transcript: string, durationSeconds: number): Heuristics {
  try {
    return computeHeuristics(transcript, durationSeconds);
  } catch {
    return emptyHeuristics();
  }
}

function browserFallback(payload: EvaluationRequest): EvaluationResponse {
  const transcript = (payload.transcript ?? "").trim();
  const duration = Number.isFinite(payload.duration_seconds) && payload.duration_seconds > 0
    ? payload.duration_seconds
    : 0;
  const heuristics = safeHeuristics(transcript, duration);
  let evaluation: Evaluation;
  try {
    evaluation = heuristicEvaluation(payload.role ?? "", payload.question ?? "", transcript, heuristics);
  } catch {
    evaluation = {
      overall_score: 5,
      clarity_score: 5,
      confidence_score: 5,
      star_alignment_score: 5,
      strengths: [
        "The attempt is on record and can be coached.",
        "You showed up for the question.",
        "A second take can add STAR structure.",
      ],
      lazy_fixes: [
        "State the situation in the first sentence.",
        "Name one action that was yours alone.",
        "End with the result in a single line.",
      ],
      rewritten_ideal_answer:
        "Situation: Set the scene in one sentence. Task: Say what you owned. Action: Name the steps you took. Result: Close with what changed.",
    };
  }

  return {
    role: payload.role ?? "",
    mode: "browser-fallback",
    question: payload.question ?? "",
    transcript,
    transcript_source: transcript ? "client" : "unavailable",
    duration_seconds: duration,
    heuristics,
    evaluation,
    evaluation_source: "browser-fallback",
  };
}

function isEvaluationResponse(value: unknown): value is EvaluationResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EvaluationResponse>;
  return Boolean(record.evaluation && record.heuristics && typeof record.transcript === "string");
}

function audioFilename(audio: Blob): string {
  if (typeof File !== "undefined" && audio instanceof File && audio.name.trim()) {
    return audio.name;
  }
  const type = audio.type.toLowerCase();
  if (type.includes("wav")) return "answer.wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "answer.mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "answer.m4a";
  if (type.includes("ogg")) return "answer.ogg";
  return "answer.webm";
}

function toFormData(payload: EvaluationRequest): FormData {
  const form = new FormData();
  form.append("role", payload.role ?? "");
  form.append("mode", payload.mode ?? "");
  form.append("question", payload.question ?? "");
  form.append("transcript", payload.transcript ?? "");
  form.append("duration_seconds", String(payload.duration_seconds ?? 0));
  if (payload.audio && payload.audio.size > 0) {
    form.append("audio", payload.audio, audioFilename(payload.audio));
  }
  return form;
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function healthTimeoutMs(baseUrl: string): number {
  return isLoopback(baseUrl) ? LOCAL_HEALTH_TIMEOUT_MS : REMOTE_HEALTH_TIMEOUT_MS;
}

function evaluateTimeoutMs(baseUrl: string): number {
  return isLoopback(baseUrl) ? LOCAL_EVALUATE_TIMEOUT_MS : REMOTE_EVALUATE_TIMEOUT_MS;
}

export async function checkBackendHealth(baseUrl: string): Promise<HealthResponse | null> {
  try {
    const response = await fetchWithTimeout(endpoint(baseUrl, "/health"), healthTimeoutMs(baseUrl));
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<HealthResponse>;
    if (typeof body.ollama_online !== "boolean" || typeof body.status !== "string") return null;
    return {
      status: body.status,
      ollama_online: body.ollama_online,
      groq_online: Boolean(body.groq_online),
      model: body.model ?? "gemma2:2b",
      stt: body.stt ?? "faster-whisper-base",
    };
  } catch {
    return null;
  }
}

export async function evaluateInterview(
  baseUrl: string,
  payload: EvaluationRequest,
): Promise<EvaluationResponse> {
  try {
    const response = await fetchWithTimeout(endpoint(baseUrl, "/evaluate"), evaluateTimeoutMs(baseUrl), {
      method: "POST",
      body: toFormData(payload),
    });
    if (!response.ok) return browserFallback(payload);
    const body: unknown = await response.json();
    if (!isEvaluationResponse(body)) return browserFallback(payload);
    return body;
  } catch {
    return browserFallback(payload);
  }
}
