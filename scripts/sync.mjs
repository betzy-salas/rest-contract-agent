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
 *
 * Códigos de salida: 0 = descarga completa · 2 = error (credenciales, permisos, carpeta vacía, página ilegible)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
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

// ---------- API ----------
async function api(origen, ruta) {
  const url = new URL(ruta, origen);
  const res = await fetch(url, { headers: { Accept: 'application/json', ...auth } });
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
async function guardarPagina({ origen, id, sourceUrl, topic, parentId }) {
  if (escritas.has(id)) return true;
  let p;
  try { p = await api(origen, `/wiki/api/v2/pages/${id}?body-format=export_view`); }
  catch (e) { fallas.push(`página ${id}: ${e.message}`); return false; }
  const cuerpo = aMarkdown(p.body?.export_view?.value ?? '');
  if (!cuerpo) { fallas.push(`página ${id} "${p.title}": el contenido llegó vacío`); return false; }
  const space = await claveEspacio(origen, p.spaceId);
  const url = p._links?.webui ? `${origen}/wiki${p._links.webui}` : `${origen}/wiki/spaces/${space}/pages/${id}`;
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
console.log(`Descargadas ${escritas.size} páginas en guidelines/.cache`);
if (fallas.length) salir('La descarga quedó incompleta. No sigas con lineamientos incompletos:\n' + fallas.map(x => '  - ' + x).join('\n'));
