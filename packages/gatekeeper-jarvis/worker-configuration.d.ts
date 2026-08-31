/* eslint-disable */
// Hand-maintained to match the shape `wrangler types` would emit for this Worker.
interface __BaseEnv_Env {
	JARVIS_MCP_URL?: string;
	JARVIS_MCP_TOKEN?: string;
	JARVIS_TRUST_ANNOTATIONS?: string;
	MCP_CLIENT_NAME?: string;
	PRODUCT_FEEDBACK_MCP_TOKEN?: string;
	PRODUCT_FEEDBACK_MCP_URL?: string;
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/index");
		durableNamespaces: "JarvisGatekeeper" | "JarvisPolicy";
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
declare module "*.txt" {
	const value: string;
	export default value;
}
