const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    try {
        const { data, error } = await supabase
            .from('energy_daily_summary')
            .select('*')
            .order('data', { ascending: true })
            .limit(30);

        if (error) throw error;
        res.status(200).json(data);
    } catch (erro) {
        console.error('Erro na API de Gestão:', erro);
        res.status(500).json({ erro: 'Falha ao buscar dados de gestão energética' });
    }
}
