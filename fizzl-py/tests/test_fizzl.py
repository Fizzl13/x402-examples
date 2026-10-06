"""The checks against a stand-in session (no network, no money), and as LangChain tools."""
import json

import pytest

from fizzl import PRICES, Fizzl


class Resp:
    def __init__(self, status, body):
        self.status_code = status
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return json.loads(self.text)


class StandIn:
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def request(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        if isinstance(self.answers, Exception):
            raise self.answers
        path = url.split("://", 1)[1].split("/", 1)[1].split("?")[0]
        status, body = self.answers.get("/" + path, (404, {"error": "not found"}))
        return Resp(status, body)


def test_calls_the_right_api_sends_credit_keys_and_leaves_the_receipt_out():
    s = StandIn({"/v1/check": (200, {"verdict": "red", "reasons": [{"code": "known_drainer"}], "receipt": {"sig": "0x"}}),
                 "/v1/token": (200, {"verdict": "green"}), "/v1/approvals": (200, {"summary": {"toRevoke": 1}}),
                 "/api/v1/preflight": (200, {"verdict": "caution"})})
    f = Fizzl(session=s, credit_keys={"presign": "pk", "doctor": "dk"})
    assert f.check_before_signing(type="approval", chainId=8453, token="0xa", spender="0xb", amount="1") == {"verdict": "red", "reasons": [{"code": "known_drainer"}]}
    assert s.calls[0]["method"] == "POST" and s.calls[0]["url"] == "https://presign-guard.fizzl.eu/v1/check"
    assert s.calls[0]["headers"]["x-credit-key"] == "pk" and s.calls[0]["json"]["spender"] == "0xb" and "data" not in s.calls[0]["json"]
    f.check_token("solana", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")
    assert "/v1/token?chain=solana&address=Dez" in s.calls[1]["url"]
    f.check_wallet_approvals("base", "0x6B0F4651eD42893ab58139938175E4a69f175F25")
    assert "/v1/approvals?chain=base&address=0x6B0F" in s.calls[2]["url"]
    assert f.check_endpoint_before_paying("https://api.example.com/x", max_usd=0.05, network="eip155:8453")["verdict"] == "caution"
    assert s.calls[3]["url"] == "https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fapi.example.com%2Fx&max_usd=0.05&network=eip155%3A8453"
    assert s.calls[3]["headers"]["x-credit-key"] == "dk"


def test_failures_come_back_as_error_dicts():
    f = Fizzl(session=StandIn({"/v1/token": (402, {}), "/v1/check": (500, {"error": "boom"}), "/v1/approvals": (200, "not json")}))
    assert f.check_token("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")["error"] == "payment_required"
    assert f.check_before_signing(type="transaction", chainId=1, to="0x1") == {"error": "http_500", "message": "boom"}
    assert f.check_wallet_approvals("base", "0x6B0F4651eD42893ab58139938175E4a69f175F25")["error"] == "bad_response"
    assert Fizzl(session=StandIn(ConnectionError("down"))).check_endpoint_before_paying("https://a.example") == {"error": "check_failed", "message": "ConnectionError: down"}
    assert f.check_before_signing(type="approval", chainId=999)["error"] == "bad_input"
    assert f.check_token("dogechain", "x")["error"] == "bad_input"


def test_prices_cover_every_check():
    assert sorted(PRICES) == ["check_before_signing", "check_endpoint_before_paying", "check_token", "check_wallet_approvals"]


def test_langchain_tools_call_the_checks():
    pytest.importorskip("langchain_core")
    from fizzl.langchain import fizzl_tools
    s = StandIn({"/api/v1/preflight": (200, {"verdict": "no_go", "summary": "Do not pay: over budget."})})
    tools = fizzl_tools(session=s)
    assert [t.name for t in tools] == ["check_before_signing", "check_token", "check_wallet_approvals", "check_endpoint_before_paying"]
    pre = next(t for t in tools if t.name == "check_endpoint_before_paying")
    assert "BEFORE paying" in pre.description
    assert pre.invoke({"url": "https://api.example.com/x", "max_usd": 0.01})["verdict"] == "no_go"
    assert "max_usd=0.01" in s.calls[0]["url"]
    assert [t.name for t in fizzl_tools(session=s, only=["check_token"])] == ["check_token"]
    with pytest.raises(ValueError):
        fizzl_tools(session=s, only=["nope"])
