const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.usuarioId) return res.redirect('/');
  res.render('login', { erro: null });
});

router.post('/login', async (req, res) => {
  const { username, senha } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE username = $1',
      [username]
    );
    const usuario = rows[0];
    if (!usuario) {
      return res.render('login', { erro: 'Usuário ou senha inválidos.' });
    }
    const ok = await bcrypt.compare(senha, usuario.senha_hash);
    if (!ok) {
      return res.render('login', { erro: 'Usuário ou senha inválidos.' });
    }
    req.session.usuarioId = usuario.id;
    req.session.username = usuario.username;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { erro: 'Erro ao tentar entrar. Tente novamente.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
