const { Pool } = require('pg');

// A DATABASE_URL vem do Render (ou do seu .env local)
//
// O banco do Render usa UTC por padrão, enquanto o sistema é usado no
// horário de Brasília. Isso fazia toda data salva (criado_em, fechado_em,
// entregue_em, baixado_em, cancelado_em etc.) ficar registrada com o
// horário UTC, sempre umas 3 horas à frente do horário real.
//
// O fuso é passado aqui em "options" (parâmetro de conexão do Postgres),
// que já chega definido no aperto de mão inicial de CADA conexão nova do
// pool — antes de qualquer query rodar nela. Antes isso era feito com um
// client.query("SET TIME ZONE ...") separado, mas como ele não era
// aguardado antes da conexão ser liberada pro resto do sistema, corria o
// risco de uma query "furar a fila" e rodar antes do fuso ser ajustado
// (motivo do aviso "Calling client.query() when the client is already
// executing a query" que aparecia no log) — com esse jeito isso não acontece.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
  options: '-c TimeZone=America/Sao_Paulo'
});

module.exports = pool;
