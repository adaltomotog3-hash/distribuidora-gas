// Envia notificações push (som + texto) pro celular do entregador, usando o
// serviço gratuito de push da própria Expo. Não precisa de nenhuma conta ou
// chave extra: o "Expo push token" que o app manda pro sistema depois do
// login (ver POST /api/push-token em routes/api.js) já é suficiente.
//
// Requer Node 18+ (usa o "fetch" global) — o servidor já roda em Node 20.
const pool = require('../db/pool');

async function enviarPush(expoPushToken, { titulo, corpo, dados }) {
  if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken')) return;

  try {
    const resposta = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: expoPushToken,
        title: titulo,
        body: corpo,
        sound: 'default',
        priority: 'high',
        channelId: 'entregas', // precisa ser o mesmo nome de canal criado no app (Android)
        data: dados || {}
      })
    });

    const resultado = await resposta.json().catch(() => null);
    if (resultado && resultado.data && resultado.data.status === 'error') {
      console.log('>> Push recusado pelo servidor da Expo:', resultado.data.message);
    }
  } catch (err) {
    // Uma falha aqui nunca deve derrubar a ação principal (fechar/atribuir O.S.)
    console.log('>> Falha ao enviar notificação push:', err.message);
  }
}

// Avisa (com som) o entregador especificado que uma nova O.S. foi direcionada
// pra ele. Não faz nada se esse entregador não tiver token salvo ainda (app
// nunca abriu / notificação nunca foi autorizada) ou estiver inativo.
async function notificarNovaEntrega(entregadorId, pedidoId) {
  if (!entregadorId) return;

  try {
    const { rows } = await pool.query(
      'SELECT expo_push_token FROM entregadores WHERE id = $1 AND ativo = TRUE',
      [entregadorId]
    );
    const token = rows[0] && rows[0].expo_push_token;
    if (!token) return;

    await enviarPush(token, {
      titulo: 'Nova entrega',
      corpo: 'Você tem uma nova O.S. #' + pedidoId + ' pra entregar.',
      dados: { pedidoId }
    });
  } catch (err) {
    console.log('>> Falha ao notificar entregador sobre nova entrega:', err.message);
  }
}

module.exports = { notificarNovaEntrega };
