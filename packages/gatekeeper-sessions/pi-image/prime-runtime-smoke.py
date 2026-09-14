#!/usr/bin/env python3
"""Offline Prime 0.9 runtime smoke for Odie's coding-session image."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from types import SimpleNamespace


def fail(message: str) -> None:
    print(f"prime runtime smoke failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_frame(process: subprocess.Popen[str]) -> dict[str, object]:
    assert process.stdout is not None
    line = process.stdout.readline()
    if not line:
        stderr = process.stderr.read() if process.stderr is not None else ""
        fail(f"runtime closed before frame; stderr={stderr!r}")
    try:
        frame = json.loads(line)
    except json.JSONDecodeError as error:
        fail(f"non-JSON runtime frame: {line!r}; {error}")
    if not isinstance(frame, dict):
        fail(f"runtime frame is not an object: {frame!r}")
    return frame


def repl_protocol_smoke() -> None:
    process = subprocess.Popen(
        [sys.executable, "-m", "rlm.repl"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ready = read_frame(process)
        if ready.get("event") != "ready" or ready.get("protocol") != 3:
            fail(f"unexpected REPL ready frame: {ready!r}")
        request = {
            "type": "execute",
            "id": "odie-repl-imports",
            "code": (
                "import rlm, rlm.mcp, rlm.bash\n"
                "from rlm import McpIntegration\n"
                "assert McpIntegration.__name__ == 'McpIntegration'\n"
                "'odie-prime-runtime-ok'"
            ),
        }
        assert process.stdin is not None
        process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        process.stdin.flush()
        saw_result = False
        for _ in range(20):
            frame = read_frame(process)
            if frame.get("event") == "error":
                fail(f"REPL execute errored: {frame!r}")
            if frame.get("event") == "result" and frame.get("id") == request["id"]:
                saw_result = frame.get("text") == "'odie-prime-runtime-ok'"
            if frame.get("event") == "done" and frame.get("id") == request["id"]:
                if frame.get("status") != "ok" or not saw_result:
                    fail(f"REPL execute did not complete cleanly; frame={frame!r}; saw_result={saw_result}")
                process.stdin.write(json.dumps({"type": "shutdown", "id": "odie-shutdown"}) + "\n")
                process.stdin.flush()
                return
        fail("REPL execute did not reach done")
    finally:
        try:
            if process.stdin is not None:
                process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


async def mcp2_schema_smoke() -> None:
    from rlm import McpIntegration

    class FakeSession:
        async def list_tools(self):
            return SimpleNamespace(tools=[SimpleNamespace(
                name="workshop_echo",
                description="Odie MCP2 schema smoke",
                input_schema={
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                    "required": ["message"],
                },
            )])

    class FakeWorkshop(McpIntegration):
        server = "workshop"

        async def _open_session(self, stack):  # type: ignore[no-untyped-def]
            return FakeSession()

    tools = await FakeWorkshop().list_tools()
    schema = tools[0].get("inputSchema") if tools else None
    if not isinstance(schema, dict) or schema.get("properties", {}).get("message", {}).get("type") != "string":
        fail(f"MCP2 input_schema did not normalize to inputSchema: {tools!r}")


def main() -> None:
    repl_protocol_smoke()
    asyncio.run(mcp2_schema_smoke())
    print("prime-runtime-smoke-ok")


if __name__ == "__main__":
    main()
