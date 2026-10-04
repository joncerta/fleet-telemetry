
name: add-contract
description: Agrega o modifica un esquema compartido en packages/contracts (evento Kafka, DTO HTTP de request o response, evento SSE, schema de herramienta del agente IA) y propaga el cambio a todos los productores y consumidores con compatibilidad hacia atrás y hacia adelante. Úsala siempre que cambie la forma de un dato que cruza servicios, apps o la cola offline del móvil.
argument-hint: "[descripción del cambio de contrato]"
---
<!-- EDITA: ajusta rutas de archivos, ubicación de fixtures y convención de migraciones a tu repo. -->
 
Cambio de contrato: **$ARGUMENTS**
 
Paquetes que dependen de `@fleet/contracts`:
!`grep -l '"@fleet/contracts"' services/*/package.json apps/*/package.json packages/*/package.json 2>/dev/null`
 
## 0. Clasifica el cambio antes de tocar nada
 
Identifica el schema afectado y quién lo **produce** y quién lo **consume**. Luego clasifica el cambio:
 
| Cambio | Clasificación |
|---|---|
| Campo nuevo opcional | Compatible |
| Campo nuevo con `.default()` | Compatible (ver nota) |
| Hacer opcional un campo requerido | Compatible para quien lee; revisa que ningún consumidor asuma que existe |
| Campo nuevo requerido | **Incompatible**: rompe a los productores viejos (versiones del móvil instaladas, mensajes ya en el tópico) |
| Eliminar o renombrar un campo | **Incompatible** |
| Cambiar el tipo de un campo | **Incompatible** |
| Hacer requerido un campo opcional | **Incompatible** |
| **Agregar un valor a un enum** | **Incompatible para consumers viejos** que validan con `z.enum`: rechazan el mensaje y lo mandan a la DLQ |
| Quitar un valor de un enum | **Incompatible** |
| Restringir una validación (min, max, regex, longitud) | **Incompatible**: mensajes antes válidos ahora fallan |
 
Nota sobre `.default()`: el default lo aplica quien parsea, no quien produce. Un consumer que no se ha actualizado no lo aplica.
 
Revisa las dos direcciones:
- **Hacia atrás**: el código nuevo lee datos viejos. Versiones viejas del móvil, mensajes retenidos en Kafka, mensajes en la DLQ que se reprocesan, **payloads guardados en la cola SQLite del móvil antes de actualizar la app**.
- **Hacia adelante**: el código viejo lee datos nuevos. Durante el despliegue conviven réplicas viejas y nuevas.
**Si el cambio es incompatible, detente.** No implementes. Propón el plan de migración (paso 1b) y pide aprobación explícita.
 
## 1. Edita el schema
 
En `packages/contracts/src/`: `telemetry.ts` para la ingesta, `fleet.ts` para estado, alertas y SSE. Usa la API de zod 4.
 
**1a. Cambio compatible**
- Campos nuevos con `.optional()` o `.default()`.
- Objetos de mensajes externos con `z.object` (descarta campos desconocidos), **nunca** `z.strictObject` en el lado consumidor: rechazaría campos que agregue una versión más nueva.
- Enums que pueden crecer: el consumidor tolera valores desconocidos (por ejemplo, con `.catch()` a un valor `unknown` y un log), en lugar de fallar.
- Documenta el campo nuevo con `.describe()` o comentario: qué significa, unidad y desde qué versión existe.
**1b. Cambio incompatible (solo con aprobación)**
- Nunca cambies el tipo ni el significado de un campo existente: crea uno nuevo.
- Camino de migración:
  1. Agregar el campo nuevo como opcional y marcar el viejo como deprecado.
  2. Los productores escriben los dos.
  3. Los consumidores leen el nuevo, con respaldo en el viejo.
  4. Retirar el viejo solo cuando ninguna versión del móvil en uso lo envíe y el tópico ya no tenga mensajes con el formato anterior.
