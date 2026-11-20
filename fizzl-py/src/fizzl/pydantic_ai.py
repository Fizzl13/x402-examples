"""The Fizzl checks as Pydantic AI tools (``pydantic-ai``).

    from pydantic_ai import Agent
    from fizzl.pydantic_ai import fizzl_tools

    agent = Agent(model, tools=fizzl_tools(),   # or session=paying_session / credit_keys={...}
                  instructions="Before you pay any API, call check_endpoint_before_paying. Never continue on red or no_go.")
    agent.run_sync("Is https://api.example.com/data safe to pay, at most $0.05?")
"""
from __future__ import annotations

from typing import Any, List, Optional

from . import Fizzl


def fizzl_tools(session: Any = None, credit_keys: Optional[dict] = None, only: Optional[List[str]] = None, buy: bool = False, **kwargs) -> list:
    """Pydantic AI Tools for the checks (all of them, plus buy_live_data with ``buy`` and pay_api with a ``pay_session``,
    or the names in ``only``). Each tool's JSON schema is the check's typed arguments; arguments are validated again
    before the check runs, so bad input from the model comes back as ``{"error": "bad_input", ...}`` and costs nothing."""
    try:
        from pydantic import ValidationError
        from pydantic_ai import Tool
        from ._schemas import ARGS, pick
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.pydantic_ai needs pydantic-ai: pip install 'fizzl[pydantic-ai]'") from err

    f = Fizzl(session=session, credit_keys=credit_keys, **kwargs)

    def make(name: str):
        check, model = getattr(f, name), ARGS[name]

        def run(**args: Any) -> dict:
            try:
                parsed = model.model_validate(args)
            except ValidationError as err:
                return {"error": "bad_input", "message": str(err)[:300]}
            return check(**parsed.model_dump(exclude_none=True))

        return Tool.from_schema(run, name=name, description=(check.__doc__ or "").strip(), json_schema=model.model_json_schema())

    return [make(n) for n in pick(only, buy, pay=f.pay_session is not None)]
