import { defineMessages } from "../../message";

export const messages = defineMessages("dialog", {
  // Native file pickers.
  "dialog.chooseSiteDirectory": "Choose a static site directory",
  "dialog.chooseAgentFolder": "Choose a folder for {agent}",
  "dialog.chooseAgentExclusion": "Choose a folder that {agent} must not change",
  "dialog.chooseSkill": "Choose a skill folder or ZIP",
  "dialog.filter.skillPackages": "Skill packages",
  "dialog.filter.images": "Images",
  "dialog.filter.supportedFiles": "Supported files",
  "dialog.filter.attachment": "Attachment",
  "dialog.filter.zipArchive": "ZIP archive",
  "dialog.filter.jsonDocument": "JSON document",
  "dialog.chooseAgentExport": "Choose an agent export",
  "dialog.chooseHermesFolder": "Choose the Hermes folder",
  "dialog.filter.agentExports": "Agent exports",
  "dialog.chooseVaultCsv": "Choose a password export",
  "dialog.filter.csv": "CSV files",
  "dialog.saveExportSkill": "Save the export skill",
  "dialog.saveTransfer": "Save the transfer file",
  "dialog.chooseTransfer": "Choose a transfer file",
  "dialog.filter.transfer": "OpenBot transfer files",
  "dialog.chooseExternalLinkApp": "Choose a browser",
  "dialog.filter.applications": "Applications",
  "dialog.localUpdate.title": "Update OpenCat",
  "dialog.localUpdate.message": "A new OpenCat build is ready (version {version}).",
  "dialog.localUpdate.detail":
    "What changes:\n{changes}\n\nOpenCat makes a copy of your data and keeps the previous app. Then it closes and opens again by itself.",
  "dialog.localUpdate.busy": "An agent is working now. If you update, that work stops.",
  "dialog.localUpdate.install": "Update",
  "dialog.localUpdate.cancel": "Not now",
});
