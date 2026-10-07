# Guion del video (≈10 minutos)

El guion tiene dos partes:
- **Bloques 1 a 10:** lo que se muestra y lo que se dice, para aprenderlo.
- **Anexos:** la preparación técnica y el material de estudio para responder preguntas (decisiones, bugs reales, números).

Los textos de **"Dices"** son una guía: dilos con tus palabras, sin leer.

---

## Preparación (antes de grabar)

**Ventanas:**
1. **Navegador:** el dashboard en <http://localhost:3000>. Usa una ventana normal para `operador@norte.test` y una de incógnito para `operador@sur.test`.
2. **Emulador Android** (`Pixel_10_Pro`), con la app del conductor.
3. **Terminal**, con la letra grande.
4. **Editor** con el repo abierto: `CLAUDE.md`, `.claude/`, `docs/`.
5. **Opcional:** tu celular conectado por USB, para mostrar la app en un dispositivo real.

**Cómo grabar:**
- OBS Studio, con una escena por ventana o la pantalla completa.
- O la barra de juegos de Windows (`Win+Alt+R`), que solo graba la ventana activa.
- Para grabar el celular aparte: `adb -s R5GYB21NJTN shell screenrecord /sdcard/demo.mp4` y luego `adb pull`.

**Arranque** (en este orden):

```bash
# 1. Sistema completo en contenedores: infra + migrate + gateway + processor + fleet-api + agente + web
docker compose --profile app up -d --wait

# 2. Datos de demo (2 tenants, 30 vehículos, zonas y usuarios); es idempotente
pnpm db:seed

# 3. Simulador con 14 vehículos por tenant: deja libres NRT115 y SUR115 para el emulador o el celular
SIMULATOR_VEHICLES_PER_TENANT=14 pnpm simulate     # déjalo corriendo al menos 2 minutos antes de grabar

# 4. Móvil por USB o en el emulador: puertos al PC (repítelo si reconectas el cable o reinicias el emulador)
adb -s emulator-5554 reverse tcp:4001 tcp:4001 && adb -s emulator-5554 reverse tcp:4002 tcp:4002 && adb -s emulator-5554 reverse tcp:8081 tcp:8081
```

**Comprobación previa:**
- [ ] `docker compose ps`: todo en `healthy`.
- [ ] El dashboard muestra vehículos moviéndose y al menos una alerta crítica.
- [ ] La app abre en el emulador; si hay un turno de una prueba anterior, ciérralo.
- [ ] No hay nada sensible en pantalla: ni `.env`, ni tokens, ni claves de API. Las placas, zonas y usuarios son de demo.
- [ ] Opcional: `/e2e-check video` en `LISTO`.

---

## Bloque 1 · Apertura (0:00 – 0:30)

**Pantalla:** el README en GitHub, en la sección 1, con el diagrama.

**Dices:**
> "Esto es Fleet Telemetry, un portal de monitoreo de flotas. El conductor tiene una app offline-first que captura su GPS. El backend la ingiere por un bus de eventos, la persiste en TimescaleDB con PostGIS y la muestra en un dashboard en tiempo real. Además hay un agente de IA que responde preguntas sobre la flota en lenguaje natural. La prueba evalúa el *cómo*, así que voy a mostrar el sistema funcionando y, sobre todo, las decisiones y los errores reales que corregimos en el camino."

---

## Bloque 2 · Arquitectura (0:30 – 1:30)

**Pantalla:** el diagrama del README y, en el editor, el árbol del monorepo: `services/`, `packages/contracts`, `apps/`.

