# ADR-013 — Catálogo de vehículos (alta) y listado de usuarios en fleet-api

- **Estado:** aceptado
- **Fecha:** 2026-10-06
- **Alcance:** `packages/contracts` (esquemas nuevos, aditivos) y `services/fleet-api`. Sin migración: `vehicles` ya tiene `plate` (única por tenant, `vehicles_tenant_plate_key`, 1-32 caracteres) y `label` (nullable); `users` ya tiene `user_id, tenant_id, email, name, created_at`.

## Contexto

El panel "Vincular dispositivo" de la web solo listaba vehículos con estado (que ya enviaron datos), así que un vehículo nuevo no se podía vincular nunca. Hace falta un catálogo del tenant con alta, y un listado de usuarios.

## Decisiones

1. **Contratos aditivos, v1, con fixtures.** `vehicleCatalogItemSchema`, `vehicleListQuerySchema`, `vehicleListResponseSchema`, `vehicleCreateRequestSchema`, `userListItemSchema`, `userListQuerySchema`, `userListResponseSchema`, y la constante `PLATE_TAKEN_ERROR_CODE` (`plate_taken`). Sin enums, así que sin variantes tolerantes. Registrados en el arnés de compatibilidad. Placa, alias, nombre y correo llevan "DATO PERSONAL".
2. **Placa normalizada en el borde (el contrato).** `trim`, mayúsculas, 1-32 caracteres y `^[A-Z0-9]+(?:-[A-Z0-9]+)?$` (letras y dígitos, un guion opcional entre dos grupos: `ABC123`, `ABC-123`, `ABC12D`). Se normaliza una sola vez, en el esquema; el caso de uso recibe la placa ya normalizada. `ABC-123` y `ABC123` son placas distintas (no se unifican; riesgo anotado). `label`: `trim`, hasta 64, vacío/ausente/null = null.
3. **Alta con `INSERT ... ON CONFLICT ON CONSTRAINT vehicles_tenant_plate_key DO NOTHING RETURNING`.** Sin fila devuelta = `plate_taken` (409). Equivale a mapear el SQLSTATE 23505, pero sin capturar errores de `pg` (que no deben llegar al cliente) y sin transacción abortada; también serializa altas simultáneas de la misma placa. Descartado: capturar 23505 y comprobar `constraint`. Un fallo distinto de la base sube como 500.
4. **El id lo genera el servidor** (`randomUUID` inyectado en `main.ts`); el cliente no puede fijarlo. El `tenantId` sale siempre de la sesión: el esquema de la ruta descarta un `tenantId` del cuerpo o de la query.
5. **Listado sin cursor.** `GET /v1/vehicles` (por defecto 200, máximo 500, orden por placa e id) y `GET /v1/users` (por defecto 100, máximo 500, orden por nombre y id) solo aceptan `limit`, como se pidió. La respuesta de vehículos devuelve el `limit` aplicado: si `items.length === limit` puede haber más. Si un tenant supera 500 vehículos hará falta keyset (cambio aditivo: `cursor` opcional).
6. **`hasActiveDevice` con `EXISTS`** sobre `devices` (`revoked_at IS NULL`, mismo tenant), sin `LEFT JOIN`, para no multiplicar filas.
7. **Protección de `POST /v1/vehicles`** igual que las otras escrituras con cookie (p. ej. `pairing-codes`): sesión `SameSite=Lax`, CORS con lista explícita de orígenes y solo `application/json` (415 para otro tipo). No hay un chequeo de `Origin` adicional en ninguna ruta POST; no se introdujo uno aquí para no divergir. Más un límite propio por usuario (`FLEET_API_VEHICLE_CREATE_RATE_LIMIT_MAX` / `_WINDOW_MS`, por defecto 30 por minuto), con `onRequest` de sesión antes del límite (una petición sin sesión es 401 y la cubre el límite global por IP).
8. **Usuarios: solo lectura y sin hash.** La consulta no selecciona `password_hash`; la respuesta se serializa con el esquema. Sin roles (la tabla no los tiene): cualquier usuario autenticado del tenant ve la lista. Si se introducen roles, este endpoint debe restringirse.
9. **Pairing sin cambios.** `POST /v1/devices/pairing-codes` y el canje ya solo exigen que el vehículo sea del tenant (`vehicles`), no `vehicle_state`; un test de integración y el e2e lo fijan.
10. **Privacidad.** Placa, alias, nombre y correo nunca van a logs ni a mensajes de error (el 409 no repite la placa). Las líneas de log llevan `tenantId`, `userId`, `vehicleId` y `correlationId`.

## Consecuencias

- La web puede dar de alta un vehículo y vincularlo sin que haya enviado datos.
- Dos rutas nuevas en el mismo prefijo que `/v1/vehicles/stopped`; la ruta estática sigue resolviéndose aparte (con test).
- Variables nuevas: `FLEET_API_VEHICLE_CREATE_RATE_LIMIT_MAX`, `FLEET_API_VEHICLE_CREATE_RATE_LIMIT_WINDOW_MS` (validadas con zod, en `.env.example`).
