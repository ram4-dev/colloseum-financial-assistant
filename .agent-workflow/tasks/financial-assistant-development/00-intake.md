# Plan de desarrollo: asistente financiero

Fecha: 2026-10-03. Estado: propuesta redactada por Pi y pendiente de aprobación humana; no hay autorización de implementación.

## Alcance de esta fase

Derivar un plan de trabajo revisable a partir del research y el outline existentes en `../financial-assistant-research/`. Inspeccionar el repo actual para mapear cada slice a módulos, dependencias y pruebas reales. No modificar código, no operar wallets y no cambiar el outline aprobado por la revisión independiente.

## Decisiones ya registradas

- Solana-first para el MVP.
- Reglas delegadas acotadas: una operación cubierta puede ejecutarse sin pedir confirmación de nuevo; una operación fuera de la autorización requiere preview y confirmación explícita.
- Privy puede seguir evaluándose como proveedor, sujeto a verificar soporte Solana real y la necesidad de un adapter Solana específico.

## Gates que continúan pendientes

- Aprobación humana del contenido del outline.
- Clases de wallet del MVP.
- Ratificar canal autenticado para conceder grants, canal de notificaciones y alcance de multi-wallet.
- En Slice 1, elegir mecanismo de grants/session keys con evidencia; antes de Slice 2, demostrar soporte del proveedor para Solana devnet.

Pi debe proponer una secuencia de desarrollo con entregables observables, ownership de backend/frontend, dependencias, criterios de aceptación, pruebas y gates. Debe conservar los gates abiertos como decisiones del usuario, puede recomendar defaults, y no presentar recomendaciones como acuerdos. No crear SDD implementation artifacts ni tocar código en este paso.
