const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/apiAuth');
const { requirePainelAuth } = require('../middleware/apiAuthPainel');
const { protegerLogin } = require('../middleware/loginLimiter');
const { notificarNovaEntrega } = require('../lib/pushNotifications');
const { formatarEndereco } = require('../lib/endereco');
const { uploadComprovantes, salvarComprovantes, PASTA_COMPROVANTES } = require('../lib/uploads');

const router = express.Router();

// --- Login do app do painel (usuário do escritório — tabela "usuarios") ---
router.post('/api-painel/login', protegerLogin, async (req, res) => {
  const { username, senha } = req.body;
  if (!username || !senha) {
    return res.status(400).json({ erro: 'Informe usuário e senha.' });
  }

  const { rows } = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
  const usuario = rows[0];

  if (!usuario) {
    req.loginLimiter.falhou();
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }

  const ok = await bcrypt.compare(senha, usuario.senha_hash);
  if (!ok) {
    req.loginLimiter.falhou();
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }

  req.loginLimiter.sucesso();
  const token = jwt.sign(
    { usuarioId: usuario.id, username: usuario.username, tipo: 'painel' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, username: usuario.username, id: usuario.id });
});

// A partir daqui, toda rota exige token válido de usuário do painel
router.use('/api-painel', requirePainelAuth);

// --- Lista as O.S. por aba, igual a página O.S. do painel web (GET /os) ---
router.get('/api-painel/os', async (req, res) => {
  const camposComuns = `
      p.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone, e.nome AS entregador_nome,
      c.endereco, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.referencia,
      (SELECT GREATEST(COALESCE(SUM(i.preco_unitario * i.quantidade), 0) - p.desconto, 0) FROM itens_pedido i WHERE i.pedido_id = p.id) AS total_valor,
      (SELECT STRING_AGG(i.quantidade || 'x ' || COALESCE(pd.nome, CASE WHEN i.produto = 'agua' THEN 'Água' ELSE 'Gás' END), ', ' ORDER BY i.id)
         FROM itens_pedido i LEFT JOIN produtos pd ON pd.id = i.produto_id WHERE i.pedido_id = p.id) AS resumo_itens
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN entregadores e ON e.id = p.entregador_id`;

  const [abertasResult, aguardandoBaixaResult, baixadasResult, entregadoresResult] = await Promise.all([
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'fechado' AND p.entrega_status = 'pendente'
       ORDER BY p.fechado_em ASC`
    ),
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'fechado' AND p.entrega_status = 'entregue' AND p.baixado_em IS NULL
       ORDER BY p.entregue_em ASC`
    ),
    pool.query(
      `SELECT ${camposComuns}
       WHERE p.status = 'fechado' AND p.entrega_status = 'entregue' AND p.baixado_em IS NOT NULL
       ORDER BY p.baixado_em DESC
       LIMIT 50`
    ),
    pool.query(`SELECT id, nome FROM entregadores WHERE ativo = TRUE ORDER BY nome ASC`)
  ]);

  res.json({
    abertas: abertasResult.rows,
    aguardandoBaixa: aguardandoBaixaResult.rows,
    baixadas: baixadasResult.rows,
    entregadores: entregadoresResult.rows
  });
});

// --- Atribui (ou remove) o entregador de uma O.S. ---
router.post('/api-painel/os/:id/atribuir-entregador', async (req, res) => {
  const entregadorId = req.body.entregador_id || null;
  await pool.query(
    `UPDATE pedidos SET entregador_id = $1 WHERE id = $2 AND status = 'fechado'`,
    [entregadorId, req.params.id]
  );

  if (entregadorId) {
    await notificarNovaEntrega(entregadorId, req.params.id);
  }

  res.json({ ok: true });
});

// --- Dá baixa numa O.S. já entregue (confere se o vazio voltou e encerra) ---
router.post('/api-painel/os/:id/dar-baixa', async (req, res) => {
  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'fechado' || pedido.entrega_status !== 'entregue') {
    return res.status(409).json({ erro: 'Essa O.S. ainda não pode receber baixa (precisa estar entregue).' });
  }
  if (pedido.baixado_em) {
    return res.status(409).json({ erro: 'Essa O.S. já tinha recebido baixa.' });
  }

  const vazioRetornou = req.body.vazio_retornou === true;

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
    [req.usuario.username, pedido.id]
  );

  res.json({ ok: true, vazioRetornou });
});

