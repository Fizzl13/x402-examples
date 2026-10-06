"""The Fizzl checks as LangChain tools (``langchain-core``), for LangChain and LangGraph agents.

    from fizzl.langchain import fizzl_tools
    tools = fizzl_tools(session=paying_session)   # or credit_keys={...}
    agent = create_react_agent(model, tools)
"""
from __future__ import annotations

from typing import Any, List, Literal, Optional, Union

from . import Fizzl

TOOL_NAMES = ("check_before_signing", "check_token", "check_wallet_approvals", "check_endpoint_before_paying")


def fizzl_tools(session: Any = None, credit_keys: Optional[dict] = None, only: Optional[List[str]] = None, **kwargs) -> list:
    """LangChain StructuredTools for the four checks (all of them, or the names in ``only``)."""
    try:
        from langchain_core.tools import StructuredTool
        from pydantic import BaseModel, Field
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.langchain needs langchain-core: pip install 'fizzl[langchain]'") from err

    f = Fizzl(session=session, credit_keys=credit_keys, **kwargs)

    class SignArgs(BaseModel):
        type: Literal["approval", "transaction", "signature"] = Field(description="What is about to be signed")
        chainId: int = Field(description="EVM chain id: 1, 10, 56, 137, 8453 (Base) or 42161")
        token: Optional[str] = Field(None, description="approval: token contract")
        spender: Optional[str] = Field(None, description="approval: who gets the allowance")
        amount: Optional[str] = Field(None, description="approval: amount in base units (0 = revoke)")
        to: Optional[str] = Field(None, description="transaction: target contract or recipient")
        data: Optional[str] = Field(None, description="transaction: 0x-prefixed calldata")
        value: Optional[str] = Field(None, description="transaction: native value in wei")
        typedData: Optional[Union[dict, str]] = Field(None, description="signature: the eth_signTypedData_v4 payload")
        origin: Optional[str] = Field(None, description="the site asking for the signature or transaction, if any")

    class TokenArgs(BaseModel):
        chain: Literal["solana", "base", "ethereum", "arbitrum", "optimism", "polygon", "bsc"]
        address: str = Field(description="Solana mint (base58) or EVM token contract (0x…)")

    class ApprovalArgs(BaseModel):
        chain: Literal["base", "ethereum", "arbitrum", "optimism", "polygon", "bsc"]
        address: str = Field(description="Wallet address (0x…)")

    class EndpointArgs(BaseModel):
        url: str = Field(description="The paid endpoint you are about to pay")
        max_usd: Optional[float] = Field(None, description="Your budget for this call in USD")
        network: Optional[str] = Field(None, description="CAIP-2 network to pay on, e.g. eip155:8453")
        method: Optional[Literal["GET", "POST"]] = None

    specs = {
        "check_before_signing": (f.check_before_signing, SignArgs),
        "check_token": (f.check_token, TokenArgs),
        "check_wallet_approvals": (f.check_wallet_approvals, ApprovalArgs),
        "check_endpoint_before_paying": (f.check_endpoint_before_paying, EndpointArgs),
    }
    names = list(only) if only else list(TOOL_NAMES)
    unknown = [n for n in names if n not in specs]
    if unknown:
        raise ValueError(f"unknown Fizzl tool(s): {', '.join(unknown)}")
    return [StructuredTool.from_function(func=specs[n][0], name=n, description=(specs[n][0].__doc__ or "").strip(), args_schema=specs[n][1]) for n in names]
