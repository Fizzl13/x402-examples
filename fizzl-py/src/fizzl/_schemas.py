"""The typed arguments of the four checks (pydantic), shared by the LangChain and OpenAI Agents tools."""
from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field


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


ARGS = {
    "check_before_signing": SignArgs,
    "check_token": TokenArgs,
    "check_wallet_approvals": ApprovalArgs,
    "check_endpoint_before_paying": EndpointArgs,
}
TOOL_NAMES = tuple(ARGS)


def pick(only):
    """The tool names to build: all four, or the ones in ``only`` (unknown names raise)."""
    names = list(only) if only else list(TOOL_NAMES)
    unknown = [n for n in names if n not in ARGS]
    if unknown:
        raise ValueError(f"unknown Fizzl tool(s): {', '.join(unknown)}")
    return names
