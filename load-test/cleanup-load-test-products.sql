-- Deletes products created by the k6 load tests and their FK-linked rows.
-- Intended for PostgreSQL.
--
-- Usage with psql:
--   psql -v product_prefix='LoadTest-Product-' -f load-test/cleanup-load-test-products.sql

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE load_test_product_ids AS
SELECT "Id"
FROM "Product"
WHERE "Name" LIKE :'product_prefix' || '%';

DO $$
DECLARE
    fk record;
BEGIN
    FOR fk IN
        SELECT
            quote_ident(ns.nspname) AS schema_name,
            quote_ident(cls.relname) AS table_name,
            quote_ident(att.attname) AS column_name
        FROM pg_constraint con
        JOIN pg_class cls
            ON cls.oid = con.conrelid
        JOIN pg_namespace ns
            ON ns.oid = cls.relnamespace
        JOIN pg_attribute att
            ON att.attrelid = con.conrelid
           AND att.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.confrelid = to_regclass('"Product"')
          AND array_length(con.conkey, 1) = 1
          AND array_length(con.confkey, 1) = 1
    LOOP
        EXECUTE format(
            'DELETE FROM %s.%s WHERE %s IN (SELECT "Id" FROM load_test_product_ids)',
            fk.schema_name,
            fk.table_name,
            fk.column_name
        );
    END LOOP;
END $$;

-- UrlRecord is a generic relation and does not necessarily have a FK to Product
DELETE FROM "UrlRecord"
WHERE "EntityName" = 'Product'
  AND "EntityId" IN (SELECT "Id" FROM load_test_product_ids);

DELETE FROM "Product"
WHERE "Id" IN (SELECT "Id" FROM load_test_product_ids);

COMMIT;

SELECT COUNT(*) AS deleted_products
FROM load_test_product_ids;
