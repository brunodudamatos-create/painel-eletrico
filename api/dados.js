// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// Painel Elétrico — Tuya API (PADRÃO DE SEGURANÇA V2)
// MAPEAMENTO EXATO - INSTRUCTIONS TABLE
// ================================================================

const crypto = require('crypto');

// ---- Função de Assinatura Oficial Tuya ----
function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal = accessToken ? clientId + accessToken + timestamp + stringToSign : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

// ---- Função auxiliar para buscar o valor exato no JSON ----
function dp(arr, codigo) {
  const item = (arr || []).find(i => i.code === codigo);
  return item !== undefined ? item.value : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLIENT_ID          = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET      = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR  = process.env.TUYA_DEVICE_MEDIDOR;

  if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID_MEDIDOR) {
    return res.status(500).json({ erro: 'Variáveis de ambiente ausentes no Vercel.' });
  }

  const BASE_URL = 'https://openapi.tuyaus.com'; 

  try {
    // 1. Geração do Token
    const t1 = Date.now().toString();
    const urlToken = '/v1.0/token?grant_type=1';
    const assToken = gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', urlToken);

    const resToken = await fetch(`${BASE_URL}${urlToken}`, {
      headers: { client_id: CLIENT_ID, sign: assToken, t: t1, sign_method: 'HMAC-SHA256' }
    });
    const dadosToken = await resToken.json();
    const accessToken = dadosToken.result?.access_token;

    if (!accessToken) throw new Error('Falha de autenticação com a Tuya.');

    // 2. Busca o Status Real do Dispositivo
    const t2 = Date.now().toString();
    const urlMedidor = `/v1.0/devices/${DEVICE_ID_MEDIDOR}/status`;
    const assDisp = gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlMedidor, accessToken);

    const resMedidor = await fetch(`${BASE_URL}${urlMedidor}`, {
      headers: { client_id: CLIENT_ID, access_token: accessToken, sign: assDisp, t: t2, sign_method: 'HMAC-SHA256' }
    });
    const dadosMed = await resMedidor.json();
    const med = dadosMed.result || [];

    // 3. Mapeamento fiel à sua Tabela de Instruções (Table of Instructions)
    const eletrico = {
      tensao_a:   dp(med, 'voltage_a'),
      corrente_a: dp(med, 'current_a'),
      potencia_a: dp(med, 'active_power_a'),
      fat_pot_a:  dp(med, 'power_factor_a'),
      energia_a:  dp(med, 'forward_energy_a'),

      tensao_b:   dp(med, 'voltage_b'),
      corrente_b: dp(med, 'current_b'),
      potencia_b: dp(med, 'active_power_b'),
      fat_pot_b:  dp(med, 'power_factor_b'),
      energia_b:  dp(med, 'forward_energy_b'),

      tensao_c:   dp(med, 'voltage_c'),
      corrente_c: dp(med, 'current_c'),
      potencia_c: dp(med, 'active_power_c'),
      fat_pot_c:  dp(med, 'power_factor_c'),
      energia_c:  dp(med, 'forward_energy_c'),

      energia_total:  dp(med, 'forward_energy_total'),
      potencia_total: dp(med, 'active_power_total'),
      frequencia:     dp(med, 'frequency'),
      falha:          dp(med, 'fault'),
    };

    const temperatura = {
      temp_atual: null, temp_setpoint: null, ventilador_ligado: false, modo: 'manual', alarme_temp: false
    };

    const alertas = [];
    if (eletrico.falha && eletrico.falha !== 0 && eletrico.falha !== "0") {
        alertas.push('⚡ Falha elétrica detectada — código: ' + eletrico.falha);
    }

    return res.status(200).json({
      timestamp:    new Date().toISOString(),
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      status:       alertas.length > 0 ? 'ALERTA' : 'NORMAL',
      alertas,
      eletrico,
      temperatura,
    });

  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno', detalhe: err.message });
  }
};
