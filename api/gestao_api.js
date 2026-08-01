const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    try {
        // Busca os dados brutos da telemetria que vêm da Tuya (últimos 30 dias)
        const trintaDiasAtras = new Date();
        trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

        const { data: leiturasBrutas, error } = await supabase
            .from('telemetria_eletrica') // Tabela onde a Tuya salva os dados no seu index
            .select('*')
            .gte('created_at', trintaDiasAtras.toISOString())
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (!leiturasBrutas || leiturasBrutas.length === 0) {
            return res.status(200).json([]);
        }

        // Agrupa os dados brutos por dia para alimentar os gráficos e cards
        const agrupadoPorDia = {};

        leiturasBrutas.forEach(leitura => {
            const dataDia = leitura.created_at.split('T')[0]; // Pega apenas a data (YYYY-MM-DD)

            if (!agrupadoPorDia[dataDia]) {
                agrupadoPorDia[dataDia] = {
                    data: dataDia,
                    consumo_kwh: 0,
                    geracao_kwh: 0,
                    leituras_count: 0,
                    soma_tensao: 0
                };
            }

            // Acumula os valores (ajuste os nomes das colunas conforme a sua tabela de telemetria)
            agrupadoPorDia[dataDia].consumo_kwh += Number(leitura.consumo_kwh || leitura.energia_ativa || 0);
            agrupadoPorDia[dataDia].geracao_kwh += Number(leitura.geracao_kwh || 0); // Se houver inversor
            agrupadoPorDia[dataDia].leituras_count += 1;
        });

        // Transforma o objeto agrupado em um array ordenado para o front-end
        const resultadoFinal = Object.values(agrupadoPorDia).map(dia => {
            const saldo = dia.geracao_kwh - dia.consumo_kwh;
            const economia = dia.geracao_kwh * 0.85; // Tarifa média estimada de exemplo (R$ 0,85/kWh)
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

        res.status(200).json(resultadoFinal);

    } catch (erro) {
        console.error('Erro ao processar dados da Tuya para gestão:', erro);
        res.status(500).json({ erro: 'Falha ao processar telemetria' });
    }
}
