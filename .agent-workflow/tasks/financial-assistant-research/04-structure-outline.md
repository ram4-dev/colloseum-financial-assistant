# Outline de estructura: asistente financiero con autorizaciones delegadas acotadas

Estado: **DRAFT — Outline autorizado** (el usuario pidió el draft; aprobación de
contenido pendiente antes de implementar). Redactado y revisado: 2026-10-03.
**Solana-first: decidido y aprobado por el usuario.** Decisión abierta principal:
clases de wallet a integrar (2.2).
Entradas: `00-intake.md`, `01-research-questions.md`, `02-research.md`,
`03-design-discussion.md`, `review-findings.md`.

## Corrección de fechas (obligatoria para todo el paquete)

- Este paquete fue **redactado y revisado el 2026-10-03**. Las fechas
  `2026-02-20` que aparecen en `02-research.md` y `03-design-discussion.md` como
  fecha de consulta de fuentes **no son confiables como fecha de verificación
  real** y quedan marcadas para revalidación.
- Regla para este outline: cada fuente externa citada lleva su **fecha de
  verificación real** o la marca explícita `REVALIDAR`. Al momento del draft,
  verificadas hoy (2026-10-03, según `review-findings.md`):
  - OpenAI: precio GPT-Realtime-2.1-mini $10/M audio input, $20/M audio output.
    <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini> — verificado 2026-10-03.
  - LiveKit: tools asíncronas y recomendación de no bloquear el turno en tareas
    largas. <https://docs.livekit.io/agents/logic/tools/async/> — verificado 2026-10-03.
- `REVALIDAR` (sin fecha de verificación confiable): Privy embedded wallets /
  signers / swaps / webhooks; Circle developer-controlled wallets y Notifications
  API; SendAI Solana Agent Kit; precios y disponibilidad de Arc; soporte y fees
  Solana de cada proveedor. Revalidar antes de estimar o implementar contra ellas.

## 0. Supuestos

1. La base técnica parte del repo `aleph-hackathon` (HEAD `99ad96b`): voz Realtime
   con LiveKit + OpenAI, herramientas preview-only, servicio de conversación durable
   en PostgreSQL, seam `WalletProvider`. Esto es evidencia de repo, no supuesto.
2. Las "session keys" son **un mecanismo por elegir y verificar**, no una
   implementación existente. La evidencia de repo (`signer_grants`,
   `WalletTransferPipeline`) es fixture-only y experimental. Este outline planifica
   sobre el *concepto* de autorización delegada acotada del lado servidor, dejando
   el mecanismo concreto (tabla de grants propias, feature del proveedor, o
   primitiva de delegación de Solana) como decisión dentro del Slice 1.
3. El repo fuente no se modifica en esta fase; el outline describe trabajo futuro.
4. No hay custody propia ni claves de agente expuestas: toda firma pasa por el
   proveedor de wallets (supuesto de seguridad, a revalidar por proveedor).
5. Multi-wallet, swaps y notificaciones son **trabajo por construir**: no existen
   en el repo (evidencia: 0 resultados de `swap`/`notif`/`webhook` en `src/`).

## 1. Decisiones aprobadas

- **Se permiten reglas delegadas acotadas.** Las acciones cubiertas por
  autorización previa se ejecutan **sin nueva confirmación**. Las acciones que
  exceden la autorización requieren **preview y confirmación explícita**.
- **Las transacciones pedidas inline y fuera de una autorización existente** siguen
  el flujo de preview narrado y doble confirmación. Una acción ya cubierta por una
  regla delegada no pide confirmación otra vez.
- **Solana-first** es la red elegida para la hackathon de Colloseum; EVM y multichain
  quedan para una posible etapa posterior.

Ninguna otra decisión de producto está aprobada. En particular, la concesión de
autorizaciones por voz sigue prohibida por diseño de seguridad (propuesta no
refutada), pero se lista en abiertas porque no fue ratificada explícitamente.

## 2. Decisiones abiertas (el outline no las asume)

### 2.1 Red: Solana-first — DECIDIDA (aprobada por el usuario)

El usuario aprobó el **pivote del repo a Solana** porque Colloseum es la hackathon.
No es una decisión pendiente ni se vuelve a cuestionar en este outline.

Implicaciones registradas:

- Nuevo `WalletProvider` Solana: direcciones base58, versioned transactions, modelo
  propio de fees y finalidad.
- El código EVM existente (`transfer-pipeline.ts`, calldata ERC-20, providers Privy
  EVM/Circle Arc/WDK) queda como **referencia de patrones** (preview/confirm,
  idempotencia, reconciliación, seam `WalletProvider`), no como base a extender.
