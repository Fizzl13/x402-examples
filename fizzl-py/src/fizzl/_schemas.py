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
    from_address: Optional[str] = Field(None, description="transaction: your wallet address (0x…); the transaction is then simulated, so you see what really leaves the wallet (orange HIDDEN_APPROVAL, SIMULATION_NFT_OUT, SIMULATION_FAILS)")
    intent: Optional[str] = Field(None, max_length=500, description='what you are trying to do, in one sentence (e.g. "swap 10 USDC for ETH"); orange INTENT_MISMATCH when signing does more or something else')
    x402: Optional[dict] = Field(None, description="signature paying an x402 challenge: the accepts entry you chose ({accepted: {scheme, network, amount, asset, payTo, maxTimeoutSeconds}}); red when the signature pays more, someone else, another token or chain")

class XrplArgs(BaseModel):
    tx: dict = Field(description="The unsigned XRP Ledger transaction JSON (TransactionType, Account, ...)")
    network: Optional[Literal["xrpl:0", "xrpl:1"]] = Field(None, description="xrpl:0 mainnet (default) or xrpl:1 testnet")
    origin: Optional[str] = Field(None, description="the site asking for the signature, if any")


class TokenArgs(BaseModel):
    chain: Literal["solana", "base", "ethereum", "arbitrum", "optimism", "polygon", "bsc", "xrpl"]
    address: str = Field(description="Solana mint (base58), EVM token contract (0x…), or an XRPL token as CURRENCY.rIssuer")

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
    "check_xrpl_transaction": XrplArgs,
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
