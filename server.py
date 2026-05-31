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
) -> dict:
    body = text
    if document and document.filename:
        raw = await document.read()
        body = parse_file_content(document.filename, raw) or body

    harness = HermesAgent()
    result = harness.run(body, threshold=threshold, student_persona=student_persona)
    return result_to_dict(result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
