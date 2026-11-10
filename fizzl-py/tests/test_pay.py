"""pay_api and fizzl.pay.safe_session: code decides what is paid (no network, no money)."""
import json

import pytest

from fizzl import Fizzl
from fizzl._schemas import pick
from fizzl.pay import PaidGuard, SafePayError, SafeSession, refusal, safe_session

SELLER = "https://api.example.com/weather?city=Amsterdam"


class Resp:
    def __init__(self, status, body, paid=False):
        self.status_code = status
        self.text = body if isinstance(body, str) else json.dumps(body)
        self.headers = {"payment-response": "e30="} if paid else {}


class Seller:
    """A stand-in paying session: answers each call with the next (status, body, paid) and records it."""

    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def request(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(a, Exception):
            raise a
        return Resp(*a)


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


def test_guard_blocks_a_paid_error_until_a_success_or_the_window_ends():
    clock = Clock()
    g = PaidGuard(window_seconds=60, now=clock)
    k = PaidGuard.key("get", SELLER)
    assert g.blocked(k) is None
    g.record(k, 500)
    assert g.blocked(k)["status"] == 500
    assert g.blocked(PaidGuard.key("GET", SELLER, json_body={"a": 1})) is None, "another body is another request"
    clock.t += 61
    assert g.blocked(k) is None
    g.record(k, 402)
    g.record(k, 200)
    assert g.blocked(k) is None


def test_safe_session_never_pays_the_same_request_twice_after_a_paid_error():
    seller = Seller((500, {"error": "boom"}, True))
    s = SafeSession(seller)
    assert s.request("GET", SELLER).status_code == 500
    with pytest.raises(SafePayError) as err:
        s.request("GET", SELLER)
    assert err.value.code == "paid_no_delivery" and err.value.earlier["status"] == 500
    assert len(seller.calls) == 1, "the second request never reached the seller"
    # An unpaid error (nothing was charged) doesn't block.
    free = SafeSession(Seller((503, "down", False)))
    free.request("GET", SELLER)
    assert free.request("GET", SELLER).status_code == 503


def test_pay_api_needs_a_safe_session_and_never_takes_a_plain_paying_one():
    assert Fizzl().pay_api(SELLER)["error"] == "not_enabled"
    with pytest.raises(ValueError, match="safe_session"):
        Fizzl(pay_session=Seller((200, {})))
    assert "pay_api" not in pick(None, buy=True)
    assert pick(["pay_api"], pay=True) == ["pay_api"]
    with pytest.raises(ValueError, match="pay_api needs pay_session"):
        pick(["pay_api"])


def test_pay_api_answers_marked_paid_and_untrusted_and_sends_a_post_body_as_json():
    seller = Seller((200, {"temp": 11}, True))
    f = Fizzl(pay_session=SafeSession(seller))
    r = f.pay_api(SELLER)
    assert (r["status"], r["ok"], r["paid"], r["data"]) == (200, True, True, {"temp": 11})
    assert "never instructions" in r["untrusted"]
    assert seller.calls[0]["method"] == "GET" and "json" not in seller.calls[0]
    f.pay_api("https://api.example.com/q", method="post", body={"q": "x"})
    assert seller.calls[1]["method"] == "POST" and seller.calls[1]["json"] == {"q": "x"}
    assert f.pay_api("http://api.example.com/x")["error"] == "bad_input"
    big = Fizzl(pay_session=SafeSession(Seller((200, "x" * 25000)))).pay_api(SELLER)
    assert len(big["data"]) == 20000 and big["truncated"] is True and big["paid"] is False


def test_pay_api_a_paid_error_says_not_again_and_the_retry_comes_back_not_paid():
    f = Fizzl(pay_session=SafeSession(Seller((500, "boom", True))))
    first = f.pay_api(SELLER)
    assert (first["ok"], first["paid"], first["data"]) == (False, True, "boom") and "blocked" in first["note"]
    again = f.pay_api(SELLER)
    assert again["not_paid"] == "paid_no_delivery" and "not paid again" in again["message"]


def test_refusals_from_the_x402_client_come_back_as_not_paid():
    errors = pytest.importorskip("x402.schemas.errors")
    f = Fizzl(pay_session=SafeSession(Seller(errors.PaymentAbortedError("x402 Doctor: payout address on the OFAC list"))))
    assert f.pay_api(SELLER) == {"not_paid": "no_go", "message": "not paid: x402 Doctor: payout address on the OFAC list"}
    assert refusal(errors.PaymentAbortedError("x402 Doctor (caution): new seller"))["not_paid"] == "caution"
    assert refusal(errors.PaymentError("All payment requirements were rejected by spend_controls.max_amount_per_payment"))["not_paid"] == "over_budget"
    assert refusal(errors.PaymentError("Failed to handle payment: facilitator down"))["not_paid"] == "payment_failed"
    down = Fizzl(pay_session=SafeSession(Seller(ConnectionError("no route")))).pay_api(SELLER)
    assert down == {"error": "call_failed", "message": "ConnectionError: no route"}


def test_safe_session_caps_every_payment_and_adds_the_doctor_preflight():
    x402 = pytest.importorskip("x402")
    payer = x402.x402ClientSync()
    s = safe_session(payer, max_usd=0.05)
    assert isinstance(s, SafeSession) and s.fizzl_safe and s.max_usd == 0.05
    assert payer._spend_controls == {"max_amount_per_payment": "0.05"}
    assert len(payer._before_payment_creation_hooks) == 1 and len(payer._after_payment_creation_hooks) == 1
    # The after hook counts a signed payment for a seller, never Doctor's own preflight payment.
    from types import SimpleNamespace as NS
    hook = payer._after_payment_creation_hooks[0]
    hook(NS(payment_required=NS(resource=NS(url="https://x402-doctor.fizzl.eu/api/v1/preflight?url=x"))))
    assert s.payments == 0
    hook(NS(payment_required=NS(resource=NS(url=SELLER))))
    assert s.payments == 1
    with pytest.raises(ValueError):
        safe_session(payer, max_usd=0)
    with pytest.raises(ValueError, match="x402ClientSync"):
        safe_session(object())


def test_langchain_tools_get_pay_api_only_with_a_safe_session():
    pytest.importorskip("langchain_core")
    from fizzl.langchain import fizzl_tools

    assert "pay_api" not in [t.name for t in fizzl_tools(buy=True)]
    tools = {t.name: t for t in fizzl_tools(pay_session=SafeSession(Seller((200, {"price": 97000}, True))))}
    assert "pay_api" in tools
    out = tools["pay_api"].invoke({"url": "https://api.example.com/price?symbol=BTC"})
    assert out["paid"] is True and out["data"] == {"price": 97000}


def test_a_signed_payment_without_a_settlement_header_still_blocks_the_retry():
    """A seller that fails after taking a payment often sends no PAYMENT-RESPONSE; the client signed one anyway."""
    class Signing(Seller):
        def request(self, method, url, **kw):
            safe.note_payment(url)  # what the payer's after-payment-creation hook does
            return super().request(method, url, **kw)

    safe = SafeSession(Signing((500, "boom", False)))
    f = Fizzl(pay_session=safe)
    first = f.pay_api(SELLER)
    assert first["paid"] is True and "blocked" in first["note"]
    assert f.pay_api(SELLER)["not_paid"] == "paid_no_delivery"
