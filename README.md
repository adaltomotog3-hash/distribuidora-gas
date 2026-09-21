# Sistema da Distribuidora de Gás e Água

## O que o sistema faz

- **Painel**: estoque de gás e de água, pedidos fechados hoje, O.S. aguardando entrega e itens aguardando o vasilhame vazio voltar.
- **Pedidos**: é o carrinho de compras. Abre um pedido (pra um cliente cadastrado ou só com um nome), vai adicionando itens (gás e água, com ou sem troca, quantidade) enquanto o cliente pede, e quando fecha, vira uma O.S. e já desconta do estoque.
- **Clientes**: cadastro completo — nome, telefone, observação e um endereço detalhado (CEP com busca automática, rua, número, complemento, bairro, cidade, UF, ponto de referência e a localização exata marcada num mapa).
- **Estoque (Gás)** e **Estoque (Água)**: entrada de cheios (compra do fornecedor) e controle de vazios, cada um na sua aba.
- **Preços**: define o preço da troca e do sem-troca, separado para Gás e para Água — usado automaticamente quando um item é adicionado ao carrinho.
- **O.S.**: histórico de todas as O.S. — as que estão em aberto (aguardando entrega) e as que já foram finalizadas, com endereço, entregador e local da entrega. É aqui que se acompanha o andamento das entregas.
- **Financeiro**: total vendido num intervalo de datas escolhido, separado por forma de pagamento, por tipo de item e **por produto (Gás x Água)**.
- **Relatórios**: relatório de Vendas e relatório Financeiro, cada um podendo ser visto por dia, semana, quinzena, mês ou ano — pra acompanhar a evolução ao longo do tempo, sem precisar ficar mudando datas manualmente.
- **Entregador**: cadastro do login usado pelo entregador no aplicativo do celular.
- **Rastreio**: mapa com a localização atual do entregador e os pontos de cada O.S. finalizada no dia.

### Como funciona o carrinho, a O.S. e a localização

1. Em **Pedidos**, clique em "Abrir carrinho" — escolha um cliente cadastrado ou só digite um nome pra identificar (ex: "Seu João da esquina").
2. Vá adicionando os itens que o cliente for pedindo (produto, com/sem troca, quantidade) — cada item cai na hora no carrinho.
3. O carrinho fica salvo em aberto o tempo todo — dá pra atender outro cliente no meio e voltar depois (a lista de "Carrinhos em aberto" mostra todos).
4. Quando o cliente fechar o pedido, escolha a forma de pagamento (e o endereço de entrega, se for diferente do cadastrado) e aperte **Fechar pedido**. Isso já desconta do estoque e gera a O.S.
5. A O.S. cai direto no aplicativo do celular do entregador (pasta `app-entregador`, projeto separado em Expo/React Native), com todos os itens daquele pedido, o cliente e o endereço. E também aparece na aba **O.S.** do painel, na lista "em aberto".
6. Ao concluir a entrega, o entregador aperta **Finalizar entrega** no app — ele pega a localização do GPS na hora e envia pro sistema. A O.S. passa da lista "em aberto" pra "finalizadas" na aba **O.S.**, com um link "ver no mapa", e também aparece no mapa de **Rastreio**.

Enquanto o entregador está com o app aberto e o rastreio ligado, a localização dele também é enviada periodicamente (a cada 30s) e aparece em tempo real no mapa de **Rastreio**.

### Finalizar uma O.S. direto pelo painel (sem o app)

Além do app, dá pra finalizar uma entrega direto do painel — útil em qualquer situação em que o entregador não estiver com o app à mão. Tem um botão **Finalizar** na lista de "O.S. em aberto" (aba **O.S.**) e também dentro da própria O.S. Ao clicar, o navegador pede permissão de localização e, se autorizada, salva o ponto exato junto com a entrega — do mesmo jeito que o app faz. Se a localização não for autorizada, a O.S. é finalizada mesmo assim, só sem o ponto no mapa. Quando finalizada assim (sem entregador logado no app), aparece "Escritório" no lugar do nome do entregador.

