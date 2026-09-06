// =============================================================
// api/indices.js  v1.0  —  Índices mensais do painel
// =============================================================
// Endpoint leve que retorna em uma única chamada:
//
//   excedencias_45      — quantas vezes temp >= 45°C no mês
//   faltas_energia      — quantas faltas detectadas no mês
//   primeiro_do_dia     — primeiro registro de hoje (para delta energia/dia)
//   primeiro_do_mes     — primeiro registro do mês (para delta energia/mês)
//
// Usa queries COUNT e LIMIT 1 no Supabase — muito mais eficiente
// do que trazer todos os registros e filtrar no frontend.
//
// FUSO: America/Cuiabá = UTC-4 (sem horário de verão)
// =============================================================

import { createClient } from '@supabase/supabase-js';

const TIMEZONE_OFFSET_H = -4; // Cuiabá é UTC-4 fixo

function inicioDoMesUTC() {
  const agora  = new Date();
  // Ajusta para fuso de Cuiabá
  const local  = new Date(agora.getTime() + TIMEZONE_OFFSET_H * 3600000);
  // Primeiro dia do mês em Cuiabá, meia-noite → volta para UTC
  const inicio = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
  return new Date(inicio.getTime() - TIMEZONE_OFFSET_H * 3600000).toISOString();
}

function inicioDoDiaUTC() {
  const agora  = new Date();
  const local  = new Date(agora.getTime() + TIMEZONE_OFFSET_H * 3600000);
  // Meia-noite de hoje em Cuiabá → volta para UTC
  const inicio = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  return new Date(inicio.getTime() - TIMEZONE_OFFSET_H * 3600000).toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ erro: 'Use GET.' });

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY;

    const supabase = createClient(supabaseUrl, supabaseKey);

    const inicioMes = inicioDoMesUTC();
    const inicioDia = inicioDoDiaUTC();

    // Todas as queries em paralelo para máxima eficiência
    const [
      resExcedencias,
      resFaltas,
      resPrimeiroDia,
      resPrimeiroMes,
    ] = await Promise.all([

      // 1. Quantidade de leituras com temp >= 45°C no mês
      supabase
        .from('telemetria_eletrica')
        .select('id', { count: 'exact', head: true })
        .gte('timestamp', inicioMes)
        .gte('temp_atual', 45),

      // 2. Quantidade de eventos de falta de energia no mês
      supabase
        .from('eventos_sistema')
        .select('id', { count: 'exact', head: true })
        .eq('tipo', 'FALTA_ENERGIA')
        .gte('created_at', inicioMes),

      // 3. Primeiro registro de HOJE (para calcular delta energia do dia por fase)
      supabase
        .from('telemetria_eletrica')
        .select('energia_a, energia_b, energia_c, energia_total, timestamp')
        .gte('timestamp', inicioDia)
        .order('timestamp', { ascending: true })
        .limit(1),

      // 4. Primeiro registro do MÊS (para calcular delta energia do mês por fase)
      supabase
        .from('telemetria_eletrica')
        .select('energia_a, energia_b, energia_c, energia_total, timestamp')
        .gte('timestamp', inicioMes)
        .order('timestamp', { ascending: true })
        .limit(1),
    ]);

    return res.status(200).json({
      excedencias_45:  resExcedencias.count  ?? 0,
      faltas_energia:  resFaltas.count        ?? 0,
      primeiro_do_dia: resPrimeiroDia.data?.[0] ?? null,
      primeiro_do_mes: resPrimeiroMes.data?.[0] ?? null,
      referencias: {
        inicio_mes: inicioMes,
        inicio_dia: inicioDia,
      }
    });

  } catch (err) {
    console.error('Erro /api/indices:', err);
    return res.status(500).json({ erro: 'Erro interno: ' + err.message });
  }
}
