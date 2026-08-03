let chartMensal = null;
let chartDiario = null;
let chartSaldo = null;

async function carregarGestaoEnergetica() {
    try {
        const res = await fetch('/api/gestao?v=' + new Date().getTime());
        const dadosGlobais = await res.json();

        if (dadosGlobais.erro) {
            alert("Erro na API: " + dadosGlobais.erro);
            return;
        }

        if (dadosGlobais.aviso) {
            console.warn(dadosGlobais.aviso);
            alert("Aviso: " + dadosGlobais.aviso);
            return;
        }
        
        if (!dadosGlobais.diarios || dadosGlobais.diarios.length === 0) {
            alert("Nenhum dado retornado pela API do Supabase.");
            return;
        }

        renderizarPainel(dadosGlobais);

    } catch (err) {
        console.error("Falha de comunicação:", err);
        alert("Erro crítico ao carregar dados da API.");
    }
}

function renderizarPainel(dados) {
    const diarios = dados.diarios;
    const mensais = dados.mensais;

    const mesAtualObj = mensais[mensais.length - 1]; 
    const nomeMes = mesAtualObj.mes.split('-').reverse().join('/'); 

    document.getElementById('titulo-mes').innerText = `RESUMO DO MÊS (${nomeMes})`;
    document.getElementById('mes-geracao').innerText = `${mesAtualObj.geracao_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-consumo').innerText = `${mesAtualObj.consumo_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-saldo').innerText = `${mesAtualObj.saldo_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-economia').innerText = `R$ ${mesAtualObj.economia_rs.toFixed(2)}`;

    document.getElementById('mes-saldo').style.color = mesAtualObj.saldo_kwh >= 0 ? '#3fb950' : '#f85149';

    const hoje = diarios[diarios.length - 1];
    const ultimos7Dias = diarios.slice(-7);
    const saldoSemana = ultimos7Dias.reduce((acc, curr) => acc + curr.saldo_kwh, 0);

    document.getElementById('hoje-saldo').innerText = `${hoje.saldo_kwh.toFixed(2)} kWh`;
    document.getElementById('hoje-saldo').style.color = hoje.saldo_kwh >= 0 ? '#3fb950' : '#f85149';

    document.getElementById('semana-saldo').innerText = `${saldoSemana.toFixed(2)} kWh`;
    document.getElementById('semana-saldo').style.color = saldoSemana >= 0 ? '#3fb950' : '#f85149';

    renderizarGraficoMensal(mensais);

    const diasDoMesAtual = diarios.filter(d => d.data.startsWith(mesAtualObj.mes));
    renderizarGraficosDiarios(diasDoMesAtual);
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
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { grid: { color: '#30363d' } }, x: { grid: { display: false } } }, plugins: { legend: { labels: { color: '#e6edf3`' } } } }
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
