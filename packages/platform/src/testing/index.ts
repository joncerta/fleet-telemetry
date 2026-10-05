// Utilidades para tests de integración y e2e contra el stack real. Se importan como `@fleet/platform/testing`.
export { findRepoRoot, loadRootEnv } from "./env.js";
export { assertStackAvailable, type StackTargets } from "./stack.js";
export { createTempDatabase, dropTempDatabase, withDatabase, type TempDatabase } from "./temp-database.js";
export { createTempTopic, type TempTopic } from "./temp-topic.js";
