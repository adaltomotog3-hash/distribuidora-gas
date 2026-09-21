const express = require('express');
const pool = require('../db/pool');
const fiscal = require('../lib/fiscal');

const router = express.Router();

const NOMES_MOVIMENTO = {
  entrada_cheio: 'Entrada de cheios',
  entrada_vazio: 'Entrada de vazios',
  saida_cheio: 'Saída de cheio (venda)',
  saida_vazio: 'Saída de vazios',
  ajuste: 'Correção manual de quantidade'
};

// --- Tela do Estoque: catálogo completo (gás + água), cada produto com seu próprio cheio/vazio ---
router.get('/estoque', async (req, res) => {
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

  const produtosGas = produtosResult.rows.filter((p) => p.tipo === 'gas');
  const produtosAgua = produtosResult.rows.filter((p) => p.tipo === 'agua');

  const empresaResult = await pool.query('SELECT regime_tributario FROM empresa_fiscal WHERE id = 1');
  const regime = empresaResult.rows[0] ? empresaResult.rows[0].regime_tributario : null;

  res.render('estoque', {
    regime,
    usaCsosn: fiscal.usaCsosn(regime),
    produtosGas,
    produtosAgua,
    movimentos: movimentosResult.rows,
    nomesMovimento: NOMES_MOVIMENTO
  });
});

// Link antigo (/estoque-agua) continua funcionando, só manda pra tela única
router.get('/estoque-agua', (req, res) => res.redirect('/estoque'));

// --- Cria um novo produto (tipo/tamanho novo, ex: "P20", "Copo 300ml") ---
router.post('/estoque/produtos', async (req, res) => {
  const { tipo, nome, qtd_cheios, qtd_vazios } = req.body;
  const nomeLimpo = (nome || '').trim();

  if (!['gas', 'agua'].includes(tipo) || !nomeLimpo) {
    req.setFlash('erro', 'Informe o tipo (gás ou água) e o nome do produto.');
    return res.redirect('/estoque');
  }

  const cheios = Math.max(parseInt(qtd_cheios, 10) || 0, 0);
  const vazios = Math.max(parseInt(qtd_vazios, 10) || 0, 0);

  const { rows } = await pool.query(
    `INSERT INTO produtos (tipo, nome, qtd_cheios, qtd_vazios) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tipo, nomeLimpo, cheios, vazios]
  );
  const produtoId = rows[0].id;

  // Já cria os dois preços (com troca / sem troca) zerados — ele ajusta o valor em Preços
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

  req.setFlash('sucesso', 'Produto "' + nomeLimpo + '" criado. Agora é só ajustar o preço em Preços.');
  res.redirect('/estoque');
});

// --- Edita nome/tipo de um produto já existente ---
router.post('/estoque/produtos/:id/editar', async (req, res) => {
  const nomeLimpo = (req.body.nome || '').trim();
  if (!nomeLimpo) {
    req.setFlash('erro', 'Informe um nome válido.');
    return res.redirect('/estoque');
  }
  await pool.query('UPDATE produtos SET nome = $1, atualizado_em = NOW() WHERE id = $2', [nomeLimpo, req.params.id]);
  req.setFlash('sucesso', 'Produto atualizado.');
  res.redirect('/estoque');
});

// --- Dados fiscais do produto (NCM, CFOP, CST/CSOSN etc. — quem define é o contador) ---
router.post('/estoque/produtos/:id/fiscal', async (req, res) => {
  const b = req.body;
  const checagens = [
    fiscal.validarNcm(b.ncm),
    fiscal.validarCfop(b.cfop),
    fiscal.validarCstCsosn(b.cst_csosn),
    fiscal.validarOrigem(b.origem),
    fiscal.validarUnidade(b.unidade_comercial),
    fiscal.validarCest(b.cest)
  ];
  const erro = checagens.find((c) => !c.ok);
  if (erro) {
    req.setFlash('erro', erro.erro);
    return res.redirect('/estoque');
  }
  const [ncm, cfop, cstCsosn, origem, unidade, cest] = checagens.map((c) => c.valor);

  const { rowCount } = await pool.query(
    `UPDATE produtos SET ncm = $1, cfop = $2, cst_csosn = $3, origem = $4, unidade_comercial = $5, cest = $6,
       atualizado_em = NOW()
     WHERE id = $7`,
    [ncm, cfop, cstCsosn, origem, unidade, cest, req.params.id]
  );
  req.setFlash(rowCount ? 'sucesso' : 'erro', rowCount ? 'Dados fiscais do produto salvos.' : 'Produto não encontrado.');
  res.redirect('/estoque');
});

// --- Desativa um produto (some da lista/venda, mas não apaga o histórico) ---
router.post('/estoque/produtos/:id/desativar', async (req, res) => {
  await pool.query('UPDATE produtos SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1', [req.params.id]);
  req.setFlash('sucesso', 'Produto desativado. O histórico dele continua salvo.');
  res.redirect('/estoque');
});

// --- Correção direta da quantidade (pra quando ele errar e digitar o número certo) ---
router.post('/estoque/produtos/:id/corrigir', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  if (!produto) return res.redirect('/estoque');

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

  req.setFlash('sucesso', 'Quantidade de "' + produto.nome + '" corrigida.');
  res.redirect('/estoque');
});

// --- Entrada de cheios (compra do fornecedor) ---
router.post('/estoque/produtos/:id/entrada-cheio', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;

  if (produto && quantidade > 0) {
    await pool.query('UPDATE produtos SET qtd_cheios = qtd_cheios + $1, atualizado_em = NOW() WHERE id = $2', [quantidade, produto.id]);
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['entrada_cheio', quantidade, observacao, produto.tipo, produto.id]
    );
    req.setFlash('sucesso', 'Entrada de cheios registrada em "' + produto.nome + '".');
  } else {
    req.setFlash('erro', 'Informe uma quantidade válida.');
  }
  res.redirect('/estoque');
});

// --- Ajuste manual de vazios: adicionar ---
router.post('/estoque/produtos/:id/entrada-vazio', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;

  if (produto && quantidade > 0) {
    await pool.query('UPDATE produtos SET qtd_vazios = qtd_vazios + $1, atualizado_em = NOW() WHERE id = $2', [quantidade, produto.id]);
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['entrada_vazio', quantidade, observacao, produto.tipo, produto.id]
    );
    req.setFlash('sucesso', 'Vazios adicionados em "' + produto.nome + '".');
  } else {
    req.setFlash('erro', 'Informe uma quantidade válida.');
  }
  res.redirect('/estoque');
});

// --- Ajuste manual de vazios: retirar (ex: devolvidos ao fornecedor) ---
router.post('/estoque/produtos/:id/saida-vazio', async (req, res) => {
  const produtoResult = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
  const produto = produtoResult.rows[0];
  const quantidade = parseInt(req.body.quantidade, 10);
  const observacao = req.body.observacao || null;

  if (produto && quantidade > 0) {
    await pool.query('UPDATE produtos SET qtd_vazios = GREATEST(qtd_vazios - $1, 0), atualizado_em = NOW() WHERE id = $2', [quantidade, produto.id]);
    await pool.query(
      'INSERT INTO movimentos_estoque (tipo, quantidade, observacao, produto, produto_id) VALUES ($1, $2, $3, $4, $5)',
      ['saida_vazio', quantidade, observacao, produto.tipo, produto.id]
    );
    req.setFlash('sucesso', 'Vazios retirados de "' + produto.nome + '".');
  } else {
    req.setFlash('erro', 'Informe uma quantidade válida.');
  }
  res.redirect('/estoque');
});

module.exports = router;
