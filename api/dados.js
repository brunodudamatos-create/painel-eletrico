// ================================================================
// VERCEL SERVERLESS FUNCTION — api/dados.js
// MODO SCANNER - DEPURAÇÃO BRUTA
// ================================================================

const crypto = require('crypto');

function gerarAssinaturaTuya(clientId, secret, timestamp, method, urlPath, accessToken = '', body = '') {
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${urlPath}`;
  const cadeiaFinal = accessToken ? clientId + accessToken + timestamp + stringToSign : clientId + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(cadeiaFinal).digest('hex').toUpperCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLIENT_ID          = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET      = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID_MEDIDOR  = process.env.TUYA_DEVICE_MEDIDOR;

  if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID_MEDIDOR) {
    return res.status(500).json({ erro: 'Variáveis de ambiente ausentes no Vercel.' });
  }

  const BASE_URL = 'https://openapi.tuyaus.com'; 

  try {
    const t1 = Date.now().toString();
    const urlToken = '/v1.0/token?grant_type=1';
    const assToken = gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', urlToken);

    const resToken = await fetch(`${BASE_URL}${urlToken}`, {
      headers: { client_id: CLIENT_ID, sign: assToken, t: t1, sign_method: 'HMAC-SHA256' }
    });
    const dadosToken = await resToken.json();
    const accessToken = dadosToken.result?.access_token;

    if (!accessToken) throw new Error('Falha de autenticação com a Tuya.');

    const t2 = Date.now().toString();
    const urlMedidor = `/v1.0/devices/${DEVICE_ID_MEDIDOR}/status`;
    const assDisp = gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlMedidor, accessToken);

    const resMedidor = await fetch(`${BASE_URL}${urlMedidor}`, {
      headers: { client_id: CLIENT_ID, access_token: accessToken, sign: assDisp, t: t2, sign_method: 'HMAC-SHA256' }
    });
    const dadosMed = await resMedidor.json();
    const med = dadosMed.result || [];

    // MODO SCANNER: Devolve exatamente o que o equipamento mandou
    return res.status(200).json({
      aviso: "MODO SCANNER ATIVADO - SUCESSO!",
      instrucao: "Copie todo o conteudo abaixo de 'dados_brutos' e envie no chat.",
      dados_brutos: med
    });

  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno', detalhe: err.message });
  }
};