**Dices:**
> "El flujo es: la app móvil manda lotes al `ingest-gateway`, que valida cada punto y lo publica en Kafka, con la key igual al vehículo para mantener el orden por vehículo. El `processor` consume, persiste de forma idempotente, calcula si el vehículo está detenido, en qué zona está y si hay que levantar una alerta, y publica el estado. `fleet-api` es el read model: REST más SSE para el dashboard. El agente usa herramientas tipadas sobre `fleet-api`.
>
> Todo es TypeScript de punta a punta, y hay **un solo paquete de contratos** con zod: el mismo esquema valida HTTP, los mensajes de Kafka, los eventos SSE, la app móvil y las herramientas del LLM. Si un contrato cambia, el cambio es aditivo, con fixtures de la versión anterior que tienen que seguir parseando.
>
> Cada servicio sigue Clean Architecture: dominio puro, casos de uso con puertos, adaptadores de Kafka y Postgres, y un único composition root."

---

## Bloque 3 · Dashboard en vivo (1:30 – 2:45)

**Pantalla:** login como `operador@norte.test`. Muestra:
- el mapa de Bogotá con vehículos moviéndose;
- los KPIs;
- una alerta crítica que aparece sin recargar;
- el panel "Detenidos +20 min en zonas críticas";
- abre y cierra paneles: el contador sigue visible cerrado, y al seleccionar un vehículo en el mapa se abre la lista.

**Dices:**
> "El dashboard abre un solo `EventSource`. El primer evento es un snapshot del estado, y después llegan los cambios. Cada evento trae una secuencia global, así que si llega uno viejo se descarta. 'Sin señal' se calcula contra la **hora del servidor**, no contra el reloj del navegador.
>
> Esta alerta es de un vehículo detenido más de 20 minutos en una zona crítica. Lo importante: 'detenido' se calcula con la **hora del fix GPS del dispositivo**, no con la hora de llegada. Si el teléfono estuvo sin señal y manda los puntos una hora después, la detención se calcula bien.
>
> La columna lateral es desplegable. Cada panel recuerda si lo dejaste abierto, muestra su contador aunque esté cerrado y, si hay un error, lo dice en el encabezado en vez de mostrar un número viejo."

---

## Bloque 4 · Aislamiento entre tenants (2:45 – 3:15)

**Pantalla:** en la ventana de incógnito, login como `operador@sur.test`. Solo aparece Medellín. Muestra los paneles Usuarios y Zonas: solo hay datos de Sur.

**Dices:**
> "Esto es multi-tenant real. El tenant sale **siempre de la identidad autenticada**: la cookie de sesión en la API y en el SSE, y el token del dispositivo en la ingesta. Nunca del body, de la query ni de lo que diga el LLM. Lo verificamos de punta a punta: con la cookie de Sur no aparece nada de Norte en vehículos, alertas, zonas, usuarios, el stream ni el agente. Incluso le inyectamos al agente una instrucción para que consultara otro tenant, y se negó."

---

## Bloque 5 · Móvil offline-first y vinculación (3:15 – 4:30)

**Pantalla:**
1. **Crear el vehículo y su código:** en el dashboard de Norte abre "Vincular dispositivo", elige **"Nuevo vehículo"** y escribe la placa `DEMO01` y el nombre "Camión demo". Pulsa "Crear y generar código" y se ve el código de 8 caracteres.
2. **Vincular:** en el emulador escribe el código y toca **Iniciar turno**. Acepta los permisos de ubicación, con "Permitir todo el tiempo".
3. **Mover el GPS:** `adb -s emulator-5554 emu geo fix -74.0817 4.6097` (longitud primero), o una ruta GPX desde los controles extendidos del emulador. El vehículo aparece en el mapa.
4. **Offline:** `adb -s emulator-5554 shell cmd connectivity airplane-mode enable`. Mueve el GPS un par de veces y el contador de pendientes sube.
5. **Volver en línea:** `... airplane-mode disable`. Los pendientes bajan a 0 y el mapa se pone al día.

