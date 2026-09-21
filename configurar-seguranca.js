// Configura sozinho os segredos de segurança no arquivo ".env" do servidor.
//
// Como rodar (dentro da pasta do projeto):
//   node configurar-seguranca.js
//
// O que faz:
//  - SESSION_SECRET e JWT_SECRET: se estiverem faltando, forem fracos ou forem o
//    valor de exemplo do GitHub, gera um valor novo aleatório.
//  - SEGREDOS_KEY: se estiver faltando, gera uma. Se JÁ existir, NÃO mexe (trocar
//    faria os segredos já salvos no banco ficarem ilegíveis).
// Não mostra nenhum valor na tela, e guarda uma cópia do .env antigo em .env.antes-seguranca.
// Depois de rodar, reinicie o sistema:  pm2 restart gas

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARQUIVO = path.join(__dirname, '.env');
const FRACOS = ['segredo-troque-isso', 'troque-esse-segredo-tambem', 'troque-esta-frase-por-algo-so-seu'];

if (!fs.existsSync(ARQUIVO)) {
  console.log('Não achei o arquivo .env nesta pasta. Rode este comando dentro da pasta do projeto (distribuidora-gas).');
  process.exit(1);
}

const original = fs.readFileSync(ARQUIVO, 'utf8');
const linhas = original.split(/\r?\n/);

function ler(nome) {
  const linha = linhas.find((l) => l.trim().startsWith(nome + '='));
  if (!linha) return '';
  return linha.slice(linha.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

function gravar(nome, valor) {
  const i = linhas.findIndex((l) => l.trim().startsWith(nome + '='));
  if (i >= 0) linhas[i] = nome + '=' + valor;
  else linhas.push(nome + '=' + valor);
}

const aleatorio = (bytes) => crypto.randomBytes(bytes).toString('hex');
const fraco = (v) => !v || v.length < 24 || FRACOS.includes(v);

const feito = [];
if (fraco(ler('SESSION_SECRET'))) { gravar('SESSION_SECRET', aleatorio(48)); feito.push('SESSION_SECRET (criado/renovado)'); }
if (fraco(ler('JWT_SECRET'))) { gravar('JWT_SECRET', aleatorio(48)); feito.push('JWT_SECRET (criado/renovado)'); }
if (!/^[0-9a-fA-F]{64}$/.test(ler('SEGREDOS_KEY'))) {
  gravar('SEGREDOS_KEY', aleatorio(32));
  feito.push('SEGREDOS_KEY (criada)');
}

if (feito.length === 0) {
  console.log('Tudo já estava configurado e forte. Nada foi alterado.');
  process.exit(0);
}

fs.writeFileSync(path.join(__dirname, '.env.antes-seguranca'), original, { mode: 0o600 });
fs.writeFileSync(ARQUIVO, linhas.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
try { fs.chmodSync(ARQUIVO, 0o600); } catch (e) { /* sem problema se o sistema não permitir */ }

console.log('Pronto! Foram configurados:');
feito.forEach((f) => console.log('  - ' + f));
console.log('\nAgora reinicie o sistema com:  pm2 restart gas');
if (feito.some((f) => f.startsWith('JWT_SECRET') || f.startsWith('SESSION_SECRET'))) {
  console.log('Observação: as pessoas e os apps vão precisar entrar (fazer login) de novo uma vez.');
}
