const bcrypt = require('bcrypt');
const pool = require('./pool');

// --- Helpers de migração (pra poder rodar em bancos que já existem, sem perder dado) ---

async function columnExists(tabela, coluna) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [tabela, coluna]
  );
  return rows.length > 0;
}

async function constraintExists(nome) {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [nome]
  );
  return rows.length > 0;
}

async function initDb() {
  // Tabelas originais do sistema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT,
      endereco TEXT,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS precos (
      id SERIAL PRIMARY KEY,
      tipo_venda TEXT NOT NULL, -- 'troca' ou 'sem_troca'
      descricao TEXT NOT NULL,
      preco NUMERIC(10,2) NOT NULL,
      atualizado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS estoque (
      id INT PRIMARY KEY DEFAULT 1,
      qtd_cheios INT NOT NULL DEFAULT 0,
      qtd_vazios INT NOT NULL DEFAULT 0,
      atualizado_em TIMESTAMP DEFAULT NOW(),
      CONSTRAINT unica_linha CHECK (id = 1)
    );

    CREATE TABLE IF NOT EXISTS movimentos_estoque (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL, -- 'entrada_cheio', 'entrada_vazio', 'saida_cheio', 'saida_vazio'
      quantidade INT NOT NULL,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
      tipo_venda TEXT NOT NULL, -- 'troca' ou 'sem_troca'
      forma_pagamento TEXT NOT NULL, -- 'dinheiro', 'pix', 'cartao', 'fiado'
      preco NUMERIC(10,2) NOT NULL,
      observacao TEXT,
      status TEXT NOT NULL DEFAULT 'concluida', -- 'aguardando_vazio' ou 'concluida'
      criado_em TIMESTAMP DEFAULT NOW(),
      concluido_em TIMESTAMP
    );
  `);

  // --- MIGRAÇÃO: módulo de ÁGUA (produto gás/água em preços, vendas e movimentações) ---

  if (!(await columnExists('precos', 'produto'))) {
    await pool.query(`ALTER TABLE precos ADD COLUMN produto TEXT NOT NULL DEFAULT 'gas'`);
  }
  // Antes só existia "tipo_venda" único.
  // Removemos essa restrição antiga porque agora cada produto terá seus próprios preços.
  if (await constraintExists('precos_tipo_venda_key')) {
    await pool.query(`ALTER TABLE precos DROP CONSTRAINT precos_tipo_venda_key`);
  }
  // NÃO criamos aqui a constraint:
  // precos_produto_tipo_venda_key
  //
  // Ela será criada mais abaixo usando produto_id + tipo_venda,
  // depois que os preços antigos forem associados aos produtos.
  //
  // Isso evita erro caso o banco antigo já possua registros duplicados
  // em (produto, tipo_venda).

  if (!(await columnExists('vendas', 'produto'))) {
    await pool.query(`ALTER TABLE vendas ADD COLUMN produto TEXT NOT NULL DEFAULT 'gas'`);
  }

  if (!(await columnExists('movimentos_estoque', 'produto'))) {
    await pool.query(`ALTER TABLE movimentos_estoque ADD COLUMN produto TEXT NOT NULL DEFAULT 'gas'`);
  }

  // Estoque de água (galões cheios/vazios), no mesmo formato do estoque de gás
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estoque_agua (
      id INT PRIMARY KEY DEFAULT 1,
      qtd_cheios INT NOT NULL DEFAULT 0,
      qtd_vazios INT NOT NULL DEFAULT 0,
      atualizado_em TIMESTAMP DEFAULT NOW(),
      CONSTRAINT unica_linha_agua CHECK (id = 1)
    );
  `);

  // --- MIGRAÇÃO: endereço completo do cliente (CEP, número, bairro, cidade, coordenadas) ---
  // O campo "endereco" antigo (texto livre) continua existindo e guarda a rua —
  // esses campos novos só se somam a ele, nada é apagado nem sobrescrito.
  const colunasEnderecoCliente = [
    ['cep', 'TEXT'],
    ['numero', 'TEXT'],
    ['complemento', 'TEXT'],
    ['bairro', 'TEXT'],
    ['cidade', 'TEXT'],
    ['uf', 'TEXT'],
    ['referencia', 'TEXT'],
    ['latitude', 'NUMERIC(10,6)'],
    ['longitude', 'NUMERIC(10,6)']
  ];
  for (const [coluna, definicao] of colunasEnderecoCliente) {
    if (!(await columnExists('clientes', coluna))) {
      await pool.query(`ALTER TABLE clientes ADD COLUMN ${coluna} ${definicao}`);
    }
  }

  // --- MIGRAÇÃO: entregador, O.S. de entrega e rastreio ---

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entregadores (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      ultima_lat NUMERIC(10,6),
      ultima_lng NUMERIC(10,6),
      ultima_localizacao_em TIMESTAMP,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS localizacoes_entregador (
      id SERIAL PRIMARY KEY,
      entregador_id INT NOT NULL REFERENCES entregadores(id) ON DELETE CASCADE,
      latitude NUMERIC(10,6) NOT NULL,
      longitude NUMERIC(10,6) NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  // Cada venda passa a ser também a "O.S." de entrega: quem entregou, se já foi
  // entregue e onde (localização capturada no celular na hora de finalizar).
  const colunasEntrega = [
    ['entregador_id', 'INT REFERENCES entregadores(id) ON DELETE SET NULL'],
    ['entrega_status', `TEXT NOT NULL DEFAULT 'pendente'`], // 'pendente' ou 'entregue'
    ['entrega_lat', 'NUMERIC(10,6)'],
    ['entrega_lng', 'NUMERIC(10,6)'],
    ['entregue_em', 'TIMESTAMP'],
    // Endereço digitado na hora da venda (opcional). Quando vazio, o app do
    // entregador usa o endereço cadastrado no cliente.
    ['endereco_entrega', 'TEXT']
  ];
  for (const [coluna, definicao] of colunasEntrega) {
    if (!(await columnExists('vendas', coluna))) {
      await pool.query(`ALTER TABLE vendas ADD COLUMN ${coluna} ${definicao}`);
    }
  }

  // --- MIGRAÇÃO: carrinho de compras (pedido com vários itens) ---
  // Antes, cada "venda" era só um item. Agora vira um "pedido" (carrinho), que
  // pode ter vários itens (gás e água misturados) até o atendente fechar.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
      nome_avulso TEXT, -- nome digitado quando não tem cliente cadastrado (identifica o carrinho)
      forma_pagamento TEXT,
      observacao TEXT,
      endereco_entrega TEXT,
      status TEXT NOT NULL DEFAULT 'aberto', -- 'aberto' (carrinho) ou 'fechado' (virou O.S.)
      entrega_status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente' ou 'entregue'
      entregador_id INT REFERENCES entregadores(id) ON DELETE SET NULL,
      entrega_lat NUMERIC(10,6),
      entrega_lng NUMERIC(10,6),
      entregue_em TIMESTAMP,
      criado_em TIMESTAMP DEFAULT NOW(),
      fechado_em TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS itens_pedido (
      id SERIAL PRIMARY KEY,
      pedido_id INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      produto TEXT NOT NULL, -- 'gas' ou 'agua'
      tipo_venda TEXT NOT NULL, -- 'troca' ou 'sem_troca'
      quantidade INT NOT NULL DEFAULT 1,
      preco_unitario NUMERIC(10,2) NOT NULL,
      status_troca TEXT NOT NULL DEFAULT 'concluida', -- 'aguardando_vazio' ou 'concluida'
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migração única: se ainda não existe nenhum pedido, mas já existiam vendas
  // no formato antigo (uma venda = um item), traz esse histórico pro novo
  // formato (um pedido com um item só), sem perder nada.
  const totalPedidosResult = await pool.query('SELECT COUNT(*)::int AS total FROM pedidos');
  if (totalPedidosResult.rows[0].total === 0) {
    const vendasAntigas = await pool.query('SELECT * FROM vendas ORDER BY id ASC');
    for (const v of vendasAntigas.rows) {
      const pedidoResult = await pool.query(
        `INSERT INTO pedidos
           (cliente_id, forma_pagamento, observacao, endereco_entrega, status, entrega_status,
            entregador_id, entrega_lat, entrega_lng, entregue_em, criado_em, fechado_em)
         VALUES ($1, $2, $3, $4, 'fechado', $5, $6, $7, $8, $9, $10, $10)
         RETURNING id`,
        [
          v.cliente_id, v.forma_pagamento, v.observacao, v.endereco_entrega, v.entrega_status,
          v.entregador_id, v.entrega_lat, v.entrega_lng, v.entregue_em, v.criado_em
        ]
      );
      await pool.query(
        `INSERT INTO itens_pedido (pedido_id, produto, tipo_venda, quantidade, preco_unitario, status_troca, criado_em)
         VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [
          pedidoResult.rows[0].id, v.produto, v.tipo_venda, v.preco,
          v.status === 'aguardando_vazio' ? 'aguardando_vazio' : 'concluida', v.criado_em
        ]
      );
    }
    if (vendasAntigas.rows.length > 0) {
      console.log('>> Migradas ' + vendasAntigas.rows.length + ' vendas antigas para o novo formato de pedido/carrinho.');
    }
  }

  // Garante a linha única de estoque de gás e de água
  await pool.query(`
    INSERT INTO estoque (id, qtd_cheios, qtd_vazios)
    VALUES (1, 0, 0)
    ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO estoque_agua (id, qtd_cheios, qtd_vazios)
    VALUES (1, 0, 0)
    ON CONFLICT (id) DO NOTHING;
  `);

  // (Os preços padrão de gás e água são garantidos mais abaixo, já usando o
  // catálogo de produtos — ver migração "catálogo de produtos".)

  // Cria os usuários padrão do painel (admin) se ainda não existir nenhum
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
  if (rows[0].total === 0) {
    const usuariosPadrao = [
      { username: 'tiago', senha: '1122' },
      { username: 'lourinho', senha: 'admin123' }
    ];
    for (const u of usuariosPadrao) {
      const hash = await bcrypt.hash(u.senha, 10);
      await pool.query(
        'INSERT INTO usuarios (username, senha_hash) VALUES ($1, $2)',
        [u.username, hash]
      );
      console.log('>> Usuario padrao criado: ' + u.username + ' / ' + u.senha);
    }
  }

  // Cria um entregador padrão de teste, se ainda não existir nenhum
  const entregadoresResult = await pool.query('SELECT COUNT(*)::int AS total FROM entregadores');
  if (entregadoresResult.rows[0].total === 0) {
    const senhaPadrao = 'entrega123';
    const hash = await bcrypt.hash(senhaPadrao, 10);
    await pool.query(
      'INSERT INTO entregadores (nome, username, senha_hash) VALUES ($1, $2, $3)',
      ['Entregador', 'entregador', hash]
    );
    console.log('>> Entregador padrao criado (login do APP): entregador / ' + senhaPadrao);
  }

  // --- MIGRAÇÃO: catálogo de produtos (tipos/tamanhos que o próprio cliente edita) ---
  // Antes só existia UM tipo de gás e UM tipo de água (tabelas "estoque" e
  // "estoque_agua", uma linha só). Agora vira um catálogo: pode ter vários
  // produtos (ex: P13, P20, Galão 20L, Copo 300ml), cada um com seu próprio
  // estoque de cheios/vazios, e o cliente pode criar/editar isso pelo painel.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL, -- 'gas' ou 'agua' (categoria, usada nos relatórios)
      nome TEXT NOT NULL, -- ex: "P13", "Galão 20L", "Copo 300ml"
      qtd_cheios INT NOT NULL DEFAULT 0,
      qtd_vazios INT NOT NULL DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  const totalProdutosResult = await pool.query('SELECT COUNT(*)::int AS total FROM produtos');
  let produtoGasPadraoId = null;
  let produtoAguaPadraoId = null;

  if (totalProdutosResult.rows[0].total === 0) {
    // Primeira vez rodando essa migração: cria os produtos "padrão" puxando
    // o estoque que já existia nas tabelas antigas, pra não perder nada do
    // que o cliente já tinha cadastrado.
    const estoqueAntigoResult = await pool.query('SELECT * FROM estoque WHERE id = 1');
    const estoqueAguaAntigoResult = await pool.query('SELECT * FROM estoque_agua WHERE id = 1');
    const estoqueAntigo = estoqueAntigoResult.rows[0] || { qtd_cheios: 0, qtd_vazios: 0 };
    const estoqueAguaAntigo = estoqueAguaAntigoResult.rows[0] || { qtd_cheios: 0, qtd_vazios: 0 };

    const gasResult = await pool.query(
      `INSERT INTO produtos (tipo, nome, qtd_cheios, qtd_vazios) VALUES ('gas', 'Botijão (padrão)', $1, $2) RETURNING id`,
      [estoqueAntigo.qtd_cheios, estoqueAntigo.qtd_vazios]
    );
    produtoGasPadraoId = gasResult.rows[0].id;

    const aguaResult = await pool.query(
      `INSERT INTO produtos (tipo, nome, qtd_cheios, qtd_vazios) VALUES ('agua', 'Galão (padrão)', $1, $2) RETURNING id`,
      [estoqueAguaAntigo.qtd_cheios, estoqueAguaAntigo.qtd_vazios]
    );
    produtoAguaPadraoId = aguaResult.rows[0].id;

    console.log('>> Catálogo de produtos criado a partir do estoque antigo (Botijão e Galão padrão).');
  } else {
    const padraoGas = await pool.query(`SELECT id FROM produtos WHERE tipo = 'gas' ORDER BY id ASC LIMIT 1`);
    const padraoAgua = await pool.query(`SELECT id FROM produtos WHERE tipo = 'agua' ORDER BY id ASC LIMIT 1`);
    produtoGasPadraoId = padraoGas.rows[0] ? padraoGas.rows[0].id : null;
    produtoAguaPadraoId = padraoAgua.rows[0] ? padraoAgua.rows[0].id : null;
  }

  function produtoPadraoPorTipo(tipo) {
    return tipo === 'agua' ? produtoAguaPadraoId : produtoGasPadraoId;
  }

  // precos passa a apontar pra um produto específico (produto_id), não mais só a categoria
  if (!(await columnExists('precos', 'produto_id'))) {
    await pool.query(`ALTER TABLE precos ADD COLUMN produto_id INT REFERENCES produtos(id) ON DELETE CASCADE`);
    const precosSemProdutoId = await pool.query('SELECT id, produto FROM precos WHERE produto_id IS NULL');
    for (const p of precosSemProdutoId.rows) {
      const produtoId = produtoPadraoPorTipo(p.produto);
      if (produtoId) {
        await pool.query('UPDATE precos SET produto_id = $1 WHERE id = $2', [produtoId, p.id]);
      }
    }
  }
  // Se existir a constraint antiga de produto + tipo_venda,
  // removemos porque agora a chave correta será produto_id + tipo_venda.
  if (await constraintExists('precos_produto_tipo_venda_key')) {
    await pool.query(`ALTER TABLE precos DROP CONSTRAINT precos_produto_tipo_venda_key`);
  }
  // Antes de criar a constraint definitiva, elimina possíveis duplicidades
  // que existam no banco antigo.
  //
  // Mantém, de preferência:
  // 1. o registro que possui preço diferente de zero;
  // 2. entre eles, o mais recentemente atualizado;
  // 3. em último caso, o maior ID.
  //
  // Isso resolve casos como:
  // produto_id = X + tipo_venda = troca aparecendo mais de uma vez.
  await pool.query(`
    WITH duplicados AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY produto_id, tipo_venda
          ORDER BY
            (preco <> 0) DESC,
            atualizado_em DESC NULLS LAST,
            id DESC
        ) AS numero
      FROM precos
      WHERE produto_id IS NOT NULL
    )
    DELETE FROM precos p
    USING duplicados d
    WHERE p.id = d.id
      AND d.numero > 1;
  `);
  // Agora podemos criar a constraint definitiva.
  if (!(await constraintExists('precos_produto_id_tipo_venda_key'))) {
    await pool.query(`ALTER TABLE precos ADD CONSTRAINT precos_produto_id_tipo_venda_key UNIQUE (produto_id, tipo_venda)`);
  }

  // itens_pedido e movimentos_estoque também passam a guardar qual produto específico foi
  if (!(await columnExists('itens_pedido', 'produto_id'))) {
    await pool.query(`ALTER TABLE itens_pedido ADD COLUMN produto_id INT REFERENCES produtos(id) ON DELETE SET NULL`);
    const itensSemProdutoId = await pool.query('SELECT id, produto FROM itens_pedido WHERE produto_id IS NULL');
    for (const i of itensSemProdutoId.rows) {
      const produtoId = produtoPadraoPorTipo(i.produto);
      if (produtoId) {
        await pool.query('UPDATE itens_pedido SET produto_id = $1 WHERE id = $2', [produtoId, i.id]);
      }
    }
  }
  if (!(await columnExists('movimentos_estoque', 'produto_id'))) {
    await pool.query(`ALTER TABLE movimentos_estoque ADD COLUMN produto_id INT REFERENCES produtos(id) ON DELETE SET NULL`);
    const movimentosSemProdutoId = await pool.query('SELECT id, produto FROM movimentos_estoque WHERE produto_id IS NULL');
    for (const m of movimentosSemProdutoId.rows) {
      const produtoId = produtoPadraoPorTipo(m.produto);
      if (produtoId) {
        await pool.query('UPDATE movimentos_estoque SET produto_id = $1 WHERE id = $2', [produtoId, m.id]);
      }
    }
  }

  // Garante que os produtos padrão têm preço cadastrado (troca/sem_troca), pra não
  // quebrar uma venda se por algum motivo ainda não existir.
  if (produtoGasPadraoId) {
    await pool.query(
      `INSERT INTO precos (produto, produto_id, tipo_venda, descricao, preco) VALUES
         ('gas', $1, 'troca', 'Troca (cliente entrega o vazio)', 0),
         ('gas', $1, 'sem_troca', 'Sem troca (casco/vasilhame novo)', 0)
       ON CONFLICT (produto_id, tipo_venda) DO NOTHING`,
      [produtoGasPadraoId]
    );
  }
  if (produtoAguaPadraoId) {
    await pool.query(
      `INSERT INTO precos (produto, produto_id, tipo_venda, descricao, preco) VALUES
         ('agua', $1, 'troca', 'Troca (cliente entrega o vazio)', 0),
         ('agua', $1, 'sem_troca', 'Sem troca (casco/vasilhame novo)', 0)
       ON CONFLICT (produto_id, tipo_venda) DO NOTHING`,
      [produtoAguaPadraoId]
    );
  }

  // --- MIGRAÇÃO: desconto no pedido ---
  if (!(await columnExists('pedidos', 'desconto'))) {
    await pool.query(`ALTER TABLE pedidos ADD COLUMN desconto NUMERIC(10,2) NOT NULL DEFAULT 0`);
  }

  // --- MIGRAÇÃO: cancelamento de pedido/O.S. ---
  // Antes só dava pra cancelar o carrinho (antes de fechar). Agora também dá pra
  // cancelar uma O.S. já fechada (erro de digitação, cliente desistiu etc.) — o
  // status vira 'cancelado' (em vez de excluir a linha) e o estoque que tinha
  // sido baixado no fechamento volta automaticamente.
  const colunasCancelamento = [
    ['cancelado_em', 'TIMESTAMP'],
    ['motivo_cancelamento', 'TEXT']
  ];
  for (const [coluna, definicao] of colunasCancelamento) {
    if (!(await columnExists('pedidos', coluna))) {
      await pool.query(`ALTER TABLE pedidos ADD COLUMN ${coluna} ${definicao}`);
    }
  }

  // --- MIGRAÇÃO: baixa da O.S. pela loja (conferência depois do entregador finalizar) ---
  const colunasBaixa = [
    ['baixado_em', 'TIMESTAMP'],
    ['baixado_por', 'TEXT']
  ];
  for (const [coluna, definicao] of colunasBaixa) {
    if (!(await columnExists('pedidos', coluna))) {
      await pool.query(`ALTER TABLE pedidos ADD COLUMN ${coluna} ${definicao}`);
    }
  }

  // --- MIGRAÇÃO: controle de "Valores a receber" (vendas fiado) ---
  // Quando o pedido é fechado como "fiado", ele fica pendente de pagamento até
  // alguém marcar que o cliente pagou — independente da baixa do vasilhame acima.
  const colunasFiado = [
    ['fiado_pago_em', 'TIMESTAMP'],
    ['forma_pagamento_recebimento', 'TEXT']
  ];
  for (const [coluna, definicao] of colunasFiado) {
    if (!(await columnExists('pedidos', coluna))) {
      await pool.query(`ALTER TABLE pedidos ADD COLUMN ${coluna} ${definicao}`);
    }
  }

  console.log('>> Banco de dados pronto.');
}

module.exports = initDb;
