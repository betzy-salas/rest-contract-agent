# REST Contract Agent

Agente de GitHub Copilot que genera contratos **OpenAPI 3** a partir de los **lineamientos vigentes en Confluence** y de un **cuadro de mapeo de campos**.

> **Estado: Etapas 1 y 2 de 7.** El agente descarga los lineamientos de Confluence, detecta cambios y los convierte en reglas verificables. Las siguientes etapas se agregan una a una.

| Etapa | Qué hace | Estado |
|---|---|---|
| 1 | Obtener los lineamientos vigentes y detectar cambios | ✅ |
| 2 | Traducir los lineamientos a reglas verificables | ✅ |
| 3 | Leer y revisar el mapeo | ⏳ |
| 4 | Generar el contrato | ⏳ |
| 5 | Validar y corregir en ciclo | ⏳ |
| 6 | Revisión semántica independiente | ⏳ |
| 7 | Entregar contrato y trazabilidad | ⏳ |

## Cómo funcionan las Etapas 1 y 2

```
guidelines/sources.yaml          páginas y carpetas de Confluence
        │
        ▼  npm run guidelines:sync      descarga por la API REST de Confluence (solo lectura);
        │                               de una carpeta, todas las páginas que contiene
guidelines/.cache/<pageId>.md    copia local de trabajo, no se versiona
        │
        ▼  npm run guidelines:check     ¿cambió algo desde la última versión procesada?
        │
        ▼  Etapa 2: el agente clasifica cada página y extrae sus reglas
guidelines/rules/<categoria>.yaml        reglas verificables (id, texto fiel, alcance, cómo verificar, página fuente)
guidelines/rules/catalogo-esquemas.yaml  esquemas canónicos de dominio para reutilizar
guidelines/rules/pages.yaml              registro: categoría de cada página y versión de la que se extrajo
        │
        ▼  npm run rules:validate · npm run guidelines:approve   registra la versión procesada
```

Esto se ejecuta **al inicio de cada tarea**. Si una página de Confluence cambió, solo se reextraen las reglas de esa página; si nada cambió, no se relee nada. Las páginas que no aplican a contratos REST (GraphQL, eventos, procesos) se marcan fuera de alcance con una razón, y el agente te muestra esa lista para que nada se descarte sin que lo sepas.

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

### Red corporativa

Si `sync` termina con `fallo de red` aunque el navegador sí abra Confluence, la red de la empresa está en medio. El navegador toma el proxy y los certificados del sistema; Node no, hay que decírselo en el mismo `.env`. El mensaje de error dice cuál de los dos casos es:

| El error menciona | Qué pasa | Qué poner en `.env` |
|---|---|---|
| `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET` | La salida a internet pasa por un proxy | `HTTPS_PROXY=http://proxy.empresa.com:8080`, la misma dirección que usa el navegador (ver abajo cómo conocerla) |
| `CERT`, `SELF_SIGNED`, `UNABLE_TO_VERIFY`, `UNABLE_TO_GET_ISSUER` | La red inspecciona TLS con un certificado propio | El script ya confía en los certificados instalados en el sistema (donde la empresa suele poner el suyo) si tu Node es 22.15 o superior; comprueba con `node --version` y actualiza si hace falta. Si aun así falla, `CONFLUENCE_CA_CERT=/ruta/al/certificado-raiz.pem`: el certificado lo entrega soporte; en macOS se exporta desde Acceso a Llaveros y en Windows desde `certmgr.msc` (Entidades de certificación raíz de confianza, exportar como Base64 .cer y renombrar a .pem) |

Pueden hacer falta los dos a la vez. Para conocer el proxy: en macOS, Ajustes del Sistema → Red → Detalles → Proxies; en Windows, `netsh winhttp show proxy` o Configuración → Red → Proxy. Nunca desactives la verificación TLS con `NODE_TLS_REJECT_UNAUTHORIZED=0`: expondría la cookie a cualquiera en la red.

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

En el chat de Copilot, modo **Agent**:

| Prompt | Qué hace |
|---|---|
| `/sync-guidelines` | Solo Etapa 1: descarga y reporta si los lineamientos cambiaron |
| `/extract-rules` | Etapas 1 y 2: descarga y actualiza las reglas en `guidelines/rules/` |

La primera extracción procesa todas las páginas y puede tardar; el agente avisa el avance por lotes. Las siguientes solo tocan las páginas que cambiaron.

