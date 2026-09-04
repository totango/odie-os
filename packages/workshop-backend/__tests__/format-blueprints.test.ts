import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FEATURED_BLUEPRINTS_KEY, listFeaturedBlueprintsFromKv, parseBlueprintArchive, parseBlueprintKvRecord, parseFeaturedBlueprints, sanitizeBlueprintOutput, serializeFeaturedBlueprints } from "../src/blueprint-archive.js";
import { featuredBlueprintsManifestVersion, formatBlueprintsManifestVersion, installFeaturedBlueprints, installFormatBlueprints } from "../src/format-blueprints.js";
import { FEATURED_BLUEPRINTS, FORMAT_BLUEPRINTS } from "../src/generated/format-blueprints.js";

async function readBlueprintFile(
  entry: (typeof FORMAT_BLUEPRINTS)[number],
  filename: string,
): Promise<string> {
  let archive = new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!;
  let {content} = await parseBlueprintArchive(archive);
  let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
  let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  return doc.getMap<Y.Text>().get(filename)?.toString() ?? "";
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  let compressed = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function makeArchive(files: Record<string, string>, metadata: Record<string, unknown>) {
  let doc = new Y.Doc();
  let root = doc.getMap<Y.Text>();
  for (let [name, contents] of Object.entries(files).toSorted()) {
    let text = new Y.Text();
    text.insert(0, contents);
    root.set(name, text);
  }
  let content = await gzip(Y.encodeStateAsUpdateV2(doc));
  let metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  let archive = new Uint8Array(24 + metadataBytes.byteLength + content.byteLength);
  let view = new DataView(archive.buffer);
  view.setBigUint64(0, 0xec2e2d3a2300e317n);
  view.setUint32(8, 1);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  archive.set(metadataBytes, 24);
  archive.set(content, 24 + metadataBytes.byteLength);
  return archive.toBase64();
}

async function withFeaturedEntry<T>(entry: (typeof FEATURED_BLUEPRINTS)[number], test: () => Promise<T>): Promise<T> {
  FEATURED_BLUEPRINTS.push(entry);
  try {
    return await test();
  } finally {
    FEATURED_BLUEPRINTS.pop();
  }
}

async function readInstalledFiles(content: Uint8Array): Promise<Record<string, string>> {
  let decompressed = new Response(content).body!.pipeThrough(new DecompressionStream("gzip"));
  let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  let result: Record<string, string> = {};
  doc.getMap<Y.Text>().forEach((text, name) => { result[name] = text.toString(); });
  return result;
}

// Minimal in-memory stand-ins for the two bindings the installer writes to. They record what was
// written so the test can assert on the installed blueprint the way a reader would see it.
function makeEnv() {
  let kv = new Map<string, string>();
  let r2 = new Map<string, Uint8Array>();
  return {
    kv,
    r2,
    env: {
      BLUEPRINTS: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      BLUEPRINT_CONTENT: {
        // Deliberately strict: real R2 rejects a stream of unknown length, so accepting one here
        // would hide exactly the bug this stands in for.
        put: async (key: string, value: unknown) => {
          if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
            throw new TypeError(
                "Provided readable stream must have a known length " +
                "(request/response body or readable half of FixedLengthStream)");
          }
          r2.set(key, new Uint8Array(ArrayBuffer.isView(value)
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value));
        },
      },
    } as unknown as Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">,
  };
}

type StarterSlug =
  | "developer-delivery-kit"
  | "finance-operations-workbench"
  | "incident-investigation-board"
  | "jira-delivery-risk"
  | "support-escalation-cockpit";

type StarterGadget = Record<string, (...args: unknown[]) => Promise<unknown>>;

class MockDurableObject {
  ctx: unknown;
  env: Record<string, unknown>;

  constructor(ctx: unknown, env: Record<string, unknown>) {
    this.ctx = ctx;
    this.env = env;
  }
}

function makeStorage() {
  let values = new Map<string, unknown>();
  return {
    values,
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value); },
    },
  };
}

async function loadStarter(slug: StarterSlug, env: Record<string, unknown> = {}) {
  let entry = FEATURED_BLUEPRINTS.find(candidate =>
    candidate.blueprintId === `starter.${slug}`);
  if (!entry) throw new Error(`Missing bundled starter ${slug}.`);
  let parsed = await parseBlueprintArchive(
      new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);
  let content = new Uint8Array(await new Response(parsed.content).arrayBuffer());
  let source = (await readInstalledFiles(content))["server.js"];
  if (!source) throw new Error(`Bundled starter ${slug} has no server.js.`);
  source = source
      .replace(/^import \{ DurableObject \} from "cloudflare:workers";\n/u, "")
      .replace("export class Gadget extends DurableObject", "class Gadget extends DurableObject");
  let Gadget = new Function("DurableObject", `${source}\nreturn Gadget;`)(MockDurableObject) as {
    new(ctx: unknown, env: Record<string, unknown>): StarterGadget;
  };
  let {storage, values} = makeStorage();
  return { gadget: new Gadget({storage}, env), values };
}

function fakeCursor<T>(items: T[]) {
  let disposed = false;
  let nextCalls = 0;
  let served = false;
  let cursor = {
    async next() {
      nextCalls++;
      if (served) return null;
      served = true;
      return items;
    },
    [Symbol.dispose]() {
      disposed = true;
    },
  };
  return { cursor, stats: () => ({disposed, nextCalls}) };
}

const starterSlugs: StarterSlug[] = [
  "developer-delivery-kit",
  "finance-operations-workbench",
  "incident-investigation-board",
  "jira-delivery-risk",
  "support-escalation-cockpit",
];

