# hermes_agent.py 纯函数单测（无需网络/依赖，对应 CODE_REVIEW_STANDARD §4.1 测试要求）
from hermes_agent import (
    normalize_dialogue_output,
    get_card_transition_word,
    compile_card_prompt,
    summarize_document,
)


# ---------- normalize_dialogue_output ----------

def test_normalize_removes_think_block():
    out = normalize_dialogue_output("正常回答<think>我在思考</think>后续")
    assert "<think>" not in out
    assert "我在思考" not in out
    assert "正常回答" in out


def test_normalize_removes_asterisk_emphasis():
    out = normalize_dialogue_output("*点头* 你好呀")
    assert "*" not in out
    assert "你好呀" in out


def test_normalize_removes_action_parentheses():
    out = normalize_dialogue_output("你好（微笑）再见")
    assert "微笑" not in out
    assert "你好" in out and "再见" in out


def test_normalize_transition_word_exact_match():
    # 完全相等（含去尾标点）时只返回跳转词
    assert normalize_dialogue_output("下个阶段", "下个阶段") == "下个阶段"
    assert normalize_dialogue_output("下个阶段。", "下个阶段") == "下个阶段"


def test_normalize_transition_word_no_false_positive():
    # 文本包含跳转词但不是整句相等 -> 不误判为跳转
    out = normalize_dialogue_output("请进入下个阶段继续", "下个阶段")
    assert out != "下个阶段"
    assert "请进入下个阶段继续" in out


def test_normalize_length_limit():
    out = normalize_dialogue_output("字" * 250, limit=100)
    assert len(out) <= 100


# ---------- get_card_transition_word ----------

def test_get_card_transition_word_present():
    assert get_card_transition_word({"transition_word": "下一板块"}, "默认词") == "下一板块"


def test_get_card_transition_word_missing_falls_back():
    assert get_card_transition_word({}, "默认词") == "默认词"
    assert get_card_transition_word({"transition_word": "  "}, "默认词") == "默认词"


# ---------- compile_card_prompt ----------

def _card():
    return {
        "name": "阶段一：任务理解",
        "description": "引导学生明确目标",
        "max_rounds": 6,
        "evaluation_points": "说清背景与目标",
        "prompt": "引导学生完成任务理解",
        "transition_word": "",
    }


def test_compile_card_prompt_tutor_mode():
    tpl = compile_card_prompt(
        _card(),
        "下个阶段",
        metadata={"ai_role": "实训导师", "dialogue_mode": "tutor", "transition_rule_desc": "达成目标时"},
    )
    assert "实训导师" in tpl
    assert "下个阶段" in tpl
    assert "被动角色" not in tpl


def test_compile_card_prompt_passive_mode():
    tpl = compile_card_prompt(
        _card(),
        "下个阶段",
        metadata={"ai_role": "脑卒中患者李阿姨", "dialogue_mode": "passive", "transition_rule_desc": "学生问完时"},
    )
    assert "被动角色" in tpl
    assert "脑卒中患者李阿姨" in tpl


# ---------- summarize_document ----------

def test_summarize_empty_returns_default():
    out = summarize_document("")
    assert "导师提示词" in out  # 默认说明句


def test_summarize_truncates_long():
    out = summarize_document("A" * 600)
    assert len(out) <= 503  # 500 + "..."
    assert out.endswith("...")
