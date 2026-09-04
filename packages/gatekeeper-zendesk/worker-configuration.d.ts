/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/zendesk");
    durableNamespaces: "ZendeskAccount" | "ZendeskGatekeeper";
  }
  interface Env {
    BASE_URL?: string;
    CLIENT_ID?: string;
    CLIENT_SECRET?: string;
    PUBLIC_BASE_URL?: string;
  }
}
