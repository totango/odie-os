import { afterAll, beforeAll, expect, it } from "vitest";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, stubFor, waitFor, waitForIdleChat, WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const executeCode = (id: string, code: string): ChatCompletionStep => ({
  toolCall: { id, name: "executeCode", arguments: { code } },
});

it.concurrent("a worktree remains agent-private across merge, revert and deletion",
    async () => {
  const [username] = nextUsernames("worktree");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  using ws = await api.newGadget();
  await ws.negotiateEditingProtocol("git-ot-v1");
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;

  using seed = ws.createGadget("Seed", undefined, "SEED");
  const seedId = await seed.getId();
  const baseCommit = await waitFor("the seed gadget commit", async () => {
    const summary = workpieces.summaries.get(seedId);
    return summary?.type === "gadget" && summary.commitId !== undefined
      ? summary.commitId
      : null;
  });

  const model = models.script([
    { toolCall: { id: "create-worktree", name: "createWorktree", arguments: {
      title: "Notes", bindingName: "WORKTREE", commitId: baseCommit,
    } } },
    executeCode("write-worktree", `export default async function(self, env) {
  await env.WORKTREE.writeFile("note.txt", "one\\n");
  await env.WORKTREE.commit("first");
  await env.WORKTREE.writeFile("note.txt", "two\\n");
  await env.WORKTREE.commit("second");
  await env.WORKTREE.writeFile("note.txt", "three\\n");
}`),
    { text: "Done." },
    executeCode("inspect-worktree", `export default async function(self, env) {
  console.log(typeof env.WORKTREE);
}`),
    { text: "Done." },
    executeCode("continue-worktree", `export default async function(self, env) {
  await env.WORKTREE.writeFile("note.txt", "four\\n");
  await env.WORKTREE.commit("fourth");
  await env.WORKTREE.writeFile("note.txt", "five\\n");
  await env.WORKTREE.commit("fifth");
}`),
    { text: "Done." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);

  const chatA = await ws.newChat("Make a worktree.", SCRIPTED_MODEL_ID);
  await waitFor("three model requests", async () => model.requests.length === 3 ? true : null);
  await waitForIdleChat(ws, chatA);

  const firstHistory = await loadAllChatHistory(before => ws.getChatHistory(chatA, before));
  // The agent ran both commits. Chat history withholds private files and tool input/output;
  // the owner's separate workpiece subscription still lets them inspect their own worktree.
  expect(model.requests).toHaveLength(3);
  expect(firstHistory.some(message => message.type === "changes" &&
    (message.createdWorktrees?.length || message.worktreeCommits?.length))).toBe(false);
  expect(JSON.stringify(firstHistory)).not.toMatch(/note\.txt|"WORKTREE"/);
  const worktree = await waitFor("the owner's worktree summary", async () =>
    [...workpieces.summaries.values()].find(summary => summary.type === "worktree") ?? null);
  if (worktree.type !== "worktree") throw new Error("Expected a worktree summary");
  const worktreeId = worktree.id;
  expect(worktree).toMatchObject({chatId: chatA, baseCommit, pinBase: baseCommit});
  const second = worktree.headCommit;
  const [secondLog, firstLog] = await ws.getCommitLog(second, 2);
  expect(secondLog?.oid).toBe(second);
  if (!firstLog) throw new Error("The agent did not create the first commit");
  expect(await ws.readFilesAtCommit(firstLog.oid, ["note.txt"]))
    .toEqual([["note.txt", {kind: "text", text: "one\n"}]]);
  expect(await ws.readFilesAtCommit(second, ["note.txt"]))
    .toEqual([["note.txt", {kind: "text", text: "two\n"}]]);
  expect((await ws.listChats()).find(chat => chat.id === chatA)?.proposedChangeWorkpieces ?? [])
    .toEqual([]);

  const chatB = await ws.newChat("Look for a worktree.", SCRIPTED_MODEL_ID);
  await waitFor("five model requests", async () => model.requests.length === 5 ? true : null);
  await waitForIdleChat(ws, chatB);
  const secondHistory = await loadAllChatHistory(before => ws.getChatHistory(chatB, before));
  const inspection = secondHistory.flatMap(message =>
    message.type === "message" ? message.toolCalls ?? [] : [])
      .find(call => call.toolName === "executeCode");
  expect(inspection?.output).toContain("undefined");

  expect(await ws.mergeChanges(chatA)).toEqual({ outcome: "merged" });
  const merged = await waitFor("the accepted worktree commit", async () => {
    const summary = workpieces.summaries.get(worktreeId);
    return summary?.type === "worktree" && summary.pinBase !== baseCommit ? summary : null;
  });
  expect(merged.headCommit).toBe(second);
  expect(await ws.readFilesAtCommit(merged.pinBase, ["note.txt"]))
    .toEqual([["note.txt", {kind: "text", text: "three\n"}]]);
  expect((await ws.listChats()).find(chat => chat.id === chatA)?.proposedChangeWorkpieces ?? [])
      .toEqual([]);

  await ws.sendChatMessage(chatA, "Keep going.", SCRIPTED_MODEL_ID);
  await waitFor("seven model requests", async () => model.requests.length === 7 ? true : null);
  await waitForIdleChat(ws, chatA);
  const finalHistory = await loadAllChatHistory(before => ws.getChatHistory(chatA, before));
  const continuation = finalHistory.find(message => message.type === "message" &&
    message.message === "Keep going.");
  const laterChange = finalHistory.find(message => message.type === "changes" &&
    continuation && message.sequence > continuation.sequence);
  if (!laterChange) throw new Error("The later agent changes were not recorded");
  expect(JSON.stringify(finalHistory)).not.toMatch(/note\.txt|"WORKTREE"/);
  await ws.revertChanges(chatA, laterChange.sequence);
  await waitFor("the reverted worktree head", async () => {
    const summary = workpieces.summaries.get(worktreeId);
    return summary?.type === "worktree" && summary.headCommit === second ? true : null;
  });
  expect(workpieces.summaries.get(worktreeId)).toMatchObject({pinBase: merged.pinBase});

  await ws.deleteChat(chatA);
  await waitFor("the deleted worktree to disappear", async () =>
    workpieces.summaries.has(worktreeId) ? null : true);
  expect([...workpieces.summaries.values()].map(summary => summary.id)).toEqual([seedId]);
  expect((await ws.listChats()).some(chat => chat.id === chatA)).toBe(false);
  expect(model.remainingSteps()).toBe(0);
});
