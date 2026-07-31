const bcrypt = require('bcrypt');
const pool = require('./pool');

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT,
      endereco TEXT,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS precos (
      id SERIAL PRIMARY KEY,
      tipo_venda TEXT UNIQUE NOT NULL, -- 'troca' ou 'sem_troca'
      descricao TEXT NOT NULL,
      preco NUMERIC(10,2) NOT NULL,
      atualizado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS estoque (
      id INT PRIMARY KEY DEFAULT 1,
      qtd_cheios INT NOT NULL DEFAULT 0,
      qtd_vazios INT NOT NULL DEFAULT 0,
      atualizado_em TIMESTAMP DEFAULT NOW(),
      CONSTRAINT unica_linha CHECK (id = 1)
    );

    CREATE TABLE IF NOT EXISTS movimentos_estoque (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL, -- 'entrada_cheio', 'entrada_vazio', 'saida_cheio', 'ajuste'
      quantidade INT NOT NULL,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
      tipo_venda TEXT NOT NULL, -- 'troca' ou 'sem_troca'
      forma_pagamento TEXT NOT NULL, -- 'dinheiro', 'pix', 'cartao', 'fiado'
      preco NUMERIC(10,2) NOT NULL,
      observacao TEXT,
      status TEXT NOT NULL DEFAULT 'concluida', -- 'aguardando_vazio' ou 'concluida'
      criado_em TIMESTAMP DEFAULT NOW(),
      concluido_em TIMESTAMP
    );
  `);

  // Garante que existe a linha unica de estoque
  await pool.query(`
    INSERT INTO estoque (id, qtd_cheios, qtd_vazios)
    VALUES (1, 0, 0)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Garante que existem os dois tipos de preco
  await pool.query(`
    INSERT INTO precos (tipo_venda, descricao, preco) VALUES
      ('troca', 'Troca de botijao (cliente entrega o vazio)', 0),
      ('sem_troca', 'Botijao sem troca (casco novo)', 0)
    ON CONFLICT (tipo_venda) DO NOTHING;
  `);

  // Cria o usuario admin padrao se ainda nao existir nenhum usuario
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
  if (rows[0].total === 0) {
    const senhaPadrao = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(senhaPadrao, 10);
    await pool.query(
      'INSERT INTO usuarios (username, senha_hash) VALUES ($1, $2)',
      ['admin', hash]
    );
    console.log('>> Usuario padrao criado: admin / ' + senhaPadrao);
  }

  console.log('>> Banco de dados pronto.');
}

module.exports = initDb;
