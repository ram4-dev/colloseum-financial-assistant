# Research D-4: Mecanismos de grants delegados para wallets agénticas en Solana

**Fecha de investigación:** 2026-10-03
**Método:** Fuentes primarias verificadas en vivo (docs oficiales vía `llms.txt`/markdown de Mintlify, GitHub API, changelogs). Cada cita indica URL y fecha de verificación; donde el doc no muestra fecha de publicación se indica "verificado 2026-10-03" y la evidencia de fecha disponible.

---

## Respuestas a las 3 preguntas clave

### 1) ¿Privy soporta Solana DEVNET para embedded wallets y firma server-side?

**SÍ.**
- Devnet explícito en docs: *"Privy supports Solana clusters such as Mainnet Beta, Devnet, and Testnet"*, con ejemplo de config `solana:devnet` → `https://api.devnet.solana.com` en `PrivyProvider`. Fuente: https://docs.privy.io/basics/react/advanced/configuring-solana-networks (verificado 2026-10-03; doc sin fecha de publicación, se refiere al SDK React 3.x actual). También soporta SVMs custom.
- Firma server-side Solana: los server SDKs (NodeJS `PrivyClient`, REST `auth.privy.io`) firman transacciones Solana desde el backend; ejemplo oficial de backend developer-owned wallets construyendo y enviando transacción Solana (Kamino). Fuente: https://docs.privy.io/wallets/overview/chains y index de docs (llms.txt, verificado 2026-10-03). Para wallets de usuario firmadas desde el server sin usuario en el loop se usa el modelo **owners/signers + policy** (https://docs.privy.io/wallets/using-wallets/signers/overview y /use-signers, verificado 2026-10-03).
- **Policy engine sobre Solana: SÍ.** `chain_type: 'solana'` es valor soportado (junto a ethereum, tron, sui). Reglas por RPC method (`signAndSendTransaction`), evaluación **por instrucción** en enclave: max value por transferencia (`solana_system_program_instruction` → `Transfer.lamports lte`), allowlist de destinatarios (`Transfer.to in [...]`), allowlist de programas (`solana_program_instruction.programId`), ventana temporal (`system.current_unix_timestamp gte/lt`), Token Program (`TransferChecked.mint`, amounts). Fuente: https://docs.privy.io/controls/policies/example-policies/solana (verificado 2026-10-03; los ejemplos usan timestamps de sept-2025, lo que indica soporte Solana desde ~2025).
- **Limitación documentada (importante):** la evaluación de policies Solana **no resuelve Address Lookup Tables (ALTs)** — condiciones sobre direcciones dentro de una ALT (p.ej. `Transfer.to`) hacen fallar la política y rechazan la tx. Transferencias simples SOL/SPL no usan ALT, así que el caso Nana Wallet está cubierto. Fuente: misma página, sección "Known Limitations" (verificado 2026-10-03).
- Changelog fechado relevante (https://docs.privy.io/changelogs/product-updates): mayo 2026 — "Transfer policies are live. Restrict /transfer actions based on asset type, amount, chain, or destination address"; junio 2026 — Swap API soporta Solana mainnet; OAuth Device Authorization para agentes. (Verificado 2026-10-03.)

### 2) ¿Alguna primitiva de proveedor reemplazaría un motor de grants propio?

**Sí — Crossmint Scopes y Para Permissions cubren los 4 requisitos del gate D-4 de forma nativa; Privy y Turnkey cubren 3 de 4.**

| Requisito D-4 | Privy | Crossmint | Turnkey | Para |
|---|---|---|---|---|
| Cap por transferencia | ✅ `lte` por instrucción | ✅ `spendingLimit.amount` | ✅ `solana.tx.transfers[].amount` en policy language | ✅ `compare request.value.baseUnits lte` |
| **Cap acumulado con ventana (rolling)** | ❌ solo max por tx + ventanas estáticas de tiempo | ✅ `spendingLimit: {amount, interval}` con reset por intervalo | ❌ (cap per-signing; acumulado lo implementás vos) | ✅ `aggregate fact wallet.spend.native op lte window "24h"` |
| Allowlist de destinatarios | ✅ `Transfer.to in [...]` (⚠️ no ALTs) | ✅ `recipients: [...]` | ✅ `transfers[].to` en condición | ✅ `compare request.to in/eq` |
| Expiración del grant | ✅ ventana temporal (unix ts gte/lt) — estática, no "TTL desde creación" | ✅ `expiresAt` (ISO 8601) a nivel signer | ✅ expiración de session profiles (ceiling) + `time.now` en policies | ✅ vía versionado/reglas; consent con expiry en Requests |
| Enforcement fuera del app-server | ✅ enclave Privy | ✅ pre-broadcast en Crossmint (validación antes de firmar/broadcast) | ✅ enclave Turnkey | ✅ en el signing request de Para |
| Delegación a un agente | ✅ signers con `policyIds` (1 policy override por signer) | ✅ delegated signer + scopes | ✅ sub-organization/API-user por agente + policies; session profiles | ✅ `metadata.productMode: "delegation"` |

Fuentes primarias:
- Crossmint: https://docs.crossmint.com/wallets/guides/signers/scopes — *"Spending limit: a maximum amount the signer can transfer, **optionally resetting on a fixed interval**; Recipient whitelist; signer-level `expiresAt` field denies the signer after a given timestamp. Scopes are checked **before** the transaction is broadcast."* Pestaña **Solana** del mismo doc con payload `tokenLocator: "solana:sol"`, `spendingLimit: {amount, interval: 86400}` (verificado 2026-10-03).
- Para: https://docs.getpara.com/v3/concepts/permissions-reference — condición `aggregate` con `wallet.spend.native`, `window: "24h"`; selectores `walletType: SOLANA`, `requestRoute: solana.sign_transaction` (verificado 2026-10-03). Nota: la doc indica el fact aggregate para EVM native spend; para Solana hay que validar el fact equivalente con `para keys permissions catalog --json` (la doc advierte que los facts varían por route).
- Turnkey: https://docs.turnkey.com/solutions/company-wallets/agentic-wallets — *"policy-enforced access control, **spending caps**, multi-party consensus"*; https://docs.turnkey.com/features/policies/language — `solana.tx.transfers[]` (from/to/amount), `spl_transfers[]` (token_mint, amount), `time.now`, `CronSpan`, time-based policies; https://docs.turnkey.com/features/authentication/sessions/session-profiles — sesiones con scope de policy language y expiración (verificado 2026-10-03).
- Privy: ver arriba. **No tiene** cap acumulado con ventana (su modelo es por-transacción + ventanas de tiempo absolutas).

### 3) ¿Solana tiene session keys on-chain utilizables en producción para este caso?

**No como estándar listo para producción para transferencias nativas/SPL arbitrarias.** El estado real del ecosistema (verificado 2026-10-03):

- **MagicBlock session-keys** (https://github.com/magicblock-labs/session-keys, rama master, último push 2026-05-26, 12 stars): programa on-chain con **ephemeral keypair + session token (PDA) con expiry y scope**. **Requiere que el programa destino valide el session token** — está pensado para juegos/apps propias (firmar como signer secundario), no para autorizar `SystemProgram::Transfer` nativo de una wallet agéntica contra programas arbitrarios. No es drop-in para Nana.
- No existe un estándar tipo "ERC-4337 / session keys EVM" adoptado por Solana para wallets agénticas: la búsqueda en GitHub de "solana session keys" devuelve solo tutoriales (2023), proyectos con 1–7 stars y forks. No hay SIP (Solana Improvement Proposal) aprobado para esto.
- El patrón de facto del ecosistema agéntico (SendAI Agent Kit, MCP servers) es: **keypair directo en env var + lógica de límites fuera de cadena** (ver SendAI abajo), o **infra de firma custodial/no-custodial con policy engine** (Turnkey, Privy, Crossmint, Para).
- Conclusión para D-4: los "grants" deben vivir **fuera de la cadena** (en el proveedor de firma o en tu backend), no on-chain.

---

## Tabla comparativa general

| Criterio | **Privy** | **Crossmint** | **Turnkey** | **Para (getpara)** | **SendAI Agent Kit** | **Fireblocks** |
|---|---|---|---|---|---|---|
| Solana wallets | ✅ (embedded + custodial) | ✅ | ✅ (legacy/V0/V1) | ✅ (MPC) | ✅ (keypair local) | ✅ |
| **Devnet** | ✅ mainnet/devnet/testnet + SVM custom | ✅ (`solana` testnet label; staging = Solana devnet) | ✅ (gas sponsorship lista devnet "for testing"; firma cluster-agnostic) | ✅ (ejemplos testnet; devnet OK) | ✅ (RPC config) | n/d en docs accesibles |
| Firma server-side | ✅ Node/REST + signers delegados | ✅ server signer + delegated key | ✅ API signing nativa | ✅ REST API (pregen/claimed) | ✅ (es el modelo: private key local) | ✅ |
| Policy/spending engine Solana | ✅ por instrucción, en enclave; máx por tx, allowlist, ventanas de tiempo; ❌ ALTs | ✅ scopes por signer: spending limit con **interval reset**, recipients, expiresAt; pre-broadcast | ✅ policy language completa (`solana.tx.transfers`, `spl_transfers`, IDLs, `time.now`); caps per-signing | ✅ permissions policy con `aggregate` + `window` (verificar facts Solana) | ❌ sin primitivas de límites | ✅ (policy engine; docs no accesibles en esta sesión) |
| Cap acumulado con ventana | ❌ | ✅ | ⚠️ manual | ✅ | ❌ | ? |
| Modelo de delegación a agente | owners/signers + policyIds | delegated signers + scopes | sub-org/API user + policies + session profiles | productMode `delegation`/`guardrail` | n/a (kit de acciones, no custodia) | API keys + policies |
| Custodia | no-custodial (enclave) | custodial-ish (Crossmint opera wallet; recovery method del usuario) | no-custodial (quorum/enclave) | no-custodial MPC | **self-custodial (clave plana en backend)** | custodial |
| Encaje TS/Node | ✅ SDKs Node/React | ✅ wallets-sdk TS | ✅ @turnkey/solana + SDKs | ✅ SDKs TS | ✅ npm `solana-agent-kit` | ✅ |

Fuentes clave por fila:
- Crossmint Solana en tabla de chains (wallets ✅, testnet label `solana`; staging usa Solana devnet): https://docs.crossmint.com/introduction/supported-chains y https://docs.crossmint.com/llms.txt (verificado 2026-10-03). Agente + wallet: https://docs.crossmint.com/agents/payment-methods/stablecoin-wallets/authorize-agent (signer registrado pendiente + aprobación del usuario con código de email; revocable).
- Turnkey devnet: https://docs.turnkey.com/features/networks/solana — *"Supported networks: Solana mainnet, **Solana devnet (for testing)**"* (para gas sponsorship) (verificado 2026-10-03).
- SendAI: README https://github.com/sendaifun/solana-agent-kit (pushed 2026-05-14, 1.7k stars): 60+ acciones para agentes (swap, transfers, DeFi). **No hay ninguna primitiva de delegated authorization, spending limits ni allowlists** — el modelo es `SOLANA_PRIVATE_KEY` en env + acciones directas. Docs: https://docs.sendai.fun/v0/introduction.
- Fireblocks: los docs públicos no fueron accesibles en esta sesión (JS-rendered); no se emiten afirmaciones sin fuente. Known públicamente: policy engine + Solana, pero **pendiente de verificación con fuente primaria fechada** antes de citarlo en el plan.
- Para: https://docs.getpara.com/llms.txt — *"non-custodial embedded wallet infrastructure using MPC … supporting EVM, Solana, and Cosmos"* (verificado 2026-10-03).

---

## Recomendación para Nana Wallet (hackathon Colosseum, TS/Node + PostgreSQL)

**Opción A (recomendada): usar Primitiva de proveedor en vez de motor propio.**

1. **Privy como base del producto de wallets** (embedded wallets Solana con devnet OK, firma server-side, signers delegados con policy por signer). Tradeoffs:
   - ✅ Devnet soportado y documentado; no-custodial real; policies evaluadas en enclave (no son bypass-eables por el app server).
   - ✅ Modelo owners/signers encaja 1:1 con el caso: usuario owner, backend/agente signer, `policyIds` = el grant.
   - ⚠️ **Falta cap acumulado con ventana** → esa parte (ledger de gasto acumulado y reseteo) sí la implementás en PostgreSQL y la aplicás en el momento de crear el grant; Privy garantiza el tope por-tx y los destinatarios.
   - ⚠️ ALTs no resueltos en policies (irrelevante para transfers simples).
   - ⚠️ Cada signer solo soporta 1 policy override.

2. **Alternativa si querés el grant completo out-of-the-box: Crossmint Scopes** — es la única primitiva verificada que cubre los 4 requisitos (cap con `interval` reset + recipients + `expiresAt` + enforcement pre-broadcast) sobre Solana con devnet en staging. Tradeoffs:
   - ✅ Menos código propio; expiración nativa por signer.
   - ⚠️ Wallets más "custodial" (el recovery method del usuario aprueba via Crossmint; approval flow con email code).
   - ⚠️ Menos control fino sobre instrucciones no-transfer (solo scope type `transfer`).

3. **Turnkey** si preferís infraestructura de firma pura con policy language más expresiva (IDLs, time-based, session profiles con scope); el cap acumulado también queda en tu backend. **Para** es interesante por `aggregate`+`window` nativo, pero el soporte de facts aggregate para la route Solana debe validarse antes de comprometer el gate.

**Qué NO hacer:**
- Motor 100% propio sobre keypair plano en PostgreSQL (el default del plan): un agente comprometido = clave comprometida, y las políticas viven en el mismo proceso que puede ser burlado. Es aceptable solo como fallback de hackathon, no como respuesta del gate D-4.
- Session keys on-chain (MagicBlock): exige integrar validación en cada programa destino; no sirve para transfers nativos contra programas arbitrarios en 2026.

**Híbrido sugerido para el plan:** Privy (custodia + enforcement por-tx de allowlist/máx) + tabla `grants` en PostgreSQL (cap acumulado por ventana, expiración TTL, revocación, auditoría). El grant crea/actualiza la policy Privy del signer; el ledger en Postgres decide cuándo crear/rotar/revocar.

---

## Apéndice: fuentes primarias citadas (todas verificadas 2026-10-03)

1. Privy — Configuring Solana networks (devnet/testnet/mainnet): https://docs.privy.io/basics/react/advanced/configuring-solana-networks
2. Privy — Policies overview (`chain_type: 'solana'`, evaluación por instrucción en enclave): https://docs.privy.io/controls/policies/overview
3. Privy — Solana example policies (lamports lte, `Transfer.to in`, ventana unix ts): https://docs.privy.io/controls/policies/example-policies/solana (incl. limitación ALTs)
4. Privy — Signers overview / add signers / use signers: https://docs.privy.io/wallets/using-wallets/signers/overview · /add-signers · /use-signers
5. Privy — Delegating permissions (owners/signers): https://docs.privy.io/controls/common-use-cases/delegation
6. Privy — Product updates (changelog fechado, mayo–ago 2026): https://docs.privy.io/changelogs/product-updates
7. Crossmint — Restrict a Signer with Scopes (spending limit + interval, recipients, expiresAt; tab Solana): https://docs.crossmint.com/wallets/guides/signers/scopes
8. Crossmint — Supported chains (Solana wallets ✅, staging = devnet): https://docs.crossmint.com/introduction/supported-chains · https://docs.crossmint.com/llms.txt
9. Crossmint — Authorize the Agent: https://docs.crossmint.com/agents/payment-methods/stablecoin-wallets/authorize-agent
10. Turnkey — Solana (SVM) support (devnet para sponsorship, parser en enclave): https://docs.turnkey.com/features/networks/solana
11. Turnkey — Policy language (`solana.tx`, `transfers`, `spl_transfers`, `time.now`, CronSpan): https://docs.turnkey.com/features/policies/language
12. Turnkey — Agentic Wallets (spending caps, destination allowlist, personas): https://docs.turnkey.com/solutions/company-wallets/agentic-wallets
13. Turnkey — Session Profiles (scope + expiración): https://docs.turnkey.com/features/authentication/sessions/session-profiles
14. Para — Policy JSON reference (`walletType: SOLANA`, `aggregate` + `window`): https://docs.getpara.com/v3/concepts/permissions-reference
15. SendAI — solana-agent-kit README (sin primitivas de límites; private key env): https://github.com/sendaifun/solana-agent-kit (pushed 2026-05-14)
16. MagicBlock — session-keys (ephemeral keypair + session token PDA, requiere integración por programa): https://github.com/magicblock-labs/session-keys (pushed 2026-05-26)
