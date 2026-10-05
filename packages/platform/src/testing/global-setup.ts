import { z } from "zod";
import { databaseAdminConfig, kafkaConfig } from "../config/fragments.js";
import { loadConfig } from "../config/load-config.js";
import { assertStackAvailable } from "./stack.js";

const schema = z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape });

/**
 * `globalSetup` de vitest para los tests de integración: valida las variables (el error nombra las que faltan,
 * p. ej. un `.env` viejo sin `DATABASE_ADMIN_URL`) y que el stack responda.
 */
export default async function setup(): Promise<void> {
  const config = loadConfig(schema);
  await assertStackAvailable({ databaseAdminUrl: config.DATABASE_ADMIN_URL, kafkaBrokers: config.KAFKA_BROKERS });
}
