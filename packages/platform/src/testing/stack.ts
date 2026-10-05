import { Kafka, logLevel } from "kafkajs";
import { Client } from "pg";

export interface StackTargets {
  /** `DATABASE_ADMIN_URL`. */
  databaseAdminUrl: string;
  /** `KAFKA_BROKERS` ya como lista. */
  kafkaBrokers: readonly string[];
}

const CHECK_TIMEOUT_MS = 4_000;

/**
 * Comprueba que TimescaleDB y Redpanda responden. Los tests de integración y e2e lo llaman en su `globalSetup`:
 * si el stack no está, fallan con un mensaje claro en vez de saltarse (regla 17 de CLAUDE.md).
 */
export async function assertStackAvailable(targets: StackTargets): Promise<void> {
  const failures: string[] = [];

  await Promise.all([
    checkPostgres(targets.databaseAdminUrl).catch((error: unknown) => {
      failures.push(`- TimescaleDB (${describeHost(targets.databaseAdminUrl)}): ${reason(error)}`);
    }),
    checkKafka(targets.kafkaBrokers).catch((error: unknown) => {
      failures.push(`- Redpanda (${targets.kafkaBrokers.join(",")}): ${reason(error)}`);
    }),
  ]);

  if (failures.length > 0) {
    throw new Error(
      `El stack local no responde, así que no se pueden correr estos tests:\n${failures.join("\n")}\n` +
        "Levántalo con `docker compose up -d --wait` y revisa `docker compose ps`.",
    );
  }
}

async function checkPostgres(url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: CHECK_TIMEOUT_MS });
  client.on("error", () => undefined); // el fallo ya lo reporta connect() o query()
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkKafka(brokers: readonly string[]): Promise<void> {
  const kafka = new Kafka({
    clientId: "fleet-stack-check",
    brokers: [...brokers],
    connectionTimeout: CHECK_TIMEOUT_MS,
    requestTimeout: CHECK_TIMEOUT_MS,
    retry: { retries: 0 },
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.listTopics();
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

/** Host y puerto de la URL, sin usuario ni contraseña. */
function describeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "URL inválida";
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido";
}
