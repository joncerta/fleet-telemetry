# apps/mobile — App del conductor (Expo) 
Estas reglas complementan el `CLAUDE.md` de la raíz. El agente que trabaja aquí es `mobile-engineer`; revisa `/front-review`.
 
## Stack decidido
- Expo (SDK actual) + TypeScript estricto, **development build** (Expo Go no sirve para ubicación en segundo plano). Plataforma de demo: Android.
- `expo-location` (primer y segundo plano), `expo-task-manager`, `expo-sqlite`, `@react-native-community/netinfo`, `expo-secure-store`, `expo-crypto` (UUID v4).
- Dependencias nativas o de Expo siempre con `pnpm expo install`, desde `apps/mobile` (`npx` está denegado en `settings.json`); un cambio nativo o de config plugin exige un development build nuevo.
- Tipos y validación solo desde `@fleet/contracts`.
## Parámetros (no inventar otros)
| Parámetro | Valor |
|---|---|
| Captura | cada 5 s o 10 m, lo que ocurra primero, solo con turno activo |
| Precisión mínima | 50 m; los puntos peores se guardan marcados como `lowAccuracy`, no se descartan |
| Lote | hasta 200 puntos o el máximo que defina el contrato, lo que sea menor |
| Backoff | exponencial con jitter completo, de 1 s a 60 s; se reinicia tras un envío exitoso |
| Lease de `in_flight` | 60 s |
| Tope de la cola | 50 000 puntos; al llegar, se descartan los más viejos y se cuentan |
 
## Identidad del dispositivo
- El dispositivo se **vincula** una vez con un código de vinculación de los datos sembrados; recibe un token ligado a un vehículo y a su tenant.
- El token vive en `expo-secure-store`, nunca en SQLite, AsyncStorage ni variables `EXPO_PUBLIC_*`.
- El vehículo sale del token: no hay un campo editable de ID de vehículo. El gateway toma el tenant del token, nunca del payload.
## Captura (expo-location)
- `TaskManager.defineTask` **a nivel de módulo**, en un archivo importado al arranque. Dentro de un componente no existe cuando Android despierta la app.
- La tarea en segundo plano no usa React, hooks ni el store: llama al módulo de la cola, que escribe en SQLite.
- Permisos en orden: primer plano y luego segundo plano, con una explicación previa visible (Google Play la exige). Si el conductor los rechaza, una pantalla explica cómo activarlos.
- Foreground service con notificación visible mientras dura el turno. En Android 14+, el manifest generado debe declarar el tipo de foreground service de ubicación.
- Ahorro de batería de fabricantes (Xiaomi, Samsung, Huawei): detectar si la app está optimizada y guiar al conductor para excluirla.
- Cada punto lleva:
  - `eventId` UUID v4 generado al capturar (clave de idempotencia del back);
  - timestamp de `location.timestamp` (hora del fix GPS), no `Date.now()`;
  - `mocked: true` si Android reporta ubicación simulada (se envía marcado, nunca se descarta).
## Modelo offline-first (NO negociable)
1. Captura → **INSERT en SQLite primero**, siempre, haya red o no. Nunca se envía directo desde memoria.
2. Tablas:
   - `outbox(event_id PK, payload, created_at, status, claimed_at, attempts)` con `status` en `pending` o `in_flight`;
   - `rejected(event_id PK, payload, reason, rejected_at)`;
   - `dead(batch_id PK, payload, reason, failed_at)`.
3. WAL activado, escrituras en transacción, índice por `(status, created_at)`, esquema versionado con migraciones (`PRAGMA user_version`).
4. **Un solo envío a la vez, reclamado en la base**: pasar puntos de `pending` a `in_flight` se hace en una transacción. Un `in_flight` con `claimed_at` más viejo que el lease vuelve a `pending`. Un mutex en memoria no basta: la tarea en segundo plano puede correr sin la UI.
5. El `SyncEngine` drena en lotes, en orden de `created_at`.
6. Respuesta del servidor:
| Respuesta | Qué hacer |
|---|---|
| `202` con ACK válido | borrar los `eventId` de `accepted`; mover los de `rejected` a la tabla `rejected` con su motivo; lo que no venga en ninguna lista vuelve a `pending` |
| `202` cuyo cuerpo no pasa el schema del ACK | no borrar nada; vuelve a `pending` y se registra el error |
| `400` (envelope roto: bug del cliente) | mover el lote a `dead` con el motivo, no reintentar en bucle, mostrarlo en diagnóstico |
| `401` / `403` | no borrar nada; pausar el sync y mostrar "dispositivo no vinculado" |
| `413` | partir el lote a la mitad y reintentar |
| `429` | no borrar nada; esperar `Retry-After` |
| `5xx`, timeout o sin red | no borrar nada; backoff con jitter |
 
   Un reenvío es seguro: el `eventId` hace idempotente al back, y los puntos ya persistidos vuelven en `accepted`.
