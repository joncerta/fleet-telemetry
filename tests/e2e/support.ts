import { databaseAdminConfig, databaseReadOnlyConfig, kafkaConfig } from "@fleet/platform";
import { z } from "zod";

/** Variables que necesitan los tests e2e de infraestructura. */
export const e2eConfigSchema = z.object({
  ...databaseAdminConfig.shape,
  ...databaseReadOnlyConfig.shape,
  ...kafkaConfig.shape,
});
