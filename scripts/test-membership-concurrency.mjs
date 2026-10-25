// Real PostgreSQL concurrency tests. Requires an already migrated disposable DB.
// S01_PSQL is an executable path; PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD use
// normal libpq variables. Credentials are never included in arguments or output.
// Synthetic fixtures are retained for inspection; discard the isolated DB after
// the run. This script never resets a schema or connects to a non-loopback host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const host = process.env.PGHOST;
if (!["127.0.0.1", "localhost", "::1"].includes(host)
  || process.env.PGHOSTADDR && !["127.0.0.1", "::1"].includes(process.env.PGHOSTADDR)
  || process.env.MOZZI_ISOLATED_TEST_DB !== "1"
  || !process.env.PGDATABASE
  || ["postgres", "template0", "template1"].includes(process.env.PGDATABASE)
  || process.env.PGSERVICE || process.env.PGSERVICEFILE) {
  throw new Error("Requires explicit loopback PGHOST, a dedicated PGDATABASE, MOZZI_ISOLATED_TEST_DB=1 and no libpq service override.");
}

const executable = process.env.S01_PSQL || "psql";
const sessions = new Set();
class Session {
  constructor(name) {
    this.name = `s01_${name}_${randomUUID()}`;
    this.output = "";
    this.stderr = "";
    this.pending = null;
    this.closed = false;
    this.process = spawn(executable, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
      env: { ...process.env, PGAPPNAME: this.name, PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=15000 -c lock_timeout=10000" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    sessions.add(this);
    this.process.stdout.on("data", (chunk) => {
      this.output += chunk.toString();
      if (this.pending && this.output.includes(this.pending.marker)) {
        const { marker, resolve } = this.pending;
        const result = this.output.slice(0, this.output.indexOf(marker)).trim();
        this.output = this.output.slice(this.output.indexOf(marker) + marker.length).trim();
        this.pending = null;
        resolve(result);
      }
    });
    this.process.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.process.on("error", (error) => { this.pending?.reject(error); this.pending = null; });
    this.process.on("exit", (code) => {
      this.closed = true;
      if (this.pending) this.pending.reject(new Error(`psql exited ${code}: ${this.stderr.trim()}`));
      this.pending = null;
      sessions.delete(this);
    });
  }
  query(sql) {
    assert.ok(!this.pending && !this.closed, "session must be open and idle");
    this.stderr = "";
    const marker = `s01_end_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.pending = { marker, resolve, reject };
      this.process.stdin.write(`${sql}\nselect '${marker}';\n`);
    });
  }
  close() {
    if (!this.closed && !this.process.stdin.writableEnded) this.process.stdin.end("rollback;\n\\q\n");
  }
}

const observer = new Session("observer");
async function fixture() {
  const f = Object.fromEntries(["tenant", "adminA", "adminB", "manager", "newManager", "super", "memberA", "memberB", "memberManager"].map((key) => [key, randomUUID()]));
  const users = [f.adminA, f.adminB, f.manager, f.newManager, f.super];
  await observer.query(`
    begin;
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
      ${users.map((id) => `('${id}','s01-${id}@example.test',now(),'{}')`).join(",")};
    insert into public.platform_user_roles(user_id,role,created_by) values('${f.super}','super_admin','${f.super}');
    insert into public.restaurants(id,name,trade_name,slug,status,whatsapp_phone_e164,address,city,order_prefix,public_menu_enabled,created_by)
      values('${f.tenant}','S01 concurrency','S01 concurrency','s01-${f.tenant}','active','+5491111111111','Synthetic','Synthetic','SCC',true,'${f.super}');
    insert into public.restaurant_members(id,restaurant_id,user_id,role,status,invited_by) values
      ('${f.memberA}','${f.tenant}','${f.adminA}','restaurant_admin','active','${f.super}'),
      ('${f.memberB}','${f.tenant}','${f.adminB}','restaurant_admin','active','${f.super}'),
      ('${f.memberManager}','${f.tenant}','${f.manager}','order_manager','active','${f.adminA}');
    commit;
  `);
  return f;
}
function invite(f, user, role, status, actor = f.super) {
  return `set local role service_role; select public.upsert_restaurant_membership('${f.tenant}','${user}','${role}','${status}','${actor}'); reset role;`;
}
function status(f, member, value, actor = f.super) {
  return `select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claims','{"sub":"${actor}","role":"authenticated","aal":"aal2"}',true);
    set local role authenticated; select public.set_restaurant_member_status('${member}','${value}'); reset role;`;
}
async function waitForLock(session) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const blocked = await observer.query(`select exists(select 1 from pg_catalog.pg_stat_activity where application_name='${session.name}' and state='active' and wait_event_type='Lock');`);
    if (blocked === "t") return;
    assert.ok(!session.closed, "contender exited before reaching the required lock barrier");
    await delay(20);
  }
  throw new Error("Contender did not reach an observable PostgreSQL lock wait");
}
async function race(name, setup, first, second, expectedError, verify) {
  const f = await fixture();
  const a = new Session("holder");
  const b = new Session("contender");
  try {
    await a.query(`begin; ${setup(f)}`);
    // Capture rejection immediately, including when psql exits before the barrier.
    const pending = b.query(`begin; ${second(f)} commit;`).then(
      (output) => ({ output }), (error) => ({ error }),
    );
    await waitForLock(b);
    await a.query(`${first(f)} commit;`);
    const result = await pending;
    if (expectedError) {
      assert.ok(result.error, `${name}: contender unexpectedly succeeded`);
      assert.match(result.error.message, new RegExp(expectedError), `${name}: unexpected SQL error`);
    } else {
      if (result.error) throw result.error;
      assert.match(result.output, /"changed": false/, `${name}: duplicate must be a no-op`);
    }
    await verify(f);
    console.log(`PASS ${name} (independent sessions; lock barrier observed)`);
  } finally {
    a.close();
    b.close();
  }
}
const tenantLock = (f) => `select id from public.restaurants where id='${f.tenant}' for update;`;
async function oneAdmin(f) {
  assert.equal(await observer.query(`select count(*) from public.restaurant_members where restaurant_id='${f.tenant}' and role='restaurant_admin' and status='active';`), "1");
}
async function unchangedNewManager(f) {
  assert.equal(await observer.query(`select count(*) from public.restaurant_members where restaurant_id='${f.tenant}' and user_id='${f.newManager}';`), "0");
}

try {
  assert.equal(await observer.query("select current_database();"), process.env.PGDATABASE, "database must match explicit disposable target");
  await race("upsert vs upsert preserves final admin", tenantLock,
    (f) => invite(f, f.adminA, "order_manager", "active"),
    (f) => invite(f, f.adminB, "order_manager", "active"), "LAST_RESTAURANT_ADMIN_REQUIRED", oneAdmin);
  await race("status vs upsert preserves final admin", tenantLock,
    (f) => status(f, f.memberA, "suspended"),
    (f) => invite(f, f.adminB, "order_manager", "active"), "LAST_RESTAURANT_ADMIN_REQUIRED", oneAdmin);
  await race("upsert vs status preserves final admin", tenantLock,
    (f) => invite(f, f.adminA, "order_manager", "active"),
    (f) => status(f, f.memberB, "suspended"), "LAST_RESTAURANT_ADMIN_REQUIRED", oneAdmin);
  await race("waiting invitation rechecks suspended actor", tenantLock,
    (f) => status(f, f.memberA, "suspended"),
    (f) => invite(f, f.newManager, "order_manager", "active", f.adminA), "MEMBERSHIP_MANAGEMENT_FORBIDDEN", unchangedNewManager);
  await race("waiting invitation rechecks promoted target", tenantLock,
    (f) => invite(f, f.manager, "restaurant_admin", "active"),
    (f) => invite(f, f.manager, "order_manager", "active", f.adminA), "ROLE_ASSIGNMENT_FORBIDDEN",
    async (f) => assert.equal(await observer.query(`select role from public.restaurant_members where id='${f.memberManager}';`), "restaurant_admin"));
  await race("simultaneous identical invitations create one membership and audit", tenantLock,
    (f) => invite(f, f.newManager, "order_manager", "active", f.adminA),
    (f) => invite(f, f.newManager, "order_manager", "active", f.adminA), null,
    async (f) => {
      assert.equal(await observer.query(`select count(*) from public.restaurant_members where restaurant_id='${f.tenant}' and user_id='${f.newManager}';`), "1");
      assert.equal(await observer.query(`select count(*) from public.audit_logs where restaurant_id='${f.tenant}' and metadata->>'source'='upsert_restaurant_membership';`), "1");
    });
  await race("waiting invitation rechecks disabled profile",
    (f) => `update public.profiles set active=false where id='${f.adminA}';`, () => "",
    (f) => invite(f, f.newManager, "order_manager", "active", f.adminA), "MEMBERSHIP_MANAGEMENT_FORBIDDEN", unchangedNewManager);
  await race("waiting invitation rechecks revoked super role",
    (f) => `delete from public.platform_user_roles where user_id='${f.super}';`, () => "",
    (f) => invite(f, f.newManager, "order_manager", "active"), "MEMBERSHIP_MANAGEMENT_FORBIDDEN", unchangedNewManager);
  await race("waiting status rechecks revoked super role",
    (f) => `delete from public.platform_user_roles where user_id='${f.super}';`, () => "",
    (f) => status(f, f.memberManager, "suspended"), "MEMBERSHIP_NOT_FOUND_OR_FORBIDDEN",
    async (f) => assert.equal(await observer.query(`select status from public.restaurant_members where id='${f.memberManager}';`), "active"));
  console.log("PASS 9 membership concurrency scenarios; fixtures retained only in the isolated database.");
} finally {
  for (const session of sessions) session.close();
}
