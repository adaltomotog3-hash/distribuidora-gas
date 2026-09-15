const express = require('express');
const pool = require('../db/pool');
const {
  iniciarPdf,
  cabecalho,
  tituloSecao,
  linhaResumo,
  tabela,
  rodapePaginas,
  formatarMoeda,
  formatarDataCurta,
  formatarDataHora,
  truncar
} = require('../lib/pdf');

const router = express.Router();

// Pega inicio/fim da query string, com "hoje" como padrão pros dois — usado
// tanto pra tela quanto pros PDFs (assim o PDF baixa exatamente o intervalo
// que a pessoa está vendo na tela).
function periodoDoQuery(req) {
  const hoje = new Date().toISOString().slice(0, 10);
  return { inicio: req.query.inicio || hoje, fim: req.query.fim || hoje };
}

const PERIODOS_VALIDOS = ['dia', 'semana', 'quinzena', 'mes', 'ano'];

const CAMPOS = `
    COUNT(*)::int AS total_pedidos,
    COALESCE(SUM(r.qtd_itens), 0)::int AS total_itens,
    COALESCE(SUM(r.qtd_gas), 0)::int AS qtd_gas,
    COALESCE(SUM(r.qtd_agua), 0)::int AS qtd_agua,
    COALESCE(SUM(r.valor_gas), 0) AS valor_gas,
    COALESCE(SUM(r.valor_agua), 0) AS valor_agua,
    COALESCE(SUM(r.desconto), 0) AS total_descontos,
    COALESCE(SUM(GREATEST(r.valor_bruto - r.desconto, 0)), 0) AS valor_total
  FROM (
    SELECT p.id, p.fechado_em, p.desconto,
      COALESCE(SUM(i.quantidade), 0)::int AS qtd_itens,
      COALESCE(SUM(CASE WHEN i.produto = 'gas' THEN i.quantidade ELSE 0 END), 0)::int AS qtd_gas,
      COALESCE(SUM(CASE WHEN i.produto = 'agua' THEN i.quantidade ELSE 0 END), 0)::int AS qtd_agua,
      COALESCE(SUM(CASE WHEN i.produto = 'gas' THEN i.preco_unitario * i.quantidade ELSE 0 END), 0) AS valor_gas,
      COALESCE(SUM(CASE WHEN i.produto = 'agua' THEN i.preco_unitario * i.quantidade ELSE 0 END), 0) AS valor_agua,
      COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor_bruto
    FROM pedidos p
    JOIN itens_pedido i ON i.pedido_id = p.id
    WHERE p.status = 'fechado'
    GROUP BY p.id
  ) r`;

async function buscarPorPeriodo(periodo) {
  if (periodo === 'quinzena') {
    const { rows } = await pool.query(`
      SELECT DATE_TRUNC('month', r.fechado_em) AS mes,
        CASE WHEN EXTRACT(DAY FROM r.fechado_em) <= 15 THEN 1 ELSE 2 END AS quinzena,
        ${CAMPOS}
      GROUP BY DATE_TRUNC('month', r.fechado_em), CASE WHEN EXTRACT(DAY FROM r.fechado_em) <= 15 THEN 1 ELSE 2 END
      ORDER BY mes DESC, quinzena DESC
      LIMIT 12
    `);
    return rows;
  }

  const truncPorPeriodo = { dia: 'day', semana: 'week', mes: 'month', ano: 'year' };
  const limitePorPeriodo = { dia: 30, semana: 12, mes: 12, ano: 6 };
  const trunc = truncPorPeriodo[periodo] || 'day';
  const limite = limitePorPeriodo[periodo] || 30;

  const { rows } = await pool.query(`
    SELECT DATE_TRUNC('${trunc}', r.fechado_em) AS periodo,
      ${CAMPOS}
    GROUP BY DATE_TRUNC('${trunc}', r.fechado_em)
    ORDER BY periodo DESC
    LIMIT ${limite}
  `);
  return rows;
}

// Card "atual" no topo: mostra só o período que está sendo visto agora (hoje, essa
// semana, esse mês...), não a soma de todos os períodos listados na tabela abaixo.
const ROTULOS_PERIODO_ATUAL = {
  dia: 'Hoje',
  semana: 'Essa semana',
  quinzena: 'Essa quinzena',
  mes: 'Esse mês',
  ano: 'Esse ano'
};

