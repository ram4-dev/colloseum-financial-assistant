# Propuesta de plan de desarrollo: asistente financiero Solana-first

Fecha: 2026-10-03. Estado: **PROPUESTA** — no autorizada para implementar.
Base de verificación: este checkout, HEAD local `c64f6e6c7afbf76c1143da1eb75c80dcdee51f32`
("chore: import Nana Wallet at PR #23 head"; según el encargo, corresponde a
`nana-wallet@4d351b872e9c6b56fba0942a2b15fa0954dcaf1c`). Los artefactos de research
(`../financial-assistant-research/`) fueron verificados contra `99ad96b`; la diferencia
se detalla en §3. Entradas: `00-intake.md` de este task, `02-research.md`,
`03-design-discussion.md`, `04-structure-outline.md`, `05-independent-review.md`,
`review-findings.md`.

Decisiones respetadas (ya aprobadas por el usuario, no se re-discuten):
Solana-first; grants acotados ejecutan sin re-confirmar cuando cubren la acción;
todo lo no cubierto exige preview + confirmación explícita; Privy sigue candidato,
condicionado a verificar soporte Solana real y necesidad de adapter.

---

## 1. Propósito y supuestos

**Propósito.** Derivar del outline una secuencia de desarrollo ejecutable sobre ESTE
repo: slices con resultado observable, paths reales confirmados en el checkout,
dependencias, checks aplicables (backend / frontend / integración / E2E / manual) y
gates. No es autorización de implementación ni crea artefactos SDD.

**Supuestos** (cada uno etiquetado):

- S1 (hecho): la base es voz Realtime (LiveKit + OpenAI) con tools preview-only,
  servicio de conversación durable en PostgreSQL y seam `WalletProvider`
  (`src/livekit/create-agent-session.ts`, `src/conversations/service.ts`,
  `src/wallet/provider.ts`). Confirmado en este checkout.
- S2 (hecho): no existe nada de Solana en el repo: 0 matches de
  `solana|base58|spl-token` en `src/` y `docs/`; ninguna dependencia Solana en
  `package.json` ni en `apps/nana-wallet/package.json`. Las únicas menciones son
  `peerDependencies` **opcionales no instaladas** de `@circle-fin/developer-controlled-wallets`
  en `package-lock.json`. Solana-first es trabajo desde cero sobre el seam.
- S3 (hecho): los grants existentes (`signer_grants`,
  `supabase/migrations/20260901000500_embedded_wallets.sql:26`) NO tienen
  `expires_at`, ni columnas de presupuesto/ventana, ni destinatarios allowlistados.
  El encabezado de la migración lo dice explícitamente: "NO expires_at on grants,
  NO local consumed/reserved budget columns, NO local spending cap. Enforcement
  lives only in Privy policy configuration". El único consumidor de grants para
  firmar (`src/wallet/transfer-pipeline.ts:474`, gate fixture-only en :262-264) es
  experimental. El modelo de "grants acotados" del outline es trabajo nuevo, no una
  extensión menor de lo existente.
- S4 (inferencia): como el enforcement actual delega en Privy policy (EVM) y el MVP
  es Solana-first, la vía "Privy policy como enforcement" queda probablemente sin
  base en la cadena objetivo. Esto eleva el ADR del Slice 1 de formalidad a
  decisión crítica (ver §7, D-4).
- S5 (hecho): la política de transferencia live actual es EVM-específica:
  `validateLiveTransferPolicy` (`src/agent/wallet-agent.ts:160-184`) valida
  "non-burn **EVM** addresses". Un slice Solana debe reemplazarla por validación
  de direcciones base58.
- S6 (supuesto de seguridad, a revalidar por proveedor): sin custodia propia ni
  claves de agente expuestas; toda firma pasa por el proveedor.
- S7 (supuesto): red de prueba de registro: **Solana devnet** para todo el plan
  (transferencias y, si llegan, swaps). Cualquier smoke residual en **testnet**
  queda marcado `testnet` y no sustenta conclusiones de fees/finalidad para mainnet.

