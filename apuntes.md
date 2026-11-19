comando para filtrar con acentos en los buscadores
$env:PGPASSWORD='ecom_password'; psql -h localhost -U ecom_user -d ecommerce -c 'CREATE EXTENSION IF NOT EXISTS unaccent;'