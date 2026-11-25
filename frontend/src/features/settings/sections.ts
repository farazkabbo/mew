/**
 * The settings pages, in the sidebar's order (`SettingsApp`; the desktop app's settings window
 * lists the same ids under "Your account", in desktop/shell/screen-coach.html). Plain data, so
 * the server page can read `?section=` with it too.
 */
export const SETTINGS_SECTIONS = [
  { id: "tutor", label: "Tutor" },
  { id: "voice", label: "Voice & language" },
  { id: "appearance", label: "Appearance" },
  { id: "handwriting", label: "Handwriting" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "improve", label: "Help improve Neb" },
  { id: "devices", label: "Signed-in devices" },
  { id: "about", label: "About" },
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The page asked for (`?section=`), or the first. */
export function sectionOf(value: string | undefined): SettingsSectionId {
  return SETTINGS_SECTIONS.find((s) => s.id === value)?.id ?? "tutor";
}
