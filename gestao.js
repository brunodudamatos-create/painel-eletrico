let dadosGlobais = null;

let chartMensal = null;
let chartDiario = null;
let chartSaldo = null;


// ================================================================
// CARREGAR DADOS
// ================================================================

async function carregarGestaoEnergetica() {

    try {

        const res =
            await fetch(
                '/api/gestao?v=' +
                new Date().getTime()
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


        // ============================================================
        // SELETOR DE MÊS
        // ============================================================

        const selectMes =
            document.getElementById(
                'seletorMes'
            );

        if (!selectMes) {

            console.error(
                'Elemento #seletorMes não encontrado.'
            );

            return;

        }


        selectMes.innerHTML = '';


        dadosGlobais.mensais.forEach(
            m => {

                const option =
                    document.createElement(
                        'option'
                    );

                option.value =
                    m.mes;


                const partes =
                    m.mes.split('-');


                option.text =
                    `${partes[1]}/${partes[0]}`;


                selectMes.appendChild(
                    option
                );

            }
        );


        // ============================================================
        // MÊS MAIS RECENTE
        // ============================================================

        selectMes.selectedIndex =
            selectMes.options.length - 1;


        // ============================================================
        // EVENTO DO SELETOR
        // ============================================================

        selectMes.onchange =
            function () {

                renderizarMesSelecionado(
                    this.value
                );

            };


        // ============================================================
        // GRÁFICO MENSAL
        // ============================================================

        renderizarGraficoMensal(
            dadosGlobais.mensais
        );


        // ============================================================
        // MÊS PADRÃO
        // ============================================================

        renderizarMesSelecionado(
            selectMes.value
        );


    } catch (err) {

        console.error(
            'Falha ao carregar gestão energética:',
            err
        );

    }

}


// ================================================================
// RENDERIZAR MÊS
// ================================================================

function renderizarMesSelecionado(
    mesStr
) {

    if (!dadosGlobais) {
        return;
    }


    const mesObj =
        dadosGlobais.mensais.find(
            m =>
                m.mes === mesStr
        );


    if (!mesObj) {
        return;
    }


    // ============================================================
    // TÍTULO
    // ============================================================

    const partesMes =
        mesStr.split('-');


    const tituloMes =
        `${partesMes[1]}/${partesMes[0]}`;


    const titulo =
        document.getElementById(
            'titulo-mes'
        );


    if (titulo) {

        titulo.innerText =
            `RESUMO DO MÊS (${tituloMes})`;

    }


    // ============================================================
    // VALORES DO MÊS
    // ============================================================

    const mesGeracao =
        document.getElementById(
            'mes-geracao'
        );

    const mesConsumo =
        document.getElementById(
            'mes-consumo'
        );

    const mesSaldo =
        document.getElementById(
            'mes-saldo'
        );

    const mesEconomia =
        document.getElementById(
            'mes-economia'
        );


    if (mesGeracao) {

        mesGeracao.innerText =
            `${Number(
                mesObj.geracao_kwh || 0
            ).toFixed(2)} kWh`;

    }


    if (mesConsumo) {

        mesConsumo.innerText =
            `${Number(
                mesObj.consumo_kwh || 0
            ).toFixed(2)} kWh`;

    }


    if (mesSaldo) {

        const saldo =
            Number(
                mesObj.saldo_kwh || 0
            );


        mesSaldo.innerText =
            `${saldo.toFixed(2)} kWh`;


        mesSaldo.style.color =
            saldo >= 0
                ? '#3fb950'
                : '#f85149';

    }


    if (mesEconomia) {

        const economia =
            Number(
                mesObj.economia_rs || 0
            );


        mesEconomia.innerText =
            `R$ ${economia.toFixed(2)}`;


        mesEconomia.style.color =
            economia >= 0
                ? '#3fb950'
                : '#f85149';

    }


    // ============================================================
    // DADOS DIÁRIOS
    // ============================================================

    const diarios =
        dadosGlobais.diarios || [];


    const diasDoMes =
        diarios.filter(
            d =>
                d.data.startsWith(
                    mesStr
                )
        );


    // ============================================================
    // INDICADORES RECENTES
    //
    // Mantemos os últimos dados registrados.
    // ============================================================

    if (diarios.length > 0) {

        const hoje =
            diarios[
                diarios.length - 1
            ];


        const ultimos7Dias =
            diarios.slice(-7);


        const saldoSemana =
            ultimos7Dias.reduce(
                (
                    acumulado,
                    item
                ) =>
                    acumulado +
                    Number(
                        item.saldo_kwh || 0
                    ),
                0
            );


        const hojeSaldo =
            document.getElementById(
                'hoje-saldo'
            );


        const semanaSaldo =
            document.getElementById(
                'semana-saldo'
            );


        if (hojeSaldo) {

            const saldoHoje =
                Number(
                    hoje.saldo_kwh || 0
                );


            hojeSaldo.innerText =
                `${saldoHoje.toFixed(2)} kWh`;


            hojeSaldo.style.color =
                saldoHoje >= 0
                    ? '#3fb950'
                    : '#f85149';

        }


        if (semanaSaldo) {

            semanaSaldo.innerText =
                `${saldoSemana.toFixed(2)} kWh`;


            semanaSaldo.style.color =
                saldoSemana >= 0
                    ? '#3fb950'
                    : '#f85149';

        }

    }


    // ============================================================
    // GRÁFICOS DIÁRIOS
    // ============================================================

    renderizarGraficosDiarios(
        diasDoMes
    );

}


// ================================================================
// GRÁFICO MENSAL
// ================================================================

function renderizarGraficoMensal(
    mensais
) {

    const canvas =
        document.getElementById(
            'graficoMensal'
        );


    if (!canvas) {
        return;
    }


    const ctx =
        canvas.getContext('2d');


    const labels =
        mensais.map(
            m => {

                const partes =
                    m.mes.split('-');

                return `${partes[1]}/${partes[0]}`;

            }
        );


    if (chartMensal) {

        chartMensal.destroy();

    }


    chartMensal =
        new Chart(
            ctx,
            {

                type: 'bar',

                data: {

                    labels,

                    datasets: [

                        {
                            label:
                                'Geração Solar (kWh)',

                            data:
                                mensais.map(
                                    m =>
                                        Number(
                                            m.geracao_kwh || 0
                                        )
                                ),

                            backgroundColor:
                                '#3fb950'
                        },

                        {
                            label:
                                'Consumo (kWh)',

                            data:
                                mensais.map(
                                    m =>
                                        Number(
                                            m.consumo_kwh || 0
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
                            }

                        },

                        x: {

                            grid: {
                                display: false
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


// ================================================================
// GRÁFICOS DIÁRIOS
// ================================================================

function renderizarGraficosDiarios(
    dados
) {

    const canvasDiario =
        document.getElementById(
            'graficoDiario'
        );


    const canvasSaldo =
        document.getElementById(
            'graficoSaldo'
        );


    if (!canvasDiario || !canvasSaldo) {
        return;
    }


    const labels =
        dados.map(
            d => {

                const partes =
                    d.data.split('-');

                return `${partes[2]}/${partes[1]}`;

            }
        );


    // ============================================================
    // GRÁFICO GERAÇÃO X CONSUMO
    // ============================================================

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
                                'Geração (kWh)',

                            data:
                                dados.map(
                                    d =>
                                        Number(
                                            d.geracao_kwh || 0
                                        )
                                ),

                            backgroundColor:
                                '#3fb950'
                        },

                        {
                            label:
                                'Consumo (kWh)',

                            data:
                                dados.map(
                                    d =>
                                        Number(
                                            d.consumo_kwh || 0
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
                            }

                        },

                        x: {

                            grid: {
                                display: false
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


    // ============================================================
    // GRÁFICO DE SALDO
    // ============================================================

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
                                'Balanço (kWh)',

                            data:
                                dados.map(
                                    d =>
                                        Number(
                                            d.saldo_kwh || 0
                                        )
                                ),

                            backgroundColor:
                                dados.map(
                                    d =>
                                        Number(
                                            d.saldo_kwh || 0
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

                            beginAtZero: true,

                            grid: {
                                color: '#30363d'
                            }

                        },

                        x: {

                            grid: {
                                display: false
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


// ================================================================
// INICIALIZAÇÃO
// ================================================================

window.onload =
    carregarGestaoEnergetica;
