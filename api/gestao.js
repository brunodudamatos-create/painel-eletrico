const { createClient } = require('@supabase/supabase-js');

const TARIFA_KWH = 0.899;
const TIMEZONE = 'America/Cuiaba';
const PAGE_SIZE = 1000;

function numero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function arredondar(v) {
    return Number((Number(v) || 0).toFixed(2));
}

function diaLocal(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

function mesLocal(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric', month: '2-digit'
    }).format(date);
}

function garantirDia(map, chave) {
    if (!map[chave]) {
        map[chave] = {
            data: chave,
            consumo_rede_kwh: 0,
            energia_exportada_kwh: 0,
            leitura_consumo_inicio: null,
            leitura_consumo_final: null,
            leitura_geracao_inicio: null,
            leitura_geracao_final: null
        };
    }
    return map[chave];
}

function garantirMes(map, chave) {
    if (!map[chave]) {
        map[chave] = {
            mes: chave,
            consumo_rede_kwh: 0,
            energia_exportada_kwh: 0,
            leitura_consumo_inicio: null,
            leitura_consumo_final: null,
            leitura_geracao_inicio: null,
            leitura_geracao_final: null
        };
    }
    return map[chave];
}

function adicionarContador(registro, leitura) {
    const consumo = numero(leitura.energia_total);
    const geracao = numero(leitura.energia_gerada_total);

    if (consumo !== null) {
        if (registro.leitura_consumo_inicio === null) registro.leitura_consumo_inicio = consumo;
        registro.leitura_consumo_final = consumo;
    }

    // Só usamos geração quando o contador existe e é > 0.
    if (geracao !== null && geracao > 0) {
        if (registro.leitura_geracao_inicio === null) registro.leitura_geracao_inicio = geracao;
        registro.leitura_geracao_final = geracao;
    }
}

function fecharContador(registro) {
    if (registro.leitura_consumo_inicio !== null && registro.leitura_consumo_final !== null) {
        const delta = registro.leitura_consumo_final - registro.leitura_consumo_inicio;
        registro.consumo_rede_kwh = delta >= 0 ? delta / 1000 : 0;
    }

    if (registro.leitura_geracao_inicio !== null && registro.leitura_geracao_final !== null) {
        const delta = registro.leitura_geracao_final - registro.leitura_geracao_inicio;
        registro.energia_exportada_kwh = delta >= 0 ? delta / 1000 : 0;
    }

    return registro;
}

