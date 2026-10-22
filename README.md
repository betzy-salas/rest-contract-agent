# REST Contract Agent

Agente de GitHub Copilot que genera contratos **OpenAPI 3** a partir de los **lineamientos vigentes en Confluence** y de un **cuadro de mapeo de campos**.

> **Estado: Etapa 1 de 7.** Por ahora el agente obtiene los lineamientos de Confluence, detecta si cambiaron y pide aprobación. Las siguientes etapas se agregan una a una.

| Etapa | Qué hace | Estado |
|---|---|---|
| 1 | Obtener y verificar los lineamientos vigentes | ✅ |
| 2 | Traducir los lineamientos a reglas verificables | ⏳ |
| 3 | Leer y revisar el mapeo | ⏳ |
| 4 | Generar el contrato | ⏳ |
| 5 | Validar y corregir en ciclo | ⏳ |
| 6 | Revisión semántica independiente | ⏳ |
| 7 | Entregar contrato y trazabilidad | ⏳ |

## Cómo funciona la Etapa 1

```
guidelines/sources.yaml          (Gobierno: páginas y carpetas de Confluence)
        │
        ▼  el agente lee cada página con el MCP de Atlassian (solo lectura);
        │  de una carpeta, lee todas las páginas que contiene
guidelines/.cache/<pageId>.md    (copia local de trabajo, no se versiona)
        │
        ▼  npm run guidelines:check   compara contra la versión aprobada
        │
   ┌────┴─────────────┐
VIGENTES          CON CAMBIOS / NUNCA APROBADOS
   │                  │  el agente muestra qué cambió y pregunta
   │                  ▼
   │           ¿Apruebas?  ── sí ──► npm run guidelines:approve ──► guidelines/sources.lock.json
   │                  │                                              (commit + PR revisado por Gobierno)
   ▼                  no ──► se detiene, no genera nada
continúa
```

Esto se ejecuta **al inicio de cada tarea**, así nunca se genera un contrato con lineamientos desactualizados ni con cambios que nadie revisó.

## Requisitos

| Requisito | Detalle |
|---|---|
| GitHub Copilot | Licencia con modo agente. En Business/Enterprise, el administrador debe permitir **servidores MCP** y las funciones en **preview** (para IntelliJ). |
| IDE | IntelliJ con el plugin de GitHub Copilot actualizado, o VS Code actualizado. |
| Confluence Cloud | Cuenta de Atlassian con acceso de lectura a **todos** los espacios listados en `sources.yaml`. |
| Atlassian | El sitio debe permitir el **servidor MCP de Atlassian (Rovo MCP)**. La primera persona que se conecta autoriza la app para el sitio; si la organización lo restringe, lo habilita un administrador de Atlassian. |
| Node.js | 18 o superior. |

## Instalación

1. Copia el contenido de esta carpeta en la raíz del repositorio (`.github/` debe quedar en la raíz).
2. Ejecuta `npm install`.
3. En `.github/CODEOWNERS`, reemplaza `@tu-org/gobierno-apis` por el equipo de Gobierno en GitHub.
4. El equipo de Gobierno completa `guidelines/sources.yaml` con los links reales (ver más abajo).

## Conectar Confluence (una vez por desarrollador)

El servidor MCP oficial de Atlassian es remoto: no se instala nada, solo se registra su URL y cada persona se autentica con su propia cuenta. Por eso el agente ve **exactamente** lo que esa persona puede ver en Confluence.

URL del servidor: `https://mcp.atlassian.com/v1/mcp/authv2`

**VS Code**
1. El repo ya incluye `.vscode/mcp.json` con el servidor `atlassian`.
2. Abre ese archivo y pulsa **Start** sobre el servidor (o acepta el aviso que aparece al abrir el chat).
3. Se abre el navegador: inicia sesión en Atlassian y autoriza el acceso.

**IntelliJ**
1. Abre la configuración MCP de Copilot: en el chat de Copilot en modo **Agent**, ícono de herramientas → agregar servidores MCP (o *Settings → Tools → GitHub Copilot → MCP*; el nombre del menú puede variar según la versión del plugin). Se abre el `mcp.json` de Copilot.
2. Agrega el servidor:
   ```json
   {
     "servers": {
       "atlassian": {
         "type": "http",
         "url": "https://mcp.atlassian.com/v1/mcp/authv2"
       }
     }
   }
   ```