**Dices:**
> "Desde el dashboard creo un vehículo nuevo y su código de vinculación de un solo uso en un solo paso. El código lo teclea el conductor, y la app recibe un token ligado a ese vehículo y a su tenant, que se guarda en el almacenamiento seguro del teléfono.
>
> La app es offline-first: cada punto se guarda primero en SQLite y el **`eventId` lo genera el dispositivo al capturar el punto**. Por eso un reenvío nunca duplica: el processor inserta con `ON CONFLICT DO NOTHING` sobre un índice único que incluye el tiempo.
>
> El gateway responde un ACK que separa `accepted` de `rejected` por `eventId`. Un reenvío de puntos ya guardados vuelve en `accepted`; si no, el teléfono los reintentaría para siempre. Un rechazo es permanente y queda con su motivo en la DLQ."

---

## Bloque 6 · Agente IA y circuit breaker (4:30 – 5:30)

**Pantalla:**
1. En Norte, abre "Asistente IA" y pregunta: *"¿Qué vehículos llevan detenidos más de 20 minutos en zonas críticas?"*. Se ven la respuesta y la `toolCall` `get_stopped_vehicles` con sus argumentos.
2. En la terminal, `docker compose stop fleet-api`. Haz 5 o 6 preguntas seguidas: el chat dice que no hay datos y el indicador del breaker pasa a abierto.
3. `docker compose start fleet-api`. A los pocos segundos se recupera.

**Dices:**
> "El agente no hace text-to-SQL: el LLM no construye consultas. Tiene **tres herramientas tipadas** con esquema zod y límites. El tenant lo inyecta el servidor desde la sesión; el modelo nunca lo ve ni lo puede elegir.
>
> Hay **dos circuit breakers**: uno hacia `fleet-api` y otro hacia el proveedor del modelo. Ahora apago `fleet-api`: el agente dice que no tiene datos, sin inventar nada, y tras unos fallos el circuito se abre y responde al instante. Al volver `fleet-api`, el breaker prueba y se cierra solo.
>
> Un detalle de diseño: en el breaker del modelo, los 429 y 408 del proveedor **sí** abren el circuito. Normalmente un 4xx no lo abre, porque es culpa de la petición, pero un 429 sostenido significa que el proveedor está saturado. Es una excepción aprobada y quedó escrita en las reglas del proyecto."

---

## Bloque 7 · Zonas dibujadas en el mapa (5:30 – 6:00)

**Pantalla:** en el panel "Zonas", pulsa **"Nueva zona"**. Haz 4 clics en el mapa y luego "Cerrar polígono". Escribe el nombre "Patio demo" y el tipo "Crítica", y guarda. La zona aparece en el mapa y en la lista. Opcional: muestra el botón "Agregar punto en el centro del mapa".

**Dices:**
> "El operador puede dibujar sus propias zonas. El dibujo valida en el cliente que el polígono no se cruce consigo mismo, que tenga área y que esté dentro de Colombia, y el servidor lo vuelve a validar con PostGIS. También se puede dibujar con teclado: el mapa se mueve con flechas y un botón agrega el punto del centro. El processor consulta las zonas en cada lote, así que una zona nueva cuenta de inmediato para las alertas."

---

## Bloque 8 · Persistencia y decisiones (6:00 – 6:45)

**Pantalla:** `docs/adr/002-persistencia-timescaledb-postgis.md`, con la tabla de evidencia, y la lista de ADRs en `docs/adr/`.

**Dices:**
> "¿Por qué TimescaleDB con PostGIS y no Cassandra? Lo medimos con 12 millones de filas.
> - Una consulta de 2 horas de un vehículo escanea **1 de 15 chunks** y tarda 0,08 ms.
> - La compresión da **5x**.
> - El continuous aggregate por hora es **62 veces** más rápido que la consulta cruda.
> - Un solo nodo ingiere unas **40 000 filas por segundo**, dos órdenes de magnitud por encima de la carga de referencia.
>
> Cassandra escala la escritura, pero no tiene geoespacial, ni agregados, ni modelo relacional para el read model: terminaríamos con dos bases. Druid es OLAP: no deduplica por `eventId` ni sirve para estado transaccional.
>
> Cada decisión tiene su ADR: hay 14, desde el stack hasta las zonas."