function formatar(registro, mensal = false) {
    const consumoRede = arredondar(registro.consumo_rede_kwh);
    const exportada = arredondar(registro.energia_exportada_kwh);
    const balancoRede = arredondar(exportada - consumoRede);
    const custoRede = arredondar(consumoRede * TARIFA_KWH);

    return {
        [mensal ? 'mes' : 'data']: registro[mensal ? 'mes' : 'data'],
        consumo_rede_kwh: consumoRede,
        energia_exportada_kwh: exportada,
        geracao_solar_kwh: null,
        consumo_solar_kwh: null,
        consumo_total_kwh: null,
        balanco_rede_kwh: balancoRede,
        custo_rede_rs: custoRede,
        economia_rs: null,
        geracao_total_disponivel: false
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    if (req.method !== 'GET') {
        return res.status(405).json({ erro: 'Método não permitido. Use GET.' });
    }

    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
            process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ erro: 'Variáveis de ambiente do Supabase não configuradas.' });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Busca todas as leituras em páginas para não perder registros > 1.000.
        let leituras = [];
        let inicio = 0;

        while (true) {
            const { data, error } = await supabase
                .from('telemetria_eletrica')
                .select('timestamp, created_at, energia_total, energia_gerada_total')
                .not('energia_total', 'is', null)
                .order('timestamp', { ascending: true })
                .range(inicio, inicio + PAGE_SIZE - 1);

            if (error) {
                return res.status(500).json({ erro: 'Erro no Supabase: ' + error.message });
            }

            if (!data || data.length === 0) break;
            leituras.push(...data);
            if (data.length < PAGE_SIZE) break;
            inicio += PAGE_SIZE;
        }

        const registros = leituras
            .map(l => ({
                ...l,
                dataObj: new Date(l.timestamp || l.created_at)
            }))
            .filter(l => !Number.isNaN(l.dataObj.getTime()))
            .sort((a, b) => a.dataObj - b.dataObj);

        if (registros.length === 0) {
            return res.status(200).json({
                tarifa_kwh: TARIFA_KWH,
                diarios: [],
                mensais: [],
                resumo: {
                    consumo_rede_kwh: 0,
                    energia_exportada_kwh: 0,
                    geracao_solar_kwh: null,
                    consumo_solar_kwh: null,
                    balanco_rede_kwh: 0,
                    custo_rede_rs: 0,
                    economia_rs: null,
                    geracao_total_disponivel: false
                },
                diagnostico: { leituras_consideradas: 0 }
            });
        }

        const diarios = {};
        const mensais = {};

        // Primeiro e último contador de cada dia/mês.
        for (const leitura of registros) {
            const dia = diaLocal(leitura.dataObj);
            const mes = mesLocal(leitura.dataObj);

            adicionarContador(garantirDia(diarios, dia), leitura);
            adicionarContador(garantirMes(mensais, mes), leitura);
        }

        Object.values(diarios).forEach(fecharContador);
        Object.values(mensais).forEach(fecharContador);

        const resultadoDiario = Object.values(diarios)
            .sort((a, b) => a.data.localeCompare(b.data))
            .map(d => formatar(d, false));

        const resultadoMensal = Object.values(mensais)
            .sort((a, b) => a.mes.localeCompare(b.mes))
            .map(m => formatar(m, true));

        // O resumo mensal usa o contador do mês, não a soma dos dias.
        const ultimoMes = resultadoMensal[resultadoMensal.length - 1] || null;
        const resumo = ultimoMes ? {
            consumo_rede_kwh: ultimoMes.consumo_rede_kwh,
            energia_exportada_kwh: ultimoMes.energia_exportada_kwh,
            geracao_solar_kwh: null,
            consumo_solar_kwh: null,
            balanco_rede_kwh: ultimoMes.balanco_rede_kwh,
            custo_rede_rs: ultimoMes.custo_rede_rs,
            economia_rs: null,
            geracao_total_disponivel: false
        } : {
            consumo_rede_kwh: 0,
            energia_exportada_kwh: 0,
            geracao_solar_kwh: null,
            consumo_solar_kwh: null,
            balanco_rede_kwh: 0,
            custo_rede_rs: 0,
            economia_rs: null,
            geracao_total_disponivel: false
        };

        return res.status(200).json({
            tarifa_kwh: TARIFA_KWH,
            diarios: resultadoDiario,
            mensais: resultadoMensal,
            resumo,
            fonte_energia: 'telemetria_eletrica',
            significado: {
                consumo_rede_kwh: 'energia_total: energia consumida da rede',
                energia_exportada_kwh: 'energia_gerada_total: energia solar exportada para a rede',
                geracao_solar_kwh: 'indisponível até integrar o inversor/Elekeeper',
                consumo_solar_kwh: 'indisponível até integrar a geração total do inversor'
            },
            diagnostico: {
                leituras_consideradas: registros.length,
                primeiro_timestamp: registros[0]?.timestamp || registros[0]?.created_at || null,
                ultimo_timestamp: registros[registros.length - 1]?.timestamp || registros[registros.length - 1]?.created_at || null,
                total_dias: resultadoDiario.length,
                total_meses: resultadoMensal.length
            }
        });

    } catch (erro) {
        console.error('Erro em /api/gestao:', erro);
        return res.status(500).json({ erro: 'Erro interno na gestão energética: ' + (erro.message || String(erro)) });
    }
}
