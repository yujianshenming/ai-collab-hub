from __future__ import annotations

from pathlib import Path

try:
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
except ImportError as exc:  # pragma: no cover - startup guidance
    raise SystemExit(
        "Missing dependencies. Install them with: python -m pip install fastapi uvicorn python-multipart"
    ) from exc

from hermes_agent import HermesAgent, result_to_dict


ROOT = Path(__file__).parent
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Hermes Agent", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


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
        body = raw.decode("utf-8", errors="ignore") or body

    harness = HermesAgent()
    result = harness.run(body, threshold=threshold, student_persona=student_persona)
    return result_to_dict(result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
