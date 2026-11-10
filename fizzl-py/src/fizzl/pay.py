"""Pay any x402 API the safe way: code decides what is paid, not the model.

    import requests
    from x402 import x402ClientSync
    from fizzl import Fizzl
    from fizzl.pay import safe_session

    payer = x402ClientSync()                           # register an EVM scheme with a wallet just for the agent
    pay = safe_session(payer, max_usd=0.05)            # per payment; the model can't raise it
    fizzl = Fizzl(session=pay, pay_session=pay)
    fizzl.pay_api("https://api.example.com/weather?city=Amsterdam")

``safe_session`` sets up three things on the official x402 Python client:

- the budget: the client's own spend controls cap every payment at ``max_usd`` (and only known dollar tokens);
- an x402 Doctor preflight before each payment (``fizzl.hook.doctor_preflight``): only a go is paid, a caution
  stops unless ``on_caution`` says otherwise, a no_go never pays;
- never paid twice for nothing: a request (method, URL and body) that was paid and answered with an error is not
  paid again for 30 minutes (``SafePayError`` with code ``paid_no_delivery``); a success clears it.

The agent's ``pay_api`` tool only works with a session from here: with a plain paying session the model would
decide what to pay. In our wallet exam the same model scored 65 on its own and 96 when code decided the payment.
"""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Any, Callable, Iterable, Optional, Union

from .hook import DOCTOR_URL, Decision, doctor_preflight

PAID_ERROR_SECONDS = 30 * 60


