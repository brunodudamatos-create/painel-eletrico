// =============================================================
// api/dados.js  —  Coleta Tuya + Alarmes + Supabase
// Versão 3.4  —  06/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v3.4 (06/09/2026)
//     - verificarFlatline: confirmação dupla com termostato
//       Se medidor congelado + termostato offline → falta de energia
//       Se só medidor congelado → problema no medidor (não alarma)
//       temp_atual do termostato passado como parâmetro para evitar
//       chamada extra ao banco
//     - Mensagem de falta de energia mais descritiva e acionável
//   v3.3 (06/09/2026)
//     - Alarme de tensão alta: lógica contextual baseada em análise
//       estatística de 30 dias de dados reais do banco
//     - SUPRIMIDO quando exportando (potencia_total < 0) — tensão
//       elevada é efeito normal do inversor solar injetando na rede
//     - SUPRIMIDO entre 06h–16h (Cuiabá) — inversor pode estar ativo
//       mesmo com potencia_total >= 0 (consumo absorvendo a geração)
//     - Limite ajustado para 139V (base: P95 consumindo = 137V,
//       máx histórico consumindo = 139.6V — picos raros e anômalos)
//     - Mensagem de alarme inclui instrução de ação:
//       "Abrir chamado na concessionária solicitando regularização"
//     - Tensão baixa (< 111V): mantida, sempre alarma
//   v3.2 (06/09/2026)
//     - Corrigida variável deveEnviarTelegram (estava sem declaração
//       let, causando FUNCTION_INVOCATION_FAILED na Vercel)
//     - Gravação de evento em eventos_sistema ao detectar flatline
//     - estadoAnterior buscado antes da detecção de flatline
//   v3.1 (ago/2026)
//     - Alarme de temperatura: fixo em 45°C
//     - Alarme de flatline: detecta medidor travado após 4 leituras
// =============================================================
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ── Constantes ────────────────────────────────────────────────

const LIMITE_TENSAO_MAX_CONSUMINDO = 139;  // V — alarme SEM geração solar
//   Base: consumindo sem geração, P95 = 137V, máx histórico = 139.6V
//   Acima de 139V sem geração = problema real da concessionária
const LIMITE_TENSAO_MAX_EXPORTANDO = 999;  // V — nunca alarma tensão alta exportando
//   Tensão alta exportando = inversor operando normalmente (até 143V visto)
//   Sem ação possível sem impacto financeiro — silenciado completamente
const LIMITE_TENSAO_MIN  = 111;    // V — abaixo (e > 0) → alerta queda
// Horário solar: inversor só opera entre 06h e 16h (Cuiabá, GMT-4 fixo)
// Fora desse horário o inversor certamente não está ativo
const HORA_SOLAR_INICIO  = 6;     // hora local Cuiabá
const HORA_SOLAR_FIM     = 16;    // hora local Cuiabá (exclusivo)
const LIMITE_TEMP_ALARME = 45.0;   // °C — limite físico fixo de temperatura
const FLATLINE_LEITURAS  = 4;      // leituras idênticas consecutivas = medidor travado
const TIMEZONE           = 'America/Cuiaba';

// ── Supabase ──────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Telegram ──────────────────────────────────────────────────

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

// ── Assinatura Tuya ───────────────────────────────────────────

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash  = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal  = accessToken
    ? clientId + accessToken + timestamp + stringToSign
    : clientId + timestamp + stringToSign;

  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

// ── Helpers ───────────────────────────────────────────────────

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

// ── Detector de Flatline ──────────────────────────────────────
//
// Busca as últimas N leituras do banco (JÁ incluindo a que
// acabou de ser gravada nesta execução) e verifica se os 3
// sinais monitorados têm o MESMO valor em TODAS as leituras.
//
// Por que esses 3 sinais?
//   • tensao_a     — cai para zero sem energia
//   • corrente_a   — cai para zero sem carga
//   • potencia_total — reflete o estado geral do sistema
//
// Leituras insuficientes (< N): retorna flatline=false para
// evitar falsos positivos nos primeiros registros do sistema.

