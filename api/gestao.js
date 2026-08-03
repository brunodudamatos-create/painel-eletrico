const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    // Evita cache na Vercel
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: leituras, error } = await supabase
            .from('telemetria_eletrica')
            .select('created_at, potencia_total')
            .order('created_at', { ascending: true });

        if (error) return res.status(500).json({ erro: error.message });
        if (!leituras || leituras.length === 0) return res.status(200).json({ diarios: [], mensais: [] });

        const agrupadoPorDia = {};
        const agrupadoPorMes = {};
        let leituraAnterior = null;

        leituras.forEach(leitura => {
            // Ajuste matemático rígido para o fuso horário (UTC-4)
            const dataObjeto = new Date(leitura.created_at);
            dataObjeto.setHours(dataObjeto.getHours() - 4); 
            
            // Garante o formato estrito ISO YYYY-MM-DD e YYYY-MM
            const strDia = dataObjeto.toISOString().split('T')[0]; 
            const strMes = strDia.substring(0, 7); 

            if (!agrupadoPorDia[strDia]) agrupadoPorDia[strDia] = { data: strDia, consumo_kwh: 0, geracao_kwh: 0 };
            if (!agrupadoPorMes[strMes]) agrupadoPorMes[strMes] = { mes: strMes, consumo_kwh: 0, geracao_kwh: 0 };

            if (leituraAnterior) {
                const deltaHoras = (dataObjeto.getTime() - new Date(leituraAnterior.created_at).getTime()) / 3600000;
                
                if (deltaHoras > 0 && deltaHoras <= 2) {
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
            return {
                [isMes ? 'mes' : 'data']: obj[isMes ? 'mes' : 'data'],
                consumo_kwh: Number(consumo.toFixed(2)),
                geracao_kwh: Number(geracao.toFixed(2)),
                saldo_kwh: Number((geracao - consumo).toFixed(2)),
                economia_rs: Number((geracao * TARIFA).toFixed(2)),
                custo_rede_rs: Number((consumo * TARIFA).toFixed(2))
            };
        };

        const resultadoDiario = Object.values(agrupadoPorDia).map(d => formatarDados(d, false));
        const resultadoMensal = Object.values(agrupadoPorMes).map(m => formatarDados(m, true));

        return res.status(200).json({ diarios: resultadoDiario, mensais: resultadoMensal });

    } catch (erro) {
        return res.status(500).json({ erro: erro.message });
    }
}
