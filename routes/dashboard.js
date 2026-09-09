const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  const pendentesResult = await pool.query(`
    SELECT i.id AS item_id, i.produto, i.quantidade, i.preco_unitario, p.id AS pedido_id,
           p.observacao, p.criado_em, c.nome AS cliente_nome
    FROM itens_pedido i
    JOIN pedidos p ON p.id = i.pedido_id
    LEFT JOIN clientes c ON c.id = p.cliente_id
    WHERE i.status_troca = 'aguardando_vazio' AND p.status = 'fechado'
    ORDER BY p.criado_em ASC
  `);

  const estoqueResult = await pool.query(
    `SELECT COALESCE(SUM(qtd_cheios), 0)::int AS qtd_cheios, COALESCE(SUM(qtd_vazios), 0)::int AS qtd_vazios
     FROM produtos WHERE tipo = 'gas' AND ativo = TRUE`
  );
  const estoqueAguaResult = await pool.query(
    `SELECT COALESCE(SUM(qtd_cheios), 0)::int AS qtd_cheios, COALESCE(SUM(qtd_vazios), 0)::int AS qtd_vazios
     FROM produtos WHERE tipo = 'agua' AND ativo = TRUE`
  );

  const resumoHojeResult = await pool.query(`
    SELECT COALESCE(SUM(i.quantidade), 0)::int AS total_vendas, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS total_valor
    FROM pedidos p
    JOIN itens_pedido i ON i.pedido_id = p.id
    WHERE p.status = 'fechado' AND p.fechado_em::date = CURRENT_DATE
  `);

  const osPendentesResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM pedidos WHERE status = 'fechado' AND entrega_status = 'pendente'`
  );

  res.render('dashboard', {
    pendentes: pendentesResult.rows,
    estoque: estoqueResult.rows[0],
    estoqueAgua: estoqueAguaResult.rows[0],
    resumoHoje: resumoHojeResult.rows[0],
    osPendentes: osPendentesResult.rows[0].total
  });
});

module.exports = router;
