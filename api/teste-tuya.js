// ================================================================
// NOVO ARQUIVO: api/teste-tuya.js (ISOLADO PARA TESTES)
// ================================================================
const crypto = require('crypto');

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal = accessToken ? clientId + accessToken + timestamp + stringToSign : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

function dpShadow(props, codigo) {
  const item = (props || []).find(i => i.code === codigo);
  return item !== undefined ? item.value : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR = process.env.TUYA_DEVICE_MEDIDOR;
  const DEVICE_ID_TERMOSTATO = process.env.TUYA_DEVICE_TERMOSTATO; // Garanta que esta variável existe na Vercel
  const BASE_URL = 'https://openapi.tuyaus.com'; 

  try {
    // 1. Token
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: { client_id: CLIENT_ID, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'), t: t1, sign_method: 'HMAC-SHA256' }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    // 2. Medidor
    const t2 = Date.now().toString();
    const urlShadowMedidor = `/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`;
    const resShadowMedidor = await fetch(`${BASE_URL}${urlShadowMedidor}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlShadowMedidor, token), t: t2, sign_method: 'HMAC-SHA256' }
    });
    const dataShadowMedidor = await resShadowMedidor.json();
    const props = dataShadowMedidor.result?.properties || [];

    // 3. Termostato
    const t3 = Date.now().toString();
    const urlShadowTermo = `/v2.0/cloud/thing/${DEVICE_ID_TERMOSTATO}/shadow/properties`;
    const resShadowTermo = await fetch(`${BASE_URL}${urlShadowTermo}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t3, 'GET', urlShadowTermo, token), t: t3, sign_method: 'HMAC-SHA256' }
    });
    const dataShadowTermo = await resShadowTermo.json();
    const propsTermo = dataShadowTermo.result?.properties || [];

    return res.status(200).json({
      sucesso: true,
      timestamp: new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' }),
      medidor_bruto: props,
      termostato_bruto: propsTermo
    });

  } catch (err) {
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
};
