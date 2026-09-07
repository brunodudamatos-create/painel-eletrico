// =============================================================
// api/resumo-semanal.js  —  Resumo Semanal Automático
// Versão 1.0  —  06/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v1.0 (06/09/2026)
//     - Envio automático todo sábado entre 17h e 19h (Cuiabá)
//     - Período: últimos 7 dias corridos
//     - Anti-duplicidade: grava flag em eventos_sistema após envio
//       Não envia duas vezes na mesma semana
//     - Conteúdo: energia consumida, exportada, saldo, dia de
//       maior consumo, alarmes de temperatura, faltas de energia
//     - Disparado pelo UptimeRobot a cada 1h
//       URL: https://painel-eletrico.vercel.app/api/resumo-semanal
//
// VARIÁVEIS DE AMBIENTE NECESSÁRIAS:
//   SUPABASE_URL, SUPABASE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (chat principal)
//   TELEGRAM_CHATS_AUTORIZADOS (lista separada por vírgula)
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TIMEZONE       = 'America/Cuiaba';
const HORA_INICIO    = 17;   // início da janela de envio
const HORA_FIM       = 19;   // fim da janela de envio (exclusive)
const DIA_ENVIO      = 6;    // 0=domingo ... 6=sábado
const DIAS_PERIODO   = 7;    // últimos 7 dias corridos

// ── Helpers de data ───────────────────────────────────────────

function agoraEmCuiaba() {
  const agora = new Date();
  // Converte para horário de Cuiabá
  const str = agora.toLocaleString('en-US', { timeZone: TIMEZONE });
  return new Date(str);
}

function inicioDoPerioodo() {
  const agora = new Date();
  agora.setDate(agora.getDate() - DIAS_PERIODO);
  agora.setHours(0, 0, 0, 0);
  // Ajusta para UTC considerando Cuiabá GMT-4
  return new Date(agora.getTime() + 4 * 3600000);
}

function fmtDataBR(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('pt-BR', {
    timeZone: TIMEZONE,
    weekday: 'short', day: '2-digit', month: '2-digit'
  });
}

function fmtHoraBR(isoStr) {
  return new Date(isoStr).toLocaleTimeString('pt-BR', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit'
  });
}

function semanaAtual() {
  const local = agoraEmCuiaba();
  const ano   = local.getFullYear();
  // Semana ISO simplificada: ano + número da semana
  const inicio = new Date(local);
  inicio.setDate(local.getDate() - local.getDay());
  return `${ano}-S${Math.ceil((inicio.getDate()) / 7)}`;
}

// ── Telegram ──────────────────────────────────────────────────

async function enviarTelegram(chatId, mensagem) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      text:       mensagem,
      parse_mode: 'Markdown'
    })
  });
}

