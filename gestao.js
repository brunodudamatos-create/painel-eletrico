let chartMensal = null;
let chartDiario = null;
let chartSaldo = null;

async function carregarGestaoEnergetica() {
    try {
        // 'v' evita o cache para garantir que sempre peguemos o dado mais atual da Vercel
        const res = await fetch('/api/gestao?v=' + new Date().getTime());
        const dadosGlobais = await res.json();

        if (Array.isArray(dadosGlobais)) {
            console.warn("API retornou formato antigo. Aguarde o fim do deploy na Vercel.");
            return;
        }

        if (dadosGlobais.erro) {
            alert("Erro reportado pela API: " + dadosGlobais.erro);
            return;
        }
        
        if (!dadosGlobais.diarios || dadosGlobais.diarios.length === 0) {
            console.warn("Nenhum dado encontrado no banco.");
            return;
        }

        renderizarPainel(dadosGlobais);

    } catch (err) {
        console.error("Falha de comunicação com a API:", err);
    }
}

function renderizarPainel(dados) {
    const diarios = dados.diarios;
    const mensais = dados.mensais;

    // --- 1. DADOS DO MÊS ATUAL (Pega o último mês gravado no banco) ---
    const mesAtualObj = mensais[mensais.length - 1]; // Ex: { mes: '2026-08', geracao_kwh: 50, ... }
    const nomeMes = mesAtualObj.mes.split('-').reverse().join('/'); // Formata de 2026-08 para 08/2026

    document.getElementById('titulo-mes').innerText = `RESUMO DO MÊS (${nomeMes})`;
    document.getElementById('mes-geracao').innerText = `${mesAtualObj.geracao_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-consumo').innerText = `${mesAtualObj.consumo_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-saldo').innerText = `${mesAtualObj.saldo_kwh.toFixed(2)} kWh`;
    document.getElementById('mes-economia').innerText = `R$ ${mesAtualObj.economia_rs.toFixed(2)}`;

    // Colorir o saldo do mês (Verde se positivo, Vermelho se negativo)
    const corSaldoMes = mesAtualObj.saldo_kwh >= 0 ? '#3fb950' : '#f85149';
    document.getElementById('mes-saldo').style.color = corSaldoMes;

    // --- 2. INDICADORES DE CURTO PRAZO (Hoje e Últimos 7 dias) ---
    const hoje = diarios[diarios.length - 1];
    
    // Pega os últimos 7 registros diários do array e soma o saldo
    const ultimos7Dias = diarios.slice(-7);
    const saldoSemana = ultimos7Dias.reduce((acc, curr) => acc + curr.saldo_kwh, 0);

    document.getElementById('hoje-saldo').innerText = `${hoje.saldo_kwh.toFixed(2)} kWh`;
    document.getElementById('hoje-saldo').style.color = hoje.saldo_kwh >= 0 ? '#3fb950' : '#f85149';

    document.getElementById('semana-saldo').innerText = `${saldoSemana.toFixed(2)} kWh`;
    document.getElementById('semana-saldo').style.color = saldoSemana >= 0 ? '#3fb950' : '#f85149';

    // --- 3. RENDERIZAR GRÁFICOS ---
    
    // Gráfico Histórico Mensal (Usa todos os meses do banco)
    renderizarGraficoMensal(mensais);

    // Gráficos Diários (Filtra apenas os dias que pertencem ao mês atual)
    const diasDoMesAtual = diarios.filter(d => d.data.startsWith(mesAtualObj.mes));
    renderizarGraficosDiarios(diasDoMesAtual);
}

function renderizarGraficoMensal(mensais) {
    const ctx = document.getElementById('graficoMensal').getContext('2d');
    
    // Formata o eixo X (Ex: "07/2026", "08/2026")
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
    // Formata o eixo X (Ex: "02/08")
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

// Inicia a execução ao carregar a página
window.onload = carregarGestaoEnergetica;
