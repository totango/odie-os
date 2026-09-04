import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JiraConfiguratorRpc, JiraConfiguratorValues } from "./jira-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.issueUrl === "string" && values.issueUrl.length > 0,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({ issueUrl: resourceUrl }),
  resourceUrl: ({ values }) => values.issueUrl ?? "",
  render({ values, setValues, ui }) {
    return <Section><Field label="Jira issue" description="Choose one Jira issue."><Autocomplete name="issueUrl" value={values.issueUrl} placeholder="Search issues or type KEY-123..." loadOptions={q => ui.listIssues(q)} onChange={issueUrl => setValues({ issueUrl: issueUrl ?? undefined })} /></Field></Section>;
  },
} satisfies ConfiguratorUISpec<JiraConfiguratorRpc, JiraConfiguratorValues>;
