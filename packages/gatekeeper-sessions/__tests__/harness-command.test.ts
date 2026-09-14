import { describe, expect, it } from "vitest";
import { harnessRpcCommand, piCommand, piEnvironment, primeAgentCommand, primeAgentEnvironment, primeAgentSettings } from "../src/runtime.js";

describe.each(["pi", "prime-agent"] as const)("%s machine launch", runtime => {
  it("uses verified RPC mode without changing the terminal launch or trust policy", () => {
    const terminal = runtime === "pi" ? piCommand() : primeAgentCommand();
    const command = harnessRpcCommand(runtime);
    expect(command.slice(-2)).toEqual(["--mode", "rpc"]);
    expect(command).not.toContain("--tui-mode");
    expect(command[command.indexOf("--model") + 1]).toBe("gpt-6-astra");
    expect(command.includes("--no-approve")).toBe(terminal.includes("--no-approve"));
    expect(command).not.toContain("--approve");
    expect(command).not.toContain("--daemon");
    expect(command).not.toContain("--acp");
    if (runtime === "prime-agent") {
      expect(command).toContain("--offline");
      expect(command).toContain("--no-skills");
      expect(command).toContain("--no-prompt-templates");
      expect(command).toContain("--no-themes");
      expect(command).toContain("--no-context-files");
    }
    expect(runtime === "pi" ? piCommand() : primeAgentCommand()).toEqual(terminal);
  });

  it("does not override a resumed model or its available model cycle", () => {
    const sessionFile = "/owner/session with spaces.jsonl";
    const command = harnessRpcCommand(runtime, { sessionFile });
    expect(command.slice(-2)).toEqual([runtime === "pi" ? "--session" : "--resume", sessionFile]);
    for (const flag of ["--model", "--provider", "--models"]) expect(command).not.toContain(flag);
    expect(command).toContain("--extension");
  });

  it("honors an explicit saved selection on new and resumed launches", () => {
    for (const sessionFile of [undefined, "/owner/session.jsonl"]) {
      const command = harnessRpcCommand(runtime, { sessionFile, model: "gpt-5.6-sol" });
      expect(command[command.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    }
  });

  it("rejects relative or NUL paths and unsupported model selections", () => {
    for (const sessionFile of ["relative", "", "/owner/\0session"]) {
      expect(() => harnessRpcCommand(runtime, { sessionFile })).toThrow("absolute session path");
    }
    // Runtime validation protects callers beyond TypeScript.
    expect(() => harnessRpcCommand(runtime, { model: "other" as never })).toThrow("Unsupported managed model");
  });
});

describe("Prime runtime authority fencing", () => {
  it("uses isolated managed environment and only the Workshop MCP settings", () => {
    expect(primeAgentEnvironment()).toEqual({
      PRIME_AGENT_CODING_AGENT_DIR: "/workspace/.odie-prime-agent",
      PRIME_AGENT_KERNEL_PYTHON: "/opt/odie-prime-agent/kernel-venv/bin/python",
      PRIME_AGENT_TELEMETRY: "0",
      PI_OFFLINE: "1",
    });
    expect(piEnvironment()).toEqual({ PI_CODING_AGENT_DIR: "/workspace/.odie-pi", PI_OFFLINE: "1" });
    expect(primeAgentSettings()).toEqual({
      telemetry: { enabled: false },
      mcpServers: {
        workshop: { type: "http", url: "https://workshop-mcp.internal/mcp" },
      },
    });
  });
});
