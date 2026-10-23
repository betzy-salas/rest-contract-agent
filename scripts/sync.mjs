#!/usr/bin/env node
/**
 * Descarga los lineamientos de Confluence Cloud a guidelines/.cache/<pageId>.md.
 *
 *   node scripts/sync.mjs          (o: npm run guidelines:sync)
 *
 * Lee las fuentes de guidelines/sources.yaml (páginas /pages/<id>/ y carpetas /folder/<id>) y usa la API REST v2
 * de Confluence. No usa el MCP de Atlassian. Solo hace peticiones GET: nunca modifica nada en Confluence.
 *
 * Credenciales: se leen de variables de entorno o de un archivo .env en la raíz del repo (ignorado por git).
 *   CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN   token de API (recomendado; sirve para una cuenta de servicio)
 *   CONFLUENCE_COOKIE                         cabecera Cookie de tu sesión del navegador (temporal: expira)
 * Red corporativa (opcionales, también en .env):
 *   HTTPS_PROXY / HTTP_PROXY / NO_PROXY       proxy de salida (el navegador lo usa solo; Node necesita que se lo digan)
 *   CONFLUENCE_CA_CERT                        ruta a un .pem con el certificado raíz de la empresa, si la red inspecciona TLS
 *
 * Las páginas sin texto (páginas "contenedor" que solo agrupan subpáginas) se omiten y se listan como OMITIDA;
 * no son un error, pero el usuario debe confirmar que de verdad no tienen lineamientos.
 *
 * Códigos de salida: 0 = descarga completa · 2 = error (credenciales, permisos, carpeta vacía, página ilegible)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { fetch, EnvHttpProxyAgent } from 'undici';

// Confiar en los certificados del sistema operativo (donde la empresa instala el suyo), igual que el navegador.
// Node solo los carga con el flag --use-system-ca, así que si está disponible y no está activo nos relanzamos con él.
// Se desactiva con CONFLUENCE_NO_SYSTEM_CA=1.
const flagSistema = '--use-system-ca';
const flagActivo = process.execArgv.includes(flagSistema) || (process.env.NODE_OPTIONS ?? '').includes(flagSistema);
if (!flagActivo && !process.env.CONFLUENCE_NO_SYSTEM_CA && process.allowedNodeEnvironmentFlags.has(flagSistema)) {
  const r = spawnSync(process.execPath, [flagSistema, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, CONFLUENCE_NO_SYSTEM_CA: '1', CONFLUENCE_SYSTEM_CA_ACTIVO: '1' } });
  process.exit(r.status ?? 1);
}
const usaCaSistema = flagActivo || process.env.CONFLUENCE_SYSTEM_CA_ACTIVO === '1';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(raiz, 'guidelines');
const cacheDir = path.join(dir, '.cache');
const sourcesPath = path.join(dir, 'sources.yaml');

function salir(msg) { console.error(`ERROR: ${msg}`); process.exit(2); }

// ---------- .env ----------
const envPath = path.join(raiz, '.env');
if (fs.existsSync(envPath)) {
  for (const linea of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = linea.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || linea.trim().startsWith('#')) continue;
    const valor = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] == null) process.env[m[1]] = valor;
  }
}
const { CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_COOKIE } = process.env;
let auth, modoAuth;
if (CONFLUENCE_EMAIL && CONFLUENCE_API_TOKEN) {
  auth = { Authorization: 'Basic ' + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64') };
  modoAuth = `token de API (${CONFLUENCE_EMAIL})`;
} else if (CONFLUENCE_COOKIE) {
  auth = { Cookie: CONFLUENCE_COOKIE.trim() };
  modoAuth = 'cookie de sesión del navegador';
} else {
  salir('Sin credenciales. Define CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN, o CONFLUENCE_COOKIE, en el entorno o en .env (ver README, "Conectar Confluence")');
}

// ---------- fuentes ----------
if (!fs.existsSync(sourcesPath)) salir('No existe guidelines/sources.yaml');
const cfg = YAML.parse(fs.readFileSync(sourcesPath, 'utf8')) ?? {};
const sources = cfg.sources ?? [];
if (!sources.length) salir('guidelines/sources.yaml no tiene fuentes');
const fuenteDeUrl = u => {
  const m = String(u).match(/^(https?:\/\/[^/]+)\/wiki\/.*\/(pages|folder)\/(\d+)/);
  return m ? { origen: m[1], tipo: m[2] === 'pages' ? 'page' : 'folder', id: m[3] } : null;
};
const sinConfigurar = sources.filter(s => /TU-SITIO|\/(pages|folder)\/0+(\/|$)/.test(String(s.url)));
if (sinConfigurar.length) salir('sources.yaml todavía tiene URLs de ejemplo:\n' + sinConfigurar.map(s => '  - ' + s.url).join('\n'));
const sinId = sources.filter(s => !fuenteDeUrl(s.url));
if (sinId.length) salir('Estas URLs no tienen la forma https://<sitio>/wiki/.../pages/<id>/ o /folder/<id>:\n' + sinId.map(s => '  - ' + s.url).join('\n'));

// ---------- red: proxy y certificado corporativo ----------
const caPath = process.env.CONFLUENCE_CA_CERT;
if (caPath && !fs.existsSync(caPath)) salir(`CONFLUENCE_CA_CERT apunta a un archivo que no existe: ${caPath}`);
const tlsOpts = caPath ? { ca: [...tls.rootCertificates, fs.readFileSync(caPath, 'utf8')] } : {};
const dispatcher = new EnvHttpProxyAgent({ connect: tlsOpts, requestTls: tlsOpts, proxyTls: tlsOpts });
const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY ?? null;
const describirProxy = () => { try { const u = new URL(proxy); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; } catch { return proxy; } };

// Traduce un "fetch failed" de Node a una causa accionable.
function fallaDeRed(e, url) {
  const causas = []; for (let c = e; c; c = c.cause) causas.push(c);
  const code = causas.map(c => c.code).find(Boolean) ?? '';
  const detalle = causas.map(c => c.message).filter(Boolean).join(' <- ');
  const pista = /ENOTFOUND|EAI_AGAIN/.test(code)
    ? 'No se pudo resolver el nombre del servidor. En la red de la empresa suele faltar el proxy: define HTTPS_PROXY en .env (ver README, "Red corporativa").'
    : /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code)
      ? 'No se pudo conectar con el servidor. Si el navegador sí entra, probablemente la red exige un proxy: define HTTPS_PROXY en .env (ver README, "Red corporativa").'
      : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|ERR_TLS/.test(code)
        ? `El certificado TLS no es de confianza para Node: la red de la empresa inspecciona el tráfico. ${usaCaSistema ? 'Ya se usan los certificados del sistema y no basta: pide a soporte' : 'Tu Node no soporta --use-system-ca (actualiza a 22.15 o superior) o pide a soporte'} el certificado raíz corporativo y define CONFLUENCE_CA_CERT=/ruta/al/certificado.pem en .env (ver README, "Red corporativa").`
        : 'Fallo de red sin clasificar. Revisa conexión, proxy y certificados (ver README, "Red corporativa").';
  return `fallo de red${code ? ` [${code}]` : ''} al pedir ${url}: ${detalle}. ${pista}`;
}

// ---------- API ----------
async function api(origen, ruta) {
  const url = new URL(ruta, origen);
  let res;
  try { res = await fetch(url, { headers: { Accept: 'application/json', ...auth }, dispatcher }); }
  catch (e) { throw new Error(fallaDeRed(e, url)); }
  if (res.status === 401) throw new Error(`401 sin autenticar en ${url}. ${modoAuth === 'cookie de sesión del navegador' ? 'La cookie expiró o no es de este sitio: copia una nueva desde el navegador.' : 'Revisa el email y el token de API.'}`);
  if (res.status === 403) throw new Error(`403 sin permiso para ${url}. Pide acceso de lectura al espacio.`);
  if (res.status === 404) throw new Error(`404 no existe ${url}. Revisa el id en sources.yaml.`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} en ${url}`);
  const tipo = res.headers.get('content-type') ?? '';
  if (!tipo.includes('json')) throw new Error(`Respuesta no JSON (${tipo || 'sin content-type'}) en ${url}. Con cookie, suele ser que la sesión expiró y Confluence devolvió la página de login.`);
  return res.json();
}
async function todos(origen, ruta) { // recorre la paginación por cursor (_links.next)
  const items = [];
  let siguiente = ruta;
  while (siguiente) {
    const data = await api(origen, siguiente);
    items.push(...(data.results ?? []));
    siguiente = data._links?.next ?? null;
  }
  return items;
}
const espacios = new Map();
async function claveEspacio(origen, spaceId) {
  const k = `${origen}#${spaceId}`;
  if (!espacios.has(k)) espacios.set(k, (await api(origen, `/wiki/api/v2/spaces/${spaceId}`)).key);
  return espacios.get(k);
}

// ---------- HTML -> Markdown ----------
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.use(gfm);
// Confluence marca el lenguaje de los bloques de código en data-syntaxhighlighter-params="brush: json; ..."
td.addRule('codigoConfluence', {
  filter: n => n.nodeName === 'PRE',
  replacement: (_c, n) => {
    const brush = (n.getAttribute('data-syntaxhighlighter-params') ?? '').match(/brush:\s*([\w+-]+)/)?.[1] ?? '';
    return `\n\n\`\`\`${brush}\n${n.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
  },
});
td.remove(['script', 'style']);
const aMarkdown = html => td.turndown(html).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

// ---------- descarga ----------
fs.mkdirSync(cacheDir, { recursive: true });
for (const f of fs.readdirSync(cacheDir)) if (f.endsWith('.md')) fs.unlinkSync(path.join(cacheDir, f));

const escritas = new Set();
const fallas = [];
const omitidas = [];
async function guardarPagina({ origen, id, sourceUrl, topic, parentId }) {
  if (escritas.has(id)) return true;
  let p;
  try { p = await api(origen, `/wiki/api/v2/pages/${id}?body-format=export_view`); }
  catch (e) { fallas.push(`página ${id}: ${e.message}`); return false; }
  let cuerpo = aMarkdown(p.body?.export_view?.value ?? '');
  if (!cuerpo) { // algunas macros solo renderizan en "view"; segundo intento antes de darla por vacía
    try { cuerpo = aMarkdown((await api(origen, `/wiki/api/v2/pages/${id}?body-format=view`)).body?.view?.value ?? ''); }
    catch { /* nos quedamos con el resultado del primer intento */ }
  }
  const space = await claveEspacio(origen, p.spaceId);
  const url = p._links?.webui ? `${origen}/wiki${p._links.webui}` : `${origen}/wiki/spaces/${space}/pages/${id}`;
  if (!cuerpo) { omitidas.push({ id, title: p.title, space, url }); return false; }
  const front = {
    pageId: String(p.id), title: p.title, space, url, sourceUrl,
    parentId: parentId ?? (p.parentId != null ? String(p.parentId) : null),
    topic: topic ?? null,
    version: p.version?.number ?? null,
    lastModified: p.version?.createdAt ?? null,
  };
  fs.writeFileSync(path.join(cacheDir, `${p.id}.md`), '---\n' + YAML.stringify(front) + '---\n\n' + cuerpo + '\n');
  escritas.add(id);
  return true;
}
// Recorre el contenido de una página o carpeta: descarga las páginas y entra en subpáginas y subcarpetas.
async function recorrer({ origen, tipo, id, sourceUrl, topic }, contador) {
  const hijos = await todos(origen, `/wiki/api/v2/${tipo === 'page' ? 'pages' : 'folders'}/${id}/direct-children?limit=100`);
  for (const h of hijos) {
    if (h.type === 'page') {
      if (await guardarPagina({ origen, id: String(h.id), sourceUrl, topic, parentId: id })) contador.paginas++;
      await recorrer({ origen, tipo: 'page', id: String(h.id), sourceUrl, topic }, contador);
    } else if (h.type === 'folder') {
      contador.carpetas++;
      await recorrer({ origen, tipo: 'folder', id: String(h.id), sourceUrl, topic }, contador);
    } // whiteboards, bases de datos y embeds no tienen texto de lineamientos: se omiten
  }
}

