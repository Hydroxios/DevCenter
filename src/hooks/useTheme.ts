import { useEffect } from "react";

import { useSettings } from "@/stores/settings";

/** Applique le thème choisi sur <html>, en suivant le thème Windows si « system ». */
export function useApplyTheme() {
  const theme = useSettings((s) => s.settings.theme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
