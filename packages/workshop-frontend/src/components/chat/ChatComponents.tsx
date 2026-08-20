import { useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { defineChart, barY, lineY } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts-scales/linear";
import { scalePoint } from "@tanstack/charts-scales/point";
import { Chart } from "@tanstack/react-charts";
import type {
  ChatComponent,
  ChatChoiceComponent,
  ChatFormComponent,
  ChatGraphComponent,
  ChatTableComponent,
} from "@gadgets/workshop-shared/api";

/**
 * Renders the interactive components an agent attached to a message.
 *
 * A component is data the agent described, drawn here by trusted code -- agent output never
 * becomes markup or behaviour of its own. Interacting sends an ordinary chat message through the
 * same path as typing one, so nothing here carries authority: when the agent goes on to act on an
 * answer, that action still reaches the user as the usual approval request.
 */
export function ChatComponents(
  { components, onSend, disabled }: {
    /** Components to render under the message body. */
    components: ChatComponent[] | undefined;
    /** The chat's ordinary send-a-message function. */
    onSend: (message: string) => void;
    /** Whether interactions should be disabled. */
    disabled?: boolean;
  },
) {
  if (!components?.length) return null;

  return (
    <div className="space-y-2">
      {components.map((component, index) => (
        // Components have no identity of their own, and a message's list never reorders once
        // stored, so the index is a stable key.
        <ChatComponentView
          key={index}
          component={component}
          onSend={onSend}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function ChatComponentView(
  { component, onSend, disabled }: {
    component: ChatComponent;
    onSend: (message: string) => void;
    disabled?: boolean;
  },
) {
  switch (component.type) {
    case "choice":
      return <ChoiceComponent component={component} onSend={onSend} disabled={disabled} />;
    case "form":
      return <FormComponent component={component} onSend={onSend} disabled={disabled} />;
    case "table":
      return <TableComponent component={component} />;
    case "graph":
      return <GraphComponent component={component} />;
    default:
      // A kind this build doesn't know how to draw. Messages outlive releases, so an older client
      // showing only the prose is the correct outcome rather than an error.
      return null;
  }
}

// A card wrapper, so every component reads as part of the conversation rather than as an embed.
function ComponentCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-kumo-line bg-kumo-base p-3">
      {title && (
        <div className="mb-2 text-[13px] font-medium text-kumo-default">{title}</div>
      )}
      {children}
    </div>
  );
}

function ChoiceComponent(
  { component, onSend, disabled }: {
    component: ChatChoiceComponent;
    onSend: (message: string) => void;
    disabled?: boolean;
  },
) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sent, setSent] = useState(false);

  // A choice answers a question the agent asked, so once answered it stops being a live control:
  // re-answering an earlier turn would send a reply the agent is no longer waiting for.
  const locked = sent || disabled;

  const send = (message: string) => {
    if (locked) return;
    setSent(true);
    onSend(message);
  };

  const toggle = (index: number) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const textOf = (index: number) =>
    component.options[index].value ?? component.options[index].label;

  return (
    <ComponentCard title={component.prompt}>
      <div className="flex flex-wrap gap-1.5">
        {component.options.map((option, index) => (
          <Button
            key={index}
            variant={component.multiple && selected.has(index) ? "primary" : "secondary"}
            size="sm"
            disabled={locked}
            onClick={() => component.multiple ? toggle(index) : send(textOf(index))}
            title={option.description}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {component.multiple && (
        <div className="mt-2">
          <Button
            variant="primary"
            size="sm"
            disabled={locked || selected.size === 0}
            onClick={() => send(
              [...selected].toSorted((a, b) => a - b).map(textOf).join(", "),
            )}
          >
            Send
          </Button>
        </div>
      )}
    </ComponentCard>
  );
}

function FormComponent(
  { component, onSend, disabled }: {
    component: ChatFormComponent;
    onSend: (message: string) => void;
    disabled?: boolean;
  },
) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(component.fields.map(field => [field.name, field.value ?? ""])));
  const [sent, setSent] = useState(false);

  const locked = sent || disabled;
  const missing = component.fields.some(
    field => field.required && !values[field.name]?.trim() && field.kind !== "boolean");

  const submit = () => {
    if (locked || missing) return;
    setSent(true);
    // Sent as ordinary prose rather than a payload: the agent reads it the same way it would read
    // the user typing the answers out, and no new message shape is needed to carry it.
    onSend([
      component.title,
      ...component.fields.map(field => `${field.label}: ${values[field.name] || "(not provided)"}`),
    ].join("\n"));
  };

  return (
    <ComponentCard title={component.title}>
      <div className="space-y-2">
        {component.fields.map(field => (
          <label key={field.name} className="block">
            <span className="mb-1 block text-[12px] text-kumo-subtle">
              {field.label}{field.required && " *"}
            </span>
            <FormField
              field={field}
              value={values[field.name] ?? ""}
              disabled={locked}
              onChange={value => setValues(current => ({ ...current, [field.name]: value }))}
            />
          </label>
        ))}
      </div>
      <div className="mt-3">
        <Button variant="primary" size="sm" disabled={locked || missing} onClick={submit}>
          {component.submitLabel ?? "Submit"}
        </Button>
      </div>
    </ComponentCard>
  );
}

function FormField(
  { field, value, disabled, onChange }: {
    field: ChatFormComponent["fields"][number];
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
  },
) {
  const className =
    "w-full rounded-md border border-kumo-line bg-kumo-surface px-2 py-1.5 text-[13px] " +
    "text-kumo-default outline-none focus:border-kumo-accent disabled:opacity-50";

  switch (field.kind) {
    case "textarea":
      return (
        <textarea
          className={className}
          rows={3}
          value={value}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={event => onChange(event.target.value)}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          className="size-4 accent-kumo-accent"
          checked={value === "true"}
          disabled={disabled}
          onChange={event => onChange(String(event.target.checked))}
        />
      );
    case "select":
      return (
        <select
          className={className}
          value={value}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
        >
          <option value="">Select…</option>
          {(field.options ?? []).map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      );
    case "number":
    case "text":
    default:
      return (
        <input
          type={field.kind === "number" ? "number" : "text"}
          className={className}
          value={value}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={event => onChange(event.target.value)}
        />
      );
  }
}

function TableComponent({ component }: { component: ChatTableComponent }) {
  // The server squares rows against columns, so a row is always indexable by column position.
  const columns = useMemo<ColumnDef<string[]>[]>(
    () => component.columns.map((column, index) => ({
      id: `${index}`,
      header: column,
      accessorFn: row => row[index],
    })),
    [component.columns],
  );

  const table = useReactTable({
    data: component.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <ComponentCard title={component.title}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            {table.getHeaderGroups().map(headerGroup => (
              <tr key={headerGroup.id} className="border-b border-kumo-line">
                {headerGroup.headers.map(header => (
                  <th key={header.id} className="px-2 py-1.5 font-medium text-kumo-subtle">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(row => (
              <tr key={row.id} className="border-b border-kumo-line/50 last:border-0">
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} className="px-2 py-1.5 text-kumo-default">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ComponentCard>
  );
}

function GraphComponent({ component }: { component: ChatGraphComponent }) {
  const definition = useMemo(() => {
    const mark = component.plot === "bar" ? barY : lineY;
    return defineChart({
      marks: component.series.map(series => {
        // A null point is a gap rather than a zero, so drop it instead of plotting it.
        const rows = component.labels
          .map((label, index) => ({ label, value: series.points[index] }))
          .filter((row): row is { label: string; value: number } => row.value !== null);
        return mark(rows, { id: series.name, x: "label", y: "value" });
      }),
      x: { scale: () => scalePoint<string>().padding(0.2) },
      y: { scale: scaleLinear, nice: true, grid: true },
    });
  }, [component.labels, component.plot, component.series]);

  return (
    <ComponentCard title={component.title}>
      <Chart
        definition={definition}
        height={220}
        initialWidth={640}
        ariaLabel={component.title ?? "Chart"}
      />
    </ComponentCard>
  );
}
