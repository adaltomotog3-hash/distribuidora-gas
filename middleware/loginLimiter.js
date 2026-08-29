// Bloqueio simples de força bruta nos logins (painel e app do entregador).
// Guarda as tentativas na memória do processo — não é um substituto de um
// WAF de verdade, mas evita que alguém tente milhares de senhas seguidas
// contra o sistema. Reinicia sozinho quando o servidor reinicia.

const MAX_FALHAS = 8;
const JANELA_MS = 10 * 60 * 1000; // 10 minutos pra contar as falhas
const BLOQUEIO_MS = 10 * 60 * 1000; // tempo bloqueado depois de estourar o limite
const LIMITE_MEMORIA = 5000; // limpeza de segurança, pra não crescer pra sempre

const tentativas = new Map(); // chave (ip + usuário) -> { falhas, primeiraFalhaEm, bloqueadoAte }

function limparAntigos() {
  const agora = Date.now();
  for (const [chave, dados] of tentativas) {
    const expirado = agora - dados.primeiraFalhaEm > JANELA_MS;
    const desbloqueado = !dados.bloqueadoAte || dados.bloqueadoAte < agora;
    if (expirado && desbloqueado) tentativas.delete(chave);
  }
}

function msBloqueado(chave) {
  const dados = tentativas.get(chave);
  if (!dados || !dados.bloqueadoAte) return 0;
  const restante = dados.bloqueadoAte - Date.now();
  return restante > 0 ? restante : 0;
}

function registrarFalha(chave) {
  const agora = Date.now();
  const dados = tentativas.get(chave) || { falhas: 0, primeiraFalhaEm: agora, bloqueadoAte: null };
  if (agora - dados.primeiraFalhaEm > JANELA_MS) {
    dados.falhas = 0;
    dados.primeiraFalhaEm = agora;
    dados.bloqueadoAte = null;
  }
  dados.falhas += 1;
  if (dados.falhas >= MAX_FALHAS) {
    dados.bloqueadoAte = agora + BLOQUEIO_MS;
  }
  tentativas.set(chave, dados);
  if (tentativas.size > LIMITE_MEMORIA) limparAntigos();
}

function registrarSucesso(chave) {
  tentativas.delete(chave);
}

function chaveDaRequisicao(req) {
  const usuario = (req.body && req.body.username) || '';
  return req.ip + ':' + usuario;
}

// Middleware pra usar nas rotas de login. Se estiver bloqueado, já responde
// aqui (JSON pras rotas de API, página de login pro painel) e nem chega a
// consultar o banco. Se não estiver, deixa passar e pendura em req.loginLimiter
// os métodos que a rota deve chamar conforme o resultado do login.
function protegerLogin(req, res, next) {
  const chave = chaveDaRequisicao(req);
  const restanteMs = msBloqueado(chave);

  if (restanteMs > 0) {
    const minutos = Math.max(1, Math.ceil(restanteMs / 60000));
    const mensagem = 'Muitas tentativas de login. Aguarde ' + minutos + ' minuto(s) e tente de novo.';
    if (req.path.startsWith('/api')) {
      return res.status(429).json({ erro: mensagem });
    }
    return res.render('login', { erro: mensagem });
  }

  req.loginLimiter = {
    falhou: () => registrarFalha(chave),
    sucesso: () => registrarSucesso(chave)
  };
  next();
}

module.exports = { protegerLogin };
