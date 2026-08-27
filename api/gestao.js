const { createClient } = require('@supabase/supabase-js');

const TARIFA_KWH = 0.899;
const PAGE_SIZE = 1000;
const TIMEZONE = 'America/Cuiaba';

export default async function handler(req, res) {

    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );

    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    try {

        // ============================================================
        // 1. CONEXÃO SUPABASE
        // ============================================================

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


        // ============================================================
        // 2. BUSCAR TODAS AS LEITURAS
        //
        // A data da medição é timestamp.
        // Não utilizar created_at para os cálculos.
        // ============================================================

        let todasLeituras = [];
        let inicio = 0;

        while (true) {

            const fim =
                inicio + PAGE_SIZE - 1;

            const {
                data,
                error
            } = await supabase
                .from('telemetria_eletrica')
                .select(`
                    timestamp,
                    energia_total,
                    energia_gerada_total
                `)
                .not('timestamp', 'is', null)
                .order('timestamp', {
                    ascending: true
                })
                .range(inicio, fim);

            if (error) {

                return res.status(500).json({
                    erro:
                        'Erro ao consultar telemetria_eletrica: ' +
                        error.message
                });

            }

            if (!data || data.length === 0) {
                break;
            }

            todasLeituras =
                todasLeituras.concat(data);

            if (data.length < PAGE_SIZE) {
                break;
            }

            inicio += PAGE_SIZE;
        }


        // ============================================================
        // 3. SEM DADOS
        // ============================================================

        if (todasLeituras.length === 0) {

            return res.status(200).json({

                tarifa_kwh: TARIFA_KWH,

                diarios: [],

                mensais: [],

                resumo: {
                    consumo_kwh: 0,
                    geracao_kwh: 0,
                    saldo_kwh: 0,
                    economia_rs: 0,
                    custo_rede_rs: 0,
                    valor_geracao_rs: 0
                },

                fonte_energia:
                    'telemetria_eletrica',

                contadores_tuya: {

                    consumo:
                        'energia_total / forward_energy_total',

                    geracao:
                        'energia_gerada_total / reverse_energy_total',

                    unidade_origem:
                        'Wh',

                    unidade_saida:
                        'kWh'
                },

                diagnostico: {
                    leituras_consideradas: 0
                }

            });

        }


        // ============================================================
        // 4. FORMATAÇÃO DE DATA
        // ============================================================

        const formatarDia =
            new Intl.DateTimeFormat(
                'en-CA',
                {
                    timeZone: TIMEZONE,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                }
            );

        const formatarMes =
            new Intl.DateTimeFormat(
                'en-CA',
                {
                    timeZone: TIMEZONE,
                    year: 'numeric',
                    month: '2-digit'
                }
            );


        // ============================================================
        // 5. ESTRUTURAS
        // ============================================================

        const diarios = {};
        const mensais = {};


        // ============================================================
        // 6. CONTADORES
        // ============================================================

        let leituraAnterior = null;

        let leiturasComConsumo = 0;
        let leiturasComGeracao = 0;

        let leiturasSemGeracao = 0;

        let deltasInvalidos = 0;

        let deltasGeracaoSemBase = 0;


        // ============================================================
        // 7. PROCESSAMENTO
        // ============================================================

        for (const leitura of todasLeituras) {

            const timestamp =
                leitura.timestamp;

            if (!timestamp) {
                continue;
            }

            const dataObjeto =
                new Date(timestamp);

            if (
                Number.isNaN(
                    dataObjeto.getTime()
                )
            ) {
                continue;
            }

            const dia =
                formatarDia.format(
                    dataObjeto
                );

            const mes =
                formatarMes.format(
                    dataObjeto
                );


            // ========================================================
            // INICIALIZA DIA
            // ========================================================

            if (!diarios[dia]) {

                diarios[dia] = {

                    data: dia,

                    consumo_kwh: 0,

                    geracao_kwh: 0

                };

            }


            // ========================================================
            // INICIALIZA MÊS
            // ========================================================

            if (!mensais[mes]) {

                mensais[mes] = {

                    mes: mes,

                    consumo_kwh: 0,

                    geracao_kwh: 0

                };

            }


            // ========================================================
            // PRIMEIRA LEITURA
            // ========================================================

            if (!leituraAnterior) {

                leituraAnterior = leitura;

                continue;

            }


            // ========================================================
            // CONSUMO
            //
            // IMPORTANTE:
            // Não usar Number(null).
            //
            // Null NÃO é zero.
            // ========================================================

            const consumoAtual =
                leitura.energia_total !== null &&
                leitura.energia_total !== undefined &&
                leitura.energia_total !== ''
                    ? Number(
                        leitura.energia_total
                    )
                    : null;

            const consumoAnterior =
                leituraAnterior.energia_total !== null &&
                leituraAnterior.energia_total !== undefined &&
                leituraAnterior.energia_total !== ''
                    ? Number(
                        leituraAnterior.energia_total
                    )
                    : null;


            // ========================================================
            // GERAÇÃO
            //
            // Só calcula geração quando EXISTEM dois valores válidos.
            //
            // Isso é fundamental porque antes de 08/08 a geração
            // estava NULL.
            // ========================================================

            const geracaoAtual =
                leitura.energia_gerada_total !== null &&
                leitura.energia_gerada_total !== undefined &&
                leitura.energia_gerada_total !== ''
                    ? Number(
                        leitura.energia_gerada_total
                    )
                    : null;

            const geracaoAnterior =
                leituraAnterior.energia_gerada_total !== null &&
                leituraAnterior.energia_gerada_total !== undefined &&
                leituraAnterior.energia_gerada_total !== ''
                    ? Number(
                        leituraAnterior.energia_gerada_total
                    )
                    : null;


            // ========================================================
            // VALIDAR CONSUMO
            // ========================================================

            let consumoKwh = 0;

            if (
                Number.isFinite(consumoAtual) &&
                Number.isFinite(consumoAnterior)
            ) {

                let deltaConsumoWh =
                    consumoAtual -
                    consumoAnterior;

                // ----------------------------------------------------
                // Proteção contra reset
                // ----------------------------------------------------

                if (deltaConsumoWh < 0) {

                    deltaConsumoWh = 0;

                    deltasInvalidos++;

                }

                // ----------------------------------------------------
                // Wh -> kWh
                // ----------------------------------------------------

                consumoKwh =
                    deltaConsumoWh / 1000;

                if (consumoKwh > 0) {
                    leiturasComConsumo++;
                }

            } else {

                deltasInvalidos++;

            }


            // ========================================================
            // VALIDAR GERAÇÃO
            // ========================================================

            let geracaoKwh = 0;

            if (
                Number.isFinite(geracaoAtual) &&
                Number.isFinite(geracaoAnterior)
            ) {

                let deltaGeracaoWh =
                    geracaoAtual -
                    geracaoAnterior;

                // ----------------------------------------------------
                // Proteção contra reset
                // ----------------------------------------------------

                if (deltaGeracaoWh < 0) {

                    deltaGeracaoWh = 0;

                    deltasInvalidos++;

                }

                // ----------------------------------------------------
                // Wh -> kWh
                // ----------------------------------------------------

                geracaoKwh =
                    deltaGeracaoWh / 1000;

                if (geracaoKwh > 0) {

                    leiturasComGeracao++;

                } else {

                    leiturasSemGeracao++;

                }

            } else {

                // Não considerar NULL como zero.
                // Não inventar geração antes de existir uma base válida.

                deltasGeracaoSemBase++;

                leiturasSemGeracao++;

            }


            // ========================================================
            // ACUMULAR NO DIA
            // ========================================================

            diarios[dia].consumo_kwh +=
                consumoKwh;

            diarios[dia].geracao_kwh +=
                geracaoKwh;


            // ========================================================
            // ACUMULAR NO MÊS
            // ========================================================

            mensais[mes].consumo_kwh +=
                consumoKwh;

            mensais[mes].geracao_kwh +=
                geracaoKwh;


            // ========================================================
            // PRÓXIMA LEITURA
            // ========================================================

            leituraAnterior =
                leitura;

        }


        // ============================================================
        // 8. CÁLCULO FINANCEIRO
        // ============================================================

        function calcularIndicadores(
            consumo,
            geracao
        ) {

            const saldo =
                geracao -
                consumo;


            const valorGeracao =
                geracao *
                TARIFA_KWH;


            const custoRede =
                consumo *
                TARIFA_KWH;


            const economia =
                saldo *
                TARIFA_KWH;


            let percentualGeracao =
                0;

            if (consumo > 0) {

                percentualGeracao =
                    (
                        geracao /
                        consumo
                    ) * 100;

            }


            let autossuficiencia =
                0;

            if (consumo > 0) {

                autossuficiencia =
                    Math.min(
                        100,
                        (
                            geracao /
                            consumo
                        ) * 100
                    );

            }


            return {

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
                    ),

                valor_geracao_rs:
                    Number(
                        valorGeracao.toFixed(2)
                    ),

                percentual_geracao_sobre_consumo:
                    Number(
                        percentualGeracao.toFixed(2)
                    ),

                autossuficiencia:
                    Number(
                        autossuficiencia.toFixed(2)
                    )

            };

        }


        // ============================================================
        // 9. RESULTADO DIÁRIO
        // ============================================================

        const resultadoDiario =
            Object.values(diarios)
                .sort(
                    (a, b) =>
                        a.data.localeCompare(
                            b.data
                        )
                )
                .map(dia => {

                    return {

                        data:
                            dia.data,

                        ...calcularIndicadores(
                            dia.consumo_kwh,
                            dia.geracao_kwh
                        )

                    };

                });


        // ============================================================
        // 10. RESULTADO MENSAL
        // ============================================================

        const resultadoMensal =
            Object.values(mensais)
                .sort(
                    (a, b) =>
                        a.mes.localeCompare(
                            b.mes
                        )
                )
                .map(mes => {

                    return {

                        mes:
                            mes.mes,

                        ...calcularIndicadores(
                            mes.consumo_kwh,
                            mes.geracao_kwh
                        )

                    };

                });


        // ============================================================
        // 11. RESUMO
        // ============================================================

        const consumoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total +
                    item.consumo_kwh,
                0
            );


        const geracaoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total +
                    item.geracao_kwh,
                0
            );


        const resumo =
            calcularIndicadores(
                consumoTotal,
                geracaoTotal
            );


        // ============================================================
        // 12. DIAGNÓSTICO DOS CONTADORES
        // ============================================================

        const primeiraLeitura =
            todasLeituras[0];

        const ultimaLeitura =
            todasLeituras[
                todasLeituras.length - 1
            ];


        // ============================================================
        // 13. RETORNO
        // ============================================================

        return res.status(200).json({

            tarifa_kwh:
                TARIFA_KWH,


            diarios:
                resultadoDiario,


            mensais:
                resultadoMensal,


            resumo: {

                consumo_kwh:
                    resumo.consumo_kwh,

                geracao_kwh:
                    resumo.geracao_kwh,

                saldo_kwh:
                    resumo.saldo_kwh,

                economia_rs:
                    resumo.economia_rs,

                custo_rede_rs:
                    resumo.custo_rede_rs,

                valor_geracao_rs:
                    resumo.valor_geracao_rs

            },


            fonte_energia:
                'telemetria_eletrica',


            contadores_tuya: {

                consumo:
                    'energia_total / forward_energy_total',

                geracao:
                    'energia_gerada_total / reverse_energy_total',

                unidade_origem:
                    'Wh',

                unidade_saida:
                    'kWh'

            },


            diagnostico: {

                leituras_consideradas:
                    todasLeituras.length,

                leituras_com_consumo:
                    leiturasComConsumo,

                leituras_com_geracao:
                    leiturasComGeracao,

                leituras_sem_geracao:
                    leiturasSemGeracao,

                deltas_geracao_sem_base:
                    deltasGeracaoSemBase,

                deltas_invalidos:
                    deltasInvalidos,

                contador_consumo_inicial:
                    primeiraLeitura?.energia_total ??
                    null,

                contador_consumo_final:
                    ultimaLeitura?.energia_total ??
                    null,

                contador_geracao_inicial:
                    primeiraLeitura?.energia_gerada_total ??
                    null,

                contador_geracao_final:
                    ultimaLeitura?.energia_gerada_total ??
                    null,

                primeiro_timestamp:
                    primeiraLeitura?.timestamp ??
                    null,

                ultimo_timestamp:
                    ultimaLeitura?.timestamp ??
                    null,

                total_dias:
                    resultadoDiario.length,

                total_meses:
                    resultadoMensal.length

            }

        });

    } catch (erro) {

        console.error(
            'Erro em /api/gestao:',
            erro
        );

        return res.status(500).json({

            erro:
                'Erro interno na gestão energética: ' +
                erro.message

        });

    }

}
