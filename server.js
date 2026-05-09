// ============================================================
// ANT Licencias API — server.js  (version final)
// Render.com compatible — Node.js 18+ sin Puppeteer
// ============================================================

const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const iconv     = require('iconv-lite');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cors      = require('cors');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://sistematransito.ant.gob.ec/PortalWEB/paginas/clientes';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────

function crearCliente() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 20000,
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept-Language': 'es-EC,es;q=0.9,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection'     : 'keep-alive'
    }
  }));
}

function dec(data) {
  return Buffer.isBuffer(data) ? iconv.decode(data, 'ISO-8859-1') : String(data);
}

// ── parsearPersona ─────────────────────────────────────────────
// Selectores CSS reales del portal (confirmados con HTML real):
//   td.titulo1            → nombre (1er td) y puntos (td con solo digitos)
//   td.MarcoTitulo        → cedula  "CED - XXXXXXXXXX"
//   td.detalle_formulario → "LICENCIA TIPO: C  / VALIDEZ: 17-09-2024 - 16-09-2029"
function parsearPersona($) {
  const p = {};

  // NOMBRE — primer td.titulo1
  const nombreTxt = $('td.titulo1').first().text().replace(/\s+/g, ' ').trim();
  if (nombreTxt) p.nombre = nombreTxt;

  // PUNTOS — td.titulo1 cuyo texto es solo digitos
  $('td.titulo1').each((_, td) => {
    const txt = $(td).text().replace(/\s+/g, ' ').trim();
    if (/^\d+$/.test(txt)) p.puntos = txt;
  });

  // CEDULA — td.MarcoTitulo que contiene "CED - XXXXXXXXXX"
  $('td.MarcoTitulo').each((_, td) => {
    const txt = $(td).text().replace(/[\s\u00A0]+/g, ' ').trim();
    const m = txt.match(/(?:CED|RUC|PAS|PLA)\s*[-\u2013]\s*(\w+)/i);
    if (m) p.cedula = m[1];
  });

  // TIPO LICENCIA + VALIDEZ — td.detalle_formulario
  $('td.detalle_formulario').each((_, td) => {
    const txt = $(td)
      .text()
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (/LICENCIA\s+TIPO/i.test(txt)) {
      const mTipo = txt.match(/LICENCIA\s+TIPO\s*:\s*([A-Z0-9]+)/i);
      if (mTipo) p.tipo_licencia = mTipo[1].trim();

      // Fecha caducidad = segunda fecha del rango (fin de validez)
      const mCad = txt.match(/VALIDEZ\s*:\s*[\d\-\/]+\s*-\s*([\d\-\/]+)/i);
      if (mCad) p.fecha_caducidad = mCad[1].trim();

      // Rango completo de validez
      const mRango = txt.match(/VALIDEZ\s*:\s*([\d\-\/]+\s*-\s*[\d\-\/]+)/i);
      if (mRango) p.validez_completa = mRango[1].replace(/\s+/g, ' ').trim();
    }
  });

  return p;
}

// ── detectarUrlGrid ────────────────────────────────────────────
// Busca clp_json_citaciones.jsp con sus params embebidos.
// Excluye JSPs secundarios: impresiones, detalles, puntos, etc.
function detectarUrlGrid(js) {
  // Busqueda directa por nombre exacto
  const reDirecta = /url\s*:\s*'(clp_json_citaciones\.jsp[^']*)'/i;
  const mDirecta  = reDirecta.exec(js);
  if (mDirecta) return mDirecta[1];

  // Fallback excluyendo secundarios
  const excluir = /impresion|imprimir|detalles_cit|pagina_blanca|puntos|auditoria|estado_cuenta|export|print/i;
  const re = /url\s*:\s*['"]([^'"]*\.jsp[^'"]*)['"]/gi;
  let m;
  while ((m = re.exec(js)) !== null) {
    const u = m[1].trim();
    if (!excluir.test(u) && !u.includes('css') && !u.includes('jquery') && !u.includes('http')) {
      return u;
    }
  }
  return null;
}

// ── GET /api/consulta ──────────────────────────────────────────

