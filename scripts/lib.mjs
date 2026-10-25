// Utilidades compartidas por los scripts de lineamientos y reglas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dirGuidelines = path.join(raiz, 'guidelines');
export const cacheDir = path.join(dirGuidelines, '.cache');
export const sourcesPath = path.join(dirGuidelines, 'sources.yaml');
export const lockPath = path.join(dirGuidelines, 'sources.lock.json');
export const dirReglas = path.join(dirGuidelines, 'rules');
export const pagesPath = path.join(dirReglas, 'pages.yaml');

export function salir(code, msg) { console.error(`ERROR: ${msg}`); process.exit(code); }

// Una URL de Confluence Cloud identifica una página (/pages/<id>/...) o una carpeta (/folder/<id>).
export const fuenteDeUrl = u => {
  const m = String(u).match(/\/(pages|folder)\/(\d+)/);
  return m ? { tipo: m[1] === 'pages' ? 'page' : 'folder', id: m[2] } : null;
};
export const claveFuente = u => { const f = fuenteDeUrl(u); return f ? `${f.tipo}:${f.id}` : null; };

export function leerFuentes() {
  if (!fs.existsSync(sourcesPath)) salir(2, 'No existe guidelines/sources.yaml');
  const cfg = YAML.parse(fs.readFileSync(sourcesPath, 'utf8')) ?? {};
  const sources = cfg.sources ?? [];
  if (!sources.length) salir(2, 'guidelines/sources.yaml no tiene fuentes');
  const sinConfigurar = sources.filter(s => /TU-SITIO|\/(pages|folder)\/0+(\/|$)/.test(String(s.url)));
  if (sinConfigurar.length) salir(2, 'sources.yaml todavía tiene URLs de ejemplo:\n' + sinConfigurar.map(s => '  - ' + s.url).join('\n'));
  const sinId = sources.filter(s => !fuenteDeUrl(s.url));
  if (sinId.length) salir(2, 'Estas URLs no tienen /pages/<id>/ ni /folder/<id> (usa el link completo, no el link corto):\n' + sinId.map(s => '  - ' + s.url).join('\n'));
  return { cfg, sources };
}

// el hash ignora espacios al final de línea y líneas en blanco repetidas, para no marcar cambios falsos
export const hashCuerpo = cuerpo => 'sha256:' + crypto.createHash('sha256').update(cuerpo.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')).digest('hex');

// Lee guidelines/.cache/*.md (frontmatter + contenido). Con { conCuerpo: true } incluye el Markdown de cada página.
export function leerCache({ conCuerpo = false } = {}) {
  if (!fs.existsSync(cacheDir)) salir(2, 'No existe guidelines/.cache. Ejecuta primero npm run guidelines:sync');
  const paginas = [];
  for (const archivo of fs.readdirSync(cacheDir).filter(f => f.endsWith('.md')).sort()) {
    const texto = fs.readFileSync(path.join(cacheDir, archivo), 'utf8').replace(/\r\n/g, '\n');
    const m = texto.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) salir(2, `${archivo}: falta el frontmatter con los metadatos de la página`);
    let meta;
    try { meta = YAML.parse(m[1]) ?? {}; } catch (e) { salir(2, `${archivo}: frontmatter inválido (${e.message})`); }
    for (const campo of ['pageId', 'title', 'space', 'url']) if (meta[campo] == null || meta[campo] === '') salir(2, `${archivo}: falta "${campo}" en el frontmatter`);
    const cuerpo = m[2].trim();
    if (!cuerpo) salir(2, `${archivo}: la página está vacía; vuelve a ejecutar npm run guidelines:sync`);
    if (`${meta.pageId}.md` !== archivo) salir(2, `${archivo}: el nombre del archivo debe ser <pageId>.md (${meta.pageId}.md)`);
    const sourceUrl = meta.sourceUrl ?? meta.url;
    if (!fuenteDeUrl(sourceUrl)) salir(2, `${archivo}: "sourceUrl" debe ser la URL de la fuente en sources.yaml (con /pages/<id>/ o /folder/<id>)`);
    paginas.push({
      pageId: String(meta.pageId), title: String(meta.title), space: String(meta.space), url: meta.url, sourceUrl,
      parentId: meta.parentId != null ? String(meta.parentId) : null,
      topic: meta.topic ?? null, version: meta.version ?? null, lastModified: meta.lastModified ?? null,
      contentHash: hashCuerpo(cuerpo),
      ...(conCuerpo ? { cuerpo } : {}),
    });
  }
  paginas.sort((a, b) => a.space.localeCompare(b.space) || a.title.localeCompare(b.title));
  return paginas;
}

export const leerYaml = (ruta, porDefecto) => fs.existsSync(ruta) ? (YAML.parse(fs.readFileSync(ruta, 'utf8')) ?? porDefecto) : porDefecto;
export const escribirYaml = (ruta, datos) => { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, YAML.stringify(datos, { lineWidth: 0 })); };
