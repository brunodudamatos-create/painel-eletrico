const { createClient } = require('@supabase/supabase-js');

const TARIFA_KWH = 0.899;
const TIME_ZONE = 'America/Cuiaba';
const MAX_INTERVAL_HOURS = 12;

function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
}

function arredondar(valor, casas = 2) {
    const fator = Math.pow(10, casas);
    return Math.round((valor + Number.EPSILON) * fator) / fator;
}

function chaveDia(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

function chaveMes(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).format(date);
}

function inicioDoDiaLocal(date) {
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date).reduce((obj, p) => {
        obj[p.type] = p.value;
        return obj;
    }, {});

    return new Date(
        `${partes.year}-${partes.month}-${partes.day}T00:00:00-04:00`
    );
}

function proximoDiaLocal(date) {
    return new Date(
        inicioDoDiaLocal(date).getTime() + 24 * 3600000
    );
}

function garantirDia(map, data) {
    if (!map[data]) {
        map[data] = {
            data,
            consumo_kwh: 0,
            geracao_kwh: 0
        };
    }

    return map[data];
}

function garantirMes(map, mes) {
    if (!map[mes]) {
        map[mes] = {
            mes,
            consumo_kwh: 0,
            geracao_kwh: 0
        };
    }

    return map[mes];
}

function distribuirIntervalo(
    inicio,
    fim,
    consumoKwh,
    geracaoKwh,
    diarios,
    mensais
) {
    if (!(fim > inicio)) {
        return;
    }

    const duracaoMs =
        fim.getTime() - inicio.getTime();

    const duracaoHoras =
        duracaoMs / 3600000;

    if (
        duracaoHoras <= 0 ||
        duracaoHoras > MAX_INTERVAL_HOURS
    ) {
        return;
    }

    let cursor = inicio;

    while (cursor < fim) {
        const dia = chaveDia(cursor);
        const mes = chaveMes(cursor);

        const proximo = proximoDiaLocal(cursor);

        const limite =
            proximo < fim
                ? proximo
                : fim;

        const trechoMs =
            limite.getTime() - cursor.getTime();

        const proporcao =
            trechoMs / duracaoMs;

        const consumoTrecho =
            consumoKwh * proporcao;

        const geracaoTrecho =
            geracaoKwh * proporcao;

        garantirDia(diarios, dia).consumo_kwh +=
            consumoTrecho;

        garantirDia(diarios, dia).geracao_kwh +=
            geracaoTrecho;

        garantirMes(mensais, mes).consumo_kwh +=
            consumoTrecho;

        garantirMes(mensais, mes).geracao_kwh +=
            geracaoTrecho;

        cursor = limite;
    }
}

function formatarRegistro(obj, mensal = false) {
    const consumo =
        arredondar(obj.consumo_kwh);

    const geracao =
        arredondar(obj.geracao_kwh);

    const saldo =
        arredondar(
            geracao - consumo
        );

    return {
        [mensal ? 'mes' : 'data']:
            obj[melhorChave(mensal)],

        consumo_kwh:
            consumo,

        geracao_kwh:
            geracao,

        saldo_kwh:
            saldo,

        economia_rs:
            arredondar(
                saldo * TARIFA_KWH
            ),

        custo_rede_rs:
            arredondar(
                consumo * TARIFA_KWH
            ),

        valor_geracao_rs:
            arredondar(
                geracao * TARIFA_KWH
            ),

        percentual_geracao_sobre_consumo:
            consumo > 0
                ? arredondar(
                    (geracao / consumo) * 100
                )
                : 0,

        autossuficiencia:
            consumo > 0
                ? arredondar(
                    Math.min(
                        100,
                        (geracao / consumo) * 100
                    )
                )
                : 0
    };
}

function melhorChave(mensal) {
    return mensal ? 'mes' : 'data';
}

