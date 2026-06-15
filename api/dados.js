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

  const BASE_URL = 'https://openapi.tuyaus.com'; 

  try {
    // 1. Token
    const t1 = Date.now().toString();
    const urlToken = '/v1.0/token?grant_type=1';
    const assinaturaToken = gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t1, 'GET', urlToken);

    const respostaToken = await fetch(`${BASE_URL}${urlToken}`, {
      headers: { client_id: CLIENT_ID, sign: assinaturaToken, t: t1, sign_method: 'HMAC-SHA256' }
    });
    const dadosToken = await respostaToken.json();
    const accessToken = dadosToken.result.access_token;

    // 2. Busca o status bruto do dispositivo em campo
    const t2 = Date.now().toString();
    const urlMedidor = `/v1.0/devices/${DEVICE_ID_MEDIDOR}/status`;
    const assinaturaDispositivo = gerarAssinaturaTuya(CLIENT_ID, CLIENT_SECRET, t2, 'GET', urlMedidor, accessToken);

    const resMedidor = await fetch(`${BASE_URL}${urlMedidor}`, {
      headers: { client_id: CLIENT_ID, access_token: accessToken, sign: assinaturaDispositivo, t: t2, sign_method: 'HMAC-SHA256' }
    });
    
    const dadosBrutosTuya = await resMedidor.json();

    // 3. RETORNA O DIAGNÓSTICO DO EQUIPAMENTO
    return res.status(200).json({
      sucesso_api: dadosBrutosTuya.success,
      mensagem_tuya: dadosBrutosTuya.msg || "OK",
      dados_reais_do_medidor: dadosBrutosTuya.result || []
    });

  } catch (err) {
    return res.status(500).json({ erro: 'Erro no diagnóstico', detalhe: err.message });
  }
};
