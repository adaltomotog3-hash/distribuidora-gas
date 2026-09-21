const express = require('express');
const pool = require('../db/pool');
const { formatarEndereco } = require('../lib/endereco');
const fiscal = require('../lib/fiscal');

const router = express.Router();

function camposEndereco(body) {
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

// Dados do destinatário da nota (todos opcionais). Se CPF/CNPJ vier preenchido, precisa ser válido.
function camposFiscais(body) {
  const doc = fiscal.validarCpfCnpj(body.cpf_cnpj);
  if (!doc.ok) return { erro: doc.erro };
  return {
    cpf_cnpj: doc.valor,
    inscricao_estadual: fiscal.somenteDigitos(body.inscricao_estadual) || null,
    email: (body.email || '').trim() || null
  };
}

router.get('/clientes', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clientes ORDER BY nome ASC');
  const clientes = rows.map((c) => ({ ...c, endereco_formatado: formatarEndereco(c) }));
  res.render('clientes', { clientes, formatarCpfCnpj: fiscal.formatarCpfCnpj });
});

router.post('/clientes', async (req, res) => {
  const nomeLimpo = (req.body.nome || '').trim();
  const { telefone, observacao } = req.body;

  if (!nomeLimpo) {
    req.setFlash('erro', 'Informe o nome do cliente.');
    return res.redirect('/clientes');
  }

  const fis = camposFiscais(req.body);
  if (fis.erro) {
    req.setFlash('erro', fis.erro);
    return res.redirect('/clientes');
  }

  const end = camposEndereco(req.body);
  await pool.query(
    `INSERT INTO clientes
       (nome, telefone, observacao, cep, endereco, numero, complemento, bairro, cidade, uf, referencia, latitude, longitude,
        cpf_cnpj, inscricao_estadual, email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [nomeLimpo, telefone || null, observacao || null,
      end.cep, end.endereco, end.numero, end.complemento, end.bairro, end.cidade, end.uf, end.referencia, end.latitude, end.longitude,
      fis.cpf_cnpj, fis.inscricao_estadual, fis.email]
  );
  req.setFlash('sucesso', 'Cliente cadastrado.');
  res.redirect('/clientes');
});

router.get('/clientes/:id/editar', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.redirect('/clientes');
  res.render('cliente-editar', { cliente: rows[0], formatarCpfCnpj: fiscal.formatarCpfCnpj });
});

router.post('/clientes/:id/editar', async (req, res) => {
  const nomeLimpo = (req.body.nome || '').trim();
  const { telefone, observacao } = req.body;

  if (!nomeLimpo) {
    req.setFlash('erro', 'Informe o nome do cliente.');
    return res.redirect('/clientes/' + req.params.id + '/editar');
  }

  const fis = camposFiscais(req.body);
  if (fis.erro) {
    req.setFlash('erro', fis.erro);
    return res.redirect('/clientes/' + req.params.id + '/editar');
  }

  const end = camposEndereco(req.body);
  await pool.query(
    `UPDATE clientes SET
       nome = $1, telefone = $2, observacao = $3,
       cep = $4, endereco = $5, numero = $6, complemento = $7, bairro = $8, cidade = $9, uf = $10,
       referencia = $11, latitude = $12, longitude = $13,
       cpf_cnpj = $14, inscricao_estadual = $15, email = $16
     WHERE id = $17`,
    [nomeLimpo, telefone || null, observacao || null,
      end.cep, end.endereco, end.numero, end.complemento, end.bairro, end.cidade, end.uf, end.referencia, end.latitude, end.longitude,
      fis.cpf_cnpj, fis.inscricao_estadual, fis.email,
      req.params.id]
  );
  req.setFlash('sucesso', 'Cliente atualizado.');
  res.redirect('/clientes');
});

router.post('/clientes/:id/excluir', async (req, res) => {
  await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
  req.setFlash('sucesso', 'Cliente excluído.');
  res.redirect('/clientes');
});

module.exports = router;