async function buscarPeriodoAtual(periodo) {
  let condicao;
  if (periodo === 'semana') {
    condicao = `DATE_TRUNC('week', r.fechado_em) = DATE_TRUNC('week', CURRENT_DATE)`;
  } else if (periodo === 'quinzena') {
    condicao = `DATE_TRUNC('month', r.fechado_em) = DATE_TRUNC('month', CURRENT_DATE)
      AND (CASE WHEN EXTRACT(DAY FROM r.fechado_em) <= 15 THEN 1 ELSE 2 END)
        = (CASE WHEN EXTRACT(DAY FROM CURRENT_DATE) <= 15 THEN 1 ELSE 2 END)`;
  } else if (periodo === 'mes') {
    condicao = `DATE_TRUNC('month', r.fechado_em) = DATE_TRUNC('month', CURRENT_DATE)`;
  } else if (periodo === 'ano') {
    condicao = `DATE_TRUNC('year', r.fechado_em) = DATE_TRUNC('year', CURRENT_DATE)`;
  } else {
    condicao = `r.fechado_em::date = CURRENT_DATE`;
  }

  const { rows } = await pool.query(`
    SELECT ${CAMPOS}
    WHERE ${condicao}
  `);
  return rows[0];
}

function formatarLabel(row, periodo) {
  if (periodo === 'quinzena') {
    const mes = new Date(row.mes);
    const nomeMes = mes.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return (row.quinzena === 1 ? '1ª quinzena' : '2ª quinzena') + ' de ' + nomeMes;
  }
  const data = new Date(row.periodo);
  if (periodo === 'dia') {
    return data.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  if (periodo === 'semana') {
    const fim = new Date(data);
    fim.setDate(fim.getDate() + 6);
    return 'Semana de ' + data.toLocaleDateString('pt-BR') + ' a ' + fim.toLocaleDateString('pt-BR');
  }
  if (periodo === 'mes') {
    return data.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  }
  if (periodo === 'ano') {
    return String(data.getFullYear());
  }
  return '';
}

// --- Relatório de vendas: resumo e detalhe linha a linha, num intervalo de datas escolhido ---
// (mesmo padrão do que já existia pra Entregas e Saídas — usado tanto na tela
// quanto no PDF).
async function buscarResumoVendas(inicio, fim) {
  const { rows } = await pool.query(`
    SELECT ${CAMPOS}
    WHERE r.fechado_em::date BETWEEN $1 AND $2
  `, [inicio, fim]);
  return rows[0];
}

async function buscarDetalheVendas(inicio, fim) {
  const { rows } = await pool.query(
    `SELECT p.id, p.fechado_em, p.forma_pagamento, p.desconto,
       COALESCE(c.nome, p.nome_avulso, 'Cliente avulso') AS cliente_nome,
       (SELECT STRING_AGG(i.quantidade || 'x ' || COALESCE(pd.nome, CASE WHEN i.produto = 'agua' THEN 'Água' ELSE 'Gás' END), ', ' ORDER BY i.id)
          FROM itens_pedido i LEFT JOIN produtos pd ON pd.id = i.produto_id WHERE i.pedido_id = p.id) AS resumo_itens,
       GREATEST(COALESCE((SELECT SUM(i.preco_unitario * i.quantidade) FROM itens_pedido i WHERE i.pedido_id = p.id), 0) - p.desconto, 0) AS total_valor
     FROM pedidos p
     LEFT JOIN clientes c ON c.id = p.cliente_id
     WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
     ORDER BY p.fechado_em ASC
     LIMIT 1000`,
    [inicio, fim]
  );
  return rows;
}

// --- Relatório financeiro: entradas por forma de pagamento, saídas (despesas)
// e saldo líquido, tudo restrito ao mesmo intervalo de datas (independente do
// "período" dos cards/tabela acima). Reaproveita o detalhe de vendas acima. ---
async function buscarFinanceiroIntervalo(inicio, fim) {
  const [resumo, porFormaPagamentoResult, despesasPorFormaResult, detalheVendas] = await Promise.all([
    buscarResumoVendas(inicio, fim),
    pool.query(
      `SELECT r.forma_pagamento, COUNT(*)::int AS total_vendas,
         COALESCE(SUM(GREATEST(r.valor_bruto - r.desconto, 0)), 0) AS total_valor
       FROM (
         SELECT p.id, p.forma_pagamento, p.desconto, COALESCE(SUM(i.preco_unitario * i.quantidade), 0) AS valor_bruto
         FROM pedidos p
         JOIN itens_pedido i ON i.pedido_id = p.id
         WHERE p.status = 'fechado' AND p.fechado_em::date BETWEEN $1 AND $2
         GROUP BY p.id
       ) r
       GROUP BY r.forma_pagamento
       ORDER BY total_valor DESC`,
      [inicio, fim]
    ),
    pool.query(
      `SELECT forma_pagamento, COUNT(*)::int AS total_despesas, COALESCE(SUM(valor), 0) AS total_valor
       FROM despesas
       WHERE criado_em::date BETWEEN $1 AND $2
       GROUP BY forma_pagamento`,
      [inicio, fim]
    ),
    buscarDetalheVendas(inicio, fim)
  ]);

  const despesasPorForma = despesasPorFormaResult.rows;
  const totalDespesas = despesasPorForma.reduce((soma, d) => soma + Number(d.total_valor), 0);
  const saldoLiquido = Number(resumo.valor_total) - totalDespesas;

  return {
    resumo,
    porFormaPagamento: porFormaPagamentoResult.rows,
    despesasPorForma,
    totalDespesas,
    saldoLiquido,
    detalheVendas
  };
}

// --- Relatório de entregas por período (mesmo padrão do de vendas/financeiro):
// tabela com o histórico dos últimos períodos + card "atual" só com o período selecionado ---
const BASE_ENTREGAS = `
  FROM pedidos p
  JOIN (
    SELECT pedido_id, COALESCE(SUM(preco_unitario * quantidade), 0) AS valor_bruto
    FROM itens_pedido GROUP BY pedido_id
  ) r ON r.pedido_id = p.id
  WHERE p.status = 'fechado' AND p.entrega_status = 'entregue'`;

async function buscarEntregasPorPeriodo(periodo) {
  if (periodo === 'quinzena') {
    const { rows } = await pool.query(`
      SELECT DATE_TRUNC('month', p.entregue_em) AS mes,
        CASE WHEN EXTRACT(DAY FROM p.entregue_em) <= 15 THEN 1 ELSE 2 END AS quinzena,
        COUNT(p.id)::int AS total_entregas,
        COALESCE(SUM(GREATEST(r.valor_bruto - p.desconto, 0)), 0) AS valor_total
      ${BASE_ENTREGAS}
      GROUP BY DATE_TRUNC('month', p.entregue_em), CASE WHEN EXTRACT(DAY FROM p.entregue_em) <= 15 THEN 1 ELSE 2 END
      ORDER BY mes DESC, quinzena DESC
      LIMIT 12
    `);
    return rows;
  }

  const truncPorPeriodo = { dia: 'day', semana: 'week', mes: 'month', ano: 'year' };
  const limitePorPeriodo = { dia: 30, semana: 12, mes: 12, ano: 6 };
  const trunc = truncPorPeriodo[periodo] || 'day';
  const limite = limitePorPeriodo[periodo] || 30;

  const { rows } = await pool.query(`
    SELECT DATE_TRUNC('${trunc}', p.entregue_em) AS periodo,
      COUNT(p.id)::int AS total_entregas,
      COALESCE(SUM(GREATEST(r.valor_bruto - p.desconto, 0)), 0) AS valor_total
    ${BASE_ENTREGAS}
    GROUP BY DATE_TRUNC('${trunc}', p.entregue_em)
    ORDER BY periodo DESC
    LIMIT ${limite}
  `);
  return rows;
}

async function buscarEntregasPeriodoAtual(periodo) {
  let condicao;
  if (periodo === 'semana') {
    condicao = `DATE_TRUNC('week', p.entregue_em) = DATE_TRUNC('week', CURRENT_DATE)`;
  } else if (periodo === 'quinzena') {
    condicao = `DATE_TRUNC('month', p.entregue_em) = DATE_TRUNC('month', CURRENT_DATE)
      AND (CASE WHEN EXTRACT(DAY FROM p.entregue_em) <= 15 THEN 1 ELSE 2 END)
        = (CASE WHEN EXTRACT(DAY FROM CURRENT_DATE) <= 15 THEN 1 ELSE 2 END)`;
  } else if (periodo === 'mes') {
    condicao = `DATE_TRUNC('month', p.entregue_em) = DATE_TRUNC('month', CURRENT_DATE)`;
  } else if (periodo === 'ano') {
    condicao = `DATE_TRUNC('year', p.entregue_em) = DATE_TRUNC('year', CURRENT_DATE)`;
  } else {
    condicao = `p.entregue_em::date = CURRENT_DATE`;
  }

  const { rows } = await pool.query(`
    SELECT COUNT(p.id)::int AS total_entregas,
      COALESCE(SUM(GREATEST(r.valor_bruto - p.desconto, 0)), 0) AS valor_total
    ${BASE_ENTREGAS}
      AND ${condicao}
  `);
  return rows[0];
}

// --- Relatório de entregas: quem entregou cada O.S., num intervalo de datas escolhido ---
async function buscarRelatorioEntregas(inicio, fim) {
  const porEntregadorResult = await pool.query(
    `SELECT COALESCE(e.nome, 'Escritório / sem entregador') AS entregador_nome,
       COUNT(p.id)::int AS total_entregas,
       COALESCE(SUM(GREATEST(r.valor_bruto - p.desconto, 0)), 0) AS valor_total
     FROM pedidos p
     LEFT JOIN entregadores e ON e.id = p.entregador_id
     JOIN (
       SELECT pedido_id, COALESCE(SUM(preco_unitario * quantidade), 0) AS valor_bruto
       FROM itens_pedido GROUP BY pedido_id
     ) r ON r.pedido_id = p.id
     WHERE p.status = 'fechado' AND p.entrega_status = 'entregue'
       AND p.entregue_em::date BETWEEN $1 AND $2
     GROUP BY e.nome
     ORDER BY total_entregas DESC`,
    [inicio, fim]
  );

  const detalheResult = await pool.query(
    `SELECT p.id, p.entregue_em, p.baixado_em,
       COALESCE(c.nome, p.nome_avulso, 'Cliente avulso') AS cliente_nome,
       COALESCE(e.nome, 'Escritório / sem entregador') AS entregador_nome,
       (SELECT GREATEST(COALESCE(SUM(i.preco_unitario * i.quantidade), 0) - p.desconto, 0) FROM itens_pedido i WHERE i.pedido_id = p.id) AS total_valor,
       (SELECT STRING_AGG(i.quantidade || 'x ' || COALESCE(pd.nome, CASE WHEN i.produto = 'agua' THEN 'Água' ELSE 'Gás' END), ', ' ORDER BY i.id)
          FROM itens_pedido i LEFT JOIN produtos pd ON pd.id = i.produto_id WHERE i.pedido_id = p.id) AS resumo_itens
     FROM pedidos p
     LEFT JOIN clientes c ON c.id = p.cliente_id
     LEFT JOIN entregadores e ON e.id = p.entregador_id
     WHERE p.status = 'fechado' AND p.entrega_status = 'entregue'
       AND p.entregue_em::date BETWEEN $1 AND $2
     ORDER BY p.entregue_em DESC
     LIMIT 300`,
    [inicio, fim]
  );

  return { porEntregador: porEntregadorResult.rows, detalhe: detalheResult.rows };
}

// --- Relatório de saídas (despesas) por período, no mesmo padrão de vendas/financeiro ---

async function buscarDespesasPorPeriodo(periodo) {
  if (periodo === 'quinzena') {
    const { rows } = await pool.query(`
      SELECT DATE_TRUNC('month', criado_em) AS mes,
        CASE WHEN EXTRACT(DAY FROM criado_em) <= 15 THEN 1 ELSE 2 END AS quinzena,
        COUNT(*)::int AS total_despesas,
        COALESCE(SUM(valor), 0) AS valor_total
      FROM despesas
      GROUP BY DATE_TRUNC('month', criado_em), CASE WHEN EXTRACT(DAY FROM criado_em) <= 15 THEN 1 ELSE 2 END
      ORDER BY mes DESC, quinzena DESC
      LIMIT 12
    `);
    return rows;
  }

  const truncPorPeriodo = { dia: 'day', semana: 'week', mes: 'month', ano: 'year' };
  const limitePorPeriodo = { dia: 30, semana: 12, mes: 12, ano: 6 };
  const trunc = truncPorPeriodo[periodo] || 'day';
  const limite = limitePorPeriodo[periodo] || 30;

  const { rows } = await pool.query(`
    SELECT DATE_TRUNC('${trunc}', criado_em) AS periodo,
      COUNT(*)::int AS total_despesas,
      COALESCE(SUM(valor), 0) AS valor_total
    FROM despesas
    GROUP BY DATE_TRUNC('${trunc}', criado_em)
    ORDER BY periodo DESC
    LIMIT ${limite}
  `);
  return rows;
}

async function buscarDespesasPeriodoAtual(periodo) {
  let condicao;
  if (periodo === 'semana') {
    condicao = `DATE_TRUNC('week', criado_em) = DATE_TRUNC('week', CURRENT_DATE)`;
  } else if (periodo === 'quinzena') {
    condicao = `DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', CURRENT_DATE)
      AND (CASE WHEN EXTRACT(DAY FROM criado_em) <= 15 THEN 1 ELSE 2 END)
        = (CASE WHEN EXTRACT(DAY FROM CURRENT_DATE) <= 15 THEN 1 ELSE 2 END)`;
  } else if (periodo === 'mes') {
    condicao = `DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', CURRENT_DATE)`;
  } else if (periodo === 'ano') {
    condicao = `DATE_TRUNC('year', criado_em) = DATE_TRUNC('year', CURRENT_DATE)`;
  } else {
    condicao = `criado_em::date = CURRENT_DATE`;
  }

  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total_despesas, COALESCE(SUM(valor), 0) AS valor_total
    FROM despesas
    WHERE ${condicao}
  `);
  return rows[0];
}

// --- Relatório de saídas: por forma de pagamento + detalhe de cada despesa, num intervalo de datas ---
async function buscarRelatorioSaidas(inicio, fim) {
  const porFormaResult = await pool.query(
    `SELECT forma_pagamento, COUNT(*)::int AS total_despesas, COALESCE(SUM(valor), 0) AS valor_total
     FROM despesas
     WHERE criado_em::date BETWEEN $1 AND $2
     GROUP BY forma_pagamento
     ORDER BY valor_total DESC`,
    [inicio, fim]
  );

  const detalheResult = await pool.query(
    `SELECT id, criado_em, descricao, valor, forma_pagamento, destino, motivo, registrado_por
     FROM despesas
     WHERE criado_em::date BETWEEN $1 AND $2
     ORDER BY criado_em DESC
     LIMIT 300`,
    [inicio, fim]
  );

  return { porForma: porFormaResult.rows, detalhe: detalheResult.rows };
}

// Valores padrão de todos os campos "de intervalo de datas" que a view usa,
// pra cada aba só precisar preencher o que é dela — evita esquecer alguma
// variável numa aba e o EJS quebrar com "not defined".
const CAMPOS_INTERVALO_PADRAO = {
  inicio: null,
  fim: null,
  porEntregador: [],
  detalhe: [],
  porForma: [],
  detalheVendas: [],
  porFormaFinanceiro: [],
  despesasPorFormaFinanceiro: [],
  totalDespesasFinanceiro: 0,
  saldoLiquidoFinanceiro: 0
};

router.get('/relatorios', async (req, res) => {
  const tipoQuery = req.query.tipo;
  const tipo = ['financeiro', 'entregas', 'saidas'].includes(tipoQuery) ? tipoQuery : 'vendas';
  const periodo = PERIODOS_VALIDOS.includes(req.query.periodo) ? req.query.periodo : 'dia';

  if (tipo === 'entregas') {
    const { inicio, fim } = periodoDoQuery(req);

    const [{ porEntregador, detalhe }, linhasBrutas, atual] = await Promise.all([
      buscarRelatorioEntregas(inicio, fim),
      buscarEntregasPorPeriodo(periodo),
      buscarEntregasPeriodoAtual(periodo)
    ]);
    const linhas = linhasBrutas.map((row) => ({ ...row, label: formatarLabel(row, periodo) }));
    const rotuloAtual = ROTULOS_PERIODO_ATUAL[periodo] || 'Período atual';

    return res.render('relatorios', {
      ...CAMPOS_INTERVALO_PADRAO, tipo, periodo, linhas, atual, rotuloAtual,
      inicio, fim, porEntregador, detalhe
    });
  }

  if (tipo === 'saidas') {
    const { inicio, fim } = periodoDoQuery(req);

    const [{ porForma, detalhe }, linhasBrutas, atual] = await Promise.all([
      buscarRelatorioSaidas(inicio, fim),
      buscarDespesasPorPeriodo(periodo),
      buscarDespesasPeriodoAtual(periodo)
    ]);
    const linhas = linhasBrutas.map((row) => ({ ...row, label: formatarLabel(row, periodo) }));
    const rotuloAtual = ROTULOS_PERIODO_ATUAL[periodo] || 'Período atual';

    return res.render('relatorios', {
      ...CAMPOS_INTERVALO_PADRAO, tipo, periodo, linhas, atual, rotuloAtual,
      inicio, fim, porForma, detalhe
    });
  }

  if (tipo === 'financeiro') {
    const { inicio, fim } = periodoDoQuery(req);

    const [financeiroIntervalo, linhasBrutas, atual] = await Promise.all([
      buscarFinanceiroIntervalo(inicio, fim),
      buscarPorPeriodo(periodo),
      buscarPeriodoAtual(periodo)
    ]);
    const linhas = linhasBrutas.map((row) => ({ ...row, label: formatarLabel(row, periodo) }));
    const rotuloAtual = ROTULOS_PERIODO_ATUAL[periodo] || 'Período atual';

    return res.render('relatorios', {
      ...CAMPOS_INTERVALO_PADRAO, tipo, periodo, linhas, atual, rotuloAtual,
      inicio, fim,
      detalheVendas: financeiroIntervalo.detalheVendas,
      porFormaFinanceiro: financeiroIntervalo.porFormaPagamento,
      despesasPorFormaFinanceiro: financeiroIntervalo.despesasPorForma,
      totalDespesasFinanceiro: financeiroIntervalo.totalDespesas,
      saldoLiquidoFinanceiro: financeiroIntervalo.saldoLiquido
    });
  }

  // tipo === 'vendas'
  const { inicio, fim } = periodoDoQuery(req);

  const [detalheVendas, linhasBrutas, atual] = await Promise.all([
    buscarDetalheVendas(inicio, fim),
    buscarPorPeriodo(periodo),
    buscarPeriodoAtual(periodo)
  ]);
  const linhas = linhasBrutas.map((row) => ({ ...row, label: formatarLabel(row, periodo) }));
  const rotuloAtual = ROTULOS_PERIODO_ATUAL[periodo] || 'Período atual';

  res.render('relatorios', {
    ...CAMPOS_INTERVALO_PADRAO, tipo, periodo, linhas, atual, rotuloAtual,
    inicio, fim, detalheVendas
  });
});

// --- Downloads em PDF, um por aba, sempre no intervalo de datas selecionado ---

router.get('/relatorios/pdf/vendas', async (req, res) => {
  const { inicio, fim } = periodoDoQuery(req);
  const [resumo, detalhe] = await Promise.all([
    buscarResumoVendas(inicio, fim),
    buscarDetalheVendas(inicio, fim)
  ]);

  const doc = iniciarPdf(res, `relatorio-vendas_${inicio}_a_${fim}.pdf`);
  cabecalho(doc, {
    titulo: 'Relatório de Vendas',
    subtitulo: `Período: ${formatarDataCurta(inicio)} a ${formatarDataCurta(fim)}`
  });

  tituloSecao(doc, 'Resumo do período');
  linhaResumo(doc, `O.S. fechadas: ${resumo.total_pedidos}      Itens vendidos: ${resumo.total_itens}      Qtd. Gás: ${resumo.qtd_gas}      Qtd. Água: ${resumo.qtd_agua}`);
  linhaResumo(doc, `Valor total: ${formatarMoeda(resumo.valor_total)}      Descontos concedidos: ${formatarMoeda(resumo.total_descontos)}`);
  doc.moveDown(1);

  tituloSecao(doc, `Detalhe das O.S. (${detalhe.length})`);
  tabela(doc, {
    colunas: [
      { titulo: 'O.S.', campo: 'id', flex: 0.6 },
      { titulo: 'Data', flex: 1.2, valor: (l) => formatarDataHora(l.fechado_em) },
      { titulo: 'Cliente', campo: 'cliente_nome', flex: 1.6 },
      { titulo: 'Itens', flex: 2.4, valor: (l) => truncar(l.resumo_itens, 55) },
      { titulo: 'Pagamento', campo: 'forma_pagamento', flex: 1 },
      { titulo: 'Desconto', flex: 1, align: 'right', valor: (l) => formatarMoeda(l.desconto) },
      { titulo: 'Total', flex: 1, align: 'right', valor: (l) => formatarMoeda(l.total_valor) }
    ],
    linhas: detalhe
  });

  rodapePaginas(doc);
  doc.end();
});

router.get('/relatorios/pdf/financeiro', async (req, res) => {
  const { inicio, fim } = periodoDoQuery(req);
  const dados = await buscarFinanceiroIntervalo(inicio, fim);

  const doc = iniciarPdf(res, `relatorio-financeiro_${inicio}_a_${fim}.pdf`);
  cabecalho(doc, {
    titulo: 'Relatório Financeiro',
    subtitulo: `Período: ${formatarDataCurta(inicio)} a ${formatarDataCurta(fim)}`
  });

  tituloSecao(doc, 'Resumo do período');
  linhaResumo(doc, `O.S. fechadas: ${dados.resumo.total_pedidos}      Valor total: ${formatarMoeda(dados.resumo.valor_total)}      Descontos: ${formatarMoeda(dados.resumo.total_descontos)}`);
  linhaResumo(doc, `Despesas do período: ${formatarMoeda(dados.totalDespesas)}      Saldo líquido: ${formatarMoeda(dados.saldoLiquido)}`);
  doc.moveDown(1);

  tituloSecao(doc, 'Entradas por forma de pagamento');
  tabela(doc, {
    colunas: [
      { titulo: 'Forma', campo: 'forma_pagamento', flex: 1.5 },
      { titulo: 'Vendas', campo: 'total_vendas', flex: 1, align: 'right' },
      { titulo: 'Valor', flex: 1.5, align: 'right', valor: (l) => formatarMoeda(l.total_valor) }
    ],
    linhas: dados.porFormaPagamento
  });

  tituloSecao(doc, 'Saídas por forma de pagamento');
  tabela(doc, {
    colunas: [
      { titulo: 'Forma', campo: 'forma_pagamento', flex: 1.5 },
      { titulo: 'Despesas', campo: 'total_despesas', flex: 1, align: 'right' },
      { titulo: 'Valor', flex: 1.5, align: 'right', valor: (l) => formatarMoeda(l.total_valor) }
    ],
    linhas: dados.despesasPorForma
  });

  tituloSecao(doc, `Detalhe das vendas (${dados.detalheVendas.length})`);
  tabela(doc, {
    colunas: [
      { titulo: 'O.S.', campo: 'id', flex: 0.6 },
      { titulo: 'Data', flex: 1.2, valor: (l) => formatarDataHora(l.fechado_em) },
      { titulo: 'Cliente', campo: 'cliente_nome', flex: 1.8 },
      { titulo: 'Pagamento', campo: 'forma_pagamento', flex: 1.2 },
      { titulo: 'Desconto', flex: 1, align: 'right', valor: (l) => formatarMoeda(l.desconto) },
      { titulo: 'Total', flex: 1, align: 'right', valor: (l) => formatarMoeda(l.total_valor) }
    ],
    linhas: dados.detalheVendas
  });

  rodapePaginas(doc);
  doc.end();
});

router.get('/relatorios/pdf/entregas', async (req, res) => {
  const { inicio, fim } = periodoDoQuery(req);
  const { porEntregador, detalhe } = await buscarRelatorioEntregas(inicio, fim);
  const valorTotal = detalhe.reduce((soma, d) => soma + Number(d.total_valor), 0);

  const doc = iniciarPdf(res, `relatorio-entregas_${inicio}_a_${fim}.pdf`);
  cabecalho(doc, {
    titulo: 'Relatório de Entregas',
    subtitulo: `Período: ${formatarDataCurta(inicio)} a ${formatarDataCurta(fim)}`
  });

  tituloSecao(doc, 'Resumo do período');
  linhaResumo(doc, `Entregas finalizadas: ${detalhe.length}      Valor entregue: ${formatarMoeda(valorTotal)}`);
  doc.moveDown(1);

  tituloSecao(doc, 'Por entregador');
  tabela(doc, {
    colunas: [
      { titulo: 'Entregador', campo: 'entregador_nome', flex: 2 },
      { titulo: 'Entregas', campo: 'total_entregas', flex: 1, align: 'right' },
      { titulo: 'Valor entregue', flex: 1.4, align: 'right', valor: (l) => formatarMoeda(l.valor_total) }
    ],
    linhas: porEntregador
  });

  tituloSecao(doc, `Detalhe das entregas (${detalhe.length})`);
  tabela(doc, {
    colunas: [
      { titulo: 'O.S.', campo: 'id', flex: 0.6 },
      { titulo: 'Cliente', campo: 'cliente_nome', flex: 1.7 },
      { titulo: 'Itens', flex: 2, valor: (l) => truncar(l.resumo_itens, 45) },
      { titulo: 'Total', flex: 1, align: 'right', valor: (l) => formatarMoeda(l.total_valor) },
      { titulo: 'Entregador', campo: 'entregador_nome', flex: 1.4 },
      { titulo: 'Entregue em', flex: 1.3, valor: (l) => formatarDataHora(l.entregue_em) },
      { titulo: 'Baixa', flex: 0.9, valor: (l) => (l.baixado_em ? 'Baixada' : 'Pendente') }
    ],
    linhas: detalhe
  });

  rodapePaginas(doc);
  doc.end();
});

router.get('/relatorios/pdf/saidas', async (req, res) => {
  const { inicio, fim } = periodoDoQuery(req);
  const { porForma, detalhe } = await buscarRelatorioSaidas(inicio, fim);
  const valorTotal = detalhe.reduce((soma, d) => soma + Number(d.valor), 0);

  const doc = iniciarPdf(res, `relatorio-saidas_${inicio}_a_${fim}.pdf`);
  cabecalho(doc, {
    titulo: 'Relatório de Saídas',
    subtitulo: `Período: ${formatarDataCurta(inicio)} a ${formatarDataCurta(fim)}`
  });

  tituloSecao(doc, 'Resumo do período');
  linhaResumo(doc, `Despesas: ${detalhe.length}      Valor gasto: ${formatarMoeda(valorTotal)}`);
  doc.moveDown(1);

  tituloSecao(doc, 'Por forma de pagamento');
  tabela(doc, {
    colunas: [
      { titulo: 'Forma', campo: 'forma_pagamento', flex: 1.5 },
      { titulo: 'Despesas', campo: 'total_despesas', flex: 1, align: 'right' },
      { titulo: 'Valor', flex: 1.5, align: 'right', valor: (l) => formatarMoeda(l.valor_total) }
    ],
    linhas: porForma
  });

  tituloSecao(doc, `Detalhe das despesas (${detalhe.length})`);
  tabela(doc, {
    colunas: [
      { titulo: 'Data', flex: 1.2, valor: (l) => formatarDataHora(l.criado_em) },
      { titulo: 'Descrição', campo: 'descricao', flex: 1.8 },
      { titulo: 'Para onde foi', flex: 1.4, valor: (l) => truncar(l.destino, 25) },
      { titulo: 'Motivo', flex: 1.4, valor: (l) => truncar(l.motivo, 25) },
      { titulo: 'Saiu de', campo: 'forma_pagamento', flex: 1 },
      { titulo: 'Valor', flex: 1, align: 'right', valor: (l) => formatarMoeda(l.valor) },
      { titulo: 'Lançado por', campo: 'registrado_por', flex: 1.2 }
    ],
    linhas: detalhe
  });

  rodapePaginas(doc);
  doc.end();
});

module.exports = router;