// --- Finaliza a entrega direto pelo app do painel (sem precisar do app do entregador) ---
router.post('/api-painel/os/:id/finalizar', async (req, res) => {
  const { latitude, longitude } = req.body;

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'fechado' || pedido.entrega_status === 'entregue') {
    return res.status(409).json({ erro: 'Essa O.S. não pode ser finalizada.' });
  }

  const lat = latitude ? Number(latitude) : null;
  const lng = longitude ? Number(longitude) : null;

  await pool.query(
    `UPDATE pedidos
     SET entrega_status = 'entregue', entrega_lat = $1, entrega_lng = $2, entregue_em = NOW()
     WHERE id = $3`,
    [lat, lng, pedido.id]
  );

  res.json({ ok: true });
});

// ===================== DASHBOARD =====================

router.get('/api-painel/dashboard', async (req, res) => {
  const [pendentesResult, estoqueResult, estoqueAguaResult, resumoHojeResult, osPendentesResult] = await Promise.all([
    pool.query(`
      SELECT i.id AS item_id, i.produto, i.quantidade, i.preco_unitario, p.id AS pedido_id,
             p.observacao, p.criado_em, c.nome AS cliente_nome
      FROM itens_pedido i
      JOIN pedidos p ON p.id = i.pedido_id
      LEFT JOIN clientes c ON c.id = p.cliente_id
      WHERE i.status_troca = 'aguardando_vazio' AND p.status = 'fechado'
      ORDER BY p.criado_em ASC
    `),
    pool.query(
      `SELECT COALESCE(SUM(qtd_cheios), 0)::int AS qtd_cheios, COALESCE(SUM(qtd_vazios), 0)::int AS qtd_vazios
       FROM produtos WHERE tipo = 'gas' AND ativo = TRUE`
    ),
    pool.query(
      `SELECT COALESCE(SUM(qtd_cheios), 0)::int AS qtd_cheios, COALESCE(SUM(qtd_vazios), 0)::int AS qtd_vazios
       FROM produtos WHERE tipo = 'agua' AND ativo = TRUE`
    ),
    pool.query(`
      SELECT COALESCE(SUM(i.quantidade), 0)::int AS total_vendas, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS total_valor
      FROM pedidos p
      JOIN itens_pedido i ON i.pedido_id = p.id
      WHERE p.status = 'fechado' AND p.fechado_em::date = CURRENT_DATE
    `),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM pedidos WHERE status = 'fechado' AND entrega_status = 'pendente'`
    )
  ]);

  res.json({
    pendentes: pendentesResult.rows,
    estoque: estoqueResult.rows[0],
    estoqueAgua: estoqueAguaResult.rows[0],
    resumoHoje: resumoHojeResult.rows[0],
    osPendentes: osPendentesResult.rows[0].total
  });
});

// ===================== CLIENTES =====================

function camposEnderecoPainel(body) {
  return {
    cep: body.cep || null,
    endereco: body.endereco || null,
    numero: body.numero || null,
    complemento: body.complemento || null,
    bairro: body.bairro || null,
    cidade: body.cidade || null,
    uf: body.uf ? body.uf.toUpperCase() : null,
    referencia: body.referencia || null,
    latitude: body.latitude || null,
    longitude: body.longitude || null
  };
}

router.get('/api-painel/clientes', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clientes ORDER BY nome ASC');
  const clientes = rows.map((c) => ({ ...c, endereco_formatado: formatarEndereco(c) }));
  res.json({ clientes });
});

router.post('/api-painel/clientes', async (req, res) => {
  const nomeLimpo = (req.body.nome || '').trim();
  if (!nomeLimpo) return res.status(400).json({ erro: 'Informe o nome do cliente.' });
  const { telefone, observacao } = req.body;
  const end = camposEnderecoPainel(req.body);
  const { rows } = await pool.query(
    `INSERT INTO clientes (nome, telefone, observacao, cep, endereco, numero, complemento, bairro, cidade, uf, referencia, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [nomeLimpo, telefone || null, observacao || null, end.cep, end.endereco, end.numero, end.complemento, end.bairro, end.cidade, end.uf, end.referencia, end.latitude, end.longitude]
  );
  res.json({ ok: true, id: rows[0].id });
});

router.post('/api-painel/clientes/:id/editar', async (req, res) => {
  const nomeLimpo = (req.body.nome || '').trim();
  if (!nomeLimpo) return res.status(400).json({ erro: 'Informe o nome do cliente.' });
  const { telefone, observacao } = req.body;
  const end = camposEnderecoPainel(req.body);
  await pool.query(
    `UPDATE clientes SET nome=$1, telefone=$2, observacao=$3, cep=$4, endereco=$5, numero=$6, complemento=$7,
       bairro=$8, cidade=$9, uf=$10, referencia=$11, latitude=$12, longitude=$13 WHERE id=$14`,
    [nomeLimpo, telefone || null, observacao || null, end.cep, end.endereco, end.numero, end.complemento, end.bairro, end.cidade, end.uf, end.referencia, end.latitude, end.longitude, req.params.id]
  );
  res.json({ ok: true });
});

router.post('/api-painel/clientes/:id/excluir', async (req, res) => {
  await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ===================== PEDIDOS (carrinho / O.S. novo) =====================

function nomeDoPedidoPainel(p) {
  return p.cliente_nome || p.nome_avulso || 'Cliente avulso';
}

async function buscarItensDoPedidoPainel(pedidoId) {
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

router.get('/api-painel/pedidos', async (req, res) => {
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
  res.json({
    clientes: clientesResult.rows,
    abertos: abertosResult.rows.map((p) => ({ ...p, nome_exibicao: nomeDoPedidoPainel(p) }))
  });
});

router.post('/api-painel/pedidos', async (req, res) => {
  const { cliente_id, nome_avulso } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO pedidos (cliente_id, nome_avulso) VALUES ($1, $2) RETURNING id',
    [cliente_id || null, cliente_id ? null : (nome_avulso || null)]
  );
  res.json({ ok: true, id: rows[0].id });
});

router.get('/api-painel/pedidos/:id', async (req, res) => {
  const [pedidoResult, itens, produtosResult, entregadoresResult] = await Promise.all([
    pool.query(
      `SELECT p.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone, e.nome AS entregador_nome,
         c.endereco, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.referencia,
         c.latitude AS cliente_latitude, c.longitude AS cliente_longitude
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN entregadores e ON e.id = p.entregador_id
       WHERE p.id = $1`,
      [req.params.id]
    ),
    buscarItensDoPedidoPainel(req.params.id),
    pool.query(`SELECT * FROM produtos WHERE ativo = TRUE ORDER BY tipo ASC, nome ASC`),
    pool.query(`SELECT id, nome FROM entregadores WHERE ativo = TRUE ORDER BY nome ASC`)
  ]);

  const pedido = pedidoResult.rows[0];
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  pedido.cliente_endereco = formatarEndereco(pedido);
  pedido.nome_exibicao = nomeDoPedidoPainel(pedido);

  const total = itens.reduce((soma, i) => soma + Number(i.preco_unitario) * i.quantidade, 0);
  const desconto = Number(pedido.desconto) || 0;
  const totalComDesconto = Math.max(total - desconto, 0);

  res.json({
    pedido,
    itens,
    produtos: produtosResult.rows,
    entregadores: entregadoresResult.rows,
    total,
    desconto,
    totalComDesconto
  });
});

router.post('/api-painel/pedidos/:id/itens', async (req, res) => {
  const { produto_id, tipo_venda, quantidade } = req.body;
  const qtd = Math.max(parseInt(quantidade, 10) || 1, 1);

  const pedidoResult = await pool.query('SELECT status FROM pedidos WHERE id = $1', [req.params.id]);
  if (!pedidoResult.rows[0] || pedidoResult.rows[0].status !== 'aberto') {
    return res.status(409).json({ erro: 'Esse carrinho não está mais aberto.' });
  }

  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [produto_id]);
  const produto = produtoResult.rows[0];
  if (!produto) return res.status(400).json({ erro: 'Selecione um produto válido.' });

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

  res.json({ ok: true });
});

router.post('/api-painel/pedidos/:id/itens/:itemId/remover', async (req, res) => {
  await pool.query(
    `DELETE FROM itens_pedido WHERE id = $1 AND pedido_id = $2
     AND pedido_id IN (SELECT id FROM pedidos WHERE status = 'aberto')`,
    [req.params.itemId, req.params.id]
  );
  res.json({ ok: true });
});

router.post('/api-painel/pedidos/:id/desconto', async (req, res) => {
  const desconto = Math.max(parseFloat(String(req.body.desconto || '0').replace(',', '.')) || 0, 0);
  await pool.query('UPDATE pedidos SET desconto = $1 WHERE id = $2', [desconto, req.params.id]);
  res.json({ ok: true });
});

router.post('/api-painel/pedidos/:id/cancelar', async (req, res) => {
  const motivo = (req.body.motivo || '').trim() || null;
  const { rowCount } = await pool.query(
    `UPDATE pedidos SET status = 'cancelado', cancelado_em = NOW(), motivo_cancelamento = $1
     WHERE id = $2 AND status = 'aberto'`,
    [motivo, req.params.id]
  );
  if (rowCount === 0) return res.status(409).json({ erro: 'Esse carrinho não pôde ser cancelado.' });
  res.json({ ok: true });
});

router.post('/api-painel/pedidos/:id/excluir-carrinho', async (req, res) => {
  await pool.query(`DELETE FROM pedidos WHERE id = $1 AND status = 'aberto'`, [req.params.id]);
  res.json({ ok: true });
});

router.post('/api-painel/pedidos/:id/fechar', async (req, res) => {
  const { forma_pagamento, observacao, endereco_entrega, desconto, entregador_id } = req.body;

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];
  if (!pedido || pedido.status !== 'aberto') {
    return res.status(409).json({ erro: 'Esse pedido não pôde ser fechado.' });
  }

  const itens = await buscarItensDoPedidoPainel(pedido.id);
  if (itens.length === 0) {
    return res.status(400).json({ erro: 'Adicione ao menos um item antes de fechar o pedido.' });
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

  if (entregador_id) {
    await notificarNovaEntrega(entregador_id, pedido.id);
  }

  res.json({ ok: true, id: pedido.id });
});

// ===================== ESTOQUE =====================

const NOMES_MOVIMENTO_PAINEL = {
  entrada_cheio: 'Entrada de cheios',
  entrada_vazio: 'Entrada de vazios',
  saida_cheio: 'Saída de cheio (venda)',
  saida_vazio: 'Saída de vazios',
  ajuste: 'Correção manual de quantidade'
};

router.get('/api-painel/estoque', async (req, res) => {
  const produtosResult = await pool.query(
    `SELECT * FROM produtos WHERE ativo = TRUE ORDER BY tipo ASC, nome ASC`
  );
  const movimentosResult = await pool.query(`
    SELECT m.*, p.nome AS produto_nome, p.tipo AS produto_tipo
    FROM movimentos_estoque m
    LEFT JOIN produtos p ON p.id = m.produto_id
    ORDER BY m.criado_em DESC
    LIMIT 50
  `);

  res.json({
    produtosGas: produtosResult.rows.filter((p) => p.tipo === 'gas'),
    produtosAgua: produtosResult.rows.filter((p) => p.tipo === 'agua'),
    movimentos: movimentosResult.rows,
    nomesMovimento: NOMES_MOVIMENTO_PAINEL
  });
});

router.post('/api-painel/estoque/produtos', async (req, res) => {
  const { tipo, nome, qtd_cheios, qtd_vazios } = req.body;
  const nomeLimpo = (nome || '').trim();

  if (!['gas', 'agua'].includes(tipo) || !nomeLimpo) {
    return res.status(400).json({ erro: 'Informe o tipo (gás ou água) e o nome do produto.' });
  }

  const cheios = Math.max(parseInt(qtd_cheios, 10) || 0, 0);
  const vazios = Math.max(parseInt(qtd_vazios, 10) || 0, 0);

  const { rows } = await pool.query(
    `INSERT INTO produtos (tipo, nome, qtd_cheios, qtd_vazios) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tipo, nomeLimpo, cheios, vazios]
  );
  const produtoId = rows[0].id;

  await pool.query(
    `INSERT INTO precos (produto, produto_id, tipo_venda, descricao, preco) VALUES
       ($1, $2, 'troca', 'Troca (cliente entrega o vazio)', 0),
       ($1, $2, 'sem_troca', 'Sem troca (casco/vasilhame novo)', 0)`,
    [tipo, produtoId]
  );

  if (cheios > 0) {
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['entrada_cheio', cheios, 'Estoque inicial do produto novo', tipo, produtoId]
    );
  }

  res.json({ ok: true, id: produtoId });
});

router.post('/api-painel/estoque/produtos/:id/editar', async (req, res) => {
  const nomeLimpo = (req.body.nome || '').trim();
  if (!nomeLimpo) return res.status(400).json({ erro: 'Informe um nome válido.' });
  await pool.query('UPDATE produtos SET nome = $1, atualizado_em = NOW() WHERE id = $2', [nomeLimpo, req.params.id]);
  res.json({ ok: true });
});

router.post('/api-painel/estoque/produtos/:id/desativar', async (req, res) => {
  await pool.query('UPDATE produtos SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/api-painel/estoque/produtos/:id/corrigir', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  if (!produto) return res.status(404).json({ erro: 'Produto não encontrado.' });

  const temCheios = req.body.qtd_cheios !== undefined && req.body.qtd_cheios !== '';
  const temVazios = req.body.qtd_vazios !== undefined && req.body.qtd_vazios !== '';

  const novoCheios = temCheios ? Math.max(parseInt(req.body.qtd_cheios, 10) || 0, 0) : produto.qtd_cheios;
  const novoVazios = temVazios ? Math.max(parseInt(req.body.qtd_vazios, 10) || 0, 0) : produto.qtd_vazios;

  await pool.query(
    'UPDATE produtos SET qtd_cheios = $1, qtd_vazios = $2, atualizado_em = NOW() WHERE id = $3',
    [novoCheios, novoVazios, produto.id]
  );

  const diffCheios = novoCheios - produto.qtd_cheios;
  const diffVazios = novoVazios - produto.qtd_vazios;
  if (diffCheios !== 0) {
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['ajuste', diffCheios, 'Correção manual — cheios: ' + produto.qtd_cheios + ' → ' + novoCheios, produto.tipo, produto.id]
    );
  }
  if (diffVazios !== 0) {
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['ajuste', diffVazios, 'Correção manual — vazios: ' + produto.qtd_vazios + ' → ' + novoVazios, produto.tipo, produto.id]
    );
  }

  res.json({ ok: true });
});

router.post('/api-painel/estoque/produtos/:id/entrada-cheio', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;

  if (!produto || !(quantidade > 0)) return res.status(400).json({ erro: 'Informe uma quantidade válida.' });

  await pool.query('UPDATE produtos SET qtd_cheios = qtd_cheios + $1, atualizado_em = NOW() WHERE id = $2', [quantidade, produto.id]);
  await pool.query(
    'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
    ['entrada_cheio', quantidade, observacao, produto.tipo, produto.id]
  );
  res.json({ ok: true });
});

router.post('/api-painel/estoque/produtos/:id/entrada-vazio', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;

  if (!produto || !(quantidade > 0)) return res.status(400).json({ erro: 'Informe uma quantidade válida.' });

  await pool.query('UPDATE produtos SET qtd_vazios = qtd_vazios + $1, atualizado_em = NOW() WHERE id = $2', [quantidade, produto.id]);
  await pool.query(
    'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
    ['entrada_vazio', quantidade, observacao, produto.tipo, produto.id]
  );
  res.json({ ok: true });
});

router.post('/api-painel/estoque/produtos/:id/saida-vazio', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;

  if (!produto || !(quantidade > 0)) return res.status(400).json({ erro: 'Informe uma quantidade válida.' });

  await pool.query('UPDATE produtos SET qtd_vazios = GREATEST(qtd_vazios - $1, 0), atualizado_em = NOW() WHERE id = $2', [quantidade, produto.id]);
  await pool.query(
    'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
    ['saida_vazio', quantidade, observacao, produto.tipo, produto.id]
  );
  res.json({ ok: true });
});

// ===================== PREÇOS =====================

router.get('/api-painel/precos', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pr.*, pd.nome AS produto_nome, pd.tipo AS produto_tipo
    FROM precos pr
    JOIN produtos pd ON pd.id = pr.produto_id
    WHERE pd.ativo = TRUE
    ORDER BY pd.tipo ASC, pd.nome ASC, pr.tipo_venda ASC
  `);

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

  res.json({
    gruposGas: porProduto.filter((g) => g.tipo === 'gas'),
    gruposAgua: porProduto.filter((g) => g.tipo === 'agua')
  });
});

router.post('/api-painel/precos/:produtoId/:tipoVenda', async (req, res) => {
  const preco = Math.max(parseFloat(String(req.body.preco || '0').replace(',', '.')) || 0, 0);
  await pool.query(
    'UPDATE precos SET preco = $1, atualizado_em = NOW() WHERE produto_id = $2 AND tipo_venda = $3',
    [preco, req.params.produtoId, req.params.tipoVenda]
  );
  res.json({ ok: true });
});

// ===================== FINANCEIRO =====================

router.get('/api-painel/financeiro', async (req, res) => {
  const { inicio, fim } = req.query;
  const dataInicio = inicio || new Date().toISOString().slice(0, 10);
  const dataFim = fim || new Date().toISOString().slice(0, 10);

  const [
    totalGeralResult,
    porFormaPagamentoResult,
    porTipoResult,
    porProdutoResult,
    pendentesFinanceiroResult,
    porDiaResult,
    valoresAReceberResult,
    despesasPorFormaResult
  ] = await Promise.all([
    pool.query(
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
    ),
    pool.query(
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
    ),
    pool.query(
      `SELECT i.tipo_venda, COUNT(*)::int AS total_vendas, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS total_valor
       FROM itens_pedido i
       JOIN pedidos p ON p.id = i.pedido_id
       WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
       GROUP BY i.tipo_venda
       ORDER BY total_valor DESC`,
      [dataInicio, dataFim]
    ),
    pool.query(
      `SELECT i.produto, COUNT(*)::int AS total_vendas, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS total_valor
       FROM itens_pedido i
       JOIN pedidos p ON p.id = i.pedido_id
       WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
       GROUP BY i.produto
       ORDER BY i.produto ASC`,
      [dataInicio, dataFim]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor
       FROM itens_pedido i
       JOIN pedidos p ON p.id = i.pedido_id
       WHERE i.status_troca = 'aguardando_vazio' AND p.status = 'fechado'`
    ),
    pool.query(
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
    ),
    pool.query(
      `SELECT p.id, p.fechado_em,
         COALESCE(c.nome, p.nome_avulso, 'Cliente avulso') AS cliente_nome,
         GREATEST(COALESCE(SUM(i.preco_unitario * i.quantidade), 0) - p.desconto, 0) AS valor
       FROM pedidos p
       JOIN itens_pedido i ON i.pedido_id = p.id
       LEFT JOIN clientes c ON c.id = p.cliente_id
       WHERE p.status = 'fechado' AND p.forma_pagamento = 'fiado' AND p.fiado_pago_em IS NULL
       GROUP BY p.id, p.fechado_em, c.nome, p.nome_avulso, p.desconto
       ORDER BY p.fechado_em ASC`
    ),
    pool.query(
      `SELECT forma_pagamento, COUNT(*)::int AS total_despesas, COALESCE(SUM(valor), 0) AS total_valor
       FROM despesas
       WHERE criado_em::date BETWEEN $1 AND $2
       GROUP BY forma_pagamento`,
      [dataInicio, dataFim]
    )
  ]);

  const totalAReceber = valoresAReceberResult.rows.reduce((soma, r) => soma + Number(r.valor), 0);

  const mapaDespesasPorForma = {};
  despesasPorFormaResult.rows.forEach(function (d) { mapaDespesasPorForma[d.forma_pagamento] = d; });
  const totalDespesas = despesasPorFormaResult.rows.reduce((soma, d) => soma + Number(d.total_valor), 0);
  const saldoLiquido = Number(totalGeralResult.rows[0].total_valor) - totalDespesas;

  res.json({
    dataInicio,
    dataFim,
    totalGeral: totalGeralResult.rows[0],
    porFormaPagamento: porFormaPagamentoResult.rows,
    porTipo: porTipoResult.rows,
    porProduto: porProdutoResult.rows,
    porDia: porDiaResult.rows,
    pendentesFinanceiro: pendentesFinanceiroResult.rows[0],
    valoresAReceber: valoresAReceberResult.rows,
    totalAReceber,
    mapaDespesasPorForma,
    totalDespesas,
    saldoLiquido
  });
});

router.post('/api-painel/pedidos/:id/marcar-fiado-pago', async (req, res) => {
  const formaRecebimento = req.body.forma_pagamento_recebimento;
  if (!['dinheiro', 'pix', 'cartao'].includes(formaRecebimento)) {
    return res.status(400).json({ erro: 'Selecione como o cliente pagou (dinheiro, Pix ou cartão).' });
  }
  const { rowCount } = await pool.query(
    `UPDATE pedidos SET fiado_pago_em = NOW(), forma_pagamento_recebimento = $1
     WHERE id = $2 AND forma_pagamento = 'fiado' AND status = 'fechado' AND fiado_pago_em IS NULL`,
    [formaRecebimento, req.params.id]
  );
  if (rowCount === 0) return res.status(409).json({ erro: 'Não foi possível registrar esse pagamento.' });
  res.json({ ok: true });
});

// ===================== DESPESAS =====================

const FORMAS_VALIDAS_PAINEL = ['dinheiro', 'pix', 'cartao'];

// Recebe os arquivos de comprovante (campo "comprovantes", até 5) antes da
// rota principal — mesma regra do painel web, só que aqui responde em JSON
// em vez de redirecionar quando dá erro (tipo inválido, arquivo grande
// demais, mais de 5 arquivos).
function receberComprovantesApi(req, res, next) {
  uploadComprovantes.array('comprovantes', 5)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ erro: err.message || 'Não foi possível enviar o(s) comprovante(s).' });
    }
    next();
  });
}

router.get('/api-painel/despesas', async (req, res) => {
  const { inicio, fim } = req.query;
  const dataInicio = inicio || new Date().toISOString().slice(0, 10);
  const dataFim = fim || new Date().toISOString().slice(0, 10);

  const { rows: despesas } = await pool.query(
    `SELECT * FROM despesas
     WHERE criado_em::date BETWEEN $1 AND $2
     ORDER BY criado_em DESC`,
    [dataInicio, dataFim]
  );

  // Junta os comprovantes de cada despesa do período, igual ao painel web,
  // pra o app poder mostrar quantos anexos cada despesa tem.
  const idsDespesas = despesas.map((d) => d.id);
  let comprovantesPorDespesa = {};
  if (idsDespesas.length > 0) {
    const { rows: comprovantes } = await pool.query(
      `SELECT * FROM despesas_comprovantes WHERE despesa_id = ANY($1::int[]) ORDER BY id ASC`,
      [idsDespesas]
    );
    comprovantesPorDespesa = comprovantes.reduce((acc, c) => {
      (acc[c.despesa_id] = acc[c.despesa_id] || []).push(c);
      return acc;
    }, {});
  }
  despesas.forEach((d) => {
    d.comprovantes = comprovantesPorDespesa[d.id] || [];
  });

  const totalPeriodo = despesas.reduce((soma, d) => soma + Number(d.valor), 0);

  res.json({ despesas, dataInicio, dataFim, totalPeriodo });
});

router.post('/api-painel/despesas', receberComprovantesApi, async (req, res) => {
  const descricaoLimpa = (req.body.descricao || '').trim();
  const valor = Math.max(parseFloat(String(req.body.valor || '0').replace(',', '.')) || 0, 0);
  const formaPagamento = req.body.forma_pagamento;
  const destino = (req.body.destino || '').trim();
  const motivo = (req.body.motivo || '').trim();

  if (!descricaoLimpa) return res.status(400).json({ erro: 'Informe a descrição da despesa.' });
  if (!valor) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });
  if (!FORMAS_VALIDAS_PAINEL.includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Selecione de onde saiu o dinheiro (Dinheiro, Pix ou Cartão).' });
  }

  const { rows } = await pool.query(
    `INSERT INTO despesas (descricao, valor, forma_pagamento, destino, motivo, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [descricaoLimpa, valor, formaPagamento, destino || null, motivo || null, req.usuario.username]
  );
  const despesaId = rows[0].id;

  // Só grava os arquivos em disco (comprimindo as imagens) depois que a
  // despesa já existe no banco — mesma regra do painel web, evita arquivo
  // "órfão" no servidor por causa de um erro de validação anterior.
  const comprovantesSalvos = await salvarComprovantes(req.files);
  for (const c of comprovantesSalvos) {
    await pool.query(
      `INSERT INTO despesas_comprovantes (despesa_id, nome_original, nome_arquivo, tipo_mime, tamanho_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [despesaId, c.nome_original, c.nome_arquivo, c.tipo_mime, c.tamanho_bytes]
    );
  }

  res.json({ ok: true, id: despesaId, comprovantesAnexados: comprovantesSalvos.length });
});

// Recebe UM único arquivo (campo "comprovante", sem "s") — usado pelo app
// do painel, que envia cada foto num upload separado via
// FileSystem.uploadAsync (mais confiável no celular do que montar um
// FormData com Blob na mão, que se mostrou instável nessa versão do RN).
function receberUmComprovanteApi(req, res, next) {
  // >>> DIAGNÓSTICO TEMPORÁRIO <<<
  console.log('[DIAG comprovante] pedido chegou na rota, content-type:', req.headers['content-type']);
  uploadComprovantes.single('comprovante')(req, res, (err) => {
    if (err) {
      console.log('[DIAG comprovante] multer deu erro:', err.message);
      return res.status(400).json({ erro: err.message || 'Não foi possível enviar o comprovante.' });
    }
    console.log('[DIAG comprovante] multer processou sem erro, req.file:', req.file ? (req.file.originalname + ' / ' + req.file.size + ' bytes') : 'VAZIO (nenhum arquivo)');
    next();
  });
}

// --- Anexa uma foto de comprovante numa despesa que já existe ---
router.post('/api-painel/despesas/:id/comprovantes', receberUmComprovanteApi, async (req, res) => {
  console.log('[DIAG comprovante] entrou no handler da rota, despesaId:', req.params.id);
  const despesaResult = await pool.query('SELECT id FROM despesas WHERE id = $1', [req.params.id]);
  if (!despesaResult.rows[0]) {
    console.log('[DIAG comprovante] despesa não encontrada!');
    return res.status(404).json({ erro: 'Despesa não encontrada.' });
  }
  if (!req.file) {
    console.log('[DIAG comprovante] req.file vazio, respondendo 400.');
    return res.status(400).json({ erro: 'Nenhum arquivo recebido.' });
  }

  const [comprovanteSalvo] = await salvarComprovantes([req.file]);
  const { rows } = await pool.query(
    `INSERT INTO despesas_comprovantes (despesa_id, nome_original, nome_arquivo, tipo_mime, tamanho_bytes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [req.params.id, comprovanteSalvo.nome_original, comprovanteSalvo.nome_arquivo, comprovanteSalvo.tipo_mime, comprovanteSalvo.tamanho_bytes]
  );
  console.log('[DIAG comprovante] salvo com sucesso, id:', rows[0].id, 'arquivo:', comprovanteSalvo.nome_arquivo);

  res.json({ ok: true, id: rows[0].id });
});

// --- Abre um comprovante específico (imagem ou PDF) pra visualizar no app ---
router.get('/api-painel/despesas/comprovantes/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM despesas_comprovantes WHERE id = $1', [req.params.id]);
  const comprovante = rows[0];

  if (!comprovante) {
    return res.status(404).json({ erro: 'Esse comprovante não existe ou já foi removido.' });
  }

  const caminho = path.join(PASTA_COMPROVANTES, comprovante.nome_arquivo);
  res.setHeader('Content-Type', comprovante.tipo_mime || 'application/octet-stream');
  res.sendFile(caminho, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ erro: 'O arquivo desse comprovante não foi encontrado no servidor.' });
    }
  });
});

// --- Remove só um comprovante (mantém a despesa) ---
router.post('/api-painel/despesas/comprovantes/:id/excluir', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM despesas_comprovantes WHERE id = $1', [req.params.id]);
  const comprovante = rows[0];

  if (comprovante) {
    await pool.query('DELETE FROM despesas_comprovantes WHERE id = $1', [comprovante.id]);
    fs.unlink(path.join(PASTA_COMPROVANTES, comprovante.nome_arquivo), () => {});
  }

  res.json({ ok: true });
});

router.post('/api-painel/despesas/:id/excluir', async (req, res) => {
  // Antes de excluir a despesa, pega os comprovantes dela pra também apagar
  // os arquivos do disco (o ON DELETE CASCADE só apaga o registro no banco,
  // não o arquivo em si).
  const { rows: comprovantes } = await pool.query(
    'SELECT nome_arquivo FROM despesas_comprovantes WHERE despesa_id = $1',
    [req.params.id]
  );

  await pool.query('DELETE FROM despesas WHERE id = $1', [req.params.id]);

  comprovantes.forEach((c) => {
    fs.unlink(path.join(PASTA_COMPROVANTES, c.nome_arquivo), () => {});
  });

  res.json({ ok: true });
});

// ===================== ENTREGADORES =====================

router.get('/api-painel/entregadores', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, username, ativo, criado_em FROM entregadores ORDER BY criado_em ASC'
  );
  res.json({ entregadores: rows });
});

