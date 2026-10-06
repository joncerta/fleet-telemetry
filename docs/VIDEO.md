# Guion del video (8 a 9 minutos)

Para grabar con el stack local arriba. Antes de empezar:

```bash
docker compose up -d --wait
pnpm db:migrate && pnpm db:seed
pnpm dev
pnpm simulate
```

Abre tres ventanas:
- el dashboard (`http://localhost:3000`);
- una terminal;
- el editor con el repo.

El emulador Android solo hace falta para el bloque 5.

| # | Tiempo | Bloque | Qué se muestra | Qué se dice |
|---|---|---|---|---|
| 1 | 0:00–0:45 | Qué es | El diagrama del README y la estructura del monorepo | Móvil offline-first → gateway → Kafka → processor → Timescale → fleet-api con SSE → dashboard, más un agente con herramientas tipadas. La prueba evalúa el *cómo*: el resto del video es eso |
| 2 | 0:45–2:15 | Dashboard en vivo | Login como `operador@norte.test`: el mapa con 15 vehículos moviéndose, los KPIs y la atribución de OpenFreeMap. Aparece una alerta sin recargar. La lista de detenidos más de 20 min en zona crítica | Un único `EventSource`: el snapshot llega primero y los eventos se ordenan por `seq` en cada vehículo. "Sin señal" se calcula contra la hora del servidor |
| 3 | 2:15–3:00 | Aislamiento | En otra ventana, login como `operador@sur.test`: solo Medellín, nada de Norte | El tenant sale siempre de la identidad: cookie en la API y en el SSE, token del dispositivo en la ingesta. Nunca del body ni del LLM |
| 4 | 3:00–4:15 | Agente y breaker | En el chat: "¿Qué vehículos llevan detenidos más de 20 minutos en zonas críticas?". Se ven la respuesta y la `toolCall` `get_stopped_vehicles`. Luego se detiene fleet-api: el chat dice que no hay datos y el indicador del breaker pasa a abierto. Se levanta de nuevo y se recupera | Sin text-to-SQL: 3 herramientas con esquema zod y límites. La cookie se reenvía y el tenant lo filtra fleet-api. Si falla, lo dice y no inventa |
| 5 | 4:15–5:15 | Móvil offline | En el emulador: vincular con un código creado en el dashboard e iniciar turno. Con el modo avión puesto suben los pendientes; al quitarlo bajan a 0. En la base, capturados = recibidos y sin duplicados | El `eventId` se genera al capturar y la cola SQLite es idempotente. El ACK separa `accepted` de `rejected`, y un rechazo es permanente |
| 6 | 5:15–6:00 | Resiliencia y carga | La tabla de k6 del README. En la terminal, `infra/k6/README.md` con la corrida `processor-kill` | 10% de duplicados reales y 5% de inválidos, verificados por conteos. Con SIGKILL a mitad de lote: cero pérdidas y cero duplicados, porque el offset se confirma después de persistir y el sink es idempotente |
| 7 | 6:00–8:00 | Entorno agéntico | `CLAUDE.md` (las 17 reglas), `.claude/agents/` y `.claude/skills/`. Luego **el hallazgo real**: `/arch-review` del PR #5 dio RECHAZADO con un crítico, "clasificación de fallos por defecto permanente". Se muestran el diff de la corrección, el test con `REVOKE INSERT` y la entrada en `docs/AI_AUDIT_LOG.md`. Por último, el hook bloqueando un cierre con un test roto | La IA escribe y otra IA más capaz revisa sin poder editar. El hook vuelve mecánica la verificación. Los permisos impiden borrar datos, desplegar o leer secretos. Cada error real de la IA queda auditado con su test de regresión |
| 8 | 8:00–8:40 | Infraestructura y cierre | `infra/terraform/` (módulos) y el job `infra` del CI | Diseñado y validado (`validate`, `tflint`, `trivy`), pero no desplegado: costo, dominio y región son decisiones de negocio. ADRs en `docs/adr/` |

## Comprobación previa a grabar
- `/e2e-check video` en `LISTO`.
- `pnpm simulate` corriendo al menos 1 minuto antes del bloque 2, para que haya detenidos de más de 20 minutos.
- `ANTHROPIC_API_KEY` de un workspace en `.env`, para el bloque 4 con Claude real.
- Ningún dato personal real en pantalla: placas, zonas y usuarios son de demo.
