export type ZendeskTicketConfiguratorValues = { ticketId?: string };
export interface ZendeskTicketConfiguratorRpc { resourceUrl(ticketId?: string): Promise<string>; }
