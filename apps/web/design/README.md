# Diseño · Portal Corporativo de Monitoreo de Flotas

Diseño para la *Take-Home Assessment: Senior Fullstack Engineer — Telemetría y Desarrollo Agéntico*.
Stack fijado: **S4 Web** (Next.js App Router + TS, MapLibre GL, Tailwind, SSE + store, `@fleet/contracts`)
y **S5 Móvil** (Expo dev build Android, expo-location, expo-sqlite, NetInfo, GitHub Actions + EAS + Fastlane).

> **Estado:** 3 opciones propuestas, pendiente de elegir una. Tras la elección se detalla
> (ADRs, esquemas SQL, docker-compose, k6, workflows) y se descartan las otras dos.

| Documento | Contenido |
|---|---|
| [00-base-comun.md](./00-base-comun.md) | Requisitos → trazabilidad, monorepo, `@fleet/contracts`, S4 y S5 invariantes |
| [opcion-a-ts-fast-track.md](./opcion-a-ts-fast-track.md) | Todo TypeScript, Redpanda, TimescaleDB, LangChain.js |
| [opcion-b-go-poliglota.md](./opcion-b-go-poliglota.md) | Go en ingesta/procesamiento, TS en BFF/agente, Kafka, TimescaleDB |
| [opcion-c-cqrs-event-sourcing.md](./opcion-c-cqrs-event-sourcing.md) | CQRS/ES, Cassandra + Redis, agente .NET Semantic Kernel |

## Comparativa

| Dimensión | A · TS Fast Track | B · Go políglota | C · CQRS/ES |
|---|---|---|---|
| Backend | TS (Fastify) | Go + TS | Go + .NET |
| Bus | Redpanda | Kafka KRaft | Kafka (event store) |
| Persistencia | Timescale + PostGIS | Timescale + PostGIS | Cassandra + Redis |
| Agente | LangChain.js | LangChain.js | Semantic Kernel |
| Store web | Zustand | Hook propio (`useSyncExternalStore`) | Zustand |
| Build móvil | EAS nube + Fastlane | `eas build --local` + Fastlane | EAS nube + `eas submit` + Fastlane |
| IaC | Terraform | Terraform multi-cuenta | AWS CDK |
| Esfuerzo estimado | ≈ 8–9 h | ≈ 10–11 h | ≈ 14–16 h |
| RAM local | ≈ 2,5 GB | ≈ 4 GB | ≈ 6–8 GB |
| Alineación con stack corporativo | Media | **Alta** | Muy alta |
| Riesgo de no terminar | Bajo | Medio | **Alto** |
| Fuerza en “Manejo de datos” | Alta | Alta | Muy alta |
| Fuerza en “Arquitectura agéntica” | Alta | Alta | Media (menos tiempo para auditar) |

## Recomendación

**Opción B.** Encaja en el presupuesto de 8–12 h, muestra Go en el camino caliente (lo que la
empresa opera), conserva TS donde compartir `@fleet/contracts` aporta (web, móvil, BFF, agente) y
TimescaleDB + PostGIS es la mejor justificación de BD para un agente que necesita consultas
ad-hoc y geocercas. Si el tiempo aprieta, A es la salida segura; C solo si se prioriza el relato
sobre la entrega completa.
