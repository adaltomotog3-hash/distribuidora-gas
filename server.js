require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const initDb = require('./db/init');
const requireLogin = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const clientesRoutes = require('./routes/clientes');
const precosRoutes = require('./routes/precos');
const estoqueRoutes = require('./routes/estoque');
const vendasRoutes = require('./routes/vendas');
const financeiroRoutes = require('./routes/financeiro');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-troque-isso',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 } // 12 horas
}));

// Rotas de login/logout (não exigem estar logado)
app.use(authRoutes);

// A partir daqui, exige login
app.use(requireLogin);
app.use(dashboardRoutes);
app.use(clientesRoutes);
app.use(precosRoutes);
app.use(estoqueRoutes);
app.use(vendasRoutes);
app.use(financeiroRoutes);

const PORT = process.env.PORT || 3000;

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
