import type {
  ChatComponent, ChatChoiceOption, ChatFormField, ChatGraphSeries,
} from "@gadgets/workshop-shared/api";

// Bounds on the interactive components one message may carry. These come from the model rather
// than the composer, so they are the least trustworthy input in a message: the caps keep a
// confused or hostile generation from turning one chat message into a dashboard, and keep what
// gets persisted small. A message is prose plus at most a few components; anything past these
// limits is dropped rather than rejected, because the prose still answers the user.
const MAX_CHAT_COMPONENTS = 4;
const MAX_CHOICE_OPTIONS = 12;
const MAX_FORM_FIELDS = 12;
const MAX_SELECT_OPTIONS = 24;
const MAX_TABLE_COLUMNS = 8;
const MAX_TABLE_ROWS = 50;
const MAX_GRAPH_SERIES = 6;
const MAX_GRAPH_POINTS = 200;

// Longest label, title, or cell. Long enough for a sentence, short enough that fifty rows stay a
// table rather than a document.
const MAX_COMPONENT_LABEL = 200;
const MAX_COMPONENT_TITLE = 500;

// Trims a display string to `max`, or returns undefined when the value isn't a usable string.
function boundedComponentText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// Drops interactive components the client couldn't safely draw.
//
// Components are described by the model, never executed, so the risk here is not code but nonsense:
// a table whose rows don't match its columns, a select with no options, a chart with more points
// than labels. Each of those is dropped or repaired rather than thrown, so one bad component never
// costs the user the message it came with.
export function sanitizeChatComponents(components: ChatComponent[] | undefined)
    : ChatComponent[] | undefined {
  if (!Array.isArray(components) || components.length === 0) return undefined;

  let accepted: ChatComponent[] = [];
  for (let component of components) {
    if (accepted.length >= MAX_CHAT_COMPONENTS) break;
    let clean = sanitizeChatComponent(component);
    if (clean) accepted.push(clean);
  }

  return accepted.length > 0 ? accepted : undefined;
}

