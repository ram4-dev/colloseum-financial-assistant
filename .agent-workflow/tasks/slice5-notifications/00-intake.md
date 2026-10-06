# Slice 5 — Notificaciones observables

## Outcome

Cada ejecución financiera del asistente y cada evento entrante relevante deben quedar como aviso durable y aparecer en la app sin que el usuario refresque la página. Un webhook firmado del proveedor es el camino inmediato; un reconciliador de polling recupera eventos perdidos. Las revisiones activas se publican por el topic LiveKit `conversation_state_changed` ya consumido por el front.

## Acceptance evidence

- Webhook con firma inválida no crea eventos ni notificaciones; entrega repetida con la misma clave idempotente no duplica.
- Eventos firmados y eventos de reconciliación crean el mismo aviso canónico, una sola vez, ligado al usuario/wallet correctos.
- Ejecuciones iniciadas por el asistente generan aviso durable tanto si se ejecutan bajo grant vigente como si pasan por confirmación.
- El front observa avisos nuevos sin refresh; al perderse webhook el polling/reconciliador los recupera.
- El payload/proyección de notificación no expone secretos de webhook ni datos innecesarios de transacción.

## Authority and scope

- Autorización: instrucción secuencial de Ramiro vía Hermes del 2026-10-05 para iniciar Slice 5 sin nuevas aprobaciones, luego de Slices 2–4.
- D-5 ya decidido por Ramiro: webhooks firmados del proveedor + polling de reconciliación como red; fan-out vía `revision-publisher` a `conversation_state_changed`; sin push nativo para este MVP.
- Read scope: backend de notificaciones/eventos, provider Privy/Solana, persistencia y APIs de conversación, componentes front que observan revisiones y avisos, migraciones y tests.
- Write scope: `openspec/changes/slice5-notifications/`, este task packet, e implementación futura en worktree dedicado.
- Non-goals: push FCM/APNs, cambios de grant/ejecución, swaps, multi-wallet, cambios al flujo de firma o nuevas redes.

## Workflow

- Route: RPI + SDD (la fuente de eventos, dedupe, recuperación y entrega atraviesan backend y UI; un cambio mecánico no alcanza).
- Worktree: `/Users/ramiro/Desktop/projects/colloseum.slice5-notifications`.
- Branch: `slice5-notifications`, creado desde `origin/slice4-voice-confirmation` (`10aab3e`).
- Active gate: investigar capacidad/contrato actual y completar el diseño SDD antes de tocar código de runtime. La secuencia de trabajo está autorizada; los PRs permanecen separados y no se mergean.

## Approval record

Gate ID: `slice5-d5-scope`
Decision / allowed mutation: investigar y completar SDD de Slice 5 usando D-5; luego implementar en este worktree tras dejar un outline revisable y verificado.
Explicit exclusions: slices 6–7; push nativo; merge de PRs.
Owning artifact / revision or hash: instrucción de Ramiro de 2026-10-05 y `.agent-workflow/tasks/financial-assistant-development/01-propuesta-plan.md` D-5, más baseline branch `10aab3e`.
Decision owner: Ramiro.
Approved by / trusted identity: Ramiro, instrucción directa registrada en la conversación y transmitida vía Hermes.
Approved at: 2026-10-05.
Status: approved.
Invalidated by: cambio de alcance, D-5 o base de código padre.