7. Disparadores del sync: recuperación de red, cada 15 s mientras haya pendientes y red, al volver a primer plano y desde la tarea en segundo plano. Nunca un loop apretado.
8. **netinfo**: `isConnected` no significa internet. Usar `isInternetReachable` (puede venir `null` al inicio). El resultado real del request manda; netinfo solo decide cuándo intentar.
9. Tope: al superar el tope de la cola se descartan los más viejos, se cuentan y se muestran en diagnóstico. Nada desaparece sin rastro.
10. Payloads guardados antes de actualizar la app deben seguir siendo enviables. Si un cambio de contrato lo impide, hace falta una migración de la cola (ver `/add-contract`).
11. La cola y el `SyncEngine` son TypeScript puro detrás de una interfaz de almacenamiento, sin React ni expo-sqlite. El adaptador de expo-sqlite implementa esa interfaz. La UI solo observa.
 
## Red en desarrollo
- `EXPO_PUBLIC_INGEST_URL` define el gateway.
  - Emulador Android: `http://10.0.2.2:4001` (`localhost` dentro del emulador es el propio emulador).
  - Teléfono físico: la IP de tu máquina en la red local.
- Android bloquea HTTP en claro por defecto. Habilitarlo **solo en el perfil de desarrollo** (`expo-build-properties`), nunca en `preview` ni `production`.
## UI
- Pantallas: vinculación, turno (iniciar/detener) y diagnóstico.
- Siempre visible: estado de conexión, estado del tracking (activo, pausado, sin permiso, sin señal) y puntos pendientes.
- Diagnóstico:
  - conteos de `pending`, `in_flight`, `rejected`, `dead` y descartados por tope;
  - último sync exitoso y último error;
  - permisos y optimización de batería.
- Estilos con los mismos tokens del diseño de la web (`apps/web/design/`). Áreas táctiles grandes, safe areas, soporte de fuente aumentada. Textos en español.
## Tests
- **Núcleo puro (Vitest)**:
  - el punto se escribe antes de enviar;
  - ACK parcial;
  - 5xx, timeout y sin red no borran nada;
  - respuesta perdida reenvía los mismos `eventId`;
  - lease vencido vuelve a `pending`;
  - dos envíos concurrentes no toman los mismos puntos;
  - `400` va a `dead`, `401` pausa, `413` parte el lote, `429` respeta `Retry-After`;
  - tope y purga cuentan;
  - backoff con jitter (fake timers).
- **E2E con Maestro**: flujos YAML en `apps/mobile/.maestro/`, contra el development build en emulador Android:
  - vincular dispositivo;
  - iniciar turno;
  - ver crecer pendientes sin red;
  - recuperar red y ver pendientes en cero.
- **Lo que no se automatiza** (segundo plano real, modo reposo) va en la demostración manual.
## Demostración para el video
Tiene que verificarse con números, no solo verse:
1. Turno activo; el diagnóstico muestra envíos exitosos.
2. Modo avión (o `adb shell svc wifi disable` y `adb shell svc data disable`); en el emulador, mover con `adb emu geo fix <lon> <lat>` (longitud primero). El contador de pendientes sube.
3. Con la pantalla apagada, `adb shell dumpsys deviceidle force-idle`: la captura sigue.
4. Cerrar la app con pendientes y reabrirla: los pendientes se conservan.
5. Quitar el modo avión: el contador baja a 0 por lotes.
6. **Criterio de éxito**: puntos capturados en el dispositivo = puntos recibidos por el servidor para ese vehículo y rango de tiempo, sin faltantes ni duplicados.
## CI/CD (sin publicar)
- `eas.json` con perfiles `development` (dev client y HTTP en claro para local), `preview` (APK interno) y `production` (AAB). `versionCode` con autoincremento. `runtimeVersion` coherente si se usan updates OTA.
- `fastlane/Fastfile` con lane `android internal`, que sube solo al track interno. La promoción a producción es manual.
- Workflow de GitHub Actions para la app: typecheck y tests en cada PR que toque `apps/mobile/**` o `packages/contracts/**`. El build de EAS y la lane de Fastlane solo se disparan manualmente (`workflow_dispatch`).
- Secretos (`EXPO_TOKEN`, la cuenta de servicio de Google Play) solo en GitHub Secrets o EAS. Claude y los agentes nunca ejecutan `eas submit`, `eas update` ni lanes de Fastlane.
