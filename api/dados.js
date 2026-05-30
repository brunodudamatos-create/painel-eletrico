// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// Painel Elétrico — Tuya API
// EARU EASEM-E (medidor elétrico) + XY-SA10-W (temperatura)
// ================================================================
// Este arquivo fica no servidor Vercel (gratuito, 24h).
// Ele busca os dados da Tuya com segurança e entrega ao Dashboard.
// Suas credenciais NUNCA aparecem para o usuário.
// ================================================================

const crypto = require('crypto');

// ---- Função de assinatura HMAC-SHA256 (exigida pela Tuya) ----
function assinar(texto, segredo) {
  return crypto
    .createHmac('sha256', segredo)
    .update(texto)
    .digest('hex')
    .toUpperCase();
}

// ---- Função auxiliar para buscar Data Point pelo código ----
function dp(arr, codigo) {
  const item = (arr || []).find(i => i.code === codigo);
  return item !== undefined ? item.value : null;
}

// ================================================================
// HANDLER PRINCIPAL — chamado toda vez que o Dashboard atualiza
// ================================================================
module.exports = async function handler(req, res) {

  // Permite que o Dashboard (GitHub Pages) acesse esta função
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  // Responde pré-flight do navegador
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ---- Lê as credenciais das variáveis de ambiente do Vercel ----
  // (você vai configurar essas variáveis no painel do Vercel)
  const CLIENT_ID          = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET      = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR  = process.env.TUYA_DEVICE_MEDIDOR;
  const DEVICE_ID_TERMOSTO = process.env.TUYA_DEVICE_TERMOSTATO;

  // Verifica se as variáveis estão configuradas
  if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID_MEDIDOR || !DEVICE_ID_TERMOSTO) {
    return res.status(500).json({
      erro: 'Variáveis de ambiente não configuradas no Vercel.',
      faltando: {
        TUYA_CLIENT_ID:          !CLIENT_ID,
        TUYA_CLIENT_SECRET:      !CLIENT_SECRET,
        TUYA_DEVICE_MEDIDOR:     !DEVICE_ID_MEDIDOR,
        TUYA_DEVICE_TERMOSTATO:  !DEVICE_ID_TERMOSTO,
      }
    });
  }

  const BASE_URL = 'https://openapi.tuyaeu.com'; // Data Center: South America

  try {

    // ============================================================
    // PASSO 1 — Autenticar na Tuya e obter access_token
    // ============================================================
    const t1 = Date.now().toString();
    const assinaturaToken = assinar(CLIENT_ID + t1, CLIENT_SECRET);

    const respostaToken = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: {
        client_id:   CLIENT_ID,
        sign:        assinaturaToken,
        t:           t1,
        sign_method: 'HMAC-SHA256',
      }
    });

    const dadosToken = await respostaToken.json();

    if (!dadosToken.success || !dadosToken.result?.access_token) {
      return res.status(401).json({
        erro: 'Falha na autenticação com a Tuya.',
        detalhe: dadosToken,
        dica: 'Verifique o TUYA_CLIENT_ID e TUYA_CLIENT_SECRET no Vercel.'
      });
    }

    const accessToken = dadosToken.result.access_token;

    // ============================================================
    // PASSO 2 — Buscar dados dos dois dispositivos em paralelo
    // ============================================================
    const t2 = Date.now().toString();
    const assinaturaDispositivo = assinar(CLIENT_ID + accessToken + t2, CLIENT_SECRET);

    const headersDispositivo = {
      client_id:    CLIENT_ID,
      access_token: accessToken,
      sign:         assinaturaDispositivo,
      t:            t2,
      sign_method:  'HMAC-SHA256',
    };

    // Busca os dois ao mesmo tempo (mais rápido)
    const [resMedidor, resTermostato] = await Promise.all([
      fetch(`${BASE_URL}/v1.0/devices/${DEVICE_ID_MEDIDOR}/status`,  { headers: headersDispositivo }),
      fetch(`${BASE_URL}/v1.0/devices/${DEVICE_ID_TERMOSTO}/status`, { headers: headersDispositivo }),
    ]);

    const dadosMedidor    = await resMedidor.json();
    const dadosTermostato = await resTermostato.json();

    const med  = dadosMedidor.result    || [];
    const term = dadosTermostato.result || [];

    // ============================================================
    // PASSO 3 — Processar dados do EARU EASEM-E
    // Conversões obrigatórias dos Data Points Tuya:
    //   voltage:      ÷ 10    (2203 → 220,3 V)
    //   current:      ÷ 1000  (12400 → 12,4 A)
    //   active_power: direto  (em Watts)
    //   power_factor: ÷ 100   (92 → 0,92)
    //   energy:       direto  (em kWh)
    //   frequency:    ÷ 10    (600 → 60,0 Hz)
    // ============================================================
    const eletrico = {
      // Fase A
      tensao_a:   dp(med,'voltage_a')      != null ? +(dp(med,'voltage_a')/10).toFixed(1)       : null,
      corrente_a: dp(med,'current_a')      != null ? +(dp(med,'current_a')/1000).toFixed(2)     : null,
      potencia_a: dp(med,'active_power_a') != null ? +dp(med,'active_power_a')                  : null,
      fat_pot_a:  dp(med,'power_factor_a') != null ? +(dp(med,'power_factor_a')/100).toFixed(2) : null,
      energia_a:  dp(med,'forward_energy_a'),
      // Fase B
      tensao_b:   dp(med,'voltage_b')      != null ? +(dp(med,'voltage_b')/10).toFixed(1)       : null,
      corrente_b: dp(med,'current_b')      != null ? +(dp(med,'current_b')/1000).toFixed(2)     : null,
      potencia_b: dp(med,'active_power_b') != null ? +dp(med,'active_power_b')                  : null,
      fat_pot_b:  dp(med,'power_factor_b') != null ? +(dp(med,'power_factor_b')/100).toFixed(2) : null,
      energia_b:  dp(med,'forward_energy_b'),
      // Fase C
      tensao_c:   dp(med,'voltage_c')      != null ? +(dp(med,'voltage_c')/10).toFixed(1)       : null,
      corrente_c: dp(med,'current_c')      != null ? +(dp(med,'current_c')/1000).toFixed(2)     : null,
      potencia_c: dp(med,'active_power_c') != null ? +dp(med,'active_power_c')                  : null,
      fat_pot_c:  dp(med,'power_factor_c') != null ? +(dp(med,'power_factor_c')/100).toFixed(2) : null,
      energia_c:  dp(med,'forward_energy_c'),
      // Totais
      energia_total: dp(med,'total_forward_energy'),
      frequencia:    dp(med,'frequency') != null ? +(dp(med,'frequency')/10).toFixed(1) : null,
      falha:         dp(med,'fault'),
    };

    eletrico.potencia_total = +((eletrico.potencia_a||0)+(eletrico.potencia_b||0)+(eletrico.potencia_c||0)).toFixed(0);

    if (eletrico.fat_pot_a != null && eletrico.fat_pot_b != null && eletrico.fat_pot_c != null)
      eletrico.fat_pot_medio = +((eletrico.fat_pot_a+eletrico.fat_pot_b+eletrico.fat_pot_c)/3).toFixed(2);

    // ============================================================
    // PASSO 4 — Processar dados do XY-SA10-W
    // Conversões:
    //   temp_current / temp_set: ÷ 10 (325 → 32,5°C)
    //   switch: true/false
    //   mode: 'auto' / 'manual'
    //   temp_alarm: true/false
    // ============================================================
    const temperatura = {
      temp_atual:        dp(term,'temp_current') != null ? +(dp(term,'temp_current')/10).toFixed(1) : null,
      temp_setpoint:     dp(term,'temp_set')     != null ? +(dp(term,'temp_set')/10).toFixed(1)     : null,
      ventilador_ligado: dp(term,'switch'),
      modo:              dp(term,'mode'),
      alarme_temp:       dp(term,'temp_alarm'),
    };

    // ============================================================
    // PASSO 5 — Gerar alertas automáticos
    // ============================================================
    const alertas = [];

    if (temperatura.temp_atual != null) {
      if (temperatura.temp_atual >= 50)
        alertas.push('🔴 CRÍTICO: Temperatura acima de 50°C! (' + temperatura.temp_atual + '°C)');
      else if (temperatura.temp_atual >= 38)
        alertas.push('🟡 ATENÇÃO: Temperatura elevada (' + temperatura.temp_atual + '°C)');
    }
    if (temperatura.alarme_temp === true)
      alertas.push('🔔 Alarme de temperatura ativado no termostato');
    if (eletrico.falha != null && eletrico.falha !== 0)
      alertas.push('⚡ Falha elétrica detectada — código: ' + eletrico.falha);
    if (eletrico.tensao_a != null && (eletrico.tensao_a < 200 || eletrico.tensao_a > 240))
      alertas.push('⚡ Tensão Fase A fora do range 200-240V: ' + eletrico.tensao_a + 'V');
    if (eletrico.tensao_b != null && (eletrico.tensao_b < 200 || eletrico.tensao_b > 240))
      alertas.push('⚡ Tensão Fase B fora do range 200-240V: ' + eletrico.tensao_b + 'V');
    if (eletrico.tensao_c != null && (eletrico.tensao_c < 200 || eletrico.tensao_c > 240))
      alertas.push('⚡ Tensão Fase C fora do range 200-240V: ' + eletrico.tensao_c + 'V');

    // ============================================================
    // PASSO 6 — Retornar payload completo ao Dashboard
    // ============================================================
    return res.status(200).json({
      timestamp:    new Date().toISOString(),
      timestamp_br: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      status:       alertas.length > 0 ? 'ALERTA' : 'NORMAL',
      alertas,
      eletrico,
      temperatura,
    });

  } catch (err) {
    return res.status(500).json({
      erro:   'Erro interno na função.',
      detalhe: err.message,
      dica:   'Verifique se os Device IDs estão corretos e se os dispositivos estão online.'
    });
  }
};
