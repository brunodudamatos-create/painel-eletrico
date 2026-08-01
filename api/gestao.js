const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ 
                erro: 'Variáveis de ambiente do Supabase não configuradas na Vercel',
                temUrl: !!supabaseUrl,
                temKey: !!supabaseKey
            });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Teste básico de conexão e busca na tabela 'dados'
        const { data: leiturasBrutas, error } = await supabase
            .from('dados')
            .select('*')
            .limit(100);

        if (error) {
            return res.status(500).json({ erro: 'Erro na query do Supabase: ' + error.message });
        }

        if (!leiturasBrutas || leiturasBrutas.length === 0) {
            return res.status(200).json([]);
        }

        const agrupadoPorDia = {};

        leiturasBrutas.forEach(leitura => {
            const timestamp = leitura.created_at || leitura.data || leitura.timestamp;
            if (!timestamp) return;
            const dataDia = timestamp.split('T')[0];

            if (!agrupadoPorDia[dataDia]) {
                agrupadoPorDia[dataDia] = {
                    data: dataDia,
                    consumo_kwh: 0,
                    geracao_kwh: 0
                };
            }

            const consumo = Number(leitura.consumo || leitura.consumo_kwh || leitura.energia_ativa || 0);
            const geracao = Number(leitura.geracao || leitura.geracao_kwh || 0);

            agrupadoPorDia[dataDia].consumo_kwh += consumo;
            agrupadoPorDia[dataDia].geracao_kwh += geracao;
        });

        const resultadoFinal = Object.values(agrupadoPorDia).map(dia => {
            const saldo = dia.geracao_kwh - dia.consumo_kwh;
            const economia = dia.geracao_kwh * 0.85;
            const custoRede = dia.consumo_kwh * 0.85;

            return {
                data: dia.data,
                consumo_kwh: Number(dia.consumo_kwh.toFixed(2)),
                geracao_kwh: Number(dia.geracao_kwh.toFixed(2)),
                saldo_kwh: Number(saldo.toFixed(2)),
                energia_rede_kwh: Number(dia.consumo_kwh.toFixed(2)),
                economia_rs: Number(economia.toFixed(2)),
                custo_rede_rs: Number(custoRede.toFixed(2)),
                autossuficiencia: dia.geracao_kwh > 0 ? Math.min((dia.consumo_kwh / dia.geracao_kwh) * 100, 100).toFixed(1) : 0
            };
        });

        resultadoFinal.sort((a, b) => new Date(a.data) - new Date(b.data));

        return res.status(200).json(resultadoFinal);

    } catch (erro) {
        return res.status(500).json({ erro: 'Exceção capturada: ' + erro.message, stack: erro.stack });
    }
}
