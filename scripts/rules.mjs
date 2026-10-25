#!/usr/bin/env node
/**
 * Reglas verificables extraídas de los lineamientos (Etapa 2).
 *
 * El agente clasifica cada página descargada en una categoría, extrae sus reglas a guidelines/rules/<categoria>.yaml
 * y registra con qué versión de la página lo hizo. Este script lleva ese registro y valida el resultado; nunca
 * escribe reglas por su cuenta.
 *
 *   node scripts/rules.mjs status                          qué páginas faltan por clasificar, extraer o reextraer
 *   node scripts/rules.mjs classify <pageId> <categoria> [--razon "texto"]
 *   node scripts/rules.mjs forget <pageId>                 borra las reglas de esa página (antes de reextraer, o si se eliminó)
 *   node scripts/rules.mjs done <pageId> [<pageId>...]     marca la(s) página(s) como extraída(s) con su versión actual
 *   node scripts/rules.mjs validate                        valida estructura, ids y fuentes de todas las reglas
 *   node scripts/rules.mjs summary                         resumen por categoría, alcance y verificación; páginas excluidas
 *
 * Códigos de salida: status 0 = todo al día, 1 = hay pendientes · validate 0 = ok, 2 = errores · resto 0 ok, 2 error
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirReglas, pagesPath, salir, leerCache, leerYaml, escribirYaml } from './lib.mjs';

export const CATEGORIAS = {
  'nomenclatura':            { prefijo: 'NOM', descripcion: 'nombres de APIs, recursos, campos, enums; estructura de nombres' },
  'uri':                     { prefijo: 'URI', descripcion: 'diseño y taxonomía de URI, path params, query params' },
  'metodos-y-operaciones':   { prefijo: 'OPE', descripcion: 'métodos HTTP, recursos y controladores, operationId, descripciones de endpoint' },
  'cabeceras':               { prefijo: 'HDR', descripcion: 'headers comunes, de petición y de respuesta' },
  'parametros':              { prefijo: 'PAR', descripcion: 'parámetros: obligatoriedad, formato, ubicación' },
  'paginacion':              { prefijo: 'PAG', descripcion: 'paginación en GET y POST' },
  'codigos-de-respuesta':    { prefijo: 'STA', descripcion: 'códigos de estado HTTP por operación y situación' },
  'errores':                 { prefijo: 'ERR', descripcion: 'estructura y semántica del cuerpo de error' },
  'estructura-de-mensajes':  { prefijo: 'MSG', descripcion: 'payload, estructura de objetos, diseño del mensaje, uso de referencias' },
  'tipos-de-datos':          { prefijo: 'TIP', descripcion: 'tipos y formatos de datos, enums, tipos comunes, campos deprecados' },
  'versionamiento':          { prefijo: 'VER', descripcion: 'versionado del API y del contrato' },
  'seguridad':               { prefijo: 'SEG', descripcion: 'esquemas de seguridad en OpenAPI' },
  'documentacion-openapi':   { prefijo: 'DOC', descripcion: 'guía de estilo y referencia OpenAPI: info, secciones, descripciones' },
  'patrones':                { prefijo: 'PAT', descripcion: 'patrones de diseño: callback, wrapper, asincronía sobre REST' },
  'otros':                   { prefijo: 'OTR', descripcion: 'reglas de contrato REST que no encajan en las demás (revisar si merecen categoría)' },
  'esquemas-de-dominio':     { prefijo: null,  descripcion: 'catálogo de esquemas canónicos (BIAN, dominios) para reutilizar; no son reglas' },
  'fuera-de-alcance':        { prefijo: null,  descripcion: 'no aplica a contratos REST (GraphQL, eventos, procesos, desarrollo); requiere razón' },
};
const APLICA_A = ['paths', 'operations', 'parameters', 'headers', 'request-body', 'responses', 'schemas', 'security', 'info', 'naming', 'general'];
const VERIFICACION = ['automatica', 'asistida', 'manual'];
const ALCANCE = ['interna', 'externa'];
const CATALOGO = 'catalogo-esquemas.yaml';

const modo = process.argv[2];
const args = process.argv.slice(3);
const usos = Object.keys(CATEGORIAS).join(' | ');
if (!['status', 'classify', 'forget', 'done', 'validate', 'summary'].includes(modo)) salir(2, 'Uso: node scripts/rules.mjs <status|classify|forget|done|validate|summary>');

const paginas = leerCache();
const porId = new Map(paginas.map(p => [p.pageId, p]));
const registro = leerYaml(pagesPath, { pages: {} });
registro.pages ??= {};
const guardarRegistro = () => escribirYaml(pagesPath, registro);

const archivosReglas = () => fs.existsSync(dirReglas)
  ? fs.readdirSync(dirReglas).filter(f => f.endsWith('.yaml') && f !== 'pages.yaml' && f !== CATALOGO).sort()
  : [];
const leerReglas = archivo => {
  const datos = leerYaml(path.join(dirReglas, archivo), null);
  if (datos == null) return [];
  if (!Array.isArray(datos)) salir(2, `${archivo}: debe ser una lista YAML de reglas (cada una empieza con "- id:")`);
  return datos;
};

// ---------- status ----------
if (modo === 'status') {
  const sinClasificar = [], pendientes = [], cambiadas = [], alDia = [], excluidas = [];
  for (const p of paginas) {
    const r = registro.pages[p.pageId];
    if (!r?.category) sinClasificar.push(p);
    else if (r.category === 'fuera-de-alcance') excluidas.push(p);
    else if (!r.contentHash) pendientes.push({ ...p, category: r.category });
    else if (r.contentHash !== p.contentHash) cambiadas.push({ ...p, category: r.category });
    else alDia.push(p);
  }
  const eliminadas = Object.entries(registro.pages).filter(([id]) => !porId.has(id)).map(([id, r]) => ({ pageId: id, ...r }));
  const hayPendientes = sinClasificar.length + pendientes.length + cambiadas.length + eliminadas.length > 0;
  console.log(`Reglas: ${hayPendientes ? 'PENDIENTES' : 'AL DÍA'} · ${paginas.length} páginas · ${alDia.length} al día · ${excluidas.length} fuera de alcance · ${sinClasificar.length} sin clasificar · ${pendientes.length} por extraer · ${cambiadas.length} cambiadas · ${eliminadas.length} eliminadas`);
  const linea = (p, extra = '') => `  [${p.space}] ${p.title} (id ${p.pageId})${extra}`;
  if (sinClasificar.length) { console.log('\nSIN CLASIFICAR · ejecuta: npm run rules:classify -- <pageId> <categoria> [--razon "..."]'); for (const p of sinClasificar) console.log(linea(p)); }
  if (pendientes.length) { console.log('\nPOR EXTRAER · lee guidelines/.cache/<pageId>.md, escribe las reglas y ejecuta: npm run rules:done -- <pageId>'); for (const p of pendientes) console.log(linea(p, ` · ${p.category}`)); }
  if (cambiadas.length) { console.log('\nCAMBIADAS · la página cambió desde la extracción: npm run rules:forget -- <pageId>, reextrae y npm run rules:done -- <pageId>'); for (const p of cambiadas) console.log(linea(p, ` · ${p.category}`)); }
  if (eliminadas.length) { console.log('\nELIMINADAS · ya no están en Confluence: npm run rules:forget -- <pageId> (retira sus reglas y el registro)'); for (const p of eliminadas) console.log(`  ${p.title ?? '?'} (id ${p.pageId}) · ${p.category}`); }
  process.exit(hayPendientes ? 1 : 0);
}

// ---------- classify ----------
if (modo === 'classify') {
  const [pageId, categoria] = args;
  const iRazon = args.indexOf('--razon');
  const razon = iRazon >= 0 ? args[iRazon + 1] : null;
  if (!pageId || !categoria) salir(2, `Uso: rules.mjs classify <pageId> <categoria> [--razon "texto"]\nCategorías: ${usos}`);
  const p = porId.get(pageId);
  if (!p) salir(2, `No hay ninguna página con id ${pageId} en guidelines/.cache`);
  if (!CATEGORIAS[categoria]) salir(2, `Categoría desconocida "${categoria}". Válidas: ${usos}`);
  if (categoria === 'fuera-de-alcance' && !razon) salir(2, 'fuera-de-alcance requiere --razon "por qué no aplica a contratos REST"');
  const previo = registro.pages[pageId];
  registro.pages[pageId] = { title: p.title, space: p.space, url: p.url, category: categoria, reason: razon ?? null,
    contentHash: previo?.category === categoria ? previo.contentHash ?? null : null };
  guardarRegistro();
  console.log(`Clasificada [${p.space}] ${p.title} (id ${pageId}) → ${categoria}${razon ? ` · ${razon}` : ''}`);
  process.exit(0);
}

// ---------- forget ----------
if (modo === 'forget') {
  const [pageId] = args;
  if (!pageId) salir(2, 'Uso: rules.mjs forget <pageId>');
  let borradas = 0;
  for (const archivo of archivosReglas()) {
    const reglas = leerReglas(archivo);
    const quedan = reglas.filter(r => String(r?.fuente?.pageId) !== pageId);
    if (quedan.length !== reglas.length) { borradas += reglas.length - quedan.length; escribirYaml(path.join(dirReglas, archivo), quedan); }
  }
  const catalogo = leerYaml(path.join(dirReglas, CATALOGO), []);
  const quedanCat = catalogo.filter(e => String(e?.fuente?.pageId) !== pageId);
  if (quedanCat.length !== catalogo.length) { borradas += catalogo.length - quedanCat.length; escribirYaml(path.join(dirReglas, CATALOGO), quedanCat); }
  const r = registro.pages[pageId];
  if (r) { if (porId.has(pageId)) r.contentHash = null; else delete registro.pages[pageId]; guardarRegistro(); }
  console.log(`Retiradas ${borradas} entradas de la página ${pageId}${porId.has(pageId) ? ' · queda pendiente de reextraer' : ' · registro eliminado'}`);
  process.exit(0);
}

// ---------- done ----------
if (modo === 'done') {
  if (!args.length) salir(2, 'Uso: rules.mjs done <pageId> [<pageId>...]');
  for (const pageId of args) {
    const p = porId.get(pageId), r = registro.pages[pageId];
    if (!p) salir(2, `No hay ninguna página con id ${pageId} en guidelines/.cache`);
    if (!r?.category) salir(2, `La página ${pageId} no está clasificada; primero: rules.mjs classify ${pageId} <categoria>`);
    if (r.category === 'fuera-de-alcance') salir(2, `La página ${pageId} está fuera de alcance; no se extraen reglas`);
    const tiene = r.category === 'esquemas-de-dominio'
      ? leerYaml(path.join(dirReglas, CATALOGO), []).some(e => String(e?.fuente?.pageId) === pageId)
      : archivosReglas().some(a => leerReglas(a).some(x => String(x?.fuente?.pageId) === pageId));
    if (!tiene) salir(2, `La página ${pageId} (${r.category}) no tiene ninguna regla o entrada con fuente.pageId = "${pageId}". Si de verdad no contiene reglas, reclasifícala como fuera-de-alcance con la razón`);
    r.contentHash = p.contentHash;
  }
  guardarRegistro();
  console.log(`Marcadas como extraídas: ${args.join(', ')}`);
  process.exit(0);
}

// ---------- validate ----------
if (modo === 'validate') {
  const errores = [];
  const ids = new Map();
  for (const archivo of archivosReglas()) {
    const categoria = archivo.replace(/\.yaml$/, '');
    const def = CATEGORIAS[categoria];
    if (!def || !def.prefijo) { errores.push(`${archivo}: el nombre del archivo no es una categoría de reglas (${Object.keys(CATEGORIAS).filter(c => CATEGORIAS[c].prefijo).join(', ')})`); continue; }
    const reglas = leerReglas(archivo);
    reglas.forEach((r, i) => {
      const donde = `${archivo}[${i}]${r?.id ? ' ' + r.id : ''}`;
      if (!r || typeof r !== 'object') return errores.push(`${donde}: no es un objeto`);
      if (!/^[A-Z]{3}-\d{3}$/.test(String(r.id))) errores.push(`${donde}: id debe tener la forma ${def.prefijo}-001`);
      else if (!String(r.id).startsWith(def.prefijo + '-')) errores.push(`${donde}: el prefijo del id debe ser ${def.prefijo} (categoría ${categoria})`);
      if (ids.has(r.id)) errores.push(`${donde}: id repetido (también en ${ids.get(r.id)})`); else ids.set(r.id, archivo);
      if (!r.regla || String(r.regla).trim().length < 10) errores.push(`${donde}: "regla" vacía o demasiado corta`);
      if (!Array.isArray(r.alcance) || !r.alcance.length || r.alcance.some(a => !ALCANCE.includes(a))) errores.push(`${donde}: "alcance" debe ser una lista con interna y/o externa`);
      if (!APLICA_A.includes(r.aplica_a)) errores.push(`${donde}: "aplica_a" debe ser uno de ${APLICA_A.join(', ')}`);
      if (!VERIFICACION.includes(r.verificacion)) errores.push(`${donde}: "verificacion" debe ser automatica, asistida o manual`);
      if (r.verificacion !== 'manual' && !(r.como_verificar && String(r.como_verificar).trim().length >= 10)) errores.push(`${donde}: "como_verificar" es obligatorio cuando la verificación es automatica o asistida`);
      const pid = r.fuente?.pageId != null ? String(r.fuente.pageId) : null;
      if (!pid) errores.push(`${donde}: falta fuente.pageId`);
      else if (!porId.has(pid)) errores.push(`${donde}: fuente.pageId ${pid} ya no está en la caché; ejecuta rules.mjs forget ${pid} y revisa si la regla sigue vigente en otra página`);
      else {
        const reg = registro.pages[pid];
        if (!reg?.category) errores.push(`${donde}: la página fuente ${pid} no está clasificada`);
        else if (reg.category !== categoria) errores.push(`${donde}: la página fuente ${pid} está clasificada como ${reg.category}, pero la regla está en ${categoria}`);
      }
    });
  }
  const catalogo = leerYaml(path.join(dirReglas, CATALOGO), []);
  if (!Array.isArray(catalogo)) errores.push(`${CATALOGO}: debe ser una lista`);
  else catalogo.forEach((e, i) => {
    const donde = `${CATALOGO}[${i}]${e?.nombre ? ' ' + e.nombre : ''}`;
    if (!e?.nombre) errores.push(`${donde}: falta "nombre"`);
    if (!e?.define || String(e.define).trim().length < 10) errores.push(`${donde}: "define" vacío (qué esquema/campos aporta)`);
    if (!e?.reutilizar_cuando) errores.push(`${donde}: falta "reutilizar_cuando"`);
    const pid = e?.fuente?.pageId != null ? String(e.fuente.pageId) : null;
    if (!pid) errores.push(`${donde}: falta fuente.pageId`);
    else if (!porId.has(pid)) errores.push(`${donde}: fuente.pageId ${pid} ya no está en la caché`);
    else if (registro.pages[pid]?.category !== 'esquemas-de-dominio') errores.push(`${donde}: la página ${pid} no está clasificada como esquemas-de-dominio`);
  });
  for (const [id, r] of Object.entries(registro.pages)) {
    if (!CATEGORIAS[r.category]) errores.push(`pages.yaml ${id}: categoría desconocida ${r.category}`);
    if (r.category === 'fuera-de-alcance' && !r.reason) errores.push(`pages.yaml ${id}: fuera-de-alcance sin razón`);
  }
  if (errores.length) salir(2, `${errores.length} problema(s) en guidelines/rules:\n` + errores.map(e => '  - ' + e).join('\n'));
  console.log(`Reglas válidas: ${ids.size} reglas en ${archivosReglas().length} categorías · ${catalogo.length} esquemas en el catálogo`);
  process.exit(0);
}

// ---------- summary ----------
if (modo === 'summary') {
  const porCat = new Map(), porVerif = { automatica: 0, asistida: 0, manual: 0 }, porAlcance = { interna: 0, externa: 0, ambas: 0 };
  let total = 0;
  for (const archivo of archivosReglas()) {
    const reglas = leerReglas(archivo);
    porCat.set(archivo.replace(/\.yaml$/, ''), reglas.length);
    for (const r of reglas) {
      total++;
      if (porVerif[r.verificacion] != null) porVerif[r.verificacion]++;
      const a = Array.isArray(r.alcance) ? r.alcance : [];
      if (a.includes('interna') && a.includes('externa')) porAlcance.ambas++; else if (a.includes('externa')) porAlcance.externa++; else if (a.includes('interna')) porAlcance.interna++;
    }
  }
  const catalogo = leerYaml(path.join(dirReglas, CATALOGO), []);
  console.log(`${total} reglas · ${porVerif.automatica} automáticas · ${porVerif.asistida} asistidas · ${porVerif.manual} manuales · alcance: ${porAlcance.ambas} ambas, ${porAlcance.interna} solo interna, ${porAlcance.externa} solo externa`);
  for (const [c, n] of [...porCat].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);
  console.log(`${catalogo.length} esquemas en el catálogo de dominio`);
  const excluidas = Object.entries(registro.pages).filter(([, r]) => r.category === 'fuera-de-alcance');
  console.log(`\n${excluidas.length} páginas fuera de alcance (confirma que ninguna contiene reglas de contrato REST):`);
  for (const [id, r] of excluidas.sort((a, b) => (a[1].reason ?? '').localeCompare(b[1].reason ?? ''))) console.log(`  - [${r.space}] ${r.title} (id ${id}) · ${r.reason}`);
  const otros = porCat.get('otros') ?? 0;
  if (otros) console.log(`\n${otros} reglas en "otros": revisa si merecen una categoría propia.`);
  process.exit(0);
}
