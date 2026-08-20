import type { GatekeeperAppTheme } from "@gadgets/workshop-shared/theme";

export function applyAppTheme(theme: GatekeeperAppTheme): void {
  const mode = theme.mode === "dark" ? "dark" : "light";
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
}
