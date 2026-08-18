import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  TeamPiAccountConfiguratorRpc,
  TeamPiAccountConfiguratorValues,
} from "./account-configurator-types";

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Whole-account access"
        description="Use the connected Team PI account for approved skills, connections, and customer-system reads.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<TeamPiAccountConfiguratorRpc, TeamPiAccountConfiguratorValues>;
