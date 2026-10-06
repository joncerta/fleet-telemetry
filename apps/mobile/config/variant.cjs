/* global module */
// Falla en cerrado: sin APP_VARIANT el build es de producción (sin HTTP en claro). El HTTP en claro solo se habilita
// con APP_VARIANT=development, que hay que definir a propósito para trabajar en local (ver .env.example).
/** @param {string | undefined} raw */
function resolveVariant(raw) {
  const value = (raw ?? "").trim();
  return value === "" ? "production" : value;
}

/** @param {string} variant */
function allowsCleartext(variant) {
  return variant === "development";
}

module.exports = { resolveVariant, allowsCleartext };
