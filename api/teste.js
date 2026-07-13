const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const DEVICE_ID = process.env.TUYA_DEVICE_TERMOSTATO;
  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const BASE_URL = 'https://openapi.tuyaus.com';

  let resultado = {
    device_id: DEVICE_ID,
    sucesso: false,
    temperatura: null,
    raw: null,
    erro: null
  };

  try {
    // Token
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: {
        client_id: CLIENT_ID,
        sign: crypto.createHmac('sha256', CLIENT_SECRET).update(CLIENT_ID + t1 + 'GET\n\n\n/v1.0/token?grant_type=1').digest('hex').toUpperCase(),
        t: t1,
        sign_method: 'HMAC-SHA256'
      }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    // Busca status
    const t2 = Date.now().toString();
    const url = `/v1.0/iot-03/devices/${DEVICE_ID}/status`;
    const resp = await fetch(`${BASE_URL}${url}`, {
      headers: {
        client_id: CLIENT_ID,
        access_token: token,
        sign: crypto.createHmac('sha256', CLIENT_SECRET).update(CLIENT_ID + token + t2 + 'GET\n\n\n' + url).digest('hex').toUpperCase(),
        t: t2,
        sign_method: 'HMAC-SHA256'
      }
    });

    const data = await resp.json();
    resultado.raw = data;

    if (data.result && Array.isArray(data.result)) {
      const tempItem = data.result.find(item => 
        item.code && (item.code.toLowerCase().includes('temp') || item.code.toLowerCase().includes('temperature'))
      );
      if (tempItem) {
        resultado.temperatura = tempItem.value;
        resultado.code = tempItem.code;
        resultado.sucesso = true;
      }
    }
  } catch (e) {
    resultado.erro = e.message;
  }

  return res.json(resultado);
};
