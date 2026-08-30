let dadosGlobais = null;

let chartMensal = null;
let chartDiario = null;
let chartSaldo = null;


// ============================================================
// FORMATADORES
// ============================================================

function numero(valor) {

    if (
        valor === null ||
        valor === undefined ||
        !Number.isFinite(Number(valor))
    ) {
        return 0;
    }

    return Number(valor);
}


function formatarKwh(valor) {

    return `${numero(valor).toFixed(2)} kWh`;
}


function formatarRs(valor) {

    return `R$ ${numero(valor).toFixed(2)}`;
}


// ============================================================
// CORRIGIR TEXTOS DO HTML
// ============================================================

function corrigirTitulos() {

    const textos =
        document.body.querySelectorAll('*');

    textos.forEach(elemento => {

        if (
            elemento.children.length === 0 &&
            elemento.textContent
        ) {

            const texto =
                elemento.textContent.trim();

            // Geração solar ainda não disponível
            if (
                texto === 'GERAÇÃO SOLAR DO MÊS' ||
                texto === 'GERAÇÃO SOLAR'
            ) {

                elemento.textContent =
                    'ENERGIA EXPORTADA PARA REDE';
            }

            if (
                texto === 'CONSUMO TOTAL DO MÊS' ||
                texto === 'CONSUMO TOTAL'
            ) {

                elemento.textContent =
                    'CONSUMO DA REDE';
            }

            if (
                texto === 'SALDO DO MÊS (INJETADO - CONSUMIDO)'
            ) {

                elemento.textContent =
                    'SALDO DA REDE';
            }

            if (
                texto === 'ECONOMIA NO MÊS (R$)' ||
                texto === 'ECONOMIA NO MÊS'
            ) {

                elemento.textContent =
                    'VALOR DA ENERGIA EXPORTADA';
            }
        }
    });
}


// ============================================================
// CARREGAR API
// ============================================================

async function carregarGestaoEnergetica() {

    try {

        const res =
            await fetch(
                '/api/gestao?v=' +
                Date.now()
            );

        if (!res.ok) {

            throw new Error(
                `HTTP ${res.status}`
            );
        }

        dadosGlobais =
            await res.json();

        if (dadosGlobais.erro) {

            alert(
                'Erro na API: ' +
                dadosGlobais.erro
            );

            return;
        }

        if (
            !dadosGlobais.mensais ||
            dadosGlobais.mensais.length === 0
        ) {

            console.warn(
                'Nenhum dado encontrado.'
            );

            return;
        }

        corrigirTitulos();

        // ========================================================
        // SELETOR DE MÊS
        // ========================================================

        const selectMes =
            document.getElementById(
                'seletorMes'
            );

        if (selectMes) {

            selectMes.innerHTML = '';

            dadosGlobais.mensais.forEach(m => {

                const option =
                    document.createElement(
                        'option'
                    );

                option.value = m.mes;

                const partes =
                    m.mes.split('-');

                option.text =
                    `${partes[1]}/${partes[0]}`;

                selectMes.appendChild(
                    option
                );
            });

            selectMes.selectedIndex =
                selectMes.options.length - 1;

            selectMes.onchange = function () {

                renderizarMesSelecionado(
                    this.value
                );
            };
        }

        renderizarGraficoMensal(
            dadosGlobais.mensais
        );

        if (selectMes) {

            renderizarMesSelecionado(
                selectMes.value
            );
        }

    } catch (err) {

        console.error(
            'Falha ao carregar gestão:',
            err
        );

        // NÃO deixa a página branca
        const titulo =
            document.getElementById(
                'titulo-mes'
            );

        if (titulo) {

            titulo.innerText =
                'Erro ao carregar dados';
        }
    }
}


// ============================================================
// MÊS SELECIONADO
// ============================================================

