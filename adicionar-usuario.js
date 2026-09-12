require('dotenv').config();
// Script para ADICIONAR um novo usuário ao sistema, sem apagar nem alterar os
// usuários que já existem.
// Como rodar: dentro da pasta do projeto, no terminal, digite:
//   node adicionar-usuario.js
// Depois de rodar com sucesso, pode apagar este arquivo.

const bcrypt = require('bcrypt');
const pool = require('./db/pool');

const NOVO_USUARIO = 'Dhonata';
const NOVA_SENHA = '0889970';

(async () => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM usuarios WHERE username = $1',
      [NOVO_USUARIO]
    );

    if (rows.length > 0) {
      console.log('Já existe um usuário com o nome "' + NOVO_USUARIO + '". Nada foi alterado.');
      return;
    }

    const hash = await bcrypt.hash(NOVA_SENHA, 10);
    await pool.query(
      'INSERT INTO usuarios (username, senha_hash) VALUES ($1, $2)',
      [NOVO_USUARIO, hash]
    );

    console.log('Usuário criado com sucesso!');
    console.log('Usuário: ' + NOVO_USUARIO);
    console.log('Senha: ' + NOVA_SENHA);
  } catch (err) {
    console.error('Erro ao criar usuário:', err);
  } finally {
    await pool.end();
  }
})();
