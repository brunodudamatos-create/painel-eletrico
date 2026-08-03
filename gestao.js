let dadosGlobais = { diarios: [], mensais: [] };
let chartAnual = null;
let chartDiario = null;
let chartSaldo = null;

async function carregarGestaoEnergetica() {
    try {
        const res = await fetch('/api/gestao');
        dadosGlobais = await res.json();
        
        if (!dadosGlobais.diarios || dadosGlobais.diarios.length === 0) return;

        // Configura o seletor de data para o mês mais recente disponível nos dados
        const ultimoDia = dadosGlobais.diarios[dadosGlobais.diarios.length - 1].data; // Ex: 2026-08-02
        const mesAtual = ultimoDia.substring(0, 7); // Ex: 2026-08
        
        const inputMes = document.getElementById('mesFiltro');
        inputMes.value = mesAtual;
        
        // Listener para quando o usuário trocar o mês
        inputMes.addEventListener('change', () => renderizarPainel(inputMes.value));

        // Renderiza a primeira vez
        renderizarPainel(mesAtual);
        renderizarGraficoAnual(); // O anual mostra todos os meses, independente do filtro

    } catch (err) {
        console.error("Erro ao carregar dados:", err);
    }
}

function renderizarPainel(mesFiltro) {
    // Filtra os dias que pertencem ao mês selecionado
    const dadosFiltrados = dadosGlobais.diarios.filter(d => d.data.startsWith(mesFiltro));

    // Cálculos dos totais do mês selecionado
    const geracaoTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.geracao_kwh, 0);
    const consumoTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.consumo_kwh, 0);
    const saldoTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.saldo_kwh, 0);
    const economiaTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.economia_rs, 0);

    // Atualiza os Cards
    document.getElementById('val-geracao').innerText = `${geracaoTotal.toFixed(2)} kWh`;
    document.getElementById('val-consumo').innerText = `${consumoTotal.toFixed(2)} kWh`;
    document.getElementById('val-saldo').innerText = `${saldoTotal.toFixed(2)} kWh`;
    document.getElementById('val-economia').innerText = `R$ ${economiaTotal.toFixed(2)}`;

    // Atualiza Gráficos Diários
    renderizarGraficosDiarios(dadosFiltrados);
}

function renderizarGraficoAnual() {
    const ctx = document.getElementById('graficoAnual').getContext('2d');
    const labels = dadosGlobais.mensais.map(m => m.mes); // Ex: "2026-07", "2026-08"

    if (chartAnual) chartAnual.destroy();

    chartAnual = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Geração Solar (kWh)', data: dadosGlobais.mensais.map(m => m.geracao_kwh), backgroundColor: '#3fb950' },
                { label: 'Consumo (kWh)', data: dadosGlobais.mensais.map(m => m.consumo_kwh), backgroundColor: '#f85149' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { grid: { color: '#30363d' } },
                x: { grid: { display: false } }
            },
            plugins: { legend: { labels: { color: '#e6edf3' } } }
        }
    });
}

function renderizarGraficosDiarios(dados) {
    const labels = dados.map(d => d.data.substring(8, 10) + '/' + d.data.substring(5, 7)); // Ex: "02/08"

    // Gráfico de Consumo x Geração Diário
    if (chartDiario) chartDiario.destroy();
    chartDiario = new Chart(document.getElementById('graficoDiario').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Geração (kWh)', data: dados.map(d => d.geracao_kwh), backgroundColor: '#3fb950' },
                { label: 'Consumo (kWh)', data: dados.map(d => d.consumo_kwh), backgroundColor: '#f85149' }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { grid: { color: '#30363d' } }, x: { grid: { display: false } } }, plugins: { legend: { labels: { color: '#e6edf3' } } } }
    });

    // Gráfico de Balanço Diário
    if (chartSaldo) chartSaldo.destroy();
    chartSaldo = new Chart(document.getElementById('graficoSaldo').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Balanço (kWh)',
                data: dados.map(d => d.saldo_kwh),
                backgroundColor: dados.map(d => d.saldo_kwh >= 0 ? '#3fb950' : '#f85149')
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { grid: { color: '#30363d' } }, x: { grid: { display: false } } }, plugins: { legend: { display: false } } }
    });
}

window.onload = carregarGestaoEnergetica;
