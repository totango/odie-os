import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";

it.each([[true, false], [false, true], [true, true], [false, false]])(
  "preserves independent private=%s restricted=%s latches across restart", async (privateFlag, restricted) => {
    const name = crypto.randomUUID();
    await runInDurableObject(env.TEST_OVERSEER.getByName(name), instance => {
      const impl = Reflect.get(instance, "impl");
      impl.storage.prohibitAllSharing.put(privateFlag);
      impl.storage.containsRestrictedData.put(restricted);
      impl.storage.ownerInvitesOnly.put(true);
      impl.storage.domainSharingPolicy.put({type: "verified-sso-email-domain", emailDomain: "totango.com"});
    });
    await abortAllDurableObjects();
    await runInDurableObject(env.TEST_OVERSEER.getByName(name), instance => {
      const impl = Reflect.get(instance, "impl");
      expect(impl.storage.prohibitAllSharing.get()).toBe(privateFlag);
      expect(impl.storage.containsRestrictedData.get()).toBe(restricted);
      expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
      expect(impl.storage.domainSharingPolicy.get().emailDomain).toBe("totango.com");
      if (privateFlag || restricted) expect(() => impl.getWebFetchEnv()).toThrow(/prohibited/);
      else expect(() => impl.getWebFetchEnv()).not.toThrow();
    });
  });
