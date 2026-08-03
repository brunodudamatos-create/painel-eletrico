let dadosGlobais = { diarios: [], mensais: [] };
let chartAnual = null;
let chartDiario = null;
let chartSaldo = null;

async function carregarGestaoEnergetica() {
    try {
        // O parâmetro 'v' força o navegador a ignorar o cache local
        const res = await fetch('/api/gestao?v=' + new Date().getTime());
        dadosGlobais = await res.json();
        
        console.log("Resposta da API:", dadosGlobais); // Para vermos no Console (F12)

        // Validação de erro: Se vier no formato antigo (Array) ou houver erro
        if (Array.isArray(dadosGlobais)) {
            alert("A API da Vercel ainda está retornando a versão antiga. Aguarde o fim do Deploy.");
            return;
        }

        if (dadosGlobais.erro) {
            alert("Erro reportado pelo Supabase: " + dadosGlobais.erro);
            return;
        }
        
        if (!dadosGlobais.diarios || dadosGlobais.diarios.length === 0) {
            console.warn("Nenhum dado encontrado no banco para gerar os gráficos.");
            return;
        }

        // Configura o seletor para o mês da última leitura validada
        const ultimoDia = dadosGlobais.diarios[dadosGlobais.diarios.length - 1].data; 
        const mesAtual = ultimoDia.substring(0, 7); 
        
        const inputMes = document.getElementById('mesFiltro');
        inputMes.value = mesAtual;
        
        // Dispara o recálculo quando o usuário mudar o calendário
        inputMes.addEventListener('change', () => renderizarPainel(inputMes.value));

        // Plota a tela inicial
        renderizarPainel(mesAtual);
        renderizarGraficoAnual(); 

    } catch (err) {
        console.error("Falha de comunicação com a API:", err);
        alert("Erro de conexão com a API. Verifique o console.");
    }
}

function renderizarPainel(mesFiltro) {
    const dadosFiltrados = dadosGlobais.diarios.filter(d => d.data.startsWith(mesFiltro));

    const geracaoTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.geracao_kwh, 0);
    const consumoTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.consumo_kwh, 0);
    const saldoTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.saldo_kwh, 0);
    const economiaTotal = dadosFiltrados.reduce((acc, curr) => acc + curr.economia_rs, 0);

    document.getElementById('val-geracao').innerText = `${geracaoTotal.toFixed(2)} kWh`;
    document.getElementById('val-consumo').innerText = `${consumoTotal.toFixed(2)} kWh`;
    document.getElementById('val-saldo').innerText = `${saldoTotal.toFixed(2)} kWh`;
    document.getElementById('val-economia').innerText = `R$ ${economiaTotal.toFixed(2)}`;

    renderizarGraficosDiarios(dadosFiltrados);
}

function renderizarGraficoAnual() {
    const ctx = document.getElementById('graficoAnual').getContext('2d');
    const labels = dadosGlobais.mensais.map(m => m.mes); 

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
            responsive: true, maintainAspectRatio: false,
            scales: { y: { grid: { color: '#30363d' } }, x: { grid: { display: false } } },
            plugins: { legend: { labels: { color: '#e6edf3' } } }
        }
    });
}

function renderizarGraficosDiarios(dados) {
    const labels = dados.map(d => {
        const partes = d.data.split('-');
        return `${partes[2]}/${partes[1]}`; // Formato DD/MM
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
