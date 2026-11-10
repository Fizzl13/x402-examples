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
  paid again for 30 minutes (``SafePayError`` with code ``paid_no_delivery``); a success clears it;
- optionally a budget for the whole task: ``max_total_usd`` for every payment of the session together and
  ``max_per_seller_usd`` per seller (host). A seller that splits its answer over many cheap calls stays under the
  per-payment cap every time; these stop it (not paid: ``over_total_budget`` / ``over_seller_budget``), before the
  preflight is bought. ``session.spent()`` says what was paid.

The agent's ``pay_api`` tool only works with a session from here: with a plain paying session the model would
decide what to pay. In our wallet exam the same model scored 65 on its own and 96 when code decided the payment.
"""
from __future__ import annotations

import threading
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


def _host(url: Any) -> str:
    return str(url or "").split("://", 1)[-1].split("/", 1)[0].lower()


def usd_of(requirements: Any) -> Optional[float]:
    """What a payment option costs in US dollars, or None when it can't be read: RLUSD on the XRP Ledger is in decimal
    dollars, Circle's USDC on Stellar has 7 decimals, USDC elsewhere 6 (the dollar tokens the spend controls let through)."""
    get = (lambda k: requirements.get(k)) if isinstance(requirements, dict) else (lambda k: getattr(requirements, k, None))
    raw = str(get("amount") or get("max_amount_required") or get("maxAmountRequired") or "")
    network = str(get("network") or "")
    try:
        if network.startswith("xrpl:"):
            return float(Decimal(raw))
        if not raw.isdigit():
            return None
        return int(raw) / (10 ** 7 if network.startswith("stellar:") else 10 ** 6)
    except Exception:
        return None


def _paid(response: Any) -> bool:
    headers = getattr(response, "headers", None) or {}
    return bool(headers.get("payment-response") or headers.get("PAYMENT-RESPONSE") or headers.get("x-payment-response") or headers.get("X-PAYMENT-RESPONSE"))


