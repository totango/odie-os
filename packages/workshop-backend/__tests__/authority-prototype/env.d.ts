import type { PrototypeEnv } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env extends PrototypeEnv {}
  }
}
