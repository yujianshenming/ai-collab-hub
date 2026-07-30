# 测试全局夹具：保证离线、确定性，且不污染仓库。
# - HERMES_FORCE_MOCK=1：无 config.json / 无网络也能跑通，避免测试触发真实网关调用。
# - HERMES_DEBUG_DIR：server.py 会在每次请求写 debug_input.txt，指向临时目录而非仓库。
import os
import tempfile

os.environ.setdefault("HERMES_FORCE_MOCK", "1")
os.environ.setdefault("HERMES_DEBUG_DIR", tempfile.mkdtemp(prefix="hermes_test_"))
