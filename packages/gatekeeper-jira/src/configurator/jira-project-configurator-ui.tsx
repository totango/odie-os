import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JiraConfiguratorRpc, JiraConfiguratorValues } from "./jira-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.projectUrl === "string" && values.projectUrl.length > 0,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({ projectUrl: resourceUrl }),
  resourceUrl: ({ values }) => values.projectUrl ?? "",
  render({ values, setValues, ui }) {
    return <Section><Field label="Jira project" description="Choose one Jira project."><Autocomplete name="projectUrl" value={values.projectUrl} placeholder="Search projects..." loadOptions={q => ui.listProjects(q)} onChange={projectUrl => setValues({ projectUrl: projectUrl ?? undefined })} /></Field></Section>;
  },
} satisfies ConfiguratorUISpec<JiraConfiguratorRpc, JiraConfiguratorValues>;
