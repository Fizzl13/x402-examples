"""The Fizzl checks as LangChain tools (``langchain-core``), for LangChain and LangGraph agents.

    from fizzl.langchain import fizzl_tools
    tools = fizzl_tools(session=paying_session)   # or credit_keys={...}
    agent = create_react_agent(model, tools)
"""
from __future__ import annotations

from typing import Any, List, Optional

from . import Fizzl

TOOL_NAMES = ("check_before_signing", "check_token", "check_wallet_approvals", "check_endpoint_before_paying")


def fizzl_tools(session: Any = None, credit_keys: Optional[dict] = None, only: Optional[List[str]] = None, **kwargs) -> list:
    """LangChain StructuredTools for the four checks (all of them, or the names in ``only``)."""
    try:
        from langchain_core.tools import StructuredTool
        from ._schemas import ARGS, pick
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.langchain needs langchain-core: pip install 'fizzl[langchain]'") from err

    f = Fizzl(session=session, credit_keys=credit_keys, **kwargs)
    names = pick(only)
    return [StructuredTool.from_function(func=getattr(f, n), name=n, description=(getattr(f, n).__doc__ or "").strip(), args_schema=ARGS[n]) for n in names]
