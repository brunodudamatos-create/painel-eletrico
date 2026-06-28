const { createClient } = require('@supabase/supabase-js');

// A Vercel injeta essas variáveis de forma segura do lado do servidor
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async (req, res) => {
  // Configuração de CORS para permitir a leitura do painel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Busca os últimos 432 registros (12 leituras por hora x 36 horas)
    // Usamos a coluna sequencial 'id' para garantir a ordem exata das últimas inserções
    const { data, error } = await supabase
      .from('telemetria_eletrica')
      .select('*')
      .order('id', { ascending: false })
      .limit(432);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno no servidor de histórico' });
  }
};
