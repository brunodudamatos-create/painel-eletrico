// =============================================================
// api/elekeeper.js  —  Dados do Inversor Solar SAJ Elekeeper
// Versão 1.1  —  07/09/2026
// =============================================================
// HISTÓRICO DE ALTERAÇÕES:
//   v1.1 (07/09/2026)
//     - Implementado algoritmo de assinatura (x-sign) correto
//       Fonte: biblioteca open source pysaj-elekeeper
//       Algoritmo: sort(params) → MD5 → SHA1 → uppercase
//       Secret: ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe (chave do frontend)
//   v1.0 (07/09/2026)
//     - Endpoint para buscar dados de geração solar do inversor
//       SAJ C6-75K-T12-LV-40 via portal Elekeeper (iop.saj-electric.com)
//     - Estratégia: token JWT fixo salvo em variável de ambiente
//       O token dura 30 dias — renovar manualmente quando expirar
//     - Retorna:
//         potencia_atual_w:  potência instantânea do inversor (W)
//         geracao_hoje_kwh:  energia gerada hoje (kWh)
//         geracao_total_kwh: energia gerada desde instalação (kWh)
//         estado:            estado do inversor (Normal/Offline/etc)
//         atualizado_em:     timestamp da última leitura do inversor
//     - Endpoints utilizados:
//         POST /dev-api/api/v2/monitor/home/getDeviceEnergyFlowDiagram
//         POST /dev-api/api/v2/monitor/plant/getPlantListStats
//
// VARIÁVEL DE AMBIENTE NECESSÁRIA:
//   ELEKEEPER_TOKEN  — JWT token copiado do DevTools (sem "Bearer ")
//                      Renovar manualmente a cada 30 dias
//   ELEKEEPER_PLANT_UID — UID da planta (fixo: 2952D7851F7147278195F923618A0741)
//
// RENOVAÇÃO DO TOKEN (a cada 30 dias):
//   1. Acesse iop.saj-electric.com e faça login
//   2. Abra DevTools (F12) → Network → Fetch/XHR
//   3. Clique em qualquer endpoint (ex: getPlantListStats)
//   4. Copie o valor do header "authorization" (sem "Bearer ")
//   5. Atualize ELEKEEPER_TOKEN na Vercel → Redeploy
// =============================================================

import crypto from 'crypto';

const BASE_URL          = 'https://iop.saj-electric.com/dev-api/api/v2';
const PLANT_UID         = process.env.ELEKEEPER_PLANT_UID || '2952D7851F7147278195F923618A0741';
const SIGNATURE_SECRET  = 'ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe';
const CLIENT_ID         = 'esolar-monitor-admin';
const APP_PROJECT_NAME  = 'elekeeper';

// Calcula a assinatura da requisição — mesmo algoritmo do frontend Elekeeper
// Fonte: biblioteca pysaj-elekeeper (open source, MIT)
// Algoritmo: sort(chaves) → "k=v&..." → MD5 → SHA1 → uppercase
function calcularSign(params) {
  const excluir = new Set(['confirmPassword', 'rememberMe', 'uuid']);
  const sigParams = { ...params };
  Object.keys(sigParams).forEach(k => { if (excluir.has(k)) delete sigParams[k]; });
  sigParams.clientId = CLIENT_ID;

  const canonical = Object.keys(sigParams)
    .map(k => `${k}=${sigParams[k]}`)
    .sort()
    .join('&');

  const full   = `${canonical}&key=${SIGNATURE_SECRET}`;
  const md5hex = crypto.createHash('md5').update(full).digest('hex');
  return crypto.createHash('sha1').update(md5hex).digest('hex').toUpperCase();
}

// Monta o payload com campos obrigatórios + assinatura
function buildPayload(extra = {}) {
  const agora      = new Date();
  const clientDate = agora.toISOString().split('T')[0];
  const timeStamp  = Date.now();
  const random     = Math.random().toString(36).substring(2, 18).toUpperCase();

  const base = {
    appProjectName: APP_PROJECT_NAME,
    clientCode:     'organization',
    clientDate,
    clientId:       CLIENT_ID,
    lang:           'pt',
    orgCode:        'saj',
    themeColor:     'dark',
    timeStamp,
    random,
    ...extra,
  };

  // Remove campos vazios (igual ao frontend)
  const compact = Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
  );

  const signature = calcularSign(compact);

  return {
    ...compact,
    signParams: Object.keys(compact).join(','),
    signature,
    timeStamp,
    clientDate,
    random,
  };
}

