import { randomUUID } from "node:crypto";
import type { Admin } from "kafkajs";

const TEMP_TOPIC_NAME = /^fleet-it-[a-f0-9]{12}$/;

export interface TempTopic {
  readonly name: string;
  /** Borra el tópico. */
  drop(): Promise<void>;
}

/** Crea un tópico temporal `fleet-it-<runId>` con el admin; los tests nunca usan los tópicos reales. */
export async function createTempTopic(admin: Admin, partitions = 1): Promise<TempTopic> {
  const name = `fleet-it-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.createTopics({ topics: [{ topic: name, numPartitions: partitions, replicationFactor: 1 }], waitForLeaders: true });
  return {
    name,
    drop: async () => {
      if (!TEMP_TOPIC_NAME.test(name)) throw new Error(`Nombre de tópico temporal no permitido: ${name}`);
      await admin.deleteTopics({ topics: [name] });
    },
  };
}
