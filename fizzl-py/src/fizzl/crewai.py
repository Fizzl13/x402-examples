"""The Fizzl checks as native CrewAI tools (``crewai``).

    from crewai import Agent
    from fizzl.crewai import fizzl_tools

    buyer = Agent(role="Buyer", goal="Buy data from paid APIs without getting cheated",
                  backstory="Before you pay any API, you call check_endpoint_before_paying. You never pay on red or no_go.",
                  tools=fizzl_tools())          # or session=paying_session / credit_keys={...}
"""
from __future__ import annotations

import json
from typing import Any, Callable, List, Optional

from . import Fizzl


def fizzl_tools(session: Any = None, credit_keys: Optional[dict] = None, only: Optional[List[str]] = None, buy: bool = False, **kwargs) -> list:
    """CrewAI BaseTools for the checks (all of them, plus buy_live_data with ``buy`` and pay_api with a ``pay_session``,
    or the names in ``only``). Each tool takes the check's typed arguments and returns its answer as JSON text."""
    try:
        from crewai.tools import BaseTool
        from pydantic import ConfigDict, ValidationError
        from ._schemas import ARGS, pick
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.crewai needs crewai: pip install 'fizzl[crewai]'") from err

    class FizzlCheck(BaseTool):
        model_config = ConfigDict(arbitrary_types_allowed=True)
        check: Callable[..., dict]

        def _run(self, **args: Any) -> str:
            try:
                parsed = self.args_schema.model_validate(args)
            except ValidationError as err:
                return json.dumps({"error": "bad_input", "message": str(err)[:300]})
            return json.dumps(self.check(**parsed.model_dump(exclude_none=True)))

    f = Fizzl(session=session, credit_keys=credit_keys, **kwargs)
    tools = []
    for name in pick(only, buy, pay=f.pay_session is not None):
        check = getattr(f, name)
        tools.append(FizzlCheck(name=name, description=(check.__doc__ or "").strip(), args_schema=ARGS[name], check=check))
    return tools
