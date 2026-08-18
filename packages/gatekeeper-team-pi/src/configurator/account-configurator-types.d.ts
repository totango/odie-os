export type TeamPiAccountConfiguratorValues = {
  confirmed?: string | null;
};

export interface TeamPiAccountConfiguratorRpc {
  resourceUrl(): Promise<string>;
}
