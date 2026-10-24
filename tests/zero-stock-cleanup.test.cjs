// PGLITE_MODULE points to a test-only PGlite installation; no live database.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/202610240001_automatic_zero_stock_cleanup.sql');
async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table products(id uuid primary key default gen_random_uuid(), sku text,
        tracks_stock boolean default true, published boolean default true, archived_at timestamptz,
        out_of_stock_since timestamptz, cleanup_deleted_at timestamptz,
        video_url text default 'https://example.test/retained.mp4', video_path text default 'retained.mp4');
      create table product_variants(id uuid primary key default gen_random_uuid(), product_id uuid references products,
        current_stock integer default 0, active boolean default true, archived_at timestamptz);
      create table product_images(id uuid primary key default gen_random_uuid(), product_id uuid references products,
        archived_at timestamptz, storage_path text default 'retained.webp', public_url text);
      create table audit_log(entity_id uuid, action text, before_data jsonb, payload jsonb);
      create table sale_items(product_id uuid references products, amount integer);
      create function add_audit_log(text,uuid,text,uuid,jsonb,jsonb,jsonb) returns void language sql
        as $$insert into audit_log values($2,$3,$5,$7)$$;
      create schema cron;
      create table cron.job(jobname text primary key, schedule text, command text, active boolean default true);
      create function cron.schedule(text,text,text) returns bigint language sql as $$
        insert into cron.job(jobname,schedule,command) values($1,$2,$3)
        on conflict(jobname) do update set schedule=$2,command=$3; select 1::bigint;
      $$;
    `);
    const legacy = read('supabase/migrations/202609150004_stale_product_cleanup.sql');
    await db.exec(legacy.slice(legacy.indexOf('create or replace function public.refresh_product'),
      legacy.indexOf('-- Inicializa el reloj')));
    const ids = {};
    async function product(name, days, stock = 0, extra = '') {
      const id = (await db.query('insert into products(sku) values($1) returning id',[name])).rows[0].id;
      ids[name] = id;
      await db.query('insert into product_variants(product_id,current_stock) values($1,$2)',[id,stock]);
      await db.query('insert into product_images(product_id) values($1)',[id]);
      await db.query(`update products set out_of_stock_since=now()-($2::integer*interval '1 day') where id=$1`,[id,days]);
      if (extra) await db.exec(extra.replaceAll(':id',`'${id}'`));
    }
    await product('old',31);
    await product('exact',30);
    await product('recent',29);
    await product('positive',40,3);
    await product('untracked',40,0,'update products set tracks_stock=false where id=:id');
    await product('MANUAL_INTERNAL',40);
    await product('already',40,0,'update products set archived_at=now() where id=:id');
    await product('missing',null);
    await product('restocked',40);
    await db.query('update product_variants set current_stock=2 where product_id=$1',[ids.restocked]);
    assert.equal((await db.query('select out_of_stock_since from products where id=$1',[ids.restocked])).rows[0].out_of_stock_since,null);
    await db.query('update product_variants set current_stock=0 where product_id=$1',[ids.restocked]);
    await product('mixed',40);
    await db.query('insert into product_variants(product_id,current_stock) values($1,1)',[ids.mixed]);
    await product('inactive',40,0,'update product_variants set active=false where product_id=:id');
    await db.query('insert into sale_items values($1,100)',[ids.old]);
    // WASM cannot run pg_cron: stub only extension guard and schedule implementation.
    const install = migration.replace(/do \$\$[\s\S]*?\$\$;/,'');
    await db.exec(install);
    await db.exec(install);
    assert.equal((await db.query('select count(*)::int as n from cron.job')).rows[0].n,1);
    assert.equal((await db.query('select schedule from cron.job')).rows[0].schedule,'0 6 * * *');
    assert.ok((await db.query('select out_of_stock_since from products where id=$1',[ids.missing])).rows[0].out_of_stock_since);
    assert.equal((await db.query('select cleanup_zero_stock_products_30d() as n')).rows[0].n,2);
    assert.equal((await db.query('select cleanup_zero_stock_products_30d() as n')).rows[0].n,0);
    for (const name of Object.keys(ids)) {
      const p = (await db.query('select * from products where id=$1',[ids[name]])).rows[0];
      assert.equal(Boolean(p.cleanup_deleted_at),['old','exact'].includes(name),name);
      assert.equal(p.video_path,'retained.mp4');
    }
    for (const [table,n] of [['sale_items',1],['product_images',11],['audit_log',2]]) {
      assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n,n);
    }
    assert.equal((await db.query('select count(*)::int as n from product_variants where not active and archived_at is not null')).rows[0].n,2);
    for (const role of ['authenticated','anon']) {
      assert.equal((await db.query(`select has_function_privilege('${role}','cleanup_zero_stock_products_30d()','EXECUTE') as allowed`)).rows[0].allowed,false);
    }
    assert.equal((await db.query("select has_function_privilege('service_role','list_stale_out_of_stock_product_assets(integer)','EXECUTE') as allowed")).rows[0].allowed,false);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select cleanup_zero_stock_products_30d()'),/permission denied/);
    await db.exec('reset role');
    assert.match(migration,/for update skip locked/);
    assert.match(migration,/for update nowait/);
    assert.match(migration,/exception when lock_not_available/);
    const endpoint = read('supabase/functions/cleanup-stale-products/index.ts');
    assert.match(endpoint,/createCleanupHandler/);
    // Real queue/completion SQL, with only Vault/pg_net infrastructure stubbed.
    await db.exec(`create schema storage;
      create table storage.objects(bucket_id text,name text);
      create schema vault;
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values('nexo_cleanup_secret',repeat('a',40));
      create schema net;
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
        returns bigint language sql as $$select 1::bigint$$;`);
    const purge = read('supabase/migrations/202610240002_zero_stock_storage_purge.sql');
    const installPurge = purge.replace(/do \$\$[\s\S]*?\$\$;/,'');
    await db.exec(installPurge);
    await db.exec(installPurge);
    assert.equal((await db.query('select count(*)::int as n from cron.job')).rows[0].n,2);
    const imagePath = `products/${ids.old}/photo.webp`;
    const videoPath = `${ids.old}/video.mp4`;
    await db.query('insert into storage.objects values($1,$2),($3,$4)',
      ['product-images',imagePath,'product-videos',videoPath]);
    const sharedPath = `products/${ids.old}/shared.webp`;
    const otherPath = `products/${ids.recent}/photo.webp`;
    await db.query('insert into storage.objects values($1,$2),($1,$3)',
      ['product-images',sharedPath,otherPath]);
    await db.query('update product_images set storage_path=$1 where product_id=$2',[sharedPath,ids.positive]);
    let jobs = (await db.query('select claim_product_media_cleanup() as jobs')).rows[0].jobs;
    assert.equal(jobs.length,2);
    assert.equal(jobs.find(j=>j.product_id===ids.old).assets.length,2);
    assert.deepEqual((await db.query('select claim_product_media_cleanup() as jobs')).rows[0].jobs,[]);
    assert.equal((await db.query('select complete_product_media_cleanup($1,gen_random_uuid()) as ok',[ids.old])).rows[0].ok,false);
    const expiredToken = jobs.find(j=>j.product_id===ids.old).token;
    await db.exec("update product_cleanup_queue set leased_until=now()-interval '1 minute'");
    jobs = (await db.query('select claim_product_media_cleanup() as jobs')).rows[0].jobs;
    assert.notEqual(jobs.find(j=>j.product_id===ids.old).token,expiredToken);
    assert.equal((await db.query('select complete_product_media_cleanup($1,$2) as ok',[ids.old,expiredToken])).rows[0].ok,false);
    // Mirror successful Storage API removal, then acknowledge the claimed jobs.
    for (const job of jobs) {
      for (const asset of job.assets) {
        await db.query('delete from storage.objects where bucket_id=$1 and name=$2',[asset.bucket,asset.path]);
      }
      assert.equal((await db.query('select complete_product_media_cleanup($1,$2) as ok',[job.product_id,job.token])).rows[0].ok,true);
    }
    assert.equal((await db.query('select count(*)::int as n from products where id=$1',[ids.exact])).rows[0].n,0);
    assert.equal((await db.query('select video_path from products where id=$1',[ids.old])).rows[0].video_path,'');
    assert.equal((await db.query('select count(*)::int as n from sale_items')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from product_images where product_id=$1',[ids.old])).rows[0].n,0);
    assert.deepEqual((await db.query('select claim_product_media_cleanup() as jobs')).rows[0].jobs,[]);
    assert.equal((await db.query('select count(*)::int as n from storage.objects')).rows[0].n,2);
    assert.equal((await db.query("select has_function_privilege('authenticated','complete_product_media_cleanup(uuid,uuid)','EXECUTE') as ok")).rows[0].ok,false);
    if (process.env.DELIVERED_SQL) {
      const combined = fs.readFileSync(process.env.DELIVERED_SQL,'utf8');
      await db.exec(combined.replace(/do \$\$[\s\S]*?\$\$;/g,''));
      assert.equal((await db.query('select count(*)::int as n from cron.job')).rows[0].n,2);
    }
    console.log('PASS: stock expiry, restocking, idempotency, queue leases, Storage paths, physical deletion, preserved sales and permissions.');
    console.log('Cron scheduling and concurrent sessions require hosted PostgreSQL verification.');
  } finally { await db.close(); }
}
main().catch(error => {console.error(error); process.exitCode=1;});
