// ================================================================
// api/dados.js - VERSÃO COM ALERTAS, TEMPERATURA E GRAVAÇÃO NO SUPABASE
// ================================================================
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function enviarAlertaTelegram(mensagem) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) return;
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
  const LIMITE_TENSAO = 139; // Limite fixo de alarme

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

    // 2. Coleta do Termostato
    let temperatura = { temp_atual: null, temp_set: null, ventilador_ligado: false };
    const t3 = Date.now().toString();
    const urlTermo = `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status`;
    const resTermo = await fetch(`${BASE_URL}${urlTermo}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t3, 'GET', urlTermo, token), t: t3, sign_method: 'HMAC-SHA256' }
    });
    const dataTermo = await resTermo.json();
    if (dataTermo.result && Array.isArray(dataTermo.result)) {
      const itemTemp = dataTermo.result.find(i => i.code === 'temp_current');
      const itemSet = dataTermo.result.find(i => i.code === 'temp_set');
      const tempAtualVal = (itemTemp && itemTemp.value != null) ? (itemTemp.value > 100 ? itemTemp.value / 10 : Number(itemTemp.value)) : null;
      const tempSetVal = (itemSet && itemSet.value != null) ? (itemSet.value > 100 ? itemSet.value / 10 : Number(itemSet.value)) : null;
      temperatura.temp_atual = tempAtualVal !== null ? tempAtualVal.toFixed(1) : null;
      temperatura.temp_set = tempSetVal !== null ? tempSetVal.toFixed(1) : null;
      temperatura.ventilador_ligado = (tempAtualVal !== null && tempSetVal !== null) ? (tempAtualVal > tempSetVal) : false;
    }

    // 3. GRAVAÇÃO NO HISTÓRICO DO SUPABASE (Essencial para os Gráficos funcionarem)
    try {
      await supabase.from('historico').insert([{
        tensao_a: eletrico.tensao_a ? parseFloat(eletrico.tensao_a) : null,
        tensao_b: eletrico.tensao_b ? parseFloat(eletrico.tensao_b) : null,
        tensao_c: eletrico.tensao_c ? parseFloat(eletrico.tensao_c) : null,
        corrente_a: eletrico.corrente_a ? parseFloat(eletrico.corrente_a) : null,
        corrente_b: eletrico.corrente_b ? parseFloat(eletrico.corrente_b) : null,
        corrente_c: eletrico.corrente_c ? parseFloat(eletrico.corrente_c) : null,
        temp_atual: temperatura.temp_atual ? parseFloat(temperatura.temp_atual) : null
      }]);
    } catch (dbError) {
      console.error("Erro ao salvar histórico no Supabase:", dbError);
    }

    // 4. LÓGICA DE ALARMES FORMATADOS COM O VALOR CLARO
    let alertas = [];
    const ta = parseFloat(eletrico.tensao_a);
    const tb = parseFloat(eletrico.tensao_b);
    const tc = parseFloat(eletrico.tensao_c);

    if (ta > LIMITE_TENSAO) alertas.push(`*Fase A:* ${ta}V - Tensão acima de ${LIMITE_TENSAO}V`);
    if (ta < 111 && ta > 0) alertas.push(`*Fase A:* ${ta}V - Tensão abaixo de 111V`);
    if (tb > LIMITE_TENSAO) alertas.push(`*Fase B:* ${tb}V - Tensão acima de ${LIMITE_TENSAO}V`);
    if (tb < 111 && tb > 0) alertas.push(`*Fase B:* ${tb}V - Tensão abaixo de 111V`);
    if (tc > LIMITE_TENSAO) alertas.push(`*Fase C:* ${tc}V - Tensão acima de ${LIMITE_TENSAO}V`);
    if (tc < 111 && tc > 0) alertas.push(`*Fase C:* ${tc}V - Tensão abaixo de 111V`);

    if (temperatura.temp_atual && temperatura.temp_set && parseFloat(temperatura.temp_atual) > parseFloat(temperatura.temp_set)) {
       alertas.push(`*Temperatura:* ${temperatura.temp_atual}°C - Acima do setpoint (${temperatura.temp_set}°C)`);
    }

    // 5. INTEGRAÇÃO TELEGRAM
    let deveEnviarTelegram = false;
    let textoMensagem = '';
    const { data: estadoAnterior } = await supabase.from('status_alarmes').select('*').eq('id', 'painel_brasileira').maybeSingle();

    const agora = new Date();
    let novoEstado = {
      em_alerta: alertas.length > 0,
      primeiro_alerta_at: estadoAnterior?.primeiro_alerta_at || null,
      ultimo_alerta_at: estadoAnterior?.ultimo_alerta_at || null,
      estagio: estadoAnterior?.estagio || 0,
      texto_alertas: alertas.join('\n')
    };

    if (alertas.length > 0) {
      if (!estadoAnterior?.em_alerta) {
        deveEnviarTelegram = true;
        textoMensagem = `⚠️ *ALERTA: ANORMALIDADE DETECTADA*\n_Painel: Brasileira Distribuidora_\n\n${novoEstado.texto_alertas}`;
        novoEstado.primeiro_alerta_at = agora.toISOString();
        novoEstado.ultimo_alerta_at = agora.toISOString();
        novoEstado.estagio = 1;
      }
    } else {
      if (estadoAnterior?.em_alerta) {
        deveEnviarTelegram = true;
        textoMensagem = `✅ *SISTEMA NORMALIZADO*\n_Painel: Brasileira Distribuidora_\n\nTodos os parâmetros retornaram aos níveis operacionais normais.`;
        novoEstado.primeiro_alerta_at = null;
        novoEstado.ultimo_alerta_at = null;
        novoEstado.estagio = 0;
      }
    }

    if (estadoAnterior) {
      await supabase.from('status_alarmes').update(novoEstado).eq('id', 'painel_brasileira');
    } else {
      await supabase.from('status_alarmes').insert([{ id: 'painel_brasileira', ...novoEstado }]);
    }

    if (deveEnviarTelegram) {
      await enviarAlertaTelegram(textoMensagem);
    }

    return res.status(200).json({
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' }),
      status: alertas.length > 0 ? 'ALERTA' : 'NORMAL',
      alertas, eletrico, temperatura, banco_dados: "OK"
    });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
