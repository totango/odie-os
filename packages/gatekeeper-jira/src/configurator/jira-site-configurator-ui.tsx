import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JiraConfiguratorRpc, JiraConfiguratorValues } from "./jira-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.siteUrl === "string" && values.siteUrl.length > 0,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({ siteUrl: resourceUrl }),
  resourceUrl: ({ values }) => values.siteUrl ?? "",
  render({ values, setValues, ui }) {
    return <Section><Field label="Jira site" description="Choose the Jira Cloud site to connect."><Autocomplete name="siteUrl" value={values.siteUrl} placeholder="Search sites..." loadOptions={q => ui.listSites(q)} onChange={siteUrl => setValues({ siteUrl: siteUrl ?? undefined })} /></Field></Section>;
  },
} satisfies ConfiguratorUISpec<JiraConfiguratorRpc, JiraConfiguratorValues>;
