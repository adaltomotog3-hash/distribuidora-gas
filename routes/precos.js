const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/precos', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM precos ORDER BY tipo_venda ASC');
  res.render('precos', { precos: rows });
});

router.post('/precos/:tipo_venda', async (req, res) => {
  const { preco } = req.body;
  await pool.query(
    'UPDATE precos SET preco = $1, atualizado_em = NOW() WHERE tipo_venda = $2',
    [preco, req.params.tipo_venda]
  );
  res.redirect('/precos');
});

module.exports = router;
