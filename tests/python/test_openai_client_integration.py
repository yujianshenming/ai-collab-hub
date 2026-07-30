# OpenAICompatibleClient 集成测试：验证"失败显式抛 LLMUnavailable，不再静默切 Mock"
# （对应 CODE_REVIEW_STANDARD.md §5 案例 C2 的修复）
#
# 注意：本仓库默认无 config.json，且 conftest 设了 HERMES_FORCE_MOCK=1，
# 因此默认走 mock。测试真实分支时显式提供临时 config 并关闭 mock 环境变量。
import json

import pytest

from hermes.llm.client import LLMUnavailable
from hermes_agent import OpenAICompatibleClient


def _write_temp_config(tmp_path, base_url: str):
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"api_key": "test-key", "base_url": base_url, "model": "test-model"}),
        encoding="utf-8",
    )
    return cfg


def test_mock_mode_returns_mock_response():
    # 默认（无 config + FORCE_MOCK）必须走 mock，且返回可控的模拟串
    client = OpenAICompatibleClient()
    assert client.provider == "mock"
    out = client.chat([{"role": "user", "content": "hi"}])
    assert isinstance(out, str) and out  # 非空
    assert out.startswith("模拟的 Hermes 助手回答")


def test_real_config_reports_non_mock_provider(monkeypatch, tmp_path):
    # 关掉 mock 开关 + 提供真实 config -> provider 不再是 "mock"（模式标志诚实）
    monkeypatch.delenv("HERMES_FORCE_MOCK", raising=False)
    monkeypatch.delenv("HERMES_MOCK_MODE", raising=False)
    cfg = _write_temp_config(tmp_path, "http://127.0.0.1:1")
    client = OpenAICompatibleClient(config_path=cfg)
    assert client.provider != "mock"
    assert client.provider.startswith("openai-compatible:")


def test_real_failure_raises_explicitly_not_silent(monkeypatch, tmp_path):
    # C2 核心回归：真实调用失败（指向不可达地址）必须显式抛 LLMUnavailable，
    # 绝不能像旧实现那样静默降级到 mock。压缩重试以加快测试。
    monkeypatch.delenv("HERMES_FORCE_MOCK", raising=False)
    monkeypatch.delenv("HERMES_MOCK_MODE", raising=False)
    monkeypatch.setenv("HERMES_LLM_MAX_RETRIES", "0")
    monkeypatch.setenv("HERMES_LLM_TIMEOUT", "1")
    monkeypatch.setenv("HERMES_LLM_RETRY_BASE", "0.01")
    monkeypatch.setenv("HERMES_LLM_CIRCUIT_FAIL_MAX", "1")
    cfg = _write_temp_config(tmp_path, "http://127.0.0.1:1")
    client = OpenAICompatibleClient(config_path=cfg)
    with pytest.raises(LLMUnavailable):
        client.chat([{"role": "user", "content": "hi"}])
