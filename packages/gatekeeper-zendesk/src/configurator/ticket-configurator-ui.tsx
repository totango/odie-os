import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { ZendeskTicketConfiguratorRpc, ZendeskTicketConfiguratorValues } from "./ticket-configurator-types";

export default {
  initial: {},
  isReady({ values }) { return typeof values.ticketId === "string" && /^\d+$/.test(values.ticketId); },
  initialValuesFromResourceUrl({ resourceUrl }) { return { ticketId: new URL(resourceUrl).pathname.match(/\/agent\/tickets\/(\d+)/)?.[1] ?? undefined }; },
  resourceUrl({ values, ui }) { return ui.resourceUrl(values.ticketId); },
  render({ values, setValues }) {
    return <Section><Field label="Ticket ID" description="Enter a Zendesk numeric ticket id."><TextInput name="ticketId" value={values.ticketId} placeholder="12345" onChange={ticketId => setValues({ ticketId: ticketId ?? undefined })} /></Field></Section>;
  },
} satisfies ConfiguratorUISpec<ZendeskTicketConfiguratorRpc, ZendeskTicketConfiguratorValues>;
