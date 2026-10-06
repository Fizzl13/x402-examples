"""Fizzl safety checks for AI agents that pay.

Check a transaction or signature before signing, a token before buying, a wallet's open approvals, and an
x402 endpoint before paying it (presign-guard and x402 Doctor, paid per call over x402 or with prepaid
credits). The checks never sign, pay or move anything themselves, and a failed check comes back as
``{"error": ..., "message": ...}`` instead of an exception, so an agent can tell its user.

    import requests
    from x402 import x402ClientSync
    from x402.http.clients import wrapRequestsWithPayment
    from fizzl import Fizzl

    payer = x402ClientSync()            # register an EVM scheme with your agent's key
    session = wrapRequestsWithPayment(requests.Session(), payer)
    fizzl = Fizzl(session=session)
    fizzl.check_endpoint_before_paying("https://api.example.com/data", max_usd=0.05)
"""
from __future__ import annotations

import json
from typing import Any, Mapping, Optional
from urllib.parse import urlencode

__version__ = "0.2.0"
__all__ = ["Fizzl", "PRICES", "PRESIGN_URL", "DOCTOR_URL", "__version__"]

PRESIGN_URL = "https://presign-guard.fizzl.eu"
DOCTOR_URL = "https://x402-doctor.fizzl.eu"
PRICES = {
    "check_before_signing": "$0.01",
    "check_token": "$0.01",
    "check_wallet_approvals": "$0.02",
    "check_endpoint_before_paying": "$0.001",
}
EVM_CHAIN_IDS = (1, 10, 56, 137, 8453, 42161)
TOKEN_CHAINS = ("solana", "base", "ethereum", "arbitrum", "optimism", "polygon", "bsc")
APPROVAL_CHAINS = ("base", "ethereum", "arbitrum", "optimism", "polygon", "bsc")


def _error(code: str, message: str) -> dict:
    return {"error": code, "message": message}


def _free_note(price: str) -> str:
    return (f"Free quick check: the verdict only, a few per hour. The full check (reasons and details) costs {price}"
            " via x402 or prepaid credits.")