function sanitizeChatComponent(component: ChatComponent | undefined): ChatComponent | undefined {
  if (!component || typeof component !== "object") return undefined;

  switch (component.type) {
    case "choice": {
      let prompt = boundedComponentText(component.prompt, MAX_COMPONENT_TITLE);
      if (prompt === undefined || !Array.isArray(component.options)) return undefined;
      let options: ChatChoiceOption[] = [];
      for (let option of component.options) {
        if (options.length >= MAX_CHOICE_OPTIONS) break;
        let label = boundedComponentText(option?.label, MAX_COMPONENT_LABEL);
        if (label === undefined) continue;
        options.push({
          label,
          // A missing value means "send the label", so only record one that differs.
          value: boundedComponentText(option.value, MAX_COMPONENT_LABEL),
          description: boundedComponentText(option.description, MAX_COMPONENT_LABEL),
        });
      }
      if (options.length === 0) return undefined;
      return {type: "choice", prompt, options, multiple: component.multiple === true};
    }

    case "form": {
      let title = boundedComponentText(component.title, MAX_COMPONENT_TITLE);
      if (title === undefined || !Array.isArray(component.fields)) return undefined;
      let fields: ChatFormField[] = [];
      for (let field of component.fields) {
        if (fields.length >= MAX_FORM_FIELDS) break;
        let name = boundedComponentText(field?.name, MAX_COMPONENT_LABEL);
        let label = boundedComponentText(field?.label, MAX_COMPONENT_LABEL);
        if (name === undefined || label === undefined) continue;
        if (!isChatFormFieldKind(field.kind)) continue;
        // A select with nothing to select from would render as a dead control.
        let options = Array.isArray(field.options)
            ? field.options
                .map(option => boundedComponentText(option, MAX_COMPONENT_LABEL))
                .filter((option): option is string => option !== undefined)
                .slice(0, MAX_SELECT_OPTIONS)
            : undefined;
        if (field.kind === "select" && (!options || options.length === 0)) continue;
        fields.push({
          name,
          label,
          kind: field.kind,
          value: boundedComponentText(field.value, MAX_COMPONENT_TITLE),
          options,
          required: field.required === true,
          placeholder: boundedComponentText(field.placeholder, MAX_COMPONENT_LABEL),
        });
      }
      if (fields.length === 0) return undefined;
      return {
        type: "form",
        title,
        fields,
        submitLabel: boundedComponentText(component.submitLabel, MAX_COMPONENT_LABEL),
      };
    }

    case "table": {
      if (!Array.isArray(component.columns) || !Array.isArray(component.rows)) return undefined;
      let columns = component.columns
          .map(column => boundedComponentText(column, MAX_COMPONENT_LABEL) ?? "")
          .slice(0, MAX_TABLE_COLUMNS);
      if (columns.length === 0) return undefined;
      // Square the rows against the columns so the client can render without bounds checks: a
      // ragged generation shows blanks instead of dropping the whole table.
      let rows = component.rows
          .filter(row => Array.isArray(row))
          .slice(0, MAX_TABLE_ROWS)
          .map(row => columns.map((_, index) =>
              boundedComponentText(row[index], MAX_COMPONENT_LABEL) ?? ""));
      if (rows.length === 0) return undefined;
      return {
        type: "table",
        title: boundedComponentText(component.title, MAX_COMPONENT_TITLE),
        columns,
        rows,
      };
    }

    case "graph": {
      if (component.plot !== "line" && component.plot !== "bar") return undefined;
      if (!Array.isArray(component.labels) || !Array.isArray(component.series)) return undefined;
      let labels = component.labels
          .map(label => boundedComponentText(label, MAX_COMPONENT_LABEL) ?? "")
          .slice(0, MAX_GRAPH_POINTS);
      if (labels.length === 0) return undefined;
      let series: ChatGraphSeries[] = [];
      for (let entry of component.series) {
        if (series.length >= MAX_GRAPH_SERIES) break;
        let name = boundedComponentText(entry?.name, MAX_COMPONENT_LABEL);
        if (name === undefined || !Array.isArray(entry.points)) continue;
        // One point per label. A non-finite point becomes a gap rather than plotting as zero,
        // which would read as a real measurement.
        let points = labels.map((_, index) => {
          let point = entry.points[index];
          return typeof point === "number" && Number.isFinite(point) ? point : null;
        });
        if (points.every(point => point === null)) continue;
        series.push({name, points});
      }
      if (series.length === 0) return undefined;
      return {
        type: "graph",
        title: boundedComponentText(component.title, MAX_COMPONENT_TITLE),
        plot: component.plot,
        labels,
        series,
      };
    }

    default:
      // An unrecognized type is a component this build doesn't know how to draw.
      return undefined;
  }
}

function isChatFormFieldKind(kind: unknown): kind is ChatFormField["kind"] {
  return kind === "text" || kind === "textarea" || kind === "number" || kind === "boolean"
      || kind === "select";
}

// The fence an agent writes its components in. Named rather than bare so a model quoting JSON for
// some other reason cannot accidentally produce a control.
const COMPONENT_FENCE = "odie-ui";

// Matches one fenced component block, with or without a trailing newline before the closing fence.
const COMPONENT_BLOCK = new RegExp("^[ \\t]*```" + COMPONENT_FENCE + "[ \\t]*\\r?\\n" +
    "([\\s\\S]*?)\\r?\\n?[ \\t]*```[ \\t]*$", "m");

// Lifts an agent's component block out of its prose.
//
// Components arrive inside the message because that is how a model writes: asking it to fill a
// separate tool argument would split one thought across two places and lose the block whenever the
// turn ends without a tool call. The block is removed from the text it came in, so the user reads
// the prose and sees the components drawn, never the JSON that described them.
//
// Anything malformed is left exactly where it was. A model that writes a broken block has usually
// written something it meant the reader to see, and showing a stray code block is a smaller failure
// than silently deleting part of an answer.
export function extractChatComponents(message: string)
    : {message: string, components?: ChatComponent[]} {
  let match = COMPONENT_BLOCK.exec(message);
  if (!match) return {message};

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return {message};
  }

  // Accept either a bare array or {components: [...]}, since both are natural things to write.
  let candidates = Array.isArray(parsed)
      ? parsed
      : (parsed as {components?: unknown})?.components;
  let components = sanitizeChatComponents(candidates as ChatComponent[] | undefined);
  if (!components) return {message};

  // Collapse the blank lines the removed block leaves behind, so the prose doesn't end in a gap.
  let text = (message.slice(0, match.index) + message.slice(match.index + match[0].length))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return {message: text, components};
}
