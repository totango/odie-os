import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUTOVER_EPOCH = 'polaris-git-ot-oauth-v1';
const CONTRACT_FILES = [
  'packages/workshop-shared/src/api.ts',
  'packages/workshop-shared/src/gatekeeper.ts',
  'packages/workshop-backend/src/editing-protocol.ts',
  'packages/workshop-backend/src/git-migration.ts',
  'packages/workshop-backend/src/connect-handoff.ts',
  'packages/gatekeeper-kit/src/connect-handshake.ts',
  'scripts/production-cutover.mjs',
  'scripts/build-production-deploy.mjs',
  '.github/workflows/deploy-production.yml',
];
const PREPARED_EVIDENCE = [
  'pauseFence', 'drain', 'backupRestore', 'clientRecovery', 'oauthMatrix',
  'catalogProvenance', 'deploymentHistory', 'migrationRehearsal',
];
const COMPLETED_EVIDENCE = [...PREPARED_EVIDENCE, 'deployedVersions', 'postDeployVerification'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`Production cutover gate: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);

/** Fingerprint the compatibility seam; changes require renewed completion evidence. */
export function contractDigest(root) {
  return hash(JSON.stringify(CONTRACT_FILES.map(path => [path, hash(readFileSync(join(root, path)))])));
}

/** Artifact builders can only produce a write-paused backend. No environment override is accepted. */
export function pauseBackendConfig(config) {
  return { ...config, vars: { ...config.vars, WORKSHOP_EDITING_PAUSED: 'true' } };
}

/** Deterministic inventory binds approval to all modules, assets and generated configs. */
export function artifactDigest(directory) {
  const entries = [];
  function visit(relative) {
    for (const name of readdirSync(join(directory, relative)).toSorted()) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === 'cutover-artifact.json') continue;
      const stat = lstatSync(join(directory, path));
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries.push([path, hash(readFileSync(join(directory, path)))]);
      else fail('artifact contains a symlink or non-regular file');
    }
  }
  visit('');
  return hash(JSON.stringify(entries));
}

/** Seal only paused artifacts. This descriptor is build provenance, never deployment approval. */
export function sealArtifact(directory, root, targetSha) {
  if (!hex(targetSha, 40)) fail('invalid target SHA');
  const config = JSON.parse(readFileSync(join(directory, 'workshop-backend/wrangler.json'), 'utf8'));
  if (config.vars?.WORKSHOP_EDITING_PAUSED !== 'true') fail('artifact backend must be paused');
  const descriptor = {
    schemaVersion: 1, epoch: CUTOVER_EPOCH, targetSha,
    contractSha256: contractDigest(root), artifactSha256: artifactDigest(directory),
  };
  writeFileSync(join(directory, 'cutover-artifact.json'), JSON.stringify(descriptor, null, 2) + '\n');
  return descriptor;
}

/** Validate operator attestations from the protected production environment, not candidate data. */
export function validateCutoverRecord(record, artifact, { phase, targetSha, isAncestor, now = Date.now() }) {
  if (!['prepare', 'resume', 'routine'].includes(phase)) fail('unknown phase');
  if (!object(artifact) || artifact.schemaVersion !== 1 || artifact.epoch !== CUTOVER_EPOCH ||
      artifact.targetSha !== targetSha || !hex(targetSha, 40) ||
      !hex(artifact.contractSha256, 64) || !hex(artifact.artifactSha256, 64)) fail('invalid artifact provenance');
  if (!object(record) || record.schemaVersion !== 1 || record.epoch !== CUTOVER_EPOCH ||
      record.deployment !== 'odie-os-production' || !hex(record.targetSha, 40) ||
      !hex(record.artifactSha256, 64) || record.contractSha256 !== artifact.contractSha256) {
    fail('missing or mismatched reviewed record');
  }
  if (record.status !== (phase === 'prepare' ? 'prepared' : 'completed')) fail('record status does not authorize phase');
  if (!Number.isInteger(record.orchestrationLoop) || record.orchestrationLoop < 1 || record.orchestrationLoop > 20) {
    fail('coordinator loop ledger must be within the 20-loop cap');
  }
  const reviewed = Date.parse(record.reviewedAt);
  if (!Number.isFinite(reviewed) || reviewed > now) fail('invalid review time');
  if (phase !== 'routine') {
    const expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(expires) || expires <= now || expires > reviewed + 24 * 60 * 60 * 1000 ||
        record.targetSha !== targetSha || record.artifactSha256 !== artifact.artifactSha256) {
      fail('first cutover requires fresh exact-target artifact approval');
    }
  } else if (!isAncestor(record.targetSha, targetSha)) {
    fail('completed cutover is not an ancestor of this release');
  }
  if (record.targetSha === targetSha && record.artifactSha256 !== artifact.artifactSha256) {
    fail('same-target artifact differs from the reviewed cutover');
  }
  const reviewLanes = ['K', 'F', 'C', 'T'];
  if (!object(record.reviews) || !reviewLanes.every(lane =>
    typeof record.reviews[lane] === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(record.reviews[lane]))) {
    fail('all four lane reviewer identifiers are required');
  }
  if (new Set(reviewLanes.map(lane => record.reviews[lane])).size < 2) fail('independent review is required');
  const requiredEvidence = record.status === 'prepared' ? PREPARED_EVIDENCE : [...COMPLETED_EVIDENCE];
  if (phase === 'routine') requiredEvidence.push('resumeReceipt');
  for (const name of requiredEvidence) {
    const evidence = record.evidence?.[name];
    if (!object(evidence) || !hex(evidence.sha256, 64) || typeof evidence.url !== 'string') fail(`missing ${name} evidence`);
    let url;
    try { url = new URL(evidence.url); } catch { fail(`invalid ${name} evidence URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`unsafe ${name} evidence URL`);
  }
  if (!hex(record.oldClientSha, 40) || !hex(record.recoveryClientSha, 40) ||
      !['pinned-old-client-export', 'preparatory-release'].includes(record.recoveryPath)) {
    fail('pinned old-client recovery evidence is required');
  }
  return { paused: phase === 'prepare' };
}

