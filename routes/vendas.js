const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/vendas', async (req, res) => {
  const clientesResult = await pool.query('SELECT id, nome FROM clientes ORDER BY nome ASC');
  const precosResult = await pool.query('SELECT * FROM precos');
  const vendasResult = await pool.query(`
    SELECT v.*, c.nome AS cliente_nome
    FROM vendas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    ORDER BY v.criado_em DESC
    LIMIT 100
  `);
  res.render('vendas', {
    clientes: clientesResult.rows,
    precos: precosResult.rows,
    vendas: vendasResult.rows
  });
});

router.post('/vendas', async (req, res) => {
  const { cliente_id, tipo_venda, forma_pagamento, observacao } = req.body;

  const precoResult = await pool.query('SELECT preco FROM precos WHERE tipo_venda = $1', [tipo_venda]);
  const preco = precoResult.rows[0] ? precoResult.rows[0].preco : 0;

  const status = tipo_venda === 'troca' ? 'aguardando_vazio' : 'concluida';
  const concluidoEm = tipo_venda === 'troca' ? null : new Date();

  await pool.query(
    `INSERT INTO vendas (cliente_id, tipo_venda, forma_pagamento, preco, observacao, status, concluido_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [cliente_id || null, tipo_venda, forma_pagamento, preco, observacao || null, status, concluidoEm]
  );

  // Sai um botijão cheio do estoque em toda venda
  await pool.query('UPDATE estoque SET qtd_cheios = GREATEST(qtd_cheios - 1, 0), atualizado_em = NOW() WHERE id = 1');
  await pool.query(
    'INSERT INTO movimentos_estoque (tipo, quantidade, observacao) VALUES ($1, 1, $2)',
    ['saida_cheio', observacao || null]
  );

  res.redirect('/vendas');
});

// Confirma que o botijão vazio voltou (entregador retornou com o vazio)
router.post('/vendas/:id/confirmar-vazio', async (req, res) => {
  const venda = await pool.query('SELECT * FROM vendas WHERE id = $1', [req.params.id]);
  if (venda.rows[0] && venda.rows[0].status === 'aguardando_vazio') {
    await pool.query(
      `UPDATE vendas SET status = 'concluida', concluido_em = NOW() WHERE id = $1`,
      [req.params.id]
    );
    await pool.query('UPDATE estoque SET qtd_vazios = qtd_vazios + 1, atualizado_em = NOW() WHERE id = 1');
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao) VALUES ($1, 1, $2)',
      ['entrada_vazio', 'Retorno do vazio referente à venda #' + req.params.id]
    );
  }
  res.redirect(req.get('Referrer') || '/vendas');
});

module.exports = router;
