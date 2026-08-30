const { createClient } = require('@supabase/supabase-js');

const TARIFA_KWH = 0.899;
const PAGE_SIZE = 1000;
const TIMEZONE = 'America/Cuiaba';

export default async function handler(req, res) {

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    try {

        // ============================================================
        // SUPABASE
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
        // BUSCAR TODAS AS LEITURAS
        // ============================================================

        let todasLeituras = [];
        let inicio = 0;

        while (true) {

            const fim = inicio + PAGE_SIZE - 1;

            const { data, error } = await supabase
                .from('telemetria_eletrica')
                .select(`
                    timestamp,
                    energia_total,
                    energia_gerada_total,
                    potencia_total
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

        if (todasLeituras.length === 0) {

            return res.status(200).json({
                tarifa_kwh: TARIFA_KWH,
                diarios: [],
                mensais: [],
                resumo: {
                    consumo_rede_kwh: 0,
                    energia_exportada_kwh: 0,
                    saldo_kwh: 0,
                    economia_rs: 0
                },
                diagnostico: {
                    leituras_consideradas: 0
                }
            });
        }

        // ============================================================
        // FORMATADORES
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
        // AGRUPAMENTOS
        // ============================================================

        const diarios = {};
        const mensais = {};

        let leituraAnterior = null;

        let deltasInvalidos = 0;

        // ============================================================
        // PROCESSAMENTO
        //
        // energia_total = consumo acumulado
        // energia_gerada_total = energia exportada acumulada
        //
        // IMPORTANTE:
        // energia_gerada_total NÃO é geração solar total.
        // É a energia reversa/exportada registrada pelo medidor.
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

            if (!diarios[dia]) {

                diarios[dia] = {
                    data: dia,
                    consumo_rede_kwh: 0,
                    energia_exportada_kwh: 0
                };
            }

            if (!mensais[mes]) {

                mensais[mes] = {
                    mes: mes,
                    consumo_rede_kwh: 0,
                    energia_exportada_kwh: 0
                };
            }

            // Primeira leitura não possui delta
            if (!leituraAnterior) {
                leituraAnterior = leitura;
                continue;
            }

            const consumoAtual = Number(leitura.energia_total);
            const exportacaoAtual = Number(leitura.energia_gerada_total);

            const consumoAnterior = Number(
                leituraAnterior.energia_total
            );

            const exportacaoAnterior = Number(
                leituraAnterior.energia_gerada_total
            );

            if (
                !Number.isFinite(consumoAtual) ||
                !Number.isFinite(exportacaoAtual) ||
                !Number.isFinite(consumoAnterior) ||
                !Number.isFinite(exportacaoAnterior)
            ) {

                deltasInvalidos++;

                leituraAnterior = leitura;
                continue;
            }

            let deltaConsumoWh =
                consumoAtual - consumoAnterior;

            let deltaExportacaoWh =
                exportacaoAtual - exportacaoAnterior;

            // Proteção contra reset
            if (deltaConsumoWh < 0) {

                deltaConsumoWh = 0;
                deltasInvalidos++;
            }

            if (deltaExportacaoWh < 0) {

                deltaExportacaoWh = 0;
                deltasInvalidos++;
            }

            const consumoKwh =
                deltaConsumoWh / 1000;

            const exportacaoKwh =
                deltaExportacaoWh / 1000;

            diarios[dia].consumo_rede_kwh += consumoKwh;
            diarios[dia].energia_exportada_kwh += exportacaoKwh;

            mensais[mes].consumo_rede_kwh += consumoKwh;
            mensais[mes].energia_exportada_kwh += exportacaoKwh;

            leituraAnterior = leitura;
        }

        // ============================================================
        // INDICADORES
        // ============================================================

        function calcularIndicadores(consumoRede, exportacao) {

            // Nesta etapa NÃO existe geração solar total.
            //
            // Portanto não calculamos:
            // geração solar
            // consumo solar
            //
            // O saldo apresentado é apenas:
            // exportação - consumo da rede
            //
            // Quando Elekeeper entrar, substituiremos pelo balanço
            // energético real.

            const saldo =
                exportacao - consumoRede;

            const economia =
                Math.max(0, exportacao * TARIFA_KWH);

            return {

                consumo_rede_kwh:
                    Number(consumoRede.toFixed(2)),

                energia_exportada_kwh:
                    Number(exportacao.toFixed(2)),

                saldo_kwh:
                    Number(saldo.toFixed(2)),

                economia_rs:
                    Number(economia.toFixed(2))
            };
        }

        // ============================================================
        // RESULTADO DIÁRIO
        // ============================================================

        const resultadoDiario = Object.values(diarios)
            .sort((a, b) =>
                a.data.localeCompare(b.data)
            )
            .map(dia => {

                const indicadores =
                    calcularIndicadores(
                        dia.consumo_rede_kwh,
                        dia.energia_exportada_kwh
                    );

                return {
                    data: dia.data,

                    consumo_rede_kwh:
                        indicadores.consumo_rede_kwh,

                    energia_exportada_kwh:
                        indicadores.energia_exportada_kwh,

                    saldo_kwh:
                        indicadores.saldo_kwh,

                    economia_rs:
                        indicadores.economia_rs,

                    // Campos futuros
                    geracao_solar_kwh: null,
                    consumo_solar_kwh: null
                };
            });

        // ============================================================
        // RESULTADO MENSAL
        // ============================================================

        const resultadoMensal = Object.values(mensais)
            .sort((a, b) =>
                a.mes.localeCompare(b.mes)
            )
            .map(mes => {

                const indicadores =
                    calcularIndicadores(
                        mes.consumo_rede_kwh,
                        mes.energia_exportada_kwh
                    );

                return {
                    mes: mes.mes,

                    consumo_rede_kwh:
                        indicadores.consumo_rede_kwh,

                    energia_exportada_kwh:
                        indicadores.energia_exportada_kwh,

                    saldo_kwh:
                        indicadores.saldo_kwh,

                    economia_rs:
                        indicadores.economia_rs,

                    // Futuro Elekeeper
                    geracao_solar_kwh: null,
                    consumo_solar_kwh: null
                };
            });

        // ============================================================
        // RESUMO
        // ============================================================

        const consumoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total + item.consumo_rede_kwh,
                0
            );

        const exportacaoTotal =
            resultadoMensal.reduce(
                (total, item) =>
                    total + item.energia_exportada_kwh,
                0
            );

        const resumo =
            calcularIndicadores(
                consumoTotal,
                exportacaoTotal
            );

        // ============================================================
        // RETORNO
        // ============================================================

        return res.status(200).json({

            tarifa_kwh: TARIFA_KWH,

            diarios:
                resultadoDiario,

            mensais:
                resultadoMensal,

            resumo: {

                consumo_rede_kwh:
                    resumo.consumo_rede_kwh,

                energia_exportada_kwh:
                    resumo.energia_exportada_kwh,

                saldo_kwh:
                    resumo.saldo_kwh,

                economia_rs:
                    resumo.economia_rs,

                geracao_solar_kwh:
                    null,

                consumo_solar_kwh:
                    null
            },

            fonte_energia:
                'telemetria_eletrica',

            status_geracao_solar:
                'AGUARDANDO_INTEGRACAO_ELEKEEPER',

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

                deltas_invalidos:
                    deltasInvalidos,

                primeiro_timestamp:
                    todasLeituras[0]?.timestamp || null,

                ultimo_timestamp:
                    todasLeituras[todasLeituras.length - 1]?.timestamp || null,

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
