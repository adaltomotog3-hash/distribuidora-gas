const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const PROVEDORES = {
  asaas: 'Asaas (serviço de cobrança)',
  efi: 'Efí Bank / Gerencianet (serviço de cobrança)',
  outro: 'Outro serviço de cobrança',
  banco_direto: 'Direto pelo banco (cobrança registrada)'
};

const AMBIENTES = {
  sandbox: 'Sandbox (testes, boleto sem valor real)',
  producao: 'Produção (boleto real)'
};

const STATUS_BOLETO = {
  pendente: 'Aguardando emissão',
  emitido: 'Emitido',
  pago: 'Pago',
  vencido: 'Vencido',
  cancelado: 'Cancelado'
};

async function carregarConfig() {
  const { rows } = await pool.query('SELECT * FROM cobranca_config WHERE id = 1');
  return rows[0] || {};
}

function montarChecklist(config, empresa, clientesFiadoSemDoc) {
  const itens = [];
  const add = (ok, texto, dica) => itens.push({ ok: !!ok, texto, dica: dica || '' });

  add(config.provedor, 'Forma de cobrança escolhida', 'Serviço de cobrança (Asaas, Efí...) ou direto pelo banco.');

  if (config.provedor === 'banco_direto') {
    add(
      config.banco_nome && config.banco_agencia && config.banco_conta && config.banco_carteira && config.banco_convenio,
      'Dados da cobrança registrada do banco (agência, conta, carteira e convênio)',
      'O Lorin precisa pedir a cobrança registrada ao gerente do banco — quem informa esses números é o banco.'
    );
  } else {
    add(
      config.api_key,
      'Chave de acesso (API) do serviço de cobrança',
      'O Lorin abre a conta no serviço e gera a chave dentro do painel deles.'
    );
  }

  add(
    empresa.razao_social && empresa.cnpj,
    'Razão social e CNPJ da empresa (o beneficiário do boleto)',
    'Preencha no menu Empresa.'
  );
  add(
    clientesFiadoSemDoc === 0,
    'Clientes com fiado em aberto têm CPF/CNPJ cadastrado' + (clientesFiadoSemDoc > 0 ? ' (' + clientesFiadoSemDoc + ' sem)' : ''),
    'O boleto exige CPF/CNPJ do pagador. Preencha em Clientes.'
  );
  return itens;
}

router.get('/cobranca', async (req, res) => {
  const [config, empresaResult, semDocResult, boletosResult] = await Promise.all([
    carregarConfig(),
    pool.query('SELECT razao_social, cnpj FROM empresa_fiscal WHERE id = 1'),
    pool.query(
      `SELECT COUNT(DISTINCT p.cliente_id)::int AS total
       FROM pedidos p
       JOIN clientes c ON c.id = p.cliente_id
       WHERE p.status = 'fechado' AND p.forma_pagamento = 'fiado' AND p.fiado_pago_em IS NULL
         AND (c.cpf_cnpj IS NULL OR c.cpf_cnpj = '')`
    ),
    pool.query(
      `SELECT b.*, COALESCE(c.nome, p.nome_avulso, 'Cliente avulso') AS cliente_nome
       FROM boletos b
       LEFT JOIN clientes c ON c.id = b.cliente_id
       LEFT JOIN pedidos p ON p.id = b.pedido_id
       ORDER BY b.criado_em DESC
       LIMIT 100`
    )
  ]);

  const checklist = montarChecklist(config, empresaResult.rows[0] || {}, semDocResult.rows[0].total);
  res.render('cobranca', {
    config,
    checklist,
    prontos: checklist.filter((i) => i.ok).length,
    boletos: boletosResult.rows,
    PROVEDORES,
    AMBIENTES,
    STATUS_BOLETO
  });
});

router.post('/cobranca', async (req, res) => {
  const b = req.body;
  const atual = await carregarConfig();

  const texto = (v) => {
    const t = String(v || '').trim();
    return t || null;
  };
  const numeroEntre = (v, min, max, padrao) => {
    const n = Number(String(v || '').replace(',', '.'));
    return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
  };

  const provedor = texto(b.provedor);
  if (provedor && !PROVEDORES[provedor]) {
    req.setFlash('erro', 'Forma de cobrança inválida.');
    return res.redirect('/cobranca');
  }
  const ambiente = b.ambiente === 'producao' ? 'producao' : 'sandbox';

  const multa = numeroEntre(b.multa_percentual, 0, 20, null);
  const juros = numeroEntre(b.juros_mensal_percentual, 0, 20, null);
  if (multa === null || juros === null) {
    req.setFlash('erro', 'Multa e juros devem ser números entre 0 e 20 (em %).');
    return res.redirect('/cobranca');
  }
  const dias = parseInt(b.dias_vencimento_padrao, 10);
  if (!Number.isFinite(dias) || dias < 0 || dias > 90) {
    req.setFlash('erro', 'Os dias de vencimento devem ficar entre 0 e 90.');
    return res.redirect('/cobranca');
  }

  // A chave de acesso é um segredo: a tela nunca mostra ela de volta.
  // Campo vazio = mantém a que já estava salva.
  const apiKey = texto(b.api_key) || atual.api_key || null;

  await pool.query(
    `UPDATE cobranca_config SET
       provedor = $1, ambiente = $2, api_key = $3, dias_vencimento_padrao = $4,
       multa_percentual = $5, juros_mensal_percentual = $6, instrucoes = $7,
       banco_nome = $8, banco_agencia = $9, banco_conta = $10, banco_carteira = $11, banco_convenio = $12,
       atualizado_em = NOW()
     WHERE id = 1`,
    [
      provedor, ambiente, apiKey, dias, multa, juros, texto(b.instrucoes),
      texto(b.banco_nome), texto(b.banco_agencia), texto(b.banco_conta), texto(b.banco_carteira), texto(b.banco_convenio)
    ]
  );

  req.setFlash('sucesso', 'Configuração de cobrança salva.');
  res.redirect('/cobranca');
});

module.exports = router;