class SafeSession:
    """A requests-like session that pays x402 the safe way (see the module docs). Made by ``safe_session``."""

    fizzl_safe = True

    def __init__(self, session: Any, guard: Optional[PaidGuard] = None, max_usd: Optional[float] = None,
                 doctor_url: str = DOCTOR_URL, max_total_usd: Optional[float] = None,
                 max_per_seller_usd: Optional[float] = None):
        self.session = session
        self.guard = guard or PaidGuard()
        self.max_usd = max_usd
        self.max_total_usd = max_total_usd
        self.max_per_seller_usd = max_per_seller_usd
        self._doctor_host = _host(doctor_url)
        self.payments = 0  # payments the x402 client created for sellers (not for Doctor's preflight)
        self._lock = threading.Lock()
        self._total = 0.0
        self._by_seller: dict = {}
        self._held: dict = {}  # url -> amounts counted for payments being made (taken back if nothing was paid)

    def note_payment(self, url: Optional[str]) -> None:
        """Called by the payer's after-payment-creation hook: a payment was signed for ``url``."""
        if _host(url) != self._doctor_host:
            self.payments += 1

    def spent(self) -> dict:
        """What this session paid to sellers, in US dollars (Doctor's preflights not included)."""
        with self._lock:
            return {"total_usd": round(self._total, 6), "by_seller": {k: round(v, 6) for k, v in self._by_seller.items()}}

    def budget_check(self, url: Optional[str], usd: Optional[float], hold: bool = False) -> Optional[str]:
        """None when a payment of ``usd`` to ``url`` fits the total and per-seller budgets (with ``hold``, it is counted
        right away); otherwise why not, starting with its code. An unreadable price counts as ``max_usd``."""
        if (self.max_total_usd is None and self.max_per_seller_usd is None) or _host(url) == self._doctor_host:
            return None
        price = usd if usd is not None else self.max_usd
        host = _host(url)
        with self._lock:
            total_left = float("inf") if self.max_total_usd is None else round(self.max_total_usd - self._total, 6)
            seller_left = float("inf") if self.max_per_seller_usd is None else round(self.max_per_seller_usd - self._by_seller.get(host, 0.0), 6)
            left = min(total_left, seller_left)
            if left <= 0 or (price is not None and price > left + 1e-9):
                by_total = total_left <= seller_left
                which = f"the total budget (${self.max_total_usd})" if by_total else f"the budget for {host} (${self.max_per_seller_usd})"
                paid = self._total if by_total else self._by_seller.get(host, 0.0)
                asks = f"; the endpoint asks ${round(price, 6)}" if price is not None else ""
                return f"{'over_total_budget' if by_total else 'over_seller_budget'}: {which} has ${max(0.0, left)} left{asks} (already paid ${round(paid, 6)})"
            if hold and price is not None:
                self._total += price
                self._by_seller[host] = self._by_seller.get(host, 0.0) + price
                self._held.setdefault(str(url), []).append(price)
        return None

    def release(self, url: Optional[str]) -> None:
        """Takes back the last amount counted for ``url``: nothing was paid after all."""
        with self._lock:
            held = self._held.get(str(url))
            if not held:
                return
            price = held.pop()
            host = _host(url)
            self._total = max(0.0, self._total - price)
            self._by_seller[host] = max(0.0, self._by_seller.get(host, 0.0) - price)

    def _unhold_unsigned(self, url: Optional[str], payments_before: int, held_before: int) -> None:
        # Counted, then nothing signed (a later hook stopped it): take it back.
        if self.payments == payments_before and len(self._held.get(str(url), ())) > held_before:
            self.release(url)

    def _settled(self, url: Optional[str]) -> None:
        with self._lock:
            held = self._held.get(str(url))
            if held:
                held.pop(0)

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        key = PaidGuard.key(method, url, kwargs.get("data"), kwargs.get("json"))
        earlier = self.guard.blocked(key)
        if earlier:
            at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(earlier["at"]))
            raise SafePayError(f"not paid again: {url} was already paid at {at} and answered HTTP {earlier['status']} without delivering. "
                               "Paying the same request again would most likely be charged again for nothing; ask the seller, or try a different request.",
                               "paid_no_delivery", earlier)
        before = self.payments
        held = len(self._held.get(str(url), ()))
        try:
            response = self.session.request(method, url, **kwargs)
        except Exception:
            self._unhold_unsigned(url, before, held)
            raise
        # Paid: the seller's answer carries a settlement, or the client signed a payment for it (a seller that fails
        # after taking a payment often sends no settlement header).
        paid = _paid(response) or self.payments > before
        try:
            response.fizzl_paid = paid
        except Exception:  # pragma: no cover - a response that takes no attributes
            pass
        if self.payments > before:
            # A payment answered with another 402 wasn't taken; any other answer was (a paid error included).
            (self.release if int(response.status_code) == 402 else self._settled)(url)
        else:
            self._unhold_unsigned(url, before, held)
        if paid:
            self.guard.record(key, response.status_code)
        return response

    def get(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self.request("POST", url, **kwargs)


def safe_session(payer: Any, *, max_usd: float = 0.05, on_caution: Decision = "stop", credit_key: Optional[str] = None,
                 trusted: Iterable[str] = (), session: Any = None, guard: Optional[PaidGuard] = None,
                 max_total_usd: Optional[float] = None, max_per_seller_usd: Optional[float] = None) -> SafeSession:
    """A paying session for ``x402ClientSync`` ``payer`` where code decides what is paid: every payment at most
    ``max_usd`` (the client's spend controls), an x402 Doctor preflight before each one ($0.001, or ``credit_key``
    credits; ``on_caution``: "stop", "pay" or a function of the preflight), and never the same request twice after a
    paid answer that wasn't a success. ``session``: the requests.Session to wrap (default a new one); ``trusted``:
    your own hosts, paid without a preflight. The payer's spend controls are replaced by the ``max_usd`` cap.
    ``max_total_usd`` / ``max_per_seller_usd``: a budget for every payment of this session together / per seller (host);
    make one session per task or user. Past it, nothing is paid and no preflight is bought."""
    try:
        import requests
        from x402.http.clients import wrapRequestsWithPayment
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.pay needs the x402 SDK: pip install 'fizzl[x402]'") from err
    for name, value in (("max_usd", max_usd), ("max_total_usd", max_total_usd), ("max_per_seller_usd", max_per_seller_usd)):
        if (value is not None or name == "max_usd") and (not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0):
            raise ValueError(f"{name} must be a positive number of dollars")
    if not hasattr(payer, "set_spend_controls"):
        raise ValueError("payer must be an x402ClientSync from x402 2.27 or newer (it needs spend controls)")
    payer.set_spend_controls({"max_amount_per_payment": format(Decimal(str(max_usd)), "f")})
    wrapped = wrapRequestsWithPayment(session or requests.Session(), payer)
    safe = SafeSession(wrapped, guard, max_usd, max_total_usd=max_total_usd, max_per_seller_usd=max_per_seller_usd)

    def url_of(context: Any) -> Optional[str]:
        required = getattr(context, "payment_required", None)
        resource = getattr(required, "resource", None)
        url = resource if isinstance(resource, str) else getattr(resource, "url", None)
        return url or getattr(getattr(context, "selected_requirements", None), "resource", None)  # x402 v1

    def budget(hold: bool) -> Callable[[Any], Any]:
        def hook(context: Any) -> Any:
            why = safe.budget_check(url_of(context), usd_of(getattr(context, "selected_requirements", None)), hold=hold)
            if why is None:
                return None
            from x402.schemas import AbortResult
            return AbortResult(reason=why)
        return hook

    # The hooks run in order and stop at the first abort: a spent budget stops the payment before the preflight is
    # bought; the last hook counts the payment as it is signed (so parallel calls can't both spend what is left).
    payer.on_before_payment_creation(budget(hold=False))
    # Doctor's own 402 (the preflight, $0.001) is paid through the same session; the hook never checks it again.
    payer.on_before_payment_creation(doctor_preflight(session=wrapped, credit_key=credit_key, max_usd=max_usd,
                                                      on_caution=on_caution, trusted=trusted))
    payer.on_before_payment_creation(budget(hold=True))
    payer.on_after_payment_creation(lambda context: safe.note_payment(url_of(context)))
    payer.on_payment_creation_failure(lambda context: safe.release(url_of(context)))
    return safe


def refusal(err: BaseException) -> Union[dict, None]:
    """A refused or failed payment as ``{not_paid, message}`` for the model, or None when ``err`` is something else."""
    name = type(err).__name__
    message = str(getattr(err, "reason", None) or err)[:400]
    if isinstance(err, SafePayError):
        return {"not_paid": err.code, "message": message}
    for code in ("over_total_budget", "over_seller_budget"):
        if message.startswith(f"{code}: "):
            return {"not_paid": code, "message": f"not paid: {message[len(code) + 2:]}"}
    if name == "PaymentAbortedError":
        code = "caution" if "(caution)" in message else "incomplete" if "not every check ran" in message else \
            "preflight_failed" if "preflight failed" in message else "no_go"
        return {"not_paid": code, "message": f"not paid: {message}"}
    if "spend_controls" in message or "max_amount_per_payment" in message:
        return {"not_paid": "over_budget", "message": "not paid: every payment option costs more than the budget per call, or is in a token the budget doesn't cover"}
    if name in ("PaymentError", "NoMatchingRequirementsError", "SchemeNotFoundError") or any(c.__name__ == "PaymentError" for c in type(err).__mro__):
        return {"not_paid": "payment_failed", "message": f"not paid: {message}"}
    return None
