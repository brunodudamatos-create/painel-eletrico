// =============================================================
// api/telegram-webhook.js  —  Webhook de Comandos Telegram
// Versão 1.0  —  06/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v1.0 (06/09/2026)
//     - Recebe mensagens do Telegram via webhook (POST)
//     - Comandos suportados:
//         /resumo  → envia resumo dos últimos 7 dias
//         /status  → retorna status atual do sistema
//         /ajuda   → lista os comandos disponíveis
//     - Segurança: só responde a CHAT_IDs autorizados
//       Lista em TELEGRAM_CHATS_AUTORIZADOS (var. de ambiente)
//       separados por vírgula. Chat principal (TELEGRAM_CHAT_ID)
//       é sempre autorizado.
//     - Chats não autorizados: ignorados silenciosamente
//     - Não grava flag de envio semanal (é manual)
//
// CONFIGURAÇÃO (1 vez):
//   Registrar webhook no Telegram:
//   https://api.telegram.org/bot{TOKEN}/setWebhook
//     ?url=https://painel-eletrico.vercel.app/api/telegram-webhook
//
// VARIÁVEIS DE AMBIENTE NECESSÁRIAS:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID           (chat principal — sempre autorizado)
//   TELEGRAM_CHATS_AUTORIZADOS (outros chats, separados por vírgula)
//   SUPABASE_URL, SUPABASE_KEY
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TIMEZONE    = 'America/Cuiaba';
const DIAS_PERIODO = 7;

// ── Segurança: lista de chats autorizados ─────────────────────

