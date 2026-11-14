"""Structured Gemini calls (Interactions API), mirroring frontend/src/server/gemini.ts.

Every call: `store=False` (course material and handwriting are student data), a JSON schema for
the response, Pydantic validation, one retry on invalid output, then an error the caller turns
into a graceful fallback.

A model that fails outright (a timeout, a server error) is tried once more on the fallback model,
when there is one: a slow or unavailable model must not quietly turn a course into its headings.
"""

import base64
import logging
from typing import Any, Literal

from google import genai
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

ThinkingLevel = Literal["minimal", "low", "medium", "high"]

#: JSON Schema keywords sent to Gemini; others are dropped (Pydantic still validates them). Array
#: bounds (minItems/maxItems) are left out on purpose: with nested arrays or unions they make
#: Gemini reject the schema (400 "invalid argument", verified against the API).
_SUPPORTED = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "prefixItems",
    "enum",
    "format",
    "minimum",
    "maximum",
    "anyOf",
    "description",
    "title",
    "$ref",
    "$defs",
}


class LlmError(RuntimeError):
    """The model failed or returned invalid output twice."""


class GeminiLlm:
    def __init__(self, client: genai.Client, fallback_model: str | None = None) -> None:
        self.client = client
        #: Tried when a call on the asked-for model fails outright (never for invalid output).
        self.fallback_model = fallback_model

    def structured[T: BaseModel](
        self,
        *,
        model: str,
        system: str,
        text: str,
        schema: type[T],
        images: list[bytes] | None = None,
        thinking: ThinkingLevel = "low",
        max_tokens: int = 4096,
        timeout_s: float = 60,
    ) -> T:
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for png in images or []:
            parts.append(
                {"type": "image", "data": base64.b64encode(png).decode(), "mime_type": "image/png"}
            )
        try:
            return self._ask(model, system, parts, schema, thinking, max_tokens, timeout_s)
        except _CallError as error:
            fallback = self.fallback_model
            if not fallback or fallback == model:
                raise LlmError(str(error)) from error.__cause__
            logger.warning("%s on %s; trying %s", error, model, fallback)
        try:
            return self._ask(fallback, system, parts, schema, thinking, max_tokens, timeout_s)
        except _CallError as error:
            raise LlmError(str(error)) from error.__cause__

    def _ask[T: BaseModel](
        self,
        model: str,
        system: str,
        parts: list[dict[str, Any]],
        schema: type[T],
        thinking: ThinkingLevel,
        max_tokens: int,
        timeout_s: float,
    ) -> T:
        problem = "no attempt"
        for _ in range(2):
            try:
                interaction = self.client.interactions.create(
                    model=model,
                    system_instruction=system,
                    input=parts,
                    store=False,
                    stream=False,
                    response_format={
                        "type": "text",
                        "mime_type": "application/json",
                        "schema": gemini_schema(schema),
                    },
                    generation_config={"thinking_level": thinking, "max_output_tokens": max_tokens},
                    timeout=timeout_s,
                )
            except Exception as error:  # network, quota, server errors
                raise _CallError(f"model call failed: {type(error).__name__}") from error
            try:
                # (The SDK types a streamed result too; this call never streams.)
                output = getattr(interaction, "output_text", None)
                return schema.model_validate_json(output if isinstance(output, str) else "")
            except ValidationError as error:
                problem = f"{error.error_count()} validation error(s)"
        raise LlmError(f"model output failed validation: {problem}")


class _CallError(RuntimeError):
    """The request itself failed (as opposed to an answer that didn't fit the schema)."""


def gemini_schema(model: type[BaseModel]) -> dict[str, Any]:
    pruned = _prune(model.model_json_schema())
    if not isinstance(pruned, dict):
        raise TypeError("schema must be an object")
    return pruned


def _prune(node: Any) -> Any:
    if isinstance(node, list):
        return [_prune(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "const":
            out["enum"] = [value]
        elif key in _SUPPORTED:
            if key in ("properties", "$defs"):
                out[key] = {name: _prune(sub) for name, sub in value.items()}
            else:
                out[key] = _prune(value)
    return out
