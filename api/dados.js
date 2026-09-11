// =============================================================
// api/dados.js  —  Coleta Tuya + Alarmes + Supabase
// Versão 3.7  —  09/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v3.7 (09/09/2026)
//     - verificarFlatline: dois diagnósticos distintos
//         FALTA_ENERGIA:   medidor + termostato congelados
//         MEDIDOR_TRAVADO: só medidor congelado
//       Cada caso gera mensagem Telegram diferente e evento
//       diferente em eventos_sistema
//   v3.7 (09/09/2026)
//     - verificarFlatline: lógica de dois níveis
//       Medidor + termostato congelados → FALTA DE ENERGIA
//       Só medidor congelado → PROBLEMA NO MEDIDOR
//       Termostato verificado por congelamento (não por null)
//       pois a Tuya sempre retorna último valor conhecido
//   v3.6 (09/09/2026)
//     - verificarFlatline: removida confirmação dupla com termostato
//       MOTIVO: a API Tuya sempre retorna o último valor conhecido
//       mesmo quando o dispositivo está offline — temp_atual NUNCA
//       fica null, então a confirmação dupla jamais funcionaria
//       NOVO: flatline confirmado apenas pelo medidor elétrico —
//       4 leituras consecutivas com tensao_a + corrente_a +
//       potencia_total idênticos = falta de energia
//       Isso foi validado pelo evento real de 09/09/2026 onde os
//       dados congelaram em 60.6V/74.5V mas temp ficou em 36.9°C
//   v3.5 (06/09/2026)
//     - Limite de tensão alta ajustado de 139V para 141V
//   v3.4 (06/09/2026)
//     - verificarFlatline: confirmação dupla com termostato (REMOVIDA v3.6)
//   v3.3 (06/09/2026)
//     - Alarme de tensão alta: lógica contextual
//   v3.2 (06/09/2026)
//     - Corrigida variável deveEnviarTelegram
//   v3.1 (ago/2026)
//     - Alarme de temperatura fixo em 45°C
// =============================================================
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const LIMITE_TENSAO_MAX_CONSUMINDO = 141;
const LIMITE_TENSAO_MIN  = 111;
const HORA_SOLAR_INICIO  = 6;
const HORA_SOLAR_FIM     = 16;
const LIMITE_TEMP_ALARME = 45.0;
const FLATLINE_LEITURAS  = 4;
const TIMEZONE           = 'America/Cuiaba';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function enviarAlertaTelegram(mensagem) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: mensagem, parse_mode: 'Markdown' })
    });
  } catch (error) {
    console.error('Erro Telegram:', error);
  }
}

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash  = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal  = accessToken
    ? clientId + accessToken + timestamp + stringToSign
    : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

function dpShadow(props, codigo) {
  const item = (props || []).find(i => i.code === codigo);
  return item !== undefined ? item.value : null;
}

function numero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function encontrarEnergiaReversa(props) {
  const candidatosExatos = [
    'reverse_energy_total', 'reverse_energy', 'reverse_energy_sum', 'reverse_energy_all',
    'backward_energy_total', 'backward_energy', 'reverse_active_energy',
    'export_energy_total', 'export_energy', 'feed_in_energy',
    'energy_export', 'generated_energy', 'generation_energy', 'solar_energy', 'pv_energy'
  ];
  for (const codigo of candidatosExatos) {
    const item = (props || []).find(p => p.code === codigo);
    if (item && item.value !== null && item.value !== undefined) {
      return { codigo, valor: numero(item.value), origem: 'candidato_exato' };
    }
  }
  const candidatosAutomaticos = (props || []).filter(item => {
    const c = String(item.code || '').toLowerCase();
    return c.includes('reverse') || c.includes('backward') || c.includes('export') ||
           c.includes('feed_in') || c.includes('generated') || c.includes('generation') ||
           c.includes('solar')   || c.includes('pv');
  });
  for (const item of candidatosAutomaticos) {
    const valor = numero(item.value);
    if (valor !== null) return { codigo: item.code, valor, origem: 'deteccao_automatica' };
  }
  return { codigo: null, valor: null, origem: null };
}

