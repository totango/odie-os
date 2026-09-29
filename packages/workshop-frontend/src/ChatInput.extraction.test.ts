import { describe, expect, it } from "vitest";
import chatInputSource from "./ChatInput.tsx?raw";
import composerSource from "./features/chat/composer/ChatComposer.tsx?raw";
import chatInterfaceSource from "./ChatInterface.tsx?raw";
import homeRouteSource from "./routes/index.tsx?raw";

describe("ChatInput extraction", () => {
  it("keeps the Home route on the composer-only module", () => {
    expect(homeRouteSource).toContain('from "../features/chat/composer/ChatComposer"');
    expect(homeRouteSource).not.toContain('from "../ChatInterface"');
  });

  it("does not re-export the composer from ChatInterface", () => {
    expect(chatInterfaceSource).toContain('from "./features/chat/composer/ChatComposer"');
    expect(chatInterfaceSource).not.toContain("export const ChatInput");
    expect(chatInterfaceSource).not.toContain("export { ChatInput");
  });

  it("keeps the composer independent of the transcript module", () => {
    expect(chatInputSource).toContain("ChatComposer as ChatInput");
    expect(composerSource).not.toContain('from "../../../ChatInterface"');
    expect(chatInputSource).not.toMatch(/(?:from\s*|import\s*\()\s*["']\.\/ChatInterface(?:\.tsx)?["']/);
  });
});
