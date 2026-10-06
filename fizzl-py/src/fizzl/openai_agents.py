"""The Fizzl checks as OpenAI Agents SDK tools (``openai-agents``).

    from agents import Agent, Runner
    from fizzl.openai_agents import fizzl_tools

    agent = Agent(name="buyer", instructions="Before you pay any API, call check_endpoint_before_paying.",
                  tools=fizzl_tools())          # or session=paying_session / credit_keys={...}
    Runner.run_sync(agent, "Is https://api.example.com/data safe to pay?")
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, List, Optional

from . import Fizzl


def fizzl_tools(session: Any = None, credit_keys: Optional[dict] = None, only: Optional[List[str]] = None, **kwargs) -> list:
    """FunctionTools for the four checks (all of them, or the names in ``only``). The checks run in a worker
    thread, so a blocking ``requests`` session doesn't stall the agent's event loop."""
    try:
        from agents import FunctionTool
        from pydantic import ValidationError
        from ._schemas import ARGS, pick
    except ImportError as err:  # pragma: no cover
        raise ImportError("fizzl.openai_agents needs openai-agents: pip install 'fizzl[openai-agents]'") from err

    f = Fizzl(session=session, credit_keys=credit_keys, **kwargs)

    def make(name: str):
        check, model = getattr(f, name), ARGS[name]

        async def on_invoke(_ctx: Any, args: str) -> str:
            try:
                parsed = model.model_validate_json(args or "{}")
            except ValidationError as err:
                return json.dumps({"error": "bad_input", "message": str(err)[:300]})
            result = await asyncio.to_thread(check, **parsed.model_dump(exclude_none=True))
            return json.dumps(result)

        return FunctionTool(name=name, description=(check.__doc__ or "").strip(), params_json_schema=model.model_json_schema(),
                            on_invoke_tool=on_invoke, strict_json_schema=False)

    return [make(n) for n in pick(only)]
