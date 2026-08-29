-- Limpeza pra deixar o sistema "zerado" pro cliente começar a usar de verdade.
--
-- MANTÉM: produtos (catálogo), preços, e os logins (usuarios).
-- APAGA:  clientes, pedidos/O.S., itens de pedido, movimentações de estoque
--         e entregadores — ou seja, todo o histórico de teste.
-- ZERA:   a quantidade de cheios/vazios de cada produto (volta pra 0 — o
--         cliente faz a contagem física real e ajusta em Estoque > Corrigir).
--
-- IMPORTANTE: faça um backup antes de rodar isso (é uma exclusão permanente).
--   export $(grep DATABASE_URL .env) && PASTA_BACKUP=/home/manutencao/distribuidora-gas/backups bash scripts/backup-diario.sh
--
-- Como rodar:
--   psql "$DATABASE_URL" -f scripts/limpar-para-producao.sql

BEGIN;

-- Mostra o que existe antes de apagar, só pra registro/conferência
SELECT
  (SELECT COUNT(*) FROM clientes)          AS clientes,
  (SELECT COUNT(*) FROM pedidos)           AS pedidos,
  (SELECT COUNT(*) FROM itens_pedido)      AS itens_pedido,
  (SELECT COUNT(*) FROM movimentos_estoque) AS movimentos_estoque,
  (SELECT COUNT(*) FROM entregadores)      AS entregadores,
  (SELECT COUNT(*) FROM produtos)          AS produtos_mantidos,
  (SELECT COUNT(*) FROM precos)            AS precos_mantidos;

-- itens_pedido já seria apagado em cascata ao apagar pedidos, mas fazemos
-- explícito pra deixar claro a ordem.
DELETE FROM itens_pedido;
DELETE FROM movimentos_estoque;
DELETE FROM pedidos;
DELETE FROM clientes;
DELETE FROM entregadores; -- também apaga o histórico de localização deles (cascata)

-- Zera as quantidades de estoque (mantém o produto, tipo e preço cadastrados)
UPDATE produtos SET qtd_cheios = 0, qtd_vazios = 0, atualizado_em = NOW();

-- Deixa os próximos números (O.S., etc.) começando do 1 de novo, pra ficar
-- com cara de sistema novo mesmo.
ALTER SEQUENCE pedidos_id_seq RESTART WITH 1;
ALTER SEQUENCE itens_pedido_id_seq RESTART WITH 1;
ALTER SEQUENCE clientes_id_seq RESTART WITH 1;
ALTER SEQUENCE entregadores_id_seq RESTART WITH 1;
ALTER SEQUENCE movimentos_estoque_id_seq RESTART WITH 1;

-- Confere o resultado antes de confirmar de vez
SELECT
  (SELECT COUNT(*) FROM clientes)          AS clientes,
  (SELECT COUNT(*) FROM pedidos)           AS pedidos,
  (SELECT COUNT(*) FROM itens_pedido)      AS itens_pedido,
  (SELECT COUNT(*) FROM movimentos_estoque) AS movimentos_estoque,
  (SELECT COUNT(*) FROM entregadores)      AS entregadores,
  (SELECT COUNT(*) FROM produtos)          AS produtos_mantidos,
  (SELECT COUNT(*) FROM precos)            AS precos_mantidos;

COMMIT;
