export default async function handler(req, res) {
    // Configuração CORS para o navegador não bloquear
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300'); // Cache de 5 minutos

    // QUANDO COMPRAR OS APARELHOS, A LÓGICA DA TUYA ENTRARÁ AQUI
    // const tuyaData1 = await getTuyaDevice('DEVICE_ID_1');
    // const tuyaData2 = await getTuyaDevice('DEVICE_ID_2');
    // const tuyaData3 = await getTuyaDevice('DEVICE_ID_3');

    // Por enquanto, enviamos dados simulados para a tela funcionar
    const resposta = {
        status: "NORMAL",
        timestamp: new Date().toISOString(),
        camara1: {
            temp: 2.5 + (Math.random() * 2 - 1), // Simula temperatura em torno de 2.5
            setpoint: 2.0,
            umidade: 85,
            refrigerando: true
        },
        camara2: {
            temp: -17.5 + (Math.random() * 2 - 1), // Simula temperatura em torno de -17.5
            setpoint: -18.0,
            umidade: 65,
            refrigerando: false
        },
        camara3: {
            temp: 4.2 + (Math.random() * 2 - 1), // Simula temperatura em torno de 4.2
            setpoint: 4.0,
            umidade: 80,
            refrigerando: true
        }
    };

    res.status(200).json(resposta);
}
