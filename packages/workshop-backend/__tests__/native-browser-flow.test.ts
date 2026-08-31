import { describe, expect, it } from 'vitest';
import { createNativeBrowserFlowRecord, NATIVE_BROWSER_FLOW_TTL_MS, nativeBrowserFlowStatus } from '../src/auth/native-browser-flow';

describe('native browser flow records', () => {
  it('creates versioned expiring records without embedding credentials in the return handle', () => {
    const record = createNativeBrowserFlowRecord({
      kind: 'login',
      flowHandle: 'flow_opaque_handle',
      launchTicket: 'ticket_opaque_value',
      clientVerifierHash: 'sha256-value',
      providerInitiationUrl: 'https://odie-os.odie-os.workers.dev/gatekeeper/google/oauth',
      now: 1000,
    });
    expect(record.version).toBe(1);
    expect(record.status).toBe('pending');
    expect(record.expiresAt).toBe(1000 + NATIVE_BROWSER_FLOW_TTL_MS);
    expect(record.flowHandle).not.toContain('https://');
  });

  it('requires https provider launch URLs and reports expiration deterministically', () => {
    expect(() => createNativeBrowserFlowRecord({
      kind: 'connect',
      flowHandle: 'flow',
      launchTicket: 'ticket',
      clientVerifierHash: 'hash',
      providerInitiationUrl: 'http://example.com/oauth',
      now: 0,
    })).toThrow(/https/);

    const record = createNativeBrowserFlowRecord({
      kind: 'grant',
      flowHandle: 'flow',
      launchTicket: 'ticket',
      clientVerifierHash: 'hash',
      providerInitiationUrl: 'https://example.com/oauth',
      now: 0,
    });
    expect(nativeBrowserFlowStatus(record, NATIVE_BROWSER_FLOW_TTL_MS - 1)).toBe('pending');
    expect(nativeBrowserFlowStatus(record, NATIVE_BROWSER_FLOW_TTL_MS)).toBe('expired');
  });

  it('expires completed login records so unconsumed tokens are bounded', () => {
    const record = createNativeBrowserFlowRecord({
      kind: 'login',
      flowHandle: 'flow',
      launchTicket: 'ticket',
      clientVerifierHash: 'hash',
      providerInitiationUrl: 'https://example.com/oauth',
      now: 0,
    });
    record.status = 'completed';
    record.loginToken = 'user:secret';
    expect(nativeBrowserFlowStatus(record, NATIVE_BROWSER_FLOW_TTL_MS - 1)).toBe('completed');
    expect(nativeBrowserFlowStatus(record, NATIVE_BROWSER_FLOW_TTL_MS)).toBe('expired');
  });
});
