require('dotenv').config();
// Script para trocar o usuário e senha do sistema.
// Rode UMA VEZ com: node atualizar-usuario.js
// Depois pode apagar este arquivo.

const bcrypt = require('bcrypt');
const pool = require('./db/pool');

const NOVO_USUARIO = 'admintd';
const NOVA_SENHA = 'tdgas';

(async () => {
  try {
    const hash = await bcrypt.hash(NOVA_SENHA, 10);

    // Tenta atualizar o primeiro usuário existente (id = 1)
    const { rowCount } = await pool.query(
      'UPDATE usuarios SET username = $1, senha_hash = $2 WHERE id = 1',
      [NOVO_USUARIO, hash]
    );

    if (rowCount === 0) {
      // Se não existir nenhum usuário ainda, cria um novo
      await pool.query(
        'INSERT INTO usuarios (username, senha_hash) VALUES ($1, $2)',
        [NOVO_USUARIO, hash]
      );
      console.log('Nenhum usuário existia. Usuário criado com sucesso!');
    } else {
      console.log('Usuário atualizado com sucesso!');
    }

    console.log('Usuário: ' + NOVO_USUARIO);
    console.log('Senha: ' + NOVA_SENHA);
  } catch (err) {
    console.error('Erro ao atualizar usuário:', err);
  } finally {
    await pool.end();
  }
})();
