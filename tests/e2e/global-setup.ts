import { loadConfig } from "@fleet/platform";
import { assertStackAvailable } from "@fleet/platform/testing";
import { e2eConfigSchema } from "./support.js";

/** Valida las variables (nombra las que falten) y que TimescaleDB y Redpanda respondan antes de correr. */
export default async function setup(): Promise<void> {
  const config = loadConfig(e2eConfigSchema);
  await assertStackAvailable({ databaseAdminUrl: config.DATABASE_ADMIN_URL, kafkaBrokers: config.KAFKA_BROKERS });
}
