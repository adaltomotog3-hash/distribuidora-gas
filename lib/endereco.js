// Monta o endereço completo do cliente a partir dos campos separados
// (rua, número, complemento, bairro, cidade, uf, referência).
// Clientes antigos (migrados antes desses campos existirem) só têm o campo
// "endereco" preenchido com o texto livre de sempre — nesse caso a função
// devolve exatamente esse texto, sem tentar recompor nada.
function formatarEndereco(c) {
  if (!c) return '';

  const linhaRua = [c.endereco, c.numero].filter(Boolean).join(', ');
  const linhaComComplemento = c.complemento
    ? [linhaRua, c.complemento].filter(Boolean).join(' - ')
    : linhaRua;

  const cidadeUf = [c.cidade, c.uf].filter(Boolean).join('/');
  const linhaBairroCidade = [c.bairro, cidadeUf].filter(Boolean).join(', ');

  let completo = [linhaComComplemento, linhaBairroCidade].filter(Boolean).join(' - ');

  if (c.referencia) {
    completo += (completo ? ' (Ref: ' : '(Ref: ') + c.referencia + ')';
  }

  return completo || c.endereco || '';
}

module.exports = { formatarEndereco };
