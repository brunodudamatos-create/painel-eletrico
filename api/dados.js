const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const DEVICE_ID_TERMOSTATO = process.env.TUYA_DEVICE_TERMOSTATO;
  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const BASE_URL = 'https://openapi.tuyaus.com';

  let resultado = { temp_atual: null, erro: null, device_id: DEVICE_ID_TERMOSTATO };

  try {
    // Autenticação
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: { client_id: CLIENT_ID, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'), t: t1, sign_method: 'HMAC-SHA256' }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    if (!token) throw new Error("Sem token");

    // Busca simples no termostato
    const t2 = Date.now().toString();
    const url = `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status`;
    const resp = await fetch(`${BASE_URL}${url}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', url, token), t: t2, sign_method: 'HMAC-SHA256' }
    });

    const data = await resp.json();
    resultado.raw = data;

    // Tenta extrair temperatura de qualquer forma
    if (data.result) {
      const props = Array.isArray(data.result) ? data.result : [];
      const tempItem = props.find(p => 
        p.code && (p.code.includes('temp') || p.code.includes('temperature'))
      );
      if (tempItem) {
        resultado.temp_atual = tempItem.value;
        resultado.code_encontrado = tempItem.code;
      }
    }
  } catch (e) {
    resultado.erro = e.message;
  }

  return res.status(200).json(resultado);
};

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '') {
  const stringToSign = `${method}\n\n\n${urlPath}`;
  const cadeiaFinal = clientId + accessToken + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}
