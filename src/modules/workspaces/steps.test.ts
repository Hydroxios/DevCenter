import { describe, expect, it } from "vitest";

import type { AppShortcut, Project } from "@/types";
import { STEP_KINDS, defaultStep, stepIcon, stepLabel } from "./steps";

const projects: Project[] = [
  { id: 1, name: "api", path: "C:/dev/api", exists: true },
  { id: 2, name: "web", path: "C:/dev/web", exists: true },
];
const apps: AppShortcut[] = [{ id: 7, name: "Docker Desktop", path: "C:/docker.exe", exists: true }];

describe("STEP_KINDS / stepIcon", () => {
  it("a un type unique par entrée et une icône pour chacune", () => {
    const kinds = STEP_KINDS.map((k) => k.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of STEP_KINDS) expect(stepIcon(k.kind)).toBe(k.icon);
  });
});

describe("stepLabel", () => {
  it("nomme le projet visé", () => {
    expect(stepLabel({ kind: "editor", projectId: 2 }, projects, apps)).toBe("web dans l'éditeur");
    expect(stepLabel({ kind: "folder", projectId: 1 }, projects, apps)).toBe("Dossier de api");
  });

  it("indique l'ouverture du navigateur pour un script", () => {
    expect(stepLabel({ kind: "script", projectId: 1, script: "dev", openBrowser: false }, projects, apps)).toBe("api › dev");
    expect(stepLabel({ kind: "script", projectId: 1, script: "dev", openBrowser: true }, projects, apps)).toBe("api › dev + navigateur");
  });

  it("indique si l'application est fermée à l'arrêt", () => {
    expect(stepLabel({ kind: "app", appId: 7, closeOnStop: false }, projects, apps)).toBe("Docker Desktop");
    expect(stepLabel({ kind: "app", appId: 7, closeOnStop: true }, projects, apps)).toBe("Docker Desktop (fermée à l'arrêt)");
  });

  it("affiche l'URL telle quelle", () => {
    expect(stepLabel({ kind: "url", url: "http://localhost:5173" }, projects, apps)).toBe("http://localhost:5173");
  });

  it("signale une référence supprimée", () => {
    expect(stepLabel({ kind: "editor", projectId: 99 }, projects, apps)).toBe("projet supprimé dans l'éditeur");
    expect(stepLabel({ kind: "app", appId: 99, closeOnStop: false }, projects, apps)).toBe("application supprimée");
  });
});

describe("defaultStep", () => {
  it("produit une étape du bon type pour chaque entrée de STEP_KINDS", () => {
    for (const { kind } of STEP_KINDS) expect(defaultStep(kind, projects, apps).kind).toBe(kind);
  });

  it("utilise le premier projet et la première application", () => {
    expect(defaultStep("editor", projects, apps)).toEqual({ kind: "editor", projectId: 1 });
    expect(defaultStep("folder", projects, apps)).toEqual({ kind: "folder", projectId: 1 });
    expect(defaultStep("script", projects, apps)).toEqual({ kind: "script", projectId: 1, script: "dev", openBrowser: true });
    expect(defaultStep("app", projects, apps)).toEqual({ kind: "app", appId: 7, closeOnStop: false });
    expect(defaultStep("url", projects, apps)).toEqual({ kind: "url", url: "http://localhost:3000" });
  });

  it("retombe sur l'identifiant 0 sans projet ni application", () => {
    expect(defaultStep("editor", [], [])).toEqual({ kind: "editor", projectId: 0 });
    expect(defaultStep("app", [], [])).toEqual({ kind: "app", appId: 0, closeOnStop: false });
  });
});
