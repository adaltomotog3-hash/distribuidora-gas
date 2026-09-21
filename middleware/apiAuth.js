const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Sem JWT_SECRET no .env, NÃO usamos um segredo "padrão" (o código é público no
// GitHub, então qualquer um saberia qual é e poderia forjar um token de acesso).
// Em vez disso gera um segredo aleatório a cada início do servidor — seguro, mas
// os apps precisam entrar de novo depois de cada reinício. Configure JWT_SECRET
// no .env do servidor para os logins dos apps durarem.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'troque-esse-segredo-tambem' || JWT_SECRET.length < 24) {
  JWT_SECRET = require('crypto').randomBytes(48).toString('hex');
  console.warn('>> ATENÇÃO DE SEGURANÇA: JWT_SECRET ausente, fraco ou padrão no .env. Usando um segredo temporário (os apps vão pedir login de novo a cada reinício). Defina um JWT_SECRET forte no .env.');
}

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
