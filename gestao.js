let dadosGlobais = null;
let chartMensal = null;
let chartDiario = null;
let chartSaldo = null;

const nf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
}

function kwh(v) {
    return `${nf.format(n(v))} kWh`;
}

function rs(v) {
    return `R$ ${nf.format(n(v))}`;
}

function mostrar(id, valor) {
    const el = document.getElementById(id);
    if (el) el.textContent = valor;
}

function corSaldo(id, valor) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.color = n(valor) >= 0 ? '#3fb950' : '#f85149';
}

async function carregarGestaoEnergetica() {
    try {
        const res = await fetch('/api/gestao?v=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        dadosGlobais = await res.json();
        if (dadosGlobais.erro) throw new Error(dadosGlobais.erro);

        const mensais = dadosGlobais.mensais || [];
        if (!mensais.length) {
            mostrar('status-api', 'Sem dados de energia disponíveis.');
            return;
        }

        const select = document.getElementById('seletorMes');
        select.innerHTML = '';
        mensais.forEach(m => {
            const [ano, mes] = m.mes.split('-');
            const op = document.createElement('option');
            op.value = m.mes;
            op.textContent = `${mes}/${ano}`;
            select.appendChild(op);
        });

        select.value = mensais[mensais.length - 1].mes;
        select.onchange = () => renderizarMes(select.value);

        renderizarMes(select.value);
        renderizarGraficoMensal(mensais);

        mostrar('status-api', 'Dados do medidor atualizados.');
    } catch (erro) {
        console.error(erro);
        mostrar('status-api', 'Erro ao carregar gestão energética.');
    }
}

function renderizarMes(mesStr) {
    const mes = dadosGlobais.mensais.find(m => m.mes === mesStr);
    if (!mes) return;

    const [ano, numeroMes] = mesStr.split('-');
    mostrar('titulo-mes', `GESTÃO ENERGÉTICA (${numeroMes}/${ano})`);

    // Dados que o medidor realmente fornece hoje.
    mostrar('mes-consumo-rede', kwh(mes.consumo_rede_kwh));
    mostrar('mes-exportacao', kwh(mes.energia_exportada_kwh));
    mostrar('mes-custo-rede', rs(mes.custo_rede_rs));
    mostrar('mes-balanco-rede', kwh(mes.balanco_rede_kwh));
    corSaldo('mes-balanco-rede', mes.balanco_rede_kwh);

    // Ainda não existe no banco a geração total do inversor.
    mostrar('mes-geracao-total', 'AGUARDANDO');
    mostrar('mes-consumo-solar', 'AGUARDANDO');
    mostrar('mes-economia', 'AGUARDANDO');

    const diarios = (dadosGlobais.diarios || []).filter(d => d.data.startsWith(mesStr));
    const hoje = diarios.length ? diarios[diarios.length - 1] : null;
    const ultimos7 = diarios.slice(-7);
    const saldo7 = ultimos7.reduce((s, d) => s + n(d.balanco_rede_kwh), 0);

    mostrar('hoje-saldo', hoje ? kwh(hoje.balanco_rede_kwh) : '--');
    corSaldo('hoje-saldo', hoje?.balanco_rede_kwh || 0);
    mostrar('semana-saldo', kwh(saldo7));
    corSaldo('semana-saldo', saldo7);

    renderizarGraficosDiarios(diarios);
}

function opcoesGrafico() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
            y: {
                beginAtZero: true,
                grid: { color: '#30363d' },
                ticks: { color: '#8b949e' },
                title: { display: true, text: 'kWh', color: '#8b949e' }
            },
            x: {
                grid: { display: false },
                ticks: { color: '#8b949e' }
            }
        },
        plugins: {
            legend: { labels: { color: '#e6edf3' } }
        }
    };
}

function renderizarGraficoMensal(mensais) {
    const canvas = document.getElementById('graficoMensal');
    if (!canvas) return;
    if (chartMensal) chartMensal.destroy();

    chartMensal = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: mensais.map(m => {
                const [ano, mes] = m.mes.split('-');
                return `${mes}/${ano}`;
            }),
            datasets: [
                {
                    label: 'Consumo da rede (kWh)',
                    data: mensais.map(m => n(m.consumo_rede_kwh)),
                    backgroundColor: '#f85149'
                },
                {
                    label: 'Energia solar exportada (kWh)',
                    data: mensais.map(m => n(m.energia_exportada_kwh)),
                    backgroundColor: '#3fb950'
                }
            ]
        },
        options: opcoesGrafico()
    });
}

function renderizarGraficosDiarios(dados) {
    const labels = dados.map(d => {
        const partes = d.data.split('-');
        return `${partes[2]}/${partes[1]}`;
    });

    const op = opcoesGrafico();

    const canvas1 = document.getElementById('graficoDiario');
    if (canvas1) {
        if (chartDiario) chartDiario.destroy();
        chartDiario = new Chart(canvas1.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Consumo da rede (kWh)',
                        data: dados.map(d => n(d.consumo_rede_kwh)),
                        backgroundColor: '#f85149'
                    },
                    {
                        label: 'Energia solar exportada (kWh)',
                        data: dados.map(d => n(d.energia_exportada_kwh)),
                        backgroundColor: '#3fb950'
                    }
                ]
            },
            options: op
        });
    }

    const canvas2 = document.getElementById('graficoSaldo');
    if (canvas2) {
        if (chartSaldo) chartSaldo.destroy();
        chartSaldo = new Chart(canvas2.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Balanço da rede: exportação - consumo (kWh)',
                    data: dados.map(d => n(d.balanco_rede_kwh)),
                    backgroundColor: dados.map(d => n(d.balanco_rede_kwh) >= 0 ? '#3fb950' : '#f85149')
                }]
            },
            options: op
        });
    }
}

window.addEventListener('load', carregarGestaoEnergetica);
