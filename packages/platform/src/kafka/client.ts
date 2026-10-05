import { Kafka, logLevel, type KafkaConfig, type LogEntry } from "kafkajs";
import type { Logger } from "pino";

export interface CreateKafkaOptions {
  /** Lista `host:puerto`. Viene de la configuración (`KAFKA_BROKERS`), nunca del código. */
  brokers: readonly string[];
  clientId: string;
  /** TLS y SASL (MSK con IAM en AWS) se inyectan desde la configuración del servicio; local va sin ellos. */
  ssl?: KafkaConfig["ssl"];
  sasl?: KafkaConfig["sasl"];
  /** Si se pasa, los logs de kafkajs salen por este logger estructurado en vez de la consola. */
  logger?: Logger;
  connectionTimeout?: number;
  requestTimeout?: number;
}

/** Cliente kafkajs. Cada proceso crea uno y de él salen su único productor, su consumer y el admin. */
export function createKafka(options: CreateKafkaOptions): Kafka {
  const { brokers, clientId, ssl, sasl, logger, connectionTimeout, requestTimeout } = options;
  return new Kafka({
    clientId,
    brokers: [...brokers],
    ...(ssl !== undefined && { ssl }),
    ...(sasl !== undefined && { sasl }),
    ...(connectionTimeout !== undefined && { connectionTimeout }),
    ...(requestTimeout !== undefined && { requestTimeout }),
    // Con logger propio, kafkajs emite todo y pino decide por nivel.
    ...(logger !== undefined && { logLevel: logLevel.DEBUG, logCreator: kafkaLogCreator(logger) }),
  });
}

/** Adapta los logs de kafkajs a pino: mismo formato JSON y misma redacción de datos personales. */
export function kafkaLogCreator(logger: Logger): () => (entry: LogEntry) => void {
  return () =>
    ({ namespace, level, log }) => {
      const { message, timestamp: _timestamp, logger: _name, ...extra } = log;
      const line = { kafka: { namespace, ...extra } };
      switch (level) {
        case logLevel.ERROR:
          logger.error(line, message);
          break;
        case logLevel.WARN:
          logger.warn(line, message);
          break;
        case logLevel.INFO:
          logger.info(line, message);
          break;
        default:
          logger.debug(line, message);
      }
    };
}
