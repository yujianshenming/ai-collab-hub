# -*- coding: utf-8 -*-
"""polymas_grade_engine 评分解析纯函数单测：extract_scores / _parse_llm_json_object / dim_score。"""
import json

from polymas_grade_engine import _parse_llm_json_object, dim_score, extract_scores

EMPTY_RESULT = {"total": None, "items": {}, "overall_comment": None, "raw_names": [], "max_items": {}}


# ---------------------------------------------------------------- extract_scores

class TestExtractScores:
    def test_no_artifacts_returns_defaults(self):
        assert extract_scores({}) == EMPTY_RESULT
        assert extract_scores({"data": {"artifacts": []}}) == EMPTY_RESULT

    def _payload(self, data_part):
        return {"data": {"artifacts": [{"parts": [{"data": data_part}]}]}}

    def test_dict_data_part_full(self):
        data = {
            "totalScore": 87.5,
            "overallComment": "写得不错",
            "questionScores": [
                {"name": "选择题", "score": 40, "totalScore": 50},
                {"name": "问答题", "score": 47.5, "totalScore": 50},
            ],
        }
        out = extract_scores(self._payload(data))
        assert out["total"] == 87.5
        assert out["overall_comment"] == "写得不错"
        assert out["items"] == {"选择题": 40.0, "问答题": 47.5}
        assert out["max_items"] == {"选择题": 50.0, "问答题": 50.0}
        assert out["raw_names"] == ["选择题", "问答题"]

    def test_json_string_data_part(self):
        data = json.dumps({"totalScore": 60, "questionScores": []})
        out = extract_scores(self._payload(data))
        assert out["total"] == 60.0

    def test_invalid_json_string_returns_defaults(self):
        assert extract_scores(self._payload("not-json{")) == EMPTY_RESULT

    def test_non_dict_data_part_returns_defaults(self):
        assert extract_scores(self._payload([1, 2, 3])) == EMPTY_RESULT

    def test_artifact_without_parts_falls_back_to_artifact_itself(self):
        payload = {"data": {"artifacts": [{"totalScore": 33}]}}
        assert extract_scores(payload)["total"] == 33.0

    def test_total_score_aliases(self):
        assert extract_scores(self._payload({"total_score": 71}))["total"] == 71.0
        assert extract_scores(self._payload({"finalScore": 72}))["total"] == 72.0

    def test_total_summed_from_items_when_missing(self):
        data = {"questionScores": [{"name": "A", "score": 10}, {"name": "B", "score": 20}]}
        out = extract_scores(self._payload(data))
        assert out["total"] == 30.0

    def test_unnamed_and_non_dict_question_entries(self):
        data = {"questionScores": ["junk", {"score": 5}]}
        out = extract_scores(self._payload(data))
        # 非 dict 条目跳过；无名条目按位置命名 Q2
        assert out["raw_names"] == ["Q2"]
        assert out["items"] == {"Q2": 5.0}

    def test_non_numeric_scores_ignored(self):
        data = {"totalScore": "90", "questionScores": [{"name": "A", "score": "bad"}]}
        out = extract_scores(self._payload(data))
        assert out["total"] is None  # 字符串 totalScore 不接受，且 items 为空
        assert out["items"] == {}
        assert out["raw_names"] == ["A"]


# ---------------------------------------------------------------- _parse_llm_json_object

class TestParseLlmJsonObject:
    def test_plain_json(self):
        assert _parse_llm_json_object('{"a": 1}') == {"a": 1}

    def test_fenced_json_block(self):
        text = '前置说明\n```json\n{"题1": "答案"}\n```\n后置说明'
        assert _parse_llm_json_object(text) == {"题1": "答案"}

    def test_fence_without_language_tag(self):
        assert _parse_llm_json_object('```\n{"k": 2}\n```') == {"k": 2}

    def test_braces_embedded_in_prose(self):
        assert _parse_llm_json_object('结果如下：{"x": true} 完毕') == {"x": True}

    def test_non_dict_json_returns_empty(self):
        assert _parse_llm_json_object("[1, 2]") == {}

    def test_empty_and_garbage(self):
        assert _parse_llm_json_object("") == {}
        assert _parse_llm_json_object(None) == {}
        assert _parse_llm_json_object("完全不是 JSON") == {}
        assert _parse_llm_json_object("{broken: ") == {}


# ---------------------------------------------------------------- dim_score

class TestDimScore:
    def test_keys_none_uses_total(self):
        assert dim_score({}, None, 88) == 88.0
        assert dim_score({}, None, 12.5) == 12.5

    def test_keys_none_non_numeric_total(self):
        assert dim_score({}, None, None) is None
        assert dim_score({}, None, "90") is None

    def test_sums_matching_keys(self):
        items = {"选择题": 30.0, "问答题": 45.5, "判断题": 10}
        assert dim_score(items, ["选择题", "问答题"], None) == 75.5

    def test_partial_match_still_sums(self):
        assert dim_score({"A": 5.0}, ["A", "缺失"], None) == 5.0

    def test_no_matching_keys_returns_none(self):
        assert dim_score({"A": 5.0}, ["B", "C"], 100) is None

    def test_non_numeric_values_ignored(self):
        assert dim_score({"A": "bad", "B": 3}, ["A", "B"], None) == 3.0
        assert dim_score({"A": "bad"}, ["A"], None) is None
