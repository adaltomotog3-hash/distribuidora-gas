const express = require('express');
const pool = require('../db/pool');
const fiscal = require('../lib/fiscal');
const segredos = require('../lib/segredos');

const router = express.Router();

async function carregarEmpresa() {
  const { rows } = await pool.query('SELECT * FROM empresa_fiscal WHERE id = 1');
  return rows[0] || {};
}

async function carregarProdutosAtivos() {
  const { rows } = await pool.query(
    `SELECT id, tipo, nome, ncm, cfop, cst_csosn FROM produtos WHERE ativo = TRUE ORDER BY tipo ASC, nome ASC`
  );
  return rows;
}

router.get('/empresa', async (req, res) => {
  const [empresa, produtos] = await Promise.all([carregarEmpresa(), carregarProdutosAtivos()]);
  const checklist = fiscal.checklistProntidao(empresa, produtos);
  res.render('empresa', {
    empresa,
    checklist,
    prontos: checklist.filter((i) => i.ok).length,
    UFS: fiscal.UFS,
    REGIMES: fiscal.REGIMES,
    AMBIENTES: fiscal.AMBIENTES,
    formatarCpfCnpj: fiscal.formatarCpfCnpj
  });
});

router.post('/empresa', async (req, res) => {
  const b = req.body;
  const atual = await carregarEmpresa();

  const texto = (v) => {
    const t = String(v || '').trim();
    return t || null;
  };

  // CNPJ (opcional enquanto o contador não passa, mas se digitado precisa ser válido)
  const cnpjDigitos = fiscal.somenteDigitos(b.cnpj);
  if (cnpjDigitos && !fiscal.cnpjValido(cnpjDigitos)) {
    req.setFlash('erro', 'CNPJ inválido. Confira os 14 números e tente de novo.');
    return res.redirect('/empresa');
  }

  const uf = texto(b.uf) ? texto(b.uf).toUpperCase() : null;
  if (uf && !fiscal.UFS.includes(uf)) {
    req.setFlash('erro', 'UF inválida.');
    return res.redirect('/empresa');
  }

  const regime = texto(b.regime_tributario);
  if (regime && !fiscal.REGIMES[regime]) {
    req.setFlash('erro', 'Regime tributário inválido.');
    return res.redirect('/empresa');
  }

  const ambiente = b.ambiente === 'producao' ? 'producao' : 'homologacao';

  const ibge = fiscal.somenteDigitos(b.codigo_municipio_ibge);
  if (ibge && ibge.length !== 7) {
    req.setFlash('erro', 'O código IBGE do município deve ter 7 dígitos.');
    return res.redirect('/empresa');
  }

  const inteiroMin1 = (v, padrao) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 1 ? n : padrao;
  };

  // O código do CSC é um "segredo" da empresa: a tela nunca mostra ele de volta
  // e ele é gravado CRIPTOGRAFADO no banco (chave SEGREDOS_KEY, no .env do
  // servidor). Se o campo vier vazio, mantém o que já estava salvo.
  if (texto(b.csc_token) && !segredos.disponivel()) {
    req.setFlash('erro', 'Não deu para salvar o código do CSC: a chave de criptografia (SEGREDOS_KEY) ainda não foi configurada no servidor. Os outros dados não foram salvos — configure a chave e tente de novo.');
    return res.redirect('/empresa');
  }
  const cscToken = segredos.prepararParaSalvar(b.csc_token, atual.csc_token);

  await pool.query(
    `UPDATE empresa_fiscal SET
       razao_social = $1, nome_fantasia = $2, cnpj = $3, inscricao_estadual = $4, inscricao_municipal = $5,
       regime_tributario = $6, cep = $7, logradouro = $8, numero = $9, complemento = $10, bairro = $11,
       cidade = $12, uf = $13, codigo_municipio_ibge = $14, telefone = $15, email = $16,
       ambiente = $17, serie_nfe = $18, serie_nfce = $19, proximo_numero_nfe = $20, proximo_numero_nfce = $21,
       csc_id = $22, csc_token = $23, atualizado_em = NOW()
     WHERE id = 1`,
    [
      texto(b.razao_social), texto(b.nome_fantasia), cnpjDigitos || null,
      fiscal.somenteDigitos(b.inscricao_estadual) || null, texto(b.inscricao_municipal),
      regime, fiscal.somenteDigitos(b.cep) || null, texto(b.logradouro), texto(b.numero), texto(b.complemento), texto(b.bairro),
      texto(b.cidade), uf, ibge || null, texto(b.telefone), texto(b.email),
      ambiente, inteiroMin1(b.serie_nfe, 1), inteiroMin1(b.serie_nfce, 1),
      inteiroMin1(b.proximo_numero_nfe, 1), inteiroMin1(b.proximo_numero_nfce, 1),
      texto(b.csc_id), cscToken
    ]
  );

  req.setFlash('sucesso', 'Dados da empresa salvos.');
  res.redirect('/empresa');
});

module.exports = router;
