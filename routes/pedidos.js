const express = require('express');
const pool = require('../db/pool');
const { formatarEndereco } = require('../lib/endereco');

const router = express.Router();

// Estorna no estoque o que tinha sido baixado quando o pedido foi fechado
// (cheios voltam sempre; vazios só voltam se aquele item já tinha sido
// confirmado como devolvido — senão nunca chegou a entrar no estoque).
async function estornarEstoqueDoPedido(pedido, itens) {
  for (const item of itens) {
    if (item.produto_id) {
      await pool.query(
        `UPDATE produtos SET qtd_cheios = qtd_cheios + $1, atualizado_em = NOW() WHERE id = $2`,
        [item.quantidade, item.produto_id]
      );
    }
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['entrada_cheio', item.quantidade, 'Estorno — cancelamento do pedido #' + pedido.id, item.produto, item.produto_id]
    );

    if (item.tipo_venda === 'troca' && item.status_troca === 'concluida') {
      if (item.produto_id) {
        await pool.query(
          `UPDATE produtos SET qtd_vazios = GREATEST(qtd_vazios - $1, 0), atualizado_em = NOW() WHERE id = $2`,
          [item.quantidade, item.produto_id]
        );
      }
      await pool.query(
        'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
        ['saida_vazio', item.quantidade, 'Estorno do vazio — cancelamento do pedido #' + pedido.id, item.produto, item.produto_id]
      );
    }
  }
}

async function buscarItensDoPedido(pedidoId) {
  const { rows } = await pool.query(
    `SELECT i.*, pd.nome AS produto_nome
     FROM itens_pedido i
     LEFT JOIN produtos pd ON pd.id = i.produto_id
     WHERE i.pedido_id = $1
     ORDER BY i.id ASC`,
    [pedidoId]
  );
  return rows;
}

function nomeDoPedido(p) {
  return p.cliente_nome || p.nome_avulso || 'Cliente avulso';
}

// --- Lista: novo pedido e carrinhos em aberto (histórico de O.S. fica na aba O.S.) ---
router.get('/pedidos', async (req, res) => {
  const clientesResult = await pool.query('SELECT id, nome FROM clientes ORDER BY nome ASC');

  const abertosResult = await pool.query(`
    SELECT p.*, c.nome AS cliente_nome,
      (SELECT COUNT(*)::int FROM itens_pedido i WHERE i.pedido_id = p.id) AS total_itens,
      (SELECT COALESCE(SUM(i.preco_unitario * i.quantidade), 0) FROM itens_pedido i WHERE i.pedido_id = p.id) AS total_valor
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    WHERE p.status = 'aberto'
    ORDER BY p.criado_em DESC
  `);

  res.render('pedidos', {
    clientes: clientesResult.rows,
    abertos: abertosResult.rows,
    nomeDoPedido
  });
});

// --- Cria um novo carrinho (pedido em aberto) ---
router.post('/pedidos', async (req, res) => {
  const { cliente_id, nome_avulso } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO pedidos (cliente_id, nome_avulso) VALUES ($1, $2) RETURNING id',
    [cliente_id || null, cliente_id ? null : (nome_avulso || null)]
  );
  req.setFlash('sucesso', 'Carrinho aberto.');
  res.redirect('/pedidos/' + rows[0].id);
});

// --- Tela de um carrinho específico ---
router.get('/pedidos/:id', async (req, res) => {
  const pedidoResult = await pool.query(
    `SELECT p.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone, e.nome AS entregador_nome,
       c.endereco, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.referencia,
       c.latitude AS cliente_latitude, c.longitude AS cliente_longitude
     FROM pedidos p
     LEFT JOIN clientes c ON c.id = p.cliente_id
     LEFT JOIN entregadores e ON e.id = p.entregador_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  const pedido = pedidoResult.rows[0];
  if (!pedido) return res.redirect('/pedidos');

  pedido.cliente_endereco = formatarEndereco(pedido);

  const itens = await buscarItensDoPedido(pedido.id);
  const produtosResult = await pool.query(
    `SELECT * FROM produtos WHERE ativo = TRUE ORDER BY tipo ASC, nome ASC`
  );
  const entregadoresResult = await pool.query(
    `SELECT id, nome FROM entregadores WHERE ativo = TRUE ORDER BY nome ASC`
  );

  const total = itens.reduce((soma, i) => soma + Number(i.preco_unitario) * i.quantidade, 0);
  const desconto = Number(pedido.desconto) || 0;
  const totalComDesconto = Math.max(total - desconto, 0);

  res.render('pedido-carrinho', {
    pedido,
    itens,
    produtos: produtosResult.rows,
    entregadores: entregadoresResult.rows,
    total,
    desconto,
    totalComDesconto,
    nomeDoPedido
  });
});

// --- Adiciona um item ao carrinho ---
router.post('/pedidos/:id/itens', async (req, res) => {
  const { produto_id, tipo_venda, quantidade } = req.body;
  const qtd = Math.max(parseInt(quantidade, 10) || 1, 1);

  const pedidoResult = await pool.query('SELECT status FROM pedidos WHERE id = $1', [req.params.id]);
  if (!pedidoResult.rows[0] || pedidoResult.rows[0].status !== 'aberto') {
    return res.redirect('/pedidos');
  }

  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [produto_id]);
  const produto = produtoResult.rows[0];
  if (!produto) {
    req.setFlash('erro', 'Selecione um produto válido.');
    return res.redirect('/pedidos/' + req.params.id);
  }

  const precoResult = await pool.query(
    'SELECT preco FROM precos WHERE produto_id = $1 AND tipo_venda = $2',
    [produto.id, tipo_venda]
  );
  const preco = precoResult.rows[0] ? precoResult.rows[0].preco : 0;
  const statusTroca = tipo_venda === 'troca' ? 'aguardando_vazio' : 'concluida';

  await pool.query(
    `INSERT INTO itens_pedido (pedido_id, produto, produto_id, tipo_venda, quantidade, preco_unitario, status_troca)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.params.id, produto.tipo, produto.id, tipo_venda, qtd, preco, statusTroca]
  );

  req.setFlash('sucesso', 'Item encaminhado pro carrinho.');
  res.redirect('/pedidos/' + req.params.id);
});

