"""EchoHire API: local speech-to-text plus open-weight interview scoring.

Speech stays on this machine (`faster-whisper`, base, int8, CPU). Scoring goes to
a local Ollama server running `gemma2:2b`. If Ollama is down, times out, or
returns JSON that does not match the schema, delivery heuristics still produce
a complete score payload.
"""

import asyncio
import html
import json
import logging
import os
import re
import tempfile
import threading
import time
from typing import Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("echohire")


def _load_env_file(path: str) -> None:
    if not os.path.isfile(path):
        return
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _load_local_env() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    _load_env_file(os.path.join(here, ".env"))
    _load_env_file(os.path.join(os.path.dirname(here), ".env"))


_load_local_env()

OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma2:2b")
OLLAMA_HEALTH_TIMEOUT = 1.0
OLLAMA_GENERATE_TIMEOUT = float(os.environ.get("OLLAMA_GENERATE_TIMEOUT", "90"))
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "4096"))
GROQ_BASE = os.environ.get("GROQ_BASE", "https://api.groq.com/openai/v1").rstrip("/")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
GROQ_TIMEOUT = float(os.environ.get("GROQ_TIMEOUT", "45"))
STT_LABEL = "faster-whisper-base"
_groq_lock = threading.Lock()
_groq_checked_at = 0.0
_groq_ok = False

FILLER_PHRASES: Tuple[str, ...] = ("you know",)
FILLER_WORDS: Tuple[str, ...] = (
    "um",
    "uh",
    "like",
    "basically",
    "actually",
    "literally",
)

# Indicator phrases for the four STAR beats. Single letters such as "I" are
# omitted on purpose so a normal sentence does not count as Action.
STAR_INDICATORS: Dict[str, Tuple[str, ...]] = {
    "situation": (
        "situation",
        "context",
        "background",
        "scenario",
        "at the time",
        "back when",
        "when i",
        "while i",
    ),
    "task": (
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
    ),
    "action": (
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
    ),
    "result": (
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
    ),
}

_whisper_model = None
_whisper_lock = threading.Lock()