- **EVM-first y multichain quedan descartadas como opciones del MVP**; pueden ser
  expansión futura después de la hackathon.
- REVALIDAR antes de implementar: soporte y fees Solana de cada proveedor de wallets
  (Privy u otros) y primitivas de delegación/session keys del ecosistema Solana.

### 2.2 Tipos de wallet: embebidas / externas solo lectura / externas operables — DECISIÓN PENDIENTE

| Tipo | A favor | En contra | Compatibilidad con autorización delegada |
| --- | --- | --- | --- |
| **Embebidas** | El server ejecuta vía proveedor sin user-in-the-loop; encaja 1:1 con reglas delegadas; menos superficie | Custodia delegated al proveedor (TEE); depende del proveedor | Total |
| **Externas solo lectura** | Valor de portfolio/eventos sin riesgo de firma; bajo costo | No ejecuta nada sobre ellas | Total (solo lectura: sin autorización de ejecución) |
| **Externas operables** | Alcance real de usuario con self-custody | Requiere firma del usuario en cada acción (wallet adapter/ceremonia), rompe la ejecución sin re-confirmación salvo mecanismos de delegación on-chain; máxima complejidad | Parcial: contradice la política aprobada salvo delegación explícita verificada |

**Recomendación para MVP**: **embebidas** (+ opcionalmente externas de solo lectura
si el tiempo lo permite; externas operables, excluidas del MVP). **Pendiente de
aprobación explícita del usuario.**

### 2.3 Otras abiertas

- Mecanismo de session key / grant (propio en PostgreSQL vs primitiva del proveedor
  vs primitiva on-chain): se resuelve con evidencia en el Slice 1.
- Canal de concesión de autorizaciones (propuesta: firma del cliente autenticado,
  nunca voz): pendiente de ratificación.
- Notificaciones: canal in-app propuesto (revisiones), sin push. Pendiente.
- Alcance multi-wallet (N wallets embebidas por usuario): propuesta, pendiente.

## 3. Garantías transversales — checklist por slice

Cada slice que toque ejecución financiera **debe mantener demostrables** estos
puntos del lado servidor (nunca del lado del modelo ni del cliente):

1. **Autorización server-side**: el grant se valida en el servidor en el momento
   de la ejecución (no en el turno, no en la sesión de voz).
2. **Límite**: importe máximo y, si aplica, ventana de uso acumulado.
3. **Expiración y revocación**: el grant caduca y puede revocarse; una ejecución
   contra un grant expirado/revocado falla cerrado y degrada a preview+confirm.
4. **Auditoría**: cada concesión, uso y rechazo queda registrado (quién, qué,
   cuánto, con qué grant, con qué resultado).
5. **Idempotencia**: cada intención tiene clave idempotente; reintento no duplica
   efecto on-chain (patrón `previewId`/`idempotency_key` existente).
6. **Preview + confirmación fuera de autorización**: toda acción no cubierta por un
   grant vigente pasa por preview narrado + confirmación explícita (patrón
   `send_token`/`confirm_transfer` existente).
7. **Notificación observable**: toda ejecución (con o sin nueva confirmación)
   produce un evento observable por el usuario.

## 4. Slices verticales

Cada slice entrega un **resultado observable** de punta a punta. Orden propuesto;
los bloqueos son duros (el slice no empieza sin su dependencia).

---

### Slice 1 — Núcleo de autorización delegada (server-side)

- **Resultado observable**: un grant acotado (acción, wallet, importe máximo,
  ventana, expiración, destinatarios) creado por canal autenticado permite
  exactamente una acción acotada; un segundo uso fuera de límite, expirado o
  revocado es rechazado y queda auditado.
- **Scope**: modelo de grants en PostgreSQL; motor de validación server-side;
  concesión y revocación por endpoint autenticado (firma del cliente); registro de
  auditoría; claves de idempotencia por intención. Elección y verificación del
  mecanismo de session key (propio vs proveedor vs on-chain) con ADR corto.
- **Checks**:
  - Unit: validación de límite, expiración, revocación, destino permitido;
    degradación a preview+confirm al exceder scope.
  - Integración: concesión firmada → uso dentro de límite → rechazo fuera de
    límite → revocación intermedia; auditoría de cada paso.
  - Build: migraciones + suite verde.
  - E2E: concesión por API autenticada, ejecución autorizada una vez, rechazo del
    reintento fuera de política (idempotencia).
  - Manual: revocación surte efecto inmediato en la siguiente ejecución.
