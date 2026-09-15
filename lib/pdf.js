// Helpers pra gerar os PDFs de relatório (Vendas, Financeiro, Entregas,
// Saídas). Usa a biblioteca "pdfkit" — desenha o PDF do zero, sem precisar de
// nenhum navegador/Chromium instalado no servidor (mais leve e mais simples
// de manter rodando no servidor do cliente).
const PDFDocument = require('pdfkit');

const COR_CHAMA = '#D9601C';
const COR_TEXTO = '#1B2430';
const COR_SUAVE = '#6B7280';
const COR_ZEBRA = '#F6F5F2';

function formatarMoeda(valor) {
  return 'R$ ' + Number(valor || 0).toFixed(2).replace('.', ',');
}

function formatarDataCurta(valor) {
  if (!valor) return '—';
  const data = typeof valor === 'string' && valor.length === 10 ? new Date(valor + 'T00:00:00') : new Date(valor);
  return data.toLocaleDateString('pt-BR');
}

function formatarDataHora(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleString('pt-BR');
}

function truncar(texto, tamanho) {
  if (!texto) return '—';
  const t = String(texto);
  return t.length > tamanho ? t.slice(0, tamanho - 1) + '…' : t;
}

// Cria o documento, já configurando a resposta HTTP pra baixar como PDF.
function iniciarPdf(res, nomeArquivo) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nomeArquivo + '"');
  doc.pipe(res);
  return doc;
}

function cabecalho(doc, { titulo, subtitulo }) {
  doc.fillColor(COR_CHAMA).font('Helvetica-Bold').fontSize(11).text('LORIN GÁS E ÁGUA');
  doc.fillColor(COR_TEXTO).fontSize(17).text(titulo, { paragraphGap: 2 });
  if (subtitulo) {
    doc.font('Helvetica').fontSize(10).fillColor(COR_SUAVE).text(subtitulo);
  }
  doc.font('Helvetica').fontSize(8).fillColor(COR_SUAVE)
    .text('Gerado em ' + new Date().toLocaleString('pt-BR'));
  doc.moveDown(1);
  doc.fillColor(COR_TEXTO);
}

function tituloSecao(doc, texto) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 60) {
    doc.addPage();
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COR_TEXTO).text(texto);
  doc.moveDown(0.3);
}

function linhaResumo(doc, texto) {
  doc.font('Helvetica').fontSize(9.5).fillColor(COR_TEXTO).text(texto);
}

// Tabela simples, com cabeçalho colorido repetido em toda página nova e
// zebra-striping nas linhas. colunas: [{ titulo, campo|valor(linha), flex, align }]
function tabela(doc, { colunas, linhas }) {
  const margemEsquerda = doc.page.margins.left;
  const larguraUtil = doc.page.width - margemEsquerda - doc.page.margins.right;
  const somaFlex = colunas.reduce((soma, c) => soma + (c.flex || 1), 0);
  const larguras = colunas.map((c) => (larguraUtil * (c.flex || 1)) / somaFlex);
  const ALTURA_LINHA = 18;
  const ALTURA_CABECALHO = 20;

  function desenharCabecalhoTabela() {
    const y = doc.y;
    doc.rect(margemEsquerda, y, larguraUtil, ALTURA_CABECALHO).fill(COR_CHAMA);
    let x = margemEsquerda;
    doc.font('Helvetica-Bold').fontSize(8.5);
    colunas.forEach((coluna, indice) => {
      doc.fillColor('#fff').text(coluna.titulo, x + 4, y + 6, {
        width: larguras[indice] - 8,
        align: coluna.align || 'left'
      });
      x += larguras[indice];
    });
    doc.y = y + ALTURA_CABECALHO;
    doc.fillColor(COR_TEXTO).font('Helvetica');
  }

  if (linhas.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor(COR_SUAVE).text('Nenhum registro encontrado nesse período.');
    doc.moveDown(1);
    return;
  }

  desenharCabecalhoTabela();

  linhas.forEach((linha, indice) => {
    if (doc.y + ALTURA_LINHA > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      desenharCabecalhoTabela();
    }

    const y = doc.y;
    if (indice % 2 === 1) {
      doc.rect(margemEsquerda, y, larguraUtil, ALTURA_LINHA).fill(COR_ZEBRA);
    }

    let x = margemEsquerda;
    doc.font('Helvetica').fontSize(8.5);
    colunas.forEach((coluna, indiceColuna) => {
      const bruto = typeof coluna.valor === 'function' ? coluna.valor(linha) : linha[coluna.campo];
      const texto = bruto === null || bruto === undefined || bruto === '' ? '—' : String(bruto);
      doc.fillColor(COR_TEXTO).text(texto, x + 4, y + 5, {
        width: larguras[indiceColuna] - 8,
        align: coluna.align || 'left',
        lineBreak: false,
        ellipsis: true
      });
      x += larguras[indiceColuna];
    });
    doc.y = y + ALTURA_LINHA;
  });

  doc.moveDown(1);
}

// Numera as páginas ("Página X de Y") — precisa ser chamado por último,
// logo antes de doc.end(), porque só aí o total de páginas é conhecido.
function rodapePaginas(doc) {
  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i);

    // Escrever dentro da margem inferior faria o pdfkit achar que não cabe
    // e criar uma página nova sozinho — zera a margem só durante esse texto
    // pra desenhar o rodapé na página atual mesmo (truque conhecido do pdfkit).
    const margemInferiorOriginal = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - margemInferiorOriginal + 12;
    doc.font('Helvetica').fontSize(8).fillColor(COR_SUAVE).text(
      'Página ' + (i + 1) + ' de ' + paginas.count,
      doc.page.margins.left,
      y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' }
    );

    doc.page.margins.bottom = margemInferiorOriginal;
  }
}

module.exports = {
  iniciarPdf,
  cabecalho,
  tituloSecao,
  linhaResumo,
  tabela,
  rodapePaginas,
  formatarMoeda,
  formatarDataCurta,
  formatarDataHora,
  truncar
};
