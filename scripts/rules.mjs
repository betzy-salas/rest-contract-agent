#!/usr/bin/env node
/**
 * Reglas verificables extraídas de los lineamientos (Etapa 2).
 *
 * El agente clasifica cada página descargada en una categoría, extrae sus reglas a guidelines/rules/<categoria>.yaml,
 * los esquemas que la página define (campos, tipos, obligatoriedad) a guidelines/rules/esquemas-normativos.yaml,
 * y registra con qué versión de la página lo hizo. Este script lleva ese registro y valida el resultado; nunca
 * escribe reglas por su cuenta.
 *
 *   node scripts/rules.mjs status                          qué páginas faltan por clasificar, extraer o reextraer, y qué calidad falta
 *   node scripts/rules.mjs accept <pageId> --razon "..."   acepta que una página señalada por coverage está bien así (queda registrado)
 *   node scripts/rules.mjs classify <pageId> <categoria> [--razon "texto"]
 *   node scripts/rules.mjs forget <pageId>                 borra las reglas de esa página (antes de reextraer, o si se eliminó)
 *   node scripts/rules.mjs done <pageId> [<pageId>...]     marca la(s) página(s) como extraída(s) con su versión actual
 *   node scripts/rules.mjs validate                        valida estructura, ids y fuentes de todas las reglas
 *   node scripts/rules.mjs summary                         resumen por categoría, alcance y verificación; páginas excluidas
 *   node scripts/rules.mjs coverage                        por página: reglas extraídas vs. enunciados normativos del texto;
 *                                                          señala subextracción y páginas excluidas que contienen normas
 *   node scripts/rules.mjs coverage --detalle              tabla con las métricas de TODAS las páginas en alcance (solo números)
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
const ESQUEMAS = 'esquemas-normativos.yaml';
const TIPOS_CAMPO = ['string', 'integer', 'number', 'boolean', 'array', 'object', 'null'];

const modo = process.argv[2];
const args = process.argv.slice(3);
const usos = Object.keys(CATEGORIAS).join(' | ');
if (!['status', 'classify', 'forget', 'done', 'validate', 'summary', 'coverage', 'accept'].includes(modo)) salir(2, 'Uso: node scripts/rules.mjs <status|classify|forget|done|validate|summary|coverage|accept>');

const paginas = leerCache({ conCuerpo: modo === 'coverage' || modo === 'status' });
const porId = new Map(paginas.map(p => [p.pageId, p]));
const registro = leerYaml(pagesPath, { pages: {} });
registro.pages ??= {};
const guardarRegistro = () => escribirYaml(pagesPath, registro);

const archivosReglas = () => fs.existsSync(dirReglas)
  ? fs.readdirSync(dirReglas).filter(f => f.endsWith('.yaml') && f !== 'pages.yaml' && f !== CATALOGO && f !== ESQUEMAS).sort()
  : [];
const leerReglas = archivo => {
  const datos = leerYaml(path.join(dirReglas, archivo), null);
  if (datos == null) return [];
  if (!Array.isArray(datos)) salir(2, `${archivo}: debe ser una lista YAML de reglas (cada una empieza con "- id:")`);
  return datos;
};

// ---------- heurística de cobertura (la usan status y coverage) ----------
// Cuenta señales de regla en el texto y las compara con las reglas y campos extraídos de esa página.
// Las reglas rara vez dicen "debe": también son convenciones en presente ("se nombra en plural"), formatos,
// ejemplos marcados correcto/incorrecto, tablas y ejemplos JSON. No mide calidad, mide huecos.
const OBLIGACION = /\b(debe[nr]?[áa]?n?|deber[áa]n?|no debe[n]?|obligatori[oa]s?|siempre|nunca|prohibid[oa]s?|(no )?se permite[n]?|(no )?est[áa] permitid[oa]|recomendad[oa]s?|se recomienda|por defecto|requerid[oa]s?|mandatori[oa]s?|necesari[oa]s?|únicamente|solo se|solamente|evitar|no usar|no utilizar|must|should|shall|required|mandatory)\b/i;
const CONVENCION = /\b(se (usa|usan|utiliza|utilizan|nombra|nombran|define|definen|escribe|escriben|representa|representan|expresa|expresan|envía|envían|devuelve|devuelven|incluye|incluyen|indica|indican|compone|componen)|va[n]? en|en (plural|singular|inglés|minúsculas?|mayúsculas?)|camelCase|kebab-case|snake_case|PascalCase|UPPER_?CASE|ISO ?8601|RFC ?\d+|UTC|formato|patrón|convención|estructura|prefijo|sufijo|nomenclatura|sintaxis)\b/i;
const EJEMPLO = /(✅|❌|✔|✖|\bcorrecto\b|\bincorrecto\b|\bbien\b|\bmal\b|\bno recomendad[oa]\b|\bejemplo\b|\bej\.|\be\.g\.)/i;
function medirNormativo(cuerpo) {
  let enunciados = 0, filas = 0, tablas = 0, ejemplos = 0, lineasContenido = 0, palabras = 0, bloquesCodigo = 0, enCodigo = false, enTabla = false;
  const claves = new Set();
  for (const l of cuerpo.split('\n')) {
    if (/^\s*```/.test(l)) { enCodigo = !enCodigo; if (enCodigo) { ejemplos++; bloquesCodigo++; } continue; }
    if (enCodigo) { for (const m of l.matchAll(/"([A-Za-z_][\w.-]*)"\s*:/g)) claves.add(m[1]); continue; } // claves de ejemplos JSON
    if (!l.trim()) continue;
    if (/^\s*\|/.test(l)) { if (!enTabla) { enTabla = true; tablas++; } if (!/^\s*\|[\s:|-]*\|\s*$/.test(l)) filas++; continue; }
    enTabla = false;
    if (/^\s*#/.test(l)) continue; // encabezados
    lineasContenido++;
    palabras += l.trim().split(/\s+/).length;
    if (EJEMPLO.test(l)) ejemplos++;
    for (const frase of l.split(/(?<=[.;!?])\s+/)) if (OBLIGACION.test(frase) || CONVENCION.test(frase)) enunciados++;
  }
  // una fila de encabezado por tabla; las filas restantes suelen ser un campo o una regla cada una
  return { enunciados, filas: Math.max(0, filas - tablas), tablas, clavesJson: claves.size, ejemplos, bloquesCodigo, lineasContenido, palabras };
}
function todasLasReglas() { const out = []; for (const a of archivosReglas()) for (const r of leerReglas(a)) out.push({ ...r, _archivo: a }); return out; }
const leerEsquemas = () => { const d = leerYaml(path.join(dirReglas, ESQUEMAS), []); if (!Array.isArray(d)) salir(2, `${ESQUEMAS}: debe ser una lista`); return d; };
const camposDe = e => Array.isArray(e?.campos) ? e.campos : [];
function cobertura() {
  const reglasPorPagina = new Map(), camposPorPagina = new Map();
  for (const r of todasLasReglas()) { const k = String(r?.fuente?.pageId); reglasPorPagina.set(k, (reglasPorPagina.get(k) ?? 0) + 1); }
  for (const e of leerEsquemas()) { const k = String(e?.fuente?.pageId); camposPorPagina.set(k, (camposPorPagina.get(k) ?? 0) + camposDe(e).length); }
  const revisar = [], excluidasConNormas = [], aceptadas = [], ok = [];
  for (const p of paginas) {
    const r = registro.pages[p.pageId];
    if (!r?.category || r.category === 'esquemas-de-dominio') continue;
    if (r.coverageAccepted) { aceptadas.push({ p, r }); continue; }
    const m = medirNormativo(p.cuerpo ?? '');
    if (r.category === 'fuera-de-alcance') { if (m.enunciados + m.filas >= 4) excluidasConNormas.push({ p, m, r }); continue; }
    const reglas = reglasPorPagina.get(p.pageId) ?? 0, campos = camposPorPagina.get(p.pageId) ?? 0;
    // lo esperado: una regla por enunciado (obligación o convención), un campo o regla por fila de tabla o clave de ejemplo JSON,
    // y al menos una regla por cada dos ejemplos (un ejemplo ilustra una convención)
    const esperado = m.enunciados + Math.max(m.filas, m.clavesJson) + Math.floor(m.ejemplos / 2);
    const cubierto = reglas + campos;
    // densidad: una página con mucho contenido y casi nada extraído es sospechosa aunque no use palabras normativas
    const pocaDensidad = m.lineasContenido >= 25 && cubierto < Math.ceil(m.lineasContenido / 12);
    if ((cubierto === 0 && esperado > 0) || (esperado >= 3 && cubierto < esperado * 0.8) || pocaDensidad) revisar.push({ p, m, r, reglas, campos, esperado: Math.max(esperado, pocaDensidad ? Math.ceil(m.lineasContenido / 12) : 0), hueco: Math.max(esperado, Math.ceil(m.lineasContenido / 12)) - cubierto, pocaDensidad });
    else ok.push(p);
  }
  revisar.sort((a, b) => b.hueco - a.hueco);
  return { revisar, excluidasConNormas, aceptadas, ok };
}
function calidadVerificacion() {
  const reglas = todasLasReglas();
  const automaticas = reglas.filter(r => r.verificacion === 'automatica').length;
  const mecanicas = ['nomenclatura', 'uri', 'versionamiento', 'codigos-de-respuesta', 'cabeceras', 'paginacion'];
  const enMecanicas = reglas.filter(r => mecanicas.includes(r._archivo.replace(/\.yaml$/, '')));
  const autoMecanicas = enMecanicas.filter(r => r.verificacion === 'automatica').length;
  const avisos = [];
  if (reglas.length >= 20 && automaticas === 0) avisos.push(`ninguna de las ${reglas.length} reglas es automática; aplica el criterio de verificación (condición mecánica sobre el OpenAPI = automatica)`);
  else if (enMecanicas.length >= 10 && autoMecanicas * 2 < enMecanicas.length) avisos.push(`solo ${autoMecanicas} de ${enMecanicas.length} reglas de categorías mecánicas (${mecanicas.join(', ')}) son automáticas; revisa las asistidas de esas categorías`);
  return { avisos, total: reglas.length, automaticas };
}
const imprimirCobertura = ({ revisar, excluidasConNormas }) => {
  if (revisar.length) {
    console.log('\nREVISAR COBERTURA · relee la página completa. Obligaciones en prosa o en filas de tabla → reglas; tablas de campos (nombre, tipo, obligatorio) o ejemplos JSON → esquema normativo con TODOS sus campos. Si la página está bien así: npm run rules:accept -- <pageId> --razon "..."');
    for (const x of revisar) console.log(`  [${x.p.space}] ${x.p.title} (id ${x.p.pageId}) · ${x.r.category} · ${x.reglas} reglas + ${x.campos} campos de esquema vs ${x.m.enunciados} enunciados (obligaciones o convenciones), ${x.m.filas} filas de tabla, ${x.m.clavesJson} claves JSON, ${x.m.ejemplos} ejemplos, ${x.m.lineasContenido} líneas de contenido${x.pocaDensidad ? ' · POCA DENSIDAD: mucho texto y casi nada extraído' : ''}`);
  }
  if (excluidasConNormas.length) {
    console.log('\nEXCLUIDAS CON LENGUAJE NORMATIVO · relee y decide: rules:classify a una categoría y extrae, o rules:accept con la razón precisa de por qué no aplica:');
    for (const x of excluidasConNormas) console.log(`  [${x.p.space}] ${x.p.title} (id ${x.p.pageId}) · ${x.m.enunciados} enunciados y ${x.m.filas} filas de tabla · razón actual: ${x.r.reason}`);
  }
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
  const hayExtraccion = sinClasificar.length + pendientes.length + cambiadas.length + eliminadas.length > 0;
  // La calidad solo se evalúa cuando no queda extracción pendiente: primero completar, después afinar.
  const cob = hayExtraccion ? null : cobertura();
  const ver = hayExtraccion ? null : calidadVerificacion();
  const hayCalidad = !!cob && (cob.revisar.length + cob.excluidasConNormas.length > 0 || ver.avisos.length > 0);
  const hayPendientes = hayExtraccion || hayCalidad;
  console.log(`Reglas: ${hayPendientes ? 'PENDIENTES' : 'AL DÍA'} · ${paginas.length} páginas · ${alDia.length} al día · ${excluidas.length} fuera de alcance · ${sinClasificar.length} sin clasificar · ${pendientes.length} por extraer · ${cambiadas.length} cambiadas · ${eliminadas.length} eliminadas${cob ? ` · calidad: ${cob.revisar.length} con hueco, ${cob.excluidasConNormas.length} excluidas dudosas, ${ver.avisos.length} avisos de verificación` : ''}`);
  const linea = (p, extra = '') => `  [${p.space}] ${p.title} (id ${p.pageId})${extra}`;
  if (sinClasificar.length) { console.log('\nSIN CLASIFICAR · ejecuta: npm run rules:classify -- <pageId> <categoria> [--razon "..."]'); for (const p of sinClasificar) console.log(linea(p)); }
  if (pendientes.length) { console.log('\nPOR EXTRAER · lee guidelines/.cache/<pageId>.md, escribe las reglas y ejecuta: npm run rules:done -- <pageId>'); for (const p of pendientes) console.log(linea(p, ` · ${p.category}`)); }
  if (cambiadas.length) { console.log('\nCAMBIADAS · la página cambió desde la extracción: npm run rules:forget -- <pageId>, reextrae y npm run rules:done -- <pageId>'); for (const p of cambiadas) console.log(linea(p, ` · ${p.category}`)); }
  if (eliminadas.length) { console.log('\nELIMINADAS · ya no están en Confluence: npm run rules:forget -- <pageId> (retira sus reglas y el registro)'); for (const p of eliminadas) console.log(`  ${p.title ?? '?'} (id ${p.pageId}) · ${p.category}`); }
  if (hayCalidad) {
    console.log('\nCALIDAD · la extracción está completa pero no basta:');
    imprimirCobertura(cob);
    if (ver.avisos.length) { console.log('\nVERIFICACIÓN'); for (const a of ver.avisos) console.log(`  - ${a}`); }
  }
  process.exit(hayPendientes ? 1 : 0);
}

// ---------- accept ----------
if (modo === 'accept') {
  const [pageId] = args;
  const iRazon = args.indexOf('--razon');
  const razon = iRazon >= 0 ? args[iRazon + 1] : null;
  if (!pageId || !razon || razon.trim().length < 15) salir(2, 'Uso: rules.mjs accept <pageId> --razon "por qué la página está bien con las reglas que tiene (mínimo 15 caracteres)"');
  const r = registro.pages[pageId];
  if (!porId.has(pageId)) salir(2, `No hay ninguna página con id ${pageId} en guidelines/.cache`);
  if (!r?.category) salir(2, `La página ${pageId} no está clasificada`);
  r.coverageAccepted = razon;
  guardarRegistro();
  console.log(`Aceptada la cobertura de ${pageId} (${r.title}) · ${razon}`);
  process.exit(0);
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
  // al reclasificar, la aceptación de cobertura anterior deja de valer
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
  for (const archivo of [CATALOGO, ESQUEMAS]) {
    const lista = leerYaml(path.join(dirReglas, archivo), []);
    const quedanL = lista.filter(e => String(e?.fuente?.pageId) !== pageId);
    if (quedanL.length !== lista.length) { borradas += lista.length - quedanL.length; escribirYaml(path.join(dirReglas, archivo), quedanL); }
  }
  const r = registro.pages[pageId];
  if (r) { if (porId.has(pageId)) { r.contentHash = null; delete r.coverageAccepted; } else delete registro.pages[pageId]; guardarRegistro(); }
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
      : archivosReglas().some(a => leerReglas(a).some(x => String(x?.fuente?.pageId) === pageId)) || leerEsquemas().some(e => String(e?.fuente?.pageId) === pageId);
    if (!tiene) salir(2, `La página ${pageId} (${r.category}) no tiene ninguna regla ni esquema con fuente.pageId = "${pageId}". Si de verdad no contiene reglas, reclasifícala como fuera-de-alcance con la razón`);
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
  const esquemas = leerEsquemas();
  const nombresEsq = new Set();
  esquemas.forEach((e, i) => {
    const donde = `${ESQUEMAS}[${i}]${e?.nombre ? ' ' + e.nombre : ''}`;
    if (!e?.nombre || !/^[A-Z][A-Za-z0-9]*$/.test(String(e.nombre))) errores.push(`${donde}: "nombre" debe ser un identificador PascalCase (ej. Error, PageInfo)`);
    else if (nombresEsq.has(e.nombre)) errores.push(`${donde}: nombre repetido`); else nombresEsq.add(e.nombre);
    if (!e?.uso || String(e.uso).trim().length < 10) errores.push(`${donde}: "uso" vacío (cuándo y dónde se emplea este esquema en un contrato)`);
    if (!Array.isArray(e?.alcance) || !e.alcance.length || e.alcance.some(a => !ALCANCE.includes(a))) errores.push(`${donde}: "alcance" debe ser una lista con interna y/o externa`);
    const campos = camposDe(e);
    if (!campos.length) errores.push(`${donde}: "campos" vacío`);
    const vistos = new Set();
    campos.forEach((c, j) => {
      const d2 = `${donde}.campos[${j}]${c?.nombre ? ' ' + c.nombre : ''}`;
      if (!c?.nombre) errores.push(`${d2}: falta "nombre"`); else if (vistos.has(c.nombre)) errores.push(`${d2}: campo repetido`); else vistos.add(c.nombre);
      if (!TIPOS_CAMPO.includes(c?.tipo)) errores.push(`${d2}: "tipo" debe ser uno de ${TIPOS_CAMPO.join(', ')}`);
      if (typeof c?.obligatorio !== 'boolean') errores.push(`${d2}: "obligatorio" debe ser true o false (si la página no lo dice, false y anótalo en descripcion)`);
      if (!c?.descripcion || String(c.descripcion).trim().length < 5) errores.push(`${d2}: falta "descripcion"`);
      if (c?.valores != null && !Array.isArray(c.valores)) errores.push(`${d2}: "valores" debe ser una lista`);
    });
    const pid = e?.fuente?.pageId != null ? String(e.fuente.pageId) : null;
    if (!pid) errores.push(`${donde}: falta fuente.pageId`);
    else if (!porId.has(pid)) errores.push(`${donde}: fuente.pageId ${pid} ya no está en la caché; ejecuta rules.mjs forget ${pid}`);
    else if (!registro.pages[pid]?.category || ['fuera-de-alcance', 'esquemas-de-dominio'].includes(registro.pages[pid].category)) errores.push(`${donde}: la página fuente ${pid} debe estar clasificada en una categoría de reglas (los esquemas de dominio van al catálogo)`);
  });
  for (const [id, r] of Object.entries(registro.pages)) {
    if (!CATEGORIAS[r.category]) errores.push(`pages.yaml ${id}: categoría desconocida ${r.category}`);
    if (r.category === 'fuera-de-alcance' && !r.reason) errores.push(`pages.yaml ${id}: fuera-de-alcance sin razón`);
  }
  if (errores.length) salir(2, `${errores.length} problema(s) en guidelines/rules:\n` + errores.map(e => '  - ' + e).join('\n'));
  console.log(`Reglas válidas: ${ids.size} reglas en ${archivosReglas().length} categorías · ${esquemas.length} esquemas normativos con ${esquemas.reduce((n, e) => n + camposDe(e).length, 0)} campos · ${catalogo.length} esquemas en el catálogo de dominio`);
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
  const esquemas = leerEsquemas();
  console.log(`${esquemas.length} esquemas normativos (${esquemas.reduce((n, e) => n + camposDe(e).length, 0)} campos): ${esquemas.map(e => e.nombre).join(', ') || 'ninguno'}`);
  console.log(`${catalogo.length} esquemas en el catálogo de dominio`);
  const excluidas = Object.entries(registro.pages).filter(([, r]) => r.category === 'fuera-de-alcance');
  console.log(`\n${excluidas.length} páginas fuera de alcance (confirma que ninguna contiene reglas de contrato REST):`);
  for (const [id, r] of excluidas.sort((a, b) => (a[1].reason ?? '').localeCompare(b[1].reason ?? ''))) console.log(`  - [${r.space}] ${r.title} (id ${id}) · ${r.reason}`);
  const otros = porCat.get('otros') ?? 0;
  if (otros) console.log(`\n${otros} reglas en "otros": revisa si merecen una categoría propia.`);
  const ver = calidadVerificacion();
  for (const a of ver.avisos) console.log(`\nAVISO: ${a}`);
  process.exit(0);
}

// ---------- coverage ----------
if (modo === 'coverage') {
  if (args.includes('--detalle')) {
    // Métricas por página, sin texto: para diagnosticar por qué el detector señala o no.
    const reglasPorPagina = new Map(), camposPorPagina = new Map();
    for (const r of todasLasReglas()) { const k = String(r?.fuente?.pageId); reglasPorPagina.set(k, (reglasPorPagina.get(k) ?? 0) + 1); }
    for (const e of leerEsquemas()) { const k = String(e?.fuente?.pageId); camposPorPagina.set(k, (camposPorPagina.get(k) ?? 0) + camposDe(e).length); }
    const filasTabla = [];
    for (const p of paginas) {
      const r = registro.pages[p.pageId];
      if (!r?.category || ['fuera-de-alcance', 'esquemas-de-dominio'].includes(r.category)) continue;
      const m = medirNormativo(p.cuerpo ?? '');
      filasTabla.push({ id: p.pageId, titulo: p.title.slice(0, 38), cat: r.category.slice(0, 12), reglas: reglasPorPagina.get(p.pageId) ?? 0, campos: camposPorPagina.get(p.pageId) ?? 0, ...m, acept: r.coverageAccepted ? 'sí' : '' });
    }
    filasTabla.sort((a, b) => (b.palabras) - (a.palabras));
    const cols = ['id', 'cat', 'reglas', 'campos', 'lineas', 'palabras', 'tablas', 'filas', 'codigo', 'clavesJson', 'ejemplos', 'enunciados', 'acept', 'titulo'];
    const fila = x => [x.id, x.cat, x.reglas, x.campos, x.lineasContenido, x.palabras, x.tablas, x.filas, x.bloquesCodigo, x.clavesJson, x.ejemplos, x.enunciados, x.acept, x.titulo];
    const anchos = cols.map((c, i) => Math.max(c.length, ...filasTabla.map(x => String(fila(x)[i]).length)));
    console.log(cols.map((c, i) => c.padEnd(anchos[i])).join('  '));
    for (const x of filasTabla) console.log(fila(x).map((v, i) => String(v).padEnd(anchos[i])).join('  '));
    console.log(`\n${filasTabla.length} páginas en categorías de reglas · ${filasTabla.reduce((n, x) => n + x.reglas, 0)} reglas · ${filasTabla.reduce((n, x) => n + x.campos, 0)} campos de esquema`);
    process.exit(0);
  }
  const cob = cobertura();
  const ver = calidadVerificacion();
  console.log(`Cobertura: ${cob.revisar.length} páginas con posible subextracción · ${cob.excluidasConNormas.length} excluidas con lenguaje normativo · ${cob.aceptadas.length} aceptadas con razón · ${cob.ok.length} sin señal · ${ver.automaticas} de ${ver.total} reglas automáticas`);
  imprimirCobertura(cob);
  if (ver.avisos.length) { console.log('\nVERIFICACIÓN'); for (const a of ver.avisos) console.log(`  - ${a}`); }
  if (cob.aceptadas.length) { console.log('\nACEPTADAS (no se vuelven a señalar):'); for (const x of cob.aceptadas) console.log(`  [${x.p.space}] ${x.p.title} (id ${x.p.pageId}) · ${x.r.coverageAccepted}`); }
  console.log('\nEs una heurística: una página puede tener lenguaje normativo sin reglas de contrato (por ejemplo, instrucciones de proceso). Lo que no debe pasar es que una página con muchas obligaciones tenga dos reglas.');
  process.exit(cob.revisar.length + cob.excluidasConNormas.length + ver.avisos.length ? 1 : 0);
}
