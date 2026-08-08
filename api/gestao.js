const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    // ============================================================
    // CONFIGURAÇÃO DA RESPOSTA
    // ============================================================

    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    try {
        // ========================================================
        // SUPABASE
        // ========================================================

        const supabaseUrl =
            process.env.NEXT_PUBLIC_SUPABASE_URL ||
            process.env.SUPABASE_URL;

        const supabaseKey =
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
            process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({
                erro: 'Variáveis de ambiente do Supabase não configuradas.'
            });
        }

        const supabase = createClient(
            supabaseUrl,
            supabaseKey
        );

        // ========================================================
        // TARIFA DE ENERGIA
        // ========================================================

        const TARIFA_KWH = 0.899;

        // ========================================================
        // CONSULTA DAS LEITURAS
        //
        // IMPORTANTE:
        // energia_total é um contador acumulado do medidor.
        //
        // Portanto:
        //
        // consumo do período =
        // energia final - energia inicial
        //
        // Não usamos potencia_total para calcular energia.
        // ========================================================

        const { data: leituras, error } = await supabase
            .from('telemetria_eletrica')
            .select(`
                created_at,
                timestamp,
                energia_total,
                potencia_total
            `)
            .order('created_at', {
                ascending: true
            });

        if (error) {
            return res.status(500).json({
                erro: 'Erro no Supabase: ' + error.message
            });
        }

        if (!leituras || leituras.length === 0) {
            return res.status(200).json({
                aviso: 'Nenhuma leitura encontrada.',
                diarios: [],
                mensais: []
            });
        }

        // ========================================================
        // FUSO HORÁRIO
        // Cuiabá = America/Cuiaba
        // ========================================================

        const fmtDia = new Intl.DateTimeFormat(
            'en-CA',
            {
                timeZone: 'America/Cuiaba',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }
        );

        const fmtMes = new Intl.DateTimeFormat(
            'en-CA',
            {
                timeZone: 'America/Cuiaba',
                year: 'numeric',
                month: '2-digit'
            }
        );

        // ========================================================
        // AGRUPAMENTO
        // ========================================================

        const agrupadoPorDia = {};

        // ========================================================
        // PROCESSAMENTO DIÁRIO
        //
        // Para cada dia:
        //
        // primeiro valor de energia_total
        // último valor de energia_total
        //
        // consumo = último - primeiro
        // ========================================================

        leituras.forEach((leitura) => {

            const dataReferencia =
                leitura.created_at ||
                leitura.timestamp;

            if (!dataReferencia) {
                return;
            }

            const dataObjeto = new Date(
                dataReferencia
            );

            if (isNaN(dataObjeto.getTime())) {
                return;
            }

            const dia = fmtDia.format(
                dataObjeto
            );

            const mes = fmtMes.format(
                dataObjeto
            );

            let energia = Number(
                leitura.energia_total
            );

            if (!Number.isFinite(energia)) {
                return;
            }

            // ----------------------------------------------------
            // Cria o dia
            // ----------------------------------------------------

            if (!agrupadoPorDia[dia]) {

                agrupadoPorDia[dia] = {
                    data: dia,
                    mes: mes,

                    energia_inicial: energia,
                    energia_final: energia,

                    consumo_kwh: 0,
                    geracao_kwh: 0
                };

            } else {

                // ------------------------------------------------
                // Atualiza o último valor do dia
                // ------------------------------------------------

                agrupadoPorDia[dia].energia_final =
                    energia;
            }
        });

        // ========================================================
        // TRANSFORMA PRIMEIRO/ÚLTIMO CONTADOR EM CONSUMO
        // ========================================================

        Object.values(agrupadoPorDia)
            .forEach((dia) => {

                let consumo =
                    Number(dia.energia_final) -
                    Number(dia.energia_inicial);

                // ------------------------------------------------
                // Proteção contra contador inválido/reset
                // ------------------------------------------------

                if (
                    !Number.isFinite(consumo) ||
                    consumo < 0
                ) {
                    consumo = 0;
                }

                dia.consumo_kwh =
                    Number(
                        consumo.toFixed(2)
                    );

                // ------------------------------------------------
                // GERAÇÃO
                //
                // Ainda não existe no banco.
                // Não inventar valor.
                // ------------------------------------------------

                dia.geracao_kwh = 0;
            });

        // ========================================================
        // RESULTADO DIÁRIO
        // ========================================================

        const resultadoDiario =
            Object.values(agrupadoPorDia)
                .sort((a, b) =>
                    a.data.localeCompare(b.data)
                )
                .map((dia) => {

                    const consumo =
                        Number(dia.consumo_kwh) || 0;

                    const geracao =
                        Number(dia.geracao_kwh) || 0;

                    const saldo =
                        geracao - consumo;

                    const economia =
                        geracao * TARIFA_KWH;

                    const custoRede =
                        consumo * TARIFA_KWH;

                    return {

                        data: dia.data,

                        consumo_kwh:
                            Number(
                                consumo.toFixed(2)
                            ),

                        geracao_kwh:
                            Number(
                                geracao.toFixed(2)
                            ),

                        saldo_kwh:
                            Number(
                                saldo.toFixed(2)
                            ),

                        economia_rs:
                            Number(
                                economia.toFixed(2)
                            ),

                        custo_rede_rs:
                            Number(
                                custoRede.toFixed(2)
                            )
                    };
                });

        // ========================================================
        // AGRUPAMENTO MENSAL
        // ========================================================

        const agrupadoPorMes = {};

        resultadoDiario.forEach((dia) => {

            const mes =
                dia.data.substring(0, 7);

            if (!agrupadoPorMes[mes]) {

                agrupadoPorMes[mes] = {

                    mes,

                    consumo_kwh: 0,

                    geracao_kwh: 0,

                    saldo_kwh: 0,

                    economia_rs: 0,

                    custo_rede_rs: 0
                };
            }

            agrupadoPorMes[mes]
                .consumo_kwh +=
                dia.consumo_kwh;

            agrupadoPorMes[mes]
                .geracao_kwh +=
                dia.geracao_kwh;

            agrupadoPorMes[mes]
                .saldo_kwh +=
                dia.saldo_kwh;

            agrupadoPorMes[mes]
                .economia_rs +=
                dia.economia_rs;

            agrupadoPorMes[mes]
                .custo_rede_rs +=
                dia.custo_rede_rs;
        });

        // ========================================================
        // RESULTADO MENSAL
        // ========================================================

        const resultadoMensal =
            Object.values(agrupadoPorMes)
                .sort((a, b) =>
                    a.mes.localeCompare(b.mes)
                )
                .map((mes) => {

                    return {

                        mes: mes.mes,

                        consumo_kwh:
                            Number(
                                mes.consumo_kwh
                                    .toFixed(2)
                            ),

                        geracao_kwh:
                            Number(
                                mes.geracao_kwh
                                    .toFixed(2)
                            ),

                        saldo_kwh:
                            Number(
                                mes.saldo_kwh
                                    .toFixed(2)
                            ),

                        economia_rs:
                            Number(
                                mes.economia_rs
                                    .toFixed(2)
                            ),

                        custo_rede_rs:
                            Number(
                                mes.custo_rede_rs
                                    .toFixed(2)
                            )
                    };
                });

        // ========================================================
        // INDICADORES GERAIS
        // ========================================================

        const consumoTotal =
            resultadoDiario.reduce(
                (total, dia) =>
                    total + dia.consumo_kwh,
                0
            );

        const geracaoTotal =
            resultadoDiario.reduce(
                (total, dia) =>
                    total + dia.geracao_kwh,
                0
            );

        const saldoTotal =
            geracaoTotal -
            consumoTotal;

        const economiaTotal =
            geracaoTotal *
            TARIFA_KWH;

        const custoTotalRede =
            consumoTotal *
            TARIFA_KWH;

        // ========================================================
        // RETORNO
        //
        // Mantém compatibilidade com o gestao.js atual.
        // ========================================================

        return res.status(200).json({

            tarifa_kwh: TARIFA_KWH,

            diarios:
                resultadoDiario,

            mensais:
                resultadoMensal,

            resumo: {

                consumo_kwh:
                    Number(
                        consumoTotal.toFixed(2)
                    ),

                geracao_kwh:
                    Number(
                        geracaoTotal.toFixed(2)
                    ),

                saldo_kwh:
                    Number(
                        saldoTotal.toFixed(2)
                    ),

                economia_rs:
                    Number(
                        economiaTotal.toFixed(2)
                    ),

                custo_rede_rs:
                    Number(
                        custoTotalRede.toFixed(2)
                    )
            },

            fonte_energia:
                'telemetria_eletrica',

            observacao_geracao:
                'A geração solar ainda não está disponível na tabela telemetria_eletrica. O valor será preenchido quando o respectivo contador da Tuya for incorporado ao api/dados.js.'
        });

    } catch (erro) {

        console.error(
            'Erro na API /api/gestao:',
            erro
        );

        return res.status(500).json({

            erro:
                'Erro interno na API de gestão: ' +
                erro.message
        });
    }
}