// --- Aplica/edita o desconto do pedido (funciona com o carrinho aberto ou já fechado) ---
router.post('/pedidos/:id/desconto', async (req, res) => {
  const desconto = Math.max(parseFloat((req.body.desconto || '0').replace(',', '.')) || 0, 0);
  await pool.query('UPDATE pedidos SET desconto = $1 WHERE id = $2', [desconto, req.params.id]);
  req.setFlash('sucesso', desconto > 0 ? 'Desconto de R$ ' + desconto.toFixed(2) + ' aplicado.' : 'Desconto removido.');
  res.redirect('/pedidos/' + req.params.id);
});

// --- Remove um item do carrinho (só enquanto o pedido está aberto) ---
router.post('/pedidos/:id/itens/:itemId/remover', async (req, res) => {
  await pool.query(
    `DELETE FROM itens_pedido WHERE id = $1 AND pedido_id = $2
     AND pedido_id IN (SELECT id FROM pedidos WHERE status = 'aberto')`,
    [req.params.itemId, req.params.id]
  );
  req.setFlash('sucesso', 'Item removido do carrinho.');
  res.redirect('/pedidos/' + req.params.id);
});

// --- Cancela um carrinho aberto (antes de fechar) — mantém o registro, aparece ---
// em O.S. > Canceladas, de onde pode ser excluído em definitivo depois se quiser.
router.post('/pedidos/:id/cancelar', async (req, res) => {
  const voltarPara = req.get('Referrer') || '/pedidos';
  const motivo = (req.body.motivo || '').trim() || null;

  const { rowCount } = await pool.query(
    `UPDATE pedidos SET status = 'cancelado', cancelado_em = NOW(), motivo_cancelamento = $1
     WHERE id = $2 AND status = 'aberto'`,
    [motivo, req.params.id]
  );

  req.setFlash(
    rowCount > 0 ? 'sucesso' : 'erro',
    rowCount > 0 ? 'Carrinho cancelado.' : 'Esse carrinho não pôde ser cancelado.'
  );
  res.redirect(voltarPara.includes('/pedidos/') ? '/pedidos' : voltarPara);
});

// --- Exclui um carrinho aberto direto da lista, sem deixar histórico ---
// (pra carrinho de teste/engano — se quiser manter um registro do cancelamento,
// use "Cancelar" em vez disso).
router.post('/pedidos/:id/excluir-carrinho', async (req, res) => {
  await pool.query(`DELETE FROM pedidos WHERE id = $1 AND status = 'aberto'`, [req.params.id]);
  req.setFlash('sucesso', 'Carrinho excluído.');
  res.redirect('/pedidos');
});

// --- Cancela uma O.S. já fechada (erro de digitação, cliente desistiu etc.) ---
// Estorna automaticamente o que tinha sido baixado do estoque no fechamento.
router.post('/pedidos/:id/cancelar-os', async (req, res) => {
  const voltarPara = req.get('Referrer') || '/os';

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'fechado') {
    req.setFlash('erro', 'Essa O.S. não pode ser cancelada.');
    return res.redirect(voltarPara);
  }
  if (pedido.baixado_em) {
    req.setFlash('erro', 'Essa O.S. já foi baixada e não pode mais ser cancelada.');
    return res.redirect(voltarPara);
  }

  const itens = await buscarItensDoPedido(pedido.id);
  await estornarEstoqueDoPedido(pedido, itens);

  const motivo = (req.body.motivo || '').trim() || null;
  await pool.query(
    `UPDATE pedidos SET status = 'cancelado', cancelado_em = NOW(), motivo_cancelamento = $1 WHERE id = $2`,
    [motivo, pedido.id]
  );

  req.setFlash('sucesso', 'O.S. #' + pedido.id + ' cancelada — o estoque foi estornado automaticamente.');
  res.redirect(voltarPara.includes('/pedidos/') ? '/os' : voltarPara);
});

