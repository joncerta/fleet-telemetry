import { describe, expect, it } from "vitest";
import { clearPanelPreferences, panelStorageKey, parsePanelPreferences, readPanelPreferences, resolveOpen, writePanelPreference, type PreferenceStorage } from "./panel-state";

const KEY = panelStorageKey("user-1");

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage {
  const data = { ...initial };
  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const throwing: PreferenceStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("preferencias de paneles", () => {
  it("la clave es por usuario", () => {
    expect(panelStorageKey("a")).not.toBe(panelStorageKey("b"));
  });

  it("guarda y vuelve a leer, conservando los demás paneles", () => {
    const storage = memoryStorage();
    expect(writePanelPreference(storage, KEY, "alerts", false)).toBe(true);
    expect(writePanelPreference(storage, KEY, "vehicles", true)).toBe(true);
    expect(readPanelPreferences(storage, KEY)).toEqual({ alerts: false, vehicles: true });
  });

  it("un usuario no lee las preferencias de otro", () => {
    const storage = memoryStorage();
    writePanelPreference(storage, panelStorageKey("a"), "alerts", false);
    expect(readPanelPreferences(storage, panelStorageKey("b"))).toEqual({});
  });

  it("con localStorage fallando (lanza al leer y al escribir) no lanza: lee {} y reporta que no persistió", () => {
    expect(readPanelPreferences(throwing, KEY)).toEqual({});
    expect(writePanelPreference(throwing, KEY, "alerts", true)).toBe(false);
  });

  it("sin almacenamiento (null) usa los valores por defecto", () => {
    expect(readPanelPreferences(null, KEY)).toEqual({});
    expect(writePanelPreference(null, KEY, "alerts", true)).toBe(false);
  });

  it("descarta contenido corrupto o de otra forma", () => {
    expect(parsePanelPreferences("{no es json")).toEqual({});
    expect(parsePanelPreferences("[true]")).toEqual({});
    expect(parsePanelPreferences("null")).toEqual({});
    expect(parsePanelPreferences('{"alerts":"si","kpi":false,"vehicles":1}')).toEqual({ kpi: false });
    expect(parsePanelPreferences(null)).toEqual({});
  });

  it("resolveOpen: la preferencia manda; sin ella, el valor por defecto", () => {
    expect(resolveOpen({ alerts: false }, "alerts", true)).toBe(false);
    expect(resolveOpen({}, "alerts", true)).toBe(true);
    expect(resolveOpen({}, "vehicles", false)).toBe(false);
  });
});

describe("clearPanelPreferences", () => {
  function clearable(initial: Record<string, string>) {
    const data = { ...initial };
    return {
      data,
      get length() {
        return Object.keys(data).length;
      },
      key: (index: number) => Object.keys(data)[index] ?? null,
      removeItem: (key: string) => void delete data[key],
    };
  }

  it("borra las preferencias de todos los usuarios y deja lo demás", () => {
    const storage = clearable({ [panelStorageKey("a")]: "{}", [panelStorageKey("b")]: "{}", otra: "x" });
    clearPanelPreferences(storage);
    expect(storage.data).toEqual({ otra: "x" });
  });

  it("no lanza con storage nulo o que falla", () => {
    expect(() => clearPanelPreferences(null)).not.toThrow();
    const broken = {
      length: 1,
      key: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => undefined,
    };
    expect(() => clearPanelPreferences(broken)).not.toThrow();
  });
});
