declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    ODIE_KG_MCP_URL?: string;
    MCP_CLIENT_NAME?: string;
    MCP_ALLOW_INSECURE?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "OdieKgAccount" | "OdieKgGatekeeper";
  }
}
