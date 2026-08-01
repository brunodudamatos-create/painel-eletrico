async function carregarGestaoEnergetica() {
    console.log("Iniciando busca de dados de gestão...");
    try {
        const res = await fetch('/api/gestao');
        console.log("Status da resposta da API:", res.status);
        
        const dados = await res.json();
        console.log("Dados recebidos da API:", dados);

        if (!dados || dados.length === 0) {
            console.warn("A API retornou um array vazio ou dados inválidos.");
            document.getElementById('hero-content').innerHTML = "<span style='color: #f85149;'>Nenhum dado encontrado na base para os últimos 30 dias.</span>";
            return;
        }

        const hoje = dados[dados.length - 1];

        // Preenche os cards se houver dados
        document.getElementById('val-geracao').innerText = `${hoje.geracao_kwh || 0} kWh`;
        document.getElementById('val-consumo').innerText = `${hoje.consumo_kwh || 0} kWh`;
        document.getElementById('val-saldo').innerText = `${hoje.saldo_kwh || 0} kWh`;
        document.getElementById('val-custo').innerText = `R$ ${Number(hoje.custo_rede_rs || 0).toFixed(2)}`;

        document.getElementById('hero-content').innerHTML = `
            <p style="margin: 0; color: #3fb950;">✔ Dados carregados com sucesso! Consumo hoje: ${hoje.consumo_kwh} kWh</p>
        `;

    } catch (err) {
        console.error("Erro crítico ao carregar dados executivos:", err);
        document.getElementById('hero-content').innerHTML = "<span style='color: #f85149;'>Erro ao conectar com a API. Veja o console (F12).</span>";
    }
}

window.onload = carregarGestaoEnergetica;
