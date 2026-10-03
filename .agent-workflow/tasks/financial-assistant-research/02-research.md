# Research: asistente financiero sobre varias wallets

Fecha: 2026-02-20. Alcance: investigación y brainstorm. No se modificó el repo fuente
(`/Users/ramiro/Desktop/projects/personales/aleph-hackathon`, HEAD `99ad96b`) ni se
operaron cuentas, secretos o fondos. Fuentes externas consultadas el mismo día.

---

## 1. Estado actual verificado en el código

Todo lo de esta sección es **hecho observados en el código** salvo que se marque como
inferencia.

### 1.1 Mapa del flujo real (voz → on-chain)

El flujo de voz Realtime ya está **integrado en main**, no vive solo en una rama POC:
la rama `origin/real-time-voice-agent-with-live-streaming` (commits `c3b1131`,
`b38719b`, `a17120e` "feat(voice): make OpenAI GPT-Realtime the only voice path with
real wallet tools") es ancestro de HEAD `99ad96b`. La variante `feat-openai-realtime-poc`
tal como se nombra en el intake **no existe como rama local ni remota** con ese nombre
exacto; su contenido está mergeado. Decisión práctica: main ya es la base correcta.

Flujo completo:

1. **Token de sala** — `src/livekit/token-issuer.ts` (API Fastify) emite tokens de
   sala; la identidad se resuelve server-side.
2. **Binding** — El worker (`src/livekit/worker.ts`) recibe al participante y el gate
   `RoomConversation.bind()` (`src/livekit/room-conversation.ts:44-127`) verifica un
   token de binding Ed25519 efímero (`verifyLiveVoiceBinding`, `src/auth/live-binding.ts`)
   cuyo claim `sub` es el `userId`. Existe lease anti-duplicado
   (`acquireLiveLease` → `conversation_already_live`) y verificaci\u00f3n de que la identidad del
   participante coincide con `binding.sub`.
3. **Sesión Realtime** — `createAgentSession`
   (`src/livekit/create-agent-session.ts:24-44`) compone `Agent` + `AgentSession` con
   `openai.realtime.RealtimeModel` (modelo `gpt-realtime-2.1-mini`, voz `marin`,
   `record: false`). Speech-to-speech puro: sin STT/TTS intermedios (verificado en
   `docs/architecture.md`).
4. **Herramientas** — `createRealtimeTools`
   (`src/livekit/realtime-tools/create-realtime-tools.ts:218+`) expone 5 herramientas
   cerradas sobre las dependencias por-binding (wallet, memoria, servicio):
   - `get_balance` — lectura del balance configurado.
   - `search_contacts` — búsqueda de contactos **sin direcciones** en el payload
     del modelo (`stripCandidate`); falla cerrado a `unavailable`.
   - `send_token` — **solo preview**. Esquema zod `.strict()` que rechaza `dryRun`,
     `to`, `network`, `token`, `wallet`. Delega en `service.previewTransfer`.
   - `confirm_transfer` / `cancel_transfer` — sin parámetros; leen el preview
     persistido actual (`conversations.get` → `pendingTransfer.previewId`) en cada
     llamada, nunca capturado al bindear ("REVIEW FIX V1": un preview reemplazado
     falla a `stale_preview`).
5. **Servicio de conversación** — `src/conversations/service.ts` (~1400 líneas) es el
   cerebro: `previewTransfer` (línea 615), `resolveDecision` (430), `handleTurnStream`
   (192). Persiste en Supabase PostgreSQL y emite revisiones de estado.
6. **Ejecución durable** — Al confirmar: claim atómico del preview
   (`claimPendingTransfer`), fase `broadcasting` → `walletForUser(userId).broadcastTransfer`
   (línea 800) → `markTransferSubmitted` → `waitForFinality` (885) → `finalizeTransfer`.
   Los eventos publicados viajan por `FinancialTaskRegistry.publish`
   (`src/conversations/financial-task-registry.ts`) al frontend (cards de estado).
7. **Proveedor de wallet** — `bindWalletForUser`
   (`src/wallet/privy-user-provider.ts:47+`) difiere el descubrimiento de wallet hasta
   el primer uso; falla cerrado si no hay wallet. Proveedores concretos: Privy
   (usuario), Circle Arc (demo/tesorería), WDK (MCP), fixture (tests).

### 1.2 Capacidades verificadas

| Capacidad | Estado | Evidencia |
| --- | --- | --- |
| Voz realtime speech-to-speech | ✅ Integrada en main | `create-agent-session.ts`, `docs/architecture.md` |
| Transferencias con preview + confirmación explícita | ✅ | `create-realtime-tools.ts` (`send_token` preview-only), `service.ts:430+` |
| Idempotencia de broadcast | ✅ Parcial | `previewId` + `idempotencyKey` inyectados solo desde preview confirmado (`wallet-agent.ts` CAR-006; `transfer-pipeline.ts` claim atómico por `idempotency_key`) |
| Resultado incierto | ✅ Manejado explícitamente | `BroadcastOutcome = submitted \| uncertain \| not_dispatched` (`provider.ts:14-18`); `markBroadcastUncertain`; reconciliación F6 en `transfer-pipeline.ts:reconcileUncertain` (re-firma intent idéntico, nunca nuevo nonce) |
| Recipient revalidation | ✅ | `recipient_revalidation_required` con versiones de contacto (`wallet-agent.ts`, `session-state.ts`) |
| Multi-usuario / multi-wallet por usuario | ✅ Parcial | `bindWalletForUser(userId)` por binding; `signer_grants` con allowlist, cap por transferencia y ventana rolling (`transfer-pipeline.ts`, GrantRow) |
| Permisos delegados | ✅ Diseñado (fixture-only) | `signer_grants` + `wallet_operations` (estados claimed/signed/submitted/confirmed/reverted/uncertain/rejected); pipeline "Fixture-only until durable real transport and receipt reconciliation are integrated" (`transfer-pipeline.ts:195-198`) |
| Política de transferencia live | ✅ | `validateLiveTransferPolicy` (`wallet-agent.ts`): max amount, allowlist de recipients, wallet/network/token exactos |
| Balance, historial | ✅ Lectura | `WalletProvider.getBalance/getHistory` (`provider.ts:33-35`), `api/wallet.ts` |
| Rooms durable / lease | ✅ | `acquireLiveLease`/`renewLiveLease`/`releaseLiveLease` con expiración 30s |
| Swaps | ❌ No existe | `grep swap` en `src/`: 0 resultados |
| Notificaciones (push/webhook/on-chain events) | ❌ No existe | `grep notif/webhook/apns/fcm/sse` en `src/`: 0 resultados relevantes |
| Solana | ❌ No existe | 0 resultados en `src/`; solo EVM (EVM_ADDRESS, sepolia, arc-testnet) |
| Selección de red/token por voz | ❌ Bloqueada a propósito | Instrucciones Nani prohíben network/token en `send_token`; política live exige match exacto con config |
| Proveedores simultáneos | ⚠️ Una wallet activa por usuario | `bindWalletForUser` devuelve **un** `WalletProvider` por usuario; WDK/Privy/Circle son **alternativas de configuración**, no simultáneos |

### 1.3 Limitaciones relevantes

1. **Una wallet activa por sesión/usuario.** El tipo `WalletContext { wallet, network }`
   y `bindWalletForUser` devuelven un solo proveedor. "Varias wallets" hoy significa
   "el usuario tiene una wallet embebida Privy"; no hay concepto de portfolio
   multi-wallet ni selección de origen.
2. **Pipeline de firma/broadcast durable es fixture-only.** `WalletTransferPipeline`
   lanza `live_transport_unavailable` si el cliente no es fixture
   (`transfer-pipeline.ts:197-198`). El camino live usa el proveedor directo (Privy
   server-side signing) sin la capa de reconciliation F6 sobre transporte real.
3. **El estado de sesión de voz es durable donde importa.** El estado financiero
   (pendingTransfer, revisiones, historial) vive en PostgreSQL, no en la sala: el gate
   `RoomConversation` es stateless respecto al dinero y `RoomConversation.release()`
   limpia solo lo efímero. Los turns de voz se encolan con `DeferredTurnQueue` y
   "un worker crasheado nunca repite discurso efímero" (`room-conversation.ts`,
   finally en `processTranscript`).
4. **Voz ≠ autenticación.** El binding usa token Ed25519 firmado server-side con
   identidad de participante verificada; la voz solo dispara acciones ya autorizadas
   por ese binding. Correcto y debe mantenerse.
5. **Idioma**: Nani inicia en inglés por defecto (commit `f95c2fa`), con textos de
   clarificación en es-AR disponibles (`CLARIFICATION_COPY`).
6. **Costo Realtime**: `gpt-realtime-2.1-mini` tiene precios publicados de $10/M audio
   input, $20/M output (OpenAI pricing, 2026-02). La referencia comunitaria
   (~$0.04/min) no es fuente oficial; reportarla como estimación no verificada.

---

## 2. Fuentes externas oficiales (consultadas 2026-02-20)

### LiveKit Agents (JS/TS)

- `AgentSession` es el orquestador: recolecta input, maneja pipeline de voz, invoca el
  LLM, emite eventos de observabilidad y control. Requiere al menos un `Agent`.
  <https://docs.livekit.io/agents/logic/sessions/>
- **Async tools** para tareas de larga duración: una tool que tarda más de unos
  segundos bloquea la conversación; las async tools permiten que el agente siga
  hablando, enviar progreso, y ser cancelables. Es la solución oficial para "transfer
  esperando finalidad on-chain" (que tarda ~2-120s según `FINALITY_TIMEOUT_MS`).
  <https://docs.livekit.io/agents/logic/tools/async/>
- Los agent servers tienen **graceful draining** en LiveKit Cloud (rolling deploy:
  instancias viejas dejan de aceptar trabajo y esperan sesiones activas).
  <https://livekit.com/blog/deployment-reliability-cloud>
- Dispatch con `restart_policy` (Cloud-only, default `JRP_ON_FAILURE`).
  <https://docs.livekit.io/reference/agents/agent-dispatch-service-api/>
- Hueco declarado: no encontramos un mecanismo documentado para **reanudar una
  sesión Realtime después de que el worker muere** (issue #242 de livekit/agents
  confirma que si el agente muere, el backend no lo re-invoca en la misma sala). La
  recuperación real pasa por durabilidad fuera de la sala — exactamente lo que el
  repo ya hace con PostgreSQL.

### OpenAI Realtime

- `gpt-realtime` / `gpt-realtime-2.1` / `gpt-realtime-2.1-mini`: speech-to-speech GA
  sobre WebRTC/WebSocket/SIP, **function calling soportado**, reasoning effort
  configurable (2.1).
  <https://developers.openai.com/api/docs/guides/realtime-conversations>
  <https://developers.openai.com/api/docs/models/gpt-realtime-2.1>
- La API Realtime mantiene el estado de conversación del lado del modelo; el uso del
  repo (una sola sesión s2s con tools) sigue el patrón recomendado.
  <https://developers.openai.com/api/docs/guides/realtime>
- Precios oficiales (página Pricing, consultada 2026-02-20):
  `gpt-realtime-2.1-mini` audio: $10/M input, $20/M output; texto $0.60/$2.40.

### Privy (proveedor actual de wallets de usuario)

- **Embedded wallets** self-custodial en TEEs, EVM/Solana/otras chains.
  <https://docs.privy.io/wallets/overview/embedded>
- **Server-side access / signers**: el server puede firmar con la wallet del usuario
  sin user-in-the-loop mediante *signers* con políticas; el server nunca ve la clave
  privada. Soporta "agentic transactions" y ejecución offline del usuario.
  <https://docs.privy.io/wallets/wallets/server-side-access>
  <https://docs.privy.io/wallets/using-wallets/signers>
- **Swaps** como wallet actions con quote → execute → wallet action con ciclo de
  status (pending → confirmado), en EVM y **Solana**. Requiere habilitar swaps en
  Dashboard y gas sponsorship.
  <https://docs.privy.io/wallets/actions/swap/overview>
- **Webhooks** de wallet actions (cada cambio de status), y de depósitos/retiros
  (`wallet.funds_deposited`, etc.), con verificación de firma.
  <https://docs.privy.io/wallets/actions/webhooks>
  <https://docs.privy.io/wallets/gas-and-asset-management/assets/balance-event-webhooks>

### Circle (proveedor Arc)

- **Developer-controlled wallets**: creación y firma programáticas server-side;
  wallet sets; soporta Arc Testnet.
  <https://developers.circle.com/wallets/dev-controlled>
- Transferencias USDC en Arc Testnet con verificación de status.
  <https://developers.circle.com/wallets/dev-controlled/transfer-tokens-across-wallets>
- **Notifications API** (`/v2/notifications/subscriptions`): webhooks con tipos de
  notificación, verificación de firma `X-Circle-Signature` con clave pública ECDSA.
  <https://developers.circle.com/api-reference/w3s/common/get-subscriptions>
- Hueco declarado: no verificamos precios ni disponibilidad GA de Arc mainnet.

### Solana (alternativa por evaluar)

- SendAI **Solana Agent Kit** (open source): 60+ acciones (transferencias, swaps,
  balances) con arquitectura de plugins, integración Vercel AI SDK/LangChain/MCP.
  Es un toolkit de código, no custodia: requiere wallet backing (ej. Privy Solana).
  <https://github.com/sendaifun/solana-agent-kit>
- Privy soporta wallets embebidas Solana nativamente (ver arriba). **Hueco**: no
  verificamos swaps Solana vía Circle (no documentado en lo consultado) ni los
  detalles de fees de Solana en Privy.

### Huecos de información declarados

- Disponibilidad y precios de **Arc mainnet** (Circle): no verificados.
- Pricing real por minuto del Realtime en uso mixto voz+tools: la página oficial da
  tokens, no minutos; cualquier conversión a $/min es estimación.
- Confirmación oficial de Privy sobre límites de **signers concurrentes** o quotas de
  la capa server-side: no consultada (requiere dashboard/contrato).

---

## 3. Capacidades requeridas vs. lo existente

Requisitos del pedido (intake): varias wallets, compras, transferencias,
notificaciones, voz Realtime.

| Requisito | Existe | Falta construir |
| --- | --- | --- |
| Voz Realtime + confirmación segura | ✅ Sólido | Nada estructural |
| Transferencias | ✅ Sólido | Transporte live durable para el pipeline de reconciliación |
| **Varias wallets** | ⚠️ Una wallet por usuario | Concepto de portfolio: N wallets por usuario, wallet activa/selección, agregación de balances |
| **Compras** | ❌ | Swaps (Privy wallet actions ya lo da como primitiva; falta tool + quote/revalidación) |
| **Notificaciones** | ❌ | Webhooks entrantes (Privy/Circle), fan-out al usuario (frontend/SSE/push), unión con conversaciones |
| Multi-red (EVM+Solana) | ⚠️ Solo EVM | Provider Solana (Privy ya soporta wallets Solana) |

---

## 4. Distinción hecha/inferido/idea

- **Hecho**: todo lo citado con archivo:línea y las fuentes oficiales con URL.
- **Inferencia**: que `feat-openai-realtime-poc` está mergeada (basada en ancestry de
  git y nombres de commits, no en un diff completo); que el costo por minuto está
  alrededor de $0.04 (estimación comunitaria, no oficial); que los signers de Privy
  aplican sin fricción al caso multi-wallet (estructura encaja, no probado en vivo).
- **Idea**: todo lo de `03-design-discussion.md`.
