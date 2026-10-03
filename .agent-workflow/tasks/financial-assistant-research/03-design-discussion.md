# Design discussion: asistente financiero con voz sobre varias wallets

Fecha: redactado 2026-10-03 (el encargo original citaba 2026-02-20; los archivos de
este paquete fueron generados el 2026-10-03). Este documento es brainstorm: separa
hechos (ver `02-research.md`),
inferencias e ideas. No es un plan de implementación ni un outline de código.

---

## 1. Punto de partida: qué exige realmente el caso de uso

El pedido combina tres demandas de distinta naturaleza:

1. **Conversación** (voz Realtime): efímera, humana, tolerante a errores y
   interrupciones.
2. **Transacciones** (transferencias, compras): durables, irreversibles, intolerantes
   a ambigüedad.
3. **Observación** (notificaciones, eventos on-chain): asíncrona, de larga duración,
   independiente de que el usuario esté hablando.

El repo ya toma la decisión arquitectónica correcta y hay que conservarla: **la sala
de voz es efímera, el dinero es durable en PostgreSQL**. El pendingTransfer, las
revisiones y los receipts no viven en la sesión Realtime. Cualquier diseño que ponga
estado financiero dentro de la sala rompe la recuperación ante caídas.

### La pregunta de separación conversación/ejecución

¿Hace falta separar "conversación" de "ejecución durable" como sistemas distintos?

- **Versión mínima**: no. El diseño actual ya separa: el modelo habla y llama tools,
  pero toda mutación pasa por `WalletConversationService` que persiste, reclama y
  reconcilia. El modelo nunca toca la wallet directamente.
- **Versión completa**: sí, cuando aparecen **tareas que sobreviven a la sesión**:
  límites ("comprá X si baja de $Y"), suscripciones ("avisame si entra un depósito"),
  o ejecución delegada con reglas. Esas no pueden vivir en el loop de la conversación;
  necesitan un executor con estado propio (jobs + eventos), del que la voz es solo una
  interfaz más.

**Inferencia**: el corte natural es por *durabilidad de la intención*. Una intención
que se resuelve en el turno (transferir ahora) vive en la conversación. Una intención
que vive más que el turno (compra condicionada, alerta) vive en un registro durable
con su propio ciclo de vida.

---

## 2. Tres productos posibles

### Opción A — Copiloto que propone y pide confirmación

El asistente informa (patrimonio agregado, precios, estado de wallets), **prepara**
operaciones y siempre pide confirmación explícita. Nada se ejecuta solo.

- **Costo relativo**: bajo. Es casi exactamente el sistema actual. Falta: vista
  multi-wallet (lectura), herramientas de solo lectura nuevas, y swaps como
  preview+confirm (reutilizando el patrón send_token).
- **Riesgos**: menores; los existentes ya están mitigados (preview-only, stale_preview,
  uncertain, revalidación de recipient).
- **Qué habilita**: demo creíble ya; confianza del usuario; base para B y C.

### Opción B — Asistente con reglas acotadas

El usuario otorga **permisos delimitados** (por wallet, acción, importe, plazo) y el
asistente ejecuta dentro de ellos sin confirmar cada vez: "podés mover hasta 50 USDC
entre mis dos wallets sin preguntarme". Todo fuera de la regla vuelve a confirmación.

- **Costo relativo**: medio. Existe el esqueleto de permisos (`signer_grants` con
  allowlist, cap por transferencia, ventana rolling) pero es fixture-only y no tiene
  UI de concesión ni expiración ni revocación desde la app.
- **Riesgos concretos**:
  - La concesión debe ser un acto explícito, autenticado y auditable — **nunca por
    voz** ("sí, confío" hablado no es autenticación). El binding Ed25519 actual
    autentica la sesión; la concesión de permisos debe ir por un canal con pruebas
    (firma del cliente, webhook firmado del proveedor).
  - Reglas compuestas = superficie de malentendidos: "muéveme lo que sobre" no es una
    regla; necesita cuantificación explícita en la estructura del permiso.
  - Reversibilidad: una transferencia errónea dentro de una regla no se puede
    deshacer; solo se puede limitar el daño (caps, ventanas, destinos allowlistados).