---

## Bloque 9 · Resiliencia, carga y caos (6:45 – 7:30)

**Pantalla:** la tabla de k6 del README (sección 5) y `infra/k6/`.

**Dices:**
> "Para la carga usamos k6 con un modelo abierto, cientos de vehículos, **10% de duplicados reales y 5% de inválidos**. Se verifica por conteos con un usuario de solo lectura, no con un endpoint público.
>
> Y el caos: matamos el processor con **SIGKILL a mitad de un lote**. Resultado: **cero pérdidas y cero duplicados**. Funciona porque el offset de Kafka se confirma **solo después de persistir**, y la persistencia es idempotente: at-least-once más un sink idempotente da, en la práctica, exactamente una vez. La latencia del ingest fue de 23 ms en p95 y 32 ms en p99."

---

## Bloque 10 · El entorno agéntico y un error real (7:30 – 9:15)

**Pantalla, en el editor:**
1. `CLAUDE.md`, con las 17 reglas.
2. `.claude/agents/`, con los 7 subagentes, y `.claude/skills/`, con las 8 skills.
3. `docs/AI_AUDIT_LOG.md`.
4. `tools/hooks/verify-affected.mjs`.
5. En GitHub, un PR con su revisión, por ejemplo el #5 o el #26.

**Dices:**
> "Todo esto se construyó orquestando subagentes de Claude Code, con un entorno pensado para que la IA no pueda saltarse la calidad.
> - **Contexto en capas:** un `CLAUDE.md` con 17 reglas que no se negocian, uno por área y un plan con trazabilidad de requisitos.
> - **Siete subagentes:** cuatro implementan (backend, web, móvil y devops), dos revisan en un modelo más capaz **sin poder editar**, y uno verifica de punta a punta.
> - **Un hook** que al terminar cada agente corre typecheck y tests de lo que tocó y **bloquea el cierre** si fallan.
> - **Permisos:** se puede verificar; para tocar dependencias, CI o git se pregunta; y está prohibido borrar datos, desplegar o leer secretos.
>
> Un ejemplo real: en la fase 1a el revisor **rechazó** el processor con un hallazgo crítico. Cualquier error desconocido se clasificaba como permanente, así que si la base se reiniciaba, todo el backlog terminaba en la DLQ con los offsets confirmados: pérdida de datos. Se corrigió para que falle en cerrado (solo los errores de datos van a la DLQ), con un test que lo reproduce quitando el permiso de INSERT.
>
> Otro de esta semana: corrimos la verificación final con el modelo real y el agente respondía 503 a todo. El log solo decía 'Error'. La causa era un 400 de Anthropic: la clave no estaba ligada a un workspace. Lo corregimos dos veces: el log ahora muestra el código y el tipo de error del proveedor, sin datos personales, y el agente soporta el header de workspace.
>
> Cada error real de la IA queda auditado con la propuesta original, el escenario de producción, la corrección y el test que la protege."

---

## Bloque 11 · Infraestructura, CI y cierre (9:15 – 10:00)

**Pantalla:** `infra/terraform/`, con los módulos, y en GitHub, la pestaña Actions con los jobs `verify`, `integration`, `infra` y `mobile`.

**Dices:**
> "La infraestructura en AWS está diseñada en Terraform:
> - VPC privada;
> - MSK Serverless con IAM y TLS;
> - TimescaleDB autogestionado en EC2, porque RDS no trae la extensión;
> - ECS Fargate detrás de un ALB solo en 443, con un idle timeout calculado contra el heartbeat del SSE;
> - KMS y secretos de solo escritura que no quedan en el estado;
> - presupuesto y alarmas.
>
> Está validada con `terraform validate`, `tflint` y `trivy` en CI, pero **no se despliega**: el entorno dev costaría unos 700 dólares al mes, el 80% por MSK, y región, dominio y presupuesto son decisiones de negocio.
>
> El CI corre unitarios, integración contra TimescaleDB y Redpanda reales, los e2e del backend y Playwright, levanta el perfil completo con un humo de k6 y tiene un pipeline móvil con EAS y Fastlane.
>
> La verificación final de punta a punta dio **LISTO, 11 de 11**, con el modelo real. Gracias."

