// =============================================================
// api/historico-agregado.js  —  Histórico Agregado por Período
// Versão 1.0  —  06/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v1.0 (06/09/2026)
//     - Endpoint para períodos longos com agregação no banco
//     - Parâmetro ?periodo= define a janela e a resolução:
//         7d   → últimos 7 dias,  1 ponto por hora  (AVG)
//         30d  → últimos 30 dias, 1 ponto por 6h    (AVG)
//         180d → últimos 6 meses, 1 ponto por dia   (AVG)
//         total→ desde o início,  1 ponto por semana (AVG)
//     - Retorna: labels (hora local Cuiabá) + arrays de valores
//       para cada série (tensao_a/b/c, corrente_a/b/c,
//       potencia_a/b/c, temp_atual)
//     - Agregação feita no PostgreSQL via date_trunc — eficiente,
//       não traz registros brutos para o Node
//     - Fuso horário: America/Cuiaba (GMT-4 fixo)
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TIMEZONE = 'America/Cuiaba';

// Configuração por período
const PERIODOS = {
  '7d':    { dias: 7,   trunc: 'hour',   label: 'HH:MM DD/MM' },
  '30d':   { dias: 30,  trunc: '6 hours', label: 'DD/MM'       },
  '180d':  { dias: 180, trunc: 'day',     label: 'DD/MM'       },
  'total': { dias: null, trunc: 'week',   label: 'DD/MM/YY'    },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ erro: 'Use GET.' });

  const periodo = req.query.periodo || '7d';
  const cfg = PERIODOS[periodo];

  if (!cfg) {
    return res.status(400).json({ erro: `Período inválido. Use: ${Object.keys(PERIODOS).join(', ')}` });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Calcula o início do período em UTC
    let inicioISO;
    if (cfg.dias) {
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - cfg.dias);
      inicioISO = inicio.toISOString();
    }
    // total: sem filtro de data

    // ── Query de agregação via RPC (SQL direto) ───────────────
    // date_trunc com fuso de Cuiabá para labels corretos
    // Usa AVG para cada série de medição

    const truncExpr = cfg.trunc === '6 hours'
      ? `date_trunc('hour', timestamp AT TIME ZONE '${TIMEZONE}') + (EXTRACT(HOUR FROM timestamp AT TIME ZONE '${TIMEZONE}')::int / 6) * interval '6 hours'`
      : `date_trunc('${cfg.trunc}', timestamp AT TIME ZONE '${TIMEZONE}')`;

    const whereClause = inicioISO
      ? `WHERE timestamp >= '${inicioISO}'`
      : '';

    const sql = `
      SELECT
        ${truncExpr} AS periodo,
        ROUND(AVG(tensao_a)::numeric,   1) AS tensao_a,
        ROUND(AVG(tensao_b)::numeric,   1) AS tensao_b,
        ROUND(AVG(tensao_c)::numeric,   1) AS tensao_c,
        ROUND(AVG(corrente_a)::numeric, 2) AS corrente_a,
        ROUND(AVG(corrente_b)::numeric, 2) AS corrente_b,
        ROUND(AVG(corrente_c)::numeric, 2) AS corrente_c,
        ROUND(AVG(potencia_a)::numeric, 0) AS potencia_a,
        ROUND(AVG(potencia_b)::numeric, 0) AS potencia_b,
        ROUND(AVG(potencia_c)::numeric, 0) AS potencia_c,
        ROUND(AVG(temp_atual)::numeric, 1) AS temp_atual
      FROM telemetria_eletrica
      ${whereClause}
      GROUP BY ${truncExpr}
      ORDER BY periodo ASC
    `;

    const { data, error } = await supabase.rpc('executar_query_agregada', {
      query_sql: sql
    });

    // Se a RPC não existir, usa query direta
    if (error && error.message.includes('executar_query_agregada')) {
      // Fallback: query simples com filtro de tempo
      return await querySimples(supabase, cfg, inicioISO, res, periodo);
    }

    if (error) {
      return await querySimples(supabase, cfg, inicioISO, res, periodo);
    }

    return res.status(200).json(formatarResposta(data, periodo));

  } catch (err) {
    console.error('Erro /api/historico-agregado:', err);
    return res.status(500).json({ erro: err.message });
  }
}