- Para eventos de Kafka con cambio estructural: versión nueva del evento (campo `version` con unión discriminada) o tópico nuevo, según lo que defina CLAUDE.md.
## 2. Tests de compatibilidad del contrato
 
- Antes de modificar, guarda un ejemplo real de la versión actual como fixture (por ejemplo, `packages/contracts/src/__fixtures__/<schema>/v<N>.json`), si no existe.
- Tests que deben pasar:
  - **todos los fixtures de versiones anteriores siguen parseando** con el schema nuevo;
  - un mensaje con el formato nuevo parsea;
  - un mensaje con un campo desconocido extra parsea (compatibilidad hacia adelante);
  - si agregaste un valor a un enum, un consumidor con la lógica tolerante no falla ante un valor desconocido.
Luego:
 
```
pnpm --filter @fleet/contracts build && pnpm --filter @fleet/contracts test
```
 
## 3. Encuentra los usos reales
 
No basta con saber quién importa el paquete. Busca **el nombre del schema y del tipo** que cambiaste (por ejemplo, `TelemetryBatch` y `telemetryBatchSchema`) en:
- `services/`, `apps/web/`, `apps/mobile/` y `packages/` (archivos `.ts` y `.tsx`), sin `node_modules` ni `dist`;
- tests, mocks y fixtures JSON;
- scripts de k6 (`.js`) y el simulador;
- schemas de las herramientas del agente IA (cambiar un schema cambia lo que el LLM ve y envía);
- seeds de base de datos y datos de demo.
Haz también una lista de los usos que no compilan pero dependen de la forma del dato:
- adaptadores SQL que mapean campos a columnas;
- la cola SQLite del móvil;
- consultas del dashboard;
- SSE serializado a mano.
## 4. Ajusta productores y consumidores
 
- Corrige cada uso encontrado.
- Compila y prueba el contrato y todos sus dependientes:
```
pnpm turbo run typecheck test --filter=...@fleet/contracts
```
 
  Si algo no compila o falla, ese es el siguiente archivo a corregir.
- **Móvil**: si cambió el payload de telemetría, verifica que los puntos ya guardados en SQLite con el formato anterior se sigan pudiendo enviar después de actualizar la app. Si no, hace falta una migración de la cola o que el back acepte ambos formatos.
- **Kafka**: la key del mensaje (`vehicleId`) y el tópico no cambian como efecto colateral.
## 5. Base de datos (solo si cambia lo que se persiste)
 
- Crea una migración **nueva** en `infra/db/migrations/`. Nunca edites una existente.
- Revisa cuál es el último número usado y toma el siguiente, sin chocar con migraciones de otras ramas abiertas.
- La migración es reversible. Columna nueva nullable o con default, para que las réplicas viejas sigan insertando durante el despliegue.
- En hypertables, los índices únicos incluyen la columna de tiempo, y no se usa `CREATE INDEX CONCURRENTLY`.
- Actualiza el adaptador SQL que mapea el contrato a la tabla.
## 6. Resumen
 
Entrega:
 
~~~
## Contrato
<schema afectado y cambio>
 
## Clasificación
<compatible | incompatible (aprobado por el humano) — motivo>
 
## Productores y consumidores tocados
- <ruta> — <qué cambió>
 
## Compatibilidad verificada
- fixtures de versiones anteriores: <ok | falla>
- campo desconocido extra: <ok | falla>
- cola offline del móvil con datos viejos: <ok | no aplica | pendiente>
 
## Migración de base de datos
<archivo nuevo | ninguna>
 
## Verificación
- build y tests de contracts: <ok | falla>
- typecheck y tests de dependientes: <ok | falla + detalle>
 
## Pendientes
<retiro futuro de campos deprecados, versiones mínimas del móvil, cambios en k6 o simulador>
~~~
 
Siguiente paso: correr `architect-reviewer` y, si se tocó web o móvil, `frontend-reviewer`.