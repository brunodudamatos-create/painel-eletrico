// ================================================================
// api/dados.js - VERSÃO COM IMPORT (ES MODULE) + GRAVAÇÃO SUPABASE
// ================================================================
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

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

export default async function handler(req, res) {
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

    // 1. Coleta do Medidor Elétrico
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

    // --- 1.1 COLETA DE DADOS DO TERMOSTATO (Adicionar) ---
const tTermo = Date.now().toString();
const urlShadowTermo = `/v2.0/cloud/thing/${process.env.TUYA_DEVICE_TERMOSTATO}/shadow/properties`;
const resTermo = await fetch(`${BASE_URL}${urlShadowTermo}`, {
  headers: { 
    client_id: CLIENT_ID, 
    access_token: token, 
    sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, tTermo, 'GET', urlShadowTermo, token), 
    t: tTermo, 
    sign_method: 'HMAC-SHA256' 
  }
});
const dataTermo = await resTermo.json();
const propsTermo = dataTermo.result?.properties || [];

// Extração dos valores (convertendo o formato da Tuya dividido por 10)
const tempAtualVal = dpShadow(propsTermo, 'temp_current') != null ? dpShadow(propsTermo, 'temp_current') / 10 : null;
const tempSetVal = dpShadow(propsTermo, 'temp_set') != null ? dpShadow(propsTermo, 'temp_set') / 10 : null;

// Lógica inteligente: se a temperatura atual for maior que o setpoint, o ventilador/saída liga
const ventiladorLigado = (tempAtualVal !== null && tempSetVal !== null) ? (tempAtualVal > tempSetVal) : false;

const temperatura = {
  temp_atual: tempAtualVal !== null ? tempAtualVal.toFixed(1) : null,
  temp_set: tempSetVal !== null ? tempSetVal.toFixed(1) : null,
  ventilador_ligado: ventiladorLigado
};
    // 2. Coleta do Termostato
    let temperatura = { temp_atual: null, temp_set: null, debug_todos_codigos: [] };
    if (DEVICE_ID_TERMOSTATO) {
      try {
        const t3 = Date.now().toString();
        const urlTermo = `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status`;
        const resTermo = await fetch(`${BASE_URL}${urlTermo}`, {
          headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t3, 'GET', urlTermo, token), t: t3, sign_method: 'HMAC-SHA256' }
        });
        const dataTermo = await resTermo.json();

        if (dataTermo.result && Array.isArray(dataTermo.result)) {
          temperatura.debug_todos_codigos = dataTermo.result.map(item => ({
            code: item.code,
            value: item.value
          }));

          // Lê a temperatura real (temp_current)
          const itemTemp = dataTermo.result.find(i => i.code === 'temp_current');
          if (itemTemp && itemTemp.value != null) {
            let val = itemTemp.value;
            temperatura.temp_atual = (val > 100 ? val / 10 : Number(val)).toFixed(1);
          }

          // Lê o Setpoint do termostato (temp_set)
          const itemSet = dataTermo.result.find(i => i.code === 'temp_set');
          if (itemSet && itemSet.value != null) {
            let val = itemSet.value;
            temperatura.temp_set = (val > 100 ? val / 10 : Number(val)).toFixed(1);
          }
        } else {
          temperatura.debug_todos_codigos = dataTermo;
        }
      } catch (e) {
        temperatura.debug_todos_codigos = [{ erro: e.message }];
      }
    }
    // 3. GRAVAÇÃO NO BANCO DE DADOS (Restaurada e com temp_atual)
    let bancoStatus = "Não gravado";
    try {
      const { error: dbError } = await supabase
        .from('telemetria_eletrica')
        .insert([{
          tensao_a: eletrico.tensao_a,
          corrente_a: eletrico.corrente_a,
          potencia_a: eletrico.potencia_a,
          fat_pot_a: eletrico.fat_pot_a,
          energia_a: eletrico.energia_a,
          tensao_b: eletrico.tensao_b,
          corrente_b: eletrico.corrente_b,
          potencia_b: eletrico.potencia_b,
          fat_pot_b: eletrico.fat_pot_b,
          energia_b: eletrico.energia_b,
          tensao_c: eletrico.tensao_c,
          corrente_c: eletrico.corrente_c,
          potencia_c: eletrico.potencia_c,
          fat_pot_c: eletrico.fat_pot_c,
          energia_c: eletrico.energia_c,
          energia_total: eletrico.energia_total,
          potencia_total: eletrico.potencia_total,
          frequencia: eletrico.frequencia,
          temp_atual: temperatura.temp_atual // Gravando a temperatura no BD!
        }]);
      
      if (dbError) throw dbError;
      bancoStatus = "Gravação Sucesso";
    } catch (dbErr) {
      console.error("Erro ao gravar no Supabase:", dbErr);
      bancoStatus = "Erro Supabase: " + dbErr.message;
    }

    // 4. Alarmes
    let alertas = [];
    const ta = parseFloat(eletrico.tensao_a);
    if (ta > 139) alertas.push(`*Fase A:* Alta tensão (${ta}V)`);

    return res.status(200).json({
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' }),
      status: alertas.length > 0 ? 'ALERTA' : 'NORMAL',
      alertas,
      eletrico,
      temperatura,
      banco_dados: bancoStatus
    });

  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
