const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const FORMAS_VALIDAS = ['dinheiro', 'pix', 'cartao'];

router.get('/despesas', async (req, res) => {
  const { inicio, fim } = req.query;
  const dataInicio = inicio || new Date().toISOString().slice(0, 10);
  const dataFim = fim || new Date().toISOString().slice(0, 10);

  const { rows: despesas } = await pool.query(
    `SELECT * FROM despesas
     WHERE criado_em::date BETWEEN $1 AND $2
     ORDER BY criado_em DESC`,
    [dataInicio, dataFim]
  );
  const totalPeriodo = despesas.reduce((soma, d) => soma + Number(d.valor), 0);

  res.render('despesas', { despesas, dataInicio, dataFim, totalPeriodo });
});

router.post('/despesas', async (req, res) => {
  const descricaoLimpa = (req.body.descricao || '').trim();
  const valor = Math.max(parseFloat(String(req.body.valor || '0').replace(',', '.')) || 0, 0);
  const formaPagamento = req.body.forma_pagamento;
  const destino = (req.body.destino || '').trim();
  const motivo = (req.body.motivo || '').trim();

  if (!descricaoLimpa) {
    req.setFlash('erro', 'Informe a descrição da despesa.');
    return res.redirect('/despesas');
  }
  if (!valor) {
    req.setFlash('erro', 'Informe um valor maior que zero.');
    return res.redirect('/despesas');
  }
  if (!FORMAS_VALIDAS.includes(formaPagamento)) {
    req.setFlash('erro', 'Selecione de onde saiu o dinheiro (Dinheiro, Pix ou Cartão).');
    return res.redirect('/despesas');
  }

  await pool.query(
    `INSERT INTO despesas (descricao, valor, forma_pagamento, destino, motivo, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [descricaoLimpa, valor, formaPagamento, destino || null, motivo || null, req.session.username || null]
  );
  req.setFlash('sucesso', 'Despesa registrada.');
  res.redirect('/despesas');
});

router.post('/despesas/:id/excluir', async (req, res) => {
  await pool.query('DELETE FROM despesas WHERE id = $1', [req.params.id]);
  req.setFlash('sucesso', 'Despesa excluída.');
  res.redirect('/despesas');
});

module.exports = router;
