const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/financeiro', async (req, res) => {
  const { inicio, fim } = req.query;
  const dataInicio = inicio || new Date().toISOString().slice(0, 10);
  const dataFim = fim || new Date().toISOString().slice(0, 10);

  const totalGeralResult = await pool.query(
    `SELECT COUNT(*)::int AS total_vendas,
       COALESCE(SUM(r.desconto), 0) AS total_descontos,
       COALESCE(SUM(GREATEST(r.valor_bruto - r.desconto, 0)), 0) AS total_valor
     FROM (
       SELECT p.id, p.desconto, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor_bruto
       FROM pedidos p
       JOIN itens_pedido i ON i.pedido_id = p.id
       WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
       GROUP BY p.id
     ) r`,
    [dataInicio, dataFim]
  );

  // Igual ao total geral: primeiro calcula o valor líquido (já com desconto) de
  // cada PEDIDO, e só depois agrupa por forma de pagamento. Se somasse os itens
  // direto (bruto) o card mostraria mais dinheiro do que realmente entrou nele —
  // o desconto já foi dado na forma de pagamento que o cliente realmente usou,
  // não pode aparecer "sobrando" numa forma diferente nem sumir do total.
  const porFormaPagamentoResult = await pool.query(
    `SELECT r.forma_pagamento, COUNT(*)::int AS total_vendas,
       COALESCE(SUM(GREATEST(r.valor_bruto - r.desconto, 0)), 0) AS total_valor
     FROM (
       SELECT p.id, p.forma_pagamento, p.desconto, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor_bruto
       FROM pedidos p
       JOIN itens_pedido i ON i.pedido_id = p.id
       WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
       GROUP BY p.id
     ) r
     GROUP BY r.forma_pagamento
     ORDER BY total_valor DESC`,
    [dataInicio, dataFim]
  );

  const porTipoResult = await pool.query(
    `SELECT i.tipo_venda, COUNT(*)::int AS total_vendas, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS total_valor
     FROM itens_pedido i
     JOIN pedidos p ON p.id = i.pedido_id
     WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
     GROUP BY i.tipo_venda
     ORDER BY total_valor DESC`,
    [dataInicio, dataFim]
  );

  // Separa o que foi vendido de gás e o que foi vendido de água no período
  const porProdutoResult = await pool.query(
    `SELECT i.produto, COUNT(*)::int AS total_vendas, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS total_valor
     FROM itens_pedido i
     JOIN pedidos p ON p.id = i.pedido_id
     WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
     GROUP BY i.produto
     ORDER BY i.produto ASC`,
    [dataInicio, dataFim]
  );

  const pendentesFinanceiroResult = await pool.query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor
     FROM itens_pedido i
     JOIN pedidos p ON p.id = i.pedido_id
     WHERE i.status_troca = 'aguardando_vazio' AND p.status = 'fechado'`
  );

  // Total que entrou em cada dia dentro do período selecionado (o "saldo do dia")
  const porDiaResult = await pool.query(
    `SELECT r.dia,
       COUNT(*)::int AS total_pedidos,
       COALESCE(SUM(GREATEST(r.valor_bruto - r.desconto, 0)), 0) AS valor_total
     FROM (
       SELECT p.id, p.fechado_em::date AS dia, p.desconto,
         COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor_bruto
       FROM pedidos p
       JOIN itens_pedido i ON i.pedido_id = p.id
       WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
       GROUP BY p.id
     ) r
     GROUP BY r.dia
     ORDER BY r.dia DESC`,
    [dataInicio, dataFim]
  );

  res.render('financeiro', {
    dataInicio,
    dataFim,
    totalGeral: totalGeralResult.rows[0],
    porFormaPagamento: porFormaPagamentoResult.rows,
    porTipo: porTipoResult.rows,
    porProduto: porProdutoResult.rows,
    porDia: porDiaResult.rows,
    pendentesFinanceiro: pendentesFinanceiroResult.rows[0]
  });
});

module.exports = router;