### Opción C — Agente con ejecución delegada

El asistente opera con autonomía amplia: compra, rebalancea, responde a eventos.
El usuario define objetivos y el agente decide.

- **Costo relativo**: alto. Requiere B completo + cotizaciones revalidadas en el
  momento de ejecutar + idempotencia por intención + trazabilidad completa + un
  executor durable.
- **Riesgos**: además de los de B, errores de juicio del modelo con dinero real,
  cascadas (compra fallida → rebalance erróneo), y el problema de la finalidad
  incierta amplificado (una intención "compra si X" con broadcast incierto es
  indistinguible de dos ejecuciones para un agente sin estado de reconciliation
  robusto).
- **Recomendación**: no es el MVP. Es el horizonte hacia el que evolucionar si B
  demuestra que los permisos delimitados son entendibles y auditables.

**Comparación relativa** (complejidad de construirlo sobre el repo actual):

| Dimensión | A Copiloto | B Reglas | C Delegado |
| --- | --- | --- | --- |
| Voz + confirmación | ✅ ya | ✅ ya | ✅ ya |
| Multi-wallet lectura | Nueva, simple | Nueva, simple | Nueva, simple |
| Swaps con confirmación | Nueva, media (Privy wallet actions) | Media | Alta (quotes + slippage + revalidación) |
| Permisos por wallet/importe | — | Alta (concesión explícita, expiración, revocación, auditoría) | Alta + executor durable |
| Tareas sobrevivientes a la sesión | — | Parcial (reglas = tareas largas) | Completa (jobs, eventos, reconciliación) |
| Notificaciones | — | Necesarias para B (avisos de ejecución) | Críticas |

---

## 3. Notificaciones y eventos on-chain: diseño de la pieza faltante

Hoy nada escucha la blockchain ni al proveedor. La pieza natural:

1. **Ingesta**: webhooks firmados del proveedor (Privy `wallet actions` y
   `funds_deposited`; Circle Notifications API) hacia un endpoint de la API con
   verificación de firma. Polling como fallback para cadenas/proveedores sin
   cobertura (y para reconciliación de estados `uncertain` — el repo ya tiene
   `reconcileUncertain` que consume exactamente este flujo).
2. **Normalización**: una tabla de eventos (usuario, wallet, tipo, payload hash,
   status, dedupe por id de evento). Idempotente: los proveedores reintentan.
3. **Fan-out**: según canal disponible — invalidación de revisión al frontend (el
   repo ya tiene `revision-publisher`), mensaje a la conversación (para que Nani lo
   narre en la próxima sesión), o push nativo más adelante.
4. **Regla de seguridad**: un evento nunca ejecuta dinero por sí solo; dispara
   *información* o una *regla pre-autorizada*. El que decide es el executor con
   permisos, no el evento.

**Costo relativo**: medio-bajo para A (solo lectura de eventos → notificar), medio
para B (los avisos de ejecución dentro de reglas dependen de esto).

---

## 4. Varias wallets: el modelado mínimo

**Idea** (no implementada hoy): el usuario posee N wallets — una embebida Privy (o
más de una, Privy permite múltiples wallets por usuario) y, más adelante, wallets
externas conectadas por dirección (solo lectura). El diseño mínimo:

- Entidad `wallet` por usuario con: id, proveedor, red(es), dirección, etiqueta,
  estado (activa/inactiva).
- **Wallet activa por conversación**, no global: la sesión de voz declara sobre qué
  wallet opera; por defecto la última usada. Coherente con la restricción actual de
  network/token fijos por sesión — generalizarla a "wallet fija por sesión, elegible
  al inicio" es el menor cambio con la mayor ganancia de seguridad (el modelo nunca
  elige destino de fondos a mitad de la conversación).
