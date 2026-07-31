# Sistema da Distribuidora de Gás

## O que o sistema faz
- **Painel**: mostra quantos botijões cheios/vazios tem em estoque, quanto foi vendido hoje, e a lista de entregas que ainda estão **aguardando o botijão vazio voltar**.
- **Vendas**: registra cada venda (com troca ou sem troca), com forma de pagamento e observação livre. Toda venda "com troca" entra automaticamente como pendente até você confirmar que o vazio voltou.
- **Clientes**: cadastro simples (nome, telefone, endereço, observação).
- **Estoque**: entrada de botijões cheios (compra do fornecedor) e controle de vazios.
- **Preços**: você define o preço da troca e do botijão sem troca — as vendas usam esse valor automaticamente.
- **Financeiro**: total vendido por período, separado por forma de pagamento e por tipo de venda.

O login padrão criado na primeira vez que o sistema rodar é:
- usuário: `admin`
- senha: o que você colocar em `ADMIN_PASSWORD` no `.env` (padrão: `admin123`, troque depois de entrar)

## Rodando no seu computador (para testar)

1. Instale as dependências:
   ```
   npm install
   ```
2. Copie `.env.example` para `.env` e preencha o `DATABASE_URL` com um banco Postgres (pode ser um Postgres gratuito do Render, veja abaixo).
3. Rode:
   ```
   npm start
   ```
4. Acesse `http://localhost:3000` no navegador.

## Colocando no ar (Render, do mesmo jeito que seus outros sistemas)

1. Suba esta pasta para um repositório no GitHub (igual você já fez com o EA Cell e o Estoque RG).
2. No Render, crie um banco: **New > PostgreSQL** (plano free). Depois de criado, copie a "Internal Database URL".
3. Crie o serviço web: **New > Web Service**, aponte para o repositório.
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Em "Environment", adicione as variáveis:
   - `DATABASE_URL` = a Internal Database URL do passo 2
   - `SESSION_SECRET` = qualquer frase secreta
   - `ADMIN_PASSWORD` = a senha que você quer para o usuário admin
5. Deploy. Na primeira vez que o sistema subir, ele cria sozinho as tabelas e o usuário admin.

**Por que Postgres em vez de SQLite (como nos outros sistemas):** o Postgres do Render é um banco de verdade, separado do seu app — os dados não se perdem quando o serviço reinicia (diferente do SQLite, que ficava no disco do próprio app e resetava). É a opção mais profissional para um sistema que vai lidar com vendas e estoque de um cliente.
