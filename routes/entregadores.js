const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');

const router = express.Router();

router.get('/entregadores', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM entregadores ORDER BY criado_em ASC'
  );
  res.render('entregadores', { entregadores: rows });
});

router.post('/entregadores', async (req, res) => {
  const nome = (req.body.nome || '').trim();
  const username = (req.body.username || '').trim();
  const senha = req.body.senha || '';

  if (!nome || !username || !senha) {
    req.setFlash('erro', 'Preencha nome, usuário e senha do entregador.');
    return res.redirect('/entregadores');
  }

  try {
    const hash = await bcrypt.hash(senha, 10);
    await pool.query(
      'INSERT INTO entregadores (nome, username, senha_hash) VALUES ($1, $2, $3)',
      [nome, username, hash]
    );
    req.setFlash('sucesso', 'Entregador cadastrado.');
  } catch (err) {
    req.setFlash('erro', err.code === '23505'
      ? 'Já existe um entregador com esse usuário.'
      : 'Não foi possível cadastrar o entregador.');
  }
  res.redirect('/entregadores');
});

router.post('/entregadores/:id/redefinir-senha', async (req, res) => {
  const senha = req.body.senha || '';
  if (!senha) {
    req.setFlash('erro', 'Informe a nova senha.');
    return res.redirect('/entregadores');
  }
  const hash = await bcrypt.hash(senha, 10);
  await pool.query('UPDATE entregadores SET senha_hash = $1 WHERE id = $2', [hash, req.params.id]);
  req.setFlash('sucesso', 'Senha redefinida.');
  res.redirect('/entregadores');
});

router.post('/entregadores/:id/alternar-ativo', async (req, res) => {
  await pool.query('UPDATE entregadores SET ativo = NOT ativo WHERE id = $1', [req.params.id]);
  req.setFlash('sucesso', 'Status do entregador atualizado.');
  res.redirect('/entregadores');
});

module.exports = router;