// ── Fallback: query via Supabase sem RPC ──────────────────────
// Busca registros e agrega no Node.js — funciona sem função SQL
async function querySimples(supabase, cfg, inicioISO, res, periodo) {
  try {
    // Define o intervalo de agrupamento em minutos
    const intervaloMin = {
      'hour':     60,
      '6 hours':  360,
      'day':      1440,
      'week':     10080,
    }[cfg.trunc] || 60;

    let query = supabase
      .from('telemetria_eletrica')
      .select('timestamp, tensao_a, tensao_b, tensao_c, corrente_a, corrente_b, corrente_c, potencia_a, potencia_b, potencia_c, temp_atual')
      .order('timestamp', { ascending: true });

    if (inicioISO) {
      query = query.gte('timestamp', inicioISO);
    }

    // Para evitar timeout, limita registros brutos e agrega no Node
    const limite = {
      '7d':    10080,  // 1 semana × 5min = 2016, seguro
      '30d':    8640,  // 30 dias × 5min = 8640
      '180d':  26000,  // amostragem: 1 a cada ~20min nos últimos 6 meses
      'total': 20000,  // amostragem total
    }[periodo] || 5000;

    query = query.limit(limite);

    const { data, error } = await query;
    if (error) return res.status(500).json({ erro: error.message });
    if (!data || data.length === 0) return res.status(200).json(formatarResposta([], periodo));

    // Agrega no Node.js por bucket de tempo
    const buckets = {};

    for (const row of data) {
      const ts = new Date(row.timestamp);
      // Arredonda para o início do intervalo
      const bucketMs = Math.floor(ts.getTime() / (intervaloMin * 60000)) * (intervaloMin * 60000);
      const key = bucketMs;

      if (!buckets[key]) {
        buckets[key] = {
          ts: new Date(bucketMs),
          tensao_a: [], tensao_b: [], tensao_c: [],
          corrente_a: [], corrente_b: [], corrente_c: [],
          potencia_a: [], potencia_b: [], potencia_c: [],
          temp_atual: [],
        };
      }

      const b = buckets[key];
      const push = (arr, val) => { if (val !== null && val !== undefined) arr.push(Number(val)); };

      push(b.tensao_a,   row.tensao_a);
      push(b.tensao_b,   row.tensao_b);
      push(b.tensao_c,   row.tensao_c);
      push(b.corrente_a, row.corrente_a);
      push(b.corrente_b, row.corrente_b);
      push(b.corrente_c, row.corrente_c);
      push(b.potencia_a, row.potencia_a);
      push(b.potencia_b, row.potencia_b);
      push(b.potencia_c, row.potencia_c);
      push(b.temp_atual, row.temp_atual);
    }

    const avg  = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const rnd  = (v, d) => v !== null ? Number(v.toFixed(d)) : null;

    const agregado = Object.values(buckets)
      .sort((a, b) => a.ts - b.ts)
      .map(b => ({
        periodo:    b.ts,
        tensao_a:   rnd(avg(b.tensao_a),   1),
        tensao_b:   rnd(avg(b.tensao_b),   1),
        tensao_c:   rnd(avg(b.tensao_c),   1),
        corrente_a: rnd(avg(b.corrente_a), 2),
        corrente_b: rnd(avg(b.corrente_b), 2),
        corrente_c: rnd(avg(b.corrente_c), 2),
        potencia_a: rnd(avg(b.potencia_a), 0),
        potencia_b: rnd(avg(b.potencia_b), 0),
        potencia_c: rnd(avg(b.potencia_c), 0),
        temp_atual: rnd(avg(b.temp_atual), 1),
      }));

    return res.status(200).json(formatarResposta(agregado, periodo));

  } catch (err) {
    return res.status(500).json({ erro: 'Erro na query simples: ' + err.message });
  }
}

// ── Formata a resposta para o frontend ───────────────────────
function formatarResposta(dados, periodo) {
  const fmtLabel = (ts) => {
    const d = new Date(ts);
    const local = new Intl.DateTimeFormat('pt-BR', {
      timeZone: TIMEZONE,
      day: '2-digit', month: '2-digit',
      hour: ['7d'].includes(periodo) ? '2-digit' : undefined,
      minute: ['7d'].includes(periodo) ? '2-digit' : undefined,
    }).format(d);
    return local;
  };

  return {
    periodo,
    pontos: dados.length,
    series: {
      labels:     dados.map(d => fmtLabel(d.periodo || d.ts)),
      tensao_a:   dados.map(d => d.tensao_a),
      tensao_b:   dados.map(d => d.tensao_b),
      tensao_c:   dados.map(d => d.tensao_c),
      corrente_a: dados.map(d => d.corrente_a),
      corrente_b: dados.map(d => d.corrente_b),
      corrente_c: dados.map(d => d.corrente_c),
      potencia_a: dados.map(d => d.potencia_a),
      potencia_b: dados.map(d => d.potencia_b),
      potencia_c: dados.map(d => d.potencia_c),
      temp:       dados.map(d => d.temp_atual),
    }
  };
}
