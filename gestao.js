async function carregarGestaoEnergetica() {
    try {
        const res = await fetch('/api/gestao');
        const dados = await res.json();
        if (!dados || dados.length === 0) return;

        const hoje = dados[dados.length - 1];

        // BLOCO 1: Card Destaque (Hero Card)
        const heroCard = document.getElementById('hero-card');
        const heroContent = document.getElementById('hero-content');
        if (hoje.economia_rs > 0) {
            heroCard.style.borderLeftColor = '#3fb950';
            const autoconsumo = hoje.geracao_kwh > 0 ? Math.min((hoje.consumo_kwh / hoje.geracao_kuh) * 100, 100).toFixed(1) : 0;
            heroContent.innerHTML = `
                <p style="margin: 0 0 5px 0; color: #3fb950;">✔ Hoje você economizou R$ ${Number(hoje.economia_rs).toFixed(2)} graças à geração própria.</p>
                <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">A geração supriu cerca de ${autoconsumo}% da demanda da unidade.</p>
            `;
        } else {
            heroCard.style.borderLeftColor = '#f85149';
            heroContent.innerHTML = `
                <p style="margin: 0 0 5px 0; color: #f85149;">⚠ Hoje a geração não foi suficiente.</p>
                <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">Foi necessário adquirir ${hoje.energia_rede_kwh || 0} kWh da concessionária | Custo estimado: R$ ${Number(hoje.custo_rede_rs || 0).toFixed(2)}</p>
            `;
        }

        // BLOCO 2: Indicadores Diários
        document.getElementById('val-geracao').innerText = `${hoje.geracao_kwh} kWh`;
        document.getElementById('val-consumo').innerText = `${hoje.consumo_kwh} kWh`;
        document.getElementById('val-saldo').innerText = `${hoje.saldo_kwh} kWh`;
        document.getElementById('val-custo').innerText = `R$ ${Number(hoje.custo_rede_rs || 0).toFixed(2)}`;

        // BLOCO 3: Indicadores Mensais
        const saldoMes = dados.reduce((acc, curr) => acc + Number(curr.saldo_kwh), 0);
        const economiaMes = dados.reduce((acc, curr) => acc + Number(curr.economia_rs), 0);
        const redeMes = dados.reduce((acc, curr) => acc + Number(curr.energia_rede_kwh || 0), 0);
        const autossuficienciaMedia = (dados.reduce((acc, curr) => acc + Number(curr.autossuficiencia || 0), 0) / dados.length).toFixed(1);

        document.getElementById('mes-saldo').innerText = `${saldoMes.toFixed(1)} kWh`;
        document.getElementById('mes-economia').innerText = `R$ ${economiaMes.toFixed(2)}`;
        document.getElementById('mes-rede').innerText = `${redeMes.toFixed(1)} kWh`;
        document.getElementById('mes-autossuficiencia').innerText = `${autossuficienciaMedia}%`;

        // BLOCOS 4 a 7: Gráficos
        renderizarGraficos(dados);

    } catch (err) {
        console.error("Erro ao carregar dados executivos:", err);
    }
}

function renderizarGraficos(dados) {
    const labels = dados.map(d => d.data.substring(8, 10) + '/' + d.data.substring(5, 7));

    new Chart(document.getElementById('graficoConsumoGeracao').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Geração (kWh)', data: dados.map(d => d.geracao_kuh), backgroundColor: '#3fb950' },
                { label: 'Consumo (kWh)', data: dados.map(d => d.consumo_kwh), backgroundColor: '#f85149' }
            ]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true, grid: { color: '#30363d' } }, x: { grid: { display: false } } } }
    });

    new Chart(document.getElementById('graficoSaldoDiario').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Saldo (kWh)',
                data: dados.map(d => d.saldo_kwh),
                backgroundColor: dados.map(d => d.saldo_kwh >= 0 ? '#3fb950' : '#f85149')
            }]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true, grid: { color: '#30363d' } }, x: { grid: { display: false } } } }
    });

    let acumulado = 0;
    const dadosEconomia = dados.map(d => {
        acumulado += Number(d.economia_rs);
        return acumulado;
    });
    new Chart(document.getElementById('graficoEconomiaAcumulada').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [{ label: 'Economia Acumulada (R$)', data: dadosEconomia, borderColor: '#58a6ff', backgroundColor: 'rgba(88, 166, 255, 0.1)', fill: true, tension: 0.2 }]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true, grid: { color: '#30363d' } }, x: { grid: { display: false } } } }
    });

    new Chart(document.getElementById('graficoCustoDiario').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Custo da Rede (R$)', data: dados.map(d => d.custo_rede_rs || 0), backgroundColor: '#f0883e' }]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true, grid: { color: '#30363d' } }, x: { grid: { display: false } } } }
    });
}

window.onload = carregarGestaoEnergetica;
