# Preguntas para Pi

## Estado actual

1. ¿Cómo viaja una solicitud desde el cliente, LiveKit y Realtime hasta las herramientas, la identidad, el proveedor y la confirmación on-chain? Referenciar funciones y pruebas.
2. ¿Qué estado queda ligado a la sala de voz y cuál sobrevive a una desconexión? ¿Cómo evita duplicados y maneja resultados inciertos?
3. ¿Cómo se asocian usuario, wallet, red y permisos? ¿Los proveedores son alternativas de configuración o se pueden usar simultáneamente?
4. ¿Qué operaciones existen además de transferencias? Verificar swaps, balances, historial, notificaciones y jobs antes de asumir soporte.
5. ¿Qué partes del prototipo Realtime ya están integradas en el repo principal? Identificar diferencias útiles sin modificar los checkouts.

## Investigación externa

Consultar documentación oficial actual de LiveKit Agents, OpenAI Realtime, proveedores de wallets y herramientas de ejecución relevantes. Registrar enlaces y fecha; si no hay acceso, declarar el hueco. No inventar disponibilidad, precios ni compatibilidades.

Investigar sesiones de voz y herramientas de larga duración; permisos delegados y revocación; wallets externas versus embebidas; simulación/cotización/confirmación; swaps; eventos on-chain y notificaciones. Incluir Solana y EVM como alternativas por evaluar, sin asumir que el nombre Colloseum decide la red.

## Brainstorm posterior a los hechos

Comparar tres productos: copiloto que propone y pide confirmación, asistente con reglas acotadas, y agente con ejecución delegada. Considerar tareas como consultar patrimonio agregado, preparar una compra, mover liquidez entre wallets propias, seguir una operación y avisar de un evento.

Evaluar separar conversación de ejecución durable: qué exige realmente el caso de uso y cuál sería la versión mínima. Considerar permisos por wallet/acción/importe/plazo, revalidación de cotizaciones, idempotencia, recuperación después de una caída y trazabilidad. La voz no debe tomarse automáticamente como autenticación suficiente.

Proponer un MVP acotado y explicar qué se reutiliza, qué se adapta y qué falta construir. Mostrar un flujo completo con sus fallos posibles. Estimar complejidad relativa y dependencias, sin prometer cronogramas sin evidencia.

Cerrar con una sola pregunta de producto que cambie materialmente el diseño. No ejecutar operaciones financieras ni implementar las propuestas.