// ── Detector de Flatline v3.7 ─────────────────────────────────
//
// Verifica congelamento do medidor elétrico E do termostato
// separadamente. A API Tuya retorna sempre o último valor
// conhecido — por isso não verifica null, mas sim se o valor
// ficou IDÊNTICO por N leituras consecutivas.
//
// Resultados possíveis:
//   tipo 'FALTA_ENERGIA'   — medidor + termostato congelados
//   tipo 'MEDIDOR_TRAVADO' — só medidor congelado
//   tipo null              — tudo variando normalmente

async function verificarFlatline() {
  // Busca últimas N leituras com medidor + temperatura
  const { data, error } = await supabase
    .from('telemetria_eletrica')
    .select('id, timestamp, tensao_a, corrente_a, potencia_total, temp_atual')
    .order('id', { ascending: false })
    .limit(FLATLINE_LEITURAS);

  if (error || !data || data.length < FLATLINE_LEITURAS) {
    return { flatline: false, tipo: null, motivo: 'leituras insuficientes no banco' };
  }

  // ── Verificar medidor elétrico ────────────────────────────
  const sinaisEletricos = ['tensao_a', 'corrente_a', 'potencia_total'];
  const detalhes = {};
  let medidorTravado = true;

  for (const sinal of sinaisEletricos) {
    const valores = data.map(l => numero(l[sinal]));
    if (valores.some(v => v === null)) {
      detalhes[sinal] = { congelado: false, motivo: 'valores nulos' };
      medidorTravado = false;
      continue;
    }
    const referencia  = valores[0];
    const todosIguais = valores.every(v => v === referencia);
    detalhes[sinal]   = { valor: referencia, congelado: todosIguais };
    if (!todosIguais) medidorTravado = false;
  }

  // Se medidor não travou — tudo normal
  if (!medidorTravado) {
    return { flatline: false, tipo: null, sinais: detalhes,
             motivo: 'Sinais elétricos variando — normal' };
  }

  // ── Verificar termostato ──────────────────────────────────
  const tempsAnterior = data.map(l => numero(l['temp_atual']));
  const termostatoTravado = tempsAnterior.every(v => v !== null) &&
                            tempsAnterior.every(v => v === tempsAnterior[0]);

  detalhes['temp_atual'] = {
    valor:     tempsAnterior[0],
    congelado: termostatoTravado
  };

  // ── Diagnóstico final ─────────────────────────────────────
  if (medidorTravado && termostatoTravado) {
    return {
      flatline:          true,
      tipo:              'FALTA_ENERGIA',
      leituras_checadas: FLATLINE_LEITURAS,
      sinais:            detalhes,
      motivo:            'Medidor elétrico + termostato congelados — falta de energia confirmada',
    };
  }

  // Só medidor travado — problema no medidor
  return {
    flatline:          true,
    tipo:              'MEDIDOR_TRAVADO',
    leituras_checadas: FLATLINE_LEITURAS,
    sinais:            detalhes,
    motivo:            'Medidor elétrico congelado, termostato OK — verificar medidor',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const CLIENT_ID            = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET        = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR    = process.env.TUYA_DEVICE_MEDIDOR;
  const DEVICE_ID_TERMOSTATO = process.env.TUYA_DEVICE_TERMOSTATO;
  const BASE_URL             = 'https://openapi.tuyaus.com';

  try {

    // ── 1. TOKEN TUYA ─────────────────────────────────────────

    const t1       = Date.now().toString();
    const tokenRes = await fetch(`${BASE_URL}/v1.0/token?grant_type=1`, {
      headers: {
        client_id:   CLIENT_ID,
        sign:        gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', '/v1.0/token?grant_type=1'),
        t:           t1,
        sign_method: 'HMAC-SHA256'
      }
    });
    const tokenData = await tokenRes.json();
    const token     = tokenData.result?.access_token;
    if (!token) throw new Error('Não foi possível obter o token da Tuya.');

    // ── 2. MEDIDOR ELÉTRICO ───────────────────────────────────

    const t2        = Date.now().toString();
    const urlShadow = `/v2.0/cloud/thing/${DEVICE_ID_MEDIDOR}/shadow/properties`;

    const resShadow = await fetch(`${BASE_URL}${urlShadow}`, {
      headers: {
        client_id:    CLIENT_ID,
        access_token: token,
        sign:         gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlShadow, token),
        t:            t2,
        sign_method:  'HMAC-SHA256'
      }
    });
    const dataShadow     = await resShadow.json();
    const props          = dataShadow.result?.properties || [];
    const dpsDisponiveis = props.map(item => ({ code: item.code, value: item.value }));
    const energiaReversa = encontrarEnergiaReversa(props);

    const eletrico = {
      tensao_a:    dpShadow(props, 'voltage_a')      != null ? (dpShadow(props, 'voltage_a') / 10).toFixed(1)      : null,
      corrente_a:  dpShadow(props, 'current_a')      != null ? (dpShadow(props, 'current_a') / 1000).toFixed(2)    : null,
      potencia_a:  dpShadow(props, 'active_power_a'),
      fat_pot_a:   dpShadow(props, 'power_factor_a') != null ? (dpShadow(props, 'power_factor_a') / 100).toFixed(2): null,
      energia_a:   dpShadow(props, 'forward_energy_a'),
      tensao_b:    dpShadow(props, 'voltage_b')      != null ? (dpShadow(props, 'voltage_b') / 10).toFixed(1)      : null,
      corrente_b:  dpShadow(props, 'current_b')      != null ? (dpShadow(props, 'current_b') / 1000).toFixed(2)    : null,
      potencia_b:  dpShadow(props, 'active_power_b'),
      fat_pot_b:   dpShadow(props, 'power_factor_b') != null ? (dpShadow(props, 'power_factor_b') / 100).toFixed(2): null,
      energia_b:   dpShadow(props, 'forward_energy_b'),
      tensao_c:    dpShadow(props, 'voltage_c')      != null ? (dpShadow(props, 'voltage_c') / 10).toFixed(1)      : null,
      corrente_c:  dpShadow(props, 'current_c')      != null ? (dpShadow(props, 'current_c') / 1000).toFixed(2)    : null,
      potencia_c:  dpShadow(props, 'active_power_c'),
      fat_pot_c:   dpShadow(props, 'power_factor_c') != null ? (dpShadow(props, 'power_factor_c') / 100).toFixed(2): null,
      energia_c:   dpShadow(props, 'forward_energy_c'),
      energia_total:        dpShadow(props, 'forward_energy_total'),
      energia_gerada_total: energiaReversa.valor,
      energia_gerada_dp:    energiaReversa.codigo,
      potencia_total:       dpShadow(props, 'active_power_total'),
      frequencia:           dpShadow(props, 'frequency'),
      falha:                dpShadow(props, 'fault'),
    };

    // ── 3. TERMOSTATO ─────────────────────────────────────────

    let temperatura = { temp_atual: null, temp_set: null, ventilador_ligado: false };

    const t3       = Date.now().toString();
    const urlTermo = `/v1.0/iot-03/devices/${DEVICE_ID_TERMOSTATO}/status`;

    const resTermo = await fetch(`${BASE_URL}${urlTermo}`, {
      headers: {
        client_id:    CLIENT_ID,
        access_token: token,
        sign:         gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t3, 'GET', urlTermo, token),
        t:            t3,
        sign_method:  'HMAC-SHA256'
      }
    });
    const dataTermo = await resTermo.json();

    if (dataTermo.result && Array.isArray(dataTermo.result)) {
      const itemTemp = dataTermo.result.find(i => i.code === 'temp_current');
      const itemSet  = dataTermo.result.find(i => i.code === 'temp_set');
      const normalize = (item) =>
        item?.value != null
          ? (item.value > 100 ? item.value / 10 : Number(item.value))
          : null;
      const tempAtualVal = normalize(itemTemp);
      const tempSetVal   = normalize(itemSet);
      temperatura.temp_atual        = tempAtualVal !== null ? tempAtualVal.toFixed(1) : null;
      temperatura.temp_set          = tempSetVal   !== null ? tempSetVal.toFixed(1)   : null;
      temperatura.ventilador_ligado = (tempAtualVal !== null && tempSetVal !== null)
        ? tempAtualVal > tempSetVal : false;
    }

    // ── 4. GRAVAÇÃO SUPABASE ──────────────────────────────────

    let bancoStatus = 'Não gravado';
    try {
      const { error: dbError } = await supabase
        .from('telemetria_eletrica')
        .insert([{
          tensao_a:             eletrico.tensao_a,
          corrente_a:           eletrico.corrente_a,
          potencia_a:           eletrico.potencia_a,
          fat_pot_a:            eletrico.fat_pot_a,
          energia_a:            eletrico.energia_a,
          tensao_b:             eletrico.tensao_b,
          corrente_b:           eletrico.corrente_b,
          potencia_b:           eletrico.potencia_b,
          fat_pot_b:            eletrico.fat_pot_b,
          energia_b:            eletrico.energia_b,
          tensao_c:             eletrico.tensao_c,
          corrente_c:           eletrico.corrente_c,
          potencia_c:           eletrico.potencia_c,
          fat_pot_c:            eletrico.fat_pot_c,
          energia_c:            eletrico.energia_c,
          energia_total:        eletrico.energia_total,
          energia_gerada_total: eletrico.energia_gerada_total,
          potencia_total:       eletrico.potencia_total,
          frequencia:           eletrico.frequencia,
          temp_atual:           temperatura.temp_atual,
        }]);
      if (dbError) throw dbError;
      bancoStatus = 'Gravação Sucesso';
    } catch (dbErr) {
      console.error('Erro Supabase:', dbErr);
      bancoStatus = 'Erro Supabase: ' + dbErr.message;
    }

    // ── 5. ALARMES ────────────────────────────────────────────

    let alertas = [];

    // 5a. Tensão
    const ta       = parseFloat(eletrico.tensao_a);
    const tb       = parseFloat(eletrico.tensao_b);
    const tc       = parseFloat(eletrico.tensao_c);
    const potTotal = parseFloat(eletrico.potencia_total);

    const horaLocal = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Cuiaba' })
    ).getHours();
    const dentroHorarioSolar = horaLocal >= HORA_SOLAR_INICIO && horaLocal < HORA_SOLAR_FIM;
    const exportando         = !isNaN(potTotal) && potTotal < 0;
    const suprimirAlarme     = exportando || dentroHorarioSolar;

    const msgConcessionaria = (fase, v) =>
      `*Tensão ALTA — Fase ${fase}:* ${v}V\n` +
      `Tensão da concessionária acima do limite (${LIMITE_TENSAO_MAX_CONSUMINDO}V).\n` +
      `✅ Ação: abrir chamado na concessionária solicitando regularização da tensão.`;

    if (!suprimirAlarme) {
      if (!isNaN(ta) && ta > LIMITE_TENSAO_MAX_CONSUMINDO) alertas.push(msgConcessionaria('A', ta));
      if (!isNaN(tb) && tb > LIMITE_TENSAO_MAX_CONSUMINDO) alertas.push(msgConcessionaria('B', tb));
      if (!isNaN(tc) && tc > LIMITE_TENSAO_MAX_CONSUMINDO) alertas.push(msgConcessionaria('C', tc));
    }

    if (!isNaN(ta) && ta < LIMITE_TENSAO_MIN && ta > 0) alertas.push(`*Fase A:* ${ta}V — Tensão abaixo de ${LIMITE_TENSAO_MIN}V`);
    if (!isNaN(tb) && tb < LIMITE_TENSAO_MIN && tb > 0) alertas.push(`*Fase B:* ${tb}V — Tensão abaixo de ${LIMITE_TENSAO_MIN}V`);
    if (!isNaN(tc) && tc < LIMITE_TENSAO_MIN && tc > 0) alertas.push(`*Fase C:* ${tc}V — Tensão abaixo de ${LIMITE_TENSAO_MIN}V`);

    // 5b. Temperatura
    const tempAtualNum = parseFloat(temperatura.temp_atual);
    if (!isNaN(tempAtualNum) && tempAtualNum >= LIMITE_TEMP_ALARME) {
      alertas.push(`*Temperatura:* ${tempAtualNum.toFixed(1)}°C - Acima do limite de ${LIMITE_TEMP_ALARME}°C`);
    }

    // 5c. Estado anterior (para anti-spam)
    const { data: estadoAnterior } = await supabase
      .from('status_alarmes')
      .select('*')
      .eq('id', 'painel_brasileira')
      .maybeSingle();

    const agora    = new Date();
    const agoraISO = agora.toISOString();

    // 5d. Flatline — medidor elétrico + termostato (v3.7)
    const flatlineInfo = await verificarFlatline();
    if (flatlineInfo.flatline) {

      if (flatlineInfo.tipo === 'FALTA_ENERGIA') {
        // Medidor + termostato congelados = falta de energia real
        alertas.push(
          `*⚡ Falta de Energia Detectada*\n` +
          `Medidor elétrico e termostato com dados congelados ` +
          `por ${FLATLINE_LEITURAS} leituras consecutivas.\n` +
          `Verifique o quadro elétrico e registre a ocorrência.`
        );
      } else if (flatlineInfo.tipo === 'MEDIDOR_TRAVADO') {
        // Só medidor congelado = problema no equipamento
        alertas.push(
          `*🔌 Dados Elétricos Congelados*\n` +
          `Medidor elétrico com sinais travados por ${FLATLINE_LEITURAS} leituras.\n` +
          `Termostato operando normalmente.\n` +
          `Verifique o medidor elétrico (EARU EASEM-E).`
        );
      }

      // Grava evento apenas na transição normal → problema
      if (!estadoAnterior?.em_alerta) {
        try {
          await supabase.from('eventos_sistema').insert([{
            tipo:      flatlineInfo.tipo,  // 'FALTA_ENERGIA' ou 'MEDIDOR_TRAVADO'
            device_id: 'painel_brasileira',
            detalhes:  flatlineInfo,
          }]);
        } catch (evErr) {
          console.error('Erro ao gravar evento:', evErr);
        }
      }
    }

    // ── 6. TELEGRAM ───────────────────────────────────────────

    let deveEnviarTelegram = false;
    let textoMensagem      = '';

    const novoEstado = {
      em_alerta:          alertas.length > 0,
      primeiro_alerta_at: estadoAnterior?.primeiro_alerta_at || null,
      ultimo_alerta_at:   estadoAnterior?.ultimo_alerta_at   || null,
      estagio:            estadoAnterior?.estagio            || 0,
      texto_alertas:      alertas.join('\n'),
    };

    if (alertas.length > 0 && !estadoAnterior?.em_alerta) {
      deveEnviarTelegram = true;
      novoEstado.primeiro_alerta_at = agoraISO;
      novoEstado.ultimo_alerta_at   = agoraISO;
      novoEstado.estagio            = 1;

      const horaBR       = agora.toLocaleString('pt-BR', { timeZone: TIMEZONE });
      const sufixoFlatline = flatlineInfo.tipo === 'FALTA_ENERGIA'
        ? `\n\n⚡ *Causa:* Medidor + termostato congelados por ${FLATLINE_LEITURAS} leituras.`
        : flatlineInfo.tipo === 'MEDIDOR_TRAVADO'
        ? `\n\n🔧 *Causa:* Sinais do medidor congelados (termostato OK).`
        : '';

      textoMensagem =
        `⚠️ *ALERTA: ANORMALIDADE DETECTADA*\n` +
        `_Painel: Brasileira Distribuidora_\n` +
        `_${horaBR}_\n\n` +
        alertas.join('\n') +
        sufixoFlatline;

    } else if (alertas.length === 0 && estadoAnterior?.em_alerta) {
      deveEnviarTelegram = true;
      novoEstado.primeiro_alerta_at = null;
      novoEstado.ultimo_alerta_at   = null;
      novoEstado.estagio            = 0;

      textoMensagem =
        `✅ *SISTEMA NORMALIZADO*\n` +
        `_Painel: Brasileira Distribuidora_\n\n` +
        `Todos os parâmetros retornaram aos níveis operacionais normais.`;
    }

    if (estadoAnterior) {
      await supabase.from('status_alarmes').update(novoEstado).eq('id', 'painel_brasileira');
    } else {
      await supabase.from('status_alarmes').insert([{ id: 'painel_brasileira', ...novoEstado }]);
    }

    if (deveEnviarTelegram) await enviarAlertaTelegram(textoMensagem);

    // ── 7. RESPOSTA ───────────────────────────────────────────

    return res.status(200).json({
      timestamp_br: agora.toLocaleString('pt-BR', { timeZone: TIMEZONE }),
      status:       alertas.length > 0 ? 'ALERTA' : 'NORMAL',
      alertas,
      flatline:     flatlineInfo,
      eletrico,
      temperatura,
      banco_dados:  bancoStatus,
      diagnostico_tuya: {
        total_dps:             dpsDisponiveis.length,
        energia_consumo_dp:    'forward_energy_total',
        energia_geracao_dp:    energiaReversa.codigo,
        energia_geracao_valor: energiaReversa.valor,
        origem:                energiaReversa.origem,
        dps_disponiveis:       dpsDisponiveis,
      },
    });

  } catch (err) {
    console.error('Erro /api/dados:', err);
    return res.status(500).json({ erro: err.message });
  }
}
