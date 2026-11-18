// Real PostgreSQL sessions + observed lock waits; synthetic loopback data only.
// Fixtures retain append-only history in an isolated test DB; no Storage HTTP or provider calls.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { localDatabaseEnvironment, pgBinary, run } from './connection.mjs'

const env = localDatabaseEnvironment()
const database = process.argv.find(value => value.startsWith('--database='))
if (database) env.PGDATABASE = database.slice('--database='.length)
if (!/^mozzi_[a-z0-9_]+$/.test(env.PGDATABASE) || env.PGDATABASE.startsWith('mozzi_restore_')) {
  throw new Error('Synthetic test database required; never seed a recovery database')
}
const executable = pgBinary(env, 'psql')
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']
const query = sql => run(executable, args, { env, input: sql }).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const result = output => JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('RESULT:')).slice(7))
class Session {
  constructor(name) {
    this.child = spawn(executable, args, { env: { ...env, PGAPPNAME: name }, windowsHide: true })
    this.buffer = ''; this.errors = ''; this.pending = null; this.closed = false
    this.child.stdout.on('data', data => {
      this.buffer += data.toString()
      while (this.buffer.includes('\n')) {
        const at = this.buffer.indexOf('\n'); const line = this.buffer.slice(0, at).trimEnd()
        this.buffer = this.buffer.slice(at + 1)
        if (!this.pending) continue
        if (line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer)
          pending.resolve(pending.lines.join('\n'))
        } else this.pending.lines.push(line)
      }
    })
    this.child.stderr.on('data', data => { this.errors += data.toString() })
    this.child.on('error', error => this.reject(error))
    this.child.on('close', code => {
      this.closed = true
      this.reject(new Error(`SQL session ended (${code}): ${this.errors.slice(-1200)}`))
    })
  }
  reject(error) {
    if (!this.pending) return
    clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null
  }
  command(sql) {
    if (this.pending || this.closed) return Promise.reject(new Error('Session is unavailable'))
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID().replaceAll('-', '')}`
      const timer = setTimeout(() => { this.reject(new Error('SQL session timeout')); this.child.kill() }, 15000)
      this.pending = { marker, resolve, reject, timer, lines: [] }
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`)
    })
  }
  close() { if (!this.closed) this.child.stdin.end('\\q\n') }
}

async function barrier(name) {
  const until = Date.now() + 8000
  while (Date.now() < until) {
    if (query(`select count(*) from pg_stat_activity where application_name=${literal(name)} and wait_event_type='Lock';`) === '1') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Expected real PostgreSQL lock contention was not observed')
}

function fixture() {
  const f = Object.fromEntries(['tenant', 'actor', 'target', 'member'].map(key => [key, randomUUID()]))
  query(`begin;
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
      (${literal(f.actor)},${literal(`delivery-admin-${f.actor}@example.test`)},now(),'{}'),
      (${literal(f.target)},${literal(`delivery-target-${f.target}@example.test`)},null,'{}');
    insert into public.platform_user_roles(user_id,role) values(${literal(f.actor)},'super_admin');
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,order_prefix)
      values(${literal(f.tenant)},'Synthetic delivery race','Synthetic',${literal(`delivery-race-${f.tenant}`)},'draft','+5491111111111','DLV');
    insert into public.restaurant_members(id,restaurant_id,user_id,role,status)
      values(${literal(f.member)},${literal(f.tenant)},${literal(f.target)},'order_manager','invited');
    commit;`)
  return f
}
function claim(f) {
  return `set local role service_role; select 'RESULT:'||coalesce(public.claim_restaurant_invitation(
    ${literal(f.tenant)},${literal(f.target)},false,'order_manager')::text,'null');`
}

async function race(firstSql, secondSql) {
  const name = `invitation_delivery_${randomUUID().slice(0, 8)}`
  const first = new Session(`${name}_holder`); const second = new Session(`${name}_waiter`)
  try {
    const firstResult = await first.command(`begin;set local statement_timeout='12s';${firstSql}`)
    const pending = second.command(`begin;set local statement_timeout='12s';${secondSql}commit;`)
    pending.catch(() => {})
    await barrier(`${name}_waiter`)
    await first.command('commit;')
    return [firstResult, await pending]
  } finally {
    await first.command('rollback;').catch(() => {})
    if (!second.closed) await second.command('rollback;').catch(() => {})
    first.close(); second.close()
  }
}

const duplicate = fixture()
const [claimed, duplicateResult] = await race(claim(duplicate), claim(duplicate))
assert.equal(result(claimed).userId, duplicate.target)
assert.equal(result(duplicateResult), null)
assert.equal(query(`select count(*) from private.restaurant_invitation_deliveries where membership_id=${literal(duplicate.member)} and lease_id is not null;`), '1')

const changedRole = fixture()
const [, changedRoleResult] = await race(`set local role service_role;
  select public.upsert_restaurant_membership(${literal(changedRole.tenant)},${literal(changedRole.target)},'restaurant_admin','invited',${literal(changedRole.actor)});`, claim(changedRole))
assert.equal(result(changedRoleResult), null)

const confirmationFirst = fixture()
const [, afterConfirmation] = await race(`update auth.users set email_confirmed_at=clock_timestamp() where id=${literal(confirmationFirst.target)};`, claim(confirmationFirst))
assert.equal(result(afterConfirmation), null)
assert.equal(query(`select pending from private.restaurant_invitation_deliveries where membership_id=${literal(confirmationFirst.member)};`), 'f')

const claimFirst = fixture()
const [beforeConfirmation] = await race(claim(claimFirst), `update auth.users set email_confirmed_at=clock_timestamp() where id=${literal(claimFirst.target)};`)
assert.equal(query(`select public.finish_restaurant_invitation(${literal(result(beforeConfirmation).leaseId)},true);`), 'f')
assert.equal(query(`select status from public.restaurant_members where id=${literal(claimFirst.member)};`), 'active')

console.log(JSON.stringify({ database: env.PGDATABASE, passed: true, barriers: 4, scenarios: [
  'two service handlers obtain only one durable invitation lease',
  'role mutation commits first: the stale expected role cannot claim delivery',
  'Auth confirmation commits first: the waiting claim sends nothing',
  'claim commits first: Auth confirmation cancels its lease without lock-order deadlock',
], fixtures: 'synthetic only; retained with immutable history; no email is sent' }))
