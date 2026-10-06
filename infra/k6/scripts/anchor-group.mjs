// Fija el consumer group del processor al FINAL de telemetry.raw si todavía no tiene offsets confirmados. SOLO LOCAL.
//
//   node --env-file-if-exists=.env infra/k6/scripts/anchor-group.mjs [grupo]      (por defecto PROCESSOR_CONSUMER_GROUP o "processor")
//
// Por qué: el processor se suscribe con `fromBeginning: true` (ADR-004.8). Un grupo nuevo en un Redpanda compartido
// reprocesaría todo el backlog de otras pruebas (telemetría de tenants ya borrados y rechazos repetidos en la DLQ). Anclarlo al
// final deja que consuma solo lo que se envíe a partir de ahora. Si el grupo ya tiene offsets, no hace nada.
import { createKafkaClient, createScriptLogger, platform } from "./common.mjs";

const TOPIC = "telemetry.raw";
const groupId = process.argv[2] ?? process.env.PROCESSOR_CONSUMER_GROUP ?? "processor";
const logger = createScriptLogger("k6-anchor-group");

const kafka = createKafkaClient("k6-anchor-group");
const admin = platform.createAdmin(kafka);
try {
  await admin.connect();
  const committed = await admin.fetchOffsets({ groupId, topics: [TOPIC] });
  const topic = committed.find((item) => item.topic === TOPIC);
  const hasOffsets = topic?.partitions.some((partition) => Number(partition.offset) >= 0) ?? false;
  if (hasOffsets) {
    logger.info({ groupId }, "El grupo ya tiene offsets confirmados: no se toca");
  } else {
    const end = await admin.fetchTopicOffsets(TOPIC);
    await admin.setOffsets({ groupId, topic: TOPIC, partitions: end.map(({ partition, offset }) => ({ partition, offset })) });
    logger.info({ groupId, partitions: end.length }, "Grupo anclado al final de telemetry.raw");
  }
} catch (error) {
  process.stderr.write(`anchor-group falló: ${error instanceof Error ? error.message : "error desconocido"}\n`);
  process.exitCode = 1;
} finally {
  await admin.disconnect();
}
