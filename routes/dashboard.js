const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  const pendentesResult = await pool.query(`
    SELECT v.*, c.nome AS cliente_nome
    FROM vendas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE v.status = 'aguardando_vazio'
    ORDER BY v.criado_em ASC
  `);

  const estoqueResult = await pool.query('SELECT * FROM estoque WHERE id = 1');

  const resumoHojeResult = await pool.query(`
    SELECT COUNT(*)::int AS total_vendas, COALESCE(SUM(preco), 0) AS total_valor
    FROM vendas
    WHERE criado_em::date = CURRENT_DATE
  `);

  res.render('dashboard', {
    pendentes: pendentesResult.rows,
    estoque: estoqueResult.rows[0],
    resumoHoje: resumoHojeResult.rows[0]
  });
});

module.exports = router;