// Headers da requisição
function headersElekeeper(token) {
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    'Authorization': `Bearer ${token}`,
    'origin':  'https://iop.saj-electric.com',
    'referer': 'https://iop.saj-electric.com/',
  };
}

// Busca fluxo de energia (potência instantânea + geração do dia)
async function buscarFluxoEnergia(token) {
  const payload = buildPayload({ plantUid: PLANT_UID });

  const res = await fetch(
    `${BASE_URL}/monitor/home/getDeviceEnergyFlowDiagram`,
    {
      method:  'POST',
      headers: headersElekeeper(token),
      body:    JSON.stringify(payload),
    }
  );

  if (!res.ok) throw new Error(`HTTP ${res.status} em getDeviceEnergyFlowDiagram`);
  const json = await res.json();
  if (!json.connOk) throw new Error(`Elekeeper erro: ${json.errMsg}`);
  return json.data;
}

// Busca estatísticas da planta (geração acumulada total)
async function buscarEstatisticasPlanta(token) {
  const hoje = new Date().toISOString().split('T')[0];
  const payload = buildPayload({
    pageNo: 1, pageSize: 10, keyWordType: '1',
    queryDateType: 1, queryStartDate: hoje, queryEndDate: hoje,
  });

  const res = await fetch(
    `${BASE_URL}/monitor/plant/getPlantListStats`,
    {
      method:  'POST',
      headers: headersElekeeper(token),
      body:    JSON.stringify(payload),
    }
  );

  if (!res.ok) throw new Error(`HTTP ${res.status} em getPlantListStats`);
  const json = await res.json();
  if (!json.connOk) throw new Error(`Elekeeper erro: ${json.errMsg}`);
  return json.data?.list?.[0] || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ erro: 'Use GET.' });

  const token = process.env.ELEKEEPER_TOKEN;
  if (!token) {
    return res.status(500).json({
      erro: 'ELEKEEPER_TOKEN não configurado.',
      instrucao: 'Adicione o token JWT nas variáveis de ambiente da Vercel.'
    });
  }

  try {
    // Busca paralela para máxima velocidade
    const [fluxo, planta] = await Promise.all([
      buscarFluxoEnergia(token),
      buscarEstatisticasPlanta(token),
    ]);

    // Estados do inversor
    const estados = {
      0: 'Offline',
      1: 'Normal',
      2: 'Alarme',
      3: 'Falha',
    };

    return res.status(200).json({
      // Dados principais
      potencia_atual_w:   fluxo.totalPvPower       ?? null,
      geracao_hoje_kwh:   fluxo.todayPvEnergy       ?? null,
      geracao_total_kwh:  planta?.cumulativeEnergy   ? Number(planta.cumulativeEnergy) : null,
      estado:             estados[fluxo.runningState] ?? 'Desconhecido',
      estado_cod:         fluxo.runningState          ?? null,

      // Dados adicionais úteis
      potencia_sistema_kw: fluxo.systemPower          ?? null,   // capacidade nominal: 75kW
      atualizado_em:       fluxo.updateDate            ?? null,  // timestamp da leitura do inversor
      intervalo_refresh_s: fluxo.refreshInterval       ?? 60,

      // Flag de token expirado (para monitorar)
      token_ok: true,
    });

  } catch (err) {
    console.error('Erro /api/elekeeper:', err.message);

    // Token expirado gera erro 401 ou mensagem específica
    const tokenExpirado = err.message.includes('401') ||
                          err.message.includes('token') ||
                          err.message.includes('unauthorized');

    return res.status(tokenExpirado ? 401 : 500).json({
      erro:          err.message,
      token_expirado: tokenExpirado,
      instrucao:     tokenExpirado
        ? 'Token Elekeeper expirado. Acesse iop.saj-electric.com, abra DevTools → Network, copie o header Authorization e atualize ELEKEEPER_TOKEN na Vercel.'
        : 'Erro ao buscar dados do inversor.',
    });
  }
}
