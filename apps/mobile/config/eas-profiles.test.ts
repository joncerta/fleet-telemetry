import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { resolveVariant, allowsCleartext } = require("./variant.cjs") as {
  resolveVariant: (raw: string | undefined) => string;
  allowsCleartext: (variant: string) => boolean;
};

interface Profile {
  developmentClient?: boolean;
  distribution?: string;
  environment?: string;
  autoIncrement?: boolean;
  android?: { buildType?: string };
  env?: Record<string, string>;
}
interface EasConfig {
  cli?: { appVersionSource?: string };
  build: Record<string, Profile>;
  submit?: unknown;
}

const eas = JSON.parse(readFileSync(new URL("../eas.json", import.meta.url), "utf8")) as EasConfig;
const profile = (name: string): Profile => {
  const found = eas.build[name];
  if (found === undefined) throw new Error(`falta el perfil ${name}`);
  return found;
};

describe("perfiles de EAS (eas.json)", () => {
  it("define exactamente development, preview y production", () => {
    expect(Object.keys(eas.build).sort()).toEqual(["development", "preview", "production"]);
  });

  it("versionCode lo gestiona EAS (remoto) y production lo incrementa solo", () => {
    expect(eas.cli?.appVersionSource).toBe("remote");
    expect(profile("production").autoIncrement).toBe(true);
  });

  it("development es un development client con HTTP en claro solo ahí", () => {
    const development = profile("development");
    expect(development.developmentClient).toBe(true);
    expect(allowsCleartext(resolveVariant(development.env?.APP_VARIANT))).toBe(true);
  });

  it("preview es un APK interno y production un AAB", () => {
    expect(profile("preview").distribution).toBe("internal");
    expect(profile("preview").android?.buildType).toBe("apk");
    expect(profile("production").android?.buildType).toBe("app-bundle");
  });

  it("preview y production nunca permiten HTTP en claro ni fijan URLs http (HTTPS obligatorio)", () => {
    for (const name of ["preview", "production"]) {
      const { env = {}, developmentClient } = profile(name);
      expect(developmentClient).not.toBe(true);
      expect(allowsCleartext(resolveVariant(env.APP_VARIANT))).toBe(false);
      for (const [key, value] of Object.entries(env)) {
        if (key.startsWith("EXPO_PUBLIC_")) expect(value, `${name}.${key}`).toMatch(/^https:\/\//);
      }
    }
  });

  it("preview y production leen las URLs del entorno de EAS y no las fijan en el repo", () => {
    expect(profile("preview").environment).toBe("preview");
    expect(profile("production").environment).toBe("production");
  });

  it("ningún perfil lleva secretos ni tokens en env (EXPO_PUBLIC_* queda dentro del bundle)", () => {
    for (const [name, { env = {} }] of Object.entries(eas.build)) {
      for (const key of Object.keys(env)) {
        expect(key, `${name}.${key}`).toMatch(/^(APP_VARIANT|EXPO_PUBLIC_(INGEST|FLEET_API)_URL)$/);
      }
    }
  });

  it("no hay sección submit: publicar es de Fastlane, manual y solo al track interno", () => {
    expect(eas.submit).toBeUndefined();
  });
});
