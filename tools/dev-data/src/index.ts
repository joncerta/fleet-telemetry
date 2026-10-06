// API que `@fleet/simulator` reutiliza: la emisión de tokens, la guarda de base local y los datos sembrados. Solo local.
// No exporta los comandos (`cli/*` tienen efectos al importarse).
export { devDataConfigSchema, resolveDatabaseUrl, type DevDataConfig, type ResolvedDatabase } from "./database.js";
export { issueDeviceToken, type IssuedDeviceToken } from "./device-token.js";
export { assertLocalDatabase, LocalOnlyError } from "./local-only.js";
export { runSeed } from "./seed.js";
export {
  SEED_TENANTS,
  SEED_ZONES,
  VEHICLES_PER_TENANT,
  seedVehicles,
  zoneCenter,
  type SeedTenant,
  type SeedVehicle,
  type SeedZone,
} from "./seed-data.js";
