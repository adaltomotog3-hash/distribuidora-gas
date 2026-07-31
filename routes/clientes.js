const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/clientes', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clientes ORDER BY nome ASC');
  res.render('clientes', { clientes: rows });
});

router.post('/clientes', async (req, res) => {
  const { nome, telefone, endereco, observacao } = req.body;
  await pool.query(
    'INSERT INTO clientes (nome, telefone, endereco, observacao) VALUES ($1, $2, $3, $4)',
    [nome, telefone || null, endereco || null, observacao || null]
  );
  res.redirect('/clientes');
});

router.post('/clientes/:id/editar', async (req, res) => {
  const { nome, telefone, endereco, observacao } = req.body;
  await pool.query(
    'UPDATE clientes SET nome = $1, telefone = $2, endereco = $3, observacao = $4 WHERE id = $5',
    [nome, telefone || null, endereco || null, observacao || null, req.params.id]
  );
  res.redirect('/clientes');
});

router.post('/clientes/:id/excluir', async (req, res) => {
  await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
  res.redirect('/clientes');
});

module.exports = router;
