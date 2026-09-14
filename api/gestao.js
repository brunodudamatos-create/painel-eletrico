// =============================================================
// api/gestao.js  —  Gestão Energética  v6.0
// =============================================================
// HISTÓRICO:
//   v6.0 (13/09/2026) — MUDANÇA ESTRUTURAL: agregação movida pro banco
//     Antes (v5.x): o arquivo baixava TODAS as linhas de
//     telemetria_eletrica e solar_geracao (31 mil+ e crescendo) e
//     fazia a soma/agrupamento por dia e mês aqui em JavaScript.
//     Isso significava trafegar milhares de linhas cruas toda vez
//     que alguém abre a tela, só para produzir ~30-60 números finais.
//
//     Agora: duas funções SQL no Postgres (gestao_energetica_diaria
//     e gestao_energetica_mensal, ver arquivo agregacao.sql) fazem
//     a mesma conta DENTRO do banco, usando window functions
//     (DISTINCT ON) — e devolvem só as linhas já prontas (uma por
//     dia, uma por mês). Este arquivo só chama as duas funções e
//     formata a resposta.
//
//     VALIDAÇÃO ANTES DE TROCAR (importante para quem ler isso
//     depois): a lógica SQL foi testada contra a lógica JS antiga
//     usando um banco Postgres de teste com 45 dias de dados
//     sintéticos (incluindo falhas de Wi-Fi e leituras nulas
//     propositais, em duas rodadas com sementes aleatórias
//     diferentes, mais um teste cirúrgico do caso "leitura nula é
//     a primeira do dia"). Todos os 7 campos bateram exatamentos
//     em todos os dias e meses testados, nas duas versões.
//
//     BUG ENCONTRADO E CORRIGIDO NO PROCESSO (v5.3): a função
//     numero() antiga fazia Number(null) → 0 (não é erro nem NaN em
//     JavaScript!), tratando leituras nulas do medidor como leituras
//     "zero" válidas. Se calhasse de ser a última leitura do dia,
//     zerava o dia inteiro; se fosse a primeira, inflava o dia.
//     O SQL nunca teve esse problema — NULL em Postgres é
//     corretamente excluído por cláusulas WHERE. Migrar pra SQL
//     elimina essa categoria de bug de vez, não só conserta o caso
//     já encontrado.
//
//   v5.3 e anteriores: ver histórico no arquivo agregacao.sql e nas
//     conversas anteriores — resumo: correção do divisor (÷100),
//     integração solar, correção do método de cálculo solar,
//     paralelização de busca, correção do bug numero(null).
//
// PARA APLICAR ESTA VERSÃO:
//   1. Rodar agregacao.sql no SQL Editor do Supabase (cria as duas
//      funções gestao_energetica_diaria e gestao_energetica_mensal)
//   2. Substituir api/gestao.js por este arquivo
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TARIFA_KWH = 0.899;

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

    // ── Chama as duas funções SQL (agregação já pronta no banco) ──

    const [diariosResp, mensaisResp] = await Promise.all([
      supabase.rpc('gestao_energetica_diaria', { tarifa_kwh: TARIFA_KWH }),
      supabase.rpc('gestao_energetica_mensal', { tarifa_kwh: TARIFA_KWH }),
    ]);

    if (diariosResp.error) {
      return res.status(500).json({ erro: 'Erro no Supabase (função diária): ' + diariosResp.error.message });
    }
    if (mensaisResp.error) {
      return res.status(500).json({ erro: 'Erro no Supabase (função mensal): ' + mensaisResp.error.message });
    }

    // Renomeia "chave" -> "data" (diário) / "mes" (mensal), para
    // manter exatamente o mesmo formato que o front-end já espera.
    const diarios = (diariosResp.data || []).map(({ chave, ...resto }) => ({ data: chave, ...resto }));
    const mensais = (mensaisResp.data || []).map(({ chave, ...resto }) => ({ mes: chave, ...resto }));

    if (mensais.length === 0) {
      return res.status(200).json({
        tarifa_kwh: TARIFA_KWH,
        diarios: [],
        mensais: [],
        resumo: { consumo_rede_kwh: 0, energia_exportada_kwh: 0, custo_rede_rs: 0 },
        diagnostico: { leituras_consideradas: 0 },
      });
    }

    const ultimoMes = mensais[mensais.length - 1];

    return res.status(200).json({
      tarifa_kwh: TARIFA_KWH,
      diarios,
      mensais,
      resumo: ultimoMes,
      diagnostico: {
        metodo_calculo: 'delta_contador_acumulado (calculado no Postgres via gestao_energetica_diaria/mensal)',
        divisor_energia: 100,
        unidade_banco: 'centésimos de Wh (0,01 Wh por unidade)',
        total_dias: diarios.length,
        total_meses: mensais.length,
        nota: 'kWh = (última − primeira leitura do contador por período) ÷ 100. Imune a perdas de Wi-Fi. Agregação feita no banco (v6.0) — ver agregacao.sql.',
        solar: 'geracao_solar_kwh usa geracao_hoje_kwh (já calculado pelo SAJ, reseta à meia-noite). ' +
               'consumo_solar_kwh = geracao_solar_kwh − energia_exportada_kwh. economia_rs = geracao_solar_kwh × tarifa. ' +
               'Os 3 campos ficam null quando não há leitura solar para o período.',
      },
    });

  } catch (err) {
    console.error('Erro em /api/gestao:', err);
    return res.status(500).json({ erro: 'Erro interno: ' + (err.message || String(err)) });
  }
}