- Agregación de balances como **lectura** (`get_balance` iterando wallets del
  usuario); operaciones de movimiento entre wallets propias como transferencias
  normales con el destinatario allowlistado por el propio usuario.
- **Riesgo específico de voz**: "usá la otra wallet" es ambiguo con 2+ wallets. La
  mitigación barata es narrar y confirmar la wallet por etiqueta antes de cualquier
  preview ("¿sobre tu wallet Principal?"), igual que ya se hace con contactos
  ambiguos. La costosa es selección libre por voz: no recomendada para el MVP.

---

## 5. Compras (swaps): lo mínimo defendible

- Primitiva disponible: Privy swap = quote → execute → wallet action con estados;
  Circle tiene swaps en dev-controlled wallets para Arc. Ambos exigen
  revalidación: el precio de un quote expira, así que el patrón preview/confirm del
  repo se mapea directo (quote = preview, execute = broadcast, status = finality).
- **Reglas mínimas**: monto máximo por compra, re-cotizar al confirmar si el quote
  supera cierta antigüedad o desvío de slippage, y fallar cerrado ante quote vencido
  (el repo ya tiene el concepto `stale_preview` — extenderlo a `stale_quote`).
- **Hueco a cerrar con evidencia**: fees y cobertura exacta de swaps de Privy por
  red (incluida Solana) y disponibilidad de Arc mainnet.

---

## 6. Permisos, idempotencia, recuperación: qué exige cada opción

| Propiedad | A Copiloto | B Reglas | C Delegado |
| --- | --- | --- | --- |
| Confirmación explícita por operación | Siempre | Fuera de reglas | Por objetivos/reglas |
| Permiso por wallet/acción/importe/plazo | No necesario | Núcleo del producto | Núcleo + gestión de objetivos |
| Revalidación de cotización | En confirmación | En cada ejecución bajo regla | Continua |
| Idempotencia | `previewId` (ya existe) | `previewId` + `ruleExecutionId` | + intenciones condicionales con estados propios |
| Recuperación tras caída | Ya existe (durable en PG + drain) | Igual + reconciliación de reglas activas | + reconciliación de objetivos |
| Trazabilidad | Historial de conversación (ya) | + registro de concesiones y ejecuciones | + cadena de decisiones del agente |
| Voz como autenticación | No (binding Ed25519 ya) | **No** (concesión por canal con pruebas) | **No** |

---

## 7. Propuesta de MVP

**MVP = Opción A + eventos + multi-wallet de lectura.** "Nani ve todas tus wallets,
te dice tu patrimonio, prepara transferencias y compras con confirmación, y te avisa
cuando entra o sale dinero."

- **Se reutiliza** (~80% del flujo financiero): binding de voz, tools preview-only,
  `WalletConversationService` con claim/reconciliación, revisiones al frontend,
  provider seam `WalletProvider`.
- **Se adapta**:
  - `bindWalletForUser` → `listWalletsForUser` + wallet activa por sesión.
  - `get_balance` → `get_portfolio` (agregado) + `get_balance(walletId)`.
  - Patron send_token clonado a `buy_token` (quote → confirm → execute → finality).