function renderizarMesSelecionado(mesStr) {

    if (!dadosGlobais) return;

    const mesObj =
        dadosGlobais.mensais.find(
            m => m.mes === mesStr
        );

    if (!mesObj) return;

    const partes =
        mesStr.split('-');

    const partesMes =
        `${partes[1]}/${partes[0]}`;


    // ========================================================
    // TÍTULO
    // ========================================================

    const titulo =
        document.getElementById(
            'titulo-mes'
        );

    if (titulo) {

        titulo.innerText =
            `RESUMO DO MÊS (${partesMes})`;
    }


    // ========================================================
    // ENERGIA EXPORTADA
    // ========================================================

    const mesGeracao =
        document.getElementById(
            'mes-geracao'
        );

    if (mesGeracao) {

        mesGeracao.innerText =
            formatarKwh(
                mesObj.energia_exportada_kwh
            );

        mesGeracao.style.color =
            '#3fb950';
    }


    // ========================================================
    // CONSUMO DA REDE
    // ========================================================

    const mesConsumo =
        document.getElementById(
            'mes-consumo'
        );

    if (mesConsumo) {

        mesConsumo.innerText =
            formatarKwh(
                mesObj.consumo_rede_kwh
            );

        mesConsumo.style.color =
            '#f85149';
    }


    // ========================================================
    // SALDO
    // ========================================================

    const mesSaldo =
        document.getElementById(
            'mes-saldo'
        );

    if (mesSaldo) {

        mesSaldo.innerText =
            formatarKwh(
                mesObj.saldo_kwh
            );

        mesSaldo.style.color =
            mesObj.saldo_kwh >= 0
                ? '#3fb950'
                : '#f85149';
    }


    // ========================================================
    // VALOR
    // ========================================================

    const mesEconomia =
        document.getElementById(
            'mes-economia'
        );

    if (mesEconomia) {

        mesEconomia.innerText =
            formatarRs(
                mesObj.economia_rs
            );

        mesEconomia.style.color =
            '#3fb950';
    }


    // ========================================================
    // INDICADORES RECENTES
    // ========================================================

    const diarios =
        dadosGlobais.diarios || [];

    if (diarios.length > 0) {

        const hoje =
            diarios[diarios.length - 1];

        const ultimos7 =
            diarios.slice(-7);

        const saldo7 =
            ultimos7.reduce(
                (total, item) =>
                    total +
                    numero(item.saldo_kwh),
                0
            );


        const hojeSaldo =
            document.getElementById(
                'hoje-saldo'
            );

        if (hojeSaldo) {

            hojeSaldo.innerText =
                formatarKwh(
                    hoje.saldo_kwh
                );

            hojeSaldo.style.color =
                hoje.saldo_kwh >= 0
                    ? '#3fb950'
                    : '#f85149';
        }


        const semanaSaldo =
            document.getElementById(
                'semana-saldo'
            );

        if (semanaSaldo) {

            semanaSaldo.innerText =
                formatarKwh(
                    saldo7
                );

            semanaSaldo.style.color =
                saldo7 >= 0
                    ? '#3fb950'
                    : '#f85149';
        }
    }


    // ========================================================
    // GRÁFICOS DO MÊS
    // ========================================================

    const diasDoMes =
        diarios.filter(
            d =>
                d.data &&
                d.data.startsWith(
                    mesStr
                )
        );

    renderizarGraficosDiarios(
        diasDoMes
    );
}


// ============================================================
// GRÁFICO MENSAL
// ============================================================

function renderizarGraficoMensal(mensais) {

    const canvas =
        document.getElementById(
            'graficoMensal'
        );

    if (!canvas) return;

    const ctx =
        canvas.getContext('2d');

    if (chartMensal) {

        chartMensal.destroy();
    }

    const labels =
        mensais.map(
            m => {

                const partes =
                    m.mes.split('-');

                return `${partes[1]}/${partes[0]}`;
            }
        );


    chartMensal =
        new Chart(ctx, {

            type: 'bar',

            data: {

                labels,

                datasets: [

                    {
                        label:
                            'Exportação para rede (kWh)',

                        data:
                            mensais.map(
                                m =>
                                    numero(
                                        m.energia_exportada_kwh
                                    )
                            ),

                        backgroundColor:
                            '#59e08b'
                    },

                    {
                        label:
                            'Consumo da rede (kWh)',

                        data:
                            mensais.map(
                                m =>
                                    numero(
                                        m.consumo_rede_kwh
                                    )
                            ),

                        backgroundColor:
                            '#f85149'
                    }
                ]
            },

            options: {

                responsive: true,

                maintainAspectRatio: false,

                scales: {

                    y: {

                        beginAtZero: true,

                        grid: {
                            color: '#30363d'
                        },

                        ticks: {
                            color: '#8b949e'
                        }
                    },

                    x: {

                        grid: {
                            display: false
                        },

                        ticks: {
                            color: '#8b949e'
                        }
                    }
                },

                plugins: {

                    legend: {

                        labels: {
                            color: '#e6edf3'
                        }
                    }
                }
            }
        });
}


