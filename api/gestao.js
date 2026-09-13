// =============================================================
// api/gestao.js  —  Gestão Energética  v5.1
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
//
// v5.1 (13/09/2026) — CORREÇÃO DO MÉTODO DE CÁLCULO SOLAR:
//   O método de delta acumulado (v5.0) subestimava a geração do dia
//   e do mês sempre que a coleta começava no meio do período —
//   confirmado na prática: painel mostrava 20.61 kWh no dia enquanto
//   o próprio site do SAJ mostrava 139.12 kWh (o dia inteiro).
//   CORRIGIDO: usa geracao_hoje_kwh, que o SAJ já calcula pronto e
//   reseta à meia-noite — pega a leitura mais recente de cada dia.
//   O total do mês agora é a SOMA dos totais diários (não mais um
//   delta do mês inteiro). Bate exatamente com o valor "Hoje" do
//   site/app do SAJ, pois usa a mesma fonte.
//
// v5.0 (13/09/2026) — INTEGRAÇÃO SOLAR (tabela solar_geracao):
//   Preenche os 3 campos que ficavam null aguardando o Elekeeper:
//     - geracao_solar_kwh: mesma lógica de delta acumulado (última
//       leitura − primeira leitura de geracao_total_kwh no período).
//       Sem ÷100 — essa tabela já grava em kWh, não em centésimos.
//     - consumo_solar_kwh (autoconsumo): geracao_solar_kwh menos o
//       que foi exportado pro medidor da rede (energia_exportada_kwh,
//       já calculado a partir da telemetria_eletrica). O que sobra
//       foi usado na hora dentro da própria instalação.
//     - economia_rs: geracao_solar_kwh × tarifa — valor total que
//       essa energia custaria se tivesse sido comprada da rede
//       (definição confirmada com o usuário em 13/09/2026).
//   Se a tabela solar_geracao não tiver leitura para um dia/mês,
//   os 3 campos ficam null (não zero) — diferencia "sem coleta"
//   de "coletou e gerou zero".
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

// ── Lógica diária solar (tabela solar_geracao) ────────────────
// v5.1: NÃO usa mais delta acumulado. O SAJ já entrega pronto, em
// cada leitura, o campo geracao_hoje_kwh — o total do dia inteiro,
// calculado pelo próprio SAJ e resetado à meia-noite. Isso já bate
// exatamente com o que aparece no site/app do SAJ. Só precisamos
// pegar a leitura MAIS RECENTE de cada dia. Método de delta (usado
// para o medidor elétrico acima) só faz sentido pra contador que
// NUNCA reseta — não é o caso aqui, e usá-lo estava subestimando
// o valor sempre que a coleta começava no meio do dia.

function inicializarDiaSolar(chave) {
  return { chave, geracaoHojeMaisRecente: null, timestampMaisRecente: null };
}

function adicionarLeituraSolarDia(registro, geracaoHojeKwh, timestampMs) {
  const v = numero(geracaoHojeKwh);
  if (v === null || v < 0) return;
  // Como as leituras são processadas em ordem crescente de tempo,
  // a mais recente sempre substitui — mas o timestamp confirma
  // caso a ordenação mude no futuro.
  if (registro.timestampMaisRecente === null || timestampMs >= registro.timestampMaisRecente) {
    registro.geracaoHojeMaisRecente = v;
    registro.timestampMaisRecente   = timestampMs;
  }
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

    // ── Busca e mescla dados solares (solar_geracao) ──────────
    // Não fatal: se der erro aqui, o resto do painel (elétrico)
    // continua funcionando normalmente, só a parte solar fica null.

    try {
      let leiturasSolares = [];
      let offsetSolar = 0;

      while (true) {
        const { data, error } = await supabase
          .from('solar_geracao')
          .select('created_at, geracao_hoje_kwh')
          .not('geracao_hoje_kwh', 'is', null)
          .order('created_at', { ascending: true })
          .range(offsetSolar, offsetSolar + PAGE_SIZE - 1);

        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        leiturasSolares.push(...data);
        if (data.length < PAGE_SIZE) break;
        offsetSolar += PAGE_SIZE;
      }

      // ── Passo 1: geração solar do dia = geracao_hoje_kwh da
      // leitura mais recente daquele dia (já vem pronto do SAJ) ──
      const mapaSolarDiario = {};

      for (const leitura of leiturasSolares) {
        const dataObj = new Date(leitura.created_at);
        if (isNaN(dataObj.getTime())) continue;

        const dia = diaLocal(dataObj);
        if (!mapaSolarDiario[dia]) mapaSolarDiario[dia] = inicializarDiaSolar(dia);
        adicionarLeituraSolarDia(mapaSolarDiario[dia], leitura.geracao_hoje_kwh, dataObj.getTime());
      }

      // ── Passo 2: geração solar do mês = soma dos dias daquele mês ──
      const mapaSolarMensal = {}; // mes -> soma acumulada

      for (const dia of Object.keys(mapaSolarDiario)) {
        const geracaoDia = mapaSolarDiario[dia].geracaoHojeMaisRecente;
        if (geracaoDia === null) continue;
        const mes = dia.slice(0, 7); // 'AAAA-MM-DD' → 'AAAA-MM'
        mapaSolarMensal[mes] = (mapaSolarMensal[mes] || 0) + geracaoDia;
      }

      const preencherSolar = (registro, geracaoSolar) => {
        registro.geracao_solar_kwh = geracaoSolar === null || geracaoSolar === undefined
          ? null : arredondar(geracaoSolar);

        if (registro.geracao_solar_kwh === null) {
          registro.consumo_solar_kwh = null;
          registro.economia_rs       = null;
          return;
        }

        registro.consumo_solar_kwh = arredondar(
          Math.max(registro.geracao_solar_kwh - (registro.energia_exportada_kwh || 0), 0)
        );
        registro.economia_rs = arredondar(registro.geracao_solar_kwh * TARIFA_KWH);
      };

      for (const registro of diarios) {
        const dado = mapaSolarDiario[registro.data];
        preencherSolar(registro, dado ? dado.geracaoHojeMaisRecente : null);
      }
      for (const registro of mensais) {
        preencherSolar(registro, mapaSolarMensal[registro.mes] ?? null);
      }

    } catch (solarErr) {
      console.error('Aviso: falha ao mesclar dados solares em /api/gestao:', solarErr);
      // diarios/mensais continuam com geracao_solar_kwh/consumo_solar_kwh/economia_rs = null
    }

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
        solar: 'geracao_solar_kwh usa geracao_hoje_kwh (já calculado pelo SAJ, reseta à meia-noite): ' +
               'valor diário = leitura mais recente do dia; valor mensal = soma dos dias do mês. ' +
               'consumo_solar_kwh = geracao_solar_kwh − energia_exportada_kwh. economia_rs = geracao_solar_kwh × tarifa. ' +
               'Os 3 campos ficam null (não zero) quando não há leitura solar para o período.',
      },
    });

  } catch (err) {
    console.error('Erro em /api/gestao:', err);
    return res.status(500).json({ erro: 'Erro interno: ' + (err.message || String(err)) });
  }
}
