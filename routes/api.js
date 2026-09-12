const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireApiAuth, JWT_SECRET } = require('../middleware/apiAuth');
const { protegerLogin } = require('../middleware/loginLimiter');
const { formatarEndereco } = require('../lib/endereco');

const router = express.Router();

// --- Login do entregador (usado pelo app) ---
router.post('/api/login', protegerLogin, async (req, res) => {
  const { username, senha } = req.body;
  if (!username || !senha) {
    return res.status(400).json({ erro: 'Informe usuário e senha.' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM entregadores WHERE username = $1',
    [username]
  );
  const entregador = rows[0];

  if (!entregador || !entregador.ativo) {
    req.loginLimiter.falhou();
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }

  const ok = await bcrypt.compare(senha, entregador.senha_hash);
  if (!ok) {
    req.loginLimiter.falhou();
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }

  req.loginLimiter.sucesso();
  // "criadoEm" vai junto no token pra identificar esse entregador específico,
  // não só o número do ID — se o ID for reaproveitado depois (entregador
  // excluído e outro criado no lugar), o "criado_em" muda e esse token antigo
  // deixa de valer pro entregador novo. Ver checagem em middleware/apiAuth.js.
  const token = jwt.sign(
    { entregadorId: entregador.id, nome: entregador.nome, criadoEm: entregador.criado_em.toISOString() },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, nome: entregador.nome, id: entregador.id });
});

// A partir daqui, toda rota exige token válido no cabeçalho Authorization
router.use('/api', requireApiAuth);

// --- Lista as O.S. (pedidos fechados) pendentes de entrega, com os itens de cada uma ---
// Só entram aqui as O.S. sem entregador definido (aparecem pra todo mundo) ou
// as que foram atribuídas especificamente a este entregador.
router.get('/api/entregas', async (req, res) => {
  const pedidosResult = await pool.query(`
    SELECT p.id, p.forma_pagamento, p.observacao, p.criado_em, p.fechado_em, p.endereco_entrega,
           c.nome AS cliente_nome, c.telefone AS cliente_telefone,
           c.endereco, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.referencia
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    WHERE p.status = 'fechado' AND p.entrega_status = 'pendente'
      AND (p.entregador_id IS NULL OR p.entregador_id = $1)
    ORDER BY p.fechado_em ASC
  `, [req.entregador.id]);

  const pedidoIds = pedidosResult.rows.map((p) => p.id);
  let itensPorPedido = {};
  if (pedidoIds.length > 0) {
    const itensResult = await pool.query(
      `SELECT * FROM itens_pedido WHERE pedido_id = ANY($1::int[]) ORDER BY id ASC`,
      [pedidoIds]
    );
    itensPorPedido = itensResult.rows.reduce((acc, item) => {
      (acc[item.pedido_id] = acc[item.pedido_id] || []).push(item);
      return acc;
    }, {});
  }

  const entregas = pedidosResult.rows.map((p) => {
    const itens = itensPorPedido[p.id] || [];
    const total = itens.reduce((soma, i) => soma + Number(i.preco_unitario) * i.quantidade, 0);
    const cliente_endereco = p.endereco_entrega || formatarEndereco(p);
    return { ...p, cliente_endereco, itens, total };
  });

  res.json({ entregas });
});

// --- Finaliza uma O.S. (pedido): marca como entregue e salva a localização do celular ---
router.post('/api/entregas/:id/finalizar', async (req, res) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ erro: 'Localização (latitude/longitude) é obrigatória.' });
  }

  const pedidoResult = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  const pedido = pedidoResult.rows[0];

  if (!pedido || pedido.status !== 'fechado') {
    return res.status(404).json({ erro: 'Entrega não encontrada.' });
  }
  if (pedido.entrega_status === 'entregue') {
    return res.status(409).json({ erro: 'Essa O.S. já foi finalizada.' });
  }

  const { rows } = await pool.query(
    `UPDATE pedidos
     SET entrega_status = 'entregue',
         entregador_id = $1,
         entrega_lat = $2,
         entrega_lng = $3,
         entregue_em = NOW()
     WHERE id = $4
     RETURNING *`,
    [req.entregador.id, latitude, longitude, req.params.id]
  );

  // Também guarda esse ponto no histórico de localizações do entregador
  await pool.query(
    'INSERT INTO localizacoes_entregador (entregador_id, latitude, longitude) VALUES ($1, $2, $3)',
    [req.entregador.id, latitude, longitude]
  );
  await pool.query(
    'UPDATE entregadores SET ultima_lat = $1, ultima_lng = $2, ultima_localizacao_em = NOW() WHERE id = $3',
    [latitude, longitude, req.entregador.id]
  );

  res.json({ ok: true, entrega: rows[0] });
});

// --- Ping de localização em tempo real (enviado periodicamente pelo app) ---
router.post('/api/localizacao', async (req, res) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ erro: 'Localização (latitude/longitude) é obrigatória.' });
  }

  await pool.query(
    'INSERT INTO localizacoes_entregador (entregador_id, latitude, longitude) VALUES ($1, $2, $3)',
    [req.entregador.id, latitude, longitude]
  );
  await pool.query(
    'UPDATE entregadores SET ultima_lat = $1, ultima_lng = $2, ultima_localizacao_em = NOW() WHERE id = $3',
    [latitude, longitude, req.entregador.id]
  );

  res.json({ ok: true });
});

module.exports = router;