class Fizzl:
    """The four checks. ``session`` is anything with ``request(method, url, **kwargs)`` like a
    ``requests.Session``; wrap it with x402's ``wrapRequestsWithPayment`` to pay per check, or pass
    ``credit_keys={"presign": ..., "doctor": ...}`` to pay from prepaid credits with a plain session.

    With neither (or when a payment fails) the checks fall back to the free quick checks: the verdict only,
    a few per hour, marked ``"free": True``. Pass ``free=False`` to get ``payment_required`` instead."""

    def __init__(self, session: Any = None, credit_keys: Optional[Mapping[str, str]] = None, timeout: float = 30,
                 presign_url: str = PRESIGN_URL, doctor_url: str = DOCTOR_URL, free: bool = True):
        if session is None:
            import requests  # only needed when no session is given
            session = requests.Session()
        self.session = session
        self.credit_keys = dict(credit_keys or {})
        self.timeout = timeout
        self.presign_url = presign_url.rstrip("/")
        self.doctor_url = doctor_url.rstrip("/")
        self.free = free

    def _free(self, method: str, url: str, body: Optional[dict] = None) -> Any:
        """A free call: plain JSON, no credit key, None on any failure (the paid error then stands)."""
        headers = {"accept": "application/json, text/event-stream", "user-agent": f"fizzl-py/{__version__}"}
        try:
            res = self.session.request(method, url, headers=headers, timeout=self.timeout, **({"json": body} if body is not None else {}))
            if res.status_code != 200:
                return None
            text = res.text.lstrip()
            if not text.startswith("{"):  # an MCP server may answer as an event stream
                text = next((l[5:] for l in text.splitlines() if l.startswith("data:")), "")
            return json.loads(text)
        except Exception:
            return None

    def _or_free(self, paid: dict, check: str, quick) -> dict:
        if not self.free or paid.get("error") != "payment_required":
            return paid
        out = quick()
        if not isinstance(out, dict) or not out.get("verdict"):
            return paid
        return {**out, "free": True, "note": _free_note(PRICES[check]), "payment": paid["message"]}

    def _free_signing(self, args: dict) -> Any:
        d = self._free("POST", f"{self.presign_url}/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                         "params": {"name": "presign_quick_check", "arguments": args}})
        try:
            return json.loads(d["result"]["content"][0]["text"])
        except Exception:
            return None

    def _free_endpoint(self, url: str, method: Optional[str]) -> Any:
        d = self._free("POST", f"{self.doctor_url}/api/diagnose", {"url": url, **({"method": method} if method else {})})
        verdict = {"pass": "go", "warn": "caution", "fail": "no_go"}.get((d or {}).get("overall")) if isinstance(d, dict) else None
        if not verdict:
            return None
        problems = [{"status": c.get("status"), "id": c.get("id"), "message": c.get("message")}
                    for c in d.get("checks") or [] if isinstance(c, dict) and c.get("status") in ("fail", "warn")][:6]
        return {"verdict": verdict, "problems": problems, "report": d.get("share_url")}

    def _call(self, service: str, method: str, url: str, body: Optional[dict] = None) -> dict:
        headers = {"accept": "application/json", "user-agent": f"fizzl-py/{__version__}"}
        key = self.credit_keys.get(service)
        if key:
            headers["x-credit-key"] = key
        try:
            res = self.session.request(method, url, headers=headers, timeout=self.timeout, **({"json": body} if body is not None else {}))
        except Exception as err:  # network, timeout, payment client errors
            return _error("check_failed", f"{type(err).__name__}: {err}")
        try:
            data = res.json()
        except Exception:
            data = None
        if res.status_code == 402:
            why = data.get("error") if isinstance(data, dict) and isinstance(data.get("error"), str) else None
            return _error("payment_required", "This check is paid (x402) and no payment went through"
                          + (f" ({why})" if why else "")
                          + ". Pass a session wrapped with x402's wrapRequestsWithPayment whose wallet holds USDC on Base, or a prepaid credit key.")
        if res.status_code >= 400:
            msg = (data or {}).get("error") or (data or {}).get("message") if isinstance(data, dict) else None
            return _error(f"http_{res.status_code}", str(msg or getattr(res, "text", ""))[:300])
        if not isinstance(data, dict):
            return _error("bad_response", "The check did not answer JSON.")
        data.pop("receipt", None)  # the signed receipt is for audits, not for the model
        return data

    def check_before_signing(self, type: str, chainId: int, token: Optional[str] = None, spender: Optional[str] = None,
                             amount: Optional[str] = None, to: Optional[str] = None, data: Optional[str] = None,
                             value: Optional[str] = None, typedData: Any = None, origin: Optional[str] = None) -> dict:
        """Check a transaction, token approval or signature BEFORE signing it (presign-guard, $0.01).
        Returns verdict green / orange / red with reason codes. Never sign on red; ask the user on orange."""
        if type not in ("approval", "transaction", "signature"):
            return _error("bad_input", 'type must be "approval", "transaction" or "signature"')
        if chainId not in EVM_CHAIN_IDS:
            return _error("bad_input", f"chainId must be one of {EVM_CHAIN_IDS}")
        body = {k: v for k, v in dict(type=type, chainId=chainId, token=token, spender=spender, amount=amount, to=to,
                                      data=data, value=value, typedData=typedData, origin=origin).items() if v is not None}
        return self._or_free(self._call("presign", "POST", f"{self.presign_url}/v1/check", body), "check_before_signing",
                             lambda: self._free_signing(body))

    def check_token(self, chain: str, address: str) -> dict:
        """Check a token BEFORE buying, holding or accepting it (presign-guard, $0.01): honeypot, rug-pull
        signs, look-alikes of known tokens. Solana and EVM chains."""
        if chain not in TOKEN_CHAINS:
            return _error("bad_input", f"chain must be one of {TOKEN_CHAINS}")
        q = urlencode({"chain": chain, "address": address})
        return self._or_free(self._call("presign", "GET", f"{self.presign_url}/v1/token?{q}"), "check_token",
                             lambda: self._free("GET", f"{self.presign_url}/v1/token/quick?{q}"))

    def check_wallet_approvals(self, chain: str, address: str) -> dict:
        """List every open token approval of an EVM wallet and which ones to revoke (presign-guard, $0.02)."""
        if chain not in APPROVAL_CHAINS:
            return _error("bad_input", f"chain must be one of {APPROVAL_CHAINS}")
        return self._call("presign", "GET", f"{self.presign_url}/v1/approvals?{urlencode({'chain': chain, 'address': address})}")

    def check_endpoint_before_paying(self, url: str, max_usd: Optional[float] = None, network: Optional[str] = None,
                                     method: Optional[str] = None) -> dict:
        """Check an x402 or MPP paid API BEFORE paying it (x402 Doctor, $0.001): go / caution / no_go, the
        cheapest option that settles, budget, track record and bait signs. Don't pay on no_go."""
        q = {"url": url}
        if max_usd is not None:
            q["max_usd"] = str(max_usd)
        if network:
            q["network"] = network
        if method:
            q["method"] = method
        return self._or_free(self._call("doctor", "GET", f"{self.doctor_url}/api/v1/preflight?{urlencode(q)}"),
                             "check_endpoint_before_paying", lambda: self._free_endpoint(url, method))