---

## Anexo A · Comandos de la demo

| Para | Comando |
|---|---|
| Levantar todo | `docker compose --profile app up -d --wait` |
| Sembrar | `pnpm db:seed` |
| Simular sin pisar NRT115/SUR115 | `SIMULATOR_VEHICLES_PER_TENANT=14 pnpm simulate` |
| Puertos al emulador | `adb -s emulator-5554 reverse tcp:4001 tcp:4001` (también 4002 y 8081) |
| Mover el GPS del emulador | `adb -s emulator-5554 emu geo fix <lon> <lat>` (longitud primero) |
| Modo avión en el emulador | `adb -s emulator-5554 shell cmd connectivity airplane-mode enable` (o `disable`) |
| Romper fleet-api | `docker compose stop fleet-api` (y luego `start`) |
| Estado del agente | `curl -s localhost:4003/health` |
| Usuarios de demo | `operador@norte.test` y `operador@sur.test`, con la contraseña `SEED_USER_PASSWORD` |

> **Nunca** `docker compose down -v`: borra el volumen de datos (regla del proyecto).

---

## Anexo B · Decisiones (para responder "¿por qué…?")

| Tema | Decisión | Por qué |
|---|---|---|
| Stack (ADR-001) | TypeScript de punta a punta, Node 24 | Un solo contrato zod para HTTP, Kafka, SSE, móvil y LLM. Go o .NET duplicarían los contratos. Salida documentada si el gateway se limitara por CPU |
| Kafka | kafkajs, key = `vehicleId`, producer idempotente con `acks=-1` | Orden por vehículo. Salida a `@confluentinc/kafka-javascript`, con API compatible, porque kafkajs ya no se mantiene |
| Persistencia (ADR-002) | TimescaleDB + PostGIS | Medido: exclusión de chunks, 5x de compresión, aggregate 62x más rápido. Cassandra y Druid descartados |
| Migraciones (ADR-003) | Reversibles: par up/down obligatorio, checksum y prueba de ida y vuelta | No se edita una migración que ya está en `develop`. La `007` no existe y nunca se usará |
| Esquema (ADR-004) | Chunks de 1 día, compresión a los 7, **retención de 90 días** (Ley 1581) | El límite de antigüedad del gateway (7 días) coincide con la compresión, porque escribir en un chunk comprimido cuesta 11 veces más |
| Processor (ADR-005) | Offset confirmado después de persistir; **a la DLQ solo va lo que falla por su contenido** | Un fallo de infraestructura detiene la partición y reintenta, no vacía el backlog en la DLQ |
| Read model (ADR-006/007) | `seq` global; detención con la hora del fix GPS; zonas con `ST_Covers` | Orden correcto en el cliente y detención correcta aunque los puntos lleguen tarde |
| Sesión (ADR-008) | Cookie httpOnly firmada con HMAC, `SameSite=Lax`, CORS explícito | Sin tokens en la URL, ni en el SSE |
| SSE (ADR-009) | Un consumer group por réplica, snapshot primero en `REPEATABLE READ`, heartbeat y `retry` con jitter | Cada réplica recibe todos los eventos de sus tenants |
| AWS (ADR-010) | Diseño en Terraform, sin desplegar | Costo de unos US$700 al mes y decisiones de negocio pendientes |
| Agente (ADR-011) | Herramientas tipadas, tenant del servidor y breakers hacia fleet-api y hacia el modelo; 408/429 del proveedor abren el circuito | Sin text-to-SQL, y la saturación del proveedor se frena |
| Web (ADR-012) | Un `EventSource`, reconexión manual con jitter, `setData` limitado y la imagen `standalone` | Evita que todas las pestañas reconecten a la vez y protege el rendimiento del mapa |
| Catálogo (ADR-013) | Placa canónica única por tenant; listado de usuarios de solo lectura | `ABC-123` y `ABC123` son el mismo vehículo |
| Zonas (ADR-014) | Validación en cliente y PostGIS, nombre NFC y tope de 1000 por tenant con lock consultivo | Ni las altas simultáneas superan el tope |
| Móvil | Un solo dispositivo activo por vehículo; cola SQLite con tope de 50 000 puntos | Lo descartado se cuenta y se muestra |

