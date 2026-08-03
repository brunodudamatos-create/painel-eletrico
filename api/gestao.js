const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Busca todo o histórico ordenado para montar o consolidado Anual e Diário
        const { data: leituras, error } = await supabase
            .from('telemetria_eletrica')
            .select('created_at, potencia_total')
            .order('created_at', { ascending: true });

        if (error) return res.status(500).json({ erro: error.message });
        if (!leituras || leituras.length === 0) return res.status(200).json({ diarios: [], mensais: [] });

        const agrupadoPorDia = {};
        const agrupadoPorMes = {};
        let leituraAnterior = null;

        // Fuso de Mato Grosso para evitar cortes de dia incorretos
        const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cuiaba', year: 'numeric', month: '2-digit', day: '2-digit' });
        const fmtMes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cuiaba', year: 'numeric', month: '2-digit' });

        leituras.forEach(leitura => {
            const dataObjeto = new Date(leitura.created_at);
            const strDia = fmtDia.format(dataObjeto); // YYYY-MM-DD
            const strMes = fmtMes.format(dataObjeto); // YYYY-MM

            if (!agrupadoPorDia[strDia]) agrupadoPorDia[strDia] = { data: strDia, consumo_kwh: 0, geracao_kwh: 0 };
            if (!agrupadoPorMes[strMes]) agrupadoPorMes[strMes] = { mes: strMes, consumo_kwh: 0, geracao_kwh: 0 };

            if (leituraAnterior) {
                const deltaHoras = (dataObjeto.getTime() - new Date(leituraAnterior.created_at).getTime()) / 3600000;
                
                if (deltaHoras > 0 && deltaHoras <= 2) {
                    // Integração Trapezoidal (Média entre a leitura atual e anterior) dividida por 1000 para kW
                    const potAtual = leitura.potencia_total / 1000;
                    const potAnt = leituraAnterior.potencia_total / 1000;
                    const potenciaMediaKw = (potAtual + potAnt) / 2;
                    
                    const energiaKwh = Math.abs(potenciaMediaKw * deltaHoras);

                    if (potenciaMediaKw > 0) {
                        agrupadoPorDia[strDia].consumo_kwh += energiaKwh;
                        agrupadoPorMes[strMes].consumo_kwh += energiaKwh;
                    } else if (potenciaMediaKw < 0) {
                        agrupadoPorDia[strDia].geracao_kwh += energiaKwh;
                        agrupadoPorMes[strMes].geracao_kwh += energiaKwh;
                    }
                }
            }
            leituraAnterior = leitura;
        });

        const TARIFA = 0.85; 
        const formatarDados = (obj, isMes = false) => {
            const consumo = obj.consumo_kwh;
            const geracao = obj.geracao_kwh;
            const autossuficiencia = geracao > 0 ? Math.min((geracao / consumo) * 100, 100) : 0;
            return {
                [isMes ? 'mes' : 'data']: obj[isMes ? 'mes' : 'data'],
                consumo_kwh: Number(consumo.toFixed(2)),
                geracao_kwh: Number(geracao.toFixed(2)),
                saldo_kwh: Number((geracao - consumo).toFixed(2)),
                economia_rs: Number((geracao * TARIFA).toFixed(2)),
                custo_rede_rs: Number((consumo * TARIFA).toFixed(2)),
                autossuficiencia: Number(autossuficiencia.toFixed(1))
            };
        };

        const resultadoDiario = Object.values(agrupadoPorDia).map(d => formatarDados(d, false));
        const resultadoMensal = Object.values(agrupadoPorMes).map(m => formatarDados(m, true));

        return res.status(200).json({ diarios: resultadoDiario, mensais: resultadoMensal });

    } catch (erro) {
        return res.status(500).json({ erro: erro.message });
    }
}
