import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { authorizeArtifact, pauseBackendConfig, sealArtifact, validateCutoverRecord } from './production-cutover.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = 'a'.repeat(40);
const now = Date.parse('2026-09-25T12:00:00Z');
const options = { phase: 'resume', targetSha: sha, now, isAncestor: () => true };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cutover-artifact-'));
  mkdirSync(join(directory, 'workshop-backend'));
  const configPath = join(directory, 'workshop-backend/wrangler.json');
  writeFileSync(configPath, JSON.stringify(pauseBackendConfig({ vars: { WORKSHOP_EDITING_PAUSED: 'false', OTHER: 'retained' } })));
  writeFileSync(join(directory, 'workshop-backend/server.js'), 'export default {};');
  const artifact = sealArtifact(directory, root, sha);
  const evidence = Object.fromEntries([
    'pauseFence', 'drain', 'backupRestore', 'clientRecovery', 'oauthMatrix', 'catalogProvenance',
    'deploymentHistory', 'migrationRehearsal', 'deployedVersions', 'postDeployVerification', 'resumeReceipt',
  ].map(name => [name, { url: `https://evidence.example/${name}`, sha256: 'b'.repeat(64) }]));
  // Synthetic unit-test data only; no production record is shipped by this change.
  const record = {
    schemaVersion: 1, epoch: artifact.epoch, deployment: 'odie-os-production', status: 'completed',
    targetSha: sha, artifactSha256: artifact.artifactSha256, contractSha256: artifact.contractSha256,
    recordedAt: '2026-09-25T11:00:00Z', expiresAt: '2026-09-25T13:00:00Z',
    oldClientSha: 'c'.repeat(40), recoveryClientSha: 'd'.repeat(40), recoveryPath: 'preparatory-release', evidence,
  };
  return { directory, configPath, artifact, record, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('artifact generation forces pause, and no record cannot enable writes', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.configPath, 'utf8');
    assert.equal(JSON.parse(before).vars.WORKSHOP_EDITING_PAUSED, 'true');
    assert.throws(() => authorizeArtifact(f.directory, root, undefined, options), /record/);
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
  } finally { f.close(); }
});

test('prepared exact-target approval stays paused; completion is required to resume', () => {
  const f = fixture();
  try {
    f.record.status = 'prepared';
    assert.equal(authorizeArtifact(f.directory, root, f.record, { ...options, phase: 'prepare' }).paused, true);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).vars.WORKSHOP_EDITING_PAUSED, 'true');
    assert.throws(() => authorizeArtifact(f.directory, root, f.record, options), /status/);
  } finally { f.close(); }
});

test('recorded completion resumes only the sealed target without dropping other configuration', () => {
  const f = fixture();
  try {
    assert.equal(authorizeArtifact(f.directory, root, f.record, options).paused, false);
    assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).vars, { OTHER: 'retained' });
  } finally { f.close(); }
});

for (const field of ['pauseFence', 'drain', 'backupRestore', 'clientRecovery', 'oauthMatrix',
  'catalogProvenance', 'deploymentHistory', 'migrationRehearsal', 'deployedVersions', 'postDeployVerification']) {
  test(`missing ${field} evidence cannot resume writes`, () => {
    const f = fixture();
    try {
      delete f.record.evidence[field];
      assert.throws(() => authorizeArtifact(f.directory, root, f.record, options), /evidence/);
      assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).vars.WORKSHOP_EDITING_PAUSED, 'true');
    } finally { f.close(); }
  });
}