**Regla de evidencia externa**: ninguna afirmación de soporte, precios o fees de
proveedores (Privy, Circle, SendAI) se toma como vigente. Todo lo externo lleva
REVALIDAR con fuente primaria fechada antes de usarlo para estimar o implementar.

## 2. Evidencia de repo confirmada en este checkout

Hechos verificados por lectura directa (paths y líneas de ESTE checkout):

| Área | Evidencia |
| --- | --- |
| Seam de wallet | `src/wallet/provider.ts`: `interface WalletProvider` con `getBalance/getHistory/previewTransfer/broadcastTransfer/waitForFinality`; `BroadcastOutcome = submitted \| uncertain \| not_dispatched`; `EXPLORER_URLS` solo `sepolia` y `arc-testnet` |
| Proveedores | `src/wallet/{privy-user-provider,circle-arc-provider,wdk-provider,fixture-provider}.ts`; `bindWalletForUser` difiere y devuelve UNA wallet por usuario |
| Pipeline | `src/wallet/transfer-pipeline.ts` (721 líneas): gate fixture-only `live_transport_unavailable` (:262-264), `reconcileUncertain` (:351), claim con `FOR UPDATE` (:456), lectura de grant activo (:474), `ON CONFLICT (idempotency_key) DO NOTHING` (:495) |
| Grants | `signer_grants` (estados `pending/active/revoking/revoked/unavailable`) y `wallet_operations` (estados `claimed…rejected`) en `supabase/migrations/20260901000500_embedded_wallets.sql`; espejo local `src/db/migrations/006_embedded_wallets.sql` |
| Servicios | `src/conversations/service.ts` (1452 líneas, `previewTransfer` ~:609); `src/conversations/financial-task-registry.ts`; `src/livekit/revision-publisher.ts` |
| Voz | `src/livekit/create-agent-session.ts` (Realtime s2s); `src/livekit/realtime-tools/create-realtime-tools.ts`: 5 tools (`get_balance`, `search_contacts`, `send_token`, `confirm_transfer`, `cancel_transfer`); `send_token` preview-only con schema zod `.strict()` que rechaza `to/network/token/wallet/dryRun`; binding Ed25519 (`src/auth/live-binding.ts`, vida máxima 300s) y lease 30s (`src/livekit/room-conversation.ts`) |
| API `/v1` | `src/api/wallets.ts`: `/v1/wallets/current`, `/v1/wallets/sync`, `/v1/wallets/current/permission{,/prepare,/complete,/revoke}`, `/v1/wallets/current/balances`; `src/api/wallet.ts`: `/v1/wallet/{address,balance,history}`; `src/api/conversations.ts`: conversations CRUD, `/v1/live-bindings`, state, decisions, turns; `src/api/voice.ts`: transcribe, speak, room-token. Contrato: `src/contracts/http.ts` |
| Front | `apps/nana-wallet/src/lib/api-types.ts` duplica el contrato a mano (encabezado lo exige en el mismo PR); revisiones por pull con guard monótono + ETag (`src/features/agent/useConversationState.ts`) y push por `RoomEvent.DataReceived` topic `conversation_state_changed` (`src/features/agent/voice/livekit-web-client.ts:173-174`); UI wallet en `src/features/wallet/` (Privy sync, enrollment, recipients) |
| Tests | ~100 archivos: unit (`tests/unit/`, incl. `wallet-grants.test.ts`, `wallet-pipeline-live-guard.test.ts`, `realtime-tools.test.ts`), integration (`tests/integration/`, se **saltean sin `DATABASE_URL`** — patrón `describe.skip`), simulation (1), e2e (5). Front: tests colocalizados con Vitest + Testing Library |
| CI | `.github/workflows/ci.yml`: job backend (levanta `db` pgvector con `compose.yaml`, aplica migraciones, `lint/typecheck/test/eval`) + job frontend (`lint/typecheck/test`). Sin pasos Solana |
| DB | `compose.yaml`: `pgvector/pgvector:0.8.1-pg16` |
| Docs | Los runbooks citados en AGENTS.md existen; **cero menciones de Solana en `docs/`** |

