let dadosGlobais = null;
let chartMensal = null;
let chartDiario = null;
let chartSaldo = null;

async function carregarGestaoEnergetica() {
    try {
        const res = await fetch('/api/gestao?v=' + new Date().getTime());
        dadosGlobais = await res.json();

        if (dadosGlobais.erro) {
            alert("Erro na API: " + dadosGlobais.erro);
            return;
        }
        
        if (!dadosGlobais.mensais || dadosGlobais.mensais.length === 0) {
            console.warn("Nenhum dado encontrado.");
            return;
        }

        // Popula o seletor de meses dinamicamente
        const selectMes = document.getElementById('seletorMes');
        selectMes.innerHTML = '';

        dadosGlobais.mensais.forEach((m, index) => {
            const option = document.createElement('option');
            option.value = m.mes; // Ex: "2026-06" ou "2026-08"
            const partes = m.mes.split('-');
            option.text = `${partes[1]}/${partes[0]}`; // Ex: "06/2026"
            selectMes.appendChild(option);
        });

        // Seleciona por padrão o mês mais recente disponível
        selectMes.selectedIndex = selectMes.options.length - 1;
        
        // Listener para trocar o mês ao selecionar no dropdown
        selectMes.addEventListener('change', () => {
            renderizarMesSelecionado(selectMes.value);
        });

        // Renderiza o gráfico anual e o mês padrão
        renderizarGraficoMensal(dadosGlobais.mensais);
        renderizarMesSelecionado(selectMes.value);

    } catch (err) {
        console.error("Falha ao carregar:", err);
    }
}

function renderizarMesSelecionado(mesStr) {
    const mesObj = dadosGlobais.mensais.find(m => m.mes === mesStr);
    if (!mesObj) return;

    const partesMes = mesStr.split('-').reverse().join('/');
    document.getElementById('titulo-mes').innerText = `RESUMO DO MÊS (${partesMes})`;
    document.getElementById('mes-geracao').innerText = `${mesObj.geracao_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-consumo').innerText = `${mesObj.consumo_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-saldo').innerText = `${mesObj.saldo_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-economia').innerText = `R$ ${mesObj.economia_rs.toFixed(2)}`;

    document.getElementById('mes-saldo').style.color = mesObj.saldo_kwh >= 0 ? '#3fb950' : '#f85149';

    // Indicadores Curtos
    const diarios = dadosGlobais.diarios;
    if (diarios.length > 0) {
        const hoje = diarios[diarios.length - 1];
        const ultimos7Dias = diarios.slice(-7);
        const saldoSemana = ultimos7Dias.reduce((acc, curr) => acc + curr.saldo_kwh, 0);

        document.getElementById('hoje-saldo').innerText = `${hoje.saldo_kwh.toFixed(2)} kWh`;
        document.getElementById('hoje-saldo').style.color = hoje.saldo_kwh >= 0 ? '#3fb950' : '#f85149';

        document.getElementById('semana-saldo').innerText = `${saldoSemana.toFixed(2)} kWh`;
        document.getElementById('semana-saldo').style.color = saldoSemana >= 0 ? '#3fb950' : '#f85149';
    }

    // Filtra e plota os gráficos diários daquele mês
    const diasDoMes = diarios.filter(d => d.data.startsWith(mesStr));
    renderizarGraficosDiarios(diasDoMes);
}

function renderizarGraficoMensal(mensais) {
    const ctx = document.getElementById('graficoMensal').getContext('2d');
    const labels = mensais.map(m => m.mes.split('-').reverse().join('/')); 

    if (chartMensal) chartMensal.destroy();

    chartMensal = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Geração Solar (kWh)', data: mensais.map(m => m.geracao_kwh), backgroundColor: '#3fb950' },
                { label: 'Consumo (kWh)', data: mensais.map(m => m.consumo_kwh), backgroundColor: '#f85149' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { grid: { color: '#30363d' } }, x: { grid: { display: false } } },
            plugins: { legend: { labels: { color: '#e6edf3' } } }
        }
    });
}

function renderizarGraficosDiarios(dados) {
    const labels = dados.map(d => {
        const partes = d.data.split('-');
        return `${partes[2]}/${partes[1]}`; 
    });

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
