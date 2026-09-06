// =============================================================
// api/historico.js  v2.0
// =============================================================
// MUDANÇAS em relação ao original:
//
//   1. Convertido de CommonJS (module.exports) para ESM
//      (export default) — igual ao dados.js e gestao.js
//
//   2. Aceita parâmetros na URL:
//      ?from=2026-09-05T04:00:00Z  — filtra timestamp >= from
//                                    (usado para energia do dia/mês)
//      ?limit=N                    — máximo de registros (padrão 432)
//      ?order=asc                  — ordena ASC (padrão DESC)
//
//   3. Quando ?from é passado:
//      - Ordena ASC (do mais antigo para o mais novo)
//      - Sem limit padrão (busca todos do período)
//      - Permite calcular delta de energia (último - primeiro)
//
//   4. Sem ?from:
//      - Comportamento original: últimos 432 registros em DESC
//      - Usado pelos gráficos de tendência
// =============================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY;

    const supabase = createClient(supabaseUrl, supabaseKey);

    const from    = req.query.from  || null;
    const limitQ  = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const orderQ  = req.query.order === 'asc' ? 'asc' : 'desc';

    let query = supabase
      .from('telemetria_eletrica')
      .select('id, timestamp, created_at, tensao_a, tensao_b, tensao_c, corrente_a, corrente_b, corrente_c, potencia_a, potencia_b, potencia_c, potencia_total, energia_a, energia_b, energia_c, energia_total, energia_gerada_total, fat_pot_a, fat_pot_b, fat_pot_c, frequencia, temp_atual, falha');

    if (from) {
      // Com filtro de data: ordena ASC para pegar primeiro e último
      query = query
        .gte('timestamp', from)
        .order('timestamp', { ascending: true });

      // Aplica limit apenas se explicitamente solicitado
      if (limitQ) query = query.limit(limitQ);

    } else {
      // Sem filtro: comportamento original para gráficos
      const limite = limitQ || 432;
      query = query
        .order('id', { ascending: orderQ === 'asc' })
        .limit(limite);
    }

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json(data || []);

  } catch (err) {
    console.error('Erro /api/historico:', err);
    return res.status(500).json({ error: 'Erro interno no servidor de histórico' });
  }
}
