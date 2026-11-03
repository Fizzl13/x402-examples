"""x402 Doctor's preflight as a hook on the official x402 Python client (no network, no money)."""
import json
from types import SimpleNamespace as NS

import pytest

from fizzl.hook import doctor_preflight

AbortResult = pytest.importorskip("x402.schemas").AbortResult

SELLER = "https://api.example.com/paid"


class Resp:
    def __init__(self, status, body):
        self.status_code, self.text = status, json.dumps(body)

    def json(self):
        return json.loads(self.text)


class Doctor:
    """A session that answers Doctor's preflight with `verdict` and records each call."""

    def __init__(self, verdict="go", status=200, **extra):
        self.verdict, self.status, self.extra, self.calls = verdict, status, extra, []

    def request(self, method, url, **kw):
        self.calls.append(url)
        return Resp(self.status, {"verdict": self.verdict, "summary": f"{self.verdict} summary", **self.extra} if self.status == 200 else {"error": "boom"})


def ctx(url=SELLER, amount="10000", pay_to="0x1111111111111111111111111111111111111111"):
    req = NS(scheme="exact", network="eip155:8453", asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount=amount, pay_to=pay_to)
    return NS(payment_required=NS(resource=NS(url=url), accepts=[req]), selected_requirements=req)


def test_go_lets_the_payment_through_and_asks_with_url_network_and_budget():
    d = Doctor("go")
    assert doctor_preflight(d, max_usd=0.05)(ctx()) is None
    assert "url=https%3A%2F%2Fapi.example.com%2Fpaid" in d.calls[0] and "max_usd=0.05" in d.calls[0] and "network=eip155%3A8453" in d.calls[0]


def test_no_go_aborts_caution_aborts_unless_on_caution_pays():
    out = doctor_preflight(Doctor("no_go"))(ctx())
    assert isinstance(out, AbortResult) and out.reason == "x402 Doctor: no_go summary"
    assert isinstance(doctor_preflight(Doctor("caution"))(ctx()), AbortResult)
    assert doctor_preflight(Doctor("caution"), on_caution="pay")(ctx()) is None
    assert doctor_preflight(Doctor("caution"), on_caution=lambda p: p["verdict"] == "caution")(ctx()) is None


def test_incomplete_go_pays_by_default_and_stops_on_request():
    assert doctor_preflight(Doctor("go", checks_complete=False))(ctx()) is None
    out = doctor_preflight(Doctor("go", checks_complete=False), on_incomplete="stop")(ctx())
    assert isinstance(out, AbortResult) and "not every check ran" in out.reason


def test_verdict_reused_while_the_402_asks_the_same_thing():
    d = Doctor("go")
    hook = doctor_preflight(d)
    hook(ctx()); hook(ctx())
    assert len(d.calls) == 1
    hook(ctx(amount="20000")); hook(ctx(pay_to="0x2222222222222222222222222222222222222222"))
    assert len(d.calls) == 3


def test_doctors_own_402_is_skipped_and_capped_trusted_hosts_skip_the_check():
    d = Doctor("go")
    hook = doctor_preflight(d, trusted=["api.example.com"])
    assert hook(ctx("https://x402-doctor.fizzl.eu/api/v1/preflight?url=x", amount="1000")) is None
    assert "more than $0.002" in hook(ctx("https://x402-doctor.fizzl.eu/api/v1/preflight?url=x", amount="50000")).reason
    assert hook(ctx()) is None
    assert d.calls == []


def test_a_failing_doctor_stops_the_payment_unless_on_error_pays():
    out = doctor_preflight(Doctor(status=503), fizzl=None)(ctx())
    assert isinstance(out, AbortResult) and "preflight failed" in out.reason
    assert doctor_preflight(Doctor(status=503), on_error="pay")(ctx()) is None
    with pytest.raises(ValueError):
        doctor_preflight(Doctor(), on_error="maybe")


def test_on_a_real_x402_client_a_no_go_aborts_before_the_scheme_signs():
    x402 = pytest.importorskip("x402")
    from x402.schemas import PaymentAbortedError, PaymentRequired, PaymentRequirements, ResourceInfo

    signed = []

    class Scheme:
        scheme = "exact"

        def create_payment_payload(self, requirements):
            signed.append(requirements)
            return {"signature": "0x"}

    reqs = PaymentRequirements(scheme="exact", network="eip155:8453", asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount="10000", pay_to="0x1111111111111111111111111111111111111111", max_timeout_seconds=60, extra={})
    required = PaymentRequired(x402_version=2, resource=ResourceInfo(url=SELLER, description="x", mime_type="application/json"), accepts=[reqs])
    client = x402.x402ClientSync().register("eip155:8453", Scheme())
    client.set_spend_controls(False) if hasattr(client, "set_spend_controls") else None
    client.on_before_payment_creation(doctor_preflight(Doctor("no_go")))
    with pytest.raises(PaymentAbortedError):
        client.create_payment_payload(required)
    assert signed == []
