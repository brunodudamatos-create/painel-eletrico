// =============================================================
// api/gestao.js  —  Gestão Energética  v4.0
// =============================================================
//
// CORREÇÃO PRINCIPAL — DIVISOR:
//   O EARU EASEM-E envia energia em centésimos de Wh (0,01 Wh).
//   Para converter para kWh: valor_banco ÷ 100
//
//   Confirmado via Supabase:
//     delta agosto = 1.007.162 ÷ 100 = 10.071,62 kWh
//     App Smart Life agosto          = 10.111,72 kWh
//     Erro: 0,40% — diferença normal de arredondamento ✅
//
// LÓGICA DE CÁLCULO (à prova de falhas de Wi-Fi):
//   kWh = (última leitura do contador) − (primeira leitura)
//   O medidor acumula internamente mesmo offline.
//
// COMPATIBILIDADE COM O FRONTEND:
//   Retorna todos os dias em diarios[] e todos os meses em mensais[]
//   sem exigir parâmetros na URL.
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TARIFA_KWH  = 0.899;
const TIMEZONE    = 'America/Cuiaba';
const PAGE_SIZE   = 1000;

// ── Helpers numéricos ─────────────────────────────────────────

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function arredondar(v) {
  return Number((Number(v) || 0).toFixed(2));
}

// ── Helpers de data (fuso de Cuiabá) ─────────────────────────

function diaLocal(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function mesLocal(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit'
  }).format(date);
}

// ── Lógica de agrupamento por contador acumulado ──────────────

function inicializarRegistro(chave) {
  return {
    chave,
    consumo_inicio: null,
    consumo_final:  null,
    geracao_inicio: null,
    geracao_final:  null,
  };
}

function adicionarLeitura(registro, leitura) {
  const consumo = numero(leitura.energia_total);
  const geracao = numero(leitura.energia_gerada_total);

  if (consumo !== null && consumo >= 0) {
    if (registro.consumo_inicio === null) registro.consumo_inicio = consumo;
    registro.consumo_final = consumo;
  }

  if (geracao !== null && geracao > 0) {
    if (registro.geracao_inicio === null) registro.geracao_inicio = geracao;
    registro.geracao_final = geracao;
  }
}

function calcularDelta(inicio, final) {
  if (inicio === null || final === null) return 0;
  const delta = final - inicio;
  return delta >= 0 ? delta : 0;
}

function fecharRegistro(registro, mensal) {
  // ÷ 100 converte centésimos de Wh → kWh
  const consumo_kwh = calcularDelta(registro.consumo_inicio, registro.consumo_final) / 100;
  const geracao_kwh = calcularDelta(registro.geracao_inicio, registro.geracao_final) / 100;

  const consumo = arredondar(consumo_kwh);
  const geracao = arredondar(geracao_kwh);
  const balanco = arredondar(geracao - consumo);
  const custo   = arredondar(consumo * TARIFA_KWH);

  return {
    [mensal ? 'mes' : 'data']: registro.chave,
    consumo_rede_kwh:           consumo,
    energia_exportada_kwh:      geracao,
    balanco_rede_kwh:           balanco,
    custo_rede_rs:              custo,
    geracao_solar_kwh:          null,  // futuro: Elekeeper
    consumo_solar_kwh:          null,  // futuro: Elekeeper
    economia_rs:                null,  // futuro: Elekeeper
  };
}

// ── Handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ erro: 'Método não permitido. Use GET.' });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ erro: 'Variáveis SUPABASE_URL e SUPABASE_KEY não configuradas.' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Busca paginada de todos os registros ──────────────────
    // Seleciona apenas as 4 colunas necessárias para minimizar
    // tráfego e custo de leitura no Supabase.

    let leituras = [];
    let offset   = 0;

    while (true) {
      const { data, error } = await supabase
        .from('telemetria_eletrica')
        .select('timestamp, created_at, energia_total, energia_gerada_total')
        .not('energia_total', 'is', null)
        .order('timestamp', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        return res.status(500).json({ erro: 'Erro no Supabase: ' + error.message });
      }

      if (!data || data.length === 0) break;
      leituras.push(...data);
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    // ── Normaliza timestamps ──────────────────────────────────

    const registros = leituras
      .map(l => ({ ...l, dataObj: new Date(l.timestamp || l.created_at) }))
      .filter(l => !isNaN(l.dataObj.getTime()))
      .sort((a, b) => a.dataObj - b.dataObj);

    if (registros.length === 0) {
      return res.status(200).json({
        tarifa_kwh:  TARIFA_KWH,
        diarios:     [],
        mensais:     [],
        resumo:      { consumo_rede_kwh: 0, energia_exportada_kwh: 0, custo_rede_rs: 0 },
        diagnostico: { leituras_consideradas: 0 },
      });
    }

    // ── Agrupa por dia e por mês ──────────────────────────────

    const mapaDiario = {};
    const mapaMensal = {};

    for (const leitura of registros) {
      const dia = diaLocal(leitura.dataObj);
      const mes = mesLocal(leitura.dataObj);

      if (!mapaDiario[dia]) mapaDiario[dia] = inicializarRegistro(dia);
      if (!mapaMensal[mes]) mapaMensal[mes] = inicializarRegistro(mes);

      adicionarLeitura(mapaDiario[dia], leitura);
      adicionarLeitura(mapaMensal[mes], leitura);
    }

    // ── Fecha e ordena ────────────────────────────────────────

    const diarios = Object.values(mapaDiario)
      .sort((a, b) => a.chave.localeCompare(b.chave))
      .map(r => fecharRegistro(r, false));

    const mensais = Object.values(mapaMensal)
      .sort((a, b) => a.chave.localeCompare(b.chave))
      .map(r => fecharRegistro(r, true));

    // ── Resumo = mês mais recente ─────────────────────────────

    const ultimoMes = mensais[mensais.length - 1] || {
      consumo_rede_kwh:      0,
      energia_exportada_kwh: 0,
      custo_rede_rs:         0,
      balanco_rede_kwh:      0,
    };

    return res.status(200).json({
      tarifa_kwh: TARIFA_KWH,
      diarios,
      mensais,
      resumo:     ultimoMes,
      diagnostico: {
        leituras_consideradas: registros.length,
        metodo_calculo:        'delta_contador_acumulado',
        divisor_energia:       100,
        unidade_banco:         'centésimos de Wh (0,01 Wh por unidade)',
        primeiro_timestamp:    registros[0]?.timestamp                      || null,
        ultimo_timestamp:      registros[registros.length - 1]?.timestamp   || null,
        total_dias:            diarios.length,
        total_meses:           mensais.length,
        nota: 'kWh = (última − primeira leitura do contador por período) ÷ 100. Imune a perdas de Wi-Fi.',
      },
    });

  } catch (err) {
    console.error('Erro em /api/gestao:', err);
    return res.status(500).json({ erro: 'Erro interno: ' + (err.message || String(err)) });
  }
}
