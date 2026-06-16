// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// SUPER SCANNER - BUSCA MULTI-ENDPOINT
// ================================================================

const crypto = require('crypto');

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal = accessToken ? clientId + accessToken + timestamp + stringToSign : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLIENT_ID          = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET      = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR  = process.env.TUYA_DEVICE_MEDIDOR;
  const BASE_URL           = 'https://openapi.tuyaus.com'; 

  try {
    // 1. Pega o Token
    const t1 = Date.now().toString();
    const urlToken = '/v1.0/token?grant_type=1';
    const reqToken = await fetch(`${BASE_URL}${urlToken}`, {
      headers: { client_id: CLIENT_ID, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', urlToken), t: t1, sign_method: 'HMAC-SHA256' }
    });
    const dadosToken = await reqToken.json();
    const token = dadosToken.result?.access_token;

    if (!token) throw new Error('Falha de autenticação com a Tuya.');

    // Função auxiliar para bater nos endpoints
    async function tuyaFetch(url) {
      const t = Date.now().toString();
      const req = await fetch(`${BASE_URL}${url}`, {
        headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t, 'GET', url, token), t: t, sign_method: 'HMAC-SHA256' }
      });
      return await req.json();
    }

    // 2. Dispara contra os 3 endpoints possíveis simultaneamente
    const resV1 = await tuyaFetch(`/v1.0/devices/${DEVICE_ID_MEDIDOR}/status`);
    const resIoT = await tuyaFetch(`/v1.0/iot-03/devices/${DEVICE_ID_MEDIDOR}/status`);
    const resShadow = await tuyaFetch(`/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`);

    return res.status(200).json({
      aviso: "SUPER SCANNER CONCLUIDO",
      instrucao: "Copie todo este JSON e envie no chat",
      endpoint_v1_basico: resV1.result || resV1,
      endpoint_iot_industrial: resIoT.result || resIoT,
      endpoint_device_shadow: resShadow.result || resShadow
    });

  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno', detalhe: err.message });
  }
};
