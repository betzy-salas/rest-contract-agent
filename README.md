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
        ▼  npm run guidelines:sync   descarga por la API REST de Confluence (solo lectura);
        │                             de una carpeta, todas las páginas que contiene
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
| GitHub Copilot | Licencia con modo agente. No requiere servidores MCP. |
| IDE | IntelliJ con el plugin de GitHub Copilot actualizado, o VS Code actualizado. |
| Confluence Cloud | Cuenta de Atlassian con acceso de lectura a **todos** los espacios listados en `sources.yaml`, y una credencial para la API REST (ver "Conectar Confluence"). |
| Node.js | 18 o superior. |

## Instalación

1. Copia el contenido de esta carpeta en la raíz del repositorio (`.github/` debe quedar en la raíz).
2. Ejecuta `npm install`.
3. En `.github/CODEOWNERS`, reemplaza `@tu-org/gobierno-apis` por el equipo de Gobierno en GitHub.
4. El equipo de Gobierno completa `guidelines/sources.yaml` con los links reales (ver más abajo).

## Conectar Confluence (una vez por desarrollador)

El agente no habla con Confluence directamente: ejecuta `npm run guidelines:sync`, que usa la **API REST de Confluence Cloud** con tus credenciales. Por eso el agente ve exactamente lo que tú puedes ver.

Las credenciales van en un archivo `.env` en la raíz del repo. **Está en `.gitignore` y nunca se sube.** Copia `.env.example` a `.env` y completa una de las dos opciones:

**Opción 1 (recomendada): token de API.**

```
CONFLUENCE_EMAIL=tu.correo@empresa.com
CONFLUENCE_API_TOKEN=...
```

Se crea en https://id.atlassian.com/manage-profile/security/api-tokens. Si la organización bloquea la creación de tokens, pide a Gobierno que solicite una **cuenta de servicio** con token al administrador de Atlassian: el mismo script sirve sin cambios y el token puede vivir en un secret de GitHub para sincronizar desde CI.

**Opción 2 (temporal): cookie de tu sesión del navegador.**

Es la misma sesión con la que ya entras a Confluence. Expira a las pocas horas o días; cuando `sync` falle con `401` o `Respuesta no JSON`, repite estos pasos.

1. Abre Confluence en el navegador, con sesión iniciada.
2. Abre las herramientas de desarrollador (F12 o Cmd+Opt+I) y la pestaña **Red** (Network).
3. Recarga la página y haz clic en cualquier petición a `<sitio>.atlassian.net` (por ejemplo la primera de la lista).
4. En **Encabezados de la solicitud** (Request Headers), copia el valor completo de `Cookie`.
5. Pégalo en `.env`:

```
CONFLUENCE_COOKIE=cloud.session.token=...; tenant.session.token=...; (todo el valor copiado)
```

La cookie da acceso a Confluence como tú. Trátala como una contraseña: no la compartas, no la pegues en el chat de Copilot ni en ningún archivo del repo. Si usas las dos opciones a la vez, el script prefiere el token.

**Comprobar:** en la terminal, `npm run guidelines:sync` debe terminar con `Descargadas N páginas`.

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

También puedes hacerlo desde la terminal, sin el agente:

```bash
npm run guidelines:sync      # descarga a guidelines/.cache · 0 ok · 2 error
npm run guidelines:check     # 0 vigentes · 1 cambios · 2 error
npm run guidelines:approve   # registra la versión aprobada en sources.lock.json
```

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `Sin credenciales` | No existe `.env` o está vacío | Seguir "Conectar Confluence" |
| `401 sin autenticar` o `Respuesta no JSON` | La cookie expiró, o el token es incorrecto | Copiar una cookie nueva desde el navegador, o revisar email y token |
| `403 sin permiso` | Sin lectura en ese espacio | Pedir acceso de lectura al espacio indicado |
| `404 no existe` | El id de la URL en `sources.yaml` es incorrecto | Gobierno corrige el link |
| `sources.yaml todavía tiene URLs de ejemplo` | Fuentes sin configurar | Gobierno completa `sources.yaml` |
| `no tienen la forma https://<sitio>/wiki/.../pages/<id>/ o /folder/<id>` | Se usó un link corto | Copiar el link completo desde el navegador |
| `no contiene páginas` | La carpeta está vacía | Revisar la carpeta en Confluence |
| Faltan páginas de una carpeta | Son de otro tipo (pizarras, bases de datos) o están en un espacio sin permiso | Comparar el conteo `CARPETA` con Confluence; el script solo descarga páginas |
| Marca CAMBIADA y nadie editó la página | Cambió la conversión a Markdown entre ejecuciones | Revisar el resumen; si no hay cambio de reglas, aprobar |

## Estructura

```
.github/agents/rest-contract.agent.md      agente (Etapa 1 activa)
.github/prompts/sync-guidelines.prompt.md  /sync-guidelines
.github/CODEOWNERS                         Gobierno aprueba cambios en guidelines/
guidelines/sources.yaml                    páginas y carpetas de Confluence (Gobierno)
guidelines/sources.lock.json               versión aprobada (la genera guidelines:approve)
guidelines/.cache/                         descarga local de trabajo (no se versiona)
.env.example                               plantilla de credenciales (copiar a .env, que no se versiona)
scripts/sync.mjs                           descarga desde la API REST de Confluence
scripts/guidelines.mjs                     check / approve
```
