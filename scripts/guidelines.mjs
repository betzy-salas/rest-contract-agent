#!/usr/bin/env node
/**
 * Control de vigencia de los lineamientos.
 *
 * El agente descarga las páginas de Confluence a guidelines/.cache/<pageId>.md (con frontmatter de metadatos).
 * Este script compara esa descarga con la última versión PROCESADA, registrada en guidelines/sources.lock.json
 * (la versión de la que se extrajeron las reglas de guidelines/rules/).
 *
 *   node scripts/guidelines.mjs check     compara caché vs. lock aprobado (no escribe nada)
 *   node scripts/guidelines.mjs approve   registra la caché actual como versión procesada (escribe el lock)
 *   node scripts/guidelines.mjs list      imprime el índice de páginas descargadas (espacio, título, id, fuente), sin contenido
 *
 * Las fuentes de sources.yaml pueden ser páginas (/pages/<id>/) o carpetas (/folder/<id>).
 * Una carpeta no tiene contenido propio: el agente descarga todas las páginas que contiene
 * (incluidas las de sus subcarpetas) y cada una lleva en el frontmatter `sourceUrl` con la URL de la carpeta.
 *
 * Códigos de salida:
 *   check:   0 = vigentes (sin cambios), 1 = hay cambios o nunca se procesó, 2 = error
 *   approve: 0 = lock escrito, 2 = error
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { raiz, lockPath, salir, fuenteDeUrl, claveFuente, leerFuentes, leerCache } from './lib.mjs';

const modo = process.argv[2];
if (!['check', 'approve', 'list'].includes(modo)) salir(2, 'Uso: node scripts/guidelines.mjs <check|approve|list>');

const { sources } = leerFuentes();
const paginas = leerCache();
const ids = new Set(paginas.map(p => p.pageId));

// Cada fuente debe haber producido algo: una página, su propio .md (o alguna subpágina); una carpeta, al menos una página con sourceUrl de esa carpeta.
const paginasPorFuente = new Map();
for (const p of paginas) {
  const k = claveFuente(p.sourceUrl);
  paginasPorFuente.set(k, (paginasPorFuente.get(k) ?? 0) + 1);
}
const paginasFaltantes = sources.filter(s => { const f = fuenteDeUrl(s.url); return f.tipo === 'page' && !ids.has(f.id) && !paginasPorFuente.get(claveFuente(s.url)); });
const carpetasVacias = sources.filter(s => { const f = fuenteDeUrl(s.url); return f.tipo === 'folder' && !paginasPorFuente.get(claveFuente(s.url)); });
if (paginasFaltantes.length) salir(2, 'Páginas de sources.yaml que no se descargaron (ni ellas ni ninguna subpágina):\n' + paginasFaltantes.map(s => '  - ' + s.url).join('\n'));
if (carpetasVacias.length) salir(2, 'Carpetas de sources.yaml sin páginas descargadas (la carpeta está vacía o el agente no pudo listar su contenido):\n' + carpetasVacias.map(s => '  - ' + s.url).join('\n'));

if (modo === 'list') {
  // Índice sin contenido: sirve para ver qué temas cubren los lineamientos sin exponer su texto.
  const porFuente = new Map();
  for (const p of paginas) { const k = p.sourceUrl; if (!porFuente.has(k)) porFuente.set(k, []); porFuente.get(k).push(p); }
  console.log(`${paginas.length} páginas en ${porFuente.size} fuentes`);
  for (const [fuente, lista] of porFuente) {
    const s = sources.find(s => s.url === fuente);
    console.log(`\nFUENTE ${fuente}${s?.topic ? ` · topic: ${s.topic}` : ''} · ${lista.length} páginas`);
    const porPadre = new Map();
    for (const p of lista) { const k = p.parentId ?? ''; if (!porPadre.has(k)) porPadre.set(k, []); porPadre.get(k).push(p); }
    const idsLista = new Set(lista.map(p => p.pageId));
    const raices = lista.filter(p => !p.parentId || !idsLista.has(p.parentId));
    const imprimir = (p, nivel) => {
      console.log(`${'  '.repeat(nivel + 1)}- [${p.space}] ${p.title} (id ${p.pageId}${p.version != null ? ', v' + p.version : ''})`);
      for (const h of porPadre.get(p.pageId) ?? []) imprimir(h, nivel + 1);
    };
    for (const r of raices) imprimir(r, 0);
  }
  process.exit(0);
}

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
  if (!aprobado) console.log('Lineamientos: NUNCA PROCESADOS · aún no existe guidelines/sources.lock.json');
  else console.log(`Lineamientos: ${hayCambios ? 'CON CAMBIOS' : 'VIGENTES'} · última versión procesada el ${aprobado.approvedAt}${aprobado.approvedBy ? ' por ' + aprobado.approvedBy : ''}`);
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
console.log(`Registradas ${paginas.length} páginas como versión procesada · escrito guidelines/sources.lock.json`);
process.exit(0);