---

## Anexo C · Bugs reales y sus correcciones

Todos ocurrieron en este proyecto.

| # | Qué pasó | Cómo se detectó | Corrección (y test) |
|---|---|---|---|
| 1 | El processor trataba cualquier error desconocido como permanente: al reiniciar la base, el backlog iba a la DLQ con los offsets confirmados | `/arch-review`, que **rechazó** el PR #5 | Falla en cerrado: solo los SQLSTATE de clase 22 y 23 son permanentes. El test reproduce el fallo con `REVOKE INSERT` |
| 2 | `commitOffsetsIfNecessary()` sin umbrales no confirmaba nada | `/arch-review` | Commit explícito por tramo, después de persistir |
| 3 | La prueba de ida y vuelta de migraciones no comparaba el esquema, y `CLAUDE.md` decía que sí | Revisión | Snapshot completo (relaciones, columnas, constraints, índices, vistas, funciones, Timescale) contra un baseline. Entrada 1 del log de auditoría |
| 4 | Tests de Kafka que pasaban con cualquier particionador | Revisión | Comparación contra los vectores murmur2 de Apache Kafka y contra un cliente que *sí* pide autocreación |
| 5 | Un test de sesión inactiva que aceptaba su propio timeout | Revisión | Exige el error `25P03` de Postgres |
| 6 | Lockfile roto por merges paralelos | CI | Se reconstruyó desde un commit sano |
| 7 | Una API key quedó en `.env.example` sin commitear | Revisión local antes del commit | Se quitó, y `git log --all -S` confirmó que no está en el historial |
| 8 | CI: el runner se quedaba sin disco | Logs de Redpanda en CI: "free space 4.97%" | El `ARG` del Dockerfile iba antes del `pnpm install` y repetía la instalación por imagen. Se movió después |
| 9 | CI: compose exigía `SESSION_SECRET` aun para levantar solo la infraestructura | CI | Variable efímera en el job |
| 10 | El modelo del agente no tenía breaker, hacía 6 reintentos y no tenía timeout | `/arch-review` | Breaker con un deadline dentro de la acción y un semáforo de cupos fuera, para que la cola no abra el circuito. E2e con un Anthropic falso |
| 11 | En opossum, un error filtrado cuenta como **éxito**: una pregunta cancelada cerraba el circuito en `halfOpen` | `/arch-review` | En `halfOpen`, una cancelación cuenta como fallo |
| 12 | El agente real respondía 503 a todo y el log solo decía "Error" | `/e2e-check` con el modelo real | Causa: un 400 por la clave sin workspace. Log seguro con código y tipo de error, y soporte de `ANTHROPIC_WORKSPACE_ID` |
| 13 | Web: la reconexión sin jitter hacía que todas las pestañas reconectaran a la vez | `/front-review` | Jitter completo desde el primer reintento |
| 14 | Web: con la cookie compartida, si en otra pestaña entraba otro tenant se mezclaban los datos | `/front-review` | Aviso entre pestañas y verificación de identidad en cada snapshot |
| 15 | E2e de aislamiento que pasaban sin probar nada: aserción negativa sin ancla | `/front-review` (dos veces) | Primero se espera un dato propio visible y después se afirma la ausencia del ajeno |
| 16 | Una respuesta tardía al guardar una zona podía quedar a la vista del siguiente usuario de la pestaña | `/front-review` (crítico) | El guardado se descarta de forma síncrona antes de limpiar la sesión. E2e de cambio de sesión en la misma pestaña |
| 17 | `ABC-123` y `ABC123` eran placas distintas, y un alias con NUL daba 500 | `/arch-review` | Placa canónica y un patrón que rechaza caracteres de control e invisibles |
| 18 | El rate limit no contaba las peticiones sin sesión, por el orden de los hooks de Fastify | `/arch-review`, leyendo el código de la librería | La sesión pasa a `preParsing` y la clave es `user:` o `ip:` |
| 19 | E2e del breaker en la web que nunca abría: ventana de 10 s y preguntas cada 6 s | CI (Playwright) | Ventana de 60 s en el entorno de e2e |
| 20 | Los e2e no eran repetibles: contaban el historial y dejaban datos | `/e2e-check` local | Solo se cuenta lo activo, y cada test limpia lo que crea |
| 21 | Proceso: 4 PR se mergearon antes de entrar las correcciones de su revisión | Verificación de `develop` | PR de seguimiento, y ahora borrador hasta cerrar la ronda |
| 22 | La compilación nativa en Windows fallaba por rutas largas | Al compilar | Copia de trabajo en una ruta corta (`C:\ft`): con pnpm, `subst` no basta |

