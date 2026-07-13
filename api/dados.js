// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// PAINEL ELÉTRICO + TERMOSTATO — VERSÃO CORRIGIDA
// ================================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Inicializa o Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function enviarAlertaTelegram(mensagem) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
 
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: mensagem,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error("Erro ao disparar alerta para o Telegram:", error);
  }
}

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal = accessToken 
    ? clientId + accessToken + timestamp + stringToSign 
    : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

function dpShadow(props, codigo) {
  const item = (props || []).find(i => i.code === codigo);
  return item !== undefined ? item.value : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // ==================== DEBUG DE VARIÁVEIS ====================
  console.log("=== DEBUG VARS ===");
  console.log("TUYA_DEVICE_MEDIDOR:", process.env.TUYA_DEVICE_MEDIDOR);
  console.log("TUYA_DEVICE_TERMOSTATO:", process.env.TUYA_DEVICE_TERMOSTATO);
  console.log("CLIENT_ID presente?", !!process.env.TUYA_CLIENT_ID);
  console.log("==================");
  // ===========================================================

  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR = process.env.TUYA_DEVICE_MEDIDOR;
  const DEVICE_ID_TERMOSTATO = process.env.TUYA_DEVICE_TERMOSTATO;
  const BASE_URL = 'https://openapi.tuyaus.com';

  try {
    // 1. AUTENTICAÇÃO
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: { 
        client_id: CLIENT_ID, 
        sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'), 
        t: t1, 
        sign_method: 'HMAC-SHA256' 
      }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    if (!token) throw new Error("Falha ao obter token da Tuya");

    // 2. DADOS DO MEDIDOR ELÉTRICO
    const t2 = Date.now().toString();
    const urlShadow = `/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`;
    const resShadow = await fetch(`${BASE_URL}${urlShadow}`, {
      headers: { 
        client_id: CLIENT_ID, 
        access_token: token, 
        sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlShadow, token), 
        t: t2, 
        sign_method: 'HMAC-SHA256' 
      }
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

       // 3. DADOS DO TERMOSTATO - ULTRA DEBUG
    let temperatura = { 
      temp_atual: null, 
      status: "não configurado", 
      raw_response: null,
      found_codes: []
    };

    if (DEVICE_ID_TERMOSTATO) {
      try {
        const t3 = Date.now().toString();
        const urlStatusTermo = `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status`;
        
        console.log(`[TERMOSTATO] === INICIANDO BUSCA === ID: ${DEVICE_ID_TERMOSTATO}`);

        const resStatusTermo = await fetch(`${BASE_URL}${urlStatusTermo}`, {
          headers: { 
            client_id: CLIENT_ID, 
            access_token: token, 
            sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t3, 'GET', urlStatusTermo, token), 
            t: t3, 
            sign_method: 'HMAC-SHA256' 
          }
        });

        const dataStatusTermo = await resStatusTermo.json();
        
        console.log(`[TERMOSTATO] Status HTTP: ${resStatusTermo.status}`);
        console.log(`[TERMOSTATO] Resposta completa:`, JSON.stringify(dataStatusTermo, null, 2));

        temperatura.raw_response = dataStatusTermo;

        if (dataStatusTermo.result && Array.isArray(dataStatusTermo.result)) {
          const propsTermo = dataStatusTermo.result;
          
          // Lista todos os codes disponíveis (muito útil!)
          temperatura.found_codes = propsTermo.map(p => ({code: p.code, value: p.value}));

          console.log(`[TERMOSTATO] Todos os codes disponíveis:`, temperatura.found_codes);

          // Tenta vários nomes possíveis
          let valTemp = null;
          const possibleCodes = ['temp_current', 'temperature', 'cur_temperature', 'current_temperature', 'temp', 'TempCurrent', 'current_temp'];
          
          for (const code of possibleCodes) {
            valTemp = dpShadow(propsTermo, code);
            if (valTemp !== null) {
              console.log(`[TERMOSTATO] Encontrado no code: ${code} → valor ${valTemp}`);
              break;
            }
          }

          if (valTemp == null && propsTermo.length > 0) {
            const numeric = propsTermo.find(p => typeof p.value === 'number' && p.value > 0);
            if (numeric) {
              valTemp = numeric.value;
              console.log(`[TERMOSTATO] Pegando primeiro valor numérico: ${valTemp} (code: ${numeric.code})`);
            }
          }

          if (valTemp != null) {
            temperatura.temp_atual = (valTemp > 100 ? (valTemp / 10) : valTemp).toFixed(1);
            temperatura.status = "ok";
          } else {
            temperatura.status = "valor não encontrado";
          }
        } else {
          temperatura.status = "formato inválido";
        }
      } catch (errTermo) {
        console.error("[TERMOSTATO] ERRO GRAVE:", errTermo.message);
        temperatura.status = "erro_exception";
      }
    }

    console.log("[TERMOSTATO] Resultado final:", temperatura);

    // --- 4. LÓGICA DE ALARMES ---
    let alertas = [];
    // ... (cole o restante do seu código original a partir daqui)

    // No final, no return res.status(200).json, mantenha o temperatura

  } catch (err) {
    console.error("Erro geral:", err);
    return res.status(500).json({ erro: err.message });
  }
};
