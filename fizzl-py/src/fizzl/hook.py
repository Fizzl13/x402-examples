"""x402 Doctor's pre-payment check as a hook for the official x402 Python client: one line, and every payment the
client makes is checked first.

    import requests
    from x402 import x402ClientSync
    from x402.http.clients import wrapRequestsWithPayment
    from fizzl.hook import doctor_preflight

    payer = x402ClientSync()                     # register your schemes as before
    session = wrapRequestsWithPayment(requests.Session(), payer)
    payer.on_before_payment_creation(doctor_preflight(session=session, max_usd=0.05))

Before the client signs a payment, the hook asks x402 Doctor ($0.001, paid through ``session``, or 1 prepaid credit
with ``credit_key``) whether the endpoint is safe to pay: no_go aborts the payment (``PaymentAbortedError``),
caution aborts unless ``on_caution`` says otherwise, go lets it through. The verdict is reused while the endpoint
asks the same thing (same payTo, amount, token and network). Doctor's own 402, for the preflight itself, is never
checked again and is paid only up to $0.002.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Iterable, Optional, Union
from urllib.parse import urlparse

from . import DOCTOR_URL, Fizzl

# The preflight costs $0.001; its own 402 is refused above twice that (6-decimal dollar tokens; RLUSD is decimal).
PREFLIGHT_MAX_ATOMIC = 2000
PREFLIGHT_MAX_DECIMAL = 0.002
CHECKS_INCOMPLETE_TTL = 600

Decision = Union[str, Callable[[dict], bool]]


def _get(obj: Any, *names: str) -> Any:
    """An attribute or key, by the first name that is set (the SDK's models use snake_case; dicts may use camelCase)."""
    for name in names:
        value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        if value is not None:
            return value
    return None


def _host(url: Optional[str]) -> Optional[str]:
    try:
        return urlparse(url).netloc or None if url else None
    except Exception:
        return None


def _within_preflight_price(amount: Any) -> bool:
    s = str(amount if amount is not None else "")
    if s.isdigit():
        return int(s) <= PREFLIGHT_MAX_ATOMIC
    try:
        return 0 < float(s) <= PREFLIGHT_MAX_DECIMAL
    except ValueError:
        return False


def _decide(choice: Decision, yes: str, preflight: dict) -> bool:
    if callable(choice):
        return choice(preflight) is True
    return choice == yes


def doctor_preflight(session: Any = None, *, fizzl: Optional[Fizzl] = None, credit_key: Optional[str] = None,
                     max_usd: Optional[float] = None, method: Optional[str] = None, on_caution: Decision = "stop",
                     on_incomplete: Decision = "pay", on_error: str = "stop", trusted: Iterable[str] = (),
                     on_preflight: Optional[Callable[[dict, dict], None]] = None, cache_seconds: float = 3600,
                     doctor_url: str = DOCTOR_URL, now: Callable[[], float] = time.time) -> Callable[[Any], Any]:
    """A before-payment-creation hook for ``x402ClientSync`` (or ``x402Client``): returns ``AbortResult`` to stop a
    payment, ``None`` to let it through.

    session: a requests-like session that pays x402 (wrapRequestsWithPayment with the same client is fine: the hook
    skips Doctor's own 402). credit_key: prepaid x402 Doctor credits (xdc_...), tried first. fizzl: a ready Fizzl to
    use instead. on_caution: "stop" (default), "pay" or a function of the preflight. on_incomplete: for a go whose
    checks_complete is false, "pay" (default), "stop" or a function. on_error: "stop" (default) or "pay" when Doctor
    can't be asked."""
    if on_error not in ("stop", "pay"):
        raise ValueError('on_error must be "stop" or "pay"')
    if not callable(on_caution) and on_caution not in ("stop", "pay"):
        raise ValueError('on_caution must be "stop", "pay" or a function')
    if not callable(on_incomplete) and on_incomplete not in ("stop", "pay"):
        raise ValueError('on_incomplete must be "pay", "stop" or a function')
    checker = fizzl or Fizzl(session=session, credit_keys={"doctor": credit_key} if credit_key else None, doctor_url=doctor_url)
    doctor_host = _host(doctor_url)
    trusted_hosts = {_host(t if "://" in t else f"https://{t}") for t in trusted}
    verdicts: dict = {}

    def abort(reason: str) -> Any:
        from x402.schemas import AbortResult  # the hook only runs inside the x402 client, so x402 is installed
        return AbortResult(reason=str(reason)[:300])

    def hook(context: Any) -> Any:
        required = _get(context, "payment_required", "paymentRequired")
        selected = _get(context, "selected_requirements", "selectedRequirements")
        resource = _get(required, "resource")
        url = _get(resource, "url") if resource is not None and not isinstance(resource, str) else resource
        url = url or _get(selected, "resource")  # x402 v1 keeps it on the requirements
        host = _host(url)
        amount = _get(selected, "amount", "max_amount_required", "maxAmountRequired")
        # Doctor's own 402, for the preflight being paid: never checked again, and never above its price.
        if host and host == doctor_host:
            return None if _within_preflight_price(amount) else abort("x402 Doctor's preflight asked more than $0.002")
        if not url or (host and host in trusted_hosts):
            return None

        network = _get(selected, "network")
        key = (url, network, _get(selected, "asset"), str(amount), _get(selected, "pay_to", "payTo"))
        hit = verdicts.get(key)
        ttl = min(cache_seconds, CHECKS_INCOMPLETE_TTL) if hit and hit[0].get("checks_complete") is False else cache_seconds
        if hit and hit[1] + ttl > now():
            preflight, cached = hit[0], True
        else:
            preflight, cached = checker.check_endpoint_before_paying(url, max_usd=max_usd, network=network, method=method), False
            if not isinstance(preflight, dict) or not preflight.get("verdict"):
                why = preflight.get("message") or preflight.get("error") if isinstance(preflight, dict) else "no answer"
                return None if on_error == "pay" else abort(f"x402 Doctor's preflight failed ({why}); not paid")
            verdicts[key] = (preflight, now())
            if len(verdicts) > 1000:
                verdicts.pop(next(iter(verdicts)))
        if on_preflight:
            on_preflight(preflight, {"url": url, "cached": cached})

        verdict = preflight["verdict"]
        why = preflight.get("summary") or verdict
        if verdict == "no_go":
            return abort(f"x402 Doctor: {why}")
        if verdict == "caution":
            return None if _decide(on_caution, "pay", preflight) else abort(f"x402 Doctor (caution): {why}")
        if verdict != "go":
            return abort(f"x402 Doctor: unknown verdict {verdict}")
        if preflight.get("checks_complete") is False and not _decide(on_incomplete, "pay", preflight):
            return abort("x402 Doctor: go, but not every check ran; try again in a few minutes")
        return None

    return hook


__all__ = ["doctor_preflight"]
