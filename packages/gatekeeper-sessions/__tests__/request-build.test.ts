import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestBuildIntent, RequestBuildPolicy } from "@gadgets/workshop-shared/coding-sessions";
import { buildHash, canonicalBuildJson, parseRequestBuildPolicy, validateRequestBuildIntent, boundedBuildModelPayload } from "../src/request-build-policy.js";
import { requestBuildCloneCommand, requestBuildCollectCommand, requestBuildRunnerSource } from "../src/request-build-runner.js";
const require = createRequire(import.meta.url);
const tooling = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = tooling("miniflare");
const { build } = tooling("esbuild");
const rpcValidation = require("capnweb-validate/esbuild");

// Explicit test-only operator policy, not production defaults/readiness evidence.
const policy: RequestBuildPolicy = {
  version: "fixture-1", runtimeVersion: "0.85.1", model: "fixture-model", wallTimeMs: 120000,
  modelCalls: 2, spendMicros: 2000, callChargeMicros: 1000, modelInputBytes: 8192,
  modelOutputTokens: 200, outputBytes: 8192, diffBytes: 4096, diffFiles: 2, concurrency: 1, dependencyHosts: [],
};
const owner = { userId: "fixture-owner", email: "fixture@example.invalid" };
const key = "dispatch_fixture_123";
async function intent(): Promise<RequestBuildIntent> {
  return { dispatchKey: key, runId: "run_fixture_123456", attempt: 1, specification: "Update a fixture",
    specificationHash: await buildHash("Update a fixture"), repository: "totango/odie-os", baseBranch: "main", baseSha: "a".repeat(40), policy, policyHash: await buildHash(canonicalBuildJson(policy)) };
}

