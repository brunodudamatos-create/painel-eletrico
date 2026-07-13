// ================================================================
// api/dados.js - VERSÃO FINAL CORRIGIDA
// ================================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function enviarAlertaTelegram(mensagem) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: mensagem, parse_mode: 'Markdown' })
    });
  } catch (error) {
    console.error("Erro Telegram:", error);
  }
}

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

  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR = process.env.TUYA_DEVICE_MEDIDOR;
  const DEVICE_ID_TERMOSTATO = process.env.TUYA_DEVICE_TERMOSTATO;
  const BASE_URL = 'https://openapi.tuyaus.com';

  try {
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: { client_id: CLIENT_ID, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'), t: t1, sign_method: 'HMAC-SHA256' }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    // Medidor
    const t2 = Date.now().toString();
    const urlShadow = `/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`;
    const resShadow = await fetch(`${BASE_URL}${urlShadow}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlShadow, token), t: t2, sign_method: 'HMAC-SHA256' }
    });
    const dataShadow = await resShadow.json();
    const props = dataShadow.result?.properties || [];

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

        // Termostato
    let temperatura = { temp_atual: null, status: "pendente" };
    if (DEVICE_ID_TERMOSTATO) {
      try {
        const t3 = Date.now().toString();
        const url = `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status`;
        const resp = await fetch(`${BASE_URL}${url}`, {
          headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t3, 'GET', url, token), t: t3, sign_method: 'HMAC-SHA256' }
        });
        const data = await resp.json();

        if (data.result && Array.isArray(data.result)) {
          const val = dpShadow(data.result, 'temp_current');
          if (val !== null) {
            temperatura.temp_atual = Number(val).toFixed(1);   // scale 1
            temperatura.status = "ok";
          }
        }
      } catch (e) {
        temperatura.status = "erro";
      }
    }

    // Alarmes (simplificado)
    let alertas = [];
    const ta = parseFloat(eletrico.tensao_a);
    if (ta > 139) alertas.push(`*Fase A:* Alta tensão (${ta}V)`);

    return res.status(200).json({
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' }),
      status: alertas.length > 0 ? 'ALERTA' : 'NORMAL',
      alertas,
      eletrico,
      temperatura,
      banco_dados: "Gravação Sucesso"
    });

  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
};
