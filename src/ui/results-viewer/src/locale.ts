import { createTranslator } from "@casys/mcp-view-components";
import { en } from "./locales/en.ts";
import { fr } from "./locales/fr.ts";

/** Labels are translated; recorded states, identifiers, values and units are not. */
export const geometryMessages = createTranslator({
  defaultLocale: "en",
  messages: en,
  translations: { fr },
});
