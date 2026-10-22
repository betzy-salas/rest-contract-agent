#!/usr/bin/env node
/**
 * Control de vigencia de los lineamientos.
 *
 * El agente descarga las páginas de Confluence a guidelines/.cache/<pageId>.md (con frontmatter de metadatos).
 * Este script compara esa descarga con la versión APROBADA registrada en guidelines/sources.lock.json.
 *
 *   node scripts/guidelines.mjs check     compara caché vs. lock aprobado (no escribe nada)
 *   node scripts/guidelines.mjs approve   registra la caché actual como versión aprobada (escribe el lock)
 *
 * Las fuentes de sources.yaml pueden ser páginas (/pages/<id>/) o carpetas (/folder/<id>).
 * Una carpeta no tiene contenido propio: el agente descarga todas las páginas que contiene
 * (incluidas las de sus subcarpetas) y cada una lleva en el frontmatter `sourceUrl` con la URL de la carpeta.
 *
 * Códigos de salida:
 *   check:   0 = vigentes (sin cambios), 1 = hay cambios o nunca se aprobó, 2 = error
 *   approve: 0 = lock escrito, 2 = error
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(raiz, 'guidelines');
const cacheDir = path.join(dir, '.cache');
const sourcesPath = path.join(dir, 'sources.yaml');
const lockPath = path.join(dir, 'sources.lock.json');
const modo = process.argv[2];

function salir(code, msg) { console.error(`ERROR: ${msg}`); process.exit(code); }
if (!['check', 'approve'].includes(modo)) salir(2, 'Uso: node scripts/guidelines.mjs <check|approve>');

// ---------- fuentes ----------
if (!fs.existsSync(sourcesPath)) salir(2, 'No existe guidelines/sources.yaml');
const cfg = YAML.parse(fs.readFileSync(sourcesPath, 'utf8')) ?? {};
const sources = cfg.sources ?? [];
if (!sources.length) salir(2, 'guidelines/sources.yaml no tiene fuentes');

// Una URL de Confluence Cloud identifica una página (/pages/<id>/...) o una carpeta (/folder/<id>).
const fuenteDeUrl = u => {
  const m = String(u).match(/\/(pages|folder)\/(\d+)/);
  return m ? { tipo: m[1] === 'pages' ? 'page' : 'folder', id: m[2] } : null;
};
const sinConfigurar = sources.filter(s => /TU-SITIO|\/(pages|folder)\/0+(\/|$)/.test(String(s.url)));
if (sinConfigurar.length) salir(2, 'sources.yaml todavía tiene URLs de ejemplo:\n' + sinConfigurar.map(s => '  - ' + s.url).join('\n'));
const sinId = sources.filter(s => !fuenteDeUrl(s.url));
if (sinId.length) salir(2, 'Estas URLs no tienen /pages/<id>/ ni /folder/<id> (usa el link completo, no el link corto):\n' + sinId.map(s => '  - ' + s.url).join('\n'));

// ---------- caché descargada por el agente ----------
if (!fs.existsSync(cacheDir)) salir(2, 'No existe guidelines/.cache. El agente debe descargar primero las páginas de Confluence');
const paginas = [];
for (const archivo of fs.readdirSync(cacheDir).filter(f => f.endsWith('.md')).sort()) {
  const texto = fs.readFileSync(path.join(cacheDir, archivo), 'utf8').replace(/\r\n/g, '\n');
  const m = texto.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) salir(2, `${archivo}: falta el frontmatter con los metadatos de la página`);
  let meta;
  try { meta = YAML.parse(m[1]) ?? {}; } catch (e) { salir(2, `${archivo}: frontmatter inválido (${e.message})`); }
  for (const campo of ['pageId', 'title', 'space', 'url']) if (meta[campo] == null || meta[campo] === '') salir(2, `${archivo}: falta "${campo}" en el frontmatter`);
  const cuerpo = m[2].trim();
  if (!cuerpo) salir(2, `${archivo}: la página está vacía; revisa que el MCP haya devuelto el contenido`);
  if (`${meta.pageId}.md` !== archivo) salir(2, `${archivo}: el nombre del archivo debe ser <pageId>.md (${meta.pageId}.md)`);
  const sourceUrl = meta.sourceUrl ?? meta.url;
  if (!fuenteDeUrl(sourceUrl)) salir(2, `${archivo}: "sourceUrl" debe ser la URL de la fuente en sources.yaml (con /pages/<id>/ o /folder/<id>)`);
  paginas.push({
    pageId: String(meta.pageId),
    title: String(meta.title),
    space: String(meta.space),
    url: meta.url,
    sourceUrl,
    parentId: meta.parentId != null ? String(meta.parentId) : null,
    topic: meta.topic ?? null,
    version: meta.version ?? null,
    lastModified: meta.lastModified ?? null,
    // el hash ignora espacios al final de línea y líneas en blanco repetidas, para no marcar cambios falsos
    contentHash: 'sha256:' + crypto.createHash('sha256').update(cuerpo.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')).digest('hex'),
  });
}
const ids = new Set(paginas.map(p => p.pageId));

// Cada fuente debe haber producido algo: una página, su propio .md; una carpeta, al menos una página con sourceUrl de esa carpeta.
const claveFuente = u => { const f = fuenteDeUrl(u); return f ? `${f.tipo}:${f.id}` : null; };
const paginasPorFuente = new Map();
for (const p of paginas) {
  const k = claveFuente(p.sourceUrl);
  paginasPorFuente.set(k, (paginasPorFuente.get(k) ?? 0) + 1);
}
const paginasFaltantes = sources.filter(s => { const f = fuenteDeUrl(s.url); return f.tipo === 'page' && !ids.has(f.id); });
const carpetasVacias = sources.filter(s => { const f = fuenteDeUrl(s.url); return f.tipo === 'folder' && !paginasPorFuente.get(claveFuente(s.url)); });
if (paginasFaltantes.length) salir(2, 'Páginas de sources.yaml que no se descargaron:\n' + paginasFaltantes.map(s => '  - ' + s.url).join('\n'));
if (carpetasVacias.length) salir(2, 'Carpetas de sources.yaml sin páginas descargadas (la carpeta está vacía o el agente no pudo listar su contenido):\n' + carpetasVacias.map(s => '  - ' + s.url).join('\n'));
paginas.sort((a, b) => a.space.localeCompare(b.space) || a.title.localeCompare(b.title));

// ---------- comparación con la versión aprobada ----------
const aprobado = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
const previas = new Map((aprobado?.pages ?? []).map(p => [p.pageId, p]));
const nuevas = [], cambiadas = [], iguales = [];
for (const p of paginas) {
  const prev = previas.get(p.pageId);
  if (!prev) nuevas.push(p);
  else if (prev.contentHash !== p.contentHash) cambiadas.push({ ...p, versionAprobada: prev.version });
  else iguales.push(p);
}
const eliminadas = (aprobado?.pages ?? []).filter(p => !ids.has(p.pageId));
const hayCambios = !aprobado || nuevas.length + cambiadas.length + eliminadas.length > 0;
const etiqueta = p => `[${p.space}] ${p.title} (id ${p.pageId}${p.version != null ? ', v' + p.version : ''})`;

if (modo === 'check') {
  if (!aprobado) console.log('Lineamientos: NUNCA APROBADOS · aún no existe guidelines/sources.lock.json');
  else console.log(`Lineamientos: ${hayCambios ? 'CON CAMBIOS' : 'VIGENTES'} · aprobados el ${aprobado.approvedAt}${aprobado.approvedBy ? ' por ' + aprobado.approvedBy : ''}`);
  console.log(`  ${paginas.length} páginas · ${nuevas.length} nuevas · ${cambiadas.length} cambiadas · ${eliminadas.length} eliminadas · ${iguales.length} sin cambios`);
  // Por carpeta, cuántas páginas se leyeron: sirve para comparar con lo que se ve en Confluence.
  for (const s of sources.filter(s => fuenteDeUrl(s.url).tipo === 'folder')) console.log(`  CARPETA    ${s.url} · ${paginasPorFuente.get(claveFuente(s.url))} páginas`);
  for (const p of nuevas) console.log(`  NUEVA      ${etiqueta(p)}`);
  for (const p of cambiadas) console.log(`  CAMBIADA   ${etiqueta(p)}${p.versionAprobada != null ? ' · aprobada: v' + p.versionAprobada : ''}`);
  for (const p of eliminadas) console.log(`  ELIMINADA  ${etiqueta(p)}`);
  process.exit(hayCambios ? 1 : 0);
}

// approve
let approvedBy = null;
try { approvedBy = execSync('git config user.name', { cwd: raiz, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { /* sin git */ }
const lock = { approvedAt: new Date().toISOString(), approvedBy, pages: paginas };
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log(`Aprobados ${paginas.length} páginas de lineamientos · escrito guidelines/sources.lock.json`);
process.exit(0);
