---
name: session-handoff
description: Cierra una sesión de trabajo actualizando docs/PROGRESS.md con lo hecho, decisiones, estado de verificación, pendientes y cómo retomar, para que la próxima sesión arranque con contexto. Solo se usa cuando el humano lo pide.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log *), Bash(git status *), Bash(git diff *), Bash(git branch *), Bash(git rev-parse *), Bash(git stash list)
---

Fecha de hoy: !`date +%Y-%m-%d`
Rama: !`git branch --show-current` · HEAD: !`git rev-parse --short HEAD`

Último commit registrado en PROGRESS.md:
!`grep -m1 'Último commit registrado' docs/PROGRESS.md 2>/dev/null || echo "(ninguno)"`

Commits recientes (filtra desde el último registrado):
!`git log --oneline -30`

Cambios sin commit:
!`git status --short`
!`git diff --stat HEAD`

Stashes: !`git stash list`

Entradas del log de auditoría:
!`grep '^### ' docs/AI_AUDIT_LOG.md 2>/dev/null || echo "(sin log)"`

## Reglas

- Usa **solo** lo que pasó en esta conversación y lo que muestra git. No inventes avances, decisiones ni resultados. Lo que no puedas confirmar va como `TODO` o "no verificado".
- Sin secretos, tokens ni datos personales en el archivo.
- Si `docs/PROGRESS.md` no existe, créalo con una tabla de fases (`Fase | Estado | Evidencia`), `## Siguiente` y la línea `Último commit registrado`.

## Pasos

1. **Lo hecho**: commits desde el último registrado (o los mostrados, si no hay registro) más el trabajo sin commitear, descrito por lo que hace, no por archivos.

2. **Fases**: una fase se marca `completa` solo con evidencia de esta sesión:
   - `/e2e-check` o `qa-verifier` con veredicto `LISTO`, o
   - confirmación explícita del humano.

   Si no hay evidencia, queda `en progreso`. En la columna Evidencia va el veredicto con su fecha o "confirmado por el humano".

3. **Decisiones**: cada decisión con su motivo. Busca ADRs relacionados (`docs/adr/`, `docs/decisions/` o lo que use el repo) y enlázalos. Si una decisión importante no tiene ADR, anótalo en pendientes.

4. **Verificación**: lo que se ejecutó en la sesión y su resultado (typecheck, tests, `/arch-review`, `/front-review`, `/e2e-check`). Si no se ejecutó nada, dilo.

5. **Correcciones a la IA sin registrar**: cruza los hallazgos marcados como "¿Candidato a auditoría IA?: sí" y las correcciones hechas en la sesión con los títulos del log de auditoría. Lista las que falten, con el comando listo:
   `/ai-audit-entry <título corto>`

6. **Siguiente**: reescribe `## Siguiente` para que una sesión nueva pueda arrancar sin preguntar:
   - el próximo paso concreto y qué agente o skill usar;
   - lo que lo bloquea, incluidos los requisitos pendientes entre agentes (por ejemplo, cambios que el backend debe hacer para web, móvil, k6 o e2e);
   - cómo retomar: rama, comandos para levantar el entorno y archivos a leer primero.

7. **Compactación**: conserva en detalle las últimas 3 secciones `## Sesión`. Las anteriores se resumen en una línea cada una, bajo `## Historial`. Este archivo se lee al inicio de cada sesión: mantenlo corto.

8. **Borrador**: muestra al humano los cambios propuestos (tabla de fases, sección nueva, `## Siguiente`) **sin escribir todavía**. Aplica sus ajustes.

9. **Escritura**: con aprobación, actualiza `docs/PROGRESS.md`, incluida `Último commit registrado: \`<HEAD>\``.

10. **Avisos finales** en tu respuesta, no en el archivo:
    - si hay archivos sin commit o stashes: "Hay N archivos sin commit: el trabajo de esta sesión no está guardado en git";
    - las correcciones a la IA pendientes de registrar, con sus comandos.

## Formato de la sección de sesión

~~~~markdown
## Sesión <fecha> — <rama>

**Hecho**
- <avance descrito por lo que hace>

**Decisiones**
- <decisión> — <motivo> ([ADR-NNN](ruta) | sin ADR)

**Verificación**
- <comando o skill>: <resultado> | Nada ejecutado en esta sesión

**Problemas abiertos**
- <problema> — <impacto y dónde mirar>
~~~~
