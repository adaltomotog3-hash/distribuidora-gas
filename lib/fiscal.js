// Funções de apoio para os dados fiscais (preparação para emissão de NF-e/NFC-e).
// Aqui só ficam validações e formatações — nada aqui fala com a Sefaz.

function somenteDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function cpfValido(valor) {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    const digito = ((soma * 10) % 11) % 10;
    if (digito !== Number(cpf[t])) return false;
  }
  return true;
}

function cnpjValido(valor) {
  const cnpj = somenteDigitos(valor);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calcula = (base) => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = calcula(cnpj.slice(0, 12));
  const d2 = calcula(cnpj.slice(0, 12) + d1);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

// Aceita CPF (11 dígitos) ou CNPJ (14 dígitos). Vazio é permitido (retorna ok com valor null).
function validarCpfCnpj(valor) {
  const digitos = somenteDigitos(valor);
  if (!digitos) return { ok: true, valor: null };
  if (digitos.length === 11) {
    return cpfValido(digitos) ? { ok: true, valor: digitos } : { ok: false, erro: 'CPF inválido.' };
  }
  if (digitos.length === 14) {
    return cnpjValido(digitos) ? { ok: true, valor: digitos } : { ok: false, erro: 'CNPJ inválido.' };
  }
  return { ok: false, erro: 'CPF deve ter 11 dígitos e CNPJ 14 dígitos.' };
}

function formatarCpfCnpj(valor) {
  const d = somenteDigitos(valor);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return valor || '';
}

const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
];

const REGIMES = {
  simples_nacional: 'Simples Nacional',
  simples_excesso: 'Simples Nacional — excesso de sublimite',
  regime_normal: 'Regime normal (Lucro Presumido / Real)',
  mei: 'MEI (Microempreendedor Individual)'
};

const AMBIENTES = {
  homologacao: 'Homologação (testes, sem valor fiscal)',
  producao: 'Produção (valor fiscal real)'
};

// Regime normal usa CST (2 dígitos); Simples/MEI usam CSOSN (3 dígitos).
function usaCsosn(regime) {
  return regime !== 'regime_normal';
}

// Cada validador devolve { ok, valor } ou { ok:false, erro }. Campo vazio é permitido
// (o contador pode preencher depois) — a "prontidão fiscal" avisa o que ainda falta.

function validarNcm(valor) {
  const d = somenteDigitos(valor);
  if (!d) return { ok: true, valor: null };
  return d.length === 8 ? { ok: true, valor: d } : { ok: false, erro: 'NCM deve ter 8 dígitos.' };
}

function validarCfop(valor) {
  const d = somenteDigitos(valor);
  if (!d) return { ok: true, valor: null };
  return /^[1-7]\d{3}$/.test(d) ? { ok: true, valor: d } : { ok: false, erro: 'CFOP deve ter 4 dígitos (começando de 1 a 7).' };
}

function validarCstCsosn(valor) {
  const d = somenteDigitos(valor);
  if (!d) return { ok: true, valor: null };
  return d.length === 2 || d.length === 3
    ? { ok: true, valor: d }
    : { ok: false, erro: 'CST tem 2 dígitos e CSOSN tem 3 dígitos.' };
}

function validarCest(valor) {
  const d = somenteDigitos(valor);
  if (!d) return { ok: true, valor: null };
  return d.length === 7 ? { ok: true, valor: d } : { ok: false, erro: 'CEST deve ter 7 dígitos.' };
}

function validarOrigem(valor) {
  const v = String(valor === undefined || valor === null ? '' : valor).trim();
  if (!v) return { ok: true, valor: '0' };
  return /^[0-8]$/.test(v) ? { ok: true, valor: v } : { ok: false, erro: 'Origem da mercadoria deve ser um número de 0 a 8.' };
}

function validarUnidade(valor) {
  const v = String(valor || '').trim().toUpperCase();
  if (!v) return { ok: true, valor: 'UN' };
  return /^[A-Z0-9]{1,6}$/.test(v) ? { ok: true, valor: v } : { ok: false, erro: 'Unidade comercial inválida (ex: UN, KG, L).' };
}

// Monta a lista do que ainda falta pra empresa estar pronta pra emitir nota.
// `empresa` = linha de empresa_fiscal (ou null); `produtos` = produtos ativos.
function checklistProntidao(empresa, produtos) {
  const e = empresa || {};
  const itens = [];
  const add = (ok, texto, dica) => itens.push({ ok: !!ok, texto, dica: dica || '' });

  add(e.razao_social, 'Razão social preenchida');
  add(e.cnpj && cnpjValido(e.cnpj), 'CNPJ válido', 'Confira com o contador se o CNPJ já está no nome do novo sócio.');
  add(e.inscricao_estadual, 'Inscrição estadual (IE) preenchida');
  add(e.regime_tributario, 'Regime tributário definido', 'Quem informa é o contador (Simples Nacional, Lucro Presumido etc.).');
  add(e.logradouro && e.numero && e.bairro && e.cidade && e.uf && e.cep, 'Endereço completo da empresa');
  add(e.codigo_municipio_ibge, 'Código IBGE do município', '7 dígitos — o contador ou a prefeitura informam.');
  add(e.csc_id && e.csc_token, 'CSC da NFC-e (ID + código)', 'Gerado no portal da Sefaz do estado — só necessário para NFC-e.');

  const total = produtos.length;
  const completos = produtos.filter((p) => p.ncm && p.cfop && p.cst_csosn).length;
  add(total > 0 && completos === total, 'Produtos com NCM, CFOP e CST/CSOSN (' + completos + ' de ' + total + ')', 'Esses códigos são definidos pelo contador.');

  return itens;
}

module.exports = {
  somenteDigitos,
  cpfValido,
  cnpjValido,
  validarCpfCnpj,
  formatarCpfCnpj,
  UFS,
  REGIMES,
  AMBIENTES,
  usaCsosn,
  validarNcm,
  validarCfop,
  validarCstCsosn,
  validarCest,
  validarOrigem,
  validarUnidade,
  checklistProntidao
};
