const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-esse-segredo-tambem';

// Autenticação da API usada pelo APP do entregador (token, não sessão/cookie).
async function requireApiAuth(req, res, next) {
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

  // Confirma que o entregador do token ainda existe e está ativo. O token
  // fica válido por 30 dias, então sem essa checagem um app que ficou logado
  // continuaria "autenticado" mesmo depois do entregador ser desativado, ou
  // pior: se o ID dele fosse reaproveitado por outro entregador criado depois
  // (ex: scripts/limpar-para-producao.sql reinicia os IDs), o token antigo
  // passaria a autenticar como se fosse essa outra pessoa. Também comparamos
  // "criado_em" (gravado no token no login) com o do banco: se não bater, é
  // porque o ID foi reaproveitado, então trata como sessão inválida também.
  const { rows } = await pool.query(
    'SELECT id, nome, criado_em FROM entregadores WHERE id = $1 AND ativo = TRUE',
    [dados.entregadorId]
  );
  const entregador = rows[0];
  if (!entregador || entregador.criado_em.toISOString() !== dados.criadoEm) {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  req.entregador = { id: entregador.id, nome: entregador.nome };
  next();
}

module.exports = { requireApiAuth, JWT_SECRET };
