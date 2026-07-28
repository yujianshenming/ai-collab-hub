#!/usr/bin/env python3
"""
Polymas 作业批阅前端 API。

用户本机启动（推荐桌面「启动批阅台.bat」）:
  cd homework_variance_tool
  set PYTHONUTF8=1
  python web_server.py
  # 浏览器打开 http://127.0.0.1:8765

表单只需: 作业 URL + JWT + Cookie（user_nid 等自动解析）。
"""
from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LOG = logging.getLogger("homework_variance.web_server")


def _default_log_dir() -> Path:
    data_root = os.environ.get("PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_DATA", "").strip()
    base = Path(data_root).expanduser() if data_root else Path(__file__).resolve().parent / "output"
    return base / "logs"


def _setup_logging() -> None:
    """stderr + 文件双 handler；在三方库导入前初始化，保证启动失败也能落盘。"""
    if LOG.handlers:
        return
    LOG.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(formatter)
    LOG.addHandler(console)
    try:
        log_dir = _default_log_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_dir / "web_server.log", encoding="utf-8")
        file_handler.setFormatter(formatter)
        LOG.addHandler(file_handler)
    except Exception:
        LOG.warning("无法创建日志文件 handler，仅输出到 stderr", exc_info=True)


_setup_logging()

try:
    from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles
except Exception:
    LOG.exception("依赖导入失败，侧车无法启动（请确认已安装 fastapi/uvicorn）")
    raise

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "polymas_grade_engine.py"
STATIC = ROOT / "web" / "static"
DATA_ROOT = ROOT / "output"
UPLOADS = DATA_ROOT / "uploads"
JOBS = DATA_ROOT / "web_jobs"
ACCESS_TOKEN = ""
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_UPLOAD_FILES = 100
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def configure_runtime(data_root: str | None = None, access_token: str | None = None) -> None:
    """Configure writable data and the optional local IPC token before serving."""
    global DATA_ROOT, UPLOADS, JOBS, ACCESS_TOKEN
    configured_root = data_root or os.environ.get("PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_DATA")
    DATA_ROOT = Path(configured_root).expanduser().resolve() if configured_root else ROOT / "output"
    UPLOADS = DATA_ROOT / "uploads"
    JOBS = DATA_ROOT / "web_jobs"
    ACCESS_TOKEN = (access_token if access_token is not None else os.environ.get(
        "PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_TOKEN", ""
    )).strip()
    UPLOADS.mkdir(parents=True, exist_ok=True)
    JOBS.mkdir(parents=True, exist_ok=True)

STATIC.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Polymas 作业批阅控制台", version="1.1.0")
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

# job_id -> runtime
RUNTIME: dict[str, dict] = {}
LOCK = threading.Lock()


@app.middleware("http")
async def local_access_guard(request: Request, call_next):
    """Protect the API when launched by the workbench without affecting standalone mode."""
    if ACCESS_TOKEN and request.url.path.startswith("/api/"):
        supplied = request.headers.get("x-workbench-token", "") or request.query_params.get("token", "")
        if not hmac.compare_digest(supplied, ACCESS_TOKEN):
            return JSONResponse({"detail": "本地服务访问令牌无效或已缺失"}, status_code=401)
    return await call_next(request)


@app.get("/health")
def health():
    return {"ok": True, "service": "homework-variance"}


def parse_homework_url(url: str) -> dict:
    """从智慧树作业页 URL 提取 course_id / instance_nid / agent_id 等。"""
    out = {
        "course_id": None,
        "instance_nid": None,
        "agent_id": None,
        "library_id": None,
        "raw": url.strip(),
    }
    if not url or not url.strip():
        return out
    u = url.strip()
    try:
        p = urlparse(u)
        qs = parse_qs(p.query)
        for key, field in (
            ("instanceNid", "instance_nid"),
            ("instanceId", "instance_nid"),
            ("agentId", "agent_id"),
            ("libraryId", "library_id"),
            ("courseId", "course_id"),
        ):
            if key in qs and qs[key]:
                out[field] = qs[key][0]
        # path: /{courseId}/resource/paper/create
        parts = [x for x in p.path.split("/") if x]
        if "resource" in parts:
            i = parts.index("resource")
            if i >= 1 and not out["course_id"]:
                out["course_id"] = parts[i - 1]
        if "agent-review" in parts:
            i = parts.index("agent-review")
            if i >= 1 and not out["course_id"]:
                out["course_id"] = parts[i - 1]
    except Exception:
        pass
    # bare instance nid
    if not out["instance_nid"] and re.fullmatch(r"[A-Za-z0-9_-]{6,}", u):
        out["instance_nid"] = u
    return out