router.post('/api-painel/entregadores', async (req, res) => {
  const nome = (req.body.nome || '').trim();
  const username = (req.body.username || '').trim();
  const senha = req.body.senha || '';

  if (!nome || !username || !senha) {
    return res.status(400).json({ erro: 'Preencha nome, usuário e senha do entregador.' });
  }

  try {
    const hash = await bcrypt.hash(senha, 10);
    const { rows } = await pool.query(
      'INSERT INTO entregadores (nome, username, senha_hash) VALUES ($1, $2, $3) RETURNING id',
      [nome, username, hash]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 500).json({
      erro: err.code === '23505' ? 'Já existe um entregador com esse usuário.' : 'Não foi possível cadastrar o entregador.'
    });
  }
});

router.post('/api-painel/entregadores/:id/redefinir-senha', async (req, res) => {
  const senha = req.body.senha || '';
  if (!senha) return res.status(400).json({ erro: 'Informe a nova senha.' });
  const hash = await bcrypt.hash(senha, 10);
  await pool.query('UPDATE entregadores SET senha_hash = $1 WHERE id = $2', [hash, req.params.id]);
  res.json({ ok: true });
});

router.post('/api-painel/entregadores/:id/alternar-ativo', async (req, res) => {
  await pool.query('UPDATE entregadores SET ativo = NOT ativo WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ===================== RASTREIO =====================

router.get('/api-painel/rastreio', async (req, res) => {
  const [entregadoresResult, entregasPendentesResult] = await Promise.all([
    pool.query(
      'SELECT id, nome, ativo, ultima_lat, ultima_lng, ultima_localizacao_em FROM entregadores ORDER BY nome ASC'
    ),
    pool.query(`
      SELECT p.id, p.entrega_lat, p.entrega_lng, p.fechado_em, c.nome AS cliente_nome, e.nome AS entregador_nome,
        c.endereco, c.numero, c.bairro, c.cidade
      FROM pedidos p
      LEFT JOIN clientes c ON c.id = p.cliente_id
      LEFT JOIN entregadores e ON e.id = p.entregador_id
      WHERE p.status = 'fechado' AND p.entrega_status = 'pendente'
      ORDER BY p.fechado_em ASC
    `)
  ]);

  res.json({
    entregadores: entregadoresResult.rows,
    entregasPendentes: entregasPendentesResult.rows
  });
});

module.exports = router;
