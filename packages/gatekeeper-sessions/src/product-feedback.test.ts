import { describe, expect, it } from "vitest";
import { validateSafeDiff, feedbackBranch, PRODUCT_FEEDBACK_SLACK_CHANNEL, summarizeEvidenceForPr } from "./product-feedback";
import type { ProductFeedbackEvidenceBundle } from "@gadgets/workshop-shared/coding-sessions";

describe("product feedback guardrails", () => {
  it("accepts a small source diff", () => {
    expect(validateSafeDiff("diff --git a/src/a.ts b/src/a.ts\n+const ok = true\n")).toEqual({ ok: true });
  });

  it("rejects protected workflow and env paths", () => {
    expect(validateSafeDiff("diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml\n+x\n"))
      .toEqual({ ok: false, reason: "Diff changes protected workflow, secret, or env paths." });
    expect(validateSafeDiff("diff --git a/.env b/.env\n+TOKEN=abc\n").ok).toBe(false);
  });

  it("rejects protected rename sources and destinations", () => {
    expect(validateSafeDiff("diff --git a/.env b/src/env.ts\nrename from .env\nrename to src/env.ts\n").ok).toBe(false);
    expect(validateSafeDiff("diff --git a/src/a.ts b/.github/workflows/x.yml\nrename from src/a.ts\nrename to .github/workflows/x.yml\n").ok).toBe(false);
  });

  it("rejects secret-looking additions and binaries", () => {
    expect(validateSafeDiff("diff --git a/a.ts b/a.ts\n+apiToken = abc\n").ok).toBe(false);
    expect(validateSafeDiff("Binary files a/img.png and b/img.png differ").ok).toBe(false);
    expect(validateSafeDiff("diff --git a/img.png b/img.png\nGIT binary patch\nliteral 12\nabc\n").ok).toBe(false);
  });

  it("rejects git metadata, symlinks, executable bits, and mode changes", () => {
    expect(validateSafeDiff("diff --git a/.git/hooks/pre-push b/.git/hooks/pre-push\n+x\n").ok).toBe(false);
    expect(validateSafeDiff("diff --git a/link b/link\nnew file mode 120000\n+x\n").ok).toBe(false);
    expect(validateSafeDiff("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n").ok).toBe(false);
  });

  it("uses sanitized feedback branches and a fixed Slack destination", () => {
    expect(feedbackBranch("abc/../bad")).toBe("feedback/abcbad");
    expect(PRODUCT_FEEDBACK_SLACK_CHANNEL).toBe("C09EW0T5VB5");
  });

  it("rejects diffs that echo private evidence", () => {
    const evidence: ProductFeedbackEvidenceBundle = {
      id: "abc123privateid", kind: "bug", title: "Secret feedback title", description: "meaningful private diagnostic phrase https://internal.example/private-path", submitterEmail: "jacob.beck@totango.com", owner: { userId: "private-owner-user-id", email: "jacob.beck@totango.com" }, pathname: "/", expiresAt: new Date(),
    };
    expect(validateSafeDiff("diff --git a/a.ts b/a.ts\n+// meaningful private diagnostic phrase\n", evidence).ok).toBe(false);
    expect(validateSafeDiff("diff --git a/a.ts b/a.ts\n+// jacob.beck@totango.com\n", evidence).ok).toBe(false);
    expect(validateSafeDiff("diff --git a/a.ts b/a.ts\n+// https://internal.example/private-path\n", evidence).ok).toBe(false);
    const summary = summarizeEvidenceForPr(evidence);
    expect(summary).toContain(evidence.id);
    expect(summary).not.toContain(evidence.title);
    expect(summary).not.toContain(evidence.description);
    expect(summary).not.toContain(evidence.submitterEmail);
  });
});