async function verificarFlatline(tempAtualTermostato) {
  // ── Passo 1: medidor elétrico — sinais congelados? ─────────
  const { data, error } = await supabase
    .from('telemetria_eletrica')
    .select('id, timestamp, tensao_a, corrente_a, potencia_total')
    .order('id', { ascending: false })
    .limit(FLATLINE_LEITURAS);

  if (error || !data || data.length < FLATLINE_LEITURAS) {
    return { flatline: false, motivo: 'leituras insuficientes no banco' };
  }

  const sinais = ['tensao_a', 'corrente_a', 'potencia_total'];
  const detalhes = {};
  let medidorTravado = true;

  for (const sinal of sinais) {
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

  if (!medidorTravado) {
    return { flatline: false, sinais: detalhes };
  }

  // ── Passo 2: confirmação dupla com termostato ───────────────
  // Se o medidor elétrico está congelado E o termostato também
  // não respondeu (temp_atual null), é falta de energia real.
  // Se só o medidor travou mas o termostato OK → problema no medidor.
  const termostatoCaiu = tempAtualTermostato === null ||
                         tempAtualTermostato === undefined;

  return {
    flatline:            termostatoCaiu,  // só confirma se os DOIS caíram
    medidor_congelado:   true,
    termostato_caiu:     termostatoCaiu,
    confirmacao_dupla:   true,
    leituras_checadas:   FLATLINE_LEITURAS,
    sinais:              detalhes,
    motivo: termostatoCaiu
      ? 'Medidor congelado + termostato offline → falta de energia confirmada'
      : 'Medidor congelado mas termostato OK → possível problema no medidor (não é falta de energia)',
  };
}

// ── Handler ───────────────────────────────────────────────────

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

    const dataShadow  = await resShadow.json();
    const props       = dataShadow.result?.properties || [];
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
        ? tempAtualVal > tempSetVal
        : false;
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

    // 5a. Tensão por fase
    const ta = parseFloat(eletrico.tensao_a);
    const tb = parseFloat(eletrico.tensao_b);
    const tc = parseFloat(eletrico.tensao_c);
    const potTotal = parseFloat(eletrico.potencia_total);

    // ── Lógica contextual de tensão alta ─────────────────────────
    //
    // Critérios para suprimir o alarme de tensão alta:
    //   1. Sistema exportando (potencia_total < 0): inversor injetando
    //      na rede → tensão elevada é normal, sem ação possível
    //   2. Dentro do horário solar (06h–16h Cuiabá): inversor pode estar
    //      ativo mesmo que potencia_total >= 0 (consumo absorve geração)
    //
    // Alarme SOMENTE se todos os critérios abaixo forem verdadeiros:
    //   • tensao > 139V  (anomalia real — base: P95 consumindo = 137V)
    //   • potencia_total >= 0 (não está exportando)
    //   • hora fora de 06h–16h (inversor certamente inativo)
    //
    // Mensagem já instrui a ação: abrir chamado na concessionária.
    //
    // Análise de base (30 dias de dados reais):
    //   Consumindo P95 = 137V, máx = 139.6V (raro)
    //   Exportando P95 = 141.3V, máx = 143.3V (normal)
    //   Inflexão consumindo→exportando ocorre em 137–138V

    const horaLocal = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Cuiaba' })
    ).getHours();

    const dentroHorarioSolar = horaLocal >= HORA_SOLAR_INICIO && horaLocal < HORA_SOLAR_FIM;
    const exportando          = !isNaN(potTotal) && potTotal < 0;
    const suprimirAlarme      = exportando || dentroHorarioSolar;

    const msgConcessionaria = (fase, v) =>
      `*Tensão ALTA — Fase ${fase}:* ${v}V\n` +
      `Tensão da concessionária acima do limite (${LIMITE_TENSAO_MAX_CONSUMINDO}V).\n` +
      `✅ Ação: abrir chamado na concessionária solicitando regularização da tensão.`;

    if (!suprimirAlarme) {
      if (!isNaN(ta) && ta > LIMITE_TENSAO_MAX_CONSUMINDO) alertas.push(msgConcessionaria('A', ta));
      if (!isNaN(tb) && tb > LIMITE_TENSAO_MAX_CONSUMINDO) alertas.push(msgConcessionaria('B', tb));
      if (!isNaN(tc) && tc > LIMITE_TENSAO_MAX_CONSUMINDO) alertas.push(msgConcessionaria('C', tc));
    }

    // Tensão BAIXA: sempre alarma independente do horário ou modo
    if (!isNaN(ta) && ta < LIMITE_TENSAO_MIN && ta > 0) alertas.push(`*Fase A:* ${ta}V — Tensão abaixo de ${LIMITE_TENSAO_MIN}V`);
    if (!isNaN(tb) && tb < LIMITE_TENSAO_MIN && tb > 0) alertas.push(`*Fase B:* ${tb}V — Tensão abaixo de ${LIMITE_TENSAO_MIN}V`);
    if (!isNaN(tc) && tc < LIMITE_TENSAO_MIN && tc > 0) alertas.push(`*Fase C:* ${tc}V — Tensão abaixo de ${LIMITE_TENSAO_MIN}V`);

    // 5b. Temperatura — limite físico fixo de 45°C
    //     (independente do setpoint do termostato)
    const tempAtualNum = parseFloat(temperatura.temp_atual);
    if (!isNaN(tempAtualNum) && tempAtualNum >= LIMITE_TEMP_ALARME) {
      alertas.push(`*Temperatura:* ${tempAtualNum.toFixed(1)}°C - Acima do limite de ${LIMITE_TEMP_ALARME}°C`);
    }

    // ── 5c. Busca estado anterior ANTES do flatline ──────────
    // (necessário para anti-spam na gravação de eventos)

    const { data: estadoAnterior } = await supabase
      .from('status_alarmes')
      .select('*')
      .eq('id', 'painel_brasileira')
      .maybeSingle();

    const agora    = new Date();
    const agoraISO = agora.toISOString();

    // 5d. Flatline — medidor congelado (queda de energia)
    //     Verifica APÓS gravar a leitura atual e buscar o estado anterior
    // Passa temp_atual do termostato para confirmação dupla
    const flatlineInfo = await verificarFlatline(temperatura.temp_atual);
    if (flatlineInfo.flatline) {
      alertas.push(
        `*Falta de Energia Confirmada:* medidor elétrico congelado + ` +
        `termostato offline nas últimas ${FLATLINE_LEITURAS} leituras.\n` +
        `Verifique o quadro elétrico e registre a ocorrência.`
      );

      // Grava evento discreto apenas na transição normal → falta
      // (evita 1 registro a cada 5 minutos durante uma falta prolongada)
      if (!estadoAnterior?.em_alerta) {
        try {
          await supabase.from('eventos_sistema').insert([{
            tipo:      'FALTA_ENERGIA',
            device_id: 'painel_brasileira',
            detalhes:  flatlineInfo,
          }]);
        } catch (evErr) {
          console.error('Erro ao gravar evento falta de energia:', evErr);
        }
      }
    }

    // ── 6. NOTIFICAÇÃO TELEGRAM ───────────────────────────────

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
      // Transição: normal → alerta
      deveEnviarTelegram = true;
      novoEstado.primeiro_alerta_at = agoraISO;
      novoEstado.ultimo_alerta_at   = agoraISO;
      novoEstado.estagio            = 1;

      const horaBR = agora.toLocaleString('pt-BR', { timeZone: TIMEZONE });

      // Mensagem enriquecida quando é flatline
      const sufixoFlatline = flatlineInfo.flatline
        ? `\n\n⚡ *Causa provável:* Falta de energia — medidor sem comunicação real por ${FLATLINE_LEITURAS} leituras.`
        : '';

      textoMensagem =
        `⚠️ *ALERTA: ANORMALIDADE DETECTADA*\n` +
        `_Painel: Brasileira Distribuidora_\n` +
        `_${horaBR}_\n\n` +
        alertas.join('\n') +
        sufixoFlatline;

    } else if (alertas.length === 0 && estadoAnterior?.em_alerta) {
      // Transição: alerta → normal
      deveEnviarTelegram = true;
      novoEstado.primeiro_alerta_at = null;
      novoEstado.ultimo_alerta_at   = null;
      novoEstado.estagio            = 0;

      textoMensagem =
        `✅ *SISTEMA NORMALIZADO*\n` +
        `_Painel: Brasileira Distribuidora_\n\n` +
        `Todos os parâmetros retornaram aos níveis operacionais normais.`;
    }

    // Persiste o estado de alarme
    if (estadoAnterior) {
      await supabase.from('status_alarmes').update(novoEstado).eq('id', 'painel_brasileira');
    } else {
      await supabase.from('status_alarmes').insert([{ id: 'painel_brasileira', ...novoEstado }]);
    }

    if (deveEnviarTelegram) {
      await enviarAlertaTelegram(textoMensagem);
    }

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
