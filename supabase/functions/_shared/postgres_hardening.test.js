import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const enabled = process.env.VOICEBRIDGE_TEST_POSTGRES === "1";
const bin = process.env.VOICEBRIDGE_POSTGRES_BIN || "/opt/homebrew/opt/postgresql@15/bin";

// Explicitly opt in: this test creates and removes its own /tmp cluster and
// never takes a database URL, credentials or connection to a user's database.
// VOICEBRIDGE_TEST_POSTGRES=1 node --test supabase/functions/_shared/postgres_hardening.test.js

test("isolated PostgreSQL migration, checkout concurrency and conservative usage settlement", { skip: !enabled }, async t => {
  try { await access(path.join(bin, "initdb")); }
  catch { throw new Error(`PostgreSQL binaries unavailable at ${bin}; explicit SQL verification cannot run`); }
  const dir = await mkdtemp("/tmp/voicebridge-pg-test-");
  let started = false;
  const psql = (sql) => run(path.join(bin, "psql"), ["-h", dir, "-p", "55439", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql]);
  try {
    await run(path.join(bin, "initdb"), ["-D", dir, "-A", "trust", "--no-locale", "--encoding=UTF8"]);
    await run(path.join(bin, "pg_ctl"), ["-D", dir, "-l", path.join(dir, "server.log"), "-o", `-k ${dir} -p 55439 -c listen_addresses=''`, "start"]);
    started = true;
    await psql(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema realtime;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create function realtime.topic() returns text language sql as $$ select ''::text $$;
      create table realtime.messages(extension text);
    `);
    for (const name of [
      "0001_cloud_core.sql", "0002_transcribe_usage_reservations.sql", "0003_auto_create_profile.sql",
      "0004_device_pairing.sql",
      "0011_admin_plan.sql", "0016_migrate_stripe_to_paddle.sql", "0017_fix_integer_overflow.sql",
      "0019_fix_claim_checkout_all_ambiguous.sql", "0020_fix_claim_checkout_out_params.sql",
      "20260804042520_fix_billing_event_effect_contract.sql", "20261011141803_harden_billing_checkout_and_asr_settlement.sql",
      "20261012014407_serialize_account_deletion_with_checkout.sql",
      "20261012014916_retain_checkout_owner_until_subscription_fact.sql",
      "20261014103000_recover_stale_checkout_attempts.sql",
      "20261014103100_clear_deletion_request_after_cancel_failure.sql",
      "20261015093000_rpc_device_and_checkout_settlement.sql"
    ]) await psql(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));

    const first = "11111111-1111-4111-8111-111111111111";
    const quotaUser = "22222222-2222-4222-8222-222222222222";
    const billingUser = "33333333-3333-4333-8333-333333333333";
    const deleteFirst = "44444444-4444-4444-8444-444444444444";
    const checkoutFirst = "55555555-5555-4555-8555-555555555555";
    const lateFactUser = "66666666-6666-4666-8666-666666666666";
    const staleUser = "77777777-7777-4777-8777-777777777777";
    const releaseUser = "88888888-8888-4888-8888-888888888888";
    await psql(`insert into auth.users(id) values('${first}'),('${quotaUser}'),('${billingUser}'),('${deleteFirst}'),('${checkoutFirst}'),('${lateFactUser}'),('${staleUser}'),('${releaseUser}')`);
    const claim = async () => JSON.parse((await psql(`select public.claim_checkout_attempt('${first}', 'paddle')`)).stdout.trim());
    const results = await Promise.all([claim(), claim()]);
    assert.equal(results.filter(r => r.acquired).length, 1, "only one concurrent creator");
    assert.equal(results[0].id, results[1].id);
    const original = results.find(r => r.acquired);
    await psql(`update public.billing_checkout_attempts set updated_at=now()-interval '1 minute' where id='${original.id}'`);
    const renewed = await claim();
    assert.equal(renewed.acquired, true);
    assert.notEqual(renewed.lease_token, original.lease_token);
    assert.equal((await psql(`select public.start_checkout_provider_request('${original.id}','${original.lease_token}')`)).stdout.trim(), "f");
    assert.equal((await psql(`select public.start_checkout_provider_request('${renewed.id}','${renewed.lease_token}')`)).stdout.trim(), "t");
    await psql(`update public.billing_checkout_attempts set updated_at=now()-interval '1 hour' where id='${renewed.id}'`);
    assert.equal((await claim()).acquired, false, "never recreate an uncertain provider request");
    assert.equal((await psql(`select public.update_checkout_attempt('${renewed.id}','${original.lease_token}','open','txn_old','https://old.invalid')`)).stdout.trim(), "f");
    assert.equal((await psql(`select public.update_checkout_attempt('${renewed.id}','${renewed.lease_token}','open','txn_new','https://new.invalid')`)).stdout.trim(), "t");
    assert.equal((await claim()).provider_transaction_id, "txn_new", "open checkout is reused");

    // Race the actual RPCs in both invocation orders and across both providers.
    // At most one may acquire permission to delete/create a payable checkout.
    for (const [user, provider, deletionFirst] of [[deleteFirst, "paddle", true], [checkoutFirst, "stripe", false]]) {
      const deleting = async () => (await psql(`select public.begin_account_deletion('${user}')`)).stdout.trim();
      const buying = async () => JSON.parse((await psql(`select public.claim_checkout_attempt('${user}', '${provider}')`)).stdout.trim());
      const result = await Promise.all(deletionFirst ? [deleting(), buying()] : [buying(), deleting()]);
      const deletion = result[deletionFirst ? 0 : 1], purchase = result[deletionFirst ? 1 : 0];
      assert.equal(Number(deletion === "account_deleting") + Number(purchase.acquired), 1);
      if (purchase.acquired) {
        assert.equal(deletion, "checkout_pending");
        assert.equal((await psql(`select account_deletion_requested_at is null from public.profiles where user_id='${user}'`)).stdout.trim(), "t");
      } else {
        assert.equal(purchase.status, "account_deleting");
        assert.equal(await deleting(), "account_deleting", "cancellation failures can retry deletion without reopening checkout");
      }
    }
    const deletionPrivileges = (await psql(`select has_function_privilege('authenticated','public.begin_account_deletion(uuid)','execute'),has_function_privilege('service_role','public.begin_account_deletion(uuid)','execute'),has_column_privilege('authenticated','public.profiles','account_deletion_requested_at','update')`)).stdout.trim();
    assert.equal(deletionPrivileges, "f|t|f");
    await assert.rejects(psql(`set role authenticated; update public.profiles set account_deletion_requested_at=null where user_id='${deleteFirst}'`), /permission denied/);
    await assert.rejects(psql(`set role authenticated; select public.begin_account_deletion('${deleteFirst}')`), /permission denied/);

    // Paddle's payment completion can precede subscription.created. The
    // completed attempt must retain ownership until that fact can be canceled.
    const lateAttempt = JSON.parse((await psql(`select public.claim_checkout_attempt('${lateFactUser}','paddle')`)).stdout.trim());
    await psql(`select public.start_checkout_provider_request('${lateAttempt.id}','${lateAttempt.lease_token}');
      select public.update_checkout_attempt('${lateAttempt.id}','${lateAttempt.lease_token}','open','txn_late','https://late.invalid')`);
    const transactionEffect = JSON.stringify({ type: "transaction", user_id: lateFactUser, customer_id: "ctm_late", subscription_id: "sub_late", transaction_id: "txn_late" });
    assert.equal((await psql(`select public.process_billing_event('paddle','evt_paid_first','transaction.completed',now(),'{"data":{"id":"txn_late"}}'::jsonb,'${transactionEffect}'::jsonb)`)).stdout.trim(), "processed");
    assert.equal((await psql(`select status||':'||provider_subscription_id from public.billing_checkout_attempts where id='${lateAttempt.id}'`)).stdout.trim(), "completed:sub_late");
    for (const provider of ["paddle", "stripe"]) {
      const secondPurchase = JSON.parse((await psql(`select public.claim_checkout_attempt('${lateFactUser}','${provider}')`)).stdout.trim());
      assert.equal(secondPurchase.status, "subscription_pending");
      assert.equal(secondPurchase.acquired, false, "a received payment cannot create another purchase while its subscription fact is delayed");
    }
    assert.equal((await psql(`select public.begin_account_deletion('${lateFactUser}')`)).stdout.trim(), "checkout_pending");
    assert.equal((await psql(`select account_deletion_requested_at is null from public.profiles where user_id='${lateFactUser}'`)).stdout.trim(), "t");
    const lateSubscription = JSON.stringify({ type: "subscription", user_id: lateFactUser, customer_id: "ctm_late", subscription_id: "sub_late", price_id: "pri_test", plan: "pro", status: "active" });
    assert.equal((await psql(`select public.process_billing_event('paddle','evt_subscription_later','subscription.created',now(),'{}'::jsonb,'${lateSubscription}'::jsonb)`)).stdout.trim(), "processed");
    assert.equal(JSON.parse((await psql(`select public.claim_checkout_attempt('${lateFactUser}','paddle')`)).stdout.trim()).status, "entitlement_exists");
    assert.equal((await psql(`select public.begin_account_deletion('${lateFactUser}')`)).stdout.trim(), "account_deleting");

    // An ambiguous provider failure (timeout/5xx with no recorded transaction)
    // must not lock purchases and deletion forever. After a bounded window the
    // stale attempt retires and both flows proceed on a fresh attempt.
    const staleAttempt = JSON.parse((await psql(`select public.claim_checkout_attempt('${staleUser}','paddle')`)).stdout.trim());
    assert.equal(staleAttempt.acquired, true);
    assert.equal((await psql(`select public.start_checkout_provider_request('${staleAttempt.id}','${staleAttempt.lease_token}')`)).stdout.trim(), "t");
    await psql(`update public.billing_checkout_attempts set provider_request_started_at=now()-interval '16 minutes', updated_at=now()-interval '16 minutes' where id='${staleAttempt.id}'`);
    const recovered = JSON.parse((await psql(`select public.claim_checkout_attempt('${staleUser}','paddle')`)).stdout.trim());
    assert.equal(recovered.acquired, true, "a stale uncertain provider request is retired, not a lifetime lock");
    assert.notEqual(recovered.id, staleAttempt.id);
    assert.equal((await psql(`select status from public.billing_checkout_attempts where id='${staleAttempt.id}'`)).stdout.trim(), "expired");
    // Fresh uncertainty stays fenced inside the window (regression guard).
    assert.equal(JSON.parse((await psql(`select public.claim_checkout_attempt('${staleUser}','paddle')`)).stdout.trim()).acquired, false);
    assert.equal((await psql(`select public.begin_account_deletion('${staleUser}')`)).stdout.trim(), "checkout_pending");
    await psql(`update public.billing_checkout_attempts set provider_request_started_at=now()-interval '16 minutes', updated_at=now()-interval '16 minutes' where user_id='${staleUser}'`);
    assert.equal((await psql(`select public.begin_account_deletion('${staleUser}')`)).stdout.trim(), "account_deleting", "a stale attempt no longer blocks deletion");

    // A provider-cancellation failure releases the deletion intent so the
    // user is not permanently forbidden from buying again.
    assert.equal((await psql(`select public.begin_account_deletion('${releaseUser}')`)).stdout.trim(), "account_deleting");
    assert.equal(JSON.parse((await psql(`select public.claim_checkout_attempt('${releaseUser}','paddle')`)).stdout.trim()).status, "account_deleting");
    assert.equal((await psql(`select public.clear_account_deletion_request('${releaseUser}')`)).stdout.trim(), "t");
    assert.equal(JSON.parse((await psql(`select public.claim_checkout_attempt('${releaseUser}','paddle')`)).stdout.trim()).acquired, true, "releasing the deletion intent reopens purchases");
    assert.equal((await psql(`select account_deletion_requested_at is null from public.profiles where user_id='${releaseUser}'`)).stdout.trim(), "t");
    const clearPrivileges = (await psql(`select has_function_privilege('authenticated','public.clear_account_deletion_request(uuid)','execute'),has_function_privilege('service_role','public.clear_account_deletion_request(uuid)','execute')`)).stdout.trim();
    assert.equal(clearPrivileges, "f|t");

    // Device-ownership authorization and Stripe checkout settlement live in
    // RPCs so this SQL suite exercises them end to end.
    const deviceOwner = "99999999-9999-4999-8999-999999999999";
    const runtimeUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const desktopId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await psql(`insert into auth.users(id) values('${deviceOwner}'),('${runtimeUser}')`);
    await psql(`insert into public.devices(id, user_id, name, device_type, platform, status, runtime_user_id, paired_at)
      values('${desktopId}', '${deviceOwner}', 'test-desktop', 'desktop', 'darwin', 'active', '${runtimeUser}', now())`);
    const resolve = (runtime) => psql(`select public.resolve_transcribe_device('${desktopId}', '${runtime}')`);
    assert.equal((await resolve(runtimeUser)).stdout.trim(), `{"paired": true, "user_id": "${deviceOwner}"}`);
    assert.equal((await resolve(deviceOwner)).stdout.trim(), '{"paired": false}', "a foreign runtime account cannot transcribe through the device");
    await psql(`update public.devices set status='revoked' where id='${desktopId}'`);
    assert.equal((await resolve(runtimeUser)).stdout.trim(), '{"paired": false}', "a revoked device cannot transcribe");
    await psql(`insert into public.billing_checkout_attempts(user_id, provider, status, expires_at, lease_token, provider_transaction_id)
      values('${deviceOwner}', 'stripe', 'open', now() + interval '5 minutes', gen_random_uuid(), 'cs_sql_test')`);
    assert.equal((await psql(`select public.settle_stripe_checkout_attempt('cs_sql_test','completed')`)).stdout.trim(), "1");
    assert.equal((await psql(`select status from public.billing_checkout_attempts where provider_transaction_id='cs_sql_test'`)).stdout.trim(), "completed");
    assert.equal((await psql(`select public.settle_stripe_checkout_attempt('cs_sql_test','completed')`)).stdout.trim(), "0", "settlement is idempotent");
    assert.equal((await psql(`select public.settle_stripe_checkout_attempt('cs_missing','expired')`)).stdout.trim(), "0");
    await assert.rejects(psql(`select public.settle_stripe_checkout_attempt('cs_sql_test','failed')`), /Invalid checkout settlement status/);
    const rpcPrivileges = (await psql(`select has_function_privilege('authenticated','public.resolve_transcribe_device(uuid,uuid)','execute'),has_function_privilege('service_role','public.settle_stripe_checkout_attempt(text,text)','execute')`)).stdout.trim();
    assert.equal(rpcPrivileges, "f|t");

    await psql(`insert into public.usage_events(user_id,request_id,provider,mode,audio_duration_ms,audio_size_bytes,status,created_at)
      values('${quotaUser}',gen_random_uuid(),'tencent_cloud','cloud',590000,100,'processing',now()-interval '20 minutes')`);
    const reservation = async ms => JSON.parse((await psql(`select public.reserve_and_get_plan('${quotaUser}',gen_random_uuid(),'tencent_cloud','cloud',${ms},100,null)`)).stdout.trim());
    assert.equal((await reservation(15000)).error_code, "quota_exceeded", "expired unknown usage still consumes quota");
    const unknown = (await psql(`select status||':'||error_code||':'||(settled_at is not null)::text from public.usage_events where user_id='${quotaUser}'`)).stdout.trim();
    assert.equal(unknown, "unknown:reservation_expired_unknown:true");
    assert.equal((await reservation(10000)).error_code, null);
    assert.equal((await reservation(1)).error_code, "quota_exceeded");

    const effect = JSON.stringify({ type: "subscription", user_id: billingUser, customer_id: "ctm_test", subscription_id: "sub_test", price_id: "pri_test", plan: "pro", status: "active" });
    const processEvent = async payload => (await psql(`select public.process_billing_event('paddle','evt_retry','subscription.created',now(),'{}'::jsonb,'${payload}'::jsonb)`)).stdout.trim();
    assert.equal(await processEvent(JSON.stringify({ type: "subscription", user_id: billingUser })), "failed");
    assert.equal(await processEvent(effect), "processed", "a failed event can be retried");
    assert.equal(await processEvent(effect), "duplicate");
    assert.equal((await psql(`select status from public.subscriptions where user_id='${billingUser}'`)).stdout.trim(), "active");
    const stripeEffect = JSON.stringify({ type: "subscription", user_id: billingUser, customer_id: "cus_test", subscription_id: "sub_stripe", price_id: "price_test", plan: "pro", status: "active" });
    const concurrentEvent = async () => (await psql(`select public.process_billing_event('stripe','evt_parallel','customer.subscription.updated',now(),'{}'::jsonb,'${stripeEffect}'::jsonb)`)).stdout.trim();
    assert.deepEqual((await Promise.all([concurrentEvent(), concurrentEvent()])).sort(), ["duplicate", "processed"]);
    assert.equal((await psql(`select count(*) from public.billing_events where provider='stripe' and event_id='evt_parallel'`)).stdout.trim(), "1");
    const privileges = (await psql(`select has_function_privilege('authenticated','public.claim_checkout_attempt(uuid,text)','execute'),has_function_privilege('service_role','public.claim_checkout_attempt(uuid,text)','execute')`)).stdout.trim();
    assert.equal(privileges, "f|t");
  } finally {
    if (started) await run(path.join(bin, "pg_ctl"), ["-D", dir, "stop", "-m", "fast"]);
    await rm(dir, { recursive: true, force: true });
  }
});
