// Cria um usuário do painel OU troca a senha de um usuário que já existe.
// Substitui os scripts antigos (adicionar-usuario.js, atualizar-usuario.js,
// trocar-usuarios.js), que tinham senhas escritas dentro do código.
//
// Como rodar (dentro da pasta do projeto, no servidor ou no seu PC):
//   node gerenciar-usuario.js NOME_DO_USUARIO
// O script pergunta a senha no terminal (ela não aparece na tela nem fica salva
// em nenhum arquivo). Se o usuário já existir, a senha dele é trocada; se não
// existir, ele é criado.

require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcrypt');
const pool = require('./db/pool');

const usuario = (process.argv[2] || '').trim();
if (!usuario) {
  console.log('Uso: node gerenciar-usuario.js NOME_DO_USUARIO');
  process.exit(1);
}

function perguntarSenha(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (s) {
      // esconde o que é digitado (mostra só a pergunta e a quebra de linha)
      if (s.includes(texto) || s === '\r\n' || s === '\n') rl.output.write(s);
    };
    rl.question(texto, (resposta) => {
      rl.close();
      resolve(resposta);
    });
  });
}

const SENHAS_FRACAS = ['12345678', '123456789', '1234567890', 'senha123', 'admin123', 'password', '11223344', 'qwertyui'];

(async () => {
  try {
    const senha = await perguntarSenha('Nova senha (mínimo 10 caracteres): ');
    const confirmacao = await perguntarSenha('Repita a senha: ');

    if (senha !== confirmacao) {
      console.log('As senhas não são iguais. Nada foi alterado.');
      return;
    }
    if (senha.length < 10 || SENHAS_FRACAS.includes(senha.toLowerCase()) || /^(\d)\1+$/.test(senha)) {
      console.log('Senha fraca demais. Use pelo menos 10 caracteres, misturando letras e números. Nada foi alterado.');
      return;
    }

    const hash = await bcrypt.hash(senha, 12);
    const { rowCount } = await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE username = $2', [hash, usuario]);
    if (rowCount > 0) {
      console.log('Senha do usuário "' + usuario + '" trocada com sucesso.');
    } else {
      await pool.query('INSERT INTO usuarios (username, senha_hash) VALUES ($1, $2)', [usuario, hash]);
      console.log('Usuário "' + usuario + '" criado com sucesso.');
    }
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await pool.end();
  }
})();