export default async function handler(req, res) {

    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );

    res.setHeader(
        'Pragma',
        'no-cache'
    );

    res.setHeader(
        'Expires',
        '0'
    );

    res.setHeader(
        'Surrogate-Control',
        'no-store'
    );

    if (req.method !== 'GET') {
        return res.status(405).json({
            erro: 'Método não permitido. Use GET.'
        });
    }

    try {

        const supabaseUrl =
            process.env.NEXT_PUBLIC_SUPABASE_URL ||
            process.env.SUPABASE_URL;

        const supabaseKey =
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
            process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {

            return res.status(500).json({
                erro:
                    'Variáveis de ambiente do Supabase não configuradas.'
            });

        }

        const supabase =
            createClient(
                supabaseUrl,
                supabaseKey
            );

        /*
         * IMPORTANTE:
         *
         * timestamp:
         * horário real da medição.
         *
         * energia_total:
         * contador acumulado de consumo
         * proveniente do forward_energy_total da Tuya.
         *
         * energia_gerada_total:
         * contador acumulado de geração
         * proveniente do reverse_energy_total da Tuya.
         */

        const {
            data: leituras,
            error
        } = await supabase
            .from('telemetria_eletrica')
            .select(
                'timestamp, created_at, energia_total, energia_gerada_total'
            )
            .not(
                'energia_total',
                'is',
                null
            )
            .order(
                'timestamp',
                {
                    ascending: true
                }
            );

        if (error) {

            return res.status(500).json({
                erro:
                    'Erro no Supabase: ' +
                    error.message
            });

        }

        if (
            !leituras ||
            leituras.length === 0
        ) {

            return res.status(200).json({

                tarifa_kwh:
                    TARIFA_KWH,

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

                observacao:
                    'Não existem leituras de energia disponíveis.'
            });

        }

        /*
         * Converte os dados do Supabase
         * para uma estrutura limpa.
         */

        const registros =
            leituras
                .map(leitura => {

                    const data =
                        new Date(
                            leitura.timestamp ||
                            leitura.created_at
                        );

                    const consumo =
                        numero(
                            leitura.energia_total
                        );

                    const geracao =
                        numero(
                            leitura.energia_gerada_total
                        );

                    return {
                        data,
                        consumo,
                        geracao
                    };

                })
                .filter(leitura => {

                    return (
                        !Number.isNaN(
                            leitura.data.getTime()
                        ) &&
                        leitura.consumo !== null
                    );

                })
                .sort(
                    (a, b) =>
                        a.data - b.data
                );

        const diarios = {};
        const mensais = {};

        let anterior = null;

        let intervalosValidos = 0;

        let intervalosIgnorados = 0;

        let leiturasGeracaoValidas = 0;

        /*
         * Percorre todas as leituras.
         *
         * Como os valores da Tuya são
         * CONTADORES ACUMULADOS,
         * calculamos:
         *
         * leitura atual
         * -
         * leitura anterior
         *
         * para descobrir o consumo/geração
         * ocorrido naquele intervalo.
         */

        for (
            const atual of registros
        ) {

            const geracaoAtualValida =
                atual.geracao !== null &&
                atual.geracao > 0;

            if (
                geracaoAtualValida
            ) {
                leiturasGeracaoValidas++;
            }

            if (anterior) {

                const deltaHoras =
                    (
                        atual.data.getTime() -
                        anterior.data.getTime()
                    ) / 3600000;

                /*
                 * Só aceitamos intervalos
                 * de até 12 horas.
                 *
                 * Isso evita criar milhares
                 * de kWh caso o equipamento
                 * fique offline por muito tempo.
                 */

                if (
                    deltaHoras > 0 &&
                    deltaHoras <=
                    MAX_INTERVAL_HOURS
                ) {

                    /*
                     * CONSUMO
                     */

                    const deltaConsumo =
                        atual.consumo -
                        anterior.consumo;

                    /*
                     * A Tuya fornece o contador
                     * em Wh.
                     *
                     * Por isso:
                     *
                     * Wh / 1000 = kWh
                     */

                    const consumoKwh =
                        deltaConsumo >= 0
                            ? deltaConsumo / 1000
                            : 0;

                    /*
                     * GERAÇÃO
                     */

                    let geracaoKwh = 0;

                    if (
                        geracaoAtualValida &&
                        anterior.geracao !== null &&
                        anterior.geracao > 0
                    ) {

                        const deltaGeracao =
                            atual.geracao -
                            anterior.geracao;

                        /*
                         * Se o contador aumentou,
                         * houve geração.
                         *
                         * Se diminuiu, provavelmente
                         * houve reset/troca do contador.
                         */

                        geracaoKwh =
                            deltaGeracao >= 0
                                ? deltaGeracao / 1000
                                : 0;
                    }

                    /*
                     * Não processa intervalo
                     * quando o contador de consumo
                     * sofreu uma redução.
                     */

                    const consumoValido =
                        deltaConsumo >= 0;

                    /*
                     * Se o contador de geração
                     * ainda não existia em uma
                     * leitura antiga, podemos
                     * contabilizar o consumo,
                     * mas geração permanece zero.
                     */

                    const geracaoValida =
                        !geracaoAtualValida ||
                        anterior.geracao === null ||
                        anterior.geracao <= 0 ||
                        atual.geracao >=
                        anterior.geracao;

                    if (
                        consumoValido &&
                        geracaoValida
                    ) {

                        distribuirIntervalo(

                            anterior.data,

                            atual.data,

                            consumoKwh,

                            geracaoKwh,

                            diarios,

                            mensais

                        );

                        intervalosValidos++;

                    } else {

                        intervalosIgnorados++;

                    }

                } else {

                    intervalosIgnorados++;

                }

            }

            anterior = atual;

        }

        /*
         * Organiza os dados diários.
         */

        const resultadoDiario =
            Object.values(diarios)
                .sort(
                    (a, b) =>
                        a.data.localeCompare(
                            b.data
                        )
                )
                .map(d => {

                    const consumo =
                        arredondar(
                            d.consumo_kwh
                        );

                    const geracao =
                        arredondar(
                            d.geracao_kwh
                        );

                    const saldo =
                        arredondar(
                            geracao -
                            consumo
                        );

                    return {

                        data: d.data,

                        consumo_kwh:
                            consumo,

                        geracao_kwh:
                            geracao,

                        saldo_kwh:
                            saldo,

                        economia_rs:
                            arredondar(
                                saldo *
                                TARIFA_KWH
                            ),

                        custo_rede_rs:
                            arredondar(
                                consumo *
                                TARIFA_KWH
                            ),

                        valor_geracao_rs:
                            arredondar(
                                geracao *
                                TARIFA_KWH
                            ),

                        percentual_geracao_sobre_consumo:
                            consumo > 0
                                ? arredondar(
                                    (
                                        geracao /
                                        consumo
                                    ) * 100
                                )
                                : 0,

                        autossuficiencia:
                            consumo > 0
                                ? arredondar(
                                    Math.min(
                                        100,
                                        (
                                            geracao /
                                            consumo
                                        ) * 100
                                    )
                                )
                                : 0

                    };

                });

        /*
         * Organiza os dados mensais.
         */

        const resultadoMensal =
            Object.values(mensais)
                .sort(
                    (a, b) =>
                        a.mes.localeCompare(
                            b.mes
                        )
                )
                .map(m => {

                    const consumo =
                        arredondar(
                            m.consumo_kwh
                        );

                    const geracao =
                        arredondar(
                            m.geracao_kwh
                        );

                    const saldo =
                        arredondar(
                            geracao -
                            consumo
                        );

                    return {

                        mes: m.mes,

                        consumo_kwh:
                            consumo,

                        geracao_kwh:
                            geracao,

                        saldo_kwh:
                            saldo,

                        economia_rs:
                            arredondar(
                                saldo *
                                TARIFA_KWH
                            ),

                        custo_rede_rs:
                            arredondar(
                                consumo *
                                TARIFA_KWH
                            ),

                        valor_geracao_rs:
                            arredondar(
                                geracao *
                                TARIFA_KWH
                            ),

                        percentual_geracao_sobre_consumo:
                            consumo > 0
                                ? arredondar(
                                    (
                                        geracao /
                                        consumo
                                    ) * 100
                                )
                                : 0,

                        autossuficiencia:
                            consumo > 0
                                ? arredondar(
                                    Math.min(
                                        100,
                                        (
                                            geracao /
                                            consumo
                                        ) * 100
                                    )
                                )
                                : 0

                    };

                });

        /*
         * Resumo geral.
         */

        const resumoBase =
            resultadoDiario.reduce(
                (acc, dia) => {

                    acc.consumo_kwh +=
                        dia.consumo_kwh;

                    acc.geracao_kwh +=
                        dia.geracao_kwh;

                    return acc;

                },
                {
                    consumo_kwh: 0,
                    geracao_kwh: 0
                }
            );

        const resumoConsumo =
            arredondar(
                resumoBase.consumo_kwh
            );

        const resumoGeracao =
            arredondar(
                resumoBase.geracao_kwh
            );

        const resumoSaldo =
            arredondar(
                resumoGeracao -
                resumoConsumo
            );

        /*
         * Retorno final da API.
         */

        return res.status(200).json({

            tarifa_kwh:
                TARIFA_KWH,

            diarios:
                resultadoDiario,

            mensais:
                resultadoMensal,

            resumo: {

                consumo_kwh:
                    resumoConsumo,

                geracao_kwh:
                    resumoGeracao,

                saldo_kwh:
                    resumoSaldo,

                economia_rs:
                    arredondar(
                        resumoSaldo *
                        TARIFA_KWH
                    ),

                custo_rede_rs:
                    arredondar(
                        resumoConsumo *
                        TARIFA_KWH
                    ),

                valor_geracao_rs:
                    arredondar(
                        resumoGeracao *
                        TARIFA_KWH
                    )

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
                    registros.length,

                leituras_com_geracao_valida:
                    leiturasGeracaoValidas,

                intervalos_processados:
                    intervalosValidos,

                intervalos_ignorados:
                    intervalosIgnorados,

                intervalo_maximo_horas:
                    MAX_INTERVAL_HOURS

            }

        });

    } catch (erro) {

        console.error(
            'Erro em /api/gestao:',
            erro
        );

        return res.status(500).json({

            erro:
                'Erro interno: ' +
                (
                    erro.message ||
                    String(erro)
                )

        });

    }

}