Al final el agente muestra el resumen de reglas por categoría y la lista de páginas fuera de alcance. Revisa esa lista: si alguna página excluida sí contiene reglas de contrato, pídele que la reclasifique.

Desde la terminal, sin el agente:

```bash
npm run guidelines:sync      # descarga a guidelines/.cache · 0 ok · 2 error
npm run guidelines:list      # índice de páginas descargadas (espacio, título, id), sin contenido
npm run guidelines:check     # 0 vigentes · 1 cambios · 2 error
npm run rules:status         # qué páginas faltan por clasificar, extraer o reextraer · 0 al día · 1 pendientes
npm run rules:validate       # estructura, ids y fuentes de las reglas · 0 ok · 2 errores
npm run rules:summary        # reglas por categoría y verificación; páginas fuera de alcance
```

### Formato de una regla

```yaml
- id: URI-012                      # prefijo de categoría + correlativo, único
  regla: "Los nombres de recursos van en plural, en inglés y en kebab-case."   # fiel a la página
  alcance: [interna, externa]      # a qué APIs aplica
  aplica_a: paths                  # paths | operations | parameters | headers | request-body | responses | schemas | security | info | naming | general
  verificacion: automatica         # automatica · asistida · manual
  como_verificar: "Cada segmento de path que no sea parámetro está en plural, en inglés, minúsculas y guiones."
  ejemplo: "/customers/{customerId}/accounts"
  fuente: { pageId: "123456", titulo: "Nomenclatura de Recursos", url: "https://..." }
```

Las reglas y el catálogo **sí se versionan**: son el resultado valioso del proceso y lo que usarán las etapas de generación y verificación.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `Sin credenciales` | No existe `.env` o está vacío | Seguir "Conectar Confluence" |
| `fallo de red [...]` | Proxy corporativo o certificado de inspección TLS | Ver "Red corporativa" |
| `401 sin autenticar` o `Respuesta no JSON` | La cookie expiró, o el token es incorrecto | Copiar una cookie nueva desde el navegador, o revisar email y token |
| `403 sin permiso` | Sin lectura en ese espacio | Pedir acceso de lectura al espacio indicado |
| `404 no existe` | El id de la URL en `sources.yaml` es incorrecto | Gobierno corrige el link |
| `sources.yaml todavía tiene URLs de ejemplo` | Fuentes sin configurar | Gobierno completa `sources.yaml` |
| `no tienen la forma https://<sitio>/wiki/.../pages/<id>/ o /folder/<id>` | Se usó un link corto | Copiar el link completo desde el navegador |
| `no contiene páginas` | La carpeta está vacía | Revisar la carpeta en Confluence |
| `OMITIDAS N páginas sin texto` | Páginas que solo agrupan subpáginas, sin cuerpo | No es un error. Confirmar en Confluence que no tienen lineamientos; si alguna sí tiene, reportarla |
| Faltan páginas de una carpeta | Son de otro tipo (pizarras, bases de datos) o están en un espacio sin permiso | Comparar el conteo `CARPETA` con Confluence; el script solo descarga páginas |
| Marca CAMBIADA y nadie editó la página | Cambió la conversión a Markdown entre ejecuciones | La Etapa 2 reextrae la página; si las reglas quedan iguales, no hay nada que hacer |

## Estructura

```
.github/agents/rest-contract.agent.md      agente (Etapas 1 y 2 activas)
.github/prompts/sync-guidelines.prompt.md  /sync-guidelines
.github/prompts/extract-rules.prompt.md    /extract-rules
.github/CODEOWNERS                         Gobierno aprueba cambios en guidelines/
guidelines/sources.yaml                    páginas y carpetas de Confluence (Gobierno)
guidelines/sources.lock.json               última versión procesada (la genera guidelines:approve)
guidelines/rules/<categoria>.yaml          reglas verificables por categoría
guidelines/rules/catalogo-esquemas.yaml    esquemas canónicos de dominio
guidelines/rules/pages.yaml                registro de clasificación y versión de cada página
guidelines/.cache/                         descarga local de trabajo (no se versiona)
.env.example                               plantilla de credenciales (copiar a .env, que no se versiona)
scripts/sync.mjs                           descarga desde la API REST de Confluence
scripts/guidelines.mjs                     list / check / approve
scripts/rules.mjs                          status / classify / forget / done / validate / summary
scripts/lib.mjs                            utilidades compartidas
```