### Endereço do cliente

No cadastro (e na edição) do cliente, o campo CEP tem um botão **Buscar** que preenche rua, bairro, cidade e UF automaticamente. O botão **📍 Marcar no mapa** abre um mapa pra clicar exatamente em cima da casa/local de entrega — isso fica salvo nas coordenadas do cliente e passa a aparecer como um link "mapa" na aba O.S., mesmo antes de qualquer entrega ser finalizada. Clientes cadastrados antes dessa atualização continuam funcionando normalmente — o endereço antigo (texto livre) some só se for reescrito.

### Login criado na primeira vez que o sistema rodar

Numa instalação nova (banco sem nenhum usuário), o sistema cria um usuário `admin` com uma **senha aleatória**, mostrada **uma única vez** no log de inicialização (`pm2 logs`). Anote na hora. Não existe mais nenhuma senha padrão fixa (o código é público, então uma senha fixa seria conhecida por todos).

Para criar outro usuário ou trocar a senha de um existente, rode dentro da pasta do projeto:

```
node gerenciar-usuario.js NOME_DO_USUARIO
```

O script pergunta a senha no terminal (ela não aparece na tela nem fica salva em arquivo). O cadastro/redefinição de senha do entregador fica em **Entregador**, dentro do painel.

## Rodando no seu computador (para testar)

1. Instale as dependências:
   ```
   npm install
   ```
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL` com um banco Postgres.
3. Defina também `JWT_SECRET` no `.env` — é o segredo usado para validar o login do aplicativo do entregador (qualquer frase longa e aleatória serve).
4. Rode:
   ```
   npm start
   ```
5. Acesse `http://localhost:3001` (ou a porta que você definir em `PORT`) no navegador.

## Migração de um banco que já existe (cliente já usando o sistema)

Não precisa fazer nada manualmente: o sistema roda as migrações sozinho toda vez que inicia (arquivo `db/init.js`). Ele:

- Adiciona as colunas e tabelas novas sem apagar nada que já existia;
- Se já existiam vendas no formato antigo (uma venda = um item), migra cada uma delas pra um pedido novo, com um item só — o histórico continua todo lá;
- Mantém os preços que já estavam cadastrados;
- Cria os preços de água que ainda não existirem (com valor R$ 0,00 — é só ajustar em **Preços**).

Isso já foi testado simulando um banco antigo, com dados de verdade dentro (venda de gás concluída, venda de água aguardando o vazio voltar), rodando a migração em cima — os dados continuaram intactos e viraram pedidos corretamente.

## Colocando no ar

Siga o mesmo processo que você já usa (Render, ou o servidor local/Ubuntu do cliente com o túnel Cloudflare). Só não esqueça de adicionar a variável `JWT_SECRET` nas variáveis de ambiente do serviço, além das que já existiam (`DATABASE_URL`, `SESSION_SECRET`). Use o arquivo `.env.example` como referência de tudo que precisa estar preenchido — inclusive tem o comando pra gerar uma frase aleatória forte pro `SESSION_SECRET`/`JWT_SECRET`.

**Importante pra instalação já existente (Render):** confira se o `SESSION_SECRET` de lá já foi trocado pela frase de exemplo do repositório (`troque-esta-frase-por-algo-so-seu`) e se existe um `JWT_SECRET` configurado — sem ele, o sistema usa um valor padrão fixo que fica público no código-fonte, o que enfraquece a segurança do login do entregador. A variável `ADMIN_PASSWORD` não é usada em nenhum lugar do sistema e pode ser removida das variáveis de ambiente.

## Backup diário do banco de dados

Se o sistema for rodar no servidor do próprio cliente (não no Render), o banco de dados fica só naquela máquina — então é essencial ter um backup automático, senão um problema no servidor (disco, atualização do sistema, etc.) pode apagar todo o histórico de vendas.

