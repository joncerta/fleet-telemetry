# ADR-001 — Stack del MVP: TypeScript de punta a punta

- **Estado:** aceptado
- **Fecha:** 2026-10-04, aprobado con el plan (`docs/PLAN.md`, "Decisiones aprobadas" 1 y 2)
- **Relacionados:** ADR-002 (persistencia), pendiente para la fase 1d

## Contexto

- El MVP cubre ingesta de telemetría por bus de eventos, read model con SSE, un agente LLM con herramientas tipadas, un dashboard web y una app móvil offline-first.
- Hay un solo desarrollador, que orquesta subagentes de IA, y unos dos días de plazo.
- Los mismos datos cruzan cinco límites: HTTP, Kafka, SSE, las herramientas del agente y la cola offline del móvil. Si cada lado tiene su propia definición, la deriva entre ellos es el riesgo principal.
- La carga de la ingesta es de I/O: validar un JSON, producir a Kafka y responder un ACK. El cómputo geoespacial pesado lo hace PostGIS, no el servicio.

## Decisión

Todo el stack va en **TypeScript estricto (ESM) sobre Node 24 LTS**:

| Pieza | Elección |
|---|---|
| HTTP | Fastify 5 |
| Kafka | kafkajs (Redpanda en local, MSK Serverless en AWS) |
| Base de datos | `pg` sobre TimescaleDB + PostGIS (justificación en ADR-002) |
| Contratos | zod 4 en `@fleet/contracts`, compartido por servicios, web, móvil y agente |
| Agente | LangChain `createAgent` con herramientas `tool()` definidas con zod |
| Resiliencia | opossum |
| Tests | Vitest (unitarios, integración y e2e) |
| Monorepo | pnpm + Turborepo |
| Web / móvil | Next.js / Expo (React Native) |

**Node 24** y no Node 20: Node 20 dejó de tener soporte el 2026-04-30. Node 24 es la LTS activa y la que está instalada en el entorno de desarrollo.

## Por qué

1. **Una sola fuente de verdad para los contratos, validada en runtime.** El mismo esquema zod valida el body en el gateway, parsea el mensaje en el consumer, tipa el evento SSE en la web y la cola del móvil, y define el esquema de entrada de cada herramienta del agente: `tool()` acepta zod directamente. Con Go o .NET habría que generar código desde JSON Schema o protobuf y mantener una segunda validación en web y móvil.
2. **La carga no la limita la CPU de Node.** El gateway es I/O asíncrono y escala horizontalmente igual que el processor, que escala con las particiones de `telemetry.raw` (key = `vehicleId`). El trabajo espacial está en PostGIS.
3. **Un solo lenguaje para los agentes y para la revisión.** Los subagentes implementan y `architect-reviewer` audita contra un único conjunto de reglas e idioms. Esto reduce la superficie donde la IA se equivoca sin que nadie lo note.

## Alternativas descartadas

- **Go.** Es más eficiente en CPU y memoria, compila a binario estático y tiene clientes Kafka maduros (franz-go, confluent-kafka-go). Se descarta porque duplica los contratos frente a la web y el móvil, el ecosistema de agentes LLM en Go está menos maduro y el cuello de botella del MVP no es la CPU del gateway.
  - **Cuándo revisarlo:** si k6 muestra el p99 del gateway limitado por CPU. Se puede reescribir solo el gateway en Go con los mismos contratos, exportados con `z.toJSONSchema`.
- **.NET.** Es tipado, rinde bien y tiene cliente oficial de Confluent. Se descarta por la misma duplicación de contratos, imágenes más pesadas y un ecosistema de agentes (Semantic Kernel) distinto del de la web.
- **Cassandra o Druid para la persistencia.** Se tratan en ADR-002. En resumen: el sink idempotente con `ON CONFLICT`, el estado por vehículo, las consultas geoespaciales y las consultas acotadas que necesita el agente piden SQL con PostGIS, no un store de escritura masiva ni un motor OLAP.

## Cliente Kafka: kafkajs, con salida definida

- **Por qué kafkajs:** es JavaScript puro, sin binario nativo, así que instala igual en Windows, en CI y en contenedores; tiene producer idempotente y control explícito de offsets.
- **Riesgo aceptado:** su mantenimiento está detenido.
- **Salida:** `@confluentinc/kafka-javascript` (sobre librdkafka) ofrece una API compatible con kafkajs. Para que el cambio quede acotado:
  - los clientes Kafka se crean solo en las fábricas de `@fleet/platform`;
  - los servicios dependen de puertos, no de kafkajs;
  - la configuración que importa la fija la fábrica: producer idempotente con `acks=-1` forzado y sin autocreación de tópicos. Hoy la cubren tests unitarios, más un test de integración de produce y consume contra Redpanda;
  - el commit de offsets después de persistir y la idempotencia del sink se probarán contra Redpanda y TimescaleDB reales en la fase 1a, con el processor.

## Consecuencias

- **Positivas:**
  - un solo cambio de contrato (`/add-contract`) llega a todos los productores y consumidores, con fixtures de la versión anterior que lo prueban;
  - un solo toolchain de build, lint y test en el monorepo.
- **Negativas:**
  - Node consume más memoria por réplica que Go;
  - la dependencia de kafkajs es una deuda explícita, con la salida descrita arriba;
  - en MSK Serverless la autenticación es IAM, lo que exige configurar SASL en la fábrica de Kafka (fase 4).
- **Cuándo revisar esta decisión:**
  - saturación de CPU medida con k6;
  - una vulnerabilidad sin parche en kafkajs;
  - un requisito de throughput que las particiones no resuelvan.
