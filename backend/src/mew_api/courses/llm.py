"""Structured Gemini calls (Interactions API), mirroring frontend/src/server/gemini.ts.

Every call: `store=False` (course material and handwriting are student data), a JSON schema for
the response, Pydantic validation, one retry on invalid output, then an error the caller turns
into a graceful fallback.
"""

import base64
from typing import Any, Literal

from google import genai
from pydantic import BaseModel, ValidationError

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
    def __init__(self, client: genai.Client) -> None:
        self.client = client

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
                raise LlmError(f"model call failed: {type(error).__name__}") from error
            try:
                # (The SDK types a streamed result too; this call never streams.)
                output = getattr(interaction, "output_text", None)
                return schema.model_validate_json(output if isinstance(output, str) else "")
            except ValidationError as error:
                problem = f"{error.error_count()} validation error(s)"
        raise LlmError(f"model output failed validation: {problem}")


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
