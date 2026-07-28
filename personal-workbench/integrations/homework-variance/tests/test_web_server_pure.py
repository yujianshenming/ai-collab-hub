# -*- coding: utf-8 -*-
"""web_server 纯函数单测：parse_homework_url / extract_user_nid 及其回退链。"""
import base64
import json

import pytest

from web_server import (
    _parse_loose_json,
    decode_jwt_payload,
    extract_jwt,
    extract_user_nid,
    parse_homework_url,
)


def make_jwt(payload: dict) -> str:
    """构造无签名校验需求的假 JWT（header.payload.signature）。"""
    def seg(obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    return f"{seg({'alg': 'none'})}.{seg(payload)}.sig"


# ---------------------------------------------------------------- parse_homework_url

class TestParseHomeworkUrl:
    def test_query_params_extracted(self):
        url = ("https://hike-teaching-center.polymas.com/x/page"
               "?instanceNid=inst-001&agentId=ag-9&libraryId=lib-3&courseId=c-77")
        out = parse_homework_url(url)
        assert out["instance_nid"] == "inst-001"
        assert out["agent_id"] == "ag-9"
        assert out["library_id"] == "lib-3"
        assert out["course_id"] == "c-77"
        assert out["raw"] == url

    def test_instance_id_alias(self):
        out = parse_homework_url("https://x.com/p?instanceId=abc123")
        assert out["instance_nid"] == "abc123"

    def test_course_id_from_resource_path(self):
        out = parse_homework_url("https://x.com/course99/resource/paper/create?instanceNid=n1")
        assert out["course_id"] == "course99"
        assert out["instance_nid"] == "n1"

    def test_course_id_from_agent_review_path(self):
        out = parse_homework_url("https://x.com/course42/agent-review?agentId=a1")
        assert out["course_id"] == "course42"

    def test_query_course_id_wins_over_path(self):
        out = parse_homework_url("https://x.com/pathCourse/resource/x?courseId=queryCourse")
        assert out["course_id"] == "queryCourse"

    def test_bare_instance_nid(self):
        out = parse_homework_url("  AbC-12345_xy  ")
        assert out["instance_nid"] == "AbC-12345_xy"
        assert out["raw"] == "AbC-12345_xy"

    def test_bare_token_too_short_ignored(self):
        assert parse_homework_url("abc12")["instance_nid"] is None

    @pytest.mark.parametrize("url", ["", "   ", None if False else ""])
    def test_empty_input_returns_defaults(self, url):
        out = parse_homework_url(url)
        assert out == {
            "course_id": None,
            "instance_nid": None,
            "agent_id": None,
            "library_id": None,
            "raw": url.strip(),
        }


# ---------------------------------------------------------------- extract_jwt / helpers

class TestJwtHelpers:
    def test_extract_jwt_bearer_prefix(self):
        assert extract_jwt("Bearer  tok.abc.def ") == "tok.abc.def"

    def test_extract_jwt_from_ai_poly_cookie(self):
        cookie = 'sid=1; ai-poly="aaa.bbb.ccc"; other=2'
        assert extract_jwt(cookie) == "aaa.bbb.ccc"

    def test_extract_jwt_finds_token_with_trailing_junk(self):
        # 整串非严格 JWT（末尾杂质）时，取第一个 eyJ 开头的 JWT 形态片段
        tok = make_jwt({"x": 1})
        assert extract_jwt(f"{tok}!!") == tok

    def test_extract_jwt_free_text_with_space_prefix_returned_as_is(self):
        # 首个点段含空格时不做提取，原样返回
        tok = make_jwt({"x": 1})
        raw = f"Authorization: {tok}"
        assert extract_jwt(raw) == raw

    def test_decode_jwt_payload_roundtrip(self):
        assert decode_jwt_payload(make_jwt({"userNid": "u1"})) == {"userNid": "u1"}

    def test_decode_jwt_payload_invalid(self):
        assert decode_jwt_payload("not-a-jwt") is None
        assert decode_jwt_payload("a.!!bad-base64!!.c") is None

    def test_parse_loose_json_url_encoded(self):
        raw = "%7B%22nid%22%3A%22abc%22%7D"  # {"nid":"abc"}
        assert _parse_loose_json(raw) == {"nid": "abc"}

    def test_parse_loose_json_single_quotes(self):
        assert _parse_loose_json("{'nid': 'abc'}") == {"nid": "abc"}

    def test_parse_loose_json_garbage(self):
        assert _parse_loose_json("") is None
        assert _parse_loose_json("not json at all") is None
        assert _parse_loose_json("[1,2,3]") is None  # 非 dict


# ---------------------------------------------------------------- extract_user_nid 回退链

class TestExtractUserNid:
    # 1) 显式填写优先级最高
    def test_explicit_wins_over_everything(self):
        jwt = make_jwt({"userNid": "from-jwt"})
        nid, src = extract_user_nid(jwt=jwt, cookie="x=1", explicit="  manual-01 ")
        assert (nid, src) == ("manual-01", "form")

    # 2) JWT payload 直接字段
    def test_jwt_user_nid_key(self):
        nid, src = extract_user_nid(jwt=make_jwt({"userNid": "stu-abc"}))
        assert (nid, src) == ("stu-abc", "jwt.userNid")

    def test_jwt_login_id_key(self):
        nid, src = extract_user_nid(jwt=make_jwt({"loginId": "log-in-9"}))
        assert (nid, src) == ("log-in-9", "jwt.loginId")

    def test_jwt_pure_digit_user_nid_still_accepted_for_usernid_key(self):
        # userNid 即使纯数字也走第二分支返回
        nid, src = extract_user_nid(jwt=make_jwt({"userNid": "12345678"}))
        assert (nid, src) == ("12345678", "jwt.userNid")

    def test_jwt_pure_digit_user_nid_snake_key_rejected(self):
        # user_nid 纯数字：两个分支都不命中 → 落空返回 ("", "")
        assert extract_user_nid(jwt=make_jwt({"user_nid": "12345678"})) == ("", "")

    def test_jwt_nested_user_info(self):
        jwt = make_jwt({"userInfo": {"nid": "nested-nid"}})
        assert extract_user_nid(jwt=jwt) == ("nested-nid", "jwt.userInfo.nid")

    # 3) Cookie 内的 ai-poly JWT 优先于 UINFO cookie
    def test_jwt_inside_cookie_beats_uinfo_cookie(self):
        tok = make_jwt({"userNid": "cookie-jwt-nid"})
        cookie = f'ai-poly={tok}; AI-POLY-UINFO=%7B%22nid%22%3A%22uinfo-nid%22%7D'
        nid, src = extract_user_nid(cookie=cookie)
        assert (nid, src) == ("cookie-jwt-nid", "jwt.userNid")

    # 4) Cookie map: AI-POLY-UINFO / CASLOGC
    def test_cookie_uinfo_url_encoded(self):
        cookie = "sid=1; AI-POLY-UINFO=%7B%22nid%22%3A%22uinfo-nid%22%7D"
        nid, src = extract_user_nid(cookie=cookie)
        assert (nid, src) == ("uinfo-nid", "cookie.AI-POLY-UINFO.nid")

    def test_cookie_caslogc_nid(self):
        cookie = 'CASLOGC=%7B%22nid%22%3A%22cas-nid%22%2C%22uuid%22%3A%22u-u-i-d%22%7D'
        nid, src = extract_user_nid(cookie=cookie)
        assert (nid, src) == ("cas-nid", "cookie.CASLOGC.nid")

    def test_cookie_caslogc_uuid_never_used(self):
        cookie = 'CASLOGC=%7B%22uuid%22%3A%22uuid-only-1%22%7D'
        assert extract_user_nid(cookie=cookie) == ("", "")

    # 5) 正则兜底
    def test_cookie_regex_fallback(self):
        cookie = 'blob={"foo":1,"userNid":"regex-nid-1"}'
        nid, src = extract_user_nid(cookie=cookie)
        assert (nid, src) == ("regex-nid-1", "cookie.regex")

    def test_cookie_regex_requires_min_length(self):
        # 少于 6 位不匹配兜底正则
        assert extract_user_nid(cookie='x={"nid":"ab1"}') == ("", "")

    def test_jwt_regex_fallback(self):
        raw = 'some text "nid": "jwt-regex-9" more'
        nid, src = extract_user_nid(jwt=raw)
        assert (nid, src) == ("jwt-regex-9", "jwt.regex")

    # 6) 错误路径
    def test_all_empty_returns_blank(self):
        assert extract_user_nid() == ("", "")

    def test_malformed_jwt_and_cookie(self):
        assert extract_user_nid(jwt="a.b", cookie="garbage;;=;") == ("", "")

    def test_jwt_payload_not_dict(self):
        seg = base64.urlsafe_b64encode(b"[1,2]").rstrip(b"=").decode()
        assert extract_user_nid(jwt=f"h.{seg}.s") == ("", "")