class SafePayError(Exception):
    """A payment the safe session refused. ``code``: "paid_no_delivery"; ``earlier``: {at, status}."""

    def __init__(self, message: str, code: str, earlier: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.earlier = earlier


def _body_key(data: Any = None, json_body: Any = None) -> str:
    """A short, stable fingerprint of the body (FNV-1a, 32 bit), the same as x402-safe-fetch's: no request content."""
    import json as _json

    if json_body is not None:
        text = _json.dumps(json_body, separators=(",", ":"), sort_keys=True)
    elif data is None:
        return ""
    elif isinstance(data, bytes):
        text = data.decode("utf-8", "replace")
    else:
        text = str(data)
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{len(text)}:{h:x}"


class PaidGuard:
    """Remembers each paid request whose answer was not a success, and blocks paying it again within the window."""

    def __init__(self, window_seconds: float = PAID_ERROR_SECONDS, now: Callable[[], float] = time.time):
        self.window, self.now, self.failed = window_seconds, now, {}

    @staticmethod
    def key(method: str, url: str, data: Any = None, json_body: Any = None) -> str:
        return f"{str(method).upper()} {url} {_body_key(data, json_body)}"

    def blocked(self, key: str) -> Optional[dict]:
        t = self.now()
        for k in [k for k, v in self.failed.items() if t - v["at"] >= self.window]:
            del self.failed[k]
        return self.failed.get(key)

    def record(self, key: str, status: int) -> None:
        if 200 <= int(status) < 300:
            self.failed.pop(key, None)
        else:
            self.failed[key] = {"at": self.now(), "status": int(status)}
            while len(self.failed) > 1000:
                self.failed.pop(next(iter(self.failed)))

    def clear(self, key: str) -> None:
        self.failed.pop(key, None)


def _paid(response: Any) -> bool:
    headers = getattr(response, "headers", None) or {}
    return bool(headers.get("payment-response") or headers.get("PAYMENT-RESPONSE") or headers.get("x-payment-response") or headers.get("X-PAYMENT-RESPONSE"))


class SafeSession:
    """A requests-like session that pays x402 the safe way (see the module docs). Made by ``safe_session``."""

    fizzl_safe = True

    def __init__(self, session: Any, guard: Optional[PaidGuard] = None, max_usd: Optional[float] = None,
                 doctor_url: str = DOCTOR_URL):
        self.session = session
        self.guard = guard or PaidGuard()
        self.max_usd = max_usd
        self._doctor_host = (doctor_url.split("://", 1)[-1].split("/", 1)[0]).lower()
        self.payments = 0  # payments the x402 client created for sellers (not for Doctor's preflight)

    def note_payment(self, url: Optional[str]) -> None:
        """Called by the payer's after-payment-creation hook: a payment was signed for ``url``."""
        host = str(url or "").split("://", 1)[-1].split("/", 1)[0].lower()
        if host != self._doctor_host:
            self.payments += 1

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        key = PaidGuard.key(method, url, kwargs.get("data"), kwargs.get("json"))
        earlier = self.guard.blocked(key)
        if earlier:
            at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(earlier["at"]))
            raise SafePayError(f"not paid again: {url} was already paid at {at} and answered HTTP {earlier['status']} without delivering. "
                               "Paying the same request again would most likely be charged again for nothing; ask the seller, or try a different request.",
                               "paid_no_delivery", earlier)
        before = self.payments
        response = self.session.request(method, url, **kwargs)
        # Paid: the seller's answer carries a settlement, or the client signed a payment for it (a seller that fails
        # after taking a payment often sends no settlement header).
        paid = _paid(response) or self.payments > before
        try:
            response.fizzl_paid = paid
        except Exception:  # pragma: no cover - a response that takes no attributes
            pass
        if paid:
            self.guard.record(key, response.status_code)
        return response

    def get(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self.request("POST", url, **kwargs)


def safe_session(payer: Any, *, max_usd: float = 0.05, on_caution: Decision = "stop", credit_key: Optional[str] = None,
                 trusted: Iterable[str] = (), session: Any = None, guard: Optional[PaidGuard] = None) -> SafeSession:
    """A paying session for ``x402ClientSync`` ``payer`` where code decides what is paid: every payment at most
    ``max_usd`` (the client's spend controls), an x402 Doctor preflight before each one ($0.001, or ``credit_key``
    credits; ``on_caution``: "stop", "pay" or a function of the preflight), and never the same request twice after a
    paid answer that wasn't a success. ``session``: the requests.Session to wrap (default a new one); ``trusted``:
    your own hosts, paid without a preflight. The payer's spend controls are replaced by the ``max_usd`` cap."""
    try:
        import requests
        from x402.http.clients import wrapRequestsWithPayment
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.pay needs the x402 SDK: pip install 'fizzl[x402]'") from err
    if not isinstance(max_usd, (int, float)) or max_usd <= 0:
        raise ValueError("max_usd must be a positive number of dollars")
    if not hasattr(payer, "set_spend_controls"):
        raise ValueError("payer must be an x402ClientSync from x402 2.27 or newer (it needs spend controls)")
    payer.set_spend_controls({"max_amount_per_payment": format(Decimal(str(max_usd)), "f")})
    wrapped = wrapRequestsWithPayment(session or requests.Session(), payer)
    safe = SafeSession(wrapped, guard, max_usd)
    # Doctor's own 402 (the preflight, $0.001) is paid through the same session; the hook never checks it again.
    payer.on_before_payment_creation(doctor_preflight(session=wrapped, credit_key=credit_key, max_usd=max_usd,
                                                      on_caution=on_caution, trusted=trusted))

    def created(context: Any) -> None:
        required = getattr(context, "payment_required", None)
        resource = getattr(required, "resource", None)
        url = resource if isinstance(resource, str) else getattr(resource, "url", None)
        if not url:
            url = getattr(getattr(context, "selected_requirements", None), "resource", None)  # x402 v1
        safe.note_payment(url)

    payer.on_after_payment_creation(created)
    return safe


def refusal(err: BaseException) -> Union[dict, None]:
    """A refused or failed payment as ``{not_paid, message}`` for the model, or None when ``err`` is something else."""
    name = type(err).__name__
    message = str(getattr(err, "reason", None) or err)[:400]
    if isinstance(err, SafePayError):
        return {"not_paid": err.code, "message": message}
    if name == "PaymentAbortedError":
        code = "caution" if "(caution)" in message else "incomplete" if "not every check ran" in message else \
            "preflight_failed" if "preflight failed" in message else "no_go"
        return {"not_paid": code, "message": f"not paid: {message}"}
    if "spend_controls" in message or "max_amount_per_payment" in message:
        return {"not_paid": "over_budget", "message": "not paid: every payment option costs more than the budget per call, or is in a token the budget doesn't cover"}
    if name in ("PaymentError", "NoMatchingRequirementsError", "SchemeNotFoundError") or any(c.__name__ == "PaymentError" for c in type(err).__mro__):
        return {"not_paid": "payment_failed", "message": f"not paid: {message}"}
    return None
