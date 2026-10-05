# Fixtures de compatibilidad de contratos

Convención: `fixtures/<esquema>/v<N>.json`, un valor JSON por archivo, donde `<esquema>` es el `name` de la
entrada en `src/compat/registry.ts` y `<N>` un entero positivo.

- Un fixture es un mensaje real de esa versión del contrato. **Nunca se edita** una vez publicado: es lo que
  un productor viejo (el móvil sin actualizar, un mensaje ya en Kafka) puede seguir enviando.
- Al cambiar un esquema, el cambio es aditivo: se agrega `v<N+1>.json`, se registra la versión y todas las
  anteriores deben seguir parseando con el esquema actual.
- `src/compat/fixtures.test.ts` falla si un fixture registrado no existe o no parsea, y también si hay un
  fixture o carpeta sin registrar (una versión no puede quedar fuera de la verificación sin que se note).
- El fixture de la **última** versión también se prueba con un campo extra en cada objeto del esquema
  (compatibilidad hacia adelante): un productor más nuevo puede agregar campos, así que los esquemas usan
  `z.object`, nunca `z.strictObject`. El campo se inyecta siguiendo el esquema (`z.object`, `z.array`,
  `optional`/`nullable` y `z.discriminatedUnion`); no se entra en `z.record`, uniones simples, tuplas, `pipe`
  ni `lazy`, así que un `z.strictObject` escondido ahí no se detecta.
- Todo esquema zod exportado por `@fleet/contracts` debe tener su entrada en el registro; si no, el test falla.
