---
description: Descarga los lineamientos vigentes de Confluence y reporta si cambiaron desde la última versión procesada
agent: rest-contract
---

Ejecuta solo la **Etapa 1** de tus instrucciones con las fuentes de `guidelines/sources.yaml`, **forzando la descarga**: usa `npm run guidelines:sync` sin `--max-age`.

Termina con el estado de los lineamientos (VIGENTES, CON CAMBIOS o NUNCA PROCESADOS) y la lista de páginas que cambiaron, si las hay. No ejecutes otras etapas.