app.get('/api/consulta', async (req, res) => {
  const { identificacion, tipo = 'CED' } = req.query;

  if (!identificacion) {
    return res.status(400).json({ success: false, error: 'Parametro identificacion requerido' });
  }

  const tipos = { CED: 'Cedula', RUC: 'RUC', PAS: 'Pasaporte', PLA: 'Placa' };
  if (!tipos[tipo]) {
    return res.status(400).json({ success: false, error: 'Tipo invalido. Usa: CED, RUC, PAS, PLA' });
  }

  const client = crearCliente();

  try {

    // PASO 1 — Sesion: obtiene JSESSIONID de Tomcat
    await client.get(`${BASE}/clp_criterio_consulta.jsp`, {
      responseType: 'arraybuffer',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });

    // PASO 2 — Validar persona via AJAX interno
    // POST clp_json_consulta_persona.jsp?ps_tipo_identificacion=CED&ps_identificacion=XXXX
    // Responde: {"mensaje":"OK"} o {"mensaje":"<error>"}
    const valRes = await client.post(
      `${BASE}/clp_json_consulta_persona.jsp`,
      '',
      {
        params: {
          ps_tipo_identificacion: tipo,
          ps_identificacion     : identificacion
        },
        responseType: 'arraybuffer',
        headers: {
          'Content-Type'    : 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer'         : `${BASE}/clp_criterio_consulta.jsp`
        }
      }
    );

    const valText = dec(valRes.data).trim();
    let valJson = {};
    try { valJson = JSON.parse(valText); } catch { valJson = { mensaje: valText }; }

    if (valJson.mensaje !== 'OK') {
      return res.json({
        success: false,
        error  : valJson.mensaje || 'Persona no encontrada'
      });
    }

    // PASO 3 — Pagina del grid
    // GET clp_grid_citaciones.jsp?ps_tipo_identificacion=CED&ps_identificacion=XXXX&ps_placa=
    const gridRes = await client.get(`${BASE}/clp_grid_citaciones.jsp`, {
      params: {
        ps_tipo_identificacion: tipo,
        ps_identificacion     : identificacion,
        ps_placa              : ''
      },
      responseType: 'arraybuffer',
      headers: {
        Accept : 'text/html,application/xhtml+xml',
        Referer: `${BASE}/clp_criterio_consulta.jsp`
      }
    });

    const gridHtml = dec(gridRes.data);
    const $        = cheerio.load(gridHtml);

    // Extraer datos del conductor con selectores CSS reales
    const persona = parsearPersona($);

    // Detectar URL del endpoint JSON del jqGrid
    const allScripts = $('script').map((_, el) => $(el).html() || '').get().join('\n');
    const gridUrlRel = detectarUrlGrid(allScripts);

    let citaciones   = [];
    let gridUrlFinal = null;
    let debugGrid    = null;

    // PASO 4 — Llamar al endpoint JSON del jqGrid de citaciones
    // La URL ya trae todos los params: ps_id_persona, ps_identificacion, ps_opcion, etc.
    if (gridUrlRel) {
      gridUrlFinal = `${BASE}/${gridUrlRel.replace(/^\//, '')}`;

      try {
        const jsonRes = await client.get(gridUrlFinal, {
          responseType: 'arraybuffer',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept'          : 'application/json, text/javascript, */*',
            'Referer'         : `${BASE}/clp_grid_citaciones.jsp`
          }
        });

        const jsonTxt = dec(jsonRes.data);
        try {
          const parsed = JSON.parse(jsonTxt);

          // Mapear filas segun colModel del portal (indices confirmados):
          // [0]=act [1]=id_factura [2]=ente [3]=secuencia_1(#cit) [4]=secuencia_4(placa)
          // [5]=documento [6]=fecha_emision [7]=fecha_factura [8]=fecha_vence
          // [9]=puntos [10]=pagada [11]=anulada [12]=reclamo [13]=capital_factura
          // [14]=multa [15]=descuento [16]=total [17]=rubro
          citaciones = (parsed.rows || []).map(row => {
            const c = row.cell || row;
            if (Array.isArray(c)) {
              return {
                id_factura   : c[1]  || '',
                entidad      : c[2]  || '',
                num_citacion : c[3]  || '',
                placa        : c[4]  || '',
                fecha_emision: c[6]  || '',
                puntos_cit   : c[9]  || '',
                sancion      : c[13] || '',
                multa        : c[14] || '',
                total        : c[16] || '',
                articulo     : c[17] || ''
              };
            }
            return {
              id_factura   : c.id_factura      || '',
              entidad      : c.ente            || '',
              num_citacion : c.secuencia_1     || '',
              placa        : c.secuencia_4     || '',
              fecha_emision: c.fecha_emision   || '',
              puntos_cit   : c.puntos          || '',
              sancion      : c.capital_factura || '',
              multa        : c.multa           || '',
              total        : c.total           || '',
              articulo     : c.rubro           || ''
            };
          });

          debugGrid = jsonTxt.substring(0, 800);
        } catch (pe) {
          debugGrid = `JSON parse error: ${pe.message} | raw: ${jsonTxt.substring(0, 400)}`;
        }
      } catch (fe) {
        debugGrid = `Fetch error: ${fe.message}`;
      }
    }

    return res.json({
      success         : true,
      tipo_consulta   : tipos[tipo],
      identificacion,
      persona,
      total_citaciones: citaciones.length,
      citaciones,
      _debug: {
        grid_url_detectada: gridUrlFinal,
        grid_json_muestra : debugGrid,
        html_muestra      : gridHtml.substring(0, 3000)
      }
    });

  } catch (err) {
    console.error('[ANT API]', err.message);
    return res.status(500).json({
      success: false,
      error  : err.message,
      hint   : 'Verifica conectividad al servidor ANT o que el identificador sea valido'
    });
  }
});

// ── Health check para Render ───────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`ANT Licencias API — Puerto ${PORT}`));
