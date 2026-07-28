"""让 tests/ 能直接 import 集成目录下的 web_server / polymas_grade_engine。"""
import os
import sys
import tempfile
from pathlib import Path

# 先把数据目录指向临时目录，避免 import 时的日志初始化在仓库内生成 output/
# （会违反 homework-variance-integration-contract.test.js 的边界约束）。
os.environ.setdefault(
    "PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_DATA",
    tempfile.mkdtemp(prefix="hwv-test-"),
)

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
