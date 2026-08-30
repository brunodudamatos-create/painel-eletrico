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
        // 1. SUPABASE
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
        // 2. BUSCAR TELEMETRIA
        //
        // energia_total = energia importada da REDE
        // energia_gerada_total = energia EXPORTADA para a REDE
        //
        // Ambos são contadores acumulativos em Wh.
        //
        // ATENÇÃO:
        // energia_gerada_total NÃO é geração FV.
        // Geração FV será adicionada posteriormente pelo Elekeeper.
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
                    erro:
                        'Erro ao consultar telemetria_eletrica: ' +
                        error.message
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
        // 3. SEM DADOS
        // ============================================================

        if (todasLeituras.length === 0) {

            return res.status(200).json({

                tarifa_kwh: TARIFA_KWH,

                diarios: [],

                mensais: [],

                resumo: {
                    geracao_fv_kwh: null,
                    consumo_solar_kwh: null,
                    consumo_rede_kwh: 0,
                    energia_exportada_kwh: 0,
                    consumo_total_kwh: null,
                    autossuficiencia_pct: null,
                    economia_rs: null,
                    custo_rede_rs: 0
                },

                fonte_energia: {
                    consumo_rede: 'Tuya',
                    energia_exportada: 'Tuya',
                    geracao_fv: 'Elekeeper - pendente'
                }

            });
        }

        // ============================================================
        // 4. DATA / TIMEZONE
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
        // 5. AGRUPADORES
        // ============================================================

        const diarios = {};
        const mensais = {};

        let leituraAnterior = null;

        let deltasInvalidos = 0;
        let leiturasValidas = 0;

        // ============================================================
        // 6. PROCESSAMENTO
        // ============================================================

        for (const leitura of todasLeituras) {

            if (!leitura.timestamp) {
                continue;
            }

            const dataObjeto = new Date(leitura.timestamp);

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

                    consumo_rede_kwh: 0,

                    energia_exportada_kwh: 0

                };

            }

            // --------------------------------------------------------
            // Inicializa mês
            // --------------------------------------------------------

            if (!mensais[mes]) {

                mensais[mes] = {

                    mes: mes,

                    consumo_rede_kwh: 0,

                    energia_exportada_kwh: 0

                };

            }

            // --------------------------------------------------------
            // Primeira leitura
            // --------------------------------------------------------

            if (!leituraAnterior) {

                leituraAnterior = leitura;

                continue;
            }

            // --------------------------------------------------------
            // CONTADORES
            // --------------------------------------------------------

            const consumoAtual =
                Number(leitura.energia_total);

            const consumoAnterior =
                Number(leituraAnterior.energia_total);

            const exportacaoAtual =
                Number(leitura.energia_gerada_total);

            const exportacaoAnterior =
                Number(leituraAnterior.energia_gerada_total);

            if (
                !Number.isFinite(consumoAtual) ||
                !Number.isFinite(consumoAnterior) ||
                !Number.isFinite(exportacaoAtual) ||
                !Number.isFinite(exportacaoAnterior)
            ) {

                deltasInvalidos++;

                leituraAnterior = leitura;

                continue;
            }

            // --------------------------------------------------------
            // DELTA EM Wh
            // --------------------------------------------------------

            let deltaConsumoWh =
                consumoAtual - consumoAnterior;

            let deltaExportacaoWh =
                exportacaoAtual - exportacaoAnterior;

            // --------------------------------------------------------
            // RESET DE CONTADOR
            // --------------------------------------------------------

            if (deltaConsumoWh < 0) {

                deltaConsumoWh = 0;

                deltasInvalidos++;

            }

            if (deltaExportacaoWh < 0) {

                deltaExportacaoWh = 0;

                deltasInvalidos++;

            }

            // --------------------------------------------------------
            // CONVERSÃO Wh -> kWh
            // --------------------------------------------------------

            const consumoRedeKwh =
                deltaConsumoWh / 1000;

            const exportacaoKwh =
                deltaExportacaoWh / 1000;

            // --------------------------------------------------------
            // DIA
            // --------------------------------------------------------

            diarios[dia].consumo_rede_kwh +=
                consumoRedeKwh;

            diarios[dia].energia_exportada_kwh +=
                exportacaoKwh;

            // --------------------------------------------------------
            // MÊS
            // --------------------------------------------------------

            mensais[mes].consumo_rede_kwh +=
                consumoRedeKwh;

            mensais[mes].energia_exportada_kwh +=
                exportacaoKwh;

            leiturasValidas++;

            leituraAnterior = leitura;
        }

        // ============================================================
        // 7. ARREDONDAMENTO
        // ============================================================

        function arredondar(valor) {

            return Number(
                Number(valor || 0).toFixed(2)
            );

        }

        // ============================================================
        // 8. RESULTADO DIÁRIO
        //
        // Geração FV ainda NÃO disponível.
        // ============================================================

        const resultadoDiario =
            Object.values(diarios)
                .sort((a, b) =>
                    a.data.localeCompare(b.data)
                )
                .map(dia => {

                    return {

                        data: dia.data,

                        // Tuya
                        consumo_rede_kwh:
                            arredondar(
                                dia.consumo_rede_kwh
                            ),

                        energia_exportada_kwh:
                            arredondar(
                                dia.energia_exportada_kwh
                            ),

                        // Elekeeper futuramente
                        geracao_fv_kwh: null,

                        consumo_solar_kwh: null,

                        consumo_total_kwh: null,

                        autossuficiencia_pct: null,

                        economia_rs: null,

                        saldo_kwh: null

                    };

                });

        // ============================================================
        // 9. RESULTADO MENSAL
        // ============================================================

        const resultadoMensal =
            Object.values(mensais)
                .sort((a, b) =>
                    a.mes.localeCompare(b.mes)
                )
                .map(mes => {

                    return {

                        mes: mes.mes,

                        // IMPORTAÇÃO DA REDE
                        consumo_rede_kwh:
                            arredondar(
                                mes.consumo_rede_kwh
                            ),

                        // EXPORTAÇÃO PARA REDE
                        energia_exportada_kwh:
                            arredondar(
                                mes.energia_exportada_kwh
                            ),

                        // FUTURO ELEKEEPER
                        geracao_fv_kwh: null,

                        consumo_solar_kwh: null,

                        consumo_total_kwh: null,

                        autossuficiencia_pct: null,

                        economia_rs: null,

                        saldo_kwh: null

                    };

                });

        // ============================================================
        // 10. RESUMO GERAL
        // ============================================================

        const consumoRedeTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total +
                    Number(item.consumo_rede_kwh || 0),
                0
            );

        const exportacaoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total +
                    Number(item.energia_exportada_kwh || 0),
                0
            );

        const custoRede =
            consumoRedeTotal * TARIFA_KWH;

        // ============================================================
        // 11. RETORNO
        // ============================================================

        return res.status(200).json({

            tarifa_kwh: TARIFA_KWH,

            diarios: resultadoDiario,

            mensais: resultadoMensal,

            resumo: {

                // ----------------------------------------------------
                // TUYA
                // ----------------------------------------------------

                consumo_rede_kwh:
                    arredondar(consumoRedeTotal),

                energia_exportada_kwh:
                    arredondar(exportacaoTotal),

                custo_rede_rs:
                    arredondar(custoRede),

                // ----------------------------------------------------
                // ELEKEEPER - FUTURO
                // ----------------------------------------------------

                geracao_fv_kwh: null,

                consumo_solar_kwh: null,

                consumo_total_kwh: null,

                autossuficiencia_pct: null,

                economia_rs: null,

                saldo_kwh: null

            },

            fonte_energia: {

                consumo_rede:
                    'Tuya - energia_total',

                energia_exportada:
                    'Tuya - energia_gerada_total',

                geracao_fv:
                    'Elekeeper - será implementado'

            },

            contadores_tuya: {

                consumo:
                    'energia_total',

                exportacao:
                    'energia_gerada_total',

                unidade_origem:
                    'Wh',

                unidade_saida:
                    'kWh'

            },

            diagnostico: {

                leituras_consideradas:
                    todasLeituras.length,

                leituras_validas:
                    leiturasValidas,

                deltas_invalidos:
                    deltasInvalidos,

                primeiro_timestamp:
                    todasLeituras[0]?.timestamp || null,

                ultimo_timestamp:
                    todasLeituras[
                        todasLeituras.length - 1
                    ]?.timestamp || null,

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