describe("bundled format blueprints", () => {
  it("bundles support document formats with curated metadata and fact-grounding hints", () => {
    let expectedSupportFormats = [
      {
        blueprintId: "format.support.engineering-escalation",
        title: "Engineering Escalation",
        noun: "Escalation",
        plural: "Escalations",
        icon: "flowArrow",
      },
      {
        blueprintId: "format.support.customer-impact-brief",
        title: "Customer Impact Brief",
        noun: "Brief",
        plural: "Briefs",
        icon: "fileText",
      },
      {
        blueprintId: "format.support.handoff",
        title: "Support Handoff",
        noun: "Handoff",
        plural: "Handoffs",
        icon: "listChecks",
      },
      {
        blueprintId: "format.support.incident-rca-summary",
        title: "Incident/RCA Summary",
        noun: "RCA",
        plural: "RCAs",
        icon: "notebook",
      },
      {
        blueprintId: "format.support.weekly-digest",
        title: "Weekly Support Digest",
        noun: "Digest",
        plural: "Digests",
        icon: "chartBar",
      },
    ];

    for (let expected of expectedSupportFormats) {
      let entry = FORMAT_BLUEPRINTS.find(format => format.blueprintId === expected.blueprintId);
      expect(entry, expected.blueprintId).toBeDefined();
      expect(entry).toMatchObject({
        title: expected.title,
        output: {
          id: "document",
          noun: expected.noun,
          plural: expected.plural,
          icon: expected.icon,
        },
        author: {type: "user", name: "Cloudflare", id: "agent@cloudflare.com"},
      });
      expect(entry!.description, expected.blueprintId).toMatch(/facts?/iu);
      expect(entry!.description, expected.blueprintId).toMatch(/customer claims?/iu);
      expect(entry!.description, expected.blueprintId).toMatch(/deductions?/iu);
      expect(entry!.description, expected.blueprintId).toMatch(/unknowns?/iu);
      expect(entry!.description, expected.blueprintId).toMatch(/provenance/iu);
    }
  });

  it("installs every manifest entry as an ordinary blueprint", async () => {
    let {kv, r2, env} = makeEnv();

    let installed = await installFormatBlueprints(env);

    expect(installed).toHaveLength(FORMAT_BLUEPRINTS.length);
    for (let entry of FORMAT_BLUEPRINTS) {
      let raw = kv.get(entry.blueprintId);
      expect(raw, `${entry.blueprintId} metadata`).toBeDefined();

      let record = parseBlueprintKvRecord(raw!);
      // No owning user: these belong to the deployment, so the owner-anchored featured toggle
      // must not apply to them.
      expect(record.ownerId).toBeUndefined();
      // Presentation comes from the sidecar, not from whatever the archive was called in the
      // workspace it was exported from.
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      // The sidecar's declaration is written into the installed blueprint, so from here on the
      // blueprint declares its own format like any other.
      expect(record.metadata.output).toEqual(entry.output);
      // ...and it survives the same validation an uploaded archive's would.
      expect(sanitizeBlueprintOutput(record.metadata.output)).toEqual(entry.output);

      // Content lands where readBlueprintContent() looks for it.
      let content = r2.get(`${entry.blueprintId}/${record.metadata.version}`);
      expect(content, `${entry.blueprintId} content`).toBeDefined();
      expect(content!.byteLength).toBeGreaterThan(0);
    }
  });

  it("ships print layouts for every standard output format", async () => {
    for (let entry of FORMAT_BLUEPRINTS) {
      expect(await readBlueprintFile(entry, "client.js"), entry.blueprintId)
        .toContain("@media print");
    }
  });

  it("renders document HTML and PDF exports without the editor chrome", async () => {
    let entry = FORMAT_BLUEPRINTS.find(blueprint => blueprint.blueprintId === "format.document")!;
    let client = await readBlueprintFile(entry, "client.js");

    expect(client).toContain('["html", "pdf"].includes(globalThis.gadgetExportFormatId)');
    expect(client).toContain('document.documentElement.classList.add("document-export")');
    expect(client).toContain("app.replaceChildren(canvas)");
  });

  it("declares the intended export formats for every standard output format", async () => {
    let expectedFormats: Record<string, string[]> = {
      "format.document": [
        'id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown"',
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.slides": [
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.spreadsheet": [
        'const CSV_FORMAT_PREFIX = "csv:"',
        'mode: "server"',
        'contentType: "text/csv"',
      ],
    };

    for (let entry of FORMAT_BLUEPRINTS) {
      let serverCode = await readBlueprintFile(entry, "server.js");
      expect(serverCode, entry.blueprintId).toContain("export class ExportHandler");
      for (let declaration of expectedFormats[entry.blueprintId] ?? []) {
        expect(serverCode, `${entry.blueprintId}: ${declaration}`).toContain(declaration);
      }
    }
  });

  // Skipped when the deployment bundles nothing, which FORMAT_BLUEPRINTS_DIR makes a supported
  // configuration rather than a broken checkout.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when an entry's revision changes", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();
    expect(before).toContain(entry.blueprintId);

    let original = entry.revision;
    try {
      entry.revision = original + 1;
      expect(formatBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.revision = original;
    }
  });

  // Curated text is the input most likely to be edited -- it is the whole point of keeping it in a
  // text file -- and an edit that doesn't reach deployments which already installed would be
  // invisible: the build succeeds and the old wording stays put.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when curated presentation changes, with no revision bump", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();

    for (let mutate of [
      () => { entry.description += " Now with more detail."; },
      () => { entry.title += " (Beta)"; },
      () => { entry.output = {...entry.output, noun: "Document"}; },
    ]) {
      let restore = {...entry};
      try {
        mutate();
        expect(formatBlueprintsManifestVersion()).not.toBe(before);
        expect(entry.revision).toBe(restore.revision);
      } finally {
        Object.assign(entry, restore);
      }
    }

    expect(formatBlueprintsManifestVersion()).toBe(before);
  });
});