console.log(`Autenticación: ${modoAuth}`);
console.log(`Red: ${proxy ? 'proxy ' + describirProxy() : 'sin proxy'} · certificados ${usaCaSistema ? 'del sistema + Node' : 'solo de Node'}${caPath ? ' + ' + caPath : ''}`);
for (const s of sources) {
  const f = fuenteDeUrl(s.url);
  const comun = { origen: f.origen, id: f.id, sourceUrl: s.url, topic: s.topic ?? null };
  const contador = { paginas: 0, carpetas: 0 };
  try {
    if (f.tipo === 'page') {
      if (await guardarPagina({ ...comun, parentId: null })) contador.paginas++;
      if (s.includeChildren) await recorrer({ ...comun, tipo: 'page' }, contador);
      console.log(`PÁGINA     ${s.url} · ${contador.paginas} páginas${s.includeChildren ? ' (con subpáginas)' : ''}`);
    } else {
      const carpeta = await api(f.origen, `/wiki/api/v2/folders/${f.id}`);
      await recorrer({ ...comun, tipo: 'folder' }, contador);
      console.log(`CARPETA    ${s.url} "${carpeta.title}" · ${contador.paginas} páginas · ${contador.carpetas} subcarpetas`);
      if (contador.paginas === 0) fallas.push(`carpeta ${f.id} "${carpeta.title}": no contiene páginas (o no se pudo listar su contenido)`);
    }
  } catch (e) { fallas.push(`${f.tipo === 'page' ? 'página' : 'carpeta'} ${f.id}: ${e.message}`); }
}
if (omitidas.length) {
  console.log(`OMITIDAS   ${omitidas.length} páginas sin texto (suelen ser páginas que solo agrupan subpáginas; confirma en Confluence que no tienen lineamientos):`);
  for (const o of omitidas) console.log(`  - [${o.space}] ${o.title} (id ${o.id}) ${o.url}`);
}
console.log(`Descargadas ${escritas.size} páginas en guidelines/.cache`);
if (!escritas.size && !fallas.length) fallas.push('ninguna fuente produjo páginas con texto');
if (fallas.length) salir('La descarga quedó incompleta. No sigas con lineamientos incompletos:\n' + fallas.map(x => '  - ' + x).join('\n'));
