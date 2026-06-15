// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// Painel Elétrico — Tuya API (APENAS MEDIDOR OPERANTE)
// EARU EASEM-E (medidor elétrico)
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

  // ---- Lê as credenciais essenciais das variáveis do Vercel ----
  const CLIENT_ID          = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET      = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR  = process.env.TUYA_DEVICE_MEDIDOR;

  // Verifica se as variáveis do medidor estão configuradas
  if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID_MEDIDOR) {
    return res.status(500).json({
      erro: 'Variáveis de ambiente essenciais não configuradas no Vercel.',
      faltando: {
        TUYA_CLIENT_ID:          !CLIENT_ID,
        TUYA_CLIENT_SECRET:      !CLIENT_SECRET,
        TUYA_DEVICE_MEDIDOR:     !DEVICE_ID_MEDIDOR,
      }
    });
  }

  const BASE_URL = 'https://openapi.tuyaus.com'; // Data Center: Western America Data Center

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
        dica: 'Verifique se o TUYA_CLIENT_ID e TUYA_CLIENT_SECRET estão perfeitamente corretos no Vercel.'
      });
    }

    const accessToken = dadosToken.result.access_token;

    // ============================================================
    // PASSO 2 — Buscar dados APENAS do medidor elétrico
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

    const resMedidor = await fetch(`${BASE_URL}/v1.0/devices/${DEVICE_ID_MEDIDOR}/status`, { headers: headersDispositivo });
    const dadosMedidor = await resMedidor.json();
    const med = dadosMedidor.result || [];

    // ============================================================
    // PASSO 3 — Processar dados do EARU EASEM-E
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
    // PASSO 4 — Termostato Desativado (Evita que o Dashboard quebre)
    // ============================================================
    const temperatura = {
      temp_atual:        null,
      temp_setpoint:     null,
      ventilador_ligado: false,
      modo:              'manual',
      alarme_temp:       false,
    };

    // ============================================================
    // PASSO 5 — Gerar alertas automáticos
    // ============================================================
    const alertas = [];

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
      dica:   'Verifique se o Device ID do medidor está correto e se está online.'
    });
  }
};
