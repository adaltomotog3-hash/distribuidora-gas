const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/financeiro', async (req, res) => {
  const { inicio, fim } = req.query;
  const dataInicio = inicio || new Date().toISOString().slice(0, 10);
  const dataFim = fim || new Date().toISOString().slice(0, 10);

  const totalGeralResult = await pool.query(
    `SELECT COUNT(*)::int AS total_vendas, COALESCE(SUM(preco), 0) AS total_valor
     FROM vendas
     WHERE criado_em::date BETWEEN $1 AND $2`,
    [dataInicio, dataFim]
  );

  const porFormaPagamentoResult = await pool.query(
    `SELECT forma_pagamento, COUNT(*)::int AS total_vendas, COALESCE(SUM(preco), 0) AS total_valor
     FROM vendas
     WHERE criado_em::date BETWEEN $1 AND $2
     GROUP BY forma_pagamento
     ORDER BY total_valor DESC`,
    [dataInicio, dataFim]
  );

  const porTipoResult = await pool.query(
    `SELECT tipo_venda, COUNT(*)::int AS total_vendas, COALESCE(SUM(preco), 0) AS total_valor
     FROM vendas
     WHERE criado_em::date BETWEEN $1 AND $2
     GROUP BY tipo_venda
     ORDER BY total_valor DESC`,
    [dataInicio, dataFim]
  );

  const pendentesFinanceiroResult = await pool.query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(preco), 0) AS valor
     FROM vendas WHERE status = 'aguardando_vazio'`
  );

  res.render('financeiro', {
    dataInicio,
    dataFim,
    totalGeral: totalGeralResult.rows[0],
    porFormaPagamento: porFormaPagamentoResult.rows,
    porTipo: porTipoResult.rows,
    pendentesFinanceiro: pendentesFinanceiroResult.rows[0]
  });
});

module.exports = router;