## 3. Diferencias entre outline y checkout

1. **Ruta del pipeline** (hecho): `review-findings.md` y partes de `02-research.md`
   citan `src/conversations/transfer-pipeline.ts`; **no existe**. La ruta real es
   `src/wallet/transfer-pipeline.ts` (la segunda pasada del review independiente ya
   la citaba correctamente).
2. **Drift de líneas** (hecho): el banner fixture-only citado en `:195-198` está hoy
   en `:249-264` (`class WalletTransferPipeline` :256). La lectura de grant en
   `:474` coincide exactamente. Tratar las citas de línea del research como
   aproximadas y verificar siempre contra este checkout.
3. **`revision-publisher`** (hecho): vive en `src/livekit/`, no en
   `src/conversations/` como podría inferirse de `02-research.md` §1.1.
4. **Modelo de grants** (hecho, aguuda el outline): el outline trata `signer_grants`
   como "esqueleto de permisos" con "cap por transferencia y ventana rolling". En la
   migración real NO hay cap, ventana ni expiración — el comentario dice que el
   enforcement vive solo en Privy policy. El Slice 1 construye el modelo acotado
   desde cero; nada de lo aprobado está ya implementado.
5. **Procedencia del import** (no verificable localmente): este repo es un import
   aplastado (`c64f6e6`, PR #23 head = `nana-wallet@4d351b8…` según el encargo); los
   artefactos verificaron contra `99ad96b`. No puedo comprobar aquí la relación entre
   ambos hashes (no hay historial upstream en este checkout), pero toda la estructura
   citada por el outline está presente y coherente salvo los puntos 1-4.
6. **Confirmaciones que sostienen el outline** (hechos): cero Solana; cero
   notificaciones/webhooks/swap; una wallet por usuario (`/v1/wallets/current`
   singular, `bindWalletForUser`); `send_token` preview-only; transporte live del
   pipeline fixture-only (el camino live usa proveedores directos sin reconciliación
   F6).

## 4. Slices propuestos

Orden y alcance alineados con `04-structure-outline.md` (no lo reemplaza: lo baja a
este checkout). Cada slice = resultado observable end-to-end. Bloqueos duros: el
slice no empieza sin su dependencia.

Checklist transversal (de outline §3, aplica a todo slice que toque dinero):
autorización server-side en el momento de ejecutar; límite con ventana; expiración y
revocación con degradación cerrada a preview+confirm; auditoría de concesión/uso/rechazo;
idempotencia por intención contra constraint único de DB; preview+confirmación fuera de
autorización; todo execution produce evento observable.

### Slice 1 — Núcleo de autorización delegada (server-side, agnóstico de cadena)

- **Resultado observable**: un grant acotado (acción, wallet, importe máximo, ventana,
  expiración, destinatarios cuando aplique) creado por canal autenticado permite
  exactamente la acción acotada; un segundo uso fuera de límite, expirado o revocado
  es rechazado, degrada a preview+confirm y queda auditado.
- **Paths probables**: nueva migración `supabase/migrations/…_delegated_grants.sql` +
  espejo `src/db/migrations/` (el modelo nuevo no debe mutar retroactivamente la
  semántica de `signer_grants` experimental); motor de validación nuevo bajo
  `src/wallet/` (p. ej. `src/wallet/grants/`); integración con la lectura de grant de
  `src/wallet/transfer-pipeline.ts:474`; endpoints de concesión/revocación siguiendo el
  patrón de `src/api/wallets.ts` (permission prepare/complete/revoke); contrato en
  `src/contracts/http.ts` + espejo `apps/nana-wallet/src/lib/api-types.ts` en el mismo PR.
  **ADR**: elección del mecanismo de grants/session key (ver §7 D-4) como criterio de
  salida.
- **Dependencias**: ninguna externa. Validadores por cadena enchufables; el validador
  Solana (base58) se enchufa en Slice 2.
- **Checks**: backend unit (límite, expiración, revocación, destino, degradación —
  extender patrón de `tests/unit/wallet-grants.test.ts`); integración contra DB real
  (`tests/integration/`, patrón `DATABASE_URL`): concesión firmada → uso dentro de
  límite → rechazo → revocación intermedia; E2E por API autenticada con idempotencia
  verificada contra la constraint única, no contadores en memoria; frontend: UI mínima
  de concesión/revocación y listado (canal autenticado, nunca voz); manual: revocación
  surte efecto en la siguiente ejecución.

### Slice 2 — Provider Solana (devnet como red de registro)

- **Resultado observable**: balance leído y una transferencia de prueba en **Solana
  devnet** con preview → confirmación → broadcast → finalidad, `uncertain` manejado
  (bloqueo + reconciliación), todo por el seam `WalletProvider`.
- **Paths probables**: nuevo `src/wallet/solana-provider.ts` implementando
  `src/wallet/provider.ts`; alta del network+explorer en `EXPLORER_URLS`
  (`provider.ts:26-31`); fixture determinista para CI (`tests/unit/wallet-provider-contract.test.ts`
  ya es el contrato a satisfacer); dependencia cliente Solana (REVALIDAR cuál:
  `@solana/web3.js` vs `@solana/kit` — decisión con evidencia fechada, no por defecto).
- **Dependencias**: Slice 1 (formato de grant/validador). **Gate duro de salida de
  Slice 1 (G3)**: proveedor seleccionado con soporte Solana devnet verificado con
  fuente primaria fechada (Privy es candidato, no decisión: condicionado a ese gate;
  si falla, evaluar alternativas antes de empezar). Register límites de fees/finalidad
  observados antes de empezar.
- **Checks**: unit (parseo base58, montos/decimales, mapeo de outcomes de broadcast y
  finalidad, timeout); integración: provider contra devnet marcada para correr con
  credenciales de prueba (fixture determinista + smoke en CI); E2E: transferencia
  completa en devnet con preview+confirm; manual: hash visible en explorador devnet.
  Residual `testnet`: solo si una restricción del proveedor obliga (p. ej. faucet o
  activos solo en testnet) — etiquetado explícito y sin valor de evidencia para mainnet.
- **Nota de alcance** (de review F2, aplicada): toda conclusión de fees/finalidad de
  este slice es evidencia de devnet únicamente.

### Slice 3 — Ejecución bajo autorización sin re-confirmación

- **Resultado observable**: instrucción cubierta por grant vigente se ejecuta de punta
  a punta **sin pedir confirmación**, con aviso visible; la misma instrucción sin
  grant vigente produce preview+confirmación.
- **Paths probables**: `src/conversations/service.ts` (decisión confirmar vs ejecutar
  en el flujo de `previewTransfer`/`resolveDecision`); tools `confirm_transfer` en
  `src/livekit/realtime-tools/create-realtime-tools.ts`; consumo de límite y auditoría
  en el motor del Slice 1; aviso vía `revision-publisher` (evento interno suficiente
  para este slice; el canal completo es Slice 5).
- **Dependencias**: Slices 1-2.
- **Checks**: unit (cubierto/no cubierto, degradación, consumo acumulado, cap
  concurrente); integración con idempotencia a nivel DB (review F4); E2E de dos turnos
  (autorizado sin confirmación / fuera de autorización con preview+confirm) que
  **afirma explícitamente el aviso visible** (review F3); manual: aviso observable
  tras ejecución sin confirmación. Backend obligatorio; evals del agente si se toca
  instrucción de tools.

### Slice 4 — Confirmación explícita fuera de autorización (voz)

- **Resultado observable**: instrucción fuera de grants → la voz narra preview (monto,
  destino, comisión) y solo ejecuta tras confirmación explícita; cancelación y
  `stale` funcionan; todo auditado.
- **Paths probables**: reuso directo del patrón existente — `send_token` preview-only
  con `.strict()` (`create-realtime-tools.ts:86-103`), `stale_preview`, cancel;
  reemplazo del validador EVM de `validateLiveTransferPolicy`
  (`src/agent/wallet-agent.ts:160-184`) por validación Solana (base58) con política
  live equivalente; copy de clarificación existente.
- **Dependencias**: Slices 1-3.
- **Checks**: unit de schema estricto (sin dirección libre, sin flags) y
  clasificación cubierto/no cubierto; integración preview→confirm→broadcast→finality,
  cancel, preview vencido; E2E de sala de voz con confirmación y cancelación habladas;
  manual: ninguna tool acepta destino libre por voz. Tocar el agente exige
  `npm run eval` (regla del repo).

### Slice 5 — Notificaciones observables

- **Resultado observable**: cada ejecución (autorizada o confirmada) y cada evento
  entrante relevante genera un aviso visible en la app sin refrescar.
- **Paths probables**: endpoint nuevo de webhooks firmados del proveedor (`src/api/webhooks.ts`
  nuevo, verificación de firma + dedupe idempotente); tabla de eventos (migración
  nueva); fan-out por `revision-publisher` existente al topic
  `conversation_state_changed` que el front ya consume
  (`useConversationState.ts` + `livekit-web-client.ts:173`) con polling como red; si el
  proveedor no cubre el evento en Solana (REVALIDAR), polling de reconciliación como
  fuente primaria.
- **Dependencias**: Slice 2 (eventos de la red); paralelizable con Slice 3 con
  contrato de eventos fijado.
- **Checks**: unit de firma y dedupe; integración webhook → evento → revisión, y
  reintento del proveedor no duplica; E2E: la ejecución del Slice 3 produce aviso
  visible end-to-end; manual: webhook perdido → polling genera el aviso. Frontend
  obligatorio (componente de avisos sobre el flujo de revisiones existente).

### Slice 6 — Multi-wallet embebida y portfolio (condicional)

- **Resultado observable**: el usuario ve patrimonio agregado de sus N wallets
  embebidas y las operaciones declaran sobre qué wallet operan (wallet activa por
  conversación, confirmada al inicio).
- **Paths probables**: entidad wallet por usuario (migración nueva; hoy
  `/v1/wallets/current` es singular y `bindWalletForUser` devuelve una); agregación
  sobre `get_balance` (`src/wallet/balances.ts`); `get_portfolio` + `get_balance(walletId)`
  como tools; grants referencian walletId (diseño del Slice 1 ya lo contempla).
- **Dependencias**: decisión D-2 (clases de wallet) y Slices 1-2. Solo corre si el
  MVP incluye N wallets embebidas.
- **Checks**: unit de agregación y ambigüedad; integración: grant de wallet A no
  autoriza sobre B; E2E de portfolio por voz; manual: cambio de wallet activa entre
  conversaciones. Frontend: UI de wallets/portfolio.

### Slice 7 — Compras/swaps en Solana (condicional, primera en recortarse)

- **Resultado observable**: compra acotada con quote → preview narrado → confirmación
  explícita → ejecución → finalidad → aviso; quote vencido degrada a re-cotización
  (`stale_quote`, nuevo estado análogo a `stale_preview`).
- **Paths probables**: quote/execute del proveedor elegido sobre Solana (**REVALIDAR
  soporte con fuente primaria fechada antes de estimar**); clon del patrón
  send_token; límite de compra por grant.
- **Dependencias**: Slices 1-5; soporte del proveedor verificado.
- **Checks**: análogos a Slice 4 + revalidación de quote vencido y slippage; E2E de
  compra en **devnet** (corrige el residuo "testnet" del outline — ver §3.1/F1-R del
  review); manual en explorador devnet.

## 5. Gates

| Gate | Qué decide | Cuándo |
| --- | --- | --- |
| G0 | Aprobación de esta propuesta (contenido y orden de slices) | Ahora — humana |
| G1 | Clases de wallet del MVP (§7 D-2) — **primera decisión humana recomendada** | Antes de Slice 1 |
| G2 | Ratificación del canal autenticado de concesión (D-3) | Antes de Slice 1 |
| G2b | Ratificación del canal de notificaciones (D-5) | Antes de Slice 5 |
| G3 | ADR de mecanismo de grants/session key (D-4) — se decide con evidencia dentro del `design` de Slice 1 | Dentro de Slice 1 |
| G3b | Cardinalidad del grant (D-7: una ejecución vs varias dentro de cap/ventana) — decisión humana abierta | Antes de diseñar/implementar Slice 1 |
| G1b | Alcance/count de wallets (D-6: una vs N wallets embebidas) — condiciona el modelo de datos | Antes de Slice 1 |
| G4 | Soporte Solana devnet del proveedor verificado con fuente primaria fechada | Salida de Slice 1, antes de Slice 2 |
| G5 | Validación por PR: backend `lint/typecheck/test/eval` + front `lint/typecheck/test` en verde (CI ya lo impone) | Cada PR |

Los tres gates de review del outline ya superados (revisión independiente PASS,
red decidida) no se re-abren. Ninguna decisión pendiente se cierra en este documento.

## 6. Distingo de epistemic status del plan

- **Hechos**: todo lo de §2 y §3 (verificado en este checkout).
- **Inferencias**: S4 (Privy policy como enforcement queda sin base con Solana-first);
  que el orden 1→2→3→4 del outline sigue siendo el mínimo demostrable con los paths
  reales; que la UI de concesión puede apoyarse en el patrón permission
  prepare/complete/revoke existente.
- **Recomendaciones/propuestas**: todo lo de §7 y la selección de paths de §4 (los
  paths son "probables": el diseño SDD puede ajustarlos).

## 7. Defaults propuestos para las decisiones humanas pendientes

Todas son **PROPUESTAS** con tradeoffs; ninguna reemplaza la decisión del usuario.

**D-2. Clases de wallet (recomendación para la primera decisión humana).**
*Propuesta*: **wallets embebidas** del proveedor, una por usuario en el MVP;
externas de solo lectura como extensión opcional post-MVP; externas operables
fuera del MVP.

- Tradeoffs: embebidas encajan 1:1 con la ejecución sin re-confirmación (el server
  firma vía proveedor, que es la base de todo el plan de grants) y minimizan
  superficie; el costo es depender de la custodia delegada del proveedor (TEE, según
  su documentación — REVALIDAR para Solana). Externas solo lectura aportan portfolio
  sin riesgo de firma pero no ejecutan; baratas de agregar después porque el modelo
  de grants no cambia. Externas operables contradicen la política aprobada (exigen
  firma del usuario en cada acción o un mecanismo de delegación on-chain no
  verificado) — excluidas.

**D-3. Canal autenticado para conceder grants.**
*Propuesta*: endpoint HTTP protegido por el `RequestIdentityProvider` configurado en
el server (`src/server.ts:118-150`): bearer Privy en modo Privy
(`PrivyIdentityProvider`, `IDENTITY_PROVIDER=privy`) o `DemoIdentityProvider` en demo
desarrollo; la concesión es un acto explícito desde la UI autenticada (el endpoint
resuelve el usuario vía `dependencies.resolveUserId`, patrón de
`src/api/wallets.ts`); nunca por voz.

- Aclaración de alcance (hecho): el binding Ed25519 de voz (`src/auth/live-binding.ts`)
  autentica la **sesión de sala LiveKit**, no peticiones HTTP; NO autoriza concesiones.
  Una concesión de grant pasa por la identidad HTTP del endpoint, no por el binding
  de voz.
- Demo caveat (hecho): `DemoIdentityProvider` (`src/auth/identity.ts`) resuelve a un
  userId fijo sin autenticación real; es válido solo para desarrollo. Si el grant se
  usa en demo, la concesión queda ligada a ese sentinel user y no demuestra el canal
  autenticado de producción.

- Tradeoffs: reusar la app es lo más barato y auditable (el patrón
  `/v1/wallets/current/permission/prepare|complete|revoke` ya existe como referencia);
  una firma criptográfica adicional del cliente aporta no-repudio pero agrega
  ceremonia y no parece necesaria mientras la concesión pase por sesión autenticada
  - registro de auditoría. Si el usuario exige no-repudio fuerte, el costo se paga
  en Slice 1 sin reordenar slices.

**D-5. Canal de notificaciones.**
*Propuesta*: in-app sobre el flujo de revisiones existente (push de datos por la
sala LiveKit + polling de reconciliación), sin push nativo en el MVP.

- Tradeoffs: es la superficie que ya funciona end-to-end (front consume
  `conversation_state_changed` hoy) — costo marginal bajo; límite: el aviso solo
  llega si la app está abierta o el usuario entra. Push nativo (FCM/APNs) es trabajo
  de plataforma (tokens, permisos, backend de dispatch) que no cambia los slices
  1-4 y puede sumarse después; para el alcance hackathon, in-app basta.

**D-6. Alcance multi-wallet.**
*Propuesta*: MVP con **una** wallet embebida activa por usuario (es el estado actual
del modelo de datos); Slice 6 (N wallets + portfolio) queda condicional y se activa
solo si el tiempo de hackathon lo permite después de Slice 5.

- Tradeoffs: activar N wallets desde el día 1 complica grants, UI y clarificación
  por voz ("usá la otra wallet" es ambiguo) antes de que la política delegada esté
  demostrada; dejarlo condicional mantiene el mínimo demostrable en Slices 1-4.

**D-7. Cardinalidad del grant — DECISIÓN ABIERTA, sin propuesta que la cierre.**
El outline y las aprobaciones registradas NO determinan si un grant acotado autoriza
**una sola ejecución** (se consume al usar) o **varias ejecuciones cubiertas**
dentro de su cap y ventana hasta expiración. La evidencia es contradictoria:
Slice 1 del outline dice "permite exactamente una acción acotada", pero su Slice 3
habla de "consumo de límite acumulado" (implica múltiples). Se marca como decisión
abierta del usuario, **gate ANTES de diseñar/implementar Slice 1 (G3b)**: la
cardinalidad determina la representación del grant en DB (consumo único vs
contabilidad acumulada) y el mecanismo de consumo que el esquema y el ADR de Slice 1
dejan modelados; retrasarla obligaría a redisear migración, motor y auditoría. No se
resuelve por defecto en este documento.

- Tradeoffs de referencia (sin decidir): una sola ejecución minimiza el daño máximo
  por concesión y simplifica la auditoría; varias dentro de cap/ventana es lo que
  usualmente se entiende por "permiso" (ej. "hasta 50 USDC por mes") y reduce fricción,
  pero exige contabilidad de consumo acumulado confiable y conciliada con la DB.

**D-4. Mecanismo de grant/session-key (se decide con ADR dentro de Slice 1, esta es
la inclinación inicial).**
*Propuesta*: motor de grants **propio server-side** en PostgreSQL (tabla nueva con
acción, wallet, cap, ventana, expiración, destinatarios, estado, auditoría),
validado en el momento de ejecutar; sin depender de primitivas del proveedor ni de
mecanismos on-chain para el MVP.

- Tradeoffs: (a) propio — código y responsabilidad propias, pero auditable,
  agnóstico de cadena, y no bloquea el G4 si el proveedor cambia; dado que el
  enforcement actual ya delegaba en Privy policy solo-EVM (S3/S4), propio es la vía
  que no hereda esa deuda; (b) primitiva del proveedor — menos código si existe
  soporte Solana real, pero REVALIDAR y acopla la política de seguridad a un vendor;
  (c) primitiva on-chain tipo session keys — la más "nativa", pero requiere
  verificación de estándares disponibles en Solana y añade riesgo de hackathon;
  REVALIDAR antes de descartarla o elegirla. El ADR del Slice 1 cierra esto con
  evidencia; esta propuesta solo fija el default de partida.

## 8. Recomendación para la primera decisión humana

Decidir primero **D-2 (clases de wallet: propuesta — embebidas)** y con ella **D-6
(propuesta — una wallet en MVP)**, porque delimitan el modelo wallet/grant: los
grants referencian wallet y la cardinalidad de wallets condiciona el esquema de
datos de Slice 1 y define si Slice 6 corre.

Antes de iniciar el change SDD de Slice 1 quedan también resueltas: **D-3 (canal
autenticado de concesión, G2)** y **D-7 (cardinalidad del grant: una ejecución vs
varias dentro de cap/ventana, G3b — determina la representación y el consumo de
grants en DB)**. Las cuatro siguen abiertas: este documento no las decide.

**D-4** (mecanismo de grants/session key) no es requisito de entrada: se resuelve
con evidencia en el ADR del `design` de Slice 1 (G3). **D-5** (canal de
notificaciones) no bloquea Slice 1: puede decidirse hasta antes de Slice 5 (G2b).
El gate G4 (soporte Solana devnet del proveedor) se verifica con fuente primaria
fechada a la salida de Slice 1, antes de Slice 2.

## 9. Paso preciso a SDD una vez aprobada la propuesta

1. El usuario aprueba esta propuesta (G0). Antes de iniciar el change SDD de
   Slice 1 quedan resueltas: **D-2 (clases de wallet, G1)**, **D-3 (canal
   autenticado de concesión, G2)**, **D-6 (alcance/count de wallets, G1b: una vs N
   wallets — condiciona el modelo de datos)** y **D-7 (cardinalidad del grant,
   G3b: una ejecución vs varias dentro de cap/ventana — determina la
   representación y el consumo de grants en DB)**. Ninguna de las cuatro la decide
   este documento; todas siguen abiertas.
   Si D-6 cambia el default propuesto de una wallet embebida, se ajusta el plan y
   el esquema de datos (migraciones, endpoints, UI) ANTES de iniciar Slice 1; el
   orden de slices no cambia, solo el alcance de Slice 6.
   **D-4** no es requisito de entrada: se decide con evidencia en el ADR del
   `design` de Slice 1 (G3). **D-5** (canal de notificaciones) no bloquea Slice 1:
   puede ratificarse hasta antes de Slice 5 (G2b).
2. Crear el change SDD en `openspec/changes/<change>/` siguiendo el flujo del repo
   (`proposal → spec → design → tasks → apply → verify → archive`), con
   `openspec/config.yaml` como contexto raíz. **Un change por slice** (primero
   Slice 1); no un mega-change: cada slice tiene resultado observable y checks
   propios, y mantiene los PRs revisables.
3. El ADR del mecanismo de grants (D-4) se escribe dentro del `design` del change de
   Slice 1, con las tres alternativas de §7-D4 y la evidencia REVALIDAR adjunta.
4. Cada `tasks` incluye la checklist transversal (§4) y los checks del slice;
   `apply` trabaja con Strict TDD (el repo tiene suite Vitest y CI que impone
   backend+frontend en verde); `verify` contrasta contra la spec y las reglas de
   AGENTS.md (separación front/back, preview+confirm intacto, sin secretos).
5. Cambios al contrato HTTP (`src/contracts/http.ts` +
   `apps/nana-wallet/src/lib/api-types.ts`) siempre en el mismo PR, por la regla
   dura del repo.
6. Red de pruebas: devnet como red de registro; residual `testnet` solo etiquetado;
   ninguna conclusión de fees/finalidad se presenta como mainnet-ready.

---

*Nada de este documento autoriza modificar código, tests, configuración ni
infraestructura. No se ejecutaron transacciones ni se leyeron secretos. Las
afirmaciones sobre proveedores externos quedan REVALIDAR con fuente primaria
fechada antes de cualquier estimación o implementación.*