// --- Atribui (ou troca) o entregador responsável por uma O.S. já fechada ---
// Funciona em qualquer etapa (pendente, aguardando baixa ou já baixada), pra
// dar pra corrigir se atribuiu errado. Enquanto não tiver entregador
// atribuído, a O.S. aparece pro app de todos os entregadores; depois de
// atribuída, só aparece pra ele.
router.post('/pedidos/:id/atribuir-entregador', async (req, res) => {
  const entregadorId = req.body.entregador_id || null;
  await pool.query(
    `UPDATE pedidos SET entregador_id = $1
     WHERE id = $2 AND status = 'fechado'`,
    [entregadorId, req.params.id]
  );
  req.setFlash('sucesso', entregadorId ? 'Entregador atribuído a essa O.S.' : 'Entregador removido — a O.S. volta a aparecer pra todos.');
  res.redirect(req.get('Referrer') || '/os');
});

// --- Exclui permanentemente uma O.S. já cancelada (limpa o histórico) ---
// Só funciona pra O.S. cancelada, porque nela o estoque já foi estornado —
// não tem risco de sumir com movimentação que ainda não foi desfeita.
router.post('/pedidos/:id/excluir', async (req, res) => {
  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'cancelado') {
    req.setFlash('erro', 'Só é possível excluir uma O.S. que já foi cancelada. Cancele antes de excluir.');
    return res.redirect(req.get('Referrer') || '/os');
  }

  await pool.query('DELETE FROM pedidos WHERE id = $1', [pedido.id]);

  req.setFlash('sucesso', 'O.S. Nº ' + pedido.id + ' excluída permanentemente.');
  res.redirect('/os');
});

// --- Dá baixa numa O.S. já entregue: a loja confere se o vazio voltou e encerra ---
router.post('/pedidos/:id/dar-baixa', async (req, res) => {
  const voltarPara = req.get('Referrer') || '/os';

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'fechado' || pedido.entrega_status !== 'entregue') {
    req.setFlash('erro', 'Essa O.S. ainda não pode receber baixa (precisa estar entregue).');
    return res.redirect(voltarPara);
  }
  if (pedido.baixado_em) {
    req.setFlash('erro', 'Essa O.S. já tinha recebido baixa.');
    return res.redirect(voltarPara);
  }

  const vazioRetornou = req.body.vazio_retornou === '1' || req.body.vazio_retornou === 'on';

  if (vazioRetornou) {
    const pendentesResult = await pool.query(
      `SELECT * FROM itens_pedido WHERE pedido_id = $1 AND status_troca = 'aguardando_vazio'`,
      [pedido.id]
    );
    for (const item of pendentesResult.rows) {
      await pool.query(`UPDATE itens_pedido SET status_troca = 'concluida' WHERE id = $1`, [item.id]);
      if (item.produto_id) {
        await pool.query(
          `UPDATE produtos SET qtd_vazios = qtd_vazios + $1, atualizado_em = NOW() WHERE id = $2`,
          [item.quantidade, item.produto_id]
        );
      }
      await pool.query(
        'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
        ['entrada_vazio', item.quantidade, 'Retorno do vazio confirmado na baixa do pedido #' + pedido.id, item.produto, item.produto_id]
      );
    }
  }

  await pool.query(
    `UPDATE pedidos SET baixado_em = NOW(), baixado_por = $1 WHERE id = $2`,
    [req.session.username || null, pedido.id]
  );

  req.setFlash('sucesso', 'Baixa da O.S. #' + pedido.id + ' registrada.' + (vazioRetornou ? ' Retorno do(s) vazio(s) confirmado.' : ' Vazio ainda não retornou — segue pendente.'));
  res.redirect(voltarPara);
});

