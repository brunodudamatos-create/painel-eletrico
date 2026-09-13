// =============================================================
// api/inversor.js  —  Status do Inversor Solar (via cache Supabase)
// Versão 1.0  —  13/09/2026
// =============================================================
// HISTÓRICO:
//   v1.0 (13/09/2026)
//     - SUBSTITUI api/elekeeper.js (removido nesta mesma versão).
//     - MOTIVO DA TROCA: elekeeper.js chamava o SAJ ao vivo toda vez
//       que alguém abria a tela de gestão, usando os endpoints
//       /api/v2/... que não existem (mesmo bug já corrigido no
//       sync_solar.py) e um token fixo que expira a cada 30 dias
//       e precisava ser renovado manualmente. Por isso o widget do
//       inversor ficava travado em "Carregando..." para sempre.
//     - NOVA ESTRATÉGIA: o robô sync_solar.py (GitHub Actions) já
//       visita o SAJ sozinho a cada 10 minutos e grava a leitura na
//       tabela solar_geracao. Este endpoint só lê a última linha
//       gravada — não fala com o SAJ diretamente. Mais rápido, sem
//       token para vencer, e sem risco de múltiplos acessos
//       simultâneos ao portal do SAJ quando várias pessoas abrem
//       o painel ao mesmo tempo.
//     - Contrapartida aceita: o dado pode ter até ~10 min de atraso
//       (o intervalo do robô), o que é irrelevante para um painel
//       de acompanhamento de geração solar.
//
// RETORNA (mesmo formato que o elekeeper.js antigo devolvia, para
// não exigir mudança nos nomes de campo usados pelo front-end):
//   potencia_atual_w, geracao_hoje_kwh, geracao_total_kwh,
//   estado, atualizado_em, fonte
// =============================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
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

    const { data, error } = await supabase
      .from('solar_geracao')
      .select('potencia_atual_w, geracao_hoje_kwh, geracao_total_kwh, estado, atualizado_em, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ erro: 'Erro no Supabase: ' + error.message });
    }

    if (!data) {
      return res.status(200).json({
        potencia_atual_w:  null,
        geracao_hoje_kwh:  null,
        geracao_total_kwh: null,
        estado:            null,
        atualizado_em:     null,
        fonte: 'solar_geracao (sem leituras ainda)',
      });
    }

    return res.status(200).json({
      potencia_atual_w:  data.potencia_atual_w,
      geracao_hoje_kwh:  data.geracao_hoje_kwh,
      geracao_total_kwh: data.geracao_total_kwh,
      estado:            data.estado,
      atualizado_em:     data.atualizado_em || data.created_at,
      fonte: 'solar_geracao (cache, atualizado a cada 10 min pelo GitHub Actions)',
    });

  } catch (err) {
    console.error('Erro em /api/inversor:', err);
    return res.status(500).json({ erro: 'Erro interno: ' + (err.message || String(err)) });
  }
}
