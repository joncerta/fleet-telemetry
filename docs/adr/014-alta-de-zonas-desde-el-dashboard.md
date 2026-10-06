# ADR-014 — Alta de zonas (polígonos) desde el dashboard

- **Estado:** aceptado
- **Fecha:** 2026-10-06
- **Alcance:** `packages/contracts` (esquemas y constantes nuevos, aditivos) y `services/fleet-api` (`POST /v1/zones`). Sin migración: `zones` (migración 005) ya tiene `zone_id` (PK), `tenant_id`, `name`, `kind` (CHECK), `geom geometry(Polygon, 4326)` con `zones_geom_valid_check` (`ST_IsValid`), `zones_tenant_name_key UNIQUE (tenant_id, name)` y el índice GiST. El processor ya consulta las zonas por lote, sin caché: una zona nueva aplica a los puntos del siguiente lote.

## Contexto

Las zonas solo se sembraban por SQL; el operador no podía crear una zona crítica, un depósito o un cliente desde el dashboard. La lectura (`GET /v1/zones/geojson`) ya existe.

## Decisiones

1. **Contratos aditivos, v1, con fixtures.** Nuevos: `zoneFeatureSchema` y `zoneFeatureTolerantSchema` (el `Feature` que estaba inline en la colección; la forma no cambia y `zoneFeatureCollection*` sigue aceptando lo mismo, con sus fixtures), `zoneCreateRequestSchema`, y las constantes `ZONE_NAME_MAX_LENGTH = 80`, `ZONE_MAX_VERTICES = 200`, `ZONE_NAME_TAKEN_ERROR_CODE = "zone_name_taken"`, `INVALID_GEOMETRY_ERROR_CODE = "invalid_geometry"` y `COLOMBIA_BBOX` (con el tipo `BoundingBox`). La petición solo tiene variante estricta (la consume el servidor).
2. **La geometría que llega se valida en el contrato; la topología, en PostGIS.** El esquema exige un `Polygon` con UN anillo (sin huecos), cerrado, de 4 a 201 posiciones `[lng, lat]` con al menos 3 vértices distintos y todas dentro del bbox de Colombia. Un `[lat, lng]` invertido cae fuera del bbox (la latitud de Colombia no cabe en el rango de longitud) y se rechaza con un mensaje que lo sugiere. La auto-intersección no se calcula en TypeScript: la decide `ST_IsValid` al guardar. Descartado: reimplementar la validez de polígonos en el contrato (duplica PostGIS y se desalinea).
3. **`COLOMBIA_BBOX` vive ahora en contracts, y el processor conserva su copia.** El bbox ya existía en `services/processor/src/domain/operating-area.ts` (con la documentación de su origen). El contrato lo necesita para validar el borde HTTP y contracts no puede importar de un servicio, así que se creó ahí con los mismos valores y un comentario que lo enlaza. **Deuda:** dos copias; migrar el processor a importar la de contracts (con sus tests de operating-area) se hace en un cambio aparte, para no tocar el processor aquí. Sigue siendo un rectángulo, no un polígono (ver el comentario del processor).
4. **Alta con `INSERT ... ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326) ... ON CONFLICT ON CONSTRAINT zones_tenant_name_key DO NOTHING RETURNING`.** El GeoJSON viaja como UN parámetro de texto (`::text` evita la ambigüedad de sobrecargas de PostGIS); nada se concatena. Sin fila = `name_taken` (409), igual que el alta de vehículos (ADR-013): sin capturar errores de `pg` y serializando altas simultáneas del mismo nombre. Se devuelve la geometría con `ST_AsGeoJSON(ST_ForcePolygonCCW(geom), 6)`, el mismo formato que `findZones`.
5. **Polígono inválido: se mapea la violación del CHECK, no se pre-valida.** El adaptador captura SOLO el SQLSTATE `23514` con `constraint = zones_geom_valid_check` y devuelve `invalid_geometry` (`400 invalid_geometry`); cualquier otro error de la base se propaga como 500 sin detalle. Es la única captura de un error de `pg`, y el cliente nunca ve su mensaje. Descartado: `WHERE ST_IsValid(...)` dentro del INSERT, porque "sin fila" sería ambiguo con el conflicto de nombre y exigiría una consulta más compleja. El CHECK se evalúa antes del arbitraje del conflicto: un polígono inválido nunca consume el nombre.
6. **El `tenantId` sale de la sesión; el `zoneId`, del servidor** (`randomUUID` inyectado en `main.ts`). El esquema descarta un `tenantId` o un `zoneId` del cuerpo (test unitario y e2e).
7. **Protección de `POST /v1/zones`** como `POST /v1/vehicles` (ADR-013 §7): sesión en `preParsing` y `keyGenerator` `user:`/`ip:` (cuenta también a quien no tiene cookie), solo `application/json` (415) y límite propio `FLEET_API_ZONE_CREATE_RATE_LIMIT_MAX` / `_WINDOW_MS` (por defecto 20 por minuto), validadas con zod y en `.env.example`. El límite de 16 KiB del cuerpo cubre de sobra 201 posiciones.
8. **Privacidad.** El nombre de una zona no es dato personal, pero no se registra: la línea de log (`Zona creada`) lleva `tenantId`, `userId` y `zoneId`. El polígono tampoco se registra. El 409 no repite el nombre.

## Deuda anotada

- **Sin edición ni borrado de zonas.** Las alertas (`alerts`) referencian la zona con una FK compuesta `(zone_id, tenant_id)`: borrar una zona con alertas falla, y editar su geometría reescribe el pasado de las alertas ya levantadas. Cuando se necesiten, habrá que decidir entre archivar (columna `archived_at`, el processor deja de usarla) o borrar en cascada, con migración. No se resuelve aquí.
- **Zonas superpuestas.** Se permiten (el read model elige una cuando un vehículo está en varias: `pickDisplayZone`). No hay validación de solapamiento.
- **Dos copias del bbox de Colombia** (decisión 3).
- **Sin tope de zonas por tenant en el alta.** La lectura se acota en `MAX_ZONES` (1000) y el alta tiene límite por usuario y ventana; un tenant podría crear más de 1000 y las últimas no se verían en `GET /v1/zones/geojson` (orden por nombre). Un tope en el alta es un cambio aditivo (`409`/`422` al superarlo) a decidir con el humano.

## Consecuencias

- La web puede crear zonas y verlas en el mapa; los siguientes lotes del processor ya las evalúan (alertas `critical_zone_stop` y filtro `zoneKind` de vehículos detenidos), sin reiniciar nada.
- Los puntos que ya se procesaron NO se reevalúan contra una zona nueva (el `zone_ids` de `vehicle_state` se recalcula con el siguiente punto del vehículo).
- Variables nuevas: `FLEET_API_ZONE_CREATE_RATE_LIMIT_MAX`, `FLEET_API_ZONE_CREATE_RATE_LIMIT_WINDOW_MS`.
