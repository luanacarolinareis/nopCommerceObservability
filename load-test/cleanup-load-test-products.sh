#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/cleanup-load-test-products.sql"

PRODUCT_PREFIX="${PRODUCT_PREFIX:-LoadTest-Product-}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-nopcommerce_pg}"
POSTGRES_DB="${POSTGRES_DB:-nopcommerce}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-db_password}"
USE_DOCKER="${USE_DOCKER:-true}"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "SQL file not found: $SQL_FILE" >&2
  exit 1
fi

echo "Cleaning load-test products with prefix: ${PRODUCT_PREFIX}"

if [[ "$USE_DOCKER" == "true" ]]; then
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" -i "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v product_prefix="$PRODUCT_PREFIX" \
    -f - < "$SQL_FILE"
else
  PGPASSWORD="$POSTGRES_PASSWORD" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v product_prefix="$PRODUCT_PREFIX" \
    -f "$SQL_FILE"
fi