describe("request-build policy", () => {
  it("requires every numeric limit and rejects permissive/malformed values", () => {
    expect(parseRequestBuildPolicy(undefined)).toMatchObject({ready:false,reasons:["BUILD_POLICY_MISSING"]});
    expect(parseRequestBuildPolicy(JSON.stringify(policy))).toMatchObject({ready:true});
    for (const [k, v] of Object.entries(policy)) {
      if (typeof v !== "number") continue;
      for (const bad of [undefined, 0, -1, 1.1, Number.MAX_SAFE_INTEGER]) {
        expect(parseRequestBuildPolicy(JSON.stringify({...policy,[k]:bad})).ready, k).toBe(false);
      }
    }
    expect(parseRequestBuildPolicy(JSON.stringify({...policy,dependencyHosts:["evil.invalid"]})).ready).toBe(false);
    expect(parseRequestBuildPolicy(JSON.stringify({...policy,enableEverything:true})).ready).toBe(false);
  });
  it("binds spec, policy, immutable base and fixed repository", async () => {
    const value = await intent();
    expect(await validateRequestBuildIntent(value, policy)).toMatch(/^[a-f0-9]{64}$/);
    for (const patch of [{specification:"changed"},{policyHash:"b".repeat(64)},{baseSha:"main"},{repository:"other/repo"},{baseBranch:"other"}]) {
      await expect(validateRequestBuildIntent({...value,...patch} as RequestBuildIntent,policy)).rejects.toThrow();
    }
  });
  it("forces output limit and rejects remote hosted tools/background/billing escapes", () => {
    const payload = {model:policy.model,input:[],max_output_tokens:9999,store:true};
    const bounded = JSON.parse(boundedBuildModelPayload(new TextEncoder().encode(JSON.stringify(payload)),policy));
    expect(bounded).toMatchObject({max_output_tokens:200,store:false});
    for (const extra of [{background:true},{model:"other"},{tools:[{type:"web_search"}]},{previous_response_id:"x"}]) {
      expect(()=>boundedBuildModelPayload(new TextEncoder().encode(JSON.stringify({...payload,...extra})),policy)).toThrow();
    }
  });
  it("uses the image's Node runtime and enforces collection bounds at runtime", async () => {
    const value = await intent();
    const clone = requestBuildCloneCommand(value);
    expect(clone[0]).toBe("node");
    expect(clone.join("\n")).not.toContain("python3");

    const directory = mkdtempSync(join(tmpdir(), "request-build-collect-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const run = (candidate: RequestBuildIntent) => {
      const [command, ...args] = requestBuildCollectCommand(candidate);
      args[2] = args[2].replaceAll("/workspace/repository", directory);
      return spawnSync(command, args, {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    };
    try {
      git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
      writeFileSync(join(directory, "a.ts"), "export const a = 1;\n");
      git("add", "a.ts"); git("commit", "-m", "base");
      const baseSha = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "a.ts"), "export const a = 2;\n");
      const expected = spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseSha, "--"], { cwd: directory }).stdout;

      const exactLimit = { ...value, baseSha, policy: { ...value.policy, diffBytes: expected.length } };
      const accepted = run(exactLimit);
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toEqual(expected);

      const overLimit = run({ ...exactLimit, policy: { ...exactLimit.policy, diffBytes: expected.length - 1 } });
      expect(overLimit.status).toBe(2);
      expect(overLimit.stdout).toHaveLength(0);

      writeFileSync(join(directory, "b.ts"), "export const b = 1;\n");
      const tooManyFiles = run({ ...exactLimit, policy: { ...exactLimit.policy, diffBytes: 8192, diffFiles: 1 } });
      expect(tooManyFiles.status).toBe(2);
      expect(run({ ...exactLimit, baseSha: "b".repeat(40) }).status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("materializes only SDK, owned loader/settings/toolset and ephemeral session", async () => {
    const source = requestBuildRunnerSource(await intent());
    expect(source).toContain("createAgentSession"); expect(source).toContain("createExtensionRuntime");
    expect(source).toContain("SessionManager.inMemory"); expect(source).toContain("modelsPath:null");
    expect(source).not.toContain("DefaultResourceLoader"); expect(source).not.toContain("spawn(");
    expect(source).not.toContain("WORKSHOP_MCP"); expect(source).not.toContain("GITHUB_TOKEN");
    expect(source).toContain("getAgentsFiles:()=>({agentsFiles:[]})");
  });
});

describe("request-build execution in real workerd SQLite", () => {
  let mf: InstanceType<typeof Miniflare>;
  beforeAll(async () => {
    const bundle = await build({entryPoints:[fileURLToPath(new URL("./request-build-fixture.js",import.meta.url))],bundle:true,write:false,format:"esm",target:"es2022",platform:"neutral",plugins:[rpcValidation()],conditions:["workerd","worker","browser"],mainFields:["module","main"],external:["cloudflare:*","node:*"]});
    mf = new Miniflare(convertV4MiniflareOptions({outboundService:()=>{throw new Error("Restricted fixture must not contact external providers");},name:"request-build-test",modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-02-02",compatibilityFlags:["nodejs_compat"],bindings:{REQUEST_BUILD_POLICY:JSON.stringify(policy),GITHUB_APP_ID:"fixture",GITHUB_APP_PRIVATE_KEY:"fixture-not-a-key",GITHUB_APP_INSTALLATION_ID:"fixture",TEAM_PI_CODEX_HMAC_SECRET:"fixture-not-a-key",TEAM_PI_CODEX_BASE_URL:"https://team-pi-proxy.unison.totango.com/api/odie/"},serviceBindings:{WORKSHOP_TOOLS:{name:"request-build-test",entrypoint:"BuildAuthorityFixture"}},durableObjects:{FIXTURE:{className:"RequestBuildFixture",useSQLite:true},SESSION_REGISTRIES:{className:"CodingSessionRegistry",useSQLite:true},SESSION_POLICIES:{className:"CodingSessionPolicy",useSQLite:true},REQUEST_BUILD_SANDBOX:{className:"RequestBuildFixture",useSQLite:true}}}));
    await mf.ready;
  },30000);
  afterAll(async()=>{await mf?.dispose();});
  async function call(id:string,op:string,extra:Record<string,unknown>={}) {
    const response = await mf.dispatchFetch(`http://fixture.test/${id}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({op,owner,key,...extra})});
    return response.json();
  }
  async function setup(id:string,fields:Record<string,unknown>={}) {
    await call(id,"configure",{fields:{policy:JSON.stringify(policy),...fields}});
    return call(id,"ensure",{intent:await intent()});
  }
  it("uses the actual GitHub credential readiness helper for B64 and whitespace", async () => {
    expect(await call("readiness", "readiness", {fields: {GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_B64: "fixture-base64"}})).toMatchObject({ready: true});
    expect(await call("readiness", "readiness", {fields: {GITHUB_APP_PRIVATE_KEY: "  ", GITHUB_APP_PRIVATE_KEY_B64: " "}})).toMatchObject({ready: false, reasons: expect.arrayContaining(["BUILD_REPOSITORY_CREDENTIALS_MISSING"])});
  });
  it("persists cancellation before reservation and rejects delayed ensure and mismatched owners", async () => {
    await call("tombstone", "configure", {fields: {policy: JSON.stringify(policy)}});
    expect(await call("tombstone", "cancel", {revision: 1})).toBeNull();
    expect(await call("tombstone", "cancel", {revision: 2})).toBeNull();
    expect(await call("tombstone", "ensure", {intent: await intent()})).toEqual({error: "BUILD_CANCELED_BEFORE_RESERVATION"});
    expect(await call("tombstone", "cancel", {revision: 3, owner: {...owner, userId: "different-owner"}})).toEqual({error: "BUILD_OWNER_MISMATCH"});
    expect(await call("tombstone", "ensure", {owner: {...owner, userId: "different-owner"}, intent: await intent()})).toEqual({error: "BUILD_OWNER_MISMATCH"});
    expect(await call("tombstone", "inspect")).toMatchObject({sessions: 0, execs: 0});
  });
  it("atomically fences cancellation racing async ensure validation, reconstructing the controller", async () => {
    await call("cancel-race", "configure", {fields: {policy: JSON.stringify(policy)}});
    const value = await intent();
    await Promise.all([call("cancel-race", "ensure", {intent: value}), call("cancel-race", "cancel", {revision: 1})]);
    expect(await call("cancel-race", "ensure", {intent: value})).toEqual({error: "BUILD_CANCELED_BEFORE_RESERVATION"});
    await call("cancel-race", "tick"); await call("cancel-race", "tick");
    expect(await call("cancel-race", "inspect")).toMatchObject({execs: 0, slot: null});
  });
  it("reserves in the actual Code Session registry and denies ordinary metadata/public fetch", async () => {
    const record = await call("native-registry","registry-ensure",{intent:await intent()});
    expect(record).toMatchObject({state:"reserved",generation:1,sequence:1});
    const again = await call("native-registry","registry-ensure",{intent:await intent()});
    expect(again.sessionId).toBe(record.sessionId);
    expect(await call("native-registry","registry-inspect",{sessionId:record.sessionId})).toMatchObject({receipt:{sessionId:record.sessionId},sessions:[],metadata:null,current:false});
    expect(await call("native-registry","public-denial")).toEqual({status:404});
  });
  it("atomically maps concurrent retries to one preallocated session before startup", async () => {
    await call("atomic","configure",{fields:{policy:JSON.stringify(policy)}});
    const value=await intent();
    const receipts=await Promise.all(Array.from({length:8},()=>call("atomic","ensure",{intent:value})));
    expect(receipts[0]).not.toHaveProperty("error");
    expect(new Set(receipts.map(r=>r.sessionId)).size).toBe(1);
    expect(await call("atomic","inspect")).toMatchObject({runtime:"Cloudflare-Workers",sessions:1,execs:0,receipt:{sequence:1,state:"reserved"}});
    expect(await call("atomic","ensure",{intent:{...value,baseSha:"b".repeat(40)}})).toMatchObject({error:"BUILD_KEY_CONFLICT"});
    expect(await call("atomic","inspect",{owner:{...owner,userId:"other"}})).toMatchObject({error:"BUILD_OWNER_MISMATCH"});
  });
  it("persists sequence/stages through reconstructed controllers, collects a frozen patch and cleans up", async () => {
    const reserved=await setup("happy");
    let sequence=reserved.sequence;
    for(let n=0;n<6;n++) {
      const snapshot=await call("happy","tick"); expect(snapshot.receipt.sequence).toBeGreaterThan(sequence); sequence=snapshot.receipt.sequence;
    }
    expect(await call("happy","inspect")).toMatchObject({execs:3,slot:null,destroys:1,disabled:true,work:false,receipt:{state:"artifact_ready",cleanup:"complete",sessionId:reserved.sessionId,generation:1}});
    const artifact=await call("happy","artifact"); expect(artifact.hash).toBe(await buildHash(artifact.patch));
    expect(await call("happy","ensure",{intent:await intent()})).toMatchObject({sessionId:reserved.sessionId,state:"artifact_ready"});
  });
  it.each([1,2,3])("does not repeat process start after lost response at launch %i",async launch=>{
    const id=`lost-${launch}`;await setup(id,{"lose-start":launch});
    for(let n=0;n<8;n++) await call(id,"tick");
    expect(await call(id,"inspect")).toMatchObject({execs:launch,work:false,receipt:{state:"needs_attention",cleanup:"complete"}});
  });
  it("revocation after reservation prevents startup and still permits cleanup",async()=>{
    await setup("revoked"); await call("revoked","configure",{fields:{denied:true}});
    await call("revoked","tick");await call("revoked","tick");
    expect(await call("revoked","inspect")).toMatchObject({execs:0,receipt:{state:"needs_attention",cleanup:"complete"}});
  });
  it("monotonic cancel needs no initiating actor eligibility and releases only after destruction",async()=>{
    await setup("cancel");await call("cancel","tick");await call("cancel","tick");
    await call("cancel","configure",{fields:{denied:true,"destroy-failed":true}});
    await call("cancel","cancel",{revision:4});await call("cancel","cancel",{revision:2});await call("cancel","tick");
    expect(await call("cancel","inspect")).toMatchObject({slot:key,disabled:true,work:true,receipt:{state:"canceled",cancelRevision:4,cleanup:"pending"}});
    await call("cancel","configure",{fields:{"destroy-failed":false}});await call("cancel","tick");
    expect(await call("cancel","inspect")).toMatchObject({slot:null,execs:1,work:false,receipt:{cleanup:"complete"}});
  });
  it.each(["process-lost","stale"])("denies %s without replacement execution",async fault=>{
    const id=`fault-${fault}`;await setup(id);await call(id,"tick");await call(id,"tick");await call(id,"configure",{fields:{[fault]:true}});
    await call(id,"tick");await call(id,"tick");expect(await call(id,"inspect")).toMatchObject({execs:1,receipt:{state:"needs_attention"}});
  });
  it("deadline expires even when provider process is running",async()=>{
    await setup("deadline",{"process-running":true});await call("deadline","tick");await call("deadline","tick");await call("deadline","expire");await call("deadline","tick");
    expect(await call("deadline","inspect")).toMatchObject({execs:1,receipt:{state:"failed",errorCode:"BUILD_WALLTIME_LIMIT",cleanup:"complete"}});
  });
  it("does not reserve without an alarm and fails closed on capacity or truncated output",async()=>{
    expect(await setup("alarm",{"alarm-failed":true})).toMatchObject({error:"alarm unavailable"});
    expect(await call("alarm","inspect")).toMatchObject({sessions:0,execs:0});
    await setup("capacity",{"capacity-denied":true});await call("capacity","tick");expect(await call("capacity","inspect")).toMatchObject({execs:0,receipt:{state:"failed",errorCode:"BUILD_CAPACITY_UNAVAILABLE"}});
    await setup("output",{truncated:true});for(let n=0;n<5;n++)await call("output","tick");expect(await call("output","inspect")).toMatchObject({execs:2,receipt:{state:"failed",errorCode:"BUILD_OUTPUT_LIMIT"}});
  });
});
