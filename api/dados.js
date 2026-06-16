// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// PAINEL ELÉTRICO — TUYA SHADOW ENDPOINT (FINAL)
// ================================================================

const crypto = require('crypto');

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal = accessToken ? clientId + accessToken + timestamp + stringToSign : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

// Busca o valor direto na lista de 'properties' do Shadow
function dpShadow(props, codigo) {
  const item = (props || []).find(i => i.code === codigo);
  return item !== undefined ? item.value : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR = process.env.TUYA_DEVICE_MEDIDOR;
  const BASE_URL = 'https://openapi.tuyaus.com'; 

  try {
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: { client_id: CLIENT_ID, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'), t: t1, sign_method: 'HMAC-SHA256' }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    // CONSULTA O SHADOW (Onde estão os dados reais)
    const t2 = Date.now().toString();
    const urlShadow = `/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`;
    const resShadow = await fetch(`${BASE_URL}${urlShadow}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlShadow, token), t: t2, sign_method: 'HMAC-SHA256' }
    });
    const dataShadow = await resShadow.json();
    const props = dataShadow.result?.properties || [];

    // MAPEAMENTO E CONVERSÃO DE UNIDADES
    const eletrico = {
      tensao_a: dpShadow(props, 'voltage_a') != null ? (dpShadow(props, 'voltage_a') / 10).toFixed(1) : null,
      corrente_a: dpShadow(props, 'current_a') != null ? (dpShadow(props, 'current_a') / 1000).toFixed(2) : null,
      potencia_a: dpShadow(props, 'active_power_a'),
      fat_pot_a: dpShadow(props, 'power_factor_a') != null ? (dpShadow(props, 'power_factor_a') / 100).toFixed(2) : null,
      energia_a: dpShadow(props, 'forward_energy_a'),

      tensao_b: dpShadow(props, 'voltage_b') != null ? (dpShadow(props, 'voltage_b') / 10).toFixed(1) : null,
      corrente_b: dpShadow(props, 'current_b') != null ? (dpShadow(props, 'current_b') / 1000).toFixed(2) : null,
      potencia_b: dpShadow(props, 'active_power_b'),
      fat_pot_b: dpShadow(props, 'power_factor_b') != null ? (dpShadow(props, 'power_factor_b') / 100).toFixed(2) : null,
      energia_b: dpShadow(props, 'forward_energy_b'),

      tensao_c: dpShadow(props, 'voltage_c') != null ? (dpShadow(props, 'voltage_c') / 10).toFixed(1) : null,
      corrente_c: dpShadow(props, 'current_c') != null ? (dpShadow(props, 'current_c') / 1000).toFixed(2) : null,
      potencia_c: dpShadow(props, 'active_power_c'),
      fat_pot_c: dpShadow(props, 'power_factor_c') != null ? (dpShadow(props, 'power_factor_c') / 100).toFixed(2) : null,
      energia_c: dpShadow(props, 'forward_energy_c'),

      energia_total: dpShadow(props, 'forward_energy_total'),
      potencia_total: dpShadow(props, 'active_power_total'),
      frequencia: dpShadow(props, 'frequency'),
      falha: dpShadow(props, 'fault')
    };

    return res.status(200).json({
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      status: 'NORMAL',
      alertas: [],
      eletrico,
      temperatura: { temp_atual: null }
    });

  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
};
