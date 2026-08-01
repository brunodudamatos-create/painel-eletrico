const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ 
                status: "ERRO_CONFIGURACAO",
                mensagem: "As variáveis de ambiente do Supabase (URL ou KEY) não estão configuradas na Vercel.",
                temUrl: !!supabaseUrl,
                temKey: !!supabaseKey
            });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Testando a conexão e busca na tabela 'dados'
        const { data, error } = await supabase
            .from('dados')
            .select('*')
            .limit(5);

        if (error) {
            return res.status(500).json({
                status: "ERRO_SUPABASE",
                mensagem: error.message,
                detalhes: error,
                dica: "Verifique se a tabela 'dados' realmente existe no seu banco Supabase ou se o nome é diferente."
            });
        }

        return res.status(200).json({
            status: "SUCESSO_CONEXAO",
            totalRegistrosEncontrados: data ? data.length : 0,
            amostraDados: data
        });

    } catch (err) {
        return res.status(500).json({
            status: "EXCECAO_CRITICA",
            mensagem: err.message,
            stack: err.stack
        });
    }
}