async function enviarParaTodos(mensagem) {
  // Envia para o chat principal + todos os autorizados
  const principal  = process.env.TELEGRAM_CHAT_ID || '';
  const autorizados = (process.env.TELEGRAM_CHATS_AUTORIZADOS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const todos = [...new Set([principal, ...autorizados].filter(Boolean))];
  await Promise.all(todos.map(chatId => enviarTelegram(chatId, mensagem)));
}

// ── Busca de dados ────────────────────────────────────────────

async function buscarDadosSemana(supabase) {
  const inicio = inicioDoPerioodo();
  const fim    = new Date();

  // ── Energia: delta de contador por dia ───────────────────────
  const { data: telemetria } = await supabase
    .from('telemetria_eletrica')
    .select('timestamp, energia_total, energia_gerada_total')
    .gte('timestamp', inicio.toISOString())
    .lte('timestamp', fim.toISOString())
    .order('timestamp', { ascending: true });

  // Agrupa por dia em Cuiabá e calcula delta de energia
  const diasMap = {};
  for (const row of telemetria || []) {
    const dia = new Date(row.timestamp).toLocaleDateString('pt-BR', {
      timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric'
    });
    if (!diasMap[dia]) diasMap[dia] = { itens: [], data: row.timestamp };
    diasMap[dia].itens.push(row);
  }

  let consumoTotal  = 0;
  let exportadoTotal = 0;
  let maiorConsumo  = { dia: '--', kwh: 0 };

  for (const [dia, val] of Object.entries(diasMap)) {
    const itens  = val.itens;
    const primeiro = itens[0];
    const ultimo   = itens[itens.length - 1];

    const deltaConsumo = Math.max(0,
      (Number(ultimo.energia_total)         - Number(primeiro.energia_total))         / 100
    );
    const deltaExport  = Math.max(0,
      (Number(ultimo.energia_gerada_total)  - Number(primeiro.energia_gerada_total))  / 100
    );

    consumoTotal   += deltaConsumo;
    exportadoTotal += deltaExport;

    if (deltaConsumo > maiorConsumo.kwh) {
      maiorConsumo = {
        dia: fmtDataBR(val.data),
        kwh: deltaConsumo
      };
    }
  }

  // ── Alarmes de temperatura ≥ 45°C ─────────────────────────
  const { count: alarmes45 } = await supabase
    .from('telemetria_eletrica')
    .select('id', { count: 'exact', head: true })
    .gte('timestamp', inicio.toISOString())
    .gte('temp_atual', 45);

  // ── Faltas de energia ─────────────────────────────────────
  const { data: faltas } = await supabase
    .from('eventos_sistema')
    .select('created_at, detalhes')
    .eq('tipo', 'FALTA_ENERGIA')
    .gte('created_at', inicio.toISOString())
    .order('created_at', { ascending: true });

  // ── Alarmes de tensão ─────────────────────────────────────
  const { data: alarmesTensao } = await supabase
    .from('eventos_sistema')
    .select('created_at')
    .eq('tipo', 'TENSAO_ALTA')
    .gte('created_at', inicio.toISOString());

  return {
    consumoTotal:   consumoTotal,
    exportadoTotal: exportadoTotal,
    saldo:          exportadoTotal - consumoTotal,
    maiorConsumo,
    alarmes45:      alarmes45 || 0,
    faltas:         faltas    || [],
    alarmesTensao:  (alarmesTensao || []).length,
    periodoInicio:  inicio,
    periodoFim:     fim,
  };
}

// ── Formata mensagem Telegram ─────────────────────────────────

function formatarMensagem(dados, isManual) {
  const periodoStr =
    `${dados.periodoInicio.toLocaleDateString('pt-BR', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' })} ` +
    `a ` +
    `${dados.periodoFim.toLocaleDateString('pt-BR',   { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' })}`;

  const fmtKwh = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const saldoSinal = dados.saldo >= 0 ? '+' : '';
  const statusSaldo = dados.saldo >= 0
    ? '🟢 Saldo positivo (mais gerou que consumiu da rede)'
    : '🔴 Saldo negativo (consumiu mais da rede que gerou)';

  // Faltas de energia detalhadas
  let faltasStr = '';
  if (dados.faltas.length === 0) {
    faltasStr = '  ✅ Nenhuma falta registrada';
  } else {
    faltasStr = dados.faltas.map(f => {
      const duracao = f.detalhes?.duracao_min
        ? ` — ${Number(f.detalhes.duracao_min).toFixed(0)} min`
        : '';
      return `  └ ${fmtDataBR(f.created_at)} ${fmtHoraBR(f.created_at)}${duracao}`;
    }).join('\n');
  }

  const rodape = isManual
    ? `_Solicitado manualmente via /resumo_`
    : `_Próximo resumo: sábado às 18h_`;

  return (
    `📊 *RESUMO SEMANAL*\n` +
    `_Brasileira Distribuidora_\n` +
    `_Período: ${periodoStr} (últimos 7 dias)_\n\n` +

    `⚡ *ENERGIA*\n` +
    `  Consumo da rede:    *${fmtKwh(dados.consumoTotal)} kWh*\n` +
    `  Exportada p/ rede:  *${fmtKwh(dados.exportadoTotal)} kWh*\n` +
    `  Saldo líquido:      *${saldoSinal}${fmtKwh(dados.saldo)} kWh*\n` +
    `  ${statusSaldo}\n\n` +

    `📅 *DIA DE MAIOR CONSUMO*\n` +
    `  ${dados.maiorConsumo.dia} — *${fmtKwh(dados.maiorConsumo.kwh)} kWh*\n\n` +

    `🌡️ *PAINEL ELÉTRICO*\n` +
    `  Alarmes ≥ 45°C:     *${dados.alarmes45} ocorrência(s)*\n\n` +

    `⚡ *FALTAS DE ENERGIA*\n` +
    `  Total: *${dados.faltas.length} ocorrência(s)*\n` +
    `${faltasStr}\n\n` +

    `⚠️ *OUTROS ALERTAS*\n` +
    `  Tensão alta:        *${dados.alarmesTensao} ocorrência(s)*\n\n` +

    `─────────────────────\n` +
    `${rodape}`
  );
}

// ── Handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY
    );

    const local    = agoraEmCuiaba();
    const diaSemana = local.getDay();   // 0=dom ... 6=sáb
    const hora      = local.getHours();

    // ── Verificar janela de envio ─────────────────────────────
    const dentroJanela = diaSemana === DIA_ENVIO &&
                         hora >= HORA_INICIO &&
                         hora <  HORA_FIM;

    if (!dentroJanela) {
      return res.status(200).json({
        status: 'fora_da_janela',
        info:   `Dia: ${diaSemana} (esperado: ${DIA_ENVIO}), Hora: ${hora}h (janela: ${HORA_INICIO}-${HORA_FIM}h)`
      });
    }

    // ── Verificar se já enviou essa semana ────────────────────
    const chave = semanaAtual();

    const { data: jaEnviou } = await supabase
      .from('eventos_sistema')
      .select('id')
      .eq('tipo', 'RESUMO_SEMANAL_ENVIADO')
      .eq('device_id', chave)
      .limit(1);

    if (jaEnviou && jaEnviou.length > 0) {
      return res.status(200).json({
        status: 'ja_enviado',
        semana: chave
      });
    }

    // ── Buscar dados e enviar ─────────────────────────────────
    const dados    = await buscarDadosSemana(supabase);
    const mensagem = formatarMensagem(dados, false);

    await enviarParaTodos(mensagem);

    // ── Gravar flag anti-duplicidade ──────────────────────────
    await supabase.from('eventos_sistema').insert([{
      tipo:      'RESUMO_SEMANAL_ENVIADO',
      device_id: chave,
      detalhes: {
        semana:           chave,
        enviado_em:       new Date().toISOString(),
        consumo_kwh:      dados.consumoTotal,
        exportado_kwh:    dados.exportadoTotal,
        faltas:           dados.faltas.length,
        alarmes_45:       dados.alarmes45,
      }
    }]);

    return res.status(200).json({
      status:  'enviado',
      semana:  chave,
      pontos:  { consumo: dados.consumoTotal, exportado: dados.exportadoTotal }
    });

  } catch (err) {
    console.error('Erro /api/resumo-semanal:', err);
    return res.status(500).json({ erro: err.message });
  }
}
