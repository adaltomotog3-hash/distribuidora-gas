const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/apiAuth');
const { requirePainelAuth } = require('../middleware/apiAuthPainel');
const { protegerLogin } = require('../middleware/loginLimiter');
const { notificarNovaEntrega } = require('../lib/pushNotifications');

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

module.exports = router;
