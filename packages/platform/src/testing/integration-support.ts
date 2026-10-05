import { z } from "zod";
import { databaseAdminConfig, kafkaConfig } from "../config/fragments.js";
import { loadConfig } from "../config/load-config.js";

/** Variables que necesitan los tests de integración de `@fleet/platform`. */
export const integrationConfig = loadConfig(z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape }));