def extract_jwt(auth_or_cookie: str) -> str:
    s = (auth_or_cookie or "").strip()
    if not s:
        return ""
    if s.lower().startswith("bearer "):
        return s[7:].strip()
    # cookie string with ai-poly=
    m = re.search(r"(?:^|;\s*)ai-poly=([^;]+)", s, flags=re.I)
    if m:
        return m.group(1).strip().strip('"')
    # raw JWT-like
    if s.count(".") >= 2 and " " not in s.split(".")[0] and len(s) > 20:
        # if entire string is jwt
        if re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", s):
            return s
        # if Authorization-like free text, take first jwt-looking token
        m2 = re.search(r"(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)", s)
        if m2:
            return m2.group(1)
    return s


def _b64url_json(segment: str) -> dict | None:
    """Decode JWT payload segment without verifying signature."""
    import base64

    s = (segment or "").strip()
    if not s:
        return None
    pad = "=" * ((4 - len(s) % 4) % 4)
    try:
        raw = base64.urlsafe_b64decode(s + pad)
        data = json.loads(raw.decode("utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def decode_jwt_payload(token: str) -> dict | None:
    t = extract_jwt(token)
    if not t or t.count(".") < 2:
        return None
    return _b64url_json(t.split(".")[1])


def _cookie_map(cookie: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (cookie or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _parse_loose_json(raw: str) -> dict | None:
    """Parse cookie values that may be URL-encoded or use single quotes / JS object style."""
    from urllib.parse import unquote

    if not raw:
        return None
    s = unquote(raw.strip())
    # try strict JSON
    for candidate in (s, s.replace("'", '"')):
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    # AI-POLY-UINFO sometimes uses {%22key%22:...} already unquoted to {"key":...}
    # CASLOGC may look like {%22realName%22:...} with braces
    if s.startswith("{") and s.endswith("}"):
        try:
            # convert {key:val} loosely — only if already double-quoted keys
            data = json.loads(s)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return None


def extract_user_nid(jwt: str = "", cookie: str = "", explicit: str = "") -> tuple[str, str]:
    """
    自动解析 user_nid。返回 (user_nid, source)。
    优先级：显式填写 → JWT payload → Cookie 中的用户信息字段。
    """
    if (explicit or "").strip():
        return explicit.strip(), "form"

    # 1) JWT payload: userNid / loginId / nid / userId(string)
    for raw in (jwt, cookie):
        payload = decode_jwt_payload(raw or "")
        if not payload:
            continue
        for key in ("userNid", "user_nid", "nid", "loginId", "login_id"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip() and not val.isdigit():
                return val.strip(), f"jwt.{key}"
            if isinstance(val, str) and val.strip() and key in ("userNid", "nid", "loginId"):
                # nid 有时是字母数字混合；纯数字也可能是 uid，优先非纯数字
                return val.strip(), f"jwt.{key}"
        # nested userInfo
        for nest_key in ("userInfo", "user", "data"):
            nest = payload.get(nest_key)
            if isinstance(nest, dict):
                for key in ("userNid", "nid", "loginId"):
                    val = nest.get(key)
                    if isinstance(val, str) and val.strip():
                        return val.strip(), f"jwt.{nest_key}.{key}"

    # 2) Cookie map
    cmap = _cookie_map(cookie)
    # AI-POLY-UINFO / AI_POLY_UINFO 等
    for ck in list(cmap.keys()):
        if re.search(r"AI.?POLY.?UINFO|poly.?uinfo|userinfo|UINFO", ck, flags=re.I):
            data = _parse_loose_json(cmap[ck])
            if data:
                for key in ("nid", "userNid", "user_nid", "loginId"):
                    val = data.get(key)
                    if isinstance(val, str) and val.strip():
                        return val.strip(), f"cookie.{ck}.{key}"
        if re.search(r"CASLOGC|caslogc", ck, flags=re.I):
            data = _parse_loose_json(cmap[ck])
            if data:
                for key in ("nid", "userNid", "uuid"):
                    val = data.get(key)
                    # CASLOGC 的 uuid 不一定是 userNid；优先 nid
                    if key != "uuid" and isinstance(val, str) and val.strip():
                        return val.strip(), f"cookie.{ck}.{key}"

    # 3) ai-poly JWT inside cookie already handled via decode_jwt_payload(cookie)
    # 4) Regex fallback on whole cookie for "nid":"XXXX"
    m = re.search(
        r'["\'](?:userNid|user_nid|nid)["\']\s*:\s*["\']([A-Za-z0-9_-]{6,})["\']',
        cookie or "",
        flags=re.I,
    )
    if m:
        return m.group(1), "cookie.regex"

    m2 = re.search(
        r'["\'](?:userNid|user_nid|nid)["\']\s*:\s*["\']([A-Za-z0-9_-]{6,})["\']',
        jwt or "",
        flags=re.I,
    )
    if m2:
        return m2.group(1), "jwt.regex"

    return "", ""


def job_dir(job_id: str) -> Path:
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(400, "非法任务编号")
    return JOBS / job_id


def cfg_path(job_id: str) -> Path:
    return job_dir(job_id) / "job.json"


def load_job_meta(job_id: str) -> dict:
    p = job_dir(job_id) / "meta.json"
    if not p.exists():
        raise HTTPException(404, f"job not found: {job_id}")
    return json.loads(p.read_text(encoding="utf-8"))


def save_job_meta(job_id: str, meta: dict) -> None:
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def resolve_job_file(job_id: str, candidate: str | Path) -> Path | None:
    """Resolve generated files without allowing metadata to escape the job directory."""
    root = job_dir(job_id).resolve()
    path = Path(candidate)
    if not path.is_absolute():
        path = root / path
    try:
        resolved = path.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return resolved


def engine_cmd(*args: str) -> list[str]:
    return [sys.executable, str(ENGINE), *args]


def _engine_env() -> dict:
    """子进程强制 UTF-8，避免 Windows 下中文文件名/level 乱码。"""
    import os

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    # 部分 Windows 终端仍按系统代码页读管道；明确声明
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("LC_ALL", "C.UTF-8")
    env.setdefault("PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_SECRETS", str(DATA_ROOT / "secrets.json"))
    return env


def run_engine(job_id: str, *args: str, timeout: float = 120) -> dict:
    cp = cfg_path(job_id)
    cmd = engine_cmd(*args, "--config", str(cp))
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(ROOT),
            encoding="utf-8",
            errors="replace",
            env=_engine_env(),
        )
        return {
            "returncode": r.returncode,
            "stdout": r.stdout,
            "stderr": r.stderr,
        }
    except subprocess.TimeoutExpired as e:
        out = e.stdout
        if isinstance(out, bytes):
            out = out.decode("utf-8", errors="replace")
        return {
            "returncode": -1,
            "stdout": out or "",
            "stderr": f"timeout after {timeout}s",
        }


def worker_loop(job_id: str) -> None:
    with LOCK:
        rt = RUNTIME.get(job_id)
        if not rt:
            return
        rt["status"] = "running"
        rt["message"] = "批阅中…"
        rt["started_at"] = time.time()
    save_job_meta(job_id, {**load_job_meta(job_id), "status": "running"})

    try:
        # init
        res = run_engine(job_id, "init", timeout=90)
        if res["returncode"] != 0:
            raise RuntimeError(f"init failed: {res['stderr'] or res['stdout']}")
        with LOCK:
            RUNTIME[job_id]["logs"].append(res["stdout"][-2000:])
            RUNTIME[job_id]["message"] = "初始化完成，开始轮询批阅"

        # loop next until done
        for _ in range(500):
            with LOCK:
                if RUNTIME.get(job_id, {}).get("cancel"):
                    RUNTIME[job_id]["status"] = "cancelled"
                    RUNTIME[job_id]["message"] = "已取消"
                    save_job_meta(job_id, {**load_job_meta(job_id), "status": "cancelled"})
                    return
            res = run_engine(job_id, "next", timeout=90)
            out = res["stdout"] or ""
            err = res["stderr"] or ""
            with LOCK:
                RUNTIME[job_id]["logs"].append((out + err)[-3000:])
                if len(RUNTIME[job_id]["logs"]) > 80:
                    RUNTIME[job_id]["logs"] = RUNTIME[job_id]["logs"][-80:]
            # status snapshot
            st = run_engine(job_id, "status", timeout=30)
            try:
                # last JSON object in stdout
                text = st["stdout"] or ""
                # find outermost {
                idx = text.find("{")
                if idx >= 0:
                    info = json.loads(text[idx:])
                    with LOCK:
                        RUNTIME[job_id]["progress"] = info
                        RUNTIME[job_id]["message"] = f"进度 {info.get('progress')}  wall≈{info.get('wall_so_far')}s"
                    if info.get("done"):
                        break
            except Exception:
                pass
            if res["returncode"] not in (0, 3) and "still_polling" not in out:
                # soft fail: check if all done
                pass
            time.sleep(0.3)

        # report
        rep = run_engine(job_id, "report", timeout=60)
        with LOCK:
            RUNTIME[job_id]["logs"].append(rep["stdout"][-2000:])
        excel = None
        try:
            text = rep["stdout"] or ""
            idx = text.find("{")
            if idx >= 0:
                info = json.loads(text[idx:])
                excel = info.get("excel")
                with LOCK:
                    RUNTIME[job_id]["excel"] = excel
                    RUNTIME[job_id]["summary"] = info.get("files")
        except Exception:
            pass
        # find excel if path missing
        if not excel:
            outs = list(job_dir(job_id).glob("*.xlsx"))
            if outs:
                excel = str(outs[0])
                with LOCK:
                    RUNTIME[job_id]["excel"] = excel

        with LOCK:
            RUNTIME[job_id]["status"] = "done"
            RUNTIME[job_id]["message"] = "批阅完成"
            RUNTIME[job_id]["finished_at"] = time.time()
        meta = load_job_meta(job_id)
        meta["status"] = "done"
        meta["excel"] = excel
        meta["finished_at"] = datetime.now().isoformat(timespec="seconds")
        save_job_meta(job_id, meta)
    except Exception as e:
        LOG.exception("worker_loop 异常终止 (job_id=%s)", job_id)
        with LOCK:
            RUNTIME[job_id]["status"] = "error"
            RUNTIME[job_id]["message"] = str(e)
            RUNTIME[job_id]["logs"].append(f"ERROR: {e}")
        try:
            meta = load_job_meta(job_id)
            meta["status"] = "error"
            meta["error"] = str(e)
            save_job_meta(job_id, meta)
        except Exception:
            pass


@app.get("/", response_class=HTMLResponse)
def index():
    html = STATIC / "index.html"
    if not html.exists():
        return HTMLResponse("<h1>index.html missing</h1>", status_code=500)
    return HTMLResponse(html.read_text(encoding="utf-8"))


@app.post("/api/parse-url")
def api_parse_url(body: dict):
    """从 URL + JWT + Cookie 自动解析作业上下文与 user_nid。"""
    url = body.get("url") or ""
    jwt = body.get("jwt") or ""
    cookie = body.get("cookie") or ""
    parsed = parse_homework_url(url)
    token = extract_jwt(jwt) or extract_jwt(cookie)
    uid, uid_src = extract_user_nid(jwt=jwt or token, cookie=cookie)
    return {
        **parsed,
        "jwt_extracted": bool(token),
        "user_nid": uid or None,
        "user_nid_source": uid_src or None,
    }


@app.post("/api/jobs")
async def create_job(
    title: str = Form(""),
    url: str = Form(""),
    instance_nid: str = Form(""),
    agent_id: str = Form(""),
    course_id: str = Form(""),
    user_nid: str = Form(""),
    jwt: str = Form(""),
    cookie: str = Form(""),
    times: int = Form(3),
    poll_interval: float = Form(3.0),
    fix_empty_answers: str = Form("true"),
    files: list[UploadFile] = File(...),
):
    if not files:
        raise HTTPException(400, "请至少上传一份作业文件")
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(413, f"一次最多上传 {MAX_UPLOAD_FILES} 个文件")
    parsed = parse_homework_url(url)
    inst = (instance_nid or "").strip() or parsed.get("instance_nid") or ""
    ag = (agent_id or "").strip() or parsed.get("agent_id") or "zsxGPgjvWx"
    cid = (course_id or "").strip() or parsed.get("course_id") or ""
    if not inst:
        raise HTTPException(400, "缺少 instance_nid：请粘贴完整作业页 URL")
    token = extract_jwt(jwt) or extract_jwt(cookie)
    if not token:
        raise HTTPException(400, "请填写 JWT 或 Cookie（含 ai-poly）")

    uid, uid_src = extract_user_nid(jwt=jwt or token, cookie=cookie, explicit=user_nid)
    if not uid:
        raise HTTPException(
            400,
            "无法从 JWT/Cookie 自动解析 user_nid。请确认 Cookie 含 AI-POLY-UINFO 或 JWT payload 含 userNid",
        )
    try:
        times = max(1, min(int(times), 20))
        poll_interval = max(0.5, min(float(poll_interval), 60.0))
    except (TypeError, ValueError):
        raise HTTPException(400, "批阅次数或轮询间隔无效")
    fix_flag = str(fix_empty_answers or "true").strip().lower() in {"1", "true", "yes", "on"}

    job_id = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    files_dir = d / "files"
    files_dir.mkdir(exist_ok=True)

    file_entries = []
    for uf in files:
        name = Path(uf.filename or "file.docx").name
        if name in {"", ".", ".."}:
            name = "file.docx"
        dest = files_dir / name
        if dest.exists():
            dest = files_dir / f"{dest.stem}_{uuid.uuid4().hex[:4]}{dest.suffix}"
        content = await uf.read(MAX_UPLOAD_BYTES + 1)
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"单个文件不能超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
        dest.write_bytes(content)
        file_entries.append({"label": dest.stem, "path": str(dest)})

    cookie_val = (cookie or "").strip()
    if "ai-poly=" not in cookie_val:
        cookie_val = f"ai-poly={token}" + (f"; {cookie_val}" if cookie_val else "")

    cfg = {
        "title": title or f"批阅任务 {job_id}",
        "instance_nid": inst,
        "agent_id": ag,
        "course_id": cid,
        "user_nid": uid,
        "auth": {"jwt": token, "cookie": cookie_val},
        "times": times,
        "poll_interval": float(poll_interval),
        "fix_empty_answers": fix_flag,
        "out_dir": str(d),
        "excel_name": f"评分表_{job_id}.xlsx",
        "files": file_entries,
    }
    # LLM 凭证不进 job.json（防泄漏进 output）；引擎从 secrets.json / 环境变量读取
    cfg_path(job_id).write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    meta = {
        "job_id": job_id,
        "title": cfg["title"],
        "instance_nid": inst,
        "agent_id": ag,
        "course_id": cid,
        "user_nid": uid,
        "user_nid_source": uid_src,
        "times": times,
        "fix_empty_answers": fix_flag,
        "files": [{"label": f["label"], "name": Path(f["path"]).name} for f in file_entries],
        "status": "created",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "excel": None,
    }
    save_job_meta(job_id, meta)

    with LOCK:
        RUNTIME[job_id] = {
            "status": "created",
            "message": f"已创建（user_nid={uid} ← {uid_src}"
            + ("，空题LLM回填开" if fix_flag else "，空题回填关")
            + "），等待启动",
            "logs": [],
            "progress": None,
            "excel": None,
            "summary": None,
            "cancel": False,
        }

    return {"job_id": job_id, "meta": meta}


@app.post("/api/jobs/{job_id}/start")
def start_job(job_id: str):
    meta = load_job_meta(job_id)
    with LOCK:
        rt = RUNTIME.get(job_id)
        if rt and rt.get("status") in {"running", "starting"}:
            return {"ok": True, "message": "已在运行"}
        if not rt:
            RUNTIME[job_id] = {
                "status": "starting",
                "message": "",
                "logs": [],
                "progress": None,
                "excel": None,
                "summary": None,
                "cancel": False,
            }
        else:
            RUNTIME[job_id]["status"] = "starting"
        RUNTIME[job_id]["cancel"] = False
    t = threading.Thread(target=worker_loop, args=(job_id,), daemon=True)
    t.start()
    return {"ok": True, "job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    with LOCK:
        if job_id in RUNTIME:
            RUNTIME[job_id]["cancel"] = True
            RUNTIME[job_id]["message"] = "取消中…"
    return {"ok": True}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    meta = load_job_meta(job_id)
    with LOCK:
        rt = RUNTIME.get(job_id, {})
    # refresh progress from state if exists
    progress = rt.get("progress")
    sp = job_dir(job_id) / "state.json"
    if sp.exists() and not progress:
        try:
            st = json.loads(sp.read_text(encoding="utf-8"))
            done_runs = sum(1 for j in st["jobs"] for r in j["runs"] if r.get("phase") == "done")
            total_runs = len(st["jobs"]) * int(st.get("times") or 3)
            progress = {
                "done": st.get("done"),
                "progress": f"{done_runs}/{total_runs}",
                "progress_num": done_runs,
                "progress_den": total_runs,
                "jobs": [
                    {
                        "level": j["level"],
                        "scores": [r.get("total_score") for r in j["runs"]],
                    }
                    for j in st["jobs"]
                ],
            }
        except Exception:
            pass
    return {
        "meta": meta,
        "status": rt.get("status") or meta.get("status"),
        "message": rt.get("message") or "",
        "progress": progress,
        "excel": rt.get("excel") or meta.get("excel"),
        "summary": rt.get("summary"),
        "logs": (rt.get("logs") or [])[-30:],
    }


@app.get("/api/jobs")
def list_jobs():
    items = []
    if not JOBS.exists():
        return {"jobs": []}
    for d in sorted(JOBS.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        mp = d / "meta.json"
        if not mp.exists():
            continue
        try:
            meta = json.loads(mp.read_text(encoding="utf-8"))
            with LOCK:
                rt = RUNTIME.get(meta["job_id"], {})
            items.append(
                {
                    "job_id": meta["job_id"],
                    "title": meta.get("title"),
                    "status": rt.get("status") or meta.get("status"),
                    "created_at": meta.get("created_at"),
                    "files": meta.get("files"),
                    "times": meta.get("times"),
                }
            )
        except Exception:
            continue
    return {"jobs": items[:50]}


@app.get("/api/jobs/{job_id}/excel")
def download_excel(job_id: str):
    meta = load_job_meta(job_id)
    excel = meta.get("excel")
    with LOCK:
        rt = RUNTIME.get(job_id, {})
        if rt.get("excel"):
            excel = rt["excel"]
    if not excel:
        candidates = list(job_dir(job_id).glob("*.xlsx"))
        if candidates:
            excel = str(candidates[0])
    excel_path = resolve_job_file(job_id, excel) if excel else None
    if not excel_path or not excel_path.is_file():
        raise HTTPException(404, "评分表尚未生成")
    return FileResponse(
        excel_path,
        filename=excel_path.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.get("/api/jobs/{job_id}/summary")
def get_summary(job_id: str):
    sp = job_dir(job_id) / "summary.json"
    if not sp.exists():
        raise HTTPException(404, "summary not ready")
    return json.loads(sp.read_text(encoding="utf-8"))


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    with LOCK:
        if job_id in RUNTIME and RUNTIME[job_id].get("status") == "running":
            raise HTTPException(400, "任务运行中，请先取消")
        RUNTIME.pop(job_id, None)
    d = job_dir(job_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the local homework variance service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-root", default="")
    parser.add_argument("--auth-token", default=None)
    args = parser.parse_args()
    try:
        import uvicorn

        configure_runtime(args.data_root or None, args.auth_token)
        LOG.info("Polymas 作业批阅控制台启动 http://%s:%s data_root=%s", args.host, args.port, DATA_ROOT)
        print("=" * 50)
        print("  Polymas 作业批阅控制台")
        print(f"  http://{args.host}:{args.port}", flush=True)
        print("=" * 50)
        uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    except Exception:
        LOG.exception("侧车启动失败 (host=%s port=%s data_root=%s)", args.host, args.port, args.data_root or "-")
        raise
