const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { uploadComprovantes, salvarComprovantes, PASTA_COMPROVANTES } = require('../lib/uploads');

const router = express.Router();

const FORMAS_VALIDAS = ['dinheiro', 'pix', 'cartao'];

// Recebe os arquivos de comprovante (campo "comprovantes", até 5) antes da
// rota principal — em erro (tipo inválido, arquivo grande demais, mais de 5
// arquivos), volta pra tela de Despesas com uma mensagem em vez de quebrar.
function receberComprovantes(req, res, next) {
  uploadComprovantes.array('comprovantes', 5)(req, res, (err) => {
    if (err) {
      req.setFlash('erro', err.message || 'Não foi possível enviar o(s) comprovante(s).');
      return res.redirect('/despesas');
    }
    next();
  });
}

router.get('/despesas', async (req, res) => {
  const { inicio, fim } = req.query;
  const dataInicio = inicio || new Date().toISOString().slice(0, 10);
  const dataFim = fim || new Date().toISOString().slice(0, 10);

  const { rows: despesas } = await pool.query(
    `SELECT * FROM despesas
     WHERE criado_em::date BETWEEN $1 AND $2
     ORDER BY criado_em DESC`,
    [dataInicio, dataFim]
  );

  const idsDespesas = despesas.map((d) => d.id);
  let comprovantesPorDespesa = {};
  if (idsDespesas.length > 0) {
    const { rows: comprovantes } = await pool.query(
      `SELECT * FROM despesas_comprovantes WHERE despesa_id = ANY($1::int[]) ORDER BY id ASC`,
      [idsDespesas]
    );
    comprovantesPorDespesa = comprovantes.reduce((acc, c) => {
      (acc[c.despesa_id] = acc[c.despesa_id] || []).push(c);
      return acc;
    }, {});
  }
  despesas.forEach((d) => {
    d.comprovantes = comprovantesPorDespesa[d.id] || [];
  });

  const totalPeriodo = despesas.reduce((soma, d) => soma + Number(d.valor), 0);

  res.render('despesas', { despesas, dataInicio, dataFim, totalPeriodo });
});

router.post('/despesas', receberComprovantes, async (req, res) => {
  const descricaoLimpa = (req.body.descricao || '').trim();
  const valor = Math.max(parseFloat(String(req.body.valor || '0').replace(',', '.')) || 0, 0);
  const formaPagamento = req.body.forma_pagamento;
  const destino = (req.body.destino || '').trim();
  const motivo = (req.body.motivo || '').trim();

  if (!descricaoLimpa) {
    req.setFlash('erro', 'Informe a descrição da despesa.');
    return res.redirect('/despesas');
  }
  if (!valor) {
    req.setFlash('erro', 'Informe um valor maior que zero.');
    return res.redirect('/despesas');
  }
  if (!FORMAS_VALIDAS.includes(formaPagamento)) {
    req.setFlash('erro', 'Selecione de onde saiu o dinheiro (Dinheiro, Pix ou Cartão).');
    return res.redirect('/despesas');
  }

  const { rows } = await pool.query(
    `INSERT INTO despesas (descricao, valor, forma_pagamento, destino, motivo, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [descricaoLimpa, valor, formaPagamento, destino || null, motivo || null, req.session.username || null]
  );
  const despesaId = rows[0].id;

  // Só grava os arquivos em disco (comprimindo as imagens) depois que a
  // despesa já existe no banco — assim nunca sobra arquivo "órfão" no
  // servidor por causa de um erro de validação anterior.
  const comprovantesSalvos = await salvarComprovantes(req.files);
  for (const c of comprovantesSalvos) {
    await pool.query(
      `INSERT INTO despesas_comprovantes (despesa_id, nome_original, nome_arquivo, tipo_mime, tamanho_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [despesaId, c.nome_original, c.nome_arquivo, c.tipo_mime, c.tamanho_bytes]
    );
  }

  req.setFlash('sucesso', 'Despesa registrada.' + (comprovantesSalvos.length > 0 ? ` ${comprovantesSalvos.length} comprovante(s) anexado(s).` : ''));
  res.redirect('/despesas');
});

// --- Abre/baixa um comprovante específico (imagem ou PDF) ---
router.get('/despesas/comprovantes/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM despesas_comprovantes WHERE id = $1', [req.params.id]);
  const comprovante = rows[0];

  if (!comprovante) {
    return res.status(404).render('erro', {
      titulo: 'Comprovante não encontrado',
      codigo: 404,
      mensagem: 'Esse comprovante não existe ou já foi removido.'
    });
  }

  const caminho = path.join(PASTA_COMPROVANTES, comprovante.nome_arquivo);
  res.setHeader('Content-Type', comprovante.tipo_mime || 'application/octet-stream');
  // "inline" deixa o navegador tentar mostrar a imagem/PDF direto, em vez de
  // forçar o download — dá pra baixar do mesmo jeito, se o navegador não
  // conseguir exibir.
  res.setHeader('Content-Disposition', 'inline; filename="' + comprovante.nome_original.replace(/[";]/g, '') + '"');

  res.sendFile(caminho, (err) => {
    if (err && !res.headersSent) {
      res.status(404).render('erro', {
        titulo: 'Arquivo não encontrado',
        codigo: 404,
        mensagem: 'O arquivo desse comprovante não foi encontrado no servidor.'
      });
    }
  });
});

// --- Remove só um comprovante (mantém a despesa) ---
router.post('/despesas/comprovantes/:id/excluir', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM despesas_comprovantes WHERE id = $1', [req.params.id]);
  const comprovante = rows[0];

  if (comprovante) {
    await pool.query('DELETE FROM despesas_comprovantes WHERE id = $1', [comprovante.id]);
    fs.unlink(path.join(PASTA_COMPROVANTES, comprovante.nome_arquivo), () => {});
  }

  req.setFlash('sucesso', 'Comprovante removido.');
  res.redirect(req.get('Referrer') || '/despesas');
});

router.post('/despesas/:id/excluir', async (req, res) => {
  // Antes de excluir a despesa, pega os comprovantes dela pra também apagar
  // os arquivos do disco (o ON DELETE CASCADE só apaga o registro no banco,
  // não o arquivo em si).
  const { rows: comprovantes } = await pool.query(
    'SELECT nome_arquivo FROM despesas_comprovantes WHERE despesa_id = $1',
    [req.params.id]
  );

  await pool.query('DELETE FROM despesas WHERE id = $1', [req.params.id]);

  comprovantes.forEach((c) => {
    fs.unlink(path.join(PASTA_COMPROVANTES, c.nome_arquivo), () => {});
  });

  req.setFlash('sucesso', 'Despesa excluída.');
  res.redirect('/despesas');
});

module.exports = router;
