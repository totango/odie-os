import { describe, expect, it } from "vitest";
import { deleteBlueprintContent } from "../src/user.js";

describe("owned blueprint content cleanup", () => {
  it("deletes all paginated versions and the screenshot", async () => {
    let blueprintId = "blueprint-id";
    let keys = new Set([
      `${blueprintId}/1`,
      `${blueprintId}/2`,
      `${blueprintId}/3`,
      `screenshots/${blueprintId}`,
      "other-blueprint/1",
    ]);
    let deleted: string[] = [];
    let bucket = {
      async list(options: R2ListOptions): Promise<R2Objects> {
        let matches = [...keys].filter(key => key.startsWith(options.prefix!)).toSorted();
        let offset = options.cursor ? Number(options.cursor) : 0;
        let objects = matches.slice(offset, offset + 2).map(key => ({key} as R2Object));
        let nextOffset = offset + objects.length;
        return {
          objects,
          truncated: nextOffset < matches.length,
          ...(nextOffset < matches.length ? {cursor: String(nextOffset)} : {}),
          delimitedPrefixes: [],
        };
      },
      async delete(input: string | string[]): Promise<void> {
        for (let key of typeof input === "string" ? [input] : input) {
          deleted.push(key);
          keys.delete(key);
        }
      },
    };

    await deleteBlueprintContent(bucket, blueprintId);

    expect(deleted).toEqual([
      `${blueprintId}/1`,
      `${blueprintId}/2`,
      `${blueprintId}/3`,
      `screenshots/${blueprintId}`,
    ]);
    expect([...keys]).toEqual(["other-blueprint/1"]);
  });

});
