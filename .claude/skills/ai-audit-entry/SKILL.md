---
name: ai-audit-entry
description: Registra en docs/AI_AUDIT_LOG.md una corrección hecha a una sugerencia deficiente de la IA (por ejemplo, un hallazgo marcado "¿Candidato a auditoría IA?: sí" por architect-reviewer o frontend-reviewer). Solo se usa cuando el humano lo pide.
disable-model-invocation: true
argument-hint: "[título corto de la corrección]"
allowed-tools: Read, Write, Edit, Grep, Bash(git log *), Bash(git show *), Bash(git diff *), Bash(git status *)
---
<!-- EDITA: este es el material del punto 3 de entregables. Ajusta el formato si quieres más o menos detalle. -->
 
Registra en `docs/AI_AUDIT_LOG.md` la corrección: **$ARGUMENTS**
 
Fecha de hoy: !`date +%Y-%m-%d`
 
Últimos commits:
!`git log --oneline -8`
 
Cambios sin commitear:
!`git status --short`
 
Entradas existentes en el log:
!`grep -n '^### ' docs/AI_AUDIT_LOG.md 2>/dev/null || echo "(el archivo no existe todavía)"`
 
## Reglas
 
- Usa **solo** lo que pasó realmente en esta conversación o lo que puedas comprobar en el repo (`git show`, `git diff`, archivos). Si falta un dato (prompt original, commit, quién lo detectó), déjalo como `TODO`. Nunca lo inventes ni lo reconstruyas "plausiblemente".
- El "prompt correctivo" es el que realmente se usó. Si la corrección la hizo el humano a mano, dilo así.
- El fragmento "Lo que propuso la IA" sale del commit, del diff o del hallazgo del reviewer. Si ya no se puede recuperar, pon `TODO` y no lo recrees de memoria.
- Redacta secretos, tokens, coordenadas reales y datos personales en los fragmentos.
- Si el hallazgo viene de un reviewer, usa su archivo y línea, su severidad y su escenario de producción.
## Pasos
 
1. **Reincidencia**: revisa las entradas existentes. Si el mismo tipo de error ya está registrado, la entrada nueva lo indica como "Reincidencia de #N". Un error que se repite es un hallazgo en sí mismo.
2. **Numeración**: N = número de la última entrada + 1 (1 si el archivo no existe).
3. **Borrador**: redacta la entrada con el formato de abajo y **muéstrala al humano sin escribir el archivo todavía**.
4. **Aprobación**: espera el visto bueno o los ajustes del humano. Aplica los ajustes.
5. **Escritura**: solo con aprobación, agrega la entrada al final de `docs/AI_AUDIT_LOG.md`. Si el archivo no existe, créalo con el encabezado `# Registro de auditoría de IA` y una línea que explique su propósito antes de la primera entrada.
6. Confirma en una línea el número de la entrada y los `TODO` que quedan pendientes.
## Formato exacto
 
~~~~markdown
### N. <título>
**Fecha:** <fecha de hoy> · **Área:** <servicio o app> · **Severidad:** crítica | alta | media · **Detectado por:** architect-reviewer | frontend-reviewer | qa-verifier | humano
**Tipo de error de IA:** <API inexistente o firma inventada · API desactualizada · tipos duplicados · error tragado · test que no prueba nada · tenant controlable por el LLM · coordenadas invertidas · snapshot regenerado · inconsistencia entre archivos · otro: ...>
<si aplica: **Reincidencia de:** #M>
 
**Contexto / prompt original**
> <el prompt que se le dio a la IA, textual o resumido; TODO si no está disponible>
 
**Lo que propuso la IA** — `<archivo>:<línea>`
```ts
<fragmento relevante, máximo 15 líneas>
```
 
**Por qué es deficiente**
<1-3 frases: qué falla en producción, con un escenario concreto (seguridad / escalabilidad / pérdida de datos / arquitectura)>
 
**Criterio aplicado y prompt correctivo**
> <el prompt con el que se forzó el refactor, o "corrección manual del humano">
 
**Resultado**
```ts
<fragmento final, máximo 15 líneas>
```
 
**Prevención:** <test de regresión que lo detecta (ruta) · regla agregada a CLAUDE.md · ítem agregado a la checklist del reviewer · ninguna (justificar)>
**Estándar aplicado:** <Clean Architecture / idempotencia / OWASP / 12-factor / regla de CLAUDE.md / etc.> · **Commit:** `<hash>` | `TODO (pendiente de commit)`
~~~~
