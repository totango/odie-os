import { describe, expect, it } from "vitest";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { WORKSHOP_EDITING_PROTOCOL } from "@gadgets/workshop-shared/api";
import { EditingProtocolSession, assertEditingAvailable } from "../src/editing-protocol";
import { makeActionStorage, openFakeOverseer } from "./fixtures";
const submission = {generation: 0, revision: 0, clientId: "test-client", seq: 1, change: {}};

describe("editing wire negotiation", () => {
  it("fences retained gatekeeper removal without touching bindings or hooks and permits reads", async () => {
    const environment = {WORKSHOP_EDITING_PAUSED: "false"};
    const storage = makeActionStorage();
    storage.gatekeepers.put({id: 1, resourceTitle: "Existing", class: {} as never});
    let removals = 0;
    const bindings = {RESOURCE: 1};
    const hooks = [{id: 1, enabled: true}];
    const client = await openFakeOverseer(storage, {negotiate: false, impl: {
      env: environment, removeGatekeeper: () => { removals++; delete bindings.RESOURCE; hooks[0].enabled = false; },
      getGatekeeperFacet: () => ({}),
      recordGadgetAnalytics: () => {},
    }});
    using gatekeeper = await client.getGatekeeperById(1);
    expect(await gatekeeper.getTitle()).toBe("Existing");
    await expect(gatekeeper.remove()).rejects.toThrow("EDITING_PROTOCOL_UPGRADE_REQUIRED");
    await client.negotiateEditingProtocol("git-ot-v1");
    environment.WORKSHOP_EDITING_PAUSED = "true";
    await expect(gatekeeper.remove()).rejects.toThrow("EDITING_CUTOVER_PAUSED");
    expect(await gatekeeper.getTitle()).toBe("Existing");
    expect(bindings).toEqual({RESOURCE: 1});
    expect(hooks).toEqual([{id: 1, enabled: true}]);
    expect(removals).toBe(0);
  });
  it("keeps an old client's runtime gadget connection alive while fencing its retained editor child", async () => {
    const environment = {WORKSHOP_EDITING_PAUSED: "true"};
    const client = await openFakeOverseer(makeActionStorage(), {negotiate: false, impl: {
      env: environment,
      getGadgetRecord: () => ({id: 0, type: "gadget", title: "Existing gadget", bindings: {}}),
      getGadgetUiBundle: async () => null,
      getGadgetFacet: () => new NativeRpcStub({ping: () => "running"}),
      recordGadgetAnalytics: () => {},
    }});
    using gadget = await client.getGadget(0);
    expect(await gadget.getTitle()).toBe("Existing gadget");
    expect(await gadget.getUiBundle()).toBeNull();
    using runtime = await gadget.connectToGadget();
    expect(await runtime.ping()).toBe("running");
    await expect(gadget.bind("NEW", 1)).rejects.toThrow("EDITING_CUTOVER_PAUSED");
    environment.WORKSHOP_EDITING_PAUSED = "false";
    await expect(gadget.remove()).rejects.toThrow("EDITING_PROTOCOL_UPGRADE_REQUIRED");
    expect(await runtime.ping()).toBe("running");
  });
  it("classifies unversioned/unknown clients, pauses matching sessions, and never upgrades by reading", () => {
    let paused = false;
    const session = new EditingProtocolSession(() => paused);
    expect(session.status().state).toBe("upgrade-required");
    expect(() => session.assertWritable()).toThrow("EDITING_PROTOCOL_UPGRADE_REQUIRED");
    expect(session.negotiate("yjs-v0").state).toBe("upgrade-required");
    expect(session.negotiate(WORKSHOP_EDITING_PROTOCOL).state).toBe("ready");
    paused = true;
    expect(session.status().state).toBe("paused");
    expect(() => session.assertCompatible()).not.toThrow();
    expect(() => session.assertWritable()).toThrow("EDITING_CUTOVER_PAUSED");
    expect(() => assertEditingAvailable({WORKSHOP_EDITING_PAUSED: "true"})).toThrow("EDITING_CUTOVER_PAUSED");
  });

  it("rejects an unversioned edit before mutation, while leaving code reads available", async () => {
    const storage = makeActionStorage();
    let writes = 0;
    const client = await openFakeOverseer(storage, {negotiate: false, impl: {
      gitCache: {readFilesAtCommit: async () => [["server.js", {text: "unchanged"}]]},
      submitCodeChange: async () => { ++writes; return {generation: 0, revision: 1}; },
    }});
    await expect(client.submitCodeChange(1, submission)).rejects.toThrow("EDITING_PROTOCOL_UPGRADE_REQUIRED");
    expect(await client.readFilesAtCommit("a".repeat(40), ["server.js"]))
      .toEqual([["server.js", {text: "unchanged"}]]);
    expect(writes).toBe(0);
    await client.negotiateEditingProtocol(WORKSHOP_EDITING_PROTOCOL);
    await client.submitCodeChange(1, submission);
    expect(writes).toBe(1);
  });

  it("rechecks a pause after an awaited identity lookup and fences already-retained sessions", async () => {
    const environment = {WORKSHOP_EDITING_PAUSED: "false"};
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    const client = await openFakeOverseer(makeActionStorage(), {impl: {
      env: environment,
      users: {idFromString: (id: string) => id, get: () => ({
        getGadget: async () => ({id: "workspace-id", title: "Workspace"}),
        whoami: async () => { await barrier; return {type: "user", id: "owner", name: "Owner"}; },
      })},
      submitCodeChange: async () => { ++writes; return {generation: 0, revision: 1}; },
    }});
    const pending = client.submitCodeChange(1, submission);
    environment.WORKSHOP_EDITING_PAUSED = "true";
    release();
    await expect(pending).rejects.toThrow("EDITING_CUTOVER_PAUSED");
    expect(writes).toBe(0);
    expect((await client.getEditingProtocol()).state).toBe("paused");
  });

  it("negotiation never promotes a use-role capability to build access", async () => {
    const client = await openFakeOverseer(makeActionStorage(), {role: "use", negotiate: false});
    expect((await client.negotiateEditingProtocol(WORKSHOP_EDITING_PROTOCOL)).state).toBe("read-only");
    await expect(client.submitCodeChange(1, submission)).rejects.toThrow();
  });
});
