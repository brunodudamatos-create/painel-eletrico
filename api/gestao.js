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
        // IMPORTANTE:
        // Não usamos created_at.
        // A data correta da medição é timestamp.
        //
        // Também não fazemos apenas um SELECT simples porque
        // o Supabase pode limitar o retorno a 1.000 registros.
        // ============================================================

        let todasLeituras = [];
        let inicio = 0;

        while (true) {

            const fim = inicio + PAGE_SIZE - 1;

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
                    erro: 'Erro ao consultar telemetria_eletrica: ' + error.message
                });
            }

            if (!data || data.length === 0) {
                break;
            }

            todasLeituras = todasLeituras.concat(data);

            if (data.length < PAGE_SIZE) {
                break;
            }

            inicio += PAGE_SIZE;
        }

        // ============================================================
        // 3. VERIFICAR SE EXISTEM DADOS
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
                fonte_energia: 'telemetria_eletrica',
                contadores_tuya: {
                    consumo: 'energia_total / forward_energy_total',
                    geracao: 'energia_gerada_total / reverse_energy_total',
                    unidade_origem: 'Wh',
                    unidade_saida: 'kWh'
                },
                diagnostico: {
                    leituras_consideradas: 0
                }
            });
        }

        // ============================================================
        // 4. FORMATAÇÃO DE DATA
        //
        // Usa timestamp da medição e não created_at.
        // ============================================================

        const formatarDia = new Intl.DateTimeFormat('en-CA', {
            timeZone: TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });

        const formatarMes = new Intl.DateTimeFormat('en-CA', {
            timeZone: TIMEZONE,
            year: 'numeric',
            month: '2-digit'
        });

        // ============================================================
        // 5. ESTRUTURAS DE AGRUPAMENTO
        // ============================================================

        const diarios = {};
        const mensais = {};

        // ============================================================
        // 6. PROCESSAMENTO DOS CONTADORES CUMULATIVOS
        //
        // energia_total:
        // consumo acumulado em Wh
        //
        // energia_gerada_total:
        // geração acumulada em Wh
        //
        // A energia do período é:
        //
        // leitura atual - leitura anterior
        //
        // ============================================================

        let leituraAnterior = null;

        let leiturasComGeracao = 0;
        let leiturasSemGeracao = 0;
        let deltasInvalidos = 0;

        for (const leitura of todasLeituras) {

            const timestamp = leitura.timestamp;

            if (!timestamp) {
                continue;
            }

            const dataObjeto = new Date(timestamp);

            if (Number.isNaN(dataObjeto.getTime())) {
                continue;
            }

            const dia = formatarDia.format(dataObjeto);
            const mes = formatarMes.format(dataObjeto);

            // --------------------------------------------------------
            // Inicializa dia
            // --------------------------------------------------------

            if (!diarios[dia]) {
                diarios[dia] = {
                    data: dia,
                    consumo_kwh: 0,
                    geracao_kwh: 0
                };
            }

            // --------------------------------------------------------
            // Inicializa mês
            // --------------------------------------------------------

            if (!mensais[mes]) {
                mensais[mes] = {
                    mes: mes,
                    consumo_kwh: 0,
                    geracao_kwh: 0
                };
            }

            // --------------------------------------------------------
            // Primeira leitura não possui delta
            // --------------------------------------------------------

            if (!leituraAnterior) {
                leituraAnterior = leitura;
                continue;
            }

            // --------------------------------------------------------
            // Contadores atuais
            // --------------------------------------------------------

            const consumoAtual = Number(leitura.energia_total);
            const geracaoAtual = Number(leitura.energia_gerada_total);

            const consumoAnterior = Number(
                leituraAnterior.energia_total
            );

            const geracaoAnterior = Number(
                leituraAnterior.energia_gerada_total
            );

            // --------------------------------------------------------
            // Validar números
            // --------------------------------------------------------

            if (
                !Number.isFinite(consumoAtual) ||
                !Number.isFinite(geracaoAtual) ||
                !Number.isFinite(consumoAnterior) ||
                !Number.isFinite(geracaoAnterior)
            ) {
                deltasInvalidos++;
                leituraAnterior = leitura;
                continue;
            }

            // --------------------------------------------------------
            // DELTA DOS CONTADORES
            //
            // Origem: Wh
            // Saída: kWh
            // --------------------------------------------------------

            let deltaConsumoWh =
                consumoAtual - consumoAnterior;

            let deltaGeracaoWh =
                geracaoAtual - geracaoAnterior;

            // --------------------------------------------------------
            // Proteção contra reset do contador
            //
            // Se o contador atual for menor que o anterior,
            // consideramos que houve reset e não geramos energia
            // negativa.
            // --------------------------------------------------------

            if (deltaConsumoWh < 0) {
                deltaConsumoWh = 0;
                deltasInvalidos++;
            }

            if (deltaGeracaoWh < 0) {
                deltaGeracaoWh = 0;
                deltasInvalidos++;
            }

            const consumoKwh =
                deltaConsumoWh / 1000;

            const geracaoKwh =
                deltaGeracaoWh / 1000;

            // --------------------------------------------------------
            // Acumula no dia
            // --------------------------------------------------------

            diarios[dia].consumo_kwh += consumoKwh;
            diarios[dia].geracao_kwh += geracaoKwh;

            // --------------------------------------------------------
            // Acumula no mês
            // --------------------------------------------------------

            mensais[mes].consumo_kwh += consumoKwh;
            mensais[mes].geracao_kwh += geracaoKwh;

            // --------------------------------------------------------
            // Diagnóstico
            // --------------------------------------------------------

            if (geracaoKwh > 0) {
                leiturasComGeracao++;
            } else {
                leiturasSemGeracao++;
            }

            leituraAnterior = leitura;
        }

        // ============================================================
        // 7. FUNÇÃO DE CÁLCULO FINANCEIRO
        // ============================================================

        function calcularIndicadores(consumo, geracao) {

            const saldo = geracao - consumo;

            // Valor econômico da geração
            const valorGeracao =
                geracao * TARIFA_KWH;

            // Custo que seria pago pela energia consumida
            const custoRede =
                consumo * TARIFA_KWH;

            // Economia líquida:
            // geração - consumo
            //
            // Positivo = geração superior ao consumo
            // Negativo = consumo superior à geração
            const economia =
                saldo * TARIFA_KWH;

            let percentualGeracao = 0;

            if (consumo > 0) {
                percentualGeracao =
                    (geracao / consumo) * 100;
            }

            let autossuficiencia = 0;

            if (consumo > 0) {
                autossuficiencia =
                    Math.min(
                        100,
                        (geracao / consumo) * 100
                    );
            }

            return {
                consumo_kwh: Number(consumo.toFixed(2)),
                geracao_kwh: Number(geracao.toFixed(2)),
                saldo_kwh: Number(saldo.toFixed(2)),
                economia_rs: Number(economia.toFixed(2)),
                custo_rede_rs: Number(custoRede.toFixed(2)),
                valor_geracao_rs: Number(valorGeracao.toFixed(2)),
                percentual_geracao_sobre_consumo:
                    Number(percentualGeracao.toFixed(2)),
                autossuficiencia:
                    Number(autossuficiencia.toFixed(2))
            };
        }

        // ============================================================
        // 8. GERAR RESULTADO DIÁRIO
        // ============================================================

        const resultadoDiario = Object.values(diarios)
            .sort((a, b) =>
                a.data.localeCompare(b.data)
            )
            .map(dia => {

                return {
                    data: dia.data,
                    ...calcularIndicadores(
                        dia.consumo_kwh,
                        dia.geracao_kwh
                    )
                };
            });

        // ============================================================
        // 9. GERAR RESULTADO MENSAL
        // ============================================================

        const resultadoMensal = Object.values(mensais)
            .sort((a, b) =>
                a.mes.localeCompare(b.mes)
            )
            .map(mes => {

                return {
                    mes: mes.mes,
                    ...calcularIndicadores(
                        mes.consumo_kwh,
                        mes.geracao_kwh
                    )
                };
            });

        // ============================================================
        // 10. RESUMO GERAL
        // ============================================================

        const consumoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total + item.consumo_kwh,
                0
            );

        const geracaoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total + item.geracao_kwh,
                0
            );

        const resumo = calcularIndicadores(
            consumoTotal,
            geracaoTotal
        );

        // ============================================================
        // 11. RETORNO DA API
        // ============================================================

        return res.status(200).json({

            tarifa_kwh: TARIFA_KWH,

            diarios: resultadoDiario,

            mensais: resultadoMensal,

            resumo: {
                consumo_kwh: resumo.consumo_kwh,
                geracao_kwh: resumo.geracao_kwh,
                saldo_kwh: resumo.saldo_kwh,
                economia_rs: resumo.economia_rs,
                custo_rede_rs: resumo.custo_rede_rs,
                valor_geracao_rs: resumo.valor_geracao_rs
            },

            fonte_energia: 'telemetria_eletrica',

            contadores_tuya: {
                consumo:
                    'energia_total / forward_energy_total',

                geracao:
                    'energia_gerada_total / reverse_energy_total',

                unidade_origem: 'Wh',

                unidade_saida: 'kWh'
            },

            diagnostico: {
                leituras_consideradas:
                    todasLeituras.length,

                leituras_com_geracao:
                    leiturasComGeracao,

                leituras_sem_geracao:
                    leiturasSemGeracao,

                deltas_invalidos:
                    deltasInvalidos,

                primeiro_timestamp:
                    todasLeituras.length > 0
                        ? todasLeituras[0].timestamp
                        : null,

                ultimo_timestamp:
                    todasLeituras.length > 0
                        ? todasLeituras[todasLeituras.length - 1].timestamp
                        : null,

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
