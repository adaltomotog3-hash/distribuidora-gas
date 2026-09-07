const { Pool } = require('pg');

// A DATABASE_URL vem do Render (ou do seu .env local)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

// O banco do Render usa UTC por padrão, enquanto o sistema é usado no
// horário de Brasília. Isso fazia toda data salva (criado_em, fechado_em,
// entregue_em, baixado_em, cancelado_em etc.) ficar registrada com o
// horário UTC, sempre umas 3 horas à frente do horário real.
//
// Aqui a gente força toda conexão nova do pool a usar o fuso horário de
// São Paulo, então NOW() e CURRENT_TIMESTAMP passam a gravar (e mostrar)
// o horário certo, sem precisar mexer em nenhuma outra parte do sistema.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'America/Sao_Paulo'").catch((err) => {
    console.error('Não foi possível ajustar o fuso horário da conexão com o banco:', err);
  });
});

module.exports = pool;
