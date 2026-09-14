import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";

const source = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(source, "../../../..");
const directory = mkdtempSync(resolve(tmpdir(), "odie-native-matrix-"));
const binary = resolve(root, "node_modules/.pnpm/@cloudflare+workerd-darwin-arm64@1.20260801.1/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd");
const hash = createHash("sha256").update(readFileSync(binary)).digest("hex");
if (hash !== "3da61644318c8fab32e68a504513865aef12329b1356d75d7e6f83a713ea9f7b") throw new Error("Unexpected workerd binary");
copyFileSync(binary, resolve(directory, "workerd"));
mkdirSync(resolve(directory, "storage"));
const sources = {};
for (const name of ["worker", "provider", "scenarios"]) {
  const text = readFileSync(resolve(source, `${name}.ts`), "utf8");
  sources[`${name}.ts`] = createHash("sha256").update(text).digest("hex");
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  writeFileSync(resolve(directory, `${name}.js`), output.replaceAll('"./provider"', '"./provider.js"').replaceAll('"./scenarios"', '"./scenarios.js"'));
}
writeFileSync(resolve(directory, "deny.js"), `export default {
  fetch() { throw new Error("MATRIX_EXTERNAL_EGRESS_DENIED"); },
  connect() { throw new Error("MATRIX_EXTERNAL_EGRESS_DENIED"); }
};\n`);
writeFileSync(resolve(directory, "config.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "storage", disk = (path = "${directory}/storage", writable = true)),
    (name = "internet", worker = (
      modules = [(name = "deny.js", esModule = embed "deny.js")],
      compatibilityDate = "2026-02-02",
      compatibilityFlags = ["nodejs_compat"],
      globalOutbound = "internet"
    )),
    (name = "matrix", worker = (
      modules = [
        (name = "worker.js", esModule = embed "worker.js"),
        (name = "provider.js", esModule = embed "provider.js"),
        (name = "scenarios.js", esModule = embed "scenarios.js")
      ],
      compatibilityDate = "2026-02-02",
      compatibilityFlags = ["nodejs_compat"],
      globalOutbound = "internet",
      bindings = [
        (name = "MATRIX_AUTHORITY", durableObjectNamespace = (className = "MatrixAuthority")),
        (name = "MATRIX_SERVICE", service = (name = "matrix", entrypoint = "MatrixService"))
      ],
      durableObjectNamespaces = [(className = "MatrixAuthority", uniqueKey = "local-matrix-only", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    ))
  ],
  sockets = [(name = "http", http = (), service = "matrix")]
);
`);
writeFileSync(resolve(directory, "sandbox.sb"), `(version 1)
(allow default)
(deny network*)
(allow network* (local ip "localhost:*") (remote ip "localhost:*"))
(deny file-read* file-write* (subpath "/Users/jacob_1"))
`);
writeFileSync(resolve(directory, "manifest.json"), JSON.stringify({ directory, binarySha256: hash, sources, compiler: ts.version }, null, 2));
process.stdout.write(`${directory}\n`);
