---
name: new-usecase
description: Crea un caso de uso nuevo en un servicio backend de Fleet Telemetry respetando Clean Architecture (contrato, dominio, puerto, caso de uso con test primero, adaptador con test de integración, wiring y entrada HTTP, Kafka o herramienta del agente). Úsala cuando el humano pida un caso de uso, endpoint, consumer o herramienta nueva en services/*.
argument-hint: "[servicio] [descripción del caso de uso]"
context: fork
agent: backend-engineer
---

Crea este caso de uso: **$ARGUMENTS**

Servicios disponibles: !`ls services 2>/dev/null || echo "(services/ no existe todavía)"`

## 0. Entender antes de escribir

- El primer argumento es el servicio. Si no coincide con uno de la lista, detente y devuelve la pregunta.
- Lee un **caso de uso existente del mismo servicio** (en `services/<servicio>/src/application/`) junto con su test, su adaptador y su entrada, y sigue esa convención:
  - nombres de archivos y funciones;
  - firma (cómo recibe el contexto de tenant y usuario);
  - forma de los errores de dominio y cómo se traducen a HTTP.
- Define en una línea: qué hace, quién lo dispara (**HTTP**, **consumer de Kafka**, **herramienta del agente IA** o varios), qué lee y qué escribe.
- Si la regla de negocio es ambigua, detente y devuelve la pregunta.

## Pasos, en orden

Ningún paso se salta en silencio. Si uno no aplica, márcalo como **"no aplica: <motivo>"** en el resumen.

1. **Contrato**: si cruza un límite (HTTP, Kafka, SSE, herramienta del agente), sigue la skill `add-contract`. Si se reutiliza un esquema existente, indica cuál.
2. **Dominio** en `domain/`: entidades, value objects y reglas puras que necesite el caso de uso, sin I/O ni imports de infraestructura. Si la lógica es solo orquestación, puede no aplicar.
3. **Puerto** (interface) en `application/ports.ts`, con nombres del dominio, no de la tecnología (`VehiclePositionsRepository`, no `PgRepo`).
4. **Test del caso de uso primero** en `application/<nombre>.test.ts`, con fakes de los puertos. Cubre:
   - el camino feliz;
   - cada error de negocio;
   - el fallo de un puerto, que se propaga o se traduce, nunca se traga;
   - que el tenant del contexto se pasa a cada puerto que lee o escribe datos;
   - si es un comando que puede repetirse (consumer, reintento): idempotencia.

   Ejecútalo y confirma que falla por la razón correcta.
5. **Caso de uso** en `application/<nombre>.ts`.
   - Solo importa de `domain/` y de los puertos.
   - Recibe el contexto (tenant y usuario) de forma explícita. Nunca lo obtiene de una variable global ni del input del cliente.
   - El test del paso 4 pasa.
6. **Adaptador** en `infrastructure/`, solo si el puerto es nuevo o cambia:
   - **SQL**: parametrizado; filtro por tenant; rango de tiempo en hypertables; `LIMIT` y paginación por keyset en listados; transacción si hay varias escrituras relacionadas; `ST_MakePoint(lon, lat)`.
   - **HTTP a otro servicio**: cliente con circuit breaker a nivel de módulo, siguiendo `services/agent/src/infrastructure/resilient-fleet-client.ts`.
   - **Test de integración** del adaptador contra TimescaleDB/PostGIS o Redpanda reales, con el mecanismo que defina CLAUDE.md.
7. **Migración**, si se persiste algo nuevo: una migración nueva y reversible en `infra/db/migrations/`, con el siguiente número libre. Nunca edites una existente.
8. **Wiring** en `main.ts`.
9. **Entrada** en `interfaces/`. Solo valida, llama al caso de uso y mapea; sin lógica de negocio:
   - **HTTP (Fastify)**: schema zod de request y de respuesta en la ruta; `tenantId` desde la auth; errores de dominio traducidos a códigos HTTP sin filtrar detalles internos.
   - **Consumer de Kafka**: parseo con el schema del contrato; `await` de todo el caso de uso antes de confirmar el offset; inválidos y reintentos agotados a la DLQ.
   - **Herramienta del agente IA**: `tool()` con schema zod; **`tenantId` inyectado desde el contexto del servidor, nunca como argumento del LLM**; resultados acotados.
10. **Verificación**:
    - `pnpm --filter @fleet/<servicio> typecheck`
    - `pnpm --filter @fleet/<servicio> lint`, si existe
    - `pnpm --filter @fleet/<servicio> test`
    - los tests de integración del adaptador
    - **test e2e** del flujo en `tests/e2e/`: dispara el caso de uso por su entrada real (HTTP, evento de Kafka o pregunta al agente) y verifica el efecto observable (respuesta, fila persistida, evento SSE). Ejecuta `pnpm test:e2e`. Si el stack no está arriba, el caso de uso no está terminado.

## Al terminar

Entrega el resumen con el formato de `backend-engineer`, con estos agregados:
- la tabla de los pasos 1 a 10 con `hecho` o `no aplica: <motivo>`;
- el disparador del caso de uso (HTTP, Kafka o herramienta) y su ruta, tópico o nombre de herramienta.

Siguiente paso: `/arch-review`.
