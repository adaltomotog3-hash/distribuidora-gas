const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('./apiAuth');

// Autenticação da API usada pelo APP DO PAINEL (usuário do escritório —
// tabela "usuarios"), separada da sessão/cookie do painel web e também
// separada do token do app do entregador (tabela "entregadores"), mesmo
// usando o mesmo segredo (JWT_SECRET) e o mesmo formato de token.
async function requirePainelAuth(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Não autenticado. Faça login novamente.' });
  }

  let dados;
  try {
    dados = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  // "tipo: painel" no token evita que um token do app do entregador seja
  // aceito aqui por engano (os dois usam o mesmo segredo).
  if (dados.tipo !== 'painel' || !dados.usuarioId) {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  const { rows } = await pool.query('SELECT id, username FROM usuarios WHERE id = $1', [dados.usuarioId]);
  const usuario = rows[0];
  if (!usuario) {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  req.usuario = { id: usuario.id, username: usuario.username };
  next();
}

module.exports = { requirePainelAuth };
