// ANT Licencias API — Compatible con Render.com (sin Puppeteer)
// Flujo: GET sesion → POST validar → GET grid → parsear HTML + jqGrid JSON

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

function crearCliente() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar, withCredentials: true, timeout: 20000,
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept-Language': 'es-EC,es;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br'
    }
  }));
}

function dec(data) {
  return Buffer.isBuffer(data) ? iconv.decode(data, 'ISO-8859-1') : String(data);
}

// Detecta URL del jqGrid en JS inline de la pagina
function detectarUrlGrid(html) {
  const re = /url\s*:\s*['"]([^'"]*\.jsp[^'"]*)['"]/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1].trim();
    if (!u.includes('css') && !u.includes('jquery') && !u.includes('http')) return u;
  }
  return null;
}

// Parsea la pagina HTML buscando datos del conductor
function parsearPersona($) {
  const p = {};
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const lbl = $(tds[0]).text().replace(/\s+/g,' ').trim().toUpperCase();
    const val = $(tds[1]).text().replace(/\s+/g,' ').trim();
    if (!val) return;
    if (/NOMBRE|APELLIDO/.test(lbl))                       p.nombre          = val;
    if (/TIPO.*(LIC|CAT)|LIC.*TIPO|CATEGOR/.test(lbl))    p.tipo_licencia   = val;
    if (/CADUCIDAD|VIGENCIA|VENCIMIENTO|EXPIRA/.test(lbl)) p.fecha_caducidad = val;
    if (/PUNTO/.test(lbl))                                 p.puntos          = val;
    if (/C[EÉ]DULA|IDENTIF/.test(lbl))                    p.cedula          = val;
  });
  return p;
}

app.get('/api/consulta', async (req, res) => {
  const { identificacion, tipo = 'CED' } = req.query;
  if (!identificacion) return res.status(400).json({ success:false, error:'Parametro identificacion requerido' });

  const tipos = { CED:'Cedula', RUC:'RUC', PAS:'Pasaporte', PLA:'Placa' };
  if (!tipos[tipo]) return res.status(400).json({ success:false, error:'Tipo invalido. Usa: CED, RUC, PAS, PLA' });

  const client = crearCliente();
  try {
    // PASO 1: Iniciar sesion (obtiene JSESSIONID)
    await client.get(`${BASE}/clp_criterio_consulta.jsp`, {
      responseType:'arraybuffer', headers:{ Accept:'text/html' }
    });

    // PASO 2: Validar persona via AJAX
    // Replicamos: AJAX.open("POST","clp_json_consulta_persona.jsp?ps_tipo_identificacion=CED&ps_identificacion=XXXX")
    const valRes = await client.post(`${BASE}/clp_json_consulta_persona.jsp`, '', {
      params: { ps_tipo_identificacion: tipo, ps_identificacion: identificacion },
      responseType: 'arraybuffer',
      headers: {
        'Content-Type'    : 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer'         : `${BASE}/clp_criterio_consulta.jsp`
      }
    });
    const valText = dec(valRes.data).trim();
    let valJson = {};
    try { valJson = JSON.parse(valText); } catch { valJson = { mensaje: valText }; }

    if (valJson.mensaje !== 'OK') {
      return res.json({ success:false, error: valJson.mensaje || 'Persona no encontrada' });
    }

    // PASO 3: Obtener pagina del grid
    // Replicamos: form.submit() → GET clp_grid_citaciones.jsp?ps_tipo_identificacion=CED&ps_identificacion=XXXX
    const gridRes = await client.get(`${BASE}/clp_grid_citaciones.jsp`, {
      params: { ps_tipo_identificacion: tipo, ps_identificacion: identificacion, ps_placa:'' },
      responseType: 'arraybuffer',
      headers: { Accept:'text/html', Referer:`${BASE}/clp_criterio_consulta.jsp` }
    });
    const gridHtml = dec(gridRes.data);
    const $ = cheerio.load(gridHtml);

    const persona = parsearPersona($);
    const allScripts = $('script').map((_,el) => $(el).html()||'').get().join('\n');
    const gridUrlRel = detectarUrlGrid(allScripts);

    let citaciones=[], gridUrlFinal=null, debugGrid=null;

    // PASO 4: Llamar al endpoint JSON del jqGrid (carga los datos de la tabla)
    if (gridUrlRel) {
      gridUrlFinal = gridUrlRel.startsWith('http') ? gridUrlRel : `${BASE}/${gridUrlRel.replace(/^\//,'')}`;
      try {
        const jsonRes = await client.get(gridUrlFinal, {
          params: { ps_tipo_identificacion:tipo, ps_identificacion:identificacion, _search:false, rows:100, page:1, sidx:'', sord:'asc' },
          responseType:'arraybuffer',
          headers: { 'X-Requested-With':'XMLHttpRequest', Referer:`${BASE}/clp_grid_citaciones.jsp` }
        });
        const jsonTxt = dec(jsonRes.data);
        try {
          const parsed = JSON.parse(jsonTxt);
          // jqGrid puede pasar datos extra del conductor en "userdata"
          const ud = parsed.userdata || {};
          if (ud.nombre         && !persona.nombre)         persona.nombre         = ud.nombre;
          if (ud.tipo_licencia  && !persona.tipo_licencia)  persona.tipo_licencia  = ud.tipo_licencia;
          if (ud.fecha_caducidad && !persona.fecha_caducidad) persona.fecha_caducidad = ud.fecha_caducidad;
          if (ud.puntos !== undefined && !persona.puntos)   persona.puntos         = String(ud.puntos);

          citaciones = (parsed.rows || []).map(r => {
            const c = r.cell || r;
            return Array.isArray(c) ? { datos:c } : c;
          });
          debugGrid = jsonTxt.substring(0, 600);
        } catch(pe) { debugGrid = `Parse error: ${pe.message} | ${jsonTxt.substring(0,300)}`; }
      } catch(fe) { debugGrid = `Fetch error: ${fe.message}`; }
    }

    return res.json({
      success:true, tipo_consulta:tipos[tipo], identificacion,
      persona, total_citaciones:citaciones.length, citaciones,
      _debug: { grid_url_detectada:gridUrlFinal, grid_json_muestra:debugGrid, html_muestra:gridHtml.substring(0,2500) }
    });

  } catch(err) {
    console.error('[ANT API]', err.message);
    return res.status(500).json({ success:false, error:err.message });
  }
});

app.get('/health', (_, res) => res.json({ status:'ok', ts: new Date().toISOString() }));
app.listen(PORT, () => console.log(`ANT Licencias API — Puerto ${PORT}`));