3. Inicia el servidor; se abre el navegador para iniciar sesión en Atlassian y autorizar.

**Comprobar:** en el chat de Copilot (modo Agent), el ícono de herramientas debe mostrar las herramientas del servidor `atlassian`.

## Configurar las fuentes (equipo de Gobierno)

Edita `guidelines/sources.yaml`:

```yaml
sources:
  - url: https://<sitio>.atlassian.net/wiki/spaces/ARQ/folder/123456
    topic: Lineamientos API              # carpeta: lee todas las páginas que contiene
  - url: https://<sitio>.atlassian.net/wiki/spaces/ARQ/pages/234567/Convenciones+de+nombres
    topic: Diseño general de APIs
    includeChildren: true                # página: también lee todas sus subpáginas
  - url: https://<sitio>.atlassian.net/wiki/spaces/SEG/pages/789012/Seguridad+en+APIs
    topic: Seguridad

precedence: [SEG, ARQ]                   # si dos páginas se contradicen, gana SEG
```

- Usa el link completo de la barra del navegador: debe contener `/pages/<número>/` (página) o `/folder/<número>` (carpeta). Los links cortos `/wiki/x/...` no sirven.
- Una **carpeta** no tiene texto propio. El agente lee todas las páginas que contiene, incluidas subpáginas y subcarpetas, aunque no indiques `includeChildren`. Si la carpeta está vacía o no logra listarla, se detiene y avisa.
- Puedes mezclar carpetas y páginas sueltas, en espacios distintos.
- `CODEOWNERS` asegura que cualquier cambio en `guidelines/` pase por revisión de Gobierno.

## Uso

En el chat de Copilot, modo **Agent**, ejecuta:

```
/sync-guidelines
```

Resultados posibles:

| Estado | Qué significa | Qué hacer |
|---|---|---|
| **VIGENTES** | Nada cambió desde la última aprobación | Nada |
| **NUNCA APROBADOS** | Primera ejecución | Revisar el índice que muestra el agente y aprobar |
| **CON CAMBIOS** | Hay páginas nuevas, modificadas o eliminadas | Revisar el resumen de cambios y aprobar o rechazar |

Al aprobar se actualiza `guidelines/sources.lock.json`. Haz commit en un PR: Gobierno lo revisa y, una vez fusionado, esa es la versión vigente para todo el equipo.

También puedes revisar el estado desde la terminal (requiere que el agente haya descargado las páginas):

```bash
npm run guidelines:check     # 0 vigentes · 1 cambios · 2 error
```

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| El agente dice que no tiene herramientas `atlassian` | El servidor MCP no está iniciado o la org no permite MCP | Iniciar el servidor; pedir al admin de Copilot que habilite MCP |
| Error de autorización al conectar | El sitio de Atlassian restringe la app | Pedir al admin de Atlassian que habilite el Rovo MCP server |
| "No se pudo leer la página…" | Sin permiso en ese espacio | Pedir acceso de lectura al espacio indicado |
| `sources.yaml todavía tiene URLs de ejemplo` | Fuentes sin configurar | Gobierno completa `sources.yaml` |
| `no tienen /pages/<id>/ ni /folder/<id>` | Se usó un link corto | Copiar el link completo desde el navegador |
| `Carpetas ... sin páginas descargadas` | La carpeta está vacía o el MCP no pudo listar su contenido | Revisar la carpeta en Confluence; si tiene páginas, reportar qué herramienta del MCP falló |
| Faltan páginas de una carpeta | La herramienta del MCP no recorrió algún nivel | Comparar el conteo `CARPETA` de `guidelines:check` con Confluence y reportar cuál falta y en qué nivel |
| Marca CAMBIADA y nadie editó la página | Cambió la conversión a Markdown entre ejecuciones | Revisar el resumen; si no hay cambio de reglas, aprobar |

## Estructura

```
.github/agents/rest-contract.agent.md      agente (Etapa 1 activa)
.github/prompts/sync-guidelines.prompt.md  /sync-guidelines
.github/CODEOWNERS                         Gobierno aprueba cambios en guidelines/
.vscode/mcp.json                           servidor MCP de Atlassian (VS Code)
guidelines/sources.yaml                    páginas y carpetas de Confluence (Gobierno)
guidelines/sources.lock.json               versión aprobada (la genera guidelines:approve)
guidelines/.cache/                         descarga local de trabajo (no se versiona)
scripts/guidelines.mjs                     check / approve
```