test('schema rejects stale, mismatched and unpinned confirmations', () => {
  const f = fixture();
  try {
    for (const patch of [
      { schemaVersion: 2 }, { deployment: 'other' }, { epoch: 'other' }, { targetSha: 'e'.repeat(40) },
      { artifactSha256: 'e'.repeat(64) }, { contractSha256: 'e'.repeat(64) },
      { expiresAt: '2026-09-25T11:59:00Z' }, { recordedAt: '2026-09-26T12:00:00Z' },
      { expiresAt: '2026-10-25T12:00:00Z' }, { oldClientSha: '' },
      { recoveryPath: 'assume-compatible' }, { recoveryClientSha: '' },
    ]) assert.throws(() => validateCutoverRecord({ ...f.record, ...patch }, f.artifact, options));
    assert.throws(() => validateCutoverRecord(f.record, f.artifact, { ...options, phase: 'unknown' }));
    f.record.evidence.drain.url = 'https://evidence.example/drain?token=private';
    assert.throws(() => validateCutoverRecord(f.record, f.artifact, options), /unsafe/);
  } finally { f.close(); }
});

test('review metadata is not a deployment requirement; the artifact evidence still is', () => {
  const f = fixture();
  try {
    const record = { ...f.record, reviews: { K: 'same', F: 'same', C: 'same', T: 'same', extra: 'other' } };
    const before = readFileSync(f.configPath, 'utf8');
    assert.deepEqual(validateCutoverRecord(record, f.artifact, options), { paused: false });
    delete record.evidence.backupRestore;
    assert.throws(() => authorizeArtifact(f.directory, root, record, options), /backupRestore evidence/);
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
    assert.equal(JSON.parse(before).vars.WORKSHOP_EDITING_PAUSED, 'true');
  } finally { f.close(); }
});

test('routine descendants need prior resume receipt and the same compatibility contract', () => {
  const f = fixture();
  try {
    const routine = { ...options, phase: 'routine', now: now + 365 * 86400000 };
    assert.deepEqual(validateCutoverRecord(f.record, f.artifact, routine), { paused: false });
    const descendant = 'e'.repeat(40);
    assert.deepEqual(validateCutoverRecord(f.record, { ...f.artifact, targetSha: descendant, artifactSha256: 'f'.repeat(64) },
      { ...routine, targetSha: descendant }), { paused: false });
    assert.throws(() => validateCutoverRecord(f.record, { ...f.artifact, artifactSha256: 'f'.repeat(64) }, routine), /same-target/);
    assert.throws(() => validateCutoverRecord(f.record, { ...f.artifact, contractSha256: 'f'.repeat(64) }, routine), /mismatched/);
    assert.throws(() => validateCutoverRecord(f.record, f.artifact, { ...routine, isAncestor: () => false }), /ancestor/);
    delete f.record.evidence.resumeReceipt;
    assert.throws(() => validateCutoverRecord(f.record, f.artifact, routine), /resumeReceipt/);
  } finally { f.close(); }
});

test('artifact tampering cannot use a valid approval to unpause', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, 'workshop-backend/server.js'), 'changed');
    assert.throws(() => authorizeArtifact(f.directory, root, f.record, options), /changed after build/);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).vars.WORKSHOP_EDITING_PAUSED, 'true');
  } finally { f.close(); }
});

test('workflow gates all deployment mutations and uses protected environment evidence', () => {
  const workflow = readFileSync(join(root, '.github/workflows/deploy-production.yml'), 'utf8');
  const gate = workflow.indexOf('- name: Enforce production cutover checklist');
  assert.ok(gate > workflow.indexOf('- name: Download deployment artifact'));
  assert.ok(gate < workflow.indexOf('- name: Deploy new OAuth connectors'));
  assert.ok(gate < workflow.indexOf('- name: Sync browser editor capability secret'));
  assert.match(workflow, /POLARIS_CUTOVER_RECORD: \$\{\{ vars\.POLARIS_CUTOVER_RECORD \}\}/);
  assert.match(workflow, /CUTOVER_PHASE: \$\{\{ inputs\.cutover_phase \|\| 'routine' \}\}/);
  assert.match(workflow, /fetch-depth: 0/);
  const builder = readFileSync(join(root, 'scripts/build-production-deploy.mjs'), 'utf8');
  assert.match(builder, /packageName === "workshop-backend"\) config = pauseBackendConfig\(config\)/);
  assert.match(builder, /sealArtifact\(outputDir, ROOT, targetSha\)/);
});
