const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    try {
        const trintaDiasAtras = new Date();
        trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

        // Buscando da sua tabela principal de dados da Tuya
        const { data: leiturasBrutas, error } = await supabase
            .from('dados') 
            .select('*')
            .gte('created_at', trintaDiasAtras.toISOString())
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (!leiturasBrutas || leiturasBrutas.length === 0) {
            return res.status(200).json([]);
        }

        const agrupadoPorDia = {};

        leiturasBrutas.forEach(leitura => {
            if (!leitura.created_at) return;
            const dataDia = leitura.created_at.split('T')[0];

            if (!agrupadoPorDia[dataDia]) {
                agrupadoPorDia[dataDia] = {
                    data: dataDia,
                    consumo_kwh: 0,
                    geracao_kuh: 0
                };
            }

            agrupadoPorDia[dataDia].consumo_kwh += Number(leitura.consumo || leitura.consumo_kwh || 0);
            agrupadoPorDia[dataDia].geracao_kuh += Number(leitura.geracao || leitura.geracao_kwh || 0);
        });

        const resultadoFinal = Object.values(agrupadoPorDia).map(dia => {
            const saldo = dia.geracao_kuh - dia.consumo_kwh;
            const economia = dia.geracao_kuh * 0.85;
            const custoRede = dia.consumo_kwh * 0.85;

            return {
                data: dia.data,
                consumo_kwh: Number(dia.consumo_kwh.toFixed(2)),
                geracao_kwh: Number(dia.geracao_kuh.toFixed(2)),
                saldo_kwh: Number(saldo.toFixed(2)),
                energia_rede_kwh: Number(dia.consumo_kwh.toFixed(2)),
                economia_rs: Number(economia.toFixed(2)),
                custo_rede_rs: Number(custoRede.toFixed(2)),
                autossuficiencia: dia.geracao_kuh > 0 ? Math.min((dia.consumo_kwh / dia.geracao_kuh) * 100, 100).toFixed(1) : 0
            };
        });

        res.status(200).json(resultadoFinal);

    } catch (erro) {
        console.error('Erro na API de Gestão:', erro);
        res.status(500).json({ erro: 'Falha ao processar telemetria' });
    }
}
