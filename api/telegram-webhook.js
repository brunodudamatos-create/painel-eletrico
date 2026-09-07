// =============================================================
// api/telegram-webhook.js  —  Webhook de Comandos Telegram
// Versão 1.4  —  06/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v1.4 (06/09/2026)
//     - /start: mensagem de boas-vindas personalizada com nome
//       da pessoa, apresentação do sistema e lista de comandos
//     - /ajuda e /start separados — cada um com sua mensagem
//   v1.3 (06/09/2026)
//     - buscarDadosSemana: reescrita usando /api/gestao e
//       /api/indices em paralelo (endpoints já otimizados)
//       em vez de queries pesadas direto no Supabase
//       Resolve timeout de 10s na Vercel gratuita
//     - Faltas detalhadas: query leve LIMIT 10
//   v1.2 (06/09/2026)
//     - /resumo: removida mensagem "Buscando..." — retorna o resumo
//       completo em uma única resposta direta (evita segunda chamada
//       de saída que causava timeout na Vercel gratuita)
//   v1.1 (06/09/2026)
//     - Corrigido ETIMEDOUT: usa resposta direta HTTP no body
//       em vez de chamada de saída para a API do Telegram
//       O Telegram suporta método "sendMessage" no body da resposta
//       Mensagens adicionais usam fetch como fallback
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
// Usa duas estratégias:
// 1. Resposta direta no body HTTP (mais rápida, sem chamada de saída)
//    — usada para a primeira resposta de cada requisição
// 2. Fetch para a API do Telegram (para mensagens adicionais)

let _res = null;  // referência para o objeto response da requisição atual
let _resUsado = false;  // flag para saber se já usou a resposta direta

async function responder(chatId, mensagem) {
  // Tenta usar resposta direta primeiro (evita ETIMEDOUT)
  if (_res && !_resUsado) {
    _resUsado = true;
    _res.status(200).json({
      method:     'sendMessage',
      chat_id:    chatId,
      text:       mensagem,
      parse_mode: 'Markdown'
    });
    return;
  }

  // Fallback: chamada direta à API do Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       mensagem,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error('Erro ao enviar mensagem Telegram:', e.message);
  }
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

// ── Buscar dados via endpoints existentes (rápido) ────────────
// Usa /api/gestao e /api/indices que já são otimizados
// em vez de queries pesadas direto no Supabase