- **Se construye**:
  - Endpoint de webhooks firmados (Privy y/o Circle) con dedupe.
  - Narración de eventos en la sesión (cuando el usuario conecta: "entraron 100 USDC
    a tu wallet Principal").
  - Tabla de wallets por usuario y su UI mínima.
- **Queda explícitamente fuera**: reglas automáticas (B), swaps Solana, wallets
  externas operables (solo lectura), Arc mainnet.
- **Dependencias**: credenciales Privy ya en uso; swaps habilitados en Dashboard
  Privy + gas sponsorship; URL pública para webhooks.

### Flujo completo del MVP con sus fallos posibles

"Comprá 100 USDC con ETH de mi wallet Principal":

1. Voz → Realtime transcribe → tool `search_assets`/contexto de wallet activa.
   *Fallo*: wallet ambigua → pregunta de clarificación (patrón existente).
2. Tool `buy_token` (preview): pide quote a Privy con monto/par.
   *Fallo*: par no soportado / quote service caído → error tipado narrado.
3. Preview persistido con `quoteId` + expiración; Nani narra: "comprás 100 USDC por
   ~0.037 ETH, comisión X. ¿Confirmás?"
   *Fallo*: quote vence → `stale_quote` al confirmar → re-cotizar y re-confirmar.
4. Usuario confirma → `confirm_transfer`-equivalente → claim atómico → execute.
   *Fallo*: broadcast incierto → estado `uncertain` + bloqueo de nuevas acciones +
   reconciliación (existente).
5. `waitForFinality` → webhook del proveedor refuerza el estado final.
   *Fallo*: receipt inválido → `transaction_receipt_invalid` (existente).
6. Evento de wallet action confirmada → revisión al frontend + narración.
   *Fallo*: webhook perdido → polling de reconciliación como red de seguridad.

Complejidad relativa estimada: **media**. Ninguna pieza es de investigación abierta;
todas existen como patrón en el repo o como primitiva documentada del proveedor. La
incertidumbre principal es operativa (Dashboard Privy, webhooks en entorno local) y
de contrato de fees.

### Qué NO hace falta construir (y suele sobre-diseñarse)

- Un executor de jobs general para el MVP: `FinancialTaskRegistry` + PostgreSQL
  alcanzan; un scheduler completo solo se justifica al llegar a B.
- Selección libre de red/token por voz: la restricción actual es una **decisión de
  seguridad**, no una limitación técnica pendiente.
- Custodia propia o claves del agente: los signers de Privy con políticas ya cubren
  la ejecución server-side sin que el server vea claves.

---

## 8. Decisiones aprobadas y propuestas pendientes

Aprobadas por el usuario (2026-10-03):

1. **Autonomía:** se permiten reglas delegadas acotadas. Una acción cubierta por
   autorización previa puede ejecutarse sin pedir confirmación otra vez. Toda acción
   fuera de esa autorización requiere preview y confirmación explícita. La concesión
   y revocación deben pasar por un canal autenticado, nunca solo por voz.
2. **Matiz de confirmación:** una transacción **pedida inline por el usuario** pasa
   **siempre** por preview más doble confirmación. Solo las acciones ya cubiertas
   por una regla delegada corren sin nueva confirmación. Lo no cubierto exige
   confirmación completa. No se crean permisos solo por voz.
3. **Red objetivo: Solana-first (decidida).** El usuario ordenó pivote del repo a
   Solana porque Colloseum es la hackathon. El código EVM existente queda como
   referencia de patrones (preview/confirm, idempotencia, reconciliación, seam
   `WalletProvider`); EVM y multichain pueden ser expansión futura, no MVP.

Pendientes (decisiones técnicas/de producto aún abiertas):

1. **Clases de wallet a integrar (pendiente):** embebidas del propio usuario,
   externas de solo lectura, externas operables — a comparar como decisión técnica;
   el outline no las asume.
2. **Mecanismo de session key / grant (propuesta por verificar):** limitar cada
   regla por wallet, acción, monto y plazo, con destinatarios cuando aplique. El
   repo no demuestra session keys listas para producción; elegir y verificar el
   mecanismo antes de tratarlo como dependencia.
3. **Canal de avisos (pendiente):** las revisiones in-app pueden ser la primera
   superficie porque ya hay publicación de revisiones. Cada ejecución delegada debe
   dejar aviso visible; falta decidir si basta o si el MVP exige push.

---

## 9. Estado del design

Aprobado por el usuario: reglas delegadas acotadas (ejecución sin re-confirmación
dentro de autorización; preview y confirmación explícita fuera de ella), el matiz
de doble confirmación para acciones inline, y el pivote Solana-first por Colloseum.

Queda abierta la comparación técnica de clases de wallet a integrar en el MVP
(embebidas / externas solo lectura / externas operables). El outline
(`04-structure-outline.md`) compara esa decisión y no la asume.