describe("bundled featured starter blueprints", () => {
  it("packages repository starter sources into installable archives", async () => {
    for (let entry of FEATURED_BLUEPRINTS) {
      let {metadata, content} = await parseBlueprintArchive(
          new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);
      let compressed = new Uint8Array(await new Response(content).arrayBuffer());
      let files = await readInstalledFiles(compressed);

      expect(metadata.version, entry.blueprintId).toBe(entry.revision);

      // Both dates come from the sidecar's explicit `updatedAt`, so they agree exactly and are a
      // canonical UTC instant. Asserting the invariant rather than one literal date matters because
      // the documented workflow is to update `updatedAt` per starter as its archive changes -- a
      // pinned literal would fail the moment somebody follows it for a single directory. The year
      // check is what catches a regression to the old behaviour, which derived the date from
      // `revision` and so produced 1970.
      let created = metadata.created.toISOString();
      expect(created, entry.blueprintId).toBe(metadata.lastUpdated.toISOString());
      expect(created, entry.blueprintId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(metadata.created.getUTCFullYear(), entry.blueprintId).toBeGreaterThan(2000);
      expect(files["README.md"], entry.blueprintId).toBeDefined();
      expect(files["client.js"], entry.blueprintId).toBeDefined();
      expect(files["server.js"], entry.blueprintId).toBeDefined();
    }
  });

  it("installs as an ownerless ordinary featured blueprint with source roundtrip", async () => {
    let files = {
      "README.md": "# Starter\n",
      "client.js": "document.body.textContent = 'hello';\n",
      "server.js": "export class Gadget {}\n",
    };
    let entry = {
      blueprintId: "starter.test-roundtrip",
      title: "Curated Starter",
      description: "Curated description wins.",
      author: {type: "user" as const, name: "Bundler", id: "starter@example.com"},
      revision: 7,
      archive: await makeArchive(files, {
        title: "Archive Title",
        description: "Archive description loses.",
        author: {type: "user", name: "Archive", id: "archive@example.com"},
        created: "1970-01-01T00:00:00.000Z",
        version: 7,
        lastUpdated: "1970-01-01T00:00:07.000Z",
        bindings: {},
        output: {id: "doc", noun: "Doc", plural: "Docs", icon: "fileText"},
      }),
    };

    await withFeaturedEntry(entry, async () => {
      let {kv, r2, env} = makeEnv();
      let installed = await installFeaturedBlueprints(env);

      expect(installed.some(publicInfo => publicInfo.id === entry.blueprintId)).toBe(true);
      expect(FORMAT_BLUEPRINTS.some(format => format.blueprintId === entry.blueprintId)).toBe(false);

      let record = parseBlueprintKvRecord(kv.get(entry.blueprintId)!);
      expect(record.ownerId).toBeUndefined();
      expect(record.gadgetId).toBeUndefined();
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      expect(record.metadata.output).toBeUndefined();

      let content = r2.get(`${entry.blueprintId}/${record.metadata.version}`)!;
      expect(await readInstalledFiles(content)).toEqual(files);
    });
  });

  it("installs protected Finance content but excludes it from global featured discovery", async () => {
    let {kv, env} = makeEnv();
    let installed = await installFeaturedBlueprints(env);
    let financeId = "starter.finance-operations-workbench";

    expect(installed.some(({id}) => id === financeId)).toBe(true);
    expect(kv.has(financeId)).toBe(true);
    kv.set(FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints(installed));

    let discoverable = await listFeaturedBlueprintsFromKv(env);
    expect(discoverable.some(({id}) => id === financeId)).toBe(false);
    expect(discoverable.some(({id}) => id === "starter.developer-delivery-kit")).toBe(true);
  });

  it("changes the featured fingerprint on starter metadata or revision changes", async () => {
    let entry = {
      blueprintId: "starter.test-fingerprint",
      title: "Fingerprint Starter",
      description: "Original",
      author: {type: "user" as const, name: "Bundler", id: "starter@example.com"},
      revision: 1,
      archive: await makeArchive({"README.md": "", "client.js": "", "server.js": ""}, {
        title: "Fingerprint Starter",
        description: "Original",
        author: {type: "user", name: "Bundler", id: "starter@example.com"},
        created: "1970-01-01T00:00:00.000Z",
        version: 1,
        lastUpdated: "1970-01-01T00:00:01.000Z",
        bindings: {},
      }),
    };

    await withFeaturedEntry(entry, async () => {
      let before = featuredBlueprintsManifestVersion();
      entry.description = "Changed";
      expect(featuredBlueprintsManifestVersion()).not.toBe(before);
      entry.description = "Original";
      entry.revision = 2;
      expect(featuredBlueprintsManifestVersion()).not.toBe(before);
      expect(formatBlueprintsManifestVersion()).not.toContain(entry.blueprintId);
    });
  });

  it("featured mirror serialization preserves existing featured entries", () => {
    let existing = [{
      id: "user.featured",
      metadata: {
        title: "User Featured",
        description: "Already there",
        author: {type: "user" as const, name: "User", id: "user@example.com"},
        created: new Date("2026-01-01T00:00:00.000Z"),
        version: 1,
        lastUpdated: new Date("2026-01-01T00:00:00.000Z"),
        bindings: {},
      },
    }];
    let bundled = [{...existing[0]}, {id: "starter.new", metadata: {...existing[0].metadata, title: "New"}}];
    let parsed = parseFeaturedBlueprints(serializeFeaturedBlueprints(bundled));

    expect(parsed.map(entry => entry.id)).toEqual(["user.featured", "starter.new"]);
    expect(parsed[0].metadata.title).toBe("User Featured");
    expect(FEATURED_BLUEPRINTS_KEY).toBe(".featured");
  });
});

describe("featured starter server runtime smoke tests", () => {
  it("instantiates every starter and returns disconnected onboarding state", async () => {
    for (let slug of starterSlugs) {
      let {gadget} = await loadStarter(slug);

      let state = await gadget.getState() as {
        skippedConnectors?: unknown;
        skippedSources?: unknown;
        connectors?: unknown[];
        sources?: unknown[];
      };
      expect(state.skippedConnectors ?? state.skippedSources, slug).toBeDefined();

      let connectors = "listConnectors" in gadget
          ? await gadget.listConnectors()
          : (state.connectors ?? state.sources);
      expect(connectors, slug).toEqual(expect.arrayContaining([
        expect.objectContaining({status: expect.stringMatching(/missing|Missing/u)}),
      ]));
    }
  });

  it("detects the representative optional bindings the starters actually consume", async () => {
    let representativeEnv = {
      GITHUB_REPO: {},
      GMAIL_INBOX: {},
      LINEAR_WORKSPACE: {},
      JIRA_SITE: {},
      ZENDESK: {},
      JARVIS: {},
      GOOGLE_SHEET: {},
      GOOGLE_DOC: {},
      GMAIL_SEARCH: {},
      SCHEDULER: {},
    };

    for (let slug of starterSlugs) {
      let {gadget} = await loadStarter(slug, representativeEnv);
      let state = await gadget.getState() as {
        connectors?: Array<{key: string}>;
        sources?: Array<{key: string}>;
      };
      let connectors = "listConnectors" in gadget
          ? await gadget.listConnectors()
          : (state.connectors ?? state.sources);
      let byKey = new Map((connectors as Array<{key: string, status: string, bindingName?: string | null}>).map(c => [c.key, c]));

      for (let key of Object.keys(representativeEnv)) {
        if (byKey.has(key)) expect(byKey.get(key)?.status, `${slug}:${key}`).toMatch(/connected|Connected/u);
      }
    }
  });

  it("bounds manual imports and preserves demo lifecycle for record-based starters", async () => {
    let incident = await loadStarter("incident-investigation-board");
    let incidentImport = await incident.gadget.importRecords(
        Array.from({length: 175}, (_, index) => ({title: `incident ${index}`, tags: Array(20).fill("tag")}))) as {
      imported: number;
      state: {records: Array<{tags: string[]}>};
    };
    expect(incidentImport.imported).toBe(100);
    expect(incidentImport.state.records).toHaveLength(104);
    expect(incidentImport.state.records[0].tags).toHaveLength(12);
    await incident.gadget.setConnectorSkipped("GITHUB", true);
    let incidentReset = await incident.gadget.resetDemo() as {skippedConnectors: string[], records: unknown[]};
    expect(incidentReset.skippedConnectors).toEqual([]);
    expect(incidentReset.records).toHaveLength(4);

    let delivery = await loadStarter("developer-delivery-kit");
    let deliveryImport = await delivery.gadget.importItems(
        Array.from({length: 250}, (_, index) => ({title: `delivery ${index}`, labels: Array(30).fill("label")}))) as {
      imported: number;
      state: {items: Array<{labels: string[]}>};
    };
    expect(deliveryImport.imported).toBe(120);
    expect(deliveryImport.state.items).toHaveLength(124);
    expect(deliveryImport.state.items[0].labels).toHaveLength(16);
    await delivery.gadget.setConnectorSkipped("GITHUB", true);
    let deliveryReset = await delivery.gadget.resetDemo() as {skippedConnectors: string[], items: unknown[]};
    expect(deliveryReset.skippedConnectors).toEqual([]);
    expect(deliveryReset.items).toHaveLength(4);
  });

  it("bounds manual save/import values and demo lifecycle for sync-based starters", async () => {
    let support = await loadStarter("support-escalation-cockpit");
    let longTitle = "x".repeat(300);
    let supportSaved = await support.gadget.saveRecord({
      title: longTitle,
      impact: 250,
      tags: Array(20).fill("tag"),
    }) as {records: Array<{title: string, impact: number, tags: string[]}>};
    expect(supportSaved.records[0].title).toHaveLength(160);
    expect(supportSaved.records[0].impact).toBe(100);
    expect(supportSaved.records[0].tags).toHaveLength(12);
    await support.gadget.importText(JSON.stringify([{title: "imported"}]), "json");
    expect((await support.gadget.loadDemo() as {records: unknown[]}).records).toHaveLength(6);
    expect((await support.gadget.resetDemo() as {records: unknown[]}).records).toHaveLength(4);

    let jira = await loadStarter("jira-delivery-risk");
    let jiraSaved = await jira.gadget.saveRecord({
      title: longTitle,
      probability: 150,
      impact: -10,
      tags: Array(20).fill("tag"),
    }) as {records: Array<{title: string, probability: number, impact: number, tags: string[]}>};
    expect(jiraSaved.records[0].title).toHaveLength(180);
    expect(jiraSaved.records[0].probability).toBe(100);
    expect(jiraSaved.records[0].impact).toBe(0);
    expect(jiraSaved.records[0].tags).toHaveLength(12);
    await jira.gadget.importText("title,program\nCSV risk,Program", "csv");
    expect((await jira.gadget.resetDemo() as {records: unknown[]}).records).toHaveLength(4);
  });

  it("keeps finance imports and empty workspaces stable across demo lifecycle operations", async () => {
    let finance = await loadStarter("finance-operations-workbench");
    let initial = (await finance.gadget.getState()) as {
      financeRows: Array<{ id: string }>;
      contracts: Array<{ id: string }>;
      forecasts: Array<{ id: string }>;
    };
    expect(initial.financeRows).toHaveLength(5);

    for (let record of initial.financeRows) await finance.gadget.deleteFinanceRow(record.id);
    for (let record of initial.contracts) await finance.gadget.deleteContractFinding(record.id);
    for (let record of initial.forecasts) await finance.gadget.deleteForecastRecord(record.id);
    let empty = (await finance.gadget.getState()) as {
      financeRows: unknown[];
      contracts: unknown[];
      forecasts: unknown[];
    };
    expect(empty).toMatchObject({ financeRows: [], contracts: [], forecasts: [] });

    let imported = (await finance.gadget.importDataset(
      "finance",
      JSON.stringify([
        {
          id: "demo-custom",
          period: "Jul 2026",
          entity: "Corporate",
          account: "Travel",
          actual: 10,
          budget: 10,
        },
        {
          id: "demo-fin-1",
          period: "Jul 2026",
          entity: "Corporate",
          account: "Reserved identity",
          actual: 15,
          budget: 15,
        },
        {
          id: "same-id",
          period: "Jul 2026",
          entity: "Corporate",
          account: "Travel",
          actual: 20,
          budget: 20,
        },
        {
          id: "same-id",
          period: "Aug 2026",
          entity: "Corporate",
          account: "Travel",
          actual: 30,
          budget: 30,
        },
      ]),
      "json",
    )) as {
      imported: number;
      state: {
        financeRows: Array<{ id: string; period: string }>;
        anomalies: Array<{ kind: string }>;
      };
    };
    expect(imported.imported).toBe(3);
    expect(imported.state.financeRows).toHaveLength(3);
    expect(imported.state.financeRows.some((row) => row.id === "demo-custom")).toBe(true);
    expect(imported.state.financeRows.some((row) => row.id === "demo-fin-1")).toBe(false);
    expect(imported.state.financeRows.find((row) => row.id === "same-id")?.period).toBe("2026-08");
    expect(imported.state.anomalies.some((item) => item.kind === "actual-spike-large-miss")).toBe(
      true,
    );

    let refreshed = (await finance.gadget.refreshDemoData()) as {
      financeRows: Array<{ id: string; source: string }>;
    };
    expect(
      refreshed.financeRows.some((row) => row.source === "import" && row.id === "demo-custom"),
    ).toBe(true);
    expect(refreshed.financeRows.filter((row) => row.source === "import")).toHaveLength(3);
  });

  it("does not let finance demo refresh remove user records or evict them at capacity", async () => {
    let finance = await loadStarter("finance-operations-workbench");
    let initial = (await finance.gadget.getState()) as { financeRows: Array<{ id: string }> };
    for (let record of initial.financeRows) await finance.gadget.deleteFinanceRow(record.id);

    await finance.gadget.saveFinanceRow({
      id: "manual-demo-source",
      period: "2026-08",
      entity: "Corporate",
      account: "Manual row",
      actual: 1,
      budget: 1,
      source: "demo",
    });
    await finance.gadget.importDataset(
      "finance",
      JSON.stringify(
        Array.from({ length: 200 }, (_, index) => ({
          id: `capacity-a-${index}`,
          period: "2026-08",
          entity: "Corporate",
          account: `Imported A ${index}`,
          actual: index,
          budget: index,
        })),
      ),
      "json",
    );
    await finance.gadget.importDataset(
      "finance",
      JSON.stringify(
        Array.from({ length: 99 }, (_, index) => ({
          id: `capacity-b-${index}`,
          period: "2026-08",
          entity: "Corporate",
          account: `Imported B ${index}`,
          actual: index,
          budget: index,
        })),
      ),
      "json",
    );

    let refreshed = (await finance.gadget.refreshDemoData()) as {
      financeRows: Array<{ id: string }>;
    };
    expect(refreshed.financeRows).toHaveLength(300);
    expect(refreshed.financeRows.some((row) => row.id === "manual-demo-source")).toBe(true);
    expect(refreshed.financeRows.some((row) => row.id.startsWith("demo-fin-"))).toBe(false);
  });

  it("normalizes support escalation anchor fields from JSON and CSV imports", async () => {
    let support = await loadStarter("support-escalation-cockpit");

    let jsonImport = await support.gadget.importText(JSON.stringify({records: [{
      title: "Catalyst renewal blocked by <script>alert(1)</script>",
      accountName: "Acme Global",
      brand: "Catalyst",
      zendeskTicketUrl: "https://acme.zendesk.com/agent/tickets/123",
      ticketId: "ZD-123",
      accountId: "acct-42",
      jiraIssue: "ENG-77",
      sla: "breached",
      slaDeadline: "2026-08-21T12:00:00.000Z",
      lastCustomerTouchAt: "2026-08-20",
      followUpDate: "2026-08-22",
      resolutionEvidence: "Patch deployed and customer confirmed.",
      handoff: "engineering",
      confidence: 1.5,
      provenance: ["zendesk:123", "pi:summary"],
      sourceUrl: "https://pi.example/escalations/123",
    }]}), "json") as {state: {records: Array<{
      brand: string;
      customer: string;
      customerRef: string;
      zendeskLinks: string[];
      engineeringLinks: string[];
      slaState: string;
      slaDeadline: string;
      lastCustomerTouch: string;
      followUpDate: string;
      resolutionEvidence: string;
      handoffState: string;
      confidence: number;
      sourceRefs: string[];
      title: string;
    }>}};
    let jsonRecord = jsonImport.state.records[0];
    expect(jsonRecord).toMatchObject({
      brand: "catalyst",
      customer: "Acme Global",
      customerRef: "acct-42",
      zendeskLinks: ["https://acme.zendesk.com/agent/tickets/123", "ZD-123"],
      engineeringLinks: ["ENG-77"],
      slaState: "breached",
      slaDeadline: "2026-08-21T12:00:00.000Z",
      lastCustomerTouch: "2026-08-20",
      followUpDate: "2026-08-22",
      resolutionEvidence: "Patch deployed and customer confirmed.",
      handoffState: "engineering",
      confidence: 1,
      sourceRefs: ["zendesk:123", "pi:summary", "https://pi.example/escalations/123"],
    });
    expect(jsonRecord.title).toContain("<script>");

    let csvImport = await support.gadget.importText(
        "subject,brand,ticket_url,native_link,account_ref,eng_issue,sla_state,confidence,source_ref\n" +
        "Totango issue,totango,https://zd/t/999,https://native/t/999,account-9,GH-99,at risk,0.64,export:row-1",
        "csv") as {state: {records: Array<{brand: string, customerRef: string, zendeskLinks: string[], engineeringLinks: string[], slaState: string, confidence: number, sourceRefs: string[]}>}};
    let csvRecord = csvImport.state.records[0];
    expect(csvRecord.brand).toBe("totango");
    expect(csvRecord.customerRef).toBe("account-9");
    expect(csvRecord.zendeskLinks).toEqual(["https://zd/t/999", "https://native/t/999"]);
    expect(csvRecord.engineeringLinks).toEqual(["GH-99"]);
    expect(csvRecord.slaState).toBe("at-risk");
    expect(csvRecord.confidence).toBe(0.64);
    expect(csvRecord.sourceRefs).toEqual(["export:row-1"]);
  });

  it("exercises sourceSnapshot with fake cursor/RPC stubs and disposes cursor results", async () => {
    for (let slug of ["developer-delivery-kit", "incident-investigation-board"] as const) {
      let prs = fakeCursor([{title: "PR needs review"}]);
      let issues = fakeCursor([{title: "Issue is blocked"}]);
      let githubCalls = 0;
      let {gadget} = await loadStarter(slug, {
        GITHUB_REPO: {
          getMetadata: async () => ({fullName: "acme/repo"}),
          listPullRequests: async () => { githubCalls++; return prs.cursor; },
          listIssues: async () => { githubCalls++; return issues.cursor; },
        },
        JARVIS: {},
      });

      let snapshot = await gadget.sourceSnapshot() as {live: {notes: string[]}};
      expect(snapshot.live.notes.join("\n"), slug).toContain("JARVIS");
      expect(githubCalls, slug).toBe(2);
      expect(prs.stats()).toMatchObject({disposed: true, nextCalls: 2});
      expect(issues.stats()).toMatchObject({disposed: true, nextCalls: 2});
    }
  });

  it("does not read a connected snapshot source after the user skips it", async () => {
    for (let slug of ["developer-delivery-kit", "incident-investigation-board"] as const) {
      let calls = 0;
      let {gadget} = await loadStarter(slug, {
        GITHUB_REPO: {
          getMetadata: async () => { calls++; throw new Error("Skipped GitHub was queried"); },
          listPullRequests: async () => { calls++; throw new Error("Skipped GitHub was queried"); },
          listIssues: async () => { calls++; throw new Error("Skipped GitHub was queried"); },
        },
      });
      await gadget.setConnectorSkipped("GITHUB_REPO", true);

      let snapshot = await gadget.sourceSnapshot() as {
        live: {repository: unknown, notes: string[]};
      };

      expect(calls, slug).toBe(0);
      expect(snapshot.live.repository, slug).toBeNull();
      expect(snapshot.live.notes.join("\n"), slug).not.toContain("GITHUB_REPO");
    }
  });

  it("exercises connector sync with fake RPC stubs without fabricating disconnected data", async () => {
    let support = await loadStarter("support-escalation-cockpit", {
      GMAIL_INBOX: {listThreads: async () => fakeCursor([{
        info: {id: "mail-1", subject: "Escalation mail", snippet: "Acme needs help"},
        thread: {[Symbol.dispose]() {}},
      }]).cursor},
      LINEAR_WORKSPACE: {listIssues: async () => fakeCursor([{
        id: "lin-1", title: "Linear escalation", team: {name: "Beta"},
      }]).cursor},
      ZENDESK: {searchTickets: async () => ({items: [{
        id: "zd-1", title: "Zendesk escalation", customer: "Acme",
      }]})},
    });
    let supportSync = await support.gadget.syncSources() as {results: Array<{key: string, imported: number}>, state: {records: unknown[]}};
    expect(supportSync.results.find(result => result.key === "GMAIL_INBOX")?.imported).toBe(1);
    expect(supportSync.results.find(result => result.key === "LINEAR_WORKSPACE")?.imported).toBe(1);
    expect(supportSync.results.find(result => result.key === "ZENDESK")?.imported).toBe(1);
    expect(supportSync.results.find(result => result.key === "JARVIS")?.imported).toBe(0);
    expect(supportSync.state.records).toHaveLength(3);
    expect((await support.gadget.syncSources() as {state: {records: unknown[]}}).state.records)
        .toHaveLength(3);

    let jira = await loadStarter("jira-delivery-risk", {
      GITHUB_REPO: {
        listIssues: async () => fakeCursor([{id: "gh-issue", title: "Failing check"}]).cursor,
        listPullRequests: async () => fakeCursor([{id: "gh-pr", title: "PR needs review"}]).cursor,
      },
      LINEAR_WORKSPACE: {listIssues: async () => fakeCursor([{
        id: "lin-2", title: "Blocked issue",
      }]).cursor},
    });
    let jiraSync = await jira.gadget.syncSources() as {results: Array<{key: string, imported: number}>, state: {records: unknown[]}};
    expect(jiraSync.results.find(result => result.key === "GITHUB_REPO")?.imported).toBe(2);
    expect(jiraSync.results.find(result => result.key === "LINEAR_WORKSPACE")?.imported).toBe(1);
    expect(jiraSync.results.find(result => result.key === "GMAIL_INBOX")?.imported).toBe(0);
    expect(jiraSync.state.records).toHaveLength(3);
    expect((await jira.gadget.syncSources() as {state: {records: unknown[]}}).state.records)
        .toHaveLength(3);
  });

  it("does not read a connected source after the user skips it", async () => {
    for (let slug of ["support-escalation-cockpit", "jira-delivery-risk"] as const) {
      let calls = 0;
      let {gadget} = await loadStarter(slug, {
        LINEAR_WORKSPACE: {
          listIssues: async () => {
            calls++;
            throw new Error("Skipped connector was queried");
          },
        },
      });
      await gadget.setConnectorSkipped("LINEAR_WORKSPACE", true);

      let sync = await gadget.syncSources() as {results: Array<{key: string, status: string}>};

      expect(calls, slug).toBe(0);
      expect(sync.results.find(result => result.key === "LINEAR_WORKSPACE")?.status, slug)
          .toBe("skipped");
    }
  });

  it("keeps finance getState presence-only and blocks skipped explicit reads", async () => {
    let calls = 0;
    let env = {
      GOOGLE_SHEET: {
        getSpreadsheet: async () => {
          calls++;
          throw new Error("unexpected Sheet read");
        },
        readRange: async () => {
          calls++;
          throw new Error("unexpected Sheet read");
        },
      },
      GOOGLE_DOC: {
        getMetadata: async () => {
          calls++;
          throw new Error("unexpected Doc read");
        },
        getContent: async () => {
          calls++;
          throw new Error("unexpected Doc read");
        },
      },
      GMAIL_SEARCH: {
        listThreads: async () => {
          calls++;
          throw new Error("unexpected Gmail read");
        },
      },
    };
    let { gadget } = await loadStarter("finance-operations-workbench", env);

    let state = (await gadget.getState()) as { sources: Array<{ status: string }> };
    expect(state.sources.filter((source) => source.status === "connected-not-read")).toHaveLength(
      3,
    );
    expect(calls).toBe(0);

    for (let key of ["GOOGLE_SHEET", "GOOGLE_DOC", "GMAIL_SEARCH"]) {
      await gadget.setSourceSkipped(key, true);
    }
    await expect(
      gadget.previewGoogleSheetRange({ dataset: "finance", range: "A1:B2" }),
    ).rejects.toThrow(/skipped/iu);
    await expect(gadget.captureGoogleDocEvidence()).rejects.toThrow(/skipped/iu);
    await expect(gadget.captureGmailEvidence()).rejects.toThrow(/skipped/iu);
    expect(calls).toBe(0);
  });

  it("keeps finance record timestamps stable except for the targeted mutation", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-26T20:00:00.000Z"));
      let { gadget } = await loadStarter("finance-operations-workbench");
      let initial = (await gadget.getState()) as {
        financeRows: Array<Record<string, unknown> & { id: string; updatedAt: string }>;
      };
      let targeted = initial.financeRows.find((row) => row.id === "demo-fin-1")!;
      let unrelated = initial.financeRows.find((row) => row.id === "demo-fin-2")!;

      vi.setSystemTime(new Date("2026-08-26T21:00:00.000Z"));
      let readAgain = (await gadget.getState()) as {
        financeRows: Array<{ id: string; updatedAt: string }>;
      };
      expect(readAgain.financeRows.find((row) => row.id === unrelated.id)?.updatedAt).toBe(
        unrelated.updatedAt,
      );

      let mutated = (await gadget.saveFinanceRow({ ...targeted, actual: 1300000 })) as {
        financeRows: Array<{ id: string; updatedAt: string }>;
      };
      expect(mutated.financeRows.find((row) => row.id === unrelated.id)?.updatedAt).toBe(
        unrelated.updatedAt,
      );
      expect(mutated.financeRows.find((row) => row.id === targeted.id)?.updatedAt).toBe(
        "2026-08-26T21:00:00.000Z",
      );
      expect(mutated.financeRows.find((row) => row.id === targeted.id)?.updatedAt).not.toBe(
        targeted.updatedAt,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("previews Sheets without persistence and imports mapped finance values with lineage", async () => {
    let calls = { metadata: 0, range: 0 };
    let { gadget } = await loadStarter("finance-operations-workbench", {
      GOOGLE_SHEET: {
        getSpreadsheet: async () => {
          calls.metadata++;
          return { id: "sheet-123", title: "Close Pack", sheets: [] };
        },
        readRange: async () => {
          calls.range++;
          return {
            range: "'Ops'!A1:H2",
            values: [
              [
                "Posting Period",
                "Legal Entity",
                "GL Account",
                "Actual Amount",
                "Approved Budget",
                "Latest Estimate",
                "Currency Code",
                "Evidence Ref",
              ],
              ["Jul 2026", "EMEA", "Hosting", "$1.2k", "(€200)", "50%", "EUR", "doc:close"],
            ],
          };
        },
      },
    });
    let before = (await gadget.getState()) as { financeRows: unknown[]; importBatches: unknown[] };

    let preview = (await gadget.previewGoogleSheetRange({
      dataset: "finance",
      range: "'Ops'!A1:H2",
      valueMode: "formatted",
    })) as {
      records: Array<Record<string, unknown>>;
      controlTotals: Array<Record<string, unknown>>;
    };
    let afterPreview = (await gadget.getState()) as {
      financeRows: unknown[];
      importBatches: unknown[];
    };
    expect(afterPreview.financeRows).toHaveLength(before.financeRows.length);
    expect(afterPreview.importBatches).toHaveLength(0);
    expect(preview.records[0]).toMatchObject({
      period: "2026-07",
      entity: "EMEA",
      account: "Hosting",
      actual: 1200,
      budget: -200,
      forecast: null,
      currency: "EUR",
    });
    expect(preview.controlTotals).toEqual([
      expect.objectContaining({ currency: "EUR", actual: 1200, budget: -200 }),
    ]);

    let imported = (await gadget.importGoogleSheetRange({
      dataset: "finance",
      range: "'Ops'!A1:H2",
      valueMode: "formatted",
    })) as {
      state: {
        financeRows: Array<{ account: string; sourceRefs: string[] }>;
        importBatches: Array<{
          sourceType: string;
          rowCount: number;
          acceptedCount: number;
          controlTotals: unknown[];
        }>;
      };
    };
    let row = imported.state.financeRows.find((item) => item.account === "Hosting")!;
    expect(row.sourceRefs).toEqual(
      expect.arrayContaining(["doc:close", "google-sheet:sheet-123:Close Pack:'Ops'!A1:H2:row:2"]),
    );
    expect(imported.state.importBatches[0]).toMatchObject({
      sourceType: "google-sheet",
      rowCount: 1,
      acceptedCount: 1,
      status: "needs-review",
    });
    expect(imported.state.importBatches[0].controlTotals).toEqual([
      expect.objectContaining({ currency: "EUR", actual: 1200, budget: -200 }),
    ]);
    expect(calls).toEqual({ metadata: 2, range: 2 });
  });

  it("upserts a changed Sheet row by stable source lineage", async () => {
    let actual = 1200;
    let idCell = "shared-external-id";
    let { gadget } = await loadStarter("finance-operations-workbench", {
      GOOGLE_SHEET: {
        getSpreadsheet: async () => ({ id: "sheet-upsert", title: "Close Pack" }),
        readRange: async () => ({
          range: "'Ops'!A1:E2",
          values: [
            ["id", "Posting Period", "Legal Entity", "GL Account", "Actual Amount"],
            [idCell, "Jul 2026", "EMEA", "Hosting", actual],
          ],
        }),
      },
    });
    await gadget.saveFinanceRow({
      id: "shared-external-id",
      period: "2026-07",
      entity: "EMEA",
      account: "Manual control row",
      actual: 55,
      source: "manual",
    });

    let first = (await gadget.importGoogleSheetRange({
      dataset: "finance",
      range: "'Ops'!A1:E2",
      valueMode: "raw",
    })) as { state: { financeRows: Array<{ id: string; account: string; actual: number; source: string; sourceRefs: string[] }> } };
    let sourceRef = "google-sheet:sheet-upsert:Close Pack:'Ops'!A1:E2:row:2";
    let firstRow = first.state.financeRows.find((row) => row.sourceRefs.includes(sourceRef))!;
    expect(firstRow.actual).toBe(1200);
    expect(firstRow.id).toMatch(/^google-sheet:finance:/u);
    expect(firstRow.id).not.toBe("shared-external-id");

    actual = 1400;
    idCell = "changed-external-id";
    let second = (await gadget.importGoogleSheetRange({
      dataset: "finance",
      range: "'Ops'!A1:E2",
      valueMode: "raw",
    })) as { state: { financeRows: Array<{ id: string; account: string; actual: number; source: string; sourceRefs: string[] }> } };
    let importedRows = second.state.financeRows.filter((row) => row.sourceRefs.includes(sourceRef));

    expect(importedRows).toHaveLength(1);
    expect(importedRows[0]).toMatchObject({ id: firstRow.id, actual: 1400 });
    expect(importedRows[0].id).not.toBe("changed-external-id");
    expect(second.state.financeRows.some((row) => row.actual === 1200 && row.sourceRefs.includes(sourceRef)))
        .toBe(false);
    expect(second.state.financeRows.find((row) => row.id === "shared-external-id")).toMatchObject({
      account: "Manual control row",
      actual: 55,
      source: "manual",
    });
  });

  it("uses the validated requested Sheet range for bounded data and stable lineage", async () => {
    let extraHeaders = Array.from({ length: 1000 }, (_, index) => `Injected ${index}`);
    let extraRows = Array.from({ length: 50 }, (_, index) => [
      `Injected account ${index}`,
      index + 1000,
      "EUR",
      ...extraHeaders.map(() => "injected"),
    ]);
    let { gadget } = await loadStarter("finance-operations-workbench", {
      GOOGLE_SHEET: {
        getSpreadsheet: async () => ({ id: "sheet-wide", title: "Untrusted response" }),
        readRange: async () => ({
          range: "A1:ZZ2",
          values: [
            ["GL Account", "Actual Amount", "Currency Code", ...extraHeaders],
            ["Hosting", 100, "EUR", ...extraHeaders.map(() => "injected")],
            ...extraRows,
          ],
        }),
      },
    });

    for (let range of ["FY2026!A1:B2", "'FY2026'!A1:B2"]) {
      let preview = (await gadget.previewGoogleSheetRange({
        dataset: "finance",
        range,
        valueMode: "raw",
      })) as {
        mapping: Array<{ header: string; field: string }>;
        records: Array<Record<string, unknown>>;
      };

      expect(preview.mapping).toEqual([
        { header: "GL Account", field: "account" },
        { header: "Actual Amount", field: "actual" },
      ]);
      expect(preview.records).toHaveLength(1);
      expect(preview.records[0]).toMatchObject({ account: "Hosting", actual: 100, currency: "USD" });

      let first = (await gadget.importGoogleSheetRange({
        dataset: "finance",
        range,
        valueMode: "raw",
      })) as {
        state: { financeRows: Array<{ id: string; account: string; sourceRefs: string[] }> };
      };
      let sourceRef = `google-sheet:sheet-wide:Untrusted response:${range}:row:2`;
      let firstRow = first.state.financeRows.find((row) => row.sourceRefs.includes(sourceRef))!;
      expect(firstRow.id).toMatch(/^google-sheet:finance:/u);
      expect(firstRow.sourceRefs.some((ref) => ref.includes("A1:ZZ2"))).toBe(false);
      expect(
        first.state.financeRows.some((row) => row.account.startsWith("Injected account")),
      ).toBe(false);

      let second = (await gadget.importGoogleSheetRange({
        dataset: "finance",
        range,
        valueMode: "raw",
      })) as {
        state: { financeRows: Array<{ id: string; sourceRefs: string[] }> };
      };
      let importedRows = second.state.financeRows.filter((row) => row.sourceRefs.includes(sourceRef));
      expect(importedRows).toHaveLength(1);
      expect(importedRows[0].id).toBe(firstRow.id);
    }
  });

  it("reports duplicate imports separately from true limit and capacity truncation", async () => {
    let duplicateFinance = await loadStarter("finance-operations-workbench");
    let duplicate = (await duplicateFinance.gadget.importDataset(
      "finance",
      JSON.stringify([
        { id: "duplicate-row", period: "2026-07", account: "Travel", actual: 10 },
        { id: "duplicate-row", period: "2026-08", account: "Travel", actual: 20 },
      ]),
      "json",
    )) as {
      imported: number;
      truncated: boolean;
      batch: {
        acceptedCount: number;
        duplicateCount: number;
        truncatedCount: number;
        warnings: string[];
      };
    };
    expect(duplicate).toMatchObject({
      imported: 1,
      truncated: false,
      batch: { acceptedCount: 1, duplicateCount: 1, truncatedCount: 0 },
    });
    expect(duplicate.batch.warnings.join(" ")).toMatch(/duplicate record ID/iu);
    expect(duplicate.batch.warnings.join(" ")).not.toMatch(/200-record import limit/iu);

    let limitFinance = await loadStarter("finance-operations-workbench");
    let limited = (await limitFinance.gadget.importDataset(
      "finance",
      JSON.stringify(
        Array.from({ length: 201 }, (_, index) => ({
          id: `limit-${index}`,
          period: "2026-08",
          account: `Limited ${index}`,
          actual: index,
        })),
      ),
      "json",
    )) as { imported: number; truncated: boolean; batch: { truncatedCount: number } };
    expect(limited).toMatchObject({ imported: 200, truncated: true, batch: { truncatedCount: 1 } });

    let capacityFinance = await loadStarter("finance-operations-workbench");
    await capacityFinance.gadget.importDataset(
      "finance",
      JSON.stringify(
        Array.from({ length: 200 }, (_, index) => ({
          id: `capacity-a-${index}`,
          period: "2026-08",
          account: `Capacity A ${index}`,
          actual: index,
        })),
      ),
      "json",
    );
    await capacityFinance.gadget.importDataset(
      "finance",
      JSON.stringify(
        Array.from({ length: 95 }, (_, index) => ({
          id: `capacity-b-${index}`,
          period: "2026-08",
          account: `Capacity B ${index}`,
          actual: index,
        })),
      ),
      "json",
    );
    let capacity = (await capacityFinance.gadget.importDataset(
      "finance",
      JSON.stringify([
        { id: "capacity-rejected", period: "2026-08", account: "Rejected", actual: 999 },
        { id: "capacity-a-0", period: "2026-08", account: "Accepted update", actual: 7 },
      ]),
      "json",
    )) as {
      imported: number;
      truncated: boolean;
      batch: {
        duplicateCount: number;
        truncatedCount: number;
        controlTotals: Array<{ actual: number }>;
      };
    };
    expect(capacity).toMatchObject({
      imported: 1,
      truncated: true,
      batch: { duplicateCount: 0, truncatedCount: 1 },
    });
    expect(capacity.batch.controlTotals).toEqual([expect.objectContaining({ actual: 7 })]);
  });

  it("does not persist malformed pasted imports or partial batches", async () => {
    let { gadget } = await loadStarter("finance-operations-workbench");
    let before = (await gadget.getState()) as { financeRows: unknown[]; importBatches: unknown[] };
    await expect(gadget.importDataset("finance", '[{"actual": 1}', "json")).rejects.toThrow();
    await expect(
      gadget.importDataset("finance", 'period,actual\n"2026-07,10', "csv"),
    ).rejects.toThrow(/unterminated/iu);
    let after = (await gadget.getState()) as { financeRows: unknown[]; importBatches: unknown[] };
    expect(after.financeRows).toHaveLength(before.financeRows.length);
    expect(after.importBatches).toHaveLength(before.importBatches.length);
  });

  it("captures bounded Google Doc and Gmail evidence only on explicit invocation", async () => {
    let docCalls = 0;
    let disposedThreads = 0;
    let gmail = fakeCursor(
      Array.from({ length: 25 }, (_, index) => ({
        info: { id: `thread-${index}`, subject: `Approval ${index}`, snippet: `Snippet ${index}` },
        thread: {
          [Symbol.dispose]() {
            disposedThreads++;
          },
        },
      })),
    );
    let { gadget } = await loadStarter("finance-operations-workbench", {
      GOOGLE_DOC: {
        getMetadata: async () => {
          docCalls++;
          return { title: "Close policy", lastModified: new Date("2026-08-20T12:00:00.000Z") };
        },
        getContent: async () => {
          docCalls++;
          return "x".repeat(5000);
        },
      },
      GMAIL_SEARCH: { listThreads: async () => gmail.cursor },
    });
    expect(docCalls).toBe(0);

    let doc = (await gadget.captureGoogleDocEvidence()) as {
      evidence: { summary: string; reference: string };
    };
    expect(docCalls).toBe(2);
    expect(doc.evidence.summary).toHaveLength(1500);
    expect(doc.evidence.reference).toContain("Close policy:modified:2026-08-20T12:00:00.000Z");

    let mail = (await gadget.captureGmailEvidence()) as {
      captured: number;
      state: {
        evidenceItems: Array<{
          sourceType: string;
          summary: string;
          reference: string;
        }>;
      };
    };
    expect(mail.captured).toBe(20);
    expect(mail.state.evidenceItems.filter((item) => item.sourceType === "gmail")).toHaveLength(20);
    expect(mail.state.evidenceItems.find((item) => item.sourceType === "gmail")).toMatchObject({
      summary: expect.stringMatching(/^Snippet/u),
      reference: expect.stringMatching(/^gmail-thread:/u),
    });
    expect(gmail.stats()).toMatchObject({ disposed: true, nextCalls: 1 });
    expect(disposedThreads).toBe(25);
  });

  it("bounds and normalizes evidence imports", async () => {
    let { gadget } = await loadStarter("finance-operations-workbench");
    let first = Array.from({ length: 100 }, (_, index) => ({
      id: `evidence-a-${index}`,
      title: `<script>${"x".repeat(250)}</script>`,
      sourceType: "not-valid",
      confidence: 9,
      tags: Array.from({ length: 30 }, (_, tagIndex) => `tag-${tagIndex}`),
      summary: "y".repeat(1800),
    }));
    let second = Array.from({ length: 200 }, (_, index) => ({
      id: `evidence-b-${index}`,
      title: `B ${index}`,
    }));
    await gadget.importDataset("evidence", JSON.stringify(first), "json");
    let result = (await gadget.importDataset("evidence", JSON.stringify(second), "json")) as {
      state: {
        evidenceItems: Array<{
          title: string;
          sourceType: string;
          confidence: number;
          tags: string[];
          summary: string;
        }>;
      };
    };
    expect(result.state.evidenceItems).toHaveLength(300);
    let imported = result.state.evidenceItems.find((item) => item.title.includes("<script>"))!;
    expect(imported.title.length).toBeLessThanOrEqual(180);
    expect(imported.sourceType).toBe("import");
    expect(imported.confidence).toBe(1);
    expect(imported.tags).toHaveLength(12);
    expect(imported.summary).toHaveLength(1500);
  });

  it("generates deterministic history averages without overwriting approved forecasts", async () => {
    let { gadget } = await loadStarter("finance-operations-workbench");
    for (let [id, period, account, actual] of [
      ["hist-1", "2026-01", "Travel", 100],
      ["hist-2", "2026-02", "Travel", 300],
      ["approved-hist-1", "2026-01", "Payroll", 1000],
      ["approved-hist-2", "2026-02", "Payroll", 1200],
    ])
      await gadget.saveFinanceRow({
        id,
        period,
        entity: "Corporate",
        account,
        actual,
        currency: "USD",
        sourceRefs: [`ledger:${id}`],
      });
    await gadget.saveForecastRecord({
      id: "approved-target",
      period: "2026-03",
      entity: "Corporate",
      lineItem: "Payroll",
      amount: 9999,
      currency: "USD",
      status: "approved",
    });
    await gadget.saveForecastRecord({
      id: "manual-target",
      period: "2026-03",
      entity: "Corporate",
      lineItem: "Travel",
      amount: 777,
      currency: "USD",
      scenario: "Manual downside",
      assumption: "Controller-entered assumption",
      owner: "Controller",
      status: "in-review",
      source: "manual",
    });

    let result = (await gadget.generateForecastBaselines({
      targetPeriod: "2026-03",
      lookbackPeriods: 2,
    })) as {
      generated: number;
      skipped: number;
      state: {
        forecasts: Array<{
          id: string;
          period: string;
          lineItem: string;
          amount: number;
          source: string;
          status: string;
          confidence: number;
          assumption: string;
          scenario: string;
          owner: string;
        }>;
      };
    };
    let baseline = result.state.forecasts.find(
      (item) => item.lineItem === "Travel" && item.source === "derived-baseline",
    )!;
    expect(baseline).toMatchObject({ amount: 200, status: "draft", confidence: 0.8 });
    expect(baseline.assumption).toContain("2026-02, 2026-01");
    expect(result.state.forecasts.find((item) => item.id === "manual-target")).toMatchObject({
      amount: 777,
      status: "in-review",
      scenario: "Manual downside",
      assumption: "Controller-entered assumption",
      owner: "Controller",
      source: "manual",
    });
    expect(
      result.state.forecasts.filter(
        (item) => item.lineItem === "Travel" && item.period === "2026-03",
      ),
    ).toHaveLength(2);
    expect(result.state.forecasts.find((item) => item.id === "approved-target")?.amount).toBe(9999);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("keeps prep, briefing, and reconciled batch review explicitly not certified", async () => {
    let { gadget } = await loadStarter("finance-operations-workbench");
    let imported = (await gadget.importDataset(
      "finance",
      JSON.stringify([
        {
          id: "review-row",
          period: "2026-08",
          entity: "Corporate",
          account: "Travel",
          actual: 100,
          budget: 80,
          currency: "USD",
        },
      ]),
      "json",
    )) as { state: { importBatches: Array<{ id: string }> } };
    let reviewed = (await gadget.updateImportBatchReview(imported.state.importBatches[0].id, {
      status: "reconciled",
      reviewer: "Controller",
      note: "Reviewed in workbench only",
      evidenceRefs: ["evidence:review"],
      acceptedCount: 999,
    })) as {
      readiness: { label: string };
      briefing: { label: string };
      briefingMarkdown: string;
      prepTasks: Array<{ id: string }>;
      importBatches: Array<{ status: string; acceptedCount: number }>;
    };
    expect(reviewed.importBatches[0]).toMatchObject({ status: "reconciled", acceptedCount: 1 });
    expect(reviewed.readiness.label).toBe("Draft / derived - not certified");
    expect(reviewed.briefing.label).toBe("Draft / derived - not certified");
    expect(reviewed.briefingMarkdown).toContain("Draft / derived - not certified");
    expect(reviewed.prepTasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "source:netsuite" })]),
    );
    expect(reviewed.prepTasks.some((task) => task.id.startsWith("import:"))).toBe(false);
  });
});
