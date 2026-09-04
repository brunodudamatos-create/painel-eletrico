// =============================================================
// api/gestao.js  —  Gestão Energética  v3.1
// =============================================================
//
// LÓGICA DE CÁLCULO (à prova de falhas de Wi-Fi):
//   kWh = (última leitura do contador no período)
//         − (primeira leitura do contador no período)
//   O medidor acumula internamente mesmo sem Wi-Fi.
//   Não importa quantas leituras foram perdidas — o delta
//   do contador sempre reflete o consumo/exportação real.
//
// COMPATIBILIDADE COM O FRONTEND (gestao.html):
//   • Retorna TODOS os dias em `diarios[]`
//   • Retorna TODOS os meses em `mensais[]`
//   • Campos dos objetos mantidos idênticos à versão anterior
//   • Não exige parâmetros na URL
//
// EFICIÊNCIA:
//   Busca paginada no Supabase — não traz mais registros
//   do que o necessário em cada chamada.
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TARIFA_KWH = 0.899;
const TIMEZONE   = 'America/Cuiaba';
const PAGE_SIZE  = 1000;

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
//
// Para cada grupo (dia ou mês), pegamos a PRIMEIRA e a ÚLTIMA
// leitura do contador acumulado. O delta é o consumo/exportação
// real do período, imune a lacunas de conectividade.

function inicializarRegistro(chave, mensal) {
  return {
    chave,
    consumo_inicio:  null,
    consumo_final:   null,
    geracao_inicio:  null,
    geracao_final:   null,
  };
}

function adicionarLeitura(registro, leitura) {
  const consumo = numero(leitura.energia_total);
  const geracao = numero(leitura.energia_gerada_total);

  if (consumo !== null && consumo >= 0) {
    if (registro.consumo_inicio === null) registro.consumo_inicio = consumo;
    registro.consumo_final = consumo;   // sempre atualiza com a mais recente
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
  const consumo_kwh = calcularDelta(registro.consumo_inicio, registro.consumo_final) / 1000;
  const geracao_kwh = calcularDelta(registro.geracao_inicio, registro.geracao_final) / 1000;

  const consumo  = arredondar(consumo_kwh);
  const geracao  = arredondar(geracao_kwh);
  const balanco  = arredondar(geracao - consumo);
  const custo    = arredondar(consumo * TARIFA_KWH);

  // Mantém os mesmos nomes de campo do frontend existente
  return {
    [mensal ? 'mes' : 'data']:  registro.chave,
    consumo_rede_kwh:           consumo,
    energia_exportada_kwh:      geracao,
    geracao_solar_kwh:          null,     // futuro: Elekeeper
    consumo_solar_kwh:          null,     // futuro: Elekeeper
    consumo_total_kwh:          null,     // futuro: Elekeeper
    balanco_rede_kwh:           balanco,
    custo_rede_rs:              custo,
    economia_rs:                null,     // futuro: Elekeeper
    geracao_total_disponivel:   false,
  };
}

// ── Handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
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
      return res.status(500).json({ erro: 'Variáveis de ambiente do Supabase não configuradas.' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Busca paginada de TODOS os registros ──────────────────
    // Seleciona apenas as 4 colunas necessárias para minimizar
    // tráfego de rede e custo de transferência.

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

    // ── Normaliza e ordena ────────────────────────────────────

    const registros = leituras
      .map(l => ({ ...l, dataObj: new Date(l.timestamp || l.created_at) }))
      .filter(l => !isNaN(l.dataObj.getTime()))
      .sort((a, b) => a.dataObj - b.dataObj);

    if (registros.length === 0) {
      const vazio = {
        consumo_rede_kwh:        0,
        energia_exportada_kwh:   0,
        geracao_solar_kwh:       null,
        consumo_solar_kwh:       null,
        balanco_rede_kwh:        0,
        custo_rede_rs:           0,
        economia_rs:             null,
        geracao_total_disponivel: false,
      };
      return res.status(200).json({
        tarifa_kwh: TARIFA_KWH,
        diarios:    [],
        mensais:    [],
        resumo:     vazio,
        diagnostico: { leituras_consideradas: 0 },
      });
    }

    // ── Agrupa por dia e por mês ──────────────────────────────

    const mapaDiario = {};
    const mapaMensal = {};

    for (const leitura of registros) {
      const dia = diaLocal(leitura.dataObj);
      const mes = mesLocal(leitura.dataObj);

      if (!mapaDiario[dia]) mapaDiario[dia] = inicializarRegistro(dia, false);
      if (!mapaMensal[mes]) mapaMensal[mes] = inicializarRegistro(mes, true);

      adicionarLeitura(mapaDiario[dia], leitura);
      adicionarLeitura(mapaMensal[mes], leitura);
    }

    // ── Fecha e formata ───────────────────────────────────────

    const resultadoDiario = Object.values(mapaDiario)
      .sort((a, b) => a.chave.localeCompare(b.chave))
      .map(r => fecharRegistro(r, false));

    const resultadoMensal = Object.values(mapaMensal)
      .sort((a, b) => a.chave.localeCompare(b.chave))
      .map(r => fecharRegistro(r, true));

    // ── Resumo = mês atual (último mês com dados) ─────────────

    const ultimoMes = resultadoMensal[resultadoMensal.length - 1];

    const resumo = ultimoMes
      ? {
          consumo_rede_kwh:        ultimoMes.consumo_rede_kwh,
          energia_exportada_kwh:   ultimoMes.energia_exportada_kwh,
          geracao_solar_kwh:       null,
          consumo_solar_kwh:       null,
          balanco_rede_kwh:        ultimoMes.balanco_rede_kwh,
          custo_rede_rs:           ultimoMes.custo_rede_rs,
          economia_rs:             null,
          geracao_total_disponivel: false,
        }
      : {
          consumo_rede_kwh:        0,
          energia_exportada_kwh:   0,
          geracao_solar_kwh:       null,
          consumo_solar_kwh:       null,
          balanco_rede_kwh:        0,
          custo_rede_rs:           0,
          economia_rs:             null,
          geracao_total_disponivel: false,
        };

    return res.status(200).json({
      tarifa_kwh:  TARIFA_KWH,
      diarios:     resultadoDiario,
      mensais:     resultadoMensal,
      resumo,
      fonte_energia: 'telemetria_eletrica',
      significado: {
        consumo_rede_kwh:      'energia_total: energia consumida da rede (contador acumulado)',
        energia_exportada_kwh: 'energia_gerada_total: energia solar exportada para a rede',
        geracao_solar_kwh:     'indisponível até integrar o inversor/Elekeeper',
        consumo_solar_kwh:     'indisponível até integrar a geração total do inversor',
      },
      diagnostico: {
        leituras_consideradas: registros.length,
        metodo_calculo:        'delta_contador_acumulado',
        primeiro_timestamp:    registros[0]?.timestamp             || null,
        ultimo_timestamp:      registros[registros.length - 1]?.timestamp || null,
        total_dias:            resultadoDiario.length,
        total_meses:           resultadoMensal.length,
        nota: 'kWh = (última − primeira leitura do contador por período). Imune a perdas de Wi-Fi.',
      },
    });

  } catch (err) {
    console.error('Erro em /api/gestao:', err);
    return res.status(500).json({ erro: 'Erro interno na gestão energética: ' + (err.message || String(err)) });
  }
}
