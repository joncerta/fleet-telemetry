# apps/web — Dashboard (Next.js)
 
Estas reglas complementan el `CLAUDE.md` de la raíz. El agente que trabaja aquí es `web-engineer`; revisa `/front-review`. Fuera de alcance: cambios en `services/*` (se proponen y esperan aprobación).
 
## Stack decidido
- Next.js (App Router) + TypeScript estricto. Paquete `@fleet/web`.
- Estilos: Tailwind, sin librerías de componentes pesadas.
- Mapa: **MapLibre GL**. Estilo por `NEXT_PUBLIC_MAP_STYLE_URL` (por defecto un estilo gratuito sin token, como OpenFreeMap), con la atribución visible. Nunca los tiles públicos de OpenStreetMap.
- Centro inicial: Bogotá `[-74.10, 4.65]` (orden `[lng, lat]`), zoom 11.
- Estado en vivo: Zustand.
- Tests: Vitest (lógica pura y hooks) y Playwright (e2e).
- URLs: `NEXT_PUBLIC_FLEET_API_URL` (`http://localhost:4002`) y `NEXT_PUBLIC_AGENT_URL` (`http://localhost:4003`). Nada sensible en `NEXT_PUBLIC_*`.
- Idioma de la UI: español. Fechas y números con locale `es-CO`, en la zona horaria del navegador.
## Diseño (fuente de verdad visual)
- El diseño viene de Claude Design: pantallas exportadas y tokens en `apps/web/design/`.
- Los tokens van a **un solo módulo** (`src/design/tokens.ts`) que alimenta el tema de Tailwind **y** los colores de las capas de MapLibre. El mapa no entiende clases de Tailwind: nunca hardcodees un color en una capa.
- Solo tokens del tema: nada de valores arbitrarios (`w-[13px]`) ni clases construidas con template strings.
- Si un componente o estado no está en el diseño, no se improvisa: se pregunta.
## Autenticación
- Login con los usuarios sembrados. La sesión es una cookie httpOnly que pone `fleet-api`; la web nunca ve ni guarda tokens.
- La web (`:3000`) y las APIs (`:4002`, `:4003`) están en orígenes distintos: `fetch` con `credentials: 'include'` y `new EventSource(url, { withCredentials: true })`.
- Un `401` en cualquier llamada o en el stream lleva al login. El cliente nunca envía `tenantId`.
## Datos en vivo
1. **Una sola conexión `EventSource`** para toda la app (provider o módulo), no una por componente. Se cierra en el cleanup; con StrictMode en desarrollo, verifica que no queden conexiones duplicadas.
2. **Un solo store de flota**, con los vehículos indexados por `vehicleId` (`Map` u objeto, nunca un array que se copia en cada evento).
3. Cada evento se valida con `StreamEvent` de `@fleet/contracts`. Si no valida, se descarta y se registra, sin romper la UI.
4. **Snapshot**: llega como primer evento del propio stream, así que el orden está garantizado. **Reemplaza** el estado de vehículos; no se mezcla con el anterior.
5. **`vehicle.state`**: se aplica solo si es más nuevo que el estado actual de ese vehículo (por `id` o timestamp del evento). Los duplicados y los eventos viejos se ignoran.
6. **`alert`**: deduplicada por id de alerta.
7. **Reconexión**:
   - Ante un corte de red, `EventSource` reintenta solo; el nuevo snapshot reemplaza el estado.
   - Si queda en `CLOSED` (respuesta distinta de 200), **reconexión manual** con backoff exponencial y jitter (1 s a 30 s), salvo `401`, que lleva al login.
   - Tras reconectar, se vuelve a pedir `/v1/alerts`: las alertas ocurridas durante la desconexión no vienen en el snapshot.
   - Indicador visible: en vivo, reconectando, desconectado.
8. **Rendimiento**: los vehículos son **una** fuente GeoJSON del mapa, actualizada con `setData` a lo sumo cada ~500 ms, con los eventos acumulados entre actualizaciones. Prohibido un `<Marker>` o componente React por vehículo. Los componentes se suscriben al store con selectores finos (`useShallow` para objetos o arrays).
9. **Minutos detenido**: se calculan en el cliente desde `stoppedSince` con un tick de 30 s, usando la **hora del servidor** (desfase estimado a partir de la hora que trae el snapshot o la respuesta de `/v1/summary`), no el reloj del navegador.
10. **Sin señal**: un vehículo sin eventos por más de **5 min** (contra la hora del servidor) se marca como "sin datos desde hace X min".
## Estructura
- `src/features/<feature>/` (`fleet`, `alerts`, `summary`, `chat`, `auth`): hooks, store y funciones puras de cada feature.
- Componentes de presentación sin fetch ni acceso al store global; reciben datos por props o selectores.
- La lógica de aplicar eventos (reemplazo por snapshot, descarte de viejos, deduplicación, lote) son funciones puras, fuera de los componentes.
- Server Components por defecto; `'use client'` lo más abajo posible. El mapa se carga solo en el cliente (import dinámico sin SSR).
- Fechas formateadas en el cliente o con zona explícita, para evitar errores de hidratación.
## Pantallas y layout
- **Login.**
- **Dashboard**: mapa a pantalla completa · panel lateral con KPIs (`/v1/summary`) y alertas en vivo · chat plegable.
- Lista de vehículos sincronizada con el mapa (seleccionar en una resalta en el otro): el canvas del mapa no es accesible.
- Estados obligatorios: cargando, error, vacío, reconectando y sin datos.
## Semántica visual
Los colores exactos salen de los tokens del diseño; esta es la semántica que deben cubrir:
- **Zonas**: críticas en rojo translúcido, depósitos en azul, clientes en gris.
- **Vehículos**: en movimiento (verde), detenido (ámbar), detenido en zona crítica (rojo), sin señal (gris). Cada estado se distingue también por forma o ícono, no solo por color.
## Alertas
- Orden por severidad y hora. Ráfagas del mismo vehículo agrupadas.
- Región `aria-live="polite"`; `assertive` solo para las críticas.
## Chat con el agente
- `POST NEXT_PUBLIC_AGENT_URL/v1/agent/chat` con `credentials: 'include'`, cancelable con `AbortController` (al enviar otra pregunta, cerrar el chat o desmontar).
- Muestra las `toolCalls` de cada respuesta y el estado del breaker (de `:4003/health`), por transparencia.
- La respuesta es **no confiable**: se muestra como texto o con un renderizador de markdown que escape HTML. Nunca `dangerouslySetInnerHTML`.
- Estados: escribiendo, error con reintento, breaker abierto ("datos no disponibles", nunca datos inventados).
## Tests
- **Vitest**:
  - reemplazo por snapshot, descarte de eventos viejos y duplicados, aplicación por lote;
  - reconexión manual y redirección por `401`;
  - minutos detenido con desfase de reloj;
  - deduplicación y agrupación de alertas;
  - chat: HTML escapado y cancelación.
- **Playwright**, contra el stack real con `pnpm simulate`, con selectores por rol o texto accesible, nunca por clases de Tailwind:
  - login y aislamiento por tenant;
  - ver los vehículos moviéndose en el mapa;
  - alerta nueva sin recargar;
  - fleet-api reiniciado → reconexión y recuperación del estado;
  - pregunta al agente con `toolCalls` visibles;
  - fleet-api detenido → breaker abierto en el chat.
