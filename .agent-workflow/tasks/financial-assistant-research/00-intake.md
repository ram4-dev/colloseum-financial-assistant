# Research: asistente financiero sobre varias wallets

Fecha: 2026-10-03. Estado: lanzamiento de instancia Pi autorizado.

## Pedido y alcance

Investigar y discutir cómo reutilizar la wallet con LiveKit y OpenAI Realtime para crear un asistente financiero que conecte varias wallets, compre assets, mueva fondos y envíe notificaciones. El resultado es un brainstorm con alternativas y una recomendación técnica, no una implementación.

El usuario autorizó otra instancia de Pi para research y aclaró el modelo: GLM 5.3. Usar nan/glm5.3-flash con razonamiento high.

Repo candidato: /Users/ramiro/Desktop/projects/personales/aleph-hackathon, HEAD observado 99ad96b. También existe una variante feat-openai-realtime-poc; comparar su relevancia antes de tomarla como base. Colloseum es el destino de los documentos y todavía no tiene Git.

Ruta: RPI, fases research y discusión. Autorizado: lectura del código y fuentes públicas, creación de documentos de investigación en esta carpeta. Excluido: editar el repo fuente, implementar, desplegar, acceder a secretos, conectar cuentas reales, comprar assets o mover fondos. No crear worktrees para implementación en esta fase.

## Evidencia inicial

- src/livekit/create-agent-session.ts ya compone Agent y AgentSession con openai.realtime.RealtimeModel. Las herramientas incluyen balance, búsqueda de contactos y preparación, confirmación y cancelación de transferencias.
- Las instrucciones de voz usan la wallet configurada y no permiten seleccionar red/token desde send_token. Investigar cuánto de esa restricción proviene de la UX y cuánto del backend.
- src/wallet/provider.ts define WalletProvider, WalletContext, previewTransfer, broadcastTransfer y waitForFinality; distingue un envío incierto de uno no despachado.
- Existen proveedores WDK, Privy y Circle Arc, además de módulos de conversaciones y financial-task-registry. Su mera existencia no demuestra soporte de varias wallets simultáneas.

## Entrega esperada

02-research.md: mapa del flujo real, evidencias por archivo/línea, capacidades verificadas, limitaciones y fuentes oficiales con fecha.
03-design-discussion.md: opciones, costos relativos, riesgos concretos, propuesta de MVP y decisiones abiertas. Separar hechos, inferencias e ideas. Escribir en español directo.

No producir un outline de implementación ni código en este encargo. La siguiente decisión del usuario será sobre el concepto y alcance del producto.
