import { validateGadgetAiRequest, type GadgetAiRequest } from "@gadgets/workshop-shared/api";
import { completeText } from "./ai-invoke";
import { getModel } from "./ai-models";
import type { UserDurableObject } from "./user";

/** Execute a foreground completion using only the authenticated viewer's current Team PI authority. */
export async function runGadgetAi(
    env: Cloudflare.Env, user: DurableObjectStub<UserDurableObject>, request: GadgetAiRequest,
): Promise<string> {
  const input = validateGadgetAiRequest(request);
  // This consumes quota, so never replay it across a Durable Object reset.
  const context = await user.prepareGadgetAiRequest(input.modelId);
  if (!context.aiModel) throw new Error("Team PI model is not available.");
  return completeText(getModel(env, context.aiModel.config, context.profile), {
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    maxTokens: 4096,
    signal: AbortSignal.timeout(60_000),
  });
}
