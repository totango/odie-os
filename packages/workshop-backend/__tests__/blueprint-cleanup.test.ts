import { describe, expect, it } from "vitest";
import { deleteBlueprintContent } from "../src/user.js";

describe("owned blueprint content cleanup", () => {
  it("deletes every bounded page and the screenshot", async () => {
    let blueprintId = "blueprint-id";
    let keys = new Set([
      ...Array.from({length: 1001}, (_, index) => `${blueprintId}/${index}`),
      `screenshots/${blueprintId}`,
      "other-blueprint/1",
    ]);
    let deleted: string[] = [];
    let deleteBatchSizes: number[] = [];
    let bucket = {
      async list(options: R2ListOptions): Promise<R2Objects> {
        let matches = [...keys].filter(key => key.startsWith(options.prefix!)).toSorted();
        let objects = matches.slice(0, options.limit).map(key => ({key} as R2Object));
        return {
          objects,
          truncated: objects.length < matches.length,
          ...(objects.length < matches.length ? {cursor: "next"} : {}),
          delimitedPrefixes: [],
        };
      },
      async delete(input: string | string[]): Promise<void> {
        if (Array.isArray(input)) deleteBatchSizes.push(input.length);
        for (let key of typeof input === "string" ? [input] : input) {
          deleted.push(key);
          keys.delete(key);
        }
      },
    };

    await deleteBlueprintContent(bucket, blueprintId);

    expect(deleteBatchSizes).toEqual([1000, 1]);
    expect(deleted).toHaveLength(1002);
    expect(deleted).toContain(`screenshots/${blueprintId}`);
    expect([...keys]).toEqual(["other-blueprint/1"]);
  });

});
