# Research questions — Slice 5

| Current-state question | Why it matters | Evidence to inspect |
|---|---|---|
| Qué eventos del proveedor y de la propia ejecución ya se producen, y qué identificador/cursor estable tienen | Define el contrato de dedupe y la cobertura de eventos de envío, finalidad y depósitos | Privy Solana provider/transport, wallet operation records, official Privy docs, package event types |
| Cómo verifica hoy el backend firmas webhook y conserva raw body; cómo registra rutas nuevas | Verificar firma antes de parsear evita falsos eventos y replays; determina integración Fastify | `src/server.ts`, `src/api/*`, Fastify parsers, dependency manifest, migrations |
| Cómo se vincula wallet → usuario → conversación activa y quién puede leer notificaciones | Sin scoping durable se pueden filtrar transacciones entre usuarios | `user_wallets`, auth, conversation repository, `WalletProvider` |
| Qué fan-out ya existe y qué hace el front cuando no hay una sesión LiveKit | D-5 reutiliza el canal existente pero debe cubrir app abierta fuera de voz y eventos perdidos | `FinancialTaskRegistry`, `revision-publisher`, `worker.ts`, LiveKit web client, state hook |
| Qué infraestructura existente puede ejecutar reconciliación periódica y cómo conserva cursores | El polling debe recuperar webhooks perdidos sin duplicar ni volver a enviar fondos | runtime lifecycle, server shutdown hooks, DB migrations, provider history/read APIs |
| Qué eventos son “relevantes” y cómo se presentan de manera visible, legible y segura | Define la UI mínima y los límites de datos sin ampliar a push nativo | Slice plan acceptance, existing wallet screens and API conventions |

Scope exclusion: no comparar proveedores para reemplazar Privy; no reabrir D-5; no estudiar push nativo, swaps ni multi-wallet.