- **Bloqueos/dependencias**: ninguno externo. El motor de grants se construye
  agnóstico de cadena con validadores por cadena enchufables; el validador Solana
  (destinatario base58 válido) se enchufa con el Slice 2.

---

### Slice 2 — Provider Solana (cadena objetivo, decidida)

- **Resultado observable**: balance leído y una transferencia de prueba en Solana
  devnet, con preview → confirmación → broadcast → finalidad, y estado
  `uncertain` manejado (bloqueo + reconciliación), todo por el seam `WalletProvider`.
- **Scope**: `WalletProvider` Solana: direcciones base58, versioned transactions,
  modelo propio de fees y finalidad; lectura de balance; preview; broadcast con
  `submitted|uncertain|not_dispatched`; espera de finalidad; explorador.
- **Checks**:
  - Unit: parseo de direcciones/montos de la cadena; mapeo de outcomes de broadcast
    y finalidad; timeout de finalidad.
  - Integración: proveedor contra Solana devnet (o fixture determinista más un
    smoke test manual en devnet), reconciliación de `uncertain`.
  - Build: suite + lint.
  - E2E: transferencia de prueba completa en Solana devnet con preview+confirm.
  - Manual: verificación en explorador del hash final.
- **Bloqueos/dependencias**: Slice 1 (formato de grant/validador). Decisión de
  clases de wallet (2.2) define si el provider es embebido-por-usuario. REVALIDAR
  soporte/fees del proveedor elegido para Solana. **Gate de salida de Slice 1**:
  confirmar que el proveedor seleccionado soporta Solana devnet y dejar registrado
  cualquier límite de fees o finalidad antes de empezar este slice.
- Las conclusiones de fees y finalidad validadas en devnet describen solo ese
  entorno de prueba; no demuestran preparación para mainnet.

---

### Slice 3 — Ejecución bajo autorización sin re-confirmación

- **Resultado observable**: una instrucción de usuario cubierta por un grant vigente
  se ejecuta de punta a punta **sin pedir confirmación**, con aviso visible al
  terminar; la misma instrucción sin grant vigente produce preview+confirmación.
- **Scope**: integración del motor de grants con el flujo de ejecución:
  revalidación server-side al ejecutar (límite, expiración, revocación), consumo de
  límite, idempotencia por intención, auditoría del uso, emisión del evento de
  ejecución.
- **Checks** (aplica checklist transversal completo de la sección 3):
  - Unit: cubierto vs no cubierto; degradación; consumo de límite acumulado;
    doble ejecución concurrente del mismo grant (cap).
  - Integración: grant → ejecución por el provider del Slice 2 → finalidad →
    auditoría + evento; rechazo por revocación en el instante de ejecutar. Probar
    idempotencia contra la restricción única de la base de datos, no con un contador
    en memoria.
  - Build: suite.
  - E2E: dos turnos: uno autorizado sin confirmación, uno fuera de autorización
    con preview y confirmación explícita; ambos auditados y con un aviso visible
    para el usuario.
  - Manual: aviso observable visible tras la ejecución sin confirmación.
- **Bloqueos/dependencias**: Slice 1 (motor), Slice 2 (provider), canal de
  notificación mínimo (puede empezar con evento de revisión interno y completarse
  en Slice 5).

---

### Slice 4 — Confirmación explícita fuera de autorización (voz)

- **Resultado observable**: instrucción fuera de grants → la voz narra el preview
  (monto, destino, comisión) y solo ejecuta tras confirmación explícita;
  cancelación y `stale` funcionan; todo queda auditado.
- **Scope**: herramientas de voz ligadas al motor de autorización: la tool
  solicita al servicio; el servicio decide confirmación vs ejecución directa;
  reuso del patrón existente (preview-only, `stale_preview`, cancel).
- **Checks**:
  - Unit: clasificación cubierto/no cubierto; schema estricto de tools (sin
    dirección libre, sin flags); revalidación de destinatario versionado.
  - Integración: preview → confirm → broadcast → finalidad; cancel; preview vencido.
  - Build: suite.
  - E2E de voz (sala): flujo completo hablado con confirmación y cancelación.
  - Manual: verificación de que ninguna tool acepta destino libre por voz.
- **Bloqueos/dependencias**: Slices 1–3.

---

### Slice 5 — Notificaciones observables

- **Resultado observable**: cada ejecución (autorizada o confirmada) y cada evento
  entrante relevante (p. ej. fondo recibido, si Solana/proveedor lo soporta vía
  REVALIDAR) genera un aviso visible en la app sin refrescar.
- **Scope**: ingesta de webhooks firmados del proveedor (o polling como fallback
  REVALIDAR) con dedupe idempotente; tabla de eventos; fan-out por revisiones al
  frontend (mecanismo `revision-publisher` existente como referencia).
