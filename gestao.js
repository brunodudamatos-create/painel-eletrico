// ================================================================
// gestao.js — Gestão Energética  v4.0
// ================================================================
// CORREÇÕES:
//   1. IDs sincronizados com o gestao.html (mes-consumo-rede,
//      mes-exportacao, mes-balanco-rede, mes-custo-rede, etc.)
//   2. Divisor 100 no gestao.js (API) para converter unidades
//      brutas do EARU em kWh — confirmado via query do Supabase:
//      delta agosto 1.007.162 ÷ 100 = 10.071 kWh ≈ 10.111 kWh app
//   3. Cards "hoje-saldo", "semana-saldo", "semana-consumo"
//      populados corretamente
//   4. JS completamente separado do HTML
// ================================================================

'use strict';

let dadosGlobais = null;
let chartMensal  = null;
let chartDiario  = null;
let chartSaldo   = null;

// ── Formatadores ─────────────────────────────────────────────

function numero(valor) {
  if (valor === null || valor === undefined) return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function fmtKwh(valor) {
  const n = numero(valor);
  return n !== null ? `${n.toFixed(2)} kWh` : '—';
}

function fmtRs(valor) {
  const n = numero(valor);
  return n !== null ? `R$ ${n.toFixed(2)}` : '—';
}

function setText(id, texto, cor) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerText = texto;
  if (cor) el.style.color = cor;
}

// ── Carregamento principal ────────────────────────────────────

async function carregarGestaoEnergetica() {
  setText('status-api', 'Carregando dados...');

  try {
    const res = await fetch('/api/gestao?v=' + Date.now());

    if (!res.ok) {
      setText('status-api', `Erro HTTP ${res.status}`, '#f85149');
      return;
    }

    dadosGlobais = await res.json();

    if (dadosGlobais.erro) {
      setText('status-api', 'Erro na API: ' + dadosGlobais.erro, '#f85149');
      return;
    }

    if (!dadosGlobais.mensais || dadosGlobais.mensais.length === 0) {
      setText('status-api', 'Nenhum dado encontrado.', '#f85149');
      return;
    }

    setText('status-api', 'Dados do medidor atualizados.', '#3fb950');

    // Popular seletor de meses
    const selectMes = document.getElementById('seletorMes');
    if (!selectMes) return;

    selectMes.innerHTML = '';
    dadosGlobais.mensais.forEach(m => {
      const opt        = document.createElement('option');
      opt.value        = m.mes;
      const [ano, mes] = m.mes.split('-');
      opt.text         = `${mes}/${ano}`;
      selectMes.appendChild(opt);
    });

    // Seleciona o mês mais recente
    selectMes.selectedIndex = selectMes.options.length - 1;
    selectMes.onchange = function () { renderizarMesSelecionado(this.value); };

    renderizarMesSelecionado(selectMes.value);
    renderizarGraficoMensal(dadosGlobais.mensais);

  } catch (erro) {
    setText('status-api', 'Falha de conexão com a API.', '#f85149');
    console.error('Erro ao carregar gestão:', erro);
  }
}

// ── Renderiza o mês selecionado ───────────────────────────────