// ============================================================
// GRÁFICOS DIÁRIOS
// ============================================================

function renderizarGraficosDiarios(dados) {

    const labels =
        dados.map(d => {

            const partes =
                d.data.split('-');

            return `${partes[2]}/${partes[1]}`;
        });


    // ========================================================
    // GRÁFICO 1
    // CONSUMO DA REDE X EXPORTAÇÃO
    // ========================================================

    const canvasDiario =
        document.getElementById(
            'graficoDiario'
        );

    if (canvasDiario) {

        if (chartDiario) {

            chartDiario.destroy();
        }

        chartDiario =
            new Chart(
                canvasDiario.getContext('2d'),
                {

                    type: 'bar',

                    data: {

                        labels,

                        datasets: [

                            {
                                label:
                                    'Consumo da rede (kWh)',

                                data:
                                    dados.map(
                                        d =>
                                            numero(
                                                d.consumo_rede_kwh
                                            )
                                    ),

                                backgroundColor:
                                    '#f85149'
                            },

                            {
                                label:
                                    'Exportação para rede (kWh)',

                                data:
                                    dados.map(
                                        d =>
                                            numero(
                                                d.energia_exportada_kwh
                                            )
                                    ),

                                backgroundColor:
                                    '#59e08b'
                            }
                        ]
                    },

                    options: {

                        responsive: true,

                        maintainAspectRatio: false,

                        scales: {

                            y: {

                                beginAtZero: true,

                                grid: {
                                    color: '#30363d'
                                },

                                ticks: {
                                    color: '#8b949e'
                                }
                            },

                            x: {

                                grid: {
                                    display: false
                                },

                                ticks: {
                                    color: '#8b949e'
                                }
                            }
                        },

                        plugins: {

                            legend: {

                                labels: {
                                    color: '#e6edf3'
                                }
                            }
                        }
                    }
                }
            );
    }


    // ========================================================
    // GRÁFICO 2
    // SALDO REAL DO MEDIDOR
    // ========================================================

    const canvasSaldo =
        document.getElementById(
            'graficoSaldo'
        );

    if (canvasSaldo) {

        if (chartSaldo) {

            chartSaldo.destroy();
        }

        chartSaldo =
            new Chart(
                canvasSaldo.getContext('2d'),
                {

                    type: 'bar',

                    data: {

                        labels,

                        datasets: [

                            {
                                label:
                                    'Saldo da rede (kWh)',

                                data:
                                    dados.map(
                                        d =>
                                            numero(
                                                d.saldo_kwh
                                            )
                                    ),

                                backgroundColor:
                                    dados.map(
                                        d =>
                                            numero(
                                                d.saldo_kwh
                                            ) >= 0
                                                ? '#3fb950'
                                                : '#f85149'
                                    )
                            }
                        ]
                    },

                    options: {

                        responsive: true,

                        maintainAspectRatio: false,

                        scales: {

                            y: {

                                grid: {
                                    color: '#30363d'
                                },

                                ticks: {
                                    color: '#8b949e'
                                }
                            },

                            x: {

                                grid: {
                                    display: false
                                },

                                ticks: {
                                    color: '#8b949e'
                                }
                            }
                        },

                        plugins: {

                            legend: {
                                display: false
                            }
                        }
                    }
                }
            );
    }
}


// ============================================================
// INICIALIZAÇÃO
// ============================================================

window.addEventListener(
    'load',
    carregarGestaoEnergetica
);
