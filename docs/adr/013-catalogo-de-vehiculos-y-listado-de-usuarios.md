# ADR-013 — Catálogo de vehículos (alta) y listado de usuarios en fleet-api

- **Estado:** aceptado
- **Fecha:** 2026-10-06
- **Alcance:** `packages/contracts` (esquemas nuevos, aditivos) y `services/fleet-api`. Sin migración: `vehicles` ya tiene `plate` (única por tenant, `vehicles_tenant_plate_key`, 1-32 caracteres) y `label` (nullable); `users` ya tiene `user_id, tenant_id, email, name, created_at`.

## Contexto

El panel "Vincular dispositivo" de la web solo listaba vehículos con estado (que ya enviaron datos), así que un vehículo nuevo no se podía vincular nunca. Hace falta un catálogo del tenant con alta, y un listado de usuarios.

## Decisiones

1. **Contratos aditivos, v1, con fixtures.** `vehicleCatalogItemSchema`, `vehicleListQuerySchema`, `vehicleListResponseSchema`, `vehicleCreateRequestSchema`, `userListItemSchema`, `userListQuerySchema`, `userListResponseSchema`, y la constante `PLATE_TAKEN_ERROR_CODE` (`plate_taken`). Sin enums, así que sin variantes tolerantes. Registrados en el arnés de compatibilidad. Placa, alias, nombre y correo llevan "DATO PERSONAL".
2. **Placa canónica, normalizada en el borde (el contrato).** `trim`, mayúsculas y se quitan los espacios y los guiones; el resultado debe ser `^[A-Z0-9]+$` de 1 a 32 caracteres. `ABC-123`, `ABC 123` y `abc123` son LA MISMA placa y se guardan como `ABC123` (decisión del humano: evita duplicados que solo difieren en el formato). Se normaliza una sola vez, en el esquema; el caso de uso recibe la placa ya canónica. Las placas ya existentes en la base no se reescriben: una anterior con guion (p. ej. sembrada) no chocará con su forma canónica. `label`: `trim`, hasta 64, vacío/ausente/null = null, y sin caracteres de control (Cc) ni de dirección bidi (U+202A-202E, U+2066-2069): un NUL hacía fallar el INSERT (SQLSTATE 22021, 500) y los bidi falsean lo que se muestra; ahora es 400.
3. **Alta con `INSERT ... ON CONFLICT ON CONSTRAINT vehicles_tenant_plate_key DO NOTHING RETURNING`.** Sin fila devuelta = `plate_taken` (409). Equivale a mapear el SQLSTATE 23505, pero sin capturar errores de `pg` (que no deben llegar al cliente) y sin transacción abortada; también serializa altas simultáneas de la misma placa. Descartado: capturar 23505 y comprobar `constraint`. Un fallo distinto de la base sube como 500.
4. **El id lo genera el servidor** (`randomUUID` inyectado en `main.ts`); el cliente no puede fijarlo. El `tenantId` sale siempre de la sesión: el esquema de la ruta descarta un `tenantId` del cuerpo o de la query.
5. **Listado sin cursor.** `GET /v1/vehicles` (por defecto 200, máximo 500, orden por placa e id) y `GET /v1/users` (por defecto 100, máximo 500, orden por nombre y id) solo aceptan `limit`, como se pidió. La respuesta de vehículos devuelve el `limit` aplicado: si `items.length === limit` puede haber más. Si un tenant supera 500 vehículos hará falta keyset (cambio aditivo: `cursor` opcional).
6. **`hasActiveDevice` con `EXISTS`** sobre `devices` (`revoked_at IS NULL`, mismo tenant), sin `LEFT JOIN`, para no multiplicar filas.
7. **Protección de `POST /v1/vehicles`** igual que las otras escrituras con cookie (p. ej. `pairing-codes`): sesión `SameSite=Lax`, CORS con lista explícita de orígenes y solo `application/json` (415 para otro tipo). No hay un chequeo de `Origin` adicional en ninguna ruta POST; no se introdujo uno aquí para no divergir. Más un límite propio (`FLEET_API_VEHICLE_CREATE_RATE_LIMIT_MAX` / `_WINDOW_MS`, por defecto 30 por minuto): por usuario con sesión y por IP sin ella. La ruta trae su propio `config.rateLimit`, por lo que el límite global no se le agrega, y el hook del límite es un `onRequest` que el plugin añade DESPUÉS de los `onRequest` de la ruta. Por eso la sesión va en `preParsing` (corre después del límite y antes de leer el cuerpo), como `stream-route.ts` con `preValidation`: así también se cuenta a quien no tiene cookie. Los tests fijan el 415 de `application/x-www-form-urlencoded`, `multipart/form-data` y sin content-type con cookie puesta (anti-CSRF), y el 429 del tercer POST sin cookie desde la misma IP.
8. **Usuarios: solo lectura y sin hash.** La consulta no selecciona `password_hash`; la respuesta se serializa con el esquema. **Finalidad:** que el operador vea quién tiene acceso a su flota (nombre y correo). Se mantiene con esos campos porque el humano lo pidió explícitamente; bajo la Ley 1581 el criterio es la necesidad de esa finalidad. Sin roles (la tabla no los tiene), cualquier usuario autenticado del tenant ve la lista: **cuando existan roles, este endpoint debe restringirse** (p. ej. solo administradores) o reducirse a lo mínimo. Como red de seguridad, `label`, `name` y `email` se agregaron a `REDACTED_KEYS` del logger de `@fleet/platform` (nunca se registran a propósito).
9. **Pairing sin cambios.** `POST /v1/devices/pairing-codes` y el canje ya solo exigen que el vehículo sea del tenant (`vehicles`), no `vehicle_state`; un test de integración y el e2e lo fijan.
10. **Privacidad.** Placa, alias, nombre y correo nunca van a logs ni a mensajes de error (el 409 no repite la placa). Las líneas de log llevan `tenantId`, `userId`, `vehicleId` y `correlationId`.

## Deuda anotada

- **Las demás rutas con `onRequest: requireSession` no cuentan en ningún límite a quien no tiene sesión.** El plugin de rate limit (global o propio de la ruta) añade su hook `onRequest` DESPUÉS de los `onRequest` de la ruta, así que una petición sin cookie recibe el 401 de `requireSession` antes de que el limitador la cuente. Aplica a resumen, detenidos, alertas, zonas, `GET /v1/vehicles`, `GET /v1/users` y `POST /v1/devices/pairing-codes`: el 401 es barato (verifica una firma HMAC, sin base de datos), pero el flood sin sesión no tiene tope por IP. Arreglo: mover `requireSession` a `preValidation` (rutas sin cuerpo) o `preParsing` (con cuerpo), como se hizo en `POST /v1/vehicles` y en el stream, y cubrirlo con un test por ruta. No se tocó aquí.

## Consecuencias

- La web puede dar de alta un vehículo y vincularlo sin que haya enviado datos.
- Dos rutas nuevas en el mismo prefijo que `/v1/vehicles/stopped`; la ruta estática sigue resolviéndose aparte (con test).
- Variables nuevas: `FLEET_API_VEHICLE_CREATE_RATE_LIMIT_MAX`, `FLEET_API_VEHICLE_CREATE_RATE_LIMIT_WINDOW_MS` (validadas con zod, en `.env.example`).
