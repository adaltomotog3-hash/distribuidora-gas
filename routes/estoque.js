const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/estoque', async (req, res) => {
  const estoqueResult = await pool.query('SELECT * FROM estoque WHERE id = 1');
  const movimentosResult = await pool.query(
    'SELECT * FROM movimentos_estoque ORDER BY criado_em DESC LIMIT 50'
  );
  res.render('estoque', {
    estoque: estoqueResult.rows[0],
    movimentos: movimentosResult.rows
  });
});

// Entrada de botijões CHEIOS (compra do fornecedor)
router.post('/estoque/entrada-cheio', async (req, res) => {
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;
  if (quantidade > 0) {
    await pool.query('UPDATE estoque SET qtd_cheios = qtd_cheios + $1, atualizado_em = NOW() WHERE id = 1', [quantidade]);
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao) VALUES ($1, $2, $3)',
      ['entrada_cheio', quantidade, observacao]
    );
  }
  res.redirect('/estoque');
});

// Entrada de botijões VAZIOS (ajuste manual, fora de uma venda)
router.post('/estoque/entrada-vazio', async (req, res) => {
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;
  if (quantidade > 0) {
    await pool.query('UPDATE estoque SET qtd_vazios = qtd_vazios + $1, atualizado_em = NOW() WHERE id = 1', [quantidade]);
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao) VALUES ($1, $2, $3)',
      ['entrada_vazio', quantidade, observacao]
    );
  }
  res.redirect('/estoque');
});

// Saída de vazios (ex: devolvidos ao fornecedor na troca do casco)
router.post('/estoque/saida-vazio', async (req, res) => {
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;
  if (quantidade > 0) {
    await pool.query('UPDATE estoque SET qtd_vazios = GREATEST(qtd_vazios - $1, 0), atualizado_em = NOW() WHERE id = 1', [quantidade]);
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao) VALUES ($1, $2, $3)',
      ['saida_vazio', quantidade, observacao]
    );
  }
  res.redirect('/estoque');
});

module.exports = router;
