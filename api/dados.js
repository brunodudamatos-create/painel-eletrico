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

    // 4. Lógica de Alarmes Completos (Tensões e Correntes)
    let alertas = [];
    const ta = parseFloat(eletrico.tensao_a);
    const tb = parseFloat(eletrico.tensao_b);
    const tc = parseFloat(eletrico.tensao_c);
    const ia = parseFloat(eletrico.corrente_a);
    const ib = parseFloat(eletrico.corrente_b);
    const ic = parseFloat(eletrico.corrente_c);

    // Limites de Tensão
    if (ta > 139) alertas.push(`*Fase A:* Alta tensão (${ta}V)`);
    if (ta < 111 && ta > 0) alertas.push(`*Fase A:* Baixa tensão (${ta}V)`);
    if (tb > 139) alertas.push(`*Fase B:* Alta tensão (${tb}V)`);
    if (tb < 111 && tb > 0) alertas.push(`*Fase B:* Baixa tensão (${tb}V)`);
    if (tc > 139) alertas.push(`*Fase C:* Alta tensão (${tc}V)`);
    if (tc < 111 && tc > 0) alertas.push(`*Fase C:* Baixa tensão (${tc}V)`);

    // Limites de Corrente (Configurado para 50A)
    const LIMITE_CORRENTE = 50.0;
    if (ia > LIMITE_CORRENTE) alertas.push(`*Fase A:* Alta corrente (${ia}A)`);
    if (ib > LIMITE_CORRENTE) alertas.push(`*Fase B:* Alta corrente (${ib}A)`);
    if (ic > LIMITE_CORRENTE) alertas.push(`*Fase C:* Alta corrente (${ic}A)`);

    // 5. Controle do Telegram e Supabase (status_alarmes)
    let deveEnviarTelegram = false;
    let textoMensagem = '';

    const { data: estadoAnterior } = await supabase
      .from('status_alarmes')
      .select('*')
      .eq('id', 'painel_brasileira')
      .maybeSingle();

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
        textoMensagem = `⚠️ *ALERTA: ANORMALIDADE ELÉTRICA*\n_Painel: Brasileira Distribuidora_\n\n${novoEstado.texto_alertas}`;
        novoEstado.primeiro_alerta_at = agora.toISOString();
        novoEstado.ultimo_alerta_at = agora.toISOString();
        novoEstado.estagio = 1;
      } else {
        const primeiroAlerta = new Date(estadoAnterior.primeiro_alerta_at);
        const ultimoAlerta = new Date(estadoAnterior.ultimo_alerta_at);
        const diffHorasDesdePrimeiro = (agora - primeiroAlerta) / (1000 * 60 * 60);
        const diffHorasDesdeUltimo = (agora - ultimoAlerta) / (1000 * 60 * 60);

        if (novoEstado.estagio === 1 && diffHorasDesdePrimeiro >= 1) {
          deveEnviarTelegram = true;
          textoMensagem = `⚠️ *RELEMBRETE (1 HORA): ANORMALIDADE ELÉTRICA*\n_Painel: Brasileira Distribuidora_\n\n${novoEstado.texto_alertas}`;
          novoEstado.ultimo_alerta_at = agora.toISOString();
          novoEstado.estagio = 2;
        } else if (novoEstado.estagio === 2 && diffHorasDesdeUltimo >= 24) {
          deveEnviarTelegram = true;
          textoMensagem = `⚠️ *RELEMBRETE (24 HORAS): ANORMALIDADE ELÉTRICA*\n_Painel: Brasileira Distribuidora_\n\n${novoEstado.texto_alertas}`;
          novoEstado.ultimo_alerta_at = agora.toISOString();
        }
      }
    } else {
      if (estadoAnterior?.em_alerta) {
        deveEnviarTelegram = true;
        textoMensagem = `✅ *SISTEMA NORMALIZADO*\n_Painel: Brasileira Distribuidora_\n\nAs grandezas elétricas retornaram aos níveis operacionais normais.`;
        novoEstado.primeiro_alerta_at = null;
        novoEstado.ultimo_alerta_at = null;
        novoEstado.estagio = 0;
      }
    }

    // Atualiza/Cria o registro do estado do alarme no BD
    if (estadoAnterior) {
      await supabase.from('status_alarmes').update(novoEstado).eq('id', 'painel_brasileira');
    } else {
      await supabase.from('status_alarmes').insert([{ id: 'painel_brasileira', ...novoEstado }]);
    }

    // Dispara o Telegram se as condições forem atendidas
    if (deveEnviarTelegram) {
      await enviarAlertaTelegram(textoMensagem);
    }

    // 6. Retorno da API para o Dashboard
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
