const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/precos', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pr.*, pd.nome AS produto_nome, pd.tipo AS produto_tipo
    FROM precos pr
    JOIN produtos pd ON pd.id = pr.produto_id
    WHERE pd.ativo = TRUE
    ORDER BY pd.tipo ASC, pd.nome ASC, pr.tipo_venda ASC
  `);

  // Agrupa os preços por produto, na ordem que já veio do banco
  const porProduto = [];
  const indicePorProdutoId = {};
  for (const linha of rows) {
    if (indicePorProdutoId[linha.produto_id] === undefined) {
      indicePorProdutoId[linha.produto_id] = porProduto.length;
      porProduto.push({
        produto_id: linha.produto_id,
        nome: linha.produto_nome,
        tipo: linha.produto_tipo,
        precos: []
      });
    }
    porProduto[indicePorProdutoId[linha.produto_id]].precos.push(linha);
  }

  const gruposGas = porProduto.filter((g) => g.tipo === 'gas');
  const gruposAgua = porProduto.filter((g) => g.tipo === 'agua');

  res.render('precos', { gruposGas, gruposAgua });
});

router.post('/precos/:produtoId/:tipo_venda', async (req, res) => {
  const preco = Math.max(parseFloat(String(req.body.preco || '0').replace(',', '.')) || 0, 0);
  const { produtoId, tipo_venda } = req.params;
  await pool.query(
    'UPDATE precos SET preco = $1, atualizado_em = NOW() WHERE produto_id = $2 AND tipo_venda = $3',
    [preco, produtoId, tipo_venda]
  );
  req.setFlash('sucesso', 'Preço atualizado.');
  res.redirect('/precos');
});

module.exports = router;
