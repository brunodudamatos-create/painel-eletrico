const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ erro: 'Variáveis de ambiente ausentes.' });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Busca os dados brutos dos últimos 30 dias para evitar estouro de memória
        const dataLimite = new Date();
        dataLimite.setDate(dataLimite.getDate() - 30);

        const { data: leituras, error } = await supabase
            .from('telemetria_eletrica')
            .select('created_at, potencia_total, energia_total')
            .gte('created_at', dataLimite.toISOString())
            .order('created_at', { ascending: true });

        if (error) {
            return res.status(500).json({ erro: 'Erro na query: ' + error.message });
        }

        if (!leituras || leituras.length === 0) {
            return res.status(200).json([]); // Retorna array vazio caso não haja histórico
        }

        const agrupadoPorDia = {};
        let leituraAnterior = null;
        
        // Formatador para o fuso horário de MT, garantindo o agrupamento exato por data local
        const formatter = new Intl.DateTimeFormat('en-CA', { 
            timeZone: 'America/Cuiaba', year: 'numeric', month: '2-digit', day: '2-digit' 
        });

        leituras.forEach(leitura => {
            const dataDia = formatter.format(new Date(leitura.created_at)); // Formato: YYYY-MM-DD

            if (!agrupadoPorDia[dataDia]) {
                agrupadoPorDia[dataDia] = {
                    data: dataDia,
                    consumo_kwh: 0,
                    geracao_kwh: 0,
                    energia_min: leitura.energia_total,
                    energia_max: leitura.energia_total
                };
            }

            agrupadoPorDia[dataDia].energia_max = leitura.energia_total;

            // INTEGRAÇÃO NUMÉRICA: Separando Geração e Consumo pelo sinal da Potência
            if (leituraAnterior) {
                const tempoAtual = new Date(leitura.created_at).getTime();
                const tempoAnterior = new Date(leituraAnterior.created_at).getTime();
                const deltaHoras = (tempoAtual - tempoAnterior) / (1000 * 60 * 60); // Diferença em horas

                // Filtro para ignorar deltas irreais (ex: medidor desligado por várias horas)
                if (deltaHoras > 0 && deltaHoras <= 2) {
                    // Correção da escala: O banco salva em Watts, convertemos para kW
                    const potenciaKw = leitura.potencia_total / 1000; 
                    const energiaKwhIntervalo = Math.abs(potenciaKw * deltaHoras);

                    if (potenciaKw > 0) {
                        agrupadoPorDia[dataDia].consumo_kwh += energiaKwhIntervalo;
                    } else if (potenciaKw < 0) {
                        agrupadoPorDia[dataDia].geracao_kwh += energiaKwhIntervalo;
                    }
                }
            }
            leituraAnterior = leitura;
        });

        // TARIFA BASE ESTIMADA (Pode ser ajustada de acordo com a Energisa)
        const TARIFA = 0.85; 

        // Compilando o JSON final exigido pela tela gestao.html
        const resultadoFinal = Object.values(agrupadoPorDia).map(dia => {
            const consumoFinal = dia.consumo_kwh;
            const geracaoFinal = dia.geracao_kwh;
            
            const saldo = geracaoFinal - consumoFinal;
            const economia = geracaoFinal * TARIFA;
            const custoRede = consumoFinal * TARIFA;
            const autossuficiencia = geracaoFinal > 0 ? Math.min((consumoFinal / geracaoFinal) * 100, 100) : 0;

            return {
                data: dia.data,
                consumo_kwh: Number(consumoFinal.toFixed(2)),
                geracao_kwh: Number(geracaoFinal.toFixed(2)),
                saldo_kwh: Number(saldo.toFixed(2)),
                energia_rede_kwh: Number(consumoFinal.toFixed(2)),
                economia_rs: Number(economia.toFixed(2)),
                custo_rede_rs: Number(custoRede.toFixed(2)),
                autossuficiencia: Number(autossuficiencia.toFixed(1))
            };
        });

        return res.status(200).json(resultadoFinal);

    } catch (erro) {
        return res.status(500).json({ erro: 'Exceção Crítica: ' + erro.message });
    }
}
