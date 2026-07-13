// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// PAINEL ELÉTRICO + TERMOSTATO — VERSÃO CORRIGIDA versão do GROK para correção
// ================================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function enviarAlertaTelegram(mensagem) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT_ID, text: mensagem, parse_mode: 'Markdown' }) });
  } catch (e) { console.error("Erro Telegram", e); }
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

  console.log("=== INÍCIO EXECUÇÃO ===");

  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR = process.env.TUYA_DEVICE_MEDIDOR;
  const DEVICE_ID_TERMOSTATO = process.env.TUYA_DEVICE_TERMOSTATO;
  const BASE_URL = 'https://openapi.tuyaus.com';

  let temperatura = { temp_atual: null, status: "falha", detalhes: "nenhum" };

  try {
    // Autenticação
    const t1 = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: { client_id: CLIENT_ID, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'), t: t1, sign_method: 'HMAC-SHA256' }
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.result?.access_token;

    // === MEDIDOR (mantido igual) ===
    const t2 = Date.now().toString();
    const urlShadow = `/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`;
    const resShadow = await fetch(`${BASE_URL}${urlShadow}`, {
      headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlShadow, token), t: t2, sign_method: 'HMAC-SHA256' }
    });
    const dataShadow = await resShadow.json();
    const props = dataShadow.result?.properties || [];

    const eletrico = { /* ... seu código do eletrico completo, mantenha igual ... */ 
      // (cole aqui todo o objeto eletrico do seu código anterior)
    };

    // === NOVO: VÁRIAS TENTATIVAS PARA O TERMOSTATO ===
    if (DEVICE_ID_TERMOSTATO) {
      const tentativas = [
        { nome: "status_v1", url: `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status` },
        { nome: "shadow_v2", url: `/v2.0/cloud/thing/${DEVICE_ID_TERMOSTATO}/shadow/properties` }
      ];

      for (const tentativa of tentativas) {
        try {
          const t = Date.now().toString();
          console.log(`Tentativa ${tentativa.nome}...`);

          const resp = await fetch(`${BASE_URL}${tentativa.url}`, {
            headers: { client_id: CLIENT_ID, access_token: token, sign: gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t, 'GET', tentativa.url, token), t: t, sign_method: 'HMAC-SHA256' }
          });

          const data = await resp.json();
          console.log(`Resposta ${tentativa.nome}:`, JSON.stringify(data));

          if (data.result) {
            const propsT = Array.isArray(data.result) ? data.result : (data.result.properties || []);
            let val = dpShadow(propsT, 'temp_current') || dpShadow(propsT, 'temperature') || dpShadow(propsT, 'cur_temperature') || dpShadow(propsT, 'current_temperature');

            if (val !== null) {
              temperatura.temp_atual = (val > 100 ? val / 10 : val).toFixed(1);
              temperatura.status = "sucesso";
              temperatura.detalhes = `Encontrado via ${tentativa.nome}`;
              break;
            }
          }
        } catch (e) {
          console.error(`Erro na tentativa ${tentativa.nome}`, e.message);
        }
      }
    }

    // Retorno final
    return res.status(200).json({
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' }),
      status: "OK",
      eletrico,
      temperatura,
      debug_info: "Ver logs da Vercel para mais detalhes"
    });

  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
};