function chatAutorizado(chatId) {
  const principal   = process.env.TELEGRAM_CHAT_ID || '';
  const autorizados = (process.env.TELEGRAM_CHATS_AUTORIZADOS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  return String(chatId) === String(principal) ||
         autorizados.includes(String(chatId));
}

// ── Telegram: enviar mensagem ─────────────────────────────────

async function responder(chatId, mensagem) {
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

// ── Helpers de data ───────────────────────────────────────────

function inicioDoPerioodo() {
  const agora = new Date();
  agora.setDate(agora.getDate() - DIAS_PERIODO);
  agora.setHours(0, 0, 0, 0);
  return new Date(agora.getTime() + 4 * 3600000);
}

function fmtDataBR(isoStr) {
  return new Date(isoStr).toLocaleDateString('pt-BR', {
    timeZone: TIMEZONE, weekday: 'short', day: '2-digit', month: '2-digit'
  });
}

function fmtHoraBR(isoStr) {
  return new Date(isoStr).toLocaleTimeString('pt-BR', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit'
  });
}

// ── Buscar dados (mesma lógica do resumo-semanal.js) ──────────

async function buscarDadosSemana(supabase) {
  const inicio = inicioDoPerioodo();
  const fim    = new Date();

  const { data: telemetria } = await supabase
    .from('telemetria_eletrica')
    .select('timestamp, energia_total, energia_gerada_total')
    .gte('timestamp', inicio.toISOString())
    .lte('timestamp', fim.toISOString())
    .order('timestamp', { ascending: true });

  // Agrupa por dia e calcula delta
  const diasMap = {};
  for (const row of telemetria || []) {
    const dia = new Date(row.timestamp).toLocaleDateString('pt-BR', {
      timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric'
    });
    if (!diasMap[dia]) diasMap[dia] = { itens: [], data: row.timestamp };
    diasMap[dia].itens.push(row);
  }

  let consumoTotal   = 0;
  let exportadoTotal = 0;
  let maiorConsumo   = { dia: '--', kwh: 0 };

  for (const [, val] of Object.entries(diasMap)) {
    const itens    = val.itens;
    const primeiro = itens[0];
    const ultimo   = itens[itens.length - 1];

    const deltaConsumo = Math.max(0,
      (Number(ultimo.energia_total)        - Number(primeiro.energia_total))        / 100
    );
    const deltaExport  = Math.max(0,
      (Number(ultimo.energia_gerada_total) - Number(primeiro.energia_gerada_total)) / 100
    );

    consumoTotal   += deltaConsumo;
    exportadoTotal += deltaExport;

    if (deltaConsumo > maiorConsumo.kwh) {
      maiorConsumo = { dia: fmtDataBR(val.data), kwh: deltaConsumo };
    }
  }

  const { count: alarmes45 } = await supabase
    .from('telemetria_eletrica')
    .select('id', { count: 'exact', head: true })
    .gte('timestamp', inicio.toISOString())
    .gte('temp_atual', 45);

  const { data: faltas } = await supabase
    .from('eventos_sistema')
    .select('created_at, detalhes')
    .eq('tipo', 'FALTA_ENERGIA')
    .gte('created_at', inicio.toISOString())
    .order('created_at', { ascending: true });

  const { count: alarmesTensao } = await supabase
    .from('eventos_sistema')
    .select('id', { count: 'exact', head: true })
    .eq('tipo', 'TENSAO_ALTA')
    .gte('created_at', inicio.toISOString());

  return {
    consumoTotal, exportadoTotal,
    saldo:        exportadoTotal - consumoTotal,
    maiorConsumo,
    alarmes45:    alarmes45 || 0,
    faltas:       faltas    || [],
    alarmesTensao: alarmesTensao || 0,
    periodoInicio: inicio,
    periodoFim:    fim,
  };
}

// ── Formata mensagem de resumo ────────────────────────────────

function formatarResumo(dados) {
  const fmtKwh = v => v.toLocaleString('pt-BR', {
    minimumFractionDigits: 1, maximumFractionDigits: 1
  });

  const periodoStr =
    `${dados.periodoInicio.toLocaleDateString('pt-BR', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' })} ` +
    `a ` +
    `${dados.periodoFim.toLocaleDateString('pt-BR',   { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' })}`;

  const saldoSinal  = dados.saldo >= 0 ? '+' : '';
  const statusSaldo = dados.saldo >= 0
    ? '🟢 Saldo positivo'
    : '🔴 Saldo negativo';

  let faltasStr = dados.faltas.length === 0
    ? '  ✅ Nenhuma falta registrada'
    : dados.faltas.map(f => {
        const dur = f.detalhes?.duracao_min
          ? ` (${Number(f.detalhes.duracao_min).toFixed(0)} min)`
          : '';
        return `  └ ${fmtDataBR(f.created_at)} ${fmtHoraBR(f.created_at)}${dur}`;
      }).join('\n');

  return (
    `📊 *RESUMO — ÚLTIMOS 7 DIAS*\n` +
    `_Brasileira Distribuidora_\n` +
    `_Período: ${periodoStr}_\n\n` +

    `⚡ *ENERGIA*\n` +
    `  Consumo da rede:   *${fmtKwh(dados.consumoTotal)} kWh*\n` +
    `  Exportada p/ rede: *${fmtKwh(dados.exportadoTotal)} kWh*\n` +
    `  Saldo líquido:     *${saldoSinal}${fmtKwh(dados.saldo)} kWh*\n` +
    `  ${statusSaldo}\n\n` +

    `📅 *MAIOR CONSUMO*\n` +
    `  ${dados.maiorConsumo.dia} — *${fmtKwh(dados.maiorConsumo.kwh)} kWh*\n\n` +

    `🌡️ *PAINEL*\n` +
    `  Alarmes ≥ 45°C:    *${dados.alarmes45} ocorrência(s)*\n\n` +

    `⚡ *FALTAS DE ENERGIA*\n` +
    `  Total: *${dados.faltas.length} ocorrência(s)*\n` +
    `${faltasStr}\n\n` +

    `⚠️ *TENSÃO ALTA*\n` +
    `  *${dados.alarmesTensao} ocorrência(s)*\n\n` +

    `_Solicitado manualmente via /resumo_`
  );
}

// ── Comando /status ───────────────────────────────────────────

async function cmdStatus(supabase, chatId) {
  const { data } = await supabase
    .from('telemetria_eletrica')
    .select('timestamp, tensao_a, tensao_b, tensao_c, potencia_total, temp_atual')
    .order('id', { ascending: false })
    .limit(1);

  if (!data || data.length === 0) {
    return responder(chatId, '⚠️ Sem dados recentes no banco.');
  }

  const u       = data[0];
  const horaBR  = fmtHoraBR(u.timestamp);
  const dataBR  = fmtDataBR(u.timestamp);
  const modo    = Number(u.potencia_total) < 0
    ? '🟢 Injetando na rede'
    : '🔴 Consumindo da rede';

  const msg =
    `📡 *STATUS ATUAL*\n` +
    `_${dataBR} às ${horaBR}_\n\n` +
    `⚡ *Tensões*\n` +
    `  Fase A: *${u.tensao_a}V*\n` +
    `  Fase B: *${u.tensao_b}V*\n` +
    `  Fase C: *${u.tensao_c}V*\n\n` +
    `⚡ *Potência total:* ${Number(u.potencia_total).toLocaleString('pt-BR')}W\n` +
    `  ${modo}\n\n` +
    `🌡️ *Temperatura painel:* ${u.temp_atual !== null ? u.temp_atual + '°C' : '--'}`;

  return responder(chatId, msg);
}

// ── Comando /ajuda ────────────────────────────────────────────

async function cmdAjuda(chatId) {
  const msg =
    `🤖 *BOT — Brasileira Distribuidora*\n\n` +
    `*Comandos disponíveis:*\n\n` +
    `📊 /resumo — Resumo dos últimos 7 dias\n` +
    `  Energia consumida, exportada, faltas,\n` +
    `  alarmes e dia de maior consumo.\n\n` +
    `📡 /status — Status atual do sistema\n` +
    `  Tensões, potência e temperatura\n` +
    `  da última leitura.\n\n` +
    `❓ /ajuda — Lista os comandos\n\n` +
    `_O resumo semanal é enviado automaticamente\n` +
    `todo sábado entre 17h e 19h (horário de Cuiabá)._`;

  return responder(chatId, msg);
}

// ── Handler principal ─────────────────────────────────────────

export default async function handler(req, res) {
  // O Telegram exige resposta 200 rápida, senão retenta
  res.status(200).json({ ok: true });

  if (req.method !== 'POST') return;

  try {
    const body    = req.body;
    const message = body?.message;
    if (!message) return;

    const chatId  = message?.chat?.id;
    const texto   = (message?.text || '').trim().toLowerCase();

    // Ignora chats não autorizados
    if (!chatAutorizado(chatId)) {
      console.warn(`Chat não autorizado tentou acessar o bot: ${chatId}`);
      return;
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY
    );

    // ── Roteamento de comandos ────────────────────────────────
    if (texto.startsWith('/resumo')) {
      await responder(chatId, '⏳ Buscando dados dos últimos 7 dias...');
      const dados = await buscarDadosSemana(supabase);
      await responder(chatId, formatarResumo(dados));

    } else if (texto.startsWith('/status')) {
      await cmdStatus(supabase, chatId);

    } else if (texto.startsWith('/ajuda') || texto.startsWith('/start') || texto.startsWith('/help')) {
      await cmdAjuda(chatId);

    } else if (texto) {
      // Mensagem não reconhecida
      await responder(chatId,
        `Comando não reconhecido: *${message.text}*\n\nDigite /ajuda para ver os comandos disponíveis.`
      );
    }

  } catch (err) {
    console.error('Erro /api/telegram-webhook:', err);
  }
}
