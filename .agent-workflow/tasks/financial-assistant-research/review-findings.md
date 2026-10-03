# Revisión del research y el design

Revisado el 2026-10-03. Repo consultado en HEAD `99ad96b8540e3cc22def0da8b11a9830fc78c414`.

## Resultado

El research y el design describen bien el flujo de voz existente y las brechas. El
historial de Pi registra que el usuario eligió el modelo híbrido de confirmación y
Solana-first. El outline autorizado refleja esas decisiones; falta la revisión
independiente y aprobar su contenido antes de implementar.

## Hallazgos que cambian el siguiente paso

1. La revisión inicial no consultó la parte anterior del historial de Pi. Allí el
   usuario había aprobado Solana-first y el matiz de confirmación inline. Se actualizó
   el design para registrar esos acuerdos; el outline los toma como decisiones.
2. “Session keys” aparece como solución ya concreta. La evidencia citada describe
   `signer_grants` experimentales/fixture-only y políticas de signers; no demuestra
   que el proyecto tenga una implementación real de session keys lista para producción.
   No se debe planear sobre esa equivalencia sin elegir y verificar el mecanismo.
3. El research y el design dicen que se consultaron fuentes el 2026-02-20, pero los
   archivos se generaron durante esta sesión del 2026-10-03. No hay registro que
   demuestre cuándo se verificó cada URL. Los precios, APIs y disponibilidad deben
   volver a comprobarse antes de usarlos para estimar o implementar. OpenAI confirma
   hoy el precio de GPT-Realtime-2.1 Mini de $10/M audio input y $20/M audio output;
   LiveKit documenta tools asíncronas y recomienda no bloquear el turno en tareas
   largas. Sources: <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>
   y <https://docs.livekit.io/agents/logic/tools/async/>.
4. El repositorio tiene un archivo sin trackear `.env.bak-allowlist-1789092583` en
   el checkout fuente. No se abrió ni se modificó. Mantenerlo fuera del research.

## Evidencia de repo que sí sostiene el concepto

- `src/livekit/create-agent-session.ts` compone Agent y AgentSession con Realtime.
- `src/livekit/realtime-tools/create-realtime-tools.ts` expone herramientas acotadas
  para balance, contactos y preparación/confirmación/cancelación de transferencias.
- `src/wallet/provider.ts` define operaciones de lectura, preview, broadcast y
  finalización. `src/wallet/privy-user-provider.ts` adapta una wallet a un usuario;
  no es una colección multi-wallet.
- `src/conversations/transfer-pipeline.ts` contiene un pipeline durable, pero el
  checkout actual indica que la ruta de transporte real debe revisarse con cuidado.
  El research ya distingue la ruta live directa de su pipeline fixture-only.
- Hay camino sustancial para voz y transferencias confirmadas. Portfolio agregado,
  swaps y notificaciones al usuario siguen siendo propuestas de trabajo, no features
  demostradas por estos documentos.

## Actualización (2026-10-03, post-review)

Después de este review, el usuario aprobó explícitamente: el pivote Solana-first
(por Colloseum) y el matiz de confirmación híbrida (acción inline = preview + doble
confirmación; solo acciones ya cubiertas por regla delegada corren sin nueva
confirmación; lo no cubierto exige confirmación completa; no crear permisos solo
por voz). Esas decisiones están aprobadas y registradas en
`03-design-discussion.md` §8.

`04-structure-outline.md` fue creado por autorización del usuario sobre esa base:
Solana-first decidido (sin gate de red), y la comparación de clases de wallet
(embebidas / externas solo lectura / externas operables) queda como la decisión
técnica abierta principal.

## Siguiente gate

La autonomía y la red Solana-first están decididas. Falta la revisión independiente
del outline y la aprobación de su contenido antes de implementar. La clase de wallet
sigue abierta y el outline conserva esa alternativa como una decisión explícita.

~~No se creó `04-structure-outline.md`: falta decidir redes y qué tipos de wallet entran
en el MVP, y obtener aprobación del design revisado.~~ **Superado (2026-10-03):**
red decidida (Solana-first); el outline fue creado con autorización del usuario y
deja abierta solo la comparación de clases de wallet (2.2).
