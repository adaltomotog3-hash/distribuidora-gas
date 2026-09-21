// Criptografia dos "segredos" guardados no banco (chave de acesso do serviço de
// cobrança, código CSC da nota fiscal, e futuramente certificado digital).
//
// Usa AES-256-GCM (criptografia + verificação de que ninguém alterou o dado).
// A chave de criptografia NÃO fica no banco nem no GitHub: vem da variável
// SEGREDOS_KEY do arquivo .env do servidor. Assim, quem copiar só o banco (ou um
// backup dele) não consegue ler os segredos.
//
// Formato guardado no banco:  enc:v1:<iv>:<tag>:<dado>   (tudo em base64)
const crypto = require('crypto');

const PREFIXO = 'enc:v1:';

function obterChave() {
  const bruta = process.env.SEGREDOS_KEY || '';
  if (!bruta) return null;
  // Aceita 64 caracteres hexadecimais (32 bytes) ou base64 de 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(bruta)) return Buffer.from(bruta, 'hex');
  const b64 = Buffer.from(bruta, 'base64');
  return b64.length === 32 ? b64 : null;
}

function disponivel() {
  return obterChave() !== null;
}

function criptografar(texto) {
  if (texto === null || texto === undefined || texto === '') return null;
  const chave = obterChave();
  if (!chave) throw new Error('SEGREDOS_KEY não configurada no servidor.');
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const dado = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return PREFIXO + [iv, tag, dado].map((b) => b.toString('base64')).join(':');
}

function descriptografar(valor) {
  if (!valor) return null;
  if (!String(valor).startsWith(PREFIXO)) return valor; // valor antigo, ainda sem criptografia
  const chave = obterChave();
  if (!chave) throw new Error('SEGREDOS_KEY não configurada no servidor.');
  const [iv, tag, dado] = String(valor).slice(PREFIXO.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const decifra = crypto.createDecipheriv('aes-256-gcm', chave, iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(dado), decifra.final()]).toString('utf8');
}

// Decide o que gravar no banco para um segredo vindo de um formulário:
//  - campo preenchido  -> criptografa o valor novo
//  - campo em branco   -> mantém o que já estava salvo (e, se estava sem
//                         criptografia e a chave já existe, criptografa agora)
// Se precisar criptografar e a chave não estiver configurada, lança erro.
function prepararParaSalvar(novoValor, valorAtual) {
  const novo = String(novoValor || '').trim();
  if (novo) return criptografar(novo);
  if (valorAtual && !String(valorAtual).startsWith(PREFIXO) && disponivel()) return criptografar(valorAtual);
  return valorAtual || null;
}

module.exports = { disponivel, criptografar, descriptografar, prepararParaSalvar };