// --- Fecha o pedido: vira O.S. e já desconta do estoque ---
router.post('/pedidos/:id/fechar', async (req, res) => {
  const { forma_pagamento, observacao, endereco_entrega, desconto, entregador_id } = req.body;

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];
  if (!pedido || pedido.status !== 'aberto') return res.redirect('/pedidos');

  const itens = await buscarItensDoPedido(pedido.id);
  if (itens.length === 0) {
    req.setFlash('erro', 'Adicione ao menos um item antes de fechar o pedido.');
    return res.redirect('/pedidos/' + pedido.id);
  }

  const descontoValor = desconto !== undefined
    ? Math.max(parseFloat(String(desconto).replace(',', '.')) || 0, 0)
    : pedido.desconto;

  await pool.query(
    `UPDATE pedidos
     SET forma_pagamento = $1, observacao = $2, endereco_entrega = $3, desconto = $4,
         entregador_id = $5, status = 'fechado', fechado_em = NOW()
     WHERE id = $6`,
    [forma_pagamento || null, observacao || null, endereco_entrega || null, descontoValor, entregador_id || null, pedido.id]
  );

  for (const item of itens) {
    if (item.produto_id) {
      await pool.query(
        `UPDATE produtos SET qtd_cheios = GREATEST(qtd_cheios - $1, 0), atualizado_em = NOW() WHERE id = $2`,
        [item.quantidade, item.produto_id]
      );
    }
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['saida_cheio', item.quantidade, 'Pedido #' + pedido.id, item.produto, item.produto_id]
    );
  }

  req.setFlash('sucesso', 'Pedido fechado — O.S. #' + pedido.id + ' gerada e enviada pro entregador.');
  res.redirect('/pedidos');
});

// --- Finaliza a entrega direto pelo painel (sem precisar do app do entregador) ---
router.post('/pedidos/:id/finalizar', async (req, res) => {
  const { latitude, longitude } = req.body;

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'fechado' || pedido.entrega_status === 'entregue') {
    req.setFlash('erro', 'Essa O.S. não pode ser finalizada.');
    return res.redirect(req.get('Referrer') || '/os');
  }

  const lat = latitude ? Number(latitude) : null;
  const lng = longitude ? Number(longitude) : null;

  await pool.query(
    `UPDATE pedidos
     SET entrega_status = 'entregue', entrega_lat = $1, entrega_lng = $2, entregue_em = NOW()
     WHERE id = $3`,
    [lat, lng, pedido.id]
  );

  req.setFlash('sucesso', 'Entrega finalizada' + (lat && lng ? ' — localização salva.' : ' (sem localização — o navegador não permitiu pegar o GPS).'));
  res.redirect(req.get('Referrer') && req.get('Referrer').includes('/pedidos/') ? '/pedidos/' + pedido.id : '/os');
});

// --- Marca uma venda fiado como paga (o cliente quitou o valor devido) ---
// Pede a forma de pagamento real (como o dinheiro efetivamente entrou), já que
// "fiado" era só um jeito de dizer "ainda não recebi" — agora que recebeu,
// precisa saber se foi em dinheiro, Pix ou cartão.
router.post('/pedidos/:id/marcar-fiado-pago', async (req, res) => {
  const voltarPara = req.get('Referrer') || '/financeiro';
  const formaRecebimento = req.body.forma_pagamento_recebimento;

  if (!['dinheiro', 'pix', 'cartao'].includes(formaRecebimento)) {
    req.setFlash('erro', 'Selecione como o cliente pagou (dinheiro, Pix ou cartão).');
    return res.redirect(voltarPara);
  }

  const { rowCount } = await pool.query(
    `UPDATE pedidos SET fiado_pago_em = NOW(), forma_pagamento_recebimento = $1
     WHERE id = $2 AND forma_pagamento = 'fiado' AND status = 'fechado' AND fiado_pago_em IS NULL`,
    [formaRecebimento, req.params.id]
  );
  req.setFlash(
    rowCount > 0 ? 'sucesso' : 'erro',
    rowCount > 0 ? 'Pagamento registrado — saiu de "Valores a receber".' : 'Não foi possível registrar esse pagamento.'
  );
  res.redirect(voltarPara);
});

// --- Confirma que o vazio de um item específico voltou ---
router.post('/pedidos/:id/itens/:itemId/confirmar-vazio', async (req, res) => {
  const itemResult = await pool.query(
    'SELECT * FROM itens_pedido WHERE id = $1 AND pedido_id = $2',
    [req.params.itemId, req.params.id]
  );
  const item = itemResult.rows[0];
  if (item && item.status_troca === 'aguardando_vazio') {
    await pool.query(`UPDATE itens_pedido SET status_troca = 'concluida' WHERE id = $1`, [item.id]);

    if (item.produto_id) {
      await pool.query(
        `UPDATE produtos SET qtd_vazios = qtd_vazios + $1, atualizado_em = NOW() WHERE id = $2`,
        [item.quantidade, item.produto_id]
      );
    }
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['entrada_vazio', item.quantidade, 'Retorno do vazio do pedido #' + req.params.id, item.produto, item.produto_id]
    );
    req.setFlash('sucesso', 'Retorno do vazio confirmado.');
  }
  res.redirect(req.get('Referrer') || '/pedidos');
});

module.exports = router;
