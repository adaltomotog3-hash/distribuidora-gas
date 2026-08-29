// Script para apagar os usuarios antigos e criar os novos (tiago e lourinho)
// Como rodar: abra o PowerShell dentro da pasta do projeto e digite:  node trocar-usuarios.js

require('dotenv').config();
const pool = require('./db/pool');

async function trocarUsuarios() {
  try {
    const bcrypt = require('bcrypt');

    await pool.query('DELETE FROM usuarios');
    console.log('>> Usuarios antigos apagados.');

    const usuarios = [
      { username: 'tiago', senha: '1122' },
      { username: 'lourinho', senha: 'admin123' }
    ];

    for (const u of usuarios) {
      const hash = await bcrypt.hash(u.senha, 10);
      await pool.query(
        'INSERT INTO usuarios (username, senha_hash) VALUES ($1, $2)',
        [u.username, hash]
      );
      console.log('>> Usuario criado: ' + u.username + ' / ' + u.senha);
    }

    console.log('>> Pronto! Pode fechar esta janela.');
  } catch (err) {
    console.error('Deu erro:', err.message);
  } finally {
    await pool.end();
  }
}

trocarUsuarios();
