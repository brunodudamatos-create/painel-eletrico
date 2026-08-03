const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ erro: "Variáveis de ambiente do Supabase não configuradas na Vercel." });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: leituras, error } = await supabase
            .from('telemetria_eletrica')
            .select('created_at, potencia_total')
            .order('created_at', { ascending: true });

        if (error) {
            return res.status(500).json({ erro: "Erro na query do Supabase: " + error.message });
        }

        if (!leituras || leituras.length === 0) {
            return res.status(200).json({ aviso: "A tabela 'telemetria_eletrica' está vazia.", diarios: [], mensais: [] });
        }

        const agrupadoPorDia = {};
        const agrupadoPorMes = {};
        let leituraAnterior = null;

        // Formatadores seguros para o fuso horário de Cuiabá (GMT-4)
        const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cuiaba', year: 'numeric', month: '2-digit', day: '2-digit' });
        const fmtMes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cuiaba', year: 'numeric', month: '2-digit' });

        leituras.forEach(leitura => {
            const dataObjeto = new Date(leitura.created_at);
            
            // Extração correta da data local baseada em Cuiabá (sem corromper o timestamp)
            const strDia = fmtDia.format(dataObjeto); // Ex: "2026-08-02"
            const strMes = fmtMes.format(dataObjeto); // Ex: "2026-08"

            if (!agrupadoPorDia[strDia]) agrupadoPorDia[strDia] = { data: strDia, consumo_kwh: 0, geracao_kwh: 0 };
            if (!agrupadoPorMes[strMes]) agrupadoPorMes[strMes] = { mes: strMes, consumo_kwh: 0, geracao_kwh: 0 };

            if (leituraAnterior) {
                const deltaHoras = (dataObjeto.getTime() - new Date(leituraAnterior.created_at).getTime()) / 3600000;
                
                // Intervalos válidos de até 2 horas entre leituras consecutivas
                if (deltaHoras > 0 && deltaHoras <= 2) {
                    const potAtual = Number(leitura.potencia_total) / 1000;
                    const potAnt = Number(leituraAnterior.potencia_total) / 1000;
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
        return res.status(500).json({ erro: "Exceção interna na API: " + erro.message });
    }
}