- **Checks**:
  - Unit: verificación de firma; dedupe por id de evento; mapeo evento→aviso.
  - Integración: webhook firmado → evento dedupe → revisión publicada; reintento
    del proveedor no duplica aviso.
  - Build: suite.
  - E2E: ejecución en Slice 3 produce aviso visible end-to-end.
  - Manual: webhook perdido → polling de reconciliación genera el aviso.
- **Bloqueos/dependencias**: Slice 2 (provider/eventos de la red); puede
  avanzarse en paralelo al Slice 3 con contrato de eventos fijado.

---

### Slice 6 — Multi-wallet embebida y portfolio (condicional)

- **Resultado observable**: el usuario ve el patrimonio agregado de sus N wallets
  embebidas y las operaciones declaran sobre qué wallet operan (wallet activa por
  conversación, confirmada al inicio).
- **Scope**: entidad wallet por usuario; agregación de balances (lectura);
  selección de wallet activa por sesión; binds de tools con walletId; grants
  referencian wallet.
- **Checks**:
  - Unit: agregación; wallet ambigua → clarificación; grants por wallet.
  - Integración: dos wallets, grant de A no autoriza operación sobre B.
  - Build; E2E: consulta de portfolio por voz y transferencia sobre wallet activa.
  - Manual: cambio de wallet activa entre conversaciones.
- **Bloqueos/dependencias**: decisión de wallets (2.2) — solo corre si el MVP
  incluye N wallets embebidas; Slices 1–2.

---

### Slice 7 — Compras/swaps en Solana (condicional, última prioridad)

- **Resultado observable**: compra acotada con quote → preview narrado →
  confirmación explícita → ejecución → finalidad → aviso; quote vencido degrada a
  re-cotización (`stale_quote`).
- **Scope**: quote/execute del proveedor sobre Solana (REVALIDAR soporte); patrón
  preview/confirm reutilizado; límite de compra por grant.
- **Checks**: análogos a Slice 4 + revalidación de quote vencido y slippage; E2E
  de compra en testnet; manual de verificación en explorador.
- **Bloqueos/dependencias**: Slices 1–5; soporte del proveedor verificado (REVALIDAR);
  es el slice que se recorta primero si la fecha de hackathon aprieta.

---

## 5. Fuera de alcance del MVP (propuesto, pendiente de ratificación)

- Wallets externas operables (contradice la política aprobada sin mecanismo de
  delegación verificado).
- Push nativo (propuesto in-app).
- Reglas compuestas o intenciones condicionales ("comprá si baja de X").
- Arc mainnet / producción con fondos reales.

## 6. Riesgos del outline

1. ~~Decisión de red sin cerrar~~ **Resuelto: Solana-first aprobada.** El primer
   gate del usuario ahora es la decisión de clases de wallet (2.2).
2. **Mecanismo de session key sin verificar**: si ni el proveedor ni la red ofrecen
   primitiva, el núcleo propio (Slice 1) crece; el ADR del Slice 1 existirá
   precisamente para esto.
3. **REVALIDAR masivo de proveedores** (Privy/Circle/SendAI, fees, soporte por
   red): ninguna estimación de este outline es confiable hasta revalidar.
4. **Hackathon timebox**: Slice 7 es el recorte natural; Slices 1–4 son el mínimo
   que demuestra la política aprobada de punta a punta.

## 7. Nota de finalización (2026-10-03)

- Outline actualizado y verificado: **Solana-first quedó registrado como decisión
  aprobada** (§2.1), sin gate de red en ningún slice. EVM-first y multichain
  figuran solo como expansión futura posible.
- Slices reordenados sobre Solana: Slice 2 = Provider Solana, Slice 7 = swaps en
  Solana; ninguna dependencia condicional a "red elegida" queda en el documento.
- `03-design-discussion.md` y `review-findings.md` corregidos: ya no afirman que
  la aprobación de red falta; reflejan la aprobación explícita del pivote Solana
  y el matiz de doble confirmación para acciones inline.
- **Decisión abierta principal que permanece**: clases de wallet a integrar en el
  MVP — embebidas / externas de solo lectura / externas operables (§2.2), más el
  mecanismo concreto de session key (ADR del Slice 1) y el canal de avisos.
- Fuentes externas: solo OpenAI (pricing) y LiveKit (async tools) con verificación
  2026-10-03; el resto marcado REVALIDAR.
- No se implementó código ni se modificó el repo fuente. Siguiente gate: decidir
  clases de wallet (2.2) y aprobar el contenido de este outline.
