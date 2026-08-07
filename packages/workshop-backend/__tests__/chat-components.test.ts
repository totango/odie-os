import { describe, expect, it, vi } from "vitest";
import type { ChatComponent } from "@gadgets/workshop-shared/api";

// overseer.ts reaches capnweb-validate's decorators, which need the bundler plugin. Same stub the
// other overseer tests use.
vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const { sanitizeChatComponents, extractChatComponents } = await import("../src/chat-components.js");

// These components are authored by the model, so the tests below are mostly about what a confused
// generation produces: a table that doesn't line up, a select with nothing to select, a chart with
// fewer points than labels. None of that may cost the user the message the component arrived with.
describe("sanitizeChatComponents", () => {
  it("keeps a well-formed component of each kind", () => {
    let components: ChatComponent[] = [
      {type: "choice", prompt: "Which environment?", options: [{label: "prod"}, {label: "dev"}]},
      {type: "form", title: "Scope", fields: [{name: "org", label: "Org", kind: "text"}]},
      {type: "table", columns: ["User", "State"], rows: [["ada", "ok"]]},
      {type: "graph", plot: "line", labels: ["Mon", "Tue"], series: [{name: "syncs", points: [1, 2]}]},
    ];
    expect(sanitizeChatComponents(components)).toEqual(components.map(c =>
        c.type === "choice" ? {...c, multiple: false, options: c.options.map(o => ({...o, value: undefined, description: undefined}))}
      : c.type === "form" ? {...c, submitLabel: undefined, fields: c.fields.map(f => ({...f, value: undefined, options: undefined, required: false, placeholder: undefined}))}
      : c.type === "table" ? {...c, title: undefined}
      : {...c, title: undefined}));
  });

  it("returns undefined rather than an empty array when nothing survives", () => {
    expect(sanitizeChatComponents(undefined)).toBeUndefined();
    expect(sanitizeChatComponents([])).toBeUndefined();
    expect(sanitizeChatComponents([{type: "nonsense"} as unknown as ChatComponent])).toBeUndefined();
  });

  it("drops a choice with no usable options, since it would render as a dead prompt", () => {
    expect(sanitizeChatComponents([
      {type: "choice", prompt: "Pick", options: [{label: "   "} as never]},
    ])).toBeUndefined();
    expect(sanitizeChatComponents([{type: "choice", prompt: "", options: [{label: "a"}]}]))
        .toBeUndefined();
  });

  it("drops a select field with nothing to select from, but keeps the rest of the form", () => {
    let result = sanitizeChatComponents([{
      type: "form",
      title: "Scope",
      fields: [
        {name: "empty", label: "Empty", kind: "select"},
        {name: "org", label: "Org", kind: "text"},
      ],
    }]);
    let form = result?.[0];
    expect(form?.type).toBe("form");
    expect(form?.type === "form" && form.fields.map(f => f.name)).toEqual(["org"]);
  });

  it("squares ragged table rows against the columns instead of dropping the table", () => {
    let result = sanitizeChatComponents([{
      type: "table",
      columns: ["A", "B", "C"],
      rows: [["1"], ["1", "2", "3", "4"]],
    }]);
    let table = result?.[0];
    expect(table?.type === "table" && table.rows).toEqual([["1", "", ""], ["1", "2", "3"]]);
  });

  it("pads a short series and turns a non-finite point into a gap, not a zero", () => {
    let result = sanitizeChatComponents([{
      type: "graph",
      plot: "bar",
      labels: ["a", "b", "c"],
      series: [{name: "s", points: [1, Number.NaN] as number[]}],
    }]);
    let graph = result?.[0];
    // A gap reads as "no measurement"; a zero would read as a real one.
    expect(graph?.type === "graph" && graph.series[0].points).toEqual([1, null, null]);
  });

  it("drops a series with no plottable points and a graph with an unknown plot", () => {
    expect(sanitizeChatComponents([
      {type: "graph", plot: "line", labels: ["a"], series: [{name: "s", points: [null]}]},
    ])).toBeUndefined();
    expect(sanitizeChatComponents([
      {type: "graph", plot: "pie" as never, labels: ["a"], series: [{name: "s", points: [1]}]},
    ])).toBeUndefined();
  });

  it("caps how much one message may carry", () => {
    let choice: ChatComponent = {type: "choice", prompt: "p", options: [{label: "a"}]};
    expect(sanitizeChatComponents(Array.from({length: 20}, () => choice))).toHaveLength(4);

    let manyOptions = sanitizeChatComponents([{
      type: "choice",
      prompt: "p",
      options: Array.from({length: 40}, (_, i) => ({label: `option ${i}`})),
    }]);
    expect(manyOptions?.[0].type === "choice" && manyOptions[0].options).toHaveLength(12);

    let manyRows = sanitizeChatComponents([{
      type: "table",
      columns: ["A"],
      rows: Array.from({length: 200}, (_, i) => [`${i}`]),
    }]);
    expect(manyRows?.[0].type === "table" && manyRows[0].rows).toHaveLength(50);
  });

  it("truncates overlong text rather than dropping the component", () => {
    let long = "x".repeat(5000);
    let result = sanitizeChatComponents([
      {type: "choice", prompt: long, options: [{label: long}]},
    ]);
    let choice = result?.[0];
    expect(choice?.type === "choice" && choice.prompt.length).toBe(500);
    expect(choice?.type === "choice" && choice.options[0].label.length).toBe(200);
  });
});

// The block is written by the model inside its own prose, so extraction has to be forgiving about
// what surrounds it and unforgiving about what it accepts.
describe("extractChatComponents", () => {
  const block = (body: string) => "```odie-ui\n" + body + "\n```";

  it("lifts the block out and leaves the prose behind", () => {
    let result = extractChatComponents(
      "Here are your options.\n\n" +
      block('[{"type":"choice","prompt":"Pick","options":[{"label":"a"}]}]'));
    expect(result.message).toBe("Here are your options.");
    expect(result.components?.[0].type).toBe("choice");
  });

  it("accepts the {components: [...]} form as well as a bare array", () => {
    let result = extractChatComponents(
      block('{"components":[{"type":"table","columns":["A"],"rows":[["1"]]}]}'));
    expect(result.components).toHaveLength(1);
    expect(result.message).toBe("");
  });

  it("leaves a message with no block untouched", () => {
    let result = extractChatComponents("Just an answer, with a ```js\ncode()\n``` block.");
    expect(result.message).toBe("Just an answer, with a ```js\ncode()\n``` block.");
    expect(result.components).toBeUndefined();
  });

  it("leaves malformed JSON exactly where the model wrote it", () => {
    // Showing a stray code block is a smaller failure than deleting part of an answer.
    let message = "Answer.\n\n" + block("{not json");
    expect(extractChatComponents(message)).toEqual({message});
  });

  it("leaves the block alone when nothing in it survives sanitization", () => {
    let message = "Answer.\n\n" + block('[{"type":"choice","prompt":"Pick","options":[]}]');
    expect(extractChatComponents(message)).toEqual({message});
  });

  it("does not treat an ordinary json block as components", () => {
    let message = "Result:\n\n```json\n[{\"type\":\"choice\",\"prompt\":\"x\",\"options\":[{\"label\":\"a\"}]}]\n```";
    expect(extractChatComponents(message)).toEqual({message});
  });

  it("collapses the gap the removed block leaves in the prose", () => {
    let result = extractChatComponents(
      "Before.\n\n" + block('[{"type":"table","columns":["A"],"rows":[["1"]]}]') + "\n\nAfter.");
    expect(result.message).toBe("Before.\n\nAfter.");
  });
});
