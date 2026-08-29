# Guia de deploy — GitHub → servidor do cliente

## 1. Subir as atualizações pro GitHub (mesmo repositório de sempre)

A pasta que você tem no seu computador (a que eu te mandei) ainda não é um repositório Git — mas o repositório `adaltomotog3-hash/distribuidora-gas` já existe no GitHub (é o que o Render usa). Pra ligar essa pasta a ele sem perder nem duplicar nada, no terminal do VS Code (já aberto na pasta `distribuidora`), rode um de cada vez:

```
git init
git remote add origin https://github.com/adaltomotog3-hash/distribuidora-gas.git
git fetch origin
git reset origin/main
```

Isso não mexe em nenhum arquivo seu — só "liga" a pasta ao histórico que já existe no GitHub, pra o Git saber comparar o que mudou. Depois disso, dá pra conferir o que vai ser enviado:

```
git status
```

(vai listar os arquivos alterados — não deve aparecer `.env` nem `node_modules` nessa lista; se aparecer, para e me chama antes de continuar)

Aí sim, envia:

```
git add .
git commit -m "Ajustes da versao de entrega: seguranca, bugs, visual, backup"
git push origin main
```

No `git push`, o Windows/VS Code deve abrir uma tela pedindo pra você entrar com sua conta do GitHub (se ainda não estiver logado) — é o processo normal e seguro do próprio Git, você loga direto com o GitHub, sem passar sua senha por mim nem por ninguém.

Se o Render estiver com deploy automático ligado nesse repositório, ele vai atualizar sozinho assim que o push terminar — vale a pena checar o painel do Render depois pra confirmar que subiu sem erro.

## 2. Levar pro servidor do cliente

### Se é a primeira vez nesse servidor (instalação nova)

Depois de logar no servidor do cliente por SSH:

```
# Instalar Node.js (se ainda não tiver)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clonar o projeto
git clone https://github.com/adaltomotog3-hash/distribuidora-gas.git
cd distribuidora-gas
npm install --omit=dev

# Configurar o .env (se o Postgres for local nesse servidor, confirme antes se já está instalado e rodando)
cp .env.example .env
nano .env   # preencha DATABASE_URL, SESSION_SECRET e JWT_SECRET de verdade
```

Pra manter o sistema rodando sempre (mesmo depois de reiniciar o servidor), o mais simples é usar o `pm2`:

```
sudo npm install -g pm2
pm2 start server.js --name distribuidora
pm2 save
pm2 startup   # ele mostra um comando pra copiar e rodar — copie e rode
```

Depois é só apontar o túnel Cloudflare (`cloudflared`) pra porta que o `.env` definiu (`PORT`, padrão 3001) — se o túnel já existir de antes, só confirma se está apontando pra essa mesma porta.

Por fim, configure o backup automático (script já vem no projeto):

```
chmod +x scripts/backup-diario.sh
crontab -e
```

E adicione a linha (roda todo dia às 3h da manhã):
```
0 3 * * * DATABASE_URL="sua_database_url_aqui" /caminho/completo/para/distribuidora-gas/scripts/backup-diario.sh >> /caminho/completo/para/distribuidora-gas/backup.log 2>&1
```

### Se o sistema já está rodando nesse servidor (é só atualizar)

```
cd distribuidora-gas
git pull origin main
npm install --omit=dev
pm2 restart distribuidora
```

Se o `.env` já existe nesse servidor, não mexe nele — o `git pull` nunca sobrescreve o `.env` (ele fica de fora do Git de propósito).

## 3. Checklist rápido depois de subir

- [ ] Login no painel funciona (`/login`)
- [ ] Consegue abrir um carrinho, adicionar item e fechar um pedido de teste
- [ ] O.S. aparece certinho em **O.S.**
- [ ] **Financeiro** e **Relatórios** carregam sem erro
- [ ] Backup diário configurado e testado uma vez manualmente (`bash scripts/backup-diario.sh`)
