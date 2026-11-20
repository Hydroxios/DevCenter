import { describe, expect, it } from "vitest";

import { remoteCache } from "./remoteCache";

describe("remoteCache", () => {
  it("rend la dernière valeur enregistrée", () => {
    expect(remoteCache.get("metrics:1")).toBeUndefined();
    remoteCache.set("metrics:1", { cpu: 10 });
    remoteCache.set("metrics:1", { cpu: 20 });
    expect(remoteCache.get<{ cpu: number }>("metrics:1")).toEqual({ cpu: 20 });
  });

  it("oublie toutes les entrées d'un serveur, et seulement celles-là", () => {
    remoteCache.set("metrics:5", 1);
    remoteCache.set("services:5", 2);
    remoteCache.set("metrics:15", 3);
    remoteCache.set("metrics:51", 4);
    remoteCache.forget(5);
    expect(remoteCache.get("metrics:5")).toBeUndefined();
    expect(remoteCache.get("services:5")).toBeUndefined();
    expect(remoteCache.get("metrics:15")).toBe(3);
    expect(remoteCache.get("metrics:51")).toBe(4);
  });
});
