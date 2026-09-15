#!/bin/bash
# Backup diário do banco de dados e dos comprovantes — Distribuidora de Gás e Água
#
# O que faz: gera um dump completo do Postgres (dados + estrutura) e também um
# .tar.gz da pasta uploads/ (as fotos/PDFs de comprovante anexados em
# Despesas — esses arquivos NÃO ficam no banco nem no Git, só em disco, então
# precisam de backup à parte). Os dois compactados, guardados numa pasta local,
# com backups de mais de 30 dias apagados sozinhos pra não encher o disco.
#
# Como instalar (rodar uma vez, no servidor do cliente):
#   1. Copie este arquivo para /opt/distribuidora/backup-diario.sh
#      (ou outro caminho — só ajuste o cron no passo 4)
#   2. Dê permissão de execução:
#        chmod +x /opt/distribuidora/backup-diario.sh
#   3. Edite as linhas "DATABASE_URL=" e "PASTA_UPLOADS=" logo abaixo (a
#      segunda é o caminho completo da pasta "uploads" dentro do projeto,
#      ex: /home/manutencao/distribuidora-gas/uploads).
#   4. Agende no cron pra rodar todo dia de madrugada:
#        crontab -e
#      E adicione a linha (roda às 3h da manhã, todo dia):
#        0 3 * * * /opt/distribuidora/backup-diario.sh >> /opt/distribuidora/backup.log 2>&1
#
# Onde ficam os backups: por padrão em /opt/distribuidora/backups/ — pode
# trocar em PASTA_BACKUP abaixo. Recomendado também copiar essa pasta de vez em
# quando pra fora do servidor (um HD externo, Google Drive, etc.) — um backup
# que mora só na mesma máquina não protege contra o servidor pifar de vez.
#
# Como restaurar um backup (se precisar um dia):
#   gunzip -c /opt/distribuidora/backups/distribuidora_2026-08-29_03-00-01.sql.gz | psql "$DATABASE_URL"
#   tar -xzf /opt/distribuidora/backups/comprovantes_2026-08-29_03-00-01.tar.gz -C /caminho/do/projeto/

set -euo pipefail

# --- Configurações ---
DATABASE_URL="${DATABASE_URL:-}"
PASTA_UPLOADS="${PASTA_UPLOADS:-}"
PASTA_BACKUP="${PASTA_BACKUP:-/opt/distribuidora/backups}"
DIAS_PARA_MANTER=30

if [ -z "$DATABASE_URL" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: defina DATABASE_URL (edite este script ou exporte a variável)." >&2
  exit 1
fi

mkdir -p "$PASTA_BACKUP"

DATA=$(date '+%Y-%m-%d_%H-%M-%S')
ARQUIVO="$PASTA_BACKUP/distribuidora_$DATA.sql.gz"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando backup do banco em $ARQUIVO"

if pg_dump "$DATABASE_URL" | gzip > "$ARQUIVO"; then
  TAMANHO=$(du -h "$ARQUIVO" | cut -f1)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup do banco concluído ($TAMANHO)."
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: falha ao gerar o backup do banco." >&2
  rm -f "$ARQUIVO"
  exit 1
fi

# Backup dos comprovantes anexados em Despesas (se a pasta existir e tiver algo)
if [ -n "$PASTA_UPLOADS" ] && [ -d "$PASTA_UPLOADS" ] && [ -n "$(ls -A "$PASTA_UPLOADS" 2>/dev/null)" ]; then
  ARQUIVO_UPLOADS="$PASTA_BACKUP/comprovantes_$DATA.tar.gz"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando backup dos comprovantes em $ARQUIVO_UPLOADS"
  if tar -czf "$ARQUIVO_UPLOADS" -C "$(dirname "$PASTA_UPLOADS")" "$(basename "$PASTA_UPLOADS")"; then
    TAMANHO_UPLOADS=$(du -h "$ARQUIVO_UPLOADS" | cut -f1)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup dos comprovantes concluído ($TAMANHO_UPLOADS)."
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: falha ao gerar o backup dos comprovantes." >&2
    rm -f "$ARQUIVO_UPLOADS"
  fi
elif [ -z "$PASTA_UPLOADS" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Aviso: PASTA_UPLOADS não definida — pulando backup dos comprovantes."
fi

# Apaga backups (banco e comprovantes) mais antigos que DIAS_PARA_MANTER dias
ENCONTRADOS=$(find "$PASTA_BACKUP" \( -name "distribuidora_*.sql.gz" -o -name "comprovantes_*.tar.gz" \) -mtime +$DIAS_PARA_MANTER)
if [ -n "$ENCONTRADOS" ]; then
  echo "$ENCONTRADOS" | while read -r antigo; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Removendo backup antigo: $antigo"
    rm -f "$antigo"
  done
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backups atuais em $PASTA_BACKUP:"
ls -lh "$PASTA_BACKUP" | tail -n +2
