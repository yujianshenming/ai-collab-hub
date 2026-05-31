from __future__ import annotations

import io
from pathlib import Path

try:
    import docx
    import pypdf
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
except ImportError as exc:  # pragma: no cover - startup guidance
    raise SystemExit(
        "Missing dependencies. Install them with: python -m pip install fastapi uvicorn python-multipart python-docx pypdf"
    ) from exc

from hermes_agent import HermesAgent, result_to_dict


ROOT = Path(__file__).parent
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Hermes Agent", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


def parse_file_content(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    buffer = io.BytesIO(content)

    if suffix == ".docx":
        document = docx.Document(buffer)
        return "\n".join(paragraph.text for paragraph in document.paragraphs if paragraph.text.strip())

    if suffix == ".pdf":
        reader = pypdf.PdfReader(buffer)
        pages = [page.extract_text() or "" for page in reader.pages]
        return "\n".join(page.strip() for page in pages if page.strip())

    return content.decode("utf-8-sig", errors="ignore")


@app.post("/api/start-harness")
async def start_harness(
    document: UploadFile | None = File(default=None),
    text: str = Form(default=""),
    threshold: int = Form(default=85),
    student_persona: str = Form(default="auto"),
    transition_word: str = Form(default="下个阶段"),
) -> dict:
    body = text
    if document and document.filename:
        raw = await document.read()
        body = parse_file_content(document.filename, raw) or body

    # Save to a debug file to inspect the exact input causing issues
    try:
        debug_dir = Path(r"C:\Users\24391\.gemini\antigravity\brain\7319f9a2-220d-4c09-b872-fa3db7a254b7\scratch")
        debug_dir.mkdir(parents=True, exist_ok=True)
        debug_file = debug_dir / "debug_input.txt"
        debug_file.write_text(body, encoding="utf-8")
        print(f"[DEBUG] Received document/text of length: {len(body)} chars, saved to {debug_file}")
    except Exception as e:
        print(f"[DEBUG] Failed to save debug input: {e}")

    harness = HermesAgent()
    result = harness.run(
        body,
        threshold=threshold,
        student_persona=student_persona,
        transition_word=transition_word,
    )
    return result_to_dict(result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