app = FastAPI(title="EchoHire", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: str
    ollama_online: bool
    groq_online: bool
    model: str
    stt: str


class Heuristics(BaseModel):
    word_count: int
    wpm: float
    filler_words_found: Dict[str, int]
    star_keywords_detected: Dict[str, List[str]]


class Evaluation(BaseModel):
    overall_score: int = Field(ge=1, le=10)
    clarity_score: int = Field(ge=1, le=10)
    confidence_score: int = Field(ge=1, le=10)
    star_alignment_score: int = Field(ge=1, le=10)
    strengths: List[str]
    lazy_fixes: List[str]
    rewritten_ideal_answer: str


class EvaluateResponse(BaseModel):
    role: str
    mode: str
    question: str
    transcript: str
    transcript_source: str
    duration_seconds: float
    heuristics: Heuristics
    evaluation: Evaluation
    evaluation_source: str


def _clamp_score(value: object, default: int = 5) -> int:
    try:
        number = int(round(float(value)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return max(1, min(10, number))


def _exactly_three(items: object, fillers: List[str]) -> List[str]:
    cleaned: List[str] = []
    if isinstance(items, list):
        for item in items:
            text = str(item).strip()
            if text:
                cleaned.append(text)
    index = 0
    while len(cleaned) < 3:
        cleaned.append(fillers[index % len(fillers)])
        index += 1
    return cleaned[:3]


def _phrase_pattern(phrase: str) -> str:
    parts = [re.escape(part) for part in phrase.split()]
    return r"\b" + r"\s+".join(parts) + r"\b"


def _phrase_found(text: str, phrase: str) -> bool:
    if phrase == "%":
        return "%" in text
    return re.search(_phrase_pattern(phrase), text, flags=re.IGNORECASE) is not None


def count_filler_words(transcript: str) -> Dict[str, int]:
    lowered = transcript.lower()
    counts: Dict[str, int] = {}
    for phrase in FILLER_PHRASES:
        counts[phrase] = len(re.findall(_phrase_pattern(phrase), lowered))
    for word in FILLER_WORDS:
        counts[word] = len(re.findall(_phrase_pattern(word), lowered))
    return counts


def detect_star_keywords(transcript: str) -> Dict[str, List[str]]:
    found: Dict[str, List[str]] = {}
    for beat, phrases in STAR_INDICATORS.items():
        found[beat] = [phrase for phrase in phrases if _phrase_found(transcript, phrase)]
    return found


def compute_heuristics(transcript: str, duration_seconds: float) -> Heuristics:
    words = re.findall(r"[A-Za-z0-9']+", transcript)
    word_count = len(words)
    minutes = duration_seconds / 60.0 if duration_seconds and duration_seconds > 0 else 0.0
    wpm = round(word_count / minutes, 1) if minutes > 0 else 0.0
    return Heuristics(
        word_count=word_count,
        wpm=wpm,
        filler_words_found=count_filler_words(transcript),
        star_keywords_detected=detect_star_keywords(transcript),
    )


def _empty_heuristics() -> Heuristics:
    return Heuristics(
        word_count=0,
        wpm=0.0,
        filler_words_found={phrase: 0 for phrase in FILLER_PHRASES + FILLER_WORDS},
        star_keywords_detected={beat: [] for beat in STAR_INDICATORS},
    )


def _pad_unique(lines: List[str], backups: List[str]) -> List[str]:
    chosen: List[str] = []
    for line in lines + backups:
        text = line.strip()
        if text and text not in chosen:
            chosen.append(text)
        if len(chosen) == 3:
            break
    return _exactly_three(chosen, backups)


def heuristic_evaluation(
    role: str,
    question: str,
    transcript: str,
    heuristics: Heuristics,
) -> Evaluation:
    """Deterministic scores so /evaluate still answers when Gemma cannot."""
    filler_total = sum(heuristics.filler_words_found.values())
    words = heuristics.word_count
    wpm = heuristics.wpm
    filler_rate = (filler_total / words) if words else 1.0
    present = [beat for beat, hits in heuristics.star_keywords_detected.items() if hits]

    clarity = 8
    if words < 25:
        clarity -= 3
    elif words < 50:
        clarity -= 1
    if filler_rate > 0.08:
        clarity -= 3
    elif filler_rate > 0.04:
        clarity -= 2
    elif filler_rate > 0.015:
        clarity -= 1
    if wpm and (wpm < 90 or wpm > 190):
        clarity -= 2
    elif wpm and (wpm < 110 or wpm > 170):
        clarity -= 1
    if not wpm:
        clarity -= 1

    confidence = 7
    if 110 <= wpm <= 160:
        confidence += 1
    if wpm and (wpm < 80 or wpm > 200):
        confidence -= 2
    if filler_rate > 0.05:
        confidence -= 2
    elif filler_rate > 0.02:
        confidence -= 1
    if words >= 80:
        confidence += 1
    if words < 20:
        confidence -= 2

    star_score = {0: 2, 1: 4, 2: 6, 3: 8, 4: 10}[min(len(present), 4)]

    role_name = role.strip() or "this role"
    role_label = f"{'an' if role_name[:1].lower() in 'aeiou' else 'a'} {role_name}"
    question_label = question.strip().rstrip("?") or "the question that was asked"

    strength_lines: List[str] = []
    if len(present) >= 3:
        strength_lines.append(
            f"The answer already touches {len(present)} STAR beats: {', '.join(present)}."
        )
    elif present:
        strength_lines.append(
            f"You signaled {', '.join(present)}, so the story has a place to start."
        )
    else:
        strength_lines.append(
            "You answered in your own words, which is enough to reshape into STAR."
        )
    if 110 <= wpm <= 170:
        strength_lines.append(
            f"Pace is in a listenable range at about {round(wpm)} words per minute."
        )
    elif words >= 60:
        strength_lines.append(
            f"There is enough tape to coach ({words} words), rather than a one-line reply."
        )
    else:
        strength_lines.append("The answer is short, so a second pass can add the missing beat without a ramble.")
    if filler_total == 0 and words >= 15:
        strength_lines.append("None of the tracked filler words showed up.")
    elif filler_rate < 0.02:
        strength_lines.append("Filler words are sparse enough that the point still comes through.")
    else:
        strength_lines.append("The story is still recoverable; the fillers are a surface edit.")

    fix_lines: List[str] = []
    if "situation" not in present:
        fix_lines.append("Open with one sentence of situation: when, where, and what was at stake.")
    if "task" not in present:
        fix_lines.append("Name the task that was yours before you describe what you did.")
    if "action" not in present:
        fix_lines.append("Add two concrete actions you personally took, with verbs a listener can picture.")
    if "result" not in present:
        fix_lines.append("Close with a result: a number, a changed decision, or what you would repeat.")
    if filler_total:
        top = max(heuristics.filler_words_found, key=heuristics.filler_words_found.get)
        fix_lines.append(
            f"Swap each \"{top}\" for a short pause; it showed up {heuristics.filler_words_found[top]} time(s)."
        )
    if wpm > 180:
        fix_lines.append(f"Slow down from about {round(wpm)} WPM toward 130 so the result can land.")
    elif 0 < wpm < 90:
        fix_lines.append(f"Pick up the pace from about {round(wpm)} WPM toward 130 so the answer feels decisive.")
    if words < 40:
        fix_lines.append("Add about 30 to 50 words so both the situation and the result are on the tape.")

    ideal = (
        f"Situation: As {role_label}, I hit a moment that matches this question: {question_label}. "
        "Task: It was mine to handle, with a clear outcome expected of me. "
        "Action: I named the constraint, took the next concrete step myself, and told the people affected what I was doing. "
        "Result: The change was visible, I could point to what moved, and I kept the part that worked."
    )
    if not transcript.strip():
        ideal = (
            f"Situation: As {role_label}, I would set the scene for \"{question_label}\" in one sentence. "
            "Task: I would state the outcome I personally owned. "
            "Action: I would name two steps I took, in order. "
            "Result: I would end on a number or a decision that changed."
        )

    return Evaluation(
        overall_score=_clamp_score(round(0.35 * clarity + 0.25 * confidence + 0.40 * star_score)),
        clarity_score=_clamp_score(clarity),
        confidence_score=_clamp_score(confidence),
        star_alignment_score=_clamp_score(star_score),
        strengths=_pad_unique(
            strength_lines,
            [
                "The answer is specific enough to coach.",
                "You stayed on the question that was asked.",
                "A local replay can tighten this without another live interview.",
            ],
        ),
        lazy_fixes=_pad_unique(
            fix_lines,
            [
                "Record it once more at a calm pace and stop after the result sentence.",
                "Cut any sentence that does not serve Situation, Task, Action, or Result.",
                "Lead with the result if the listener will only remember one line.",
            ],
        ),
        rewritten_ideal_answer=ideal,
    )


def _fallback_evaluation() -> Evaluation:
    return Evaluation(
        overall_score=5,
        clarity_score=5,
        confidence_score=5,
        star_alignment_score=5,
        strengths=[
            "The attempt is on record and can be coached.",
            "You showed up for the question.",
            "A second take can add STAR structure.",
        ],
        lazy_fixes=[
            "State the situation in the first sentence.",
            "Name one action that was yours alone.",
            "End with the result in a single line.",
        ],
        rewritten_ideal_answer=(
            "Situation: Set the scene in one sentence. "
            "Task: Say what you owned. "
            "Action: Name the steps you took. "
            "Result: Close with what changed."
        ),
    )


def extract_json_object(raw: str) -> dict:
    """Pull a JSON object out of a small-model reply.

    `format: json` still sometimes arrives wrapped in prose or fences. Take a
    direct parse first, then the outermost brace span.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("Model response was empty")

    candidates = [text]
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        candidates.append(fenced.group(1))
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    last_error: Optional[Exception] = None
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        if isinstance(parsed, dict):
            return parsed
        last_error = ValueError("Model JSON was not an object")
    raise ValueError("No JSON object in model response") from last_error


def evaluation_from_model(payload: dict, heuristics: Heuristics, role: str, question: str, transcript: str) -> Evaluation:
    fallback = heuristic_evaluation(role, question, transcript, heuristics)
    strengths = _exactly_three(payload.get("strengths"), fallback.strengths)
    fixes = _exactly_three(payload.get("lazy_fixes"), fallback.lazy_fixes)
    rewritten = str(payload.get("rewritten_ideal_answer") or "").strip() or fallback.rewritten_ideal_answer
    return Evaluation(
        overall_score=_clamp_score(payload.get("overall_score"), fallback.overall_score),
        clarity_score=_clamp_score(payload.get("clarity_score"), fallback.clarity_score),
        confidence_score=_clamp_score(payload.get("confidence_score"), fallback.confidence_score),
        star_alignment_score=_clamp_score(payload.get("star_alignment_score"), fallback.star_alignment_score),
        strengths=strengths,
        lazy_fixes=fixes,
        rewritten_ideal_answer=rewritten,
    )


def build_gemma_prompt(
    role: str,
    mode: str,
    question: str,
    transcript: str,
    duration_seconds: float,
    heuristics: Heuristics,
) -> str:
    clipped = transcript.strip()
    if len(clipped) > 8000:
        clipped = clipped[:8000] + "…"
    heuristic_blob = json.dumps(heuristics.model_dump(), ensure_ascii=True)
    return (
        "You are EchoHire, a privacy-first interview coach. "
        "Evaluate the candidate's spoken answer for the given role and question. "
        "Use the delivery heuristics as evidence, not as the only verdict.\n\n"
        f"Role: {role.strip() or 'unspecified'}\n"
        f"Mode: {mode.strip() or 'unspecified'}\n"
        f"Question: {question.strip() or 'unspecified'}\n"
        f"Duration seconds: {duration_seconds}\n"
        f"Transcript:\n{clipped or '[empty transcript]'}\n\n"
        f"Delivery heuristics JSON:\n{heuristic_blob}\n\n"
        "Return a single JSON object and nothing else. No markdown fences, no preamble. "
        "Keys and types:\n"
        '- "overall_score": integer from 1 to 10\n'
        '- "clarity_score": integer from 1 to 10\n'
        '- "confidence_score": integer from 1 to 10\n'
        '- "star_alignment_score": integer from 1 to 10, judging Situation, Task, Action, Result\n'
        '- "strengths": array of exactly 3 short strings\n'
        '- "lazy_fixes": array of exactly 3 actionable one-line improvements\n'
        '- "rewritten_ideal_answer": one concise STAR-structured answer the candidate could say next time\n'
    )


def ollama_online() -> bool:
    """True only when the configured model is already pulled and listed."""
    try:
        response = requests.get(
            f"{OLLAMA_BASE}/api/tags",
            timeout=(1.0, 2.0),
        )
        if not response.ok:
            return False
        models = response.json().get("models") or []
        wanted = OLLAMA_MODEL.split(":", 1)[0]
        for model in models:
            name = str(model.get("name", ""))
            if name == OLLAMA_MODEL or name.startswith(wanted + ":"):
                return True
        return False
    except (requests.RequestException, ValueError, TypeError):
        return False


def faster_whisper_loadable() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:
        logger.warning("faster-whisper is not importable: %s", exc)
        return False
    return True


def _get_whisper_model():
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel

            _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


def transcribe_file(path: str) -> str:
    model = _get_whisper_model()
    segments, _info = model.transcribe(path, beam_size=1)
    parts = [segment.text.strip() for segment in segments if segment.text and segment.text.strip()]
    return " ".join(parts).strip()


def groq_api_key() -> str:
    _load_local_env()
    return os.environ.get("GROQ_API_KEY", "").strip()


def groq_online() -> bool:
    """True when the Groq key is accepted. Cached so the dashboard poll does not hammer the API."""
    global _groq_checked_at, _groq_ok
    key = groq_api_key()
    if not key:
        return False
    now = time.time()
    with _groq_lock:
        if now - _groq_checked_at < 20:
            return _groq_ok
    ok = False
    try:
        response = requests.get(
            f"{GROQ_BASE}/models",
            headers={"Authorization": f"Bearer {key}"},
            timeout=(2.0, 3.0),
        )
        ok = response.ok
    except requests.RequestException:
        ok = False
    with _groq_lock:
        _groq_checked_at = time.time()
        _groq_ok = ok
    return ok


def score_with_groq(prompt: str) -> dict:
    key = groq_api_key()
    if not key:
        raise requests.RequestException("GROQ_API_KEY is not set")
    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You score interview answers. Return one JSON object and nothing else.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_completion_tokens": 800,
        "response_format": {"type": "json_object"},
    }
    response = requests.post(
        f"{GROQ_BASE}/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=GROQ_TIMEOUT,
    )
    if response.status_code == 400:
        payload.pop("response_format", None)
        response = requests.post(
            f"{GROQ_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            timeout=GROQ_TIMEOUT,
        )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    if isinstance(content, dict):
        return content
    return extract_json_object(str(content))


def score_with_gemma(prompt: str) -> dict:
    response = requests.post(
        f"{OLLAMA_BASE}/api/generate",
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.2, "num_ctx": OLLAMA_NUM_CTX},
        },
        timeout=OLLAMA_GENERATE_TIMEOUT,
    )
    response.raise_for_status()
    body = response.json()
    raw = body.get("response", "")
    if isinstance(raw, dict):
        return raw
    return extract_json_object(str(raw))


def _suffix_for_upload(upload: UploadFile) -> str:
    name = upload.filename or ""
    suffix = os.path.splitext(name)[1].lower()
    if suffix and len(suffix) <= 8 and re.fullmatch(r"\.[a-z0-9]+", suffix):
        return suffix
    return ".webm"


async def _transcript_from_audio(upload: UploadFile) -> str:
    payload = await upload.read()
    if not payload:
        raise ValueError("Uploaded audio was empty")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=_suffix_for_upload(upload)) as handle:
            handle.write(payload)
            temp_path = handle.name
        return await asyncio.to_thread(transcribe_file, temp_path)
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                logger.warning("Could not remove temp audio %s", temp_path)


@app.on_event("startup")
def warm_whisper_import() -> None:
    # The first native import can take a while. Keep it off the health request
    # so the dashboard does not treat a live API as offline.
    threading.Thread(target=faster_whisper_loadable, name="whisper-import", daemon=True).start()


@app.get("/", response_class=HTMLResponse)
def root() -> str:
    dashboard = os.environ.get("DASHBOARD_URL", "http://127.0.0.1:3000").strip().rstrip("/")
    if not dashboard:
        dashboard = "http://127.0.0.1:3000"
    safe_dashboard = html.escape(dashboard, quote=True)
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>EchoHire API</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #020617; color: #f1f5f9; font-family: "Segoe UI", sans-serif; }
    main { max-width: 36rem; padding: 2rem; }
    a { color: #34d399; }
    code { color: #c7d2fe; }
  </style>
</head>
<body>
  <main>
    <h1>EchoHire API</h1>
    <p>This address is the scoring server. The interview dashboard is at <a href="__DASHBOARD__">__DASHBOARD__</a>.</p>
    <p>Check the server at <a href="/health"><code>/health</code></a>. Answers are scored with <code>POST /evaluate</code>.</p>
  </main>
</body>
</html>
""".replace("__DASHBOARD__", safe_dashboard)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    online, groq = await asyncio.gather(
        asyncio.to_thread(ollama_online),
        asyncio.to_thread(groq_online),
    )
    return HealthResponse(
        status="ok",
        ollama_online=online,
        groq_online=groq,
        model=GROQ_MODEL if groq else OLLAMA_MODEL,
        stt=STT_LABEL,
    )


@app.post("/evaluate", response_model=EvaluateResponse)
async def evaluate(
    role: str = Form(...),
    mode: str = Form(...),
    question: str = Form(...),
    transcript: str = Form(""),
    duration_seconds: float = Form(...),
    audio: Optional[UploadFile] = File(None),
) -> EvaluateResponse:
    text = (transcript or "").strip()
    transcript_source = "client" if text else "none"
    safe_duration = duration_seconds if duration_seconds and duration_seconds > 0 else 0.0

    if audio is not None and not text:
        try:
            text = (await _transcript_from_audio(audio)).strip()
            transcript_source = "faster-whisper" if text else "faster-whisper-empty"
        except Exception as exc:
            logger.warning("Local transcription failed (%s); continuing with heuristics", exc)
            text = ""
            transcript_source = "unavailable"

    try:
        heuristics = compute_heuristics(text, safe_duration)
    except Exception:
        logger.exception("Heuristic pass failed")
        heuristics = _empty_heuristics()

    evaluation_source = "heuristic_fallback"
    try:
        evaluation = heuristic_evaluation(role, question, text, heuristics)
    except Exception:
        logger.exception("Heuristic scoring failed")
        evaluation = _fallback_evaluation()

    prompt = build_gemma_prompt(role, mode, question, text, safe_duration, heuristics)
    scored = False
    if groq_api_key():
        try:
            payload = await asyncio.to_thread(score_with_groq, prompt)
            evaluation = evaluation_from_model(payload, heuristics, role, question, text)
            evaluation_source = f"groq:{GROQ_MODEL}"
            scored = True
        except (requests.RequestException, ValueError, KeyError, TypeError, IndexError) as exc:
            logger.warning("Groq scoring unavailable (%s); trying Ollama", exc)
        except Exception:
            logger.exception("Unexpected Groq failure; trying Ollama")
    if not scored:
        try:
            payload = await asyncio.to_thread(score_with_gemma, prompt)
            evaluation = evaluation_from_model(payload, heuristics, role, question, text)
            evaluation_source = OLLAMA_MODEL
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            logger.warning("Ollama scoring unavailable (%s); using delivery heuristics", exc)
        except Exception:
            logger.exception("Unexpected scoring failure; using delivery heuristics")

    return EvaluateResponse(
        role=role,
        mode=mode,
        question=question,
        transcript=text,
        transcript_source=transcript_source,
        duration_seconds=safe_duration,
        heuristics=heuristics,
        evaluation=evaluation,
        evaluation_source=evaluation_source,
    )


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