Tem um script pronto em `scripts/backup-diario.sh`: ele gera um dump completo do banco todo dia (compactado), guarda numa pasta e apaga sozinho backups com mais de 30 dias. As instruções de como instalar (crontab) estão comentadas no topo do próprio arquivo. Depois de configurado, o ideal é copiar a pasta de backups pra fora do servidor de vez em quando (um HD externo, um Google Drive, etc.) — um backup que só existe na mesma máquina não protege se o servidor inteiro tiver um problema físico.

Se o sistema continuar no Render, o próprio banco gerenciado do Render já faz backup automático — não precisa desse script, mas não custa nada ter ele rodando também como uma segunda camada de segurança.

## Aplicativo do entregador

Fica num projeto separado, na pasta `app-entregador` (Expo/React Native). Veja o `README.md` dentro dela para instruções de como testar e gerar o `.apk`/publicar.

## Deixando o sistema mais profissional

- **Mensagens de confirmação**: cada ação (cadastrar, fechar pedido, atualizar preço, etc.) mostra uma faixa verde de sucesso ou vermelha de erro, em vez de simplesmente redirecionar sem avisar nada.
- **Página de erro própria**: se alguém acessar um link que não existe (ou algo der errado no servidor), aparece uma página com a cara do sistema em vez do erro cru do Node.
- **Cabeçalhos de segurança** (`helmet`): protege contra alguns ataques comuns de navegador (clickjacking, sniffing de tipo de arquivo).
- **Ícones no menu lateral** e ajustes visuais (sombra leve nos cards/tabelas, tabelas com rolagem horizontal no celular).
- **Comprovante para impressão**: em qualquer O.S. já fechada, tem um botão "Imprimir comprovante" que gera uma versão limpa (sem menu, sem botões) pronta pra imprimir ou salvar em PDF.

## Ajustes da versão de entrega

- **Visual renovado**: espaçamento, sombras, tipografia e cores revisados em todas as telas (menu lateral, botões, cards, tabelas, tela de login) pra dar uma cara mais moderna e "de produto pronto", sem mudar as cores/identidade visual do sistema.
- **Estoque mais compacto**: os produtos aparecem em linhas mais finas — pensado pra quando o catálogo crescer bastante e continuar com boa aparência.
- **Cancelar x Excluir nos carrinhos**: em **Pedidos**, um carrinho aberto agora tem duas opções separadas — **Cancelar** (fica registrado em **O.S. > Canceladas**, com motivo opcional) e **Excluir** (remove de vez, sem deixar histórico — útil pra carrinho de teste ou engano).
- **Correção no Financeiro**: o card "Por forma de pagamento" estava somando o valor bruto da venda, sem descontar o desconto do pedido — podia mostrar mais dinheiro do que realmente entrou naquela forma de pagamento. Agora o valor mostrado é sempre o líquido (já com desconto), batendo com o "Valor total do período".
- **Relatórios com resumo**: as abas de Vendas e Financeiro ganharam cards de resumo (soma dos períodos listados) no topo, no mesmo estilo das outras telas.
- **Segurança**: bloqueio automático depois de várias tentativas erradas de login (painel e app do entregador); cookie de sessão marcado como seguro quando o acesso é por HTTPS (Render / túnel Cloudflare); validação de campos obrigatórios ao cadastrar entregador.
- **Limpeza**: removida a tela antiga de "Vendas" (`/vendas`), que não estava mais ligada a nenhum menu desde que o sistema passou a usar o carrinho/pedidos — ficava sobrando no código sem ser usada em lugar nenhum.
- **Telefone do cliente não vira link estranho**: em celulares (principalmente iPhone), o navegador detectava sozinho números de telefone no meio do texto e transformava em link azul sublinhado, sem ter sido feito de propósito — corrigido.
- **Validações extras**: cadastro de cliente agora exige nome preenchido (evitava "cliente fantasma" sem nome na lista); preço agora aceita vírgula ou ponto e nunca deixa passar valor inválido.
- **Backup diário**: script pronto (`scripts/backup-diario.sh`) pra quando o sistema rodar no servidor do próprio cliente — ver seção "Backup diário do banco de dados" abaixo.
