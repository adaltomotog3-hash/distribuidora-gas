require('dotenv').config();
const express = require('express');
require('express-async-errors'); // faz erros de rotas async caírem no error handler abaixo, em vez de travar o processo
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const initDb = require('./db/init');
const requireLogin = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const clientesRoutes = require('./routes/clientes');
const precosRoutes = require('./routes/precos');
const produtosRoutes = require('./routes/produtos');
const pedidosRoutes = require('./routes/pedidos');
const osRoutes = require('./routes/os');
const financeiroRoutes = require('./routes/financeiro');
const despesasRoutes = require('./routes/despesas');
const relatoriosRoutes = require('./routes/relatorios');
const entregadoresRoutes = require('./routes/entregadores');
const rastreioRoutes = require('./routes/rastreio');
const empresaRoutes = require('./routes/empresa');
const cobrancaRoutes = require('./routes/cobranca');
const apiRoutes = require('./routes/api');
const apiPainelRoutes = require('./routes/apiPainel');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Atrás do Render ou de um túnel Cloudflare, quem recebe a conexão HTTPS de
// verdade é o proxy — o Node só vê HTTP puro por dentro. Isso faz o Express
// confiar no cabeçalho X-Forwarded-Proto que esses dois repassam, pra saber
// quando a conexão é realmente segura (usado logo abaixo no cookie.secure).
app.set('trust proxy', 1);

// Cabeçalhos de segurança padrão. CSP fica desligado porque o sistema usa
// estilos/scripts inline nas páginas e carrega o mapa (Leaflet) de um CDN.
app.use(helmet({ contentSecurityPolicy: false }));

// Compacta (gzip) o HTML/CSS/JS/JSON de cada resposta antes de mandar pro
// navegador — deixa a navegação mais rápida principalmente em conexões mais
// lentas (o túnel Cloudflare / internet do cliente), sem mudar nada no
// código das páginas.
app.use(compression());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  // CSS, imagens e ícones praticamente não mudam — manda o navegador guardar
  // em cache por 7 dias, assim ele para de rebaixar esses arquivos de novo a
  // cada página visitada. Se um dia precisar forçar atualização de algum
  // arquivo estático, basta renomeá-lo (ex: style.css -> style.v2.css).
  maxAge: '7d'
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-troque-isso',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 horas
    // 'auto': manda o cookie só por HTTPS quando o acesso é por HTTPS (Render,
    // túnel Cloudflare) e continua funcionando normal em http://localhost no teste.
    secure: 'auto'
  }
}));

// Mensagens rápidas de sucesso/erro (flash) que sobrevivem a um redirect.
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.setFlash = (tipo, mensagem) => {
    req.session.flash = { tipo, mensagem };
  };
  next();
});

// Rotas de login/logout do painel (não exigem estar logado)
app.use(authRoutes);

// API usada pelo APP do entregador: autenticação própria por token (JWT),
// não usa a sessão/cookie do painel — por isso fica fora do requireLogin.
app.use(apiRoutes);

// API usada pelo APP DO PAINEL (escritório): também autenticação própria
// por token (JWT), separada da sessão/cookie do painel web.
app.use(apiPainelRoutes);

// A partir daqui, exige login no painel (usuário do escritório)
app.use(requireLogin);
app.use(dashboardRoutes);
app.use(clientesRoutes);
app.use(precosRoutes);
app.use(produtosRoutes);
app.use(pedidosRoutes);
app.use(osRoutes);
app.use(financeiroRoutes);
app.use(despesasRoutes);
app.use(relatoriosRoutes);
app.use(entregadoresRoutes);
app.use(rastreioRoutes);
app.use(empresaRoutes);
app.use(cobrancaRoutes);

// Página não encontrada (404)
app.use((req, res) => {
  res.status(404).render('erro', {
    titulo: 'Página não encontrada',
    codigo: 404,
    mensagem: 'A página que você procura não existe ou foi movida.'
  });
});

// Qualquer erro inesperado cai aqui em vez de mostrar o stack trace do Node
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('erro', {
    titulo: 'Erro',
    codigo: 500,
    mensagem: 'Algo deu errado. Tente novamente em instantes.'
  });
});

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`>> Servidor rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Erro ao iniciar o banco de dados:', err);
    process.exit(1);
  });
