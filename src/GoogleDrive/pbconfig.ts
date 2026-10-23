import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Google Drive",
  description:
    "Read your own CBZ/ZIP manga library from a Google Drive folder. One sub-folder per series, one archive per chapter or volume.",
  version: "1.1.0",
  icon: "icon.png",
  language: "multi",
  contentRating: ContentRating.EVERYONE,
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [
    { label: "Self-hosted", textColor: "#FFFFFF", backgroundColor: "#1A73E8" },
  ],
  developers: [{ name: "remo" }],
} satisfies ExtensionInfo;
