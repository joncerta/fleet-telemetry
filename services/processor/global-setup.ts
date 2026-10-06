import { databaseAdminConfig, kafkaConfig, loadConfig } from "@fleet/platform";
import { assertStackAvailable } from "@fleet/platform/testing";
import { z } from "zod";

/** Valida las variables (nombra las que falten) y que TimescaleDB y Redpanda respondan antes de correr. */
export default async function setup(): Promise<void> {
  const config = loadConfig(z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape }));
  await assertStackAvailable({ databaseAdminUrl: config.DATABASE_ADMIN_URL, kafkaBrokers: config.KAFKA_BROKERS });
}