async function buscarDadosSemana(supabase) {
  const BASE    = 'https://painel-eletrico.vercel.app';
  const inicio  = inicioDoPerioodo();
  const fim     = new Date();

  // Busca paralela nos endpoints já existentes
  const [resGestao, resIndices] = await Promise.all([
    fetch(`${BASE}/api/gestao?_t=${Date.now()}`),
    fetch(`${BASE}/api/indices?_t=${Date.now()}`),
  ]);

  const gestao  = resGestao.ok  ? await resGestao.json()  : {};
  const indices = resIndices.ok ? await resIndices.json()  : {};

  // Energia do mês atual (dos últimos 7 dias via diarios[])
  const diarios = gestao.diarios || [];
  const inicioStr = inicio.toLocaleDateString('pt-BR', {
    timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric'
  });

  // Filtra diários dos últimos 7 dias
  const diasSemana = diarios.filter(d => {
    if (!d.data) return false;
    const [ano, mes, dia] = d.data.split('-');
    const dData = new Date(`${ano}-${mes}-${dia}T04:00:00Z`);
    return dData >= inicio && dData <= fim;
  });

  let consumoTotal   = 0;
  let exportadoTotal = 0;
  let maiorConsumo   = { dia: '--', kwh: 0 };

  for (const d of diasSemana) {
    const c = Number(d.consumo_rede_kwh)      || 0;
    const e = Number(d.energia_exportada_kwh) || 0;
    consumoTotal   += c;
    exportadoTotal += e;
    if (c > maiorConsumo.kwh) {
      const [ano, mes, dia] = d.data.split('-');
      const dt = new Date(`${ano}-${mes}-${dia}T12:00:00Z`);
      maiorConsumo = {
        dia: dt.toLocaleDateString('pt-BR', {
          timeZone: TIMEZONE, weekday: 'short', day: '2-digit', month: '2-digit'
        }),
        kwh: c
      };
    }
  }

  // Índices do mês (excedências 45°C e faltas)
  const excedencias45 = indices.excedencias_45 || 0;
  const faltasMes     = indices.faltas_energia  || 0;

  // Faltas detalhadas (últimos 7 dias)
  const { data: faltas } = await supabase
    .from('eventos_sistema')
    .select('created_at, detalhes')
    .eq('tipo', 'FALTA_ENERGIA')
    .gte('created_at', inicio.toISOString())
    .order('created_at', { ascending: true })
    .limit(10);

  return {
    consumoTotal,
    exportadoTotal,
    saldo:         exportadoTotal - consumoTotal,
    maiorConsumo,
    alarmes45:     excedencias45,
    faltas:        faltas || [],
    alarmesTensao: 0,
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

async function cmdBoasVindas(chatId, nome) {
  const saudacao = nome ? `Olá, ${nome}! 👋` : 'Olá! 👋';
  const msg =
    `${saudacao}

` +
    `Bem-vindo ao bot de monitoramento elétrico da
` +
    `*Brasileira Distribuidora de Frutas*.

` +
    `Aqui você acompanha em tempo real:
` +
    `⚡ Tensões e correntes das 3 fases
` +
    `🌡️ Temperatura do painel elétrico
` +
    `🔋 Consumo e geração solar
` +
    `⚠️ Alertas automáticos de anomalias

` +
    `*Comandos disponíveis:*

` +
    `📊 /resumo — Resumo dos últimos 7 dias
` +
    `📡 /status — Status atual do sistema
` +
    `❓ /ajuda  — Lista os comandos

` +
    `_O resumo semanal é enviado automaticamente
` +
    `todo sábado entre 17h e 19h (horário de Cuiabá)._`;

  return responder(chatId, msg);
}

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
  // Configura referência global para resposta direta (evita ETIMEDOUT)
  _res     = res;
  _resUsado = false;

  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    const body    = req.body;
    const message = body?.message;

    // Sem mensagem: responde 200 e encerra
    if (!message) {
      if (!_resUsado) res.status(200).json({ ok: true });
      return;
    }

    const chatId  = message?.chat?.id;
    const texto   = (message?.text || '').trim().toLowerCase();

    // Ignora chats não autorizados — responde 200 silencioso
    if (!chatAutorizado(chatId)) {
      console.warn(`Chat não autorizado: ${chatId}`);
      if (!_resUsado) res.status(200).json({ ok: true });
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
      // Busca os dados primeiro, depois responde com tudo numa única mensagem
      // (a Vercel não suporta múltiplas chamadas de saída — usamos resposta direta)
      const dados = await buscarDadosSemana(supabase);
      await responder(chatId, formatarResumo(dados));

    } else if (texto.startsWith('/status')) {
      await cmdStatus(supabase, chatId);

    } else if (texto.startsWith('/start')) {
      await cmdBoasVindas(chatId, message?.from?.first_name);

    } else if (texto.startsWith('/ajuda') || texto.startsWith('/help')) {
      await cmdAjuda(chatId);

    } else if (texto) {
      // Mensagem não reconhecida
      await responder(chatId,
        `Comando não reconhecido: *${message.text}*\n\nDigite /ajuda para ver os comandos disponíveis.`
      );
    }

  } catch (err) {
    console.error('Erro /api/telegram-webhook:', err);
    // Garante que o Telegram sempre recebe resposta 200
    if (!_resUsado) {
      try { res.status(200).json({ ok: true }); } catch(e) {}
    }
  }
}
