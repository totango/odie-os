import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { requestBuildNotifierBinding } from './request-build-notifier-binding.ts';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('private notifier dev binding exists only for selected JARVIS and is never ambient', () => {
  assert.deepEqual(requestBuildNotifierBinding([]), []);
  assert.deepEqual(requestBuildNotifierBinding([{ name: 'gatekeeper-slack' }]), []);
  assert.deepEqual(requestBuildNotifierBinding([{ name: 'gatekeeper-jarvis' }]), [{ binding: 'REQUEST_BUILD_NOTIFIER', service: 'gatekeeper-jarvis', entrypoint: 'RequestBuildNotifierEntrypoint' }]);
  assert.match(read('scripts/run-dev-server.ts'), /config\.services\.push\(\.\.\.requestBuildNotifierBinding\(gatekeepers\)\)/);
});
test('Odie private binding resolves before backend deploy and uses the browser origin, not the native API', () => {
  const backend = parse(read('packages/workshop-backend/wrangler.odie-os-production.jsonc'));
  const jarvis = parse(read('packages/gatekeeper-jarvis/wrangler.odie-os-production.jsonc'));
  assert.deepEqual(backend.services.find((s: {binding: string}) => s.binding === 'REQUEST_BUILD_NOTIFIER'), { binding: 'REQUEST_BUILD_NOTIFIER', service: jarvis.name, entrypoint: 'RequestBuildNotifierEntrypoint' });
  assert.equal(backend.vars.REQUEST_BUILD_WORKSHOP_ORIGIN, 'https://odie-os.odie-os.workers.dev');
  assert.equal(jarvis.vars.REQUEST_BUILD_WORKSHOP_ORIGIN, backend.vars.REQUEST_BUILD_WORKSHOP_ORIGIN);
  assert.deepEqual({
    channel: jarvis.vars.REQUEST_BUILD_SLACK_CHANNEL,
    team: jarvis.vars.REQUEST_BUILD_SLACK_TEAM_ID,
    user: jarvis.vars.REQUEST_BUILD_SLACK_BOT_USER_ID,
    bot: jarvis.vars.REQUEST_BUILD_SLACK_BOT_ID,
    channelType: jarvis.vars.REQUEST_BUILD_SLACK_CHANNEL_TYPE,
    generation: jarvis.vars.REQUEST_BUILD_NOTIFIER_GENERATION,
  }, {
    channel: 'C09EW0T5VB5', team: 'T029S9MAU', user: 'U0ASJH874Q2', bot: 'B0ASN51AUJ0',
    channelType: 'public', generation: 'jarvis-unilyst-prs-v1',
  });
  assert.equal(jarvis.vars.REQUEST_BUILD_SLACK_TOKEN, undefined);
  assert.equal(backend.vars.PUBLIC_BASE_URL, 'https://odie-os-native-api.odie-os.workers.dev');
  assert.notEqual(jarvis.vars.REQUEST_BUILD_WORKSHOP_ORIGIN, backend.vars.PUBLIC_BASE_URL);
  const board = read('packages/workshop-backend/src/community-requests.ts');
  assert.match(board, /notificationOrigin: this\.env\.REQUEST_BUILD_WORKSHOP_ORIGIN/);
  assert.match(board, /new URL\(this\.env\.REQUEST_BUILD_WORKSHOP_ORIGIN \?\? ""\)/);
  assert.doesNotMatch(board, /this\.env\.PUBLIC_BASE_URL/);
  const workflow = read('.github/workflows/deploy-production.yml');
  assert.match(workflow, /require_secrets odie-os-gk-jarvis[^\n]*REQUEST_BUILD_SLACK_TOKEN/);
  assert.ok(workflow.indexOf('config gatekeeper-jarvis/wrangler.json') < workflow.indexOf('config workshop-backend/wrangler.json'));
  const entrypoint = read('packages/gatekeeper-jarvis/src/index.ts');
  assert.match(entrypoint, /export \{ RequestBuildNotifierEntrypoint \} from "\.\/request-build-notifier"/);
});
test('generic release and router remain valid without optional JARVIS; no unimplemented expansion claim', () => {
  const backend = parse(read('packages/workshop-backend/wrangler.jsonc'));
  assert.equal((backend.services ?? []).some((s: {binding: string}) => s.binding === 'REQUEST_BUILD_NOTIFIER'), false);
  assert.equal(read('scripts/release/testdata/golden-manifest.json').includes('RequestBuildNotifierEntrypoint'), false);
  assert.equal(read('packages/router/wrangler.odie-os-production.jsonc').includes('REQUEST_BUILD_NOTIFIER'), false);
});
