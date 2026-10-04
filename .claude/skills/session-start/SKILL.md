---
name: session-start
description: Carga el contexto al iniciar una sesión de trabajo (progreso, siguiente paso, commits, cambios pendientes, entorno) y propone un plan verificable con el agente o skill adecuado para cada paso. Solo se usa cuando el humano lo pide.
disable-model-invocation: true
argument-hint: "[objetivo de la sesión, opcional]"
allowed-tools: Read, Glob, Grep, Bash(git log *), Bash(git status *), Bash(git diff *), Bash(git branch *), Bash(git rev-parse *), Bash(git stash list), Bash(docker compose ps *)
---
<!-- EDITA: lista de agentes y skills si agregas o renombras alguno. -->

Progreso del proyecto:
!`cat docs/PROGRESS.md 2>/dev/null || echo "(docs/PROGRESS.md no existe todavía)"`

Rama: !`git branch --show-current` · HEAD: !`git rev-parse --short HEAD`

Últimos commits:
!`git log --oneline -15`

Cambios sin commit:
!`git status --short`

Stashes: !`git stash list`

Entorno local:
!`docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>&1`

Objetivo de esta sesión (del humano): $ARGUMENTS

## Antes de planear

- **Trabajo sin documentar**: compara `Último commit registrado` en PROGRESS.md con `HEAD`. Si hay commits posteriores, avisa que hubo trabajo fuera del último handoff, resúmelo desde `git log` y trátalo como parte del estado actual.
- **Trabajo sin guardar**: si hay cambios sin commit o stashes, avísalo primero y pregunta qué hacer: continuar sobre ellos, que el humano los commitee, o descartarlos (eso lo hace el humano, no tú).
- **Objetivo**: si el humano no dio uno, usa `## Siguiente` de PROGRESS.md. Si dio uno que choca con un bloqueo o una dependencia registrada, dilo y propón el orden correcto.

## Entrega

1. **Dónde estamos**, en 3 líneas: fase actual, último avance verificado y bloqueos abiertos.

2. **Plan de la sesión**, en máximo 6 pasos. Cada paso indica:
   - qué se hace;
   - quién lo hace: agente (`backend-engineer`, `web-engineer`, `mobile-engineer`, `devops-engineer`) o skill (`/new-usecase`, `/add-contract`);
   - **cómo se verifica**: comando, skill o criterio observable;
   - de qué paso depende, o si puede ir en paralelo con otro.

3. **Reglas del plan**:
   - Los contratos (`/add-contract`) van antes que sus productores y consumidores.
   - Los requisitos pendientes del backend van antes que el trabajo de web, móvil, k6 o e2e que depende de ellos.
   - Todo paso que cambie código termina con su revisión: `/arch-review` para back, `/front-review` para web o móvil.
   - Si la sesión pretende cerrar una fase, el plan incluye `/e2e-check` antes de darla por completa.
   - Si el objetivo no cabe en una sesión, divídelo y deja claro qué queda para la siguiente.

4. **Recordatorios** (solo si aplican):
   - correcciones a la IA pendientes de registrar, anotadas en el último handoff;
   - entorno local abajo, si el plan necesita verificar contra él;
   - al cerrar la sesión: `/session-handoff`.

5. **Espera aprobación** antes de escribir código o lanzar cualquier agente.
