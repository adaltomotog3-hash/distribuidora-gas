const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-esse-segredo-tambem';

// Autenticação da API usada pelo APP do entregador (token, não sessão/cookie).
function requireApiAuth(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Não autenticado. Faça login novamente.' });
  }

  try {
    const dados = jwt.verify(token, JWT_SECRET);
    req.entregador = { id: dados.entregadorId, nome: dados.nome };
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }
}

module.exports = { requireApiAuth, JWT_SECRET };
