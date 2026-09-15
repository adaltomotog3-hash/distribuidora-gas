const express = require('express');
const pool = require('../db/pool');
const { formatarEndereco } = require('../lib/endereco');

const router = express.Router();

function nomeDoPedido(p) {
  return p.cliente_nome || p.nome_avulso || 'Cliente avulso';
}

router.get('/os', async (req, res) => {
  const produtoFiltro = ['gas', 'agua'].includes(req.query.produto) ? req.query.produto : null;
  const filtroProduto = produtoFiltro
    ? `AND EXISTS (SELECT 1 FROM itens_pedido i WHERE i.pedido_id = p.id AND i.produto = $1)`
    : '';
  const params = produtoFiltro ? [produtoFiltro] : [];

  const camposComuns = `
      p.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone, e.nome AS entregador_nome,
      c.endereco, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.referencia,
      c.latitude AS cliente_latitude, c.longitude AS cliente_longitude,
      (SELECT GREATEST(COALESCE(SUM(i.preco_unitario * i.quantidade), 0) - p.desconto, 0) FROM itens_pedido i WHERE i.pedido_id = p.id) AS total_valor,
      (SELECT STRING_AGG(i.quantidade || 'x ' || COALESCE(pd.nome, CASE WHEN i.produto = 'agua' THEN 'Água' ELSE 'Gás' END), ', ' ORDER BY i.id)
         FROM itens_pedido i LEFT JOIN produtos pd ON pd.id = i.produto_id WHERE i.pedido_id = p.id) AS resumo_itens,
      (SELECT COUNT(*)::int FROM itens_pedido i WHERE i.pedido_id = p.id AND i.status_troca = 'aguardando_vazio') AS itens_aguardando_vazio
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN entregadores e ON e.id = p.entregador_id`;

  // As 5 abas (Abertas, Aguardando baixa, Baixadas, Canceladas, Entregadores)
  // são consultas independentes — rodando juntas com Promise.all em vez de
  // uma esperar a outra, a página inteira carrega bem mais rápido.
  const [abertasResult, aguardandoBaixaResult, baixadasResult, canceladasResult, entregadoresResult] = await Promise.all([
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'fechado' AND p.entrega_status = 'pendente' ${filtroProduto}
       ORDER BY p.fechado_em ASC`,
      params
    ),
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'fechado' AND p.entrega_status = 'entregue' AND p.baixado_em IS NULL ${filtroProduto}
       ORDER BY p.entregue_em ASC`,
      params
    ),
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'fechado' AND p.entrega_status = 'entregue' AND p.baixado_em IS NOT NULL ${filtroProduto}
       ORDER BY p.baixado_em DESC
       LIMIT 200`,
      params
    ),
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'cancelado' ${filtroProduto}
       ORDER BY p.cancelado_em DESC
       LIMIT 100`,
      params
    ),
    pool.query(
      `SELECT id, nome FROM entregadores WHERE ativo = TRUE ORDER BY nome ASC`
    )
  ]);

  const preparar = (row) => ({
    ...row,
    endereco_final: row.endereco_entrega || formatarEndereco(row)
  });

  res.render('os', {
    abertas: abertasResult.rows.map(preparar),
    aguardandoBaixa: aguardandoBaixaResult.rows.map(preparar),
    baixadas: baixadasResult.rows.map(preparar),
    canceladas: canceladasResult.rows.map(preparar),
    entregadores: entregadoresResult.rows,
    produtoFiltro,
    nomeDoPedido
  });
});

module.exports = router;
