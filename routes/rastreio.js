const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/rastreio', async (req, res) => {
  const entregadoresResult = await pool.query(
    'SELECT id, nome, ativo, ultima_lat, ultima_lng, ultima_localizacao_em FROM entregadores ORDER BY nome ASC'
  );
  res.render('rastreio', { entregadores: entregadoresResult.rows });
});

// Usado pelo mapa pra se atualizar sozinho (sessão do painel, não é a API do app)
router.get('/rastreio/dados', async (req, res) => {
  // Essa rota é chamada de novo sozinha o tempo todo (o mapa se atualiza
  // automaticamente) — entregadores, pedidos de hoje e a trilha de hoje são
  // independentes entre si, então rodam junto em vez de em fila.
  const [entregadoresResult, pedidosResult, trilhaHojeResult] = await Promise.all([
    pool.query(
      'SELECT id, nome, ativo, ultima_lat, ultima_lng, ultima_localizacao_em FROM entregadores ORDER BY nome ASC'
    ),
    pool.query(`
      SELECT p.id, p.entrega_lat, p.entrega_lng, p.entregue_em, c.nome AS cliente_nome, e.nome AS entregador_nome
      FROM pedidos p
      LEFT JOIN clientes c ON c.id = p.cliente_id
      LEFT JOIN entregadores e ON e.id = p.entregador_id
      WHERE p.status = 'fechado' AND p.entrega_status = 'entregue' AND p.entregue_em::date = CURRENT_DATE
        AND p.entrega_lat IS NOT NULL AND p.entrega_lng IS NOT NULL
      ORDER BY p.entregue_em DESC
    `),
    pool.query(`
      SELECT entregador_id, latitude, longitude, criado_em
      FROM localizacoes_entregador
      WHERE criado_em::date = CURRENT_DATE
      ORDER BY criado_em ASC
      LIMIT 500
    `)
  ]);

  const pedidoIds = pedidosResult.rows.map((p) => p.id);
  let produtosPorPedido = {};
  if (pedidoIds.length > 0) {
    const produtosResult = await pool.query(
      `SELECT DISTINCT pedido_id, produto FROM itens_pedido WHERE pedido_id = ANY($1::int[])`,
      [pedidoIds]
    );
    produtosPorPedido = produtosResult.rows.reduce((acc, row) => {
      (acc[row.pedido_id] = acc[row.pedido_id] || []).push(row.produto);
      return acc;
    }, {});
  }

  const entregasHoje = pedidosResult.rows.map((p) => {
    const produtos = produtosPorPedido[p.id] || [];
    const produto = produtos.length === 1 ? produtos[0] : 'misto';
    return { ...p, produto };
  });

  res.json({
    entregadores: entregadoresResult.rows,
    entregasHoje,
    trilhaHoje: trilhaHojeResult.rows
  });
});

module.exports = router;
