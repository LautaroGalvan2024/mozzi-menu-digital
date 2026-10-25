// Upgrade only an already-restored, isolated database. No synthetic fixtures,
// remote connections, resets or production data are printed.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { localDatabaseEnvironment, run } from './connection.mjs'

const database = process.argv.find(value => value.startsWith('--database='))?.slice(11)
if (!/^mozzi_restore_[0-9]+$/.test(database ?? '')) throw new Error('An explicit restored database is required')
const env = { ...localDatabaseEnvironment(), PGDATABASE: database }
const query = statement => run(path.join(env.PG_BIN, 'psql.exe'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { env, input: statement }).trim()
const quote = value => `"${value.replaceAll('"', '""')}"`
const tables = JSON.parse(query(`select json_agg(x) from (
 select table_schema,table_name,array_agg(column_name order by ordinal_position) columns
 from information_schema.columns where table_schema in ('public','auth','storage')
 and table_name in (select tablename from pg_tables where schemaname in ('public','auth','storage'))
 group by table_schema,table_name order by table_schema,table_name) x;`))
const digest = ({ table_schema, table_name, columns }) => JSON.parse(query(`select json_build_object('count',count(*),'digest',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),''))) from (select ${columns.map(quote).join(',')} from ${quote(table_schema)}.${quote(table_name)}) t;`))
const before = tables.map(digest)
const history = JSON.parse(query("select coalesce(json_agg(version order by version),'[]') from supabase_migrations.schema_migrations;"))
const pending = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && !history.includes(file.split('_')[0])).sort()
assert.ok(history.length >= 23, 'Restore the complete base history first')
assert.ok(pending.every(file => file.startsWith('20261024')), 'Unexpected migration outside this release')
for (const file of pending) {
  const version = file.split('_')[0]
  const sql = readFileSync(path.join('supabase/migrations', file), 'utf8')
  query(`begin; ${sql}\ninsert into supabase_migrations.schema_migrations(version) values('${version}'); commit;`)
}
tables.forEach((table, index) => assert.deepEqual(digest(table), before[index], 'Existing data changed during upgrade'))
console.log(JSON.stringify({ database, applied: pending, originalTablesCompared: tables.length, allOriginalColumnsAndRowsUnchanged: true }))
