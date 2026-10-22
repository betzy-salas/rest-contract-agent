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
const idDeUrl = u => (String(u).match(/\/pages\/(\d+)/) ?? [])[1] ?? null;
const sinConfigurar = sources.filter(s => /TU-SITIO|\/pages\/0+\//.test(String(s.url)));
if (sinConfigurar.length) salir(2, 'sources.yaml todavía tiene URLs de ejemplo:\n' + sinConfigurar.map(s => '  - ' + s.url).join('\n'));
const sinId = sources.filter(s => !idDeUrl(s.url));
if (sinId.length) salir(2, 'Estas URLs no tienen /pages/<id>/ (usa el link completo, no el link corto):\n' + sinId.map(s => '  - ' + s.url).join('\n'));

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
  paginas.push({
    pageId: String(meta.pageId),
    title: String(meta.title),
    space: String(meta.space),
    url: meta.url,
    sourceUrl: meta.sourceUrl ?? meta.url,
    parentId: meta.parentId != null ? String(meta.parentId) : null,
    topic: meta.topic ?? null,
    version: meta.version ?? null,
    lastModified: meta.lastModified ?? null,
    // el hash ignora espacios al final de línea y líneas en blanco repetidas, para no marcar cambios falsos
    contentHash: 'sha256:' + crypto.createHash('sha256').update(cuerpo.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')).digest('hex'),
  });
}
const ids = new Set(paginas.map(p => p.pageId));
const faltantes = sources.filter(s => !ids.has(idDeUrl(s.url)));
if (faltantes.length) salir(2, 'Fuentes de sources.yaml que no se descargaron:\n' + faltantes.map(s => '  - ' + s.url).join('\n'));
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
