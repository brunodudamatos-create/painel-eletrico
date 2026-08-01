const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ erro: 'Variáveis de ambiente do Supabase não configuradas na Vercel.' });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data, error } = await supabase
            .from('energy_daily_summary')
            .select('*')
            .order('data', { ascending: true })
            .limit(30);

        if (error) {
            return res.status(500).json({ erro: 'Erro na query: ' + error.message });
        }

        if (!data || data.length === 0) {
            return res.status(200).json([]);
        }

        return res.status(200).json(data);

    } catch (erro) {
        return res.status(500).json({ erro: 'Exceção: ' + erro.message });
    }
}
