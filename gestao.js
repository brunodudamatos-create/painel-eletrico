// ================================================================
// gestao.js — Gestão Energética  v5.1  —  13/09/2026
// ================================================================
// HISTÓRICO:
//   v5.1 (13/09/2026)
//     - Adicionado horário da última leitura do inversor ao lado
//       da potência atual, com aviso visual quando passar de 20 min
//       sem atualizar. MOTIVO: o robô só coleta das 6h às ~17h50 de
//       Cuiabá; fora desse horário o valor mostrado fica "congelado"
//       na última leitura, e sem esse aviso parecia um erro de
//       medição (ex: 0,07 kW às 19h21, quando na real era só uma
//       leitura de 17h50 ainda sendo exibida).
//   v5.0 (13/09/2026)
//     - Cards solares (geração/consumo/economia) agora vêm PRONTOS
//       de /api/gestao (calculados lá com dados mensais reais da
//       tabela solar_geracao). Removida a gambiarra que usava só o
//       valor de "hoje" do inversor como se fosse o mês inteiro —
//       era por isso que os cards ficavam presos em "AGUARDANDO"
//       sempre que a chamada ao inversor falhava.
//     - Widget de status do inversor (topo da tela) trocou de
//       /api/elekeeper (quebrado, dependia de token manual) para
//       /api/inversor (lê o cache já atualizado no Supabase).
//     - Variável renomeada: API_ELEKEEPER → API_INVERSOR.
//   v4.1 (07/09/2026)
//     - IDs sincronizados com o gestao.html (mes-consumo-rede,
//       mes-exportacao, mes-balanco-rede, mes-custo-rede, etc.)
//     - Divisor 100 no gestao.js (API) para converter unidades
//       brutas do EARU em kWh — confirmado via query do Supabase:
//       delta agosto 1.007.162 ÷ 100 = 10.071 kWh ≈ 10.111 kWh app
//     - Cards "hoje-saldo", "semana-saldo", "semana-consumo"
//       populados corretamente
//     - JS completamente separado do HTML
// ================================================================

'use strict';

const API_INVERSOR = '/api/inversor';

let dadosGlobais  = null;
let dadosInversor = null;  // cache da última leitura do inversor (via Supabase)
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

  // Dados solares — já vêm calculados de /api/gestao (tabela solar_geracao)
  if (mesObj.geracao_solar_kwh !== null && mesObj.geracao_solar_kwh !== undefined) {
    setText('mes-geracao-total', fmtKwh(mesObj.geracao_solar_kwh),  '#3fb950');
    setText('mes-consumo-solar', fmtKwh(mesObj.consumo_solar_kwh),  '#3fb950');
    setText('mes-economia',      fmtRs(mesObj.economia_rs),         '#3fb950');
  } else {
    setText('mes-geracao-total', 'AGUARDANDO', '#58a6ff');
    setText('mes-consumo-solar', 'AGUARDANDO', '#58a6ff');
    setText('mes-economia',      'AGUARDANDO', '#58a6ff');
  }

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

async function carregarInversor() {
  try {
    const res = await fetch(API_INVERSOR + '?_t=' + Date.now());
    if (!res.ok) return;
    const dados = await res.json();
    if (dados.erro) {
      console.warn('Inversor:', dados.erro);
      return;
    }
    dadosInversor = dados;

    // Atualizar card de potência instantânea do inversor
    const potEl = document.getElementById('inversor-potencia');
    if (potEl && dados.potencia_atual_w !== null) {
      const kw = (dados.potencia_atual_w / 1000).toFixed(2);
      potEl.textContent = `${kw} kW`;
    }

    // Atualizar estado do inversor
    const stEl = document.getElementById('inversor-estado');
    if (stEl) {
      stEl.textContent = dados.estado || '--';
      stEl.style.color = dados.estado === 'Normal' ? '#3fb950' : '#f85149';
    }

    // Horário da última leitura — usa coletado_em (tem fuso horário
    // explícito), não atualizado_em (texto puro do SAJ, ambíguo).
    // O robô só coleta das 6h às ~17h50 de Cuiabá: fora desse
    // horário, o valor mostrado é da última leitura antes de parar,
    // não é ao vivo — por isso avisamos quando passar de 20 min
    // (o dobro do intervalo normal de 10 min entre coletas).
    const attEl = document.getElementById('inversor-atualizado');
    if (attEl && dados.coletado_em) {
      const dataLeitura = new Date(dados.coletado_em);
      if (!isNaN(dataLeitura.getTime())) {
        const minutosAtras = Math.round((Date.now() - dataLeitura.getTime()) / 60000);
        const horaFormatada = dataLeitura.toLocaleTimeString('pt-BR', {
          timeZone: 'America/Cuiaba', hour: '2-digit', minute: '2-digit'
        });

        if (minutosAtras <= 20) {
          attEl.textContent = `(última leitura: ${horaFormatada})`;
          attEl.style.color = '#8b949e';
        } else {
          const horas = Math.floor(minutosAtras / 60);
          const texto = horas >= 1 ? `há ${horas}h${minutosAtras % 60}min` : `há ${minutosAtras} min`;
          attEl.textContent = `⚠️ desatualizado — última leitura: ${horaFormatada} (${texto})`;
          attEl.style.color = '#d29922';
        }
      }
    }

  } catch (e) {
    console.error('Erro ao carregar status do inversor:', e);
  }
}

window.onload = async function() {
  await carregarGestaoEnergetica();
  carregarInversor();
  // Atualiza o status do inversor a cada 5 minutos
  // (o cache no Supabase só muda a cada 10 min, mas não faz mal
  // checar com mais frequência — o custo é só uma leitura simples)
  setInterval(carregarInversor, 300000);
};
