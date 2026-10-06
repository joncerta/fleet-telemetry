export { ConfigError, loadConfig, type Env } from "./config/load-config.js";
export {
  databaseAdminConfig,
  databaseConfig,
  databaseReadOnlyConfig,
  migrationConfig,
  shutdownConfig,
  kafkaConfig,
  logConfig,
  sessionSecretConfig,
  LOG_LEVELS,
  type LogLevel,
} from "./config/fragments.js";

export { createLogger, withContext, REDACTED_KEYS, REDACTED, TRUNCATED, MAX_REDACTION_DEPTH, redactDeep, type CreateLoggerOptions, type LogContext, type Logger } from "./logger/logger.js";

export { createKafka, kafkaLogCreator, type CreateKafkaOptions } from "./kafka/client.js";
export {
  ACKS_ALL,
  createProducer,
  FLEET_PARTITIONER,
  type FleetMessage,
  type FleetProducer,
  type FleetProducerOptions,
  type FleetSendBatch,
  type FleetSendRecord,
  type ProducerSource,
} from "./kafka/producer.js";
export { DEFAULT_MAX_BATCH_BYTES, MESSAGE_OVERHEAD_BYTES, splitBySize } from "./kafka/batching.js";
export { createAdmin, createConsumer, type AdminSource, type ConsumerSource, type FleetConsumerOptions } from "./kafka/admin-consumer.js";
export {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_PATTERN,
  CorrelationIdError,
  getCorrelationId,
  isValidCorrelationId,
  resolveCorrelationId,
  withCorrelationId,
  type CorrelatedHeaders,
} from "./kafka/headers.js";

export { createPool, type CreatePoolOptions } from "./postgres/pool.js";

export { MigrationError, checksumOf, loadMigrationFiles, type MigrationFile } from "./migrations/files.js";
export { FLEET_ROLES, scramSha256Verifier, setRolePasswords, type FleetRole, type Queryable, type RolePasswords } from "./migrations/roles.js";
export { formatMigrationStatus } from "./migrations/format-status.js";
export { DEFAULT_ROLLBACK_TARGET, parseRollbackArgs, parseRollbackCommand, type RollbackCommand, type RollbackTarget } from "./migrations/rollback-target.js";
export {
  assertLocalDatabaseHost,
  assertLocalEnvironmentMark,
  ENVIRONMENT_SETTING,
  LOCAL_DATABASE_HOSTS,
} from "./migrations/local-guard.js";
export { DEFAULT_SESSION_TIMEOUTS, type SessionTimeouts } from "./migrations/control.js";
export {
  defaultMigrationsDir,
  getMigrationStatus,
  migrate,
  rollback,
  type MigrateOptions,
  type MigrateResult,
  type MigrationStatus,
  type RollbackOptions,
  type RollbackResult,
} from "./migrations/runner.js";

export { sha256Hex } from "./security/hash.js";
export { DEFAULT_SCRYPT_PARAMS, hashPassword, verifyPassword, type ScryptParams } from "./security/password.js";
export { createSessionCodec, SESSION_SECRET_MIN_BYTES, type SessionClaims, type SessionCodec } from "./security/session-codec.js";

export {
  installGracefulShutdown,
  type GracefulShutdown,
  type GracefulShutdownOptions,
  type ShutdownEventSource,
  type ShutdownStep,
} from "./lifecycle/shutdown.js";