function renderizarMesSelecionado(mesStr) {
  const mesObj = dadosGlobais.mensais.find(m => m.mes === mesStr);
  if (!mesObj) return;

  const [ano, mes] = mesStr.split('-');
  const mesFormatado = `${mes}/${ano}`;

  // Título
  const titulo = document.getElementById('titulo-mes');
  if (titulo) titulo.innerText = `GESTÃO ENERGÉTICA (${mesFormatado})`;

  // ── Cards principais ────────────────────────────────────────

  setText('mes-consumo-rede', fmtKwh(mesObj.consumo_rede_kwh),     '#f85149');
  setText('mes-exportacao',   fmtKwh(mesObj.energia_exportada_kwh), '#3fb950');
  setText('mes-custo-rede',   fmtRs(mesObj.custo_rede_rs),          '#f85149');

  // Balanço = exportação − consumo
  const exp = numero(mesObj.energia_exportada_kwh) || 0;
  const con = numero(mesObj.consumo_rede_kwh)      || 0;
  const bal = exp - con;
  setText('mes-balanco-rede', fmtKwh(bal), bal >= 0 ? '#3fb950' : '#f85149');

  // Campos aguardando Elekeeper
  setText('mes-geracao-total', 'AGUARDANDO', '#58a6ff');
  setText('mes-consumo-solar', 'AGUARDANDO', '#58a6ff');
  setText('mes-economia',      'AGUARDANDO', '#58a6ff');

  // ── Diários do mês selecionado ──────────────────────────────

  const diarios = (dadosGlobais.diarios || [])
    .filter(d => d.data && d.data.startsWith(mesStr));

  if (diarios.length > 0) {
    const hoje     = diarios[diarios.length - 1];
    const ultimos7 = diarios.slice(-7);

    setText('hoje-saldo', fmtKwh(hoje.energia_exportada_kwh), '#3fb950');

    const exp7 = ultimos7.reduce((s, d) => s + (numero(d.energia_exportada_kwh) || 0), 0);
    const con7 = ultimos7.reduce((s, d) => s + (numero(d.consumo_rede_kwh)      || 0), 0);

    setText('semana-saldo',   fmtKwh(exp7), '#3fb950');
    setText('semana-consumo', fmtKwh(con7), '#f85149');
  } else {
    setText('hoje-saldo',     '— kWh');
    setText('semana-saldo',   '— kWh');
    setText('semana-consumo', '— kWh');
  }

  renderizarGraficosDiarios(diarios);
}

// ── Gráfico mensal ────────────────────────────────────────────

function renderizarGraficoMensal(mensais) {
  const canvas = document.getElementById('graficoMensal');
  if (!canvas) return;

  const labels = mensais.map(m => {
    const [ano, mes] = m.mes.split('-');
    return `${mes}/${ano}`;
  });

  if (chartMensal) chartMensal.destroy();

  chartMensal = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Consumo da rede (kWh)',
          data:  mensais.map(m => numero(m.consumo_rede_kwh)      || 0),
          backgroundColor: '#f85149',
        },
        {
          label: 'Exportação para rede (kWh)',
          data:  mensais.map(m => numero(m.energia_exportada_kwh) || 0),
          backgroundColor: '#f59e0b',
        },
      ],
    },
    options: opcoesGrafico(),
  });
}

// ── Gráficos diários ──────────────────────────────────────────

function renderizarGraficosDiarios(dados) {
  const labels = dados.map(d => d.data.split('-')[2]);

  // Gráfico 1 — Consumo × Exportação
  const canvasDiario = document.getElementById('graficoDiario');
  if (canvasDiario) {
    if (chartDiario) chartDiario.destroy();
    chartDiario = new Chart(canvasDiario.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Consumo da rede (kWh)',
            data:  dados.map(d => numero(d.consumo_rede_kwh)      || 0),
            backgroundColor: '#f85149',
          },
          {
            label: 'Exportação para rede (kWh)',
            data:  dados.map(d => numero(d.energia_exportada_kwh) || 0),
            backgroundColor: '#f59e0b',
          },
        ],
      },
      options: opcoesGrafico(),
    });
  }

  // Gráfico 2 — Exportação diária
  const canvasSaldo = document.getElementById('graficoSaldo');
  if (canvasSaldo) {
    if (chartSaldo) chartSaldo.destroy();
    chartSaldo = new Chart(canvasSaldo.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Exportação para rede (kWh)',
            data:  dados.map(d => numero(d.energia_exportada_kwh) || 0),
            backgroundColor: '#f59e0b',
          },
        ],
      },
      options: opcoesGrafico(),
    });
  }
}

// ── Opções padrão dos gráficos ────────────────────────────────

function opcoesGrafico() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        beginAtZero: true,
        grid:  { color: '#30363d' },
        ticks: { color: '#8b949e' },
      },
      x: {
        grid:  { display: false },
        ticks: { color: '#8b949e' },
      },
    },
    plugins: {
      legend: { labels: { color: '#e6edf3' } },
    },
  };
}

// ── Inicialização ─────────────────────────────────────────────

window.onload = carregarGestaoEnergetica;