---

## Anexo D · Números clave

- **`/e2e-check` final:** LISTO, 11 de 11, sobre `develop` `02359fc`, con el modelo real.
- **Tests:**
  - unos 2700 unitarios;
  - integración: platform 154, fleet-api 85, processor 61;
  - e2e del backend: 74 tests en 12 archivos;
  - Playwright: 21.
- **k6 (humo de 30 s):**
  - 11 519 de 11 519 persistidos sin caos;
  - con SIGKILL a mitad de lote, 11 702 de 11 702, sin duplicados;
  - latencia p95 de 23 ms y p99 de 32 ms.
- **Persistencia (12 M filas):**
  - se escanea 1 de 15 chunks;
  - compresión de 5x;
  - aggregate 62x más rápido;
  - unas 40 000 filas/s por conexión;
  - idempotencia sobre un chunk comprimido 11 veces más lenta.
- **AWS dev:** unos US$700 al mes, el 80% por MSK Serverless.
- **Reglas:** 17 en `CLAUDE.md`, 7 subagentes, 8 skills, 14 ADRs.

---

## Anexo E · Preguntas probables

- **¿Qué pasa si se cae la base?** El processor no confirma el offset y reintenta; la partición se detiene, pero no pierde ni duplica nada. A la DLQ solo va lo que falla por su contenido.
- **¿Y si un teléfono manda el mismo lote dos veces?** El `eventId` lo genera el dispositivo, así que `ON CONFLICT DO NOTHING` deja una sola fila y el ACK devuelve los puntos en `accepted`.
- **¿Cómo escalaría?**
  - Gateway y fleet-api escalan horizontalmente.
  - El processor escala por particiones.
  - TimescaleDB escala de forma vertical, con réplicas de lectura y, si hiciera falta, partición por tenant. Timescale Cloud tiene tiered storage.
- **¿El LLM puede ver datos de otro tenant?** No. El tenant lo pone el servidor desde la sesión, y `fleet-api` filtra. Lo probamos con una instrucción inyectada.
- **¿Por qué no se desplegó?** Por costo y porque faltan decisiones de negocio. El diseño está validado en CI.
- **¿Qué deuda queda?**
  - Editar y borrar zonas, que están referenciadas por las alertas.
  - Roles de usuario.
  - El heartbeat del SSE como evento con nombre.
  - Que el logout cierre los streams de otras pestañas.
  - Más detalle en los ADR, sección "Pendiente".
