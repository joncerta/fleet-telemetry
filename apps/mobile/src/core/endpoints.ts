export class EndpointConfigError extends Error {
  constructor(readonly variable: string, readonly reason: "missing" | "not_https") {
    super(`${variable}: ${reason === "missing" ? "falta la variable" : "debe ser https://"}`);
    this.name = "EndpointConfigError";
  }
}

/**
 * URL base de un servicio. Falla en cerrado:
 * - en desarrollo (`__DEV__`): usa la variable o, si falta, el valor por defecto del emulador;
 * - fuera de desarrollo: la variable es obligatoria y debe ser `https://`. Nunca cae a un host de desarrollo en claro.
 */
export function resolveBaseUrl(args: {
  readonly variable: string;
  readonly configured: string | undefined;
  readonly isDev: boolean;
  readonly devDefault: string;
}): string {
  const value = args.configured?.trim() ?? "";
  if (args.isDev) return (value === "" ? args.devDefault : value).replace(/\/+$/, "");
  if (value === "") throw new EndpointConfigError(args.variable, "missing");
  if (!/^https:\/\//i.test(value)) throw new EndpointConfigError(args.variable, "not_https");
  return value.replace(/\/+$/, "");
}
