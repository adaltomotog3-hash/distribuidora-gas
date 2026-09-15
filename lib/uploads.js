// Configuração do upload de comprovantes (recibos) anexados às despesas.
// Os arquivos ficam salvos em disco, na pasta uploads/comprovantes/ (fora do
// Git — ver .gitignore); só o nome do arquivo salvo fica gravado no banco
// (tabela despesas_comprovantes, ver db/init.js).
//
// O multer aqui guarda o arquivo só na MEMÓRIA (não escreve nada em disco
// sozinho) — quem grava em disco de fato é salvarComprovantes(), chamada só
// depois que a despesa já foi validada e inserida no banco. Isso evita
// arquivo órfão no servidor se o formulário tiver outro erro de validação.
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');

// Em alguns servidores (processador mais simples/antigo), o pacote de
// compressão de imagem (sharp) não consegue carregar. Isso NÃO pode derrubar
// o sistema inteiro — se acontecer, os comprovantes continuam funcionando
// normalmente, só sem a compressão/conversão automática pra JPEG.
let sharp = null;
try {
  sharp = require('sharp');
} catch (erro) {
  console.warn('>> Aviso: não foi possível carregar o pacote "sharp" (compressão de imagem de comprovantes desativada nesse servidor). Detalhe:', erro.message);
}

const PASTA_COMPROVANTES = path.join(__dirname, '..', 'uploads', 'comprovantes');
fs.mkdirSync(PASTA_COMPROVANTES, { recursive: true });

const TIPOS_ACEITOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

const uploadComprovantes = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }, // até 5 arquivos por despesa, 15MB cada (antes de comprimir)
  fileFilter: (req, file, cb) => {
    if (!TIPOS_ACEITOS.includes(file.mimetype)) {
      return cb(new Error('Envie só foto (JPG, PNG, WEBP ou HEIC) ou PDF do comprovante.'));
    }
    cb(null, true);
  }
});

// Grava em disco os arquivos que vieram no upload (req.files, já validados),
// comprimindo quem for imagem: redimensiona pra um tamanho já mais que
// suficiente pra leitura (maior lado até 1800px) e converte tudo pra JPEG —
// além de economizar espaço, isso também resolve fotos em HEIC (padrão do
// iPhone), que boa parte dos navegadores não consegue exibir direto. PDF
// não é comprimido, só salvo como está.
async function salvarComprovantes(arquivos) {
  const salvos = [];

  for (const arquivo of arquivos || []) {
    const ehImagem = arquivo.mimetype.startsWith('image/');

    if (ehImagem && sharp) {
      const nomeArquivo = crypto.randomUUID() + '.jpg';
      const caminhoDestino = path.join(PASTA_COMPROVANTES, nomeArquivo);
      const bufferComprimido = await sharp(arquivo.buffer)
        .rotate() // aplica a orientação da câmera (EXIF) antes de qualquer coisa
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      await fsPromises.writeFile(caminhoDestino, bufferComprimido);

      salvos.push({
        nome_original: arquivo.originalname,
        nome_arquivo: nomeArquivo,
        tipo_mime: 'image/jpeg',
        tamanho_bytes: bufferComprimido.length
      });
    } else {
      // PDF, ou imagem num servidor onde o sharp não carregou: salva o
      // arquivo original sem comprimir/converter.
      const extensaoOriginal = path.extname(arquivo.originalname || '') || (ehImagem ? '.jpg' : '.pdf');
      const nomeArquivo = crypto.randomUUID() + extensaoOriginal;
      const caminhoDestino = path.join(PASTA_COMPROVANTES, nomeArquivo);
      await fsPromises.writeFile(caminhoDestino, arquivo.buffer);
      salvos.push({
        nome_original: arquivo.originalname,
        nome_arquivo: nomeArquivo,
        tipo_mime: arquivo.mimetype,
        tamanho_bytes: arquivo.buffer.length
      });
    }
  }

  return salvos;
}

module.exports = { uploadComprovantes, salvarComprovantes, PASTA_COMPROVANTES };