/** The only production-artifact unpause path; validates everything before writing the config. */
export function authorizeArtifact(directory, root, record, options) {
  const artifact = JSON.parse(readFileSync(join(directory, 'cutover-artifact.json'), 'utf8'));
  if (artifact.artifactSha256 !== artifactDigest(directory) || artifact.contractSha256 !== contractDigest(root)) {
    fail('artifact or compatibility contract changed after build');
  }
  const configPath = join(directory, 'workshop-backend/wrangler.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.vars?.WORKSHOP_EDITING_PAUSED !== 'true') fail('input artifact is not paused');
  const decision = validateCutoverRecord(record, artifact, options);
  if (!decision.paused) {
    delete config.vars.WORKSHOP_EDITING_PAUSED;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  return { ...artifact, phase: options.phase, paused: decision.paused, recordSha256: hash(JSON.stringify(record)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, phase, targetSha] = process.argv.slice(2);
    if (!directory || !phase || !targetSha || process.argv.length !== 5) fail('expected artifact directory, phase, target SHA');
    const raw = process.env.POLARIS_CUTOVER_RECORD;
    if (!raw || raw.length > 32768) fail('protected production POLARIS_CUTOVER_RECORD is required');
    const root = process.cwd();
    const receipt = authorizeArtifact(resolve(directory), root, JSON.parse(raw), {
      phase, targetSha,
      isAncestor: (ancestor, target) => {
        try { execFileSync('git', ['merge-base', '--is-ancestor', ancestor, target], { stdio: 'pipe' }); return true; }
        catch { return false; }
      },
    });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    // Never echo the record, which can contain private evidence locations.
    console.error(error instanceof Error && error.message.startsWith('Production cutover gate:')
      ? error.message : 'Production cutover gate: invalid record or artifact');
    process.exitCode = 1;
  }
}
