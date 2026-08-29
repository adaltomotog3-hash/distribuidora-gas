#!/bin/bash
# Backup diário do banco de dados — Distribuidora de Gás e Água
#
# O que faz: gera um dump completo do Postgres (dados + estrutura), compactado,
# guarda numa pasta local e apaga backups com mais de 30 dias sozinho, pra não
# encher o disco do servidor com o tempo.
#
# Como instalar (rodar uma vez, no servidor do cliente):
#   1. Copie este arquivo para /opt/distribuidora/backup-diario.sh
#      (ou outro caminho — só ajuste o cron no passo 3)
#   2. Dê permissão de execução:
#        chmod +x /opt/distribuidora/backup-diario.sh
#   3. Edite a linha "DATABASE_URL=" logo abaixo com a mesma URL do arquivo .env
#      do sistema (ou exporte DATABASE_URL no ambiente antes de chamar o script).
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

set -euo pipefail

# --- Configurações ---
DATABASE_URL="${DATABASE_URL:-}"
PASTA_BACKUP="${PASTA_BACKUP:-/opt/distribuidora/backups}"
DIAS_PARA_MANTER=30

if [ -z "$DATABASE_URL" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: defina DATABASE_URL (edite este script ou exporte a variável)." >&2
  exit 1
fi

mkdir -p "$PASTA_BACKUP"

DATA=$(date '+%Y-%m-%d_%H-%M-%S')
ARQUIVO="$PASTA_BACKUP/distribuidora_$DATA.sql.gz"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando backup em $ARQUIVO"

if pg_dump "$DATABASE_URL" | gzip > "$ARQUIVO"; then
  TAMANHO=$(du -h "$ARQUIVO" | cut -f1)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup concluído ($TAMANHO)."
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: falha ao gerar o backup." >&2
  rm -f "$ARQUIVO"
  exit 1
fi

# Apaga backups mais antigos que DIAS_PARA_MANTER dias
ENCONTRADOS=$(find "$PASTA_BACKUP" -name "distribuidora_*.sql.gz" -mtime +$DIAS_PARA_MANTER)
if [ -n "$ENCONTRADOS" ]; then
  echo "$ENCONTRADOS" | while read -r antigo; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Removendo backup antigo: $antigo"
    rm -f "$antigo"
  done
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backups atuais em $PASTA_BACKUP:"
ls -lh "$PASTA_BACKUP" | tail -n +2
