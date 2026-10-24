const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
async function main() {
  const { runCleanup, createCleanupHandler, ownedPath } = await import(pathToFileURL(
    path.resolve(__dirname,'../supabase/functions/cleanup-stale-products/worker.mjs')));
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const job={product_id:id,token:'lease',assets:[
    {bucket:'product-images',path:`products/${id}/photo.webp`},
    {bucket:'product-videos',path:`${id}/video.mp4`},
  ]};
  function client({badBucket='',badRpc='',jobs=[job]}={}) {
    const calls=[];
    return {calls,
      rpc:async (name,args)=>{
        calls.push([name,args]);
        if(name===badRpc) return {error:{message:'mock error'}};
        return {data:name==='claim_product_media_cleanup'?jobs:name==='complete_product_media_cleanup'?true:1};
      },
      storage:{from:bucket=>({remove:async paths=>{
        calls.push(['remove',bucket,paths]);
        return bucket===badBucket?{error:{message:'mock storage failure'}}:{data:[]};
      }})},
    };
  }
  const ok=client();
  assert.deepEqual(await runCleanup(ok,{expireProducts:true}),{archived:1,completed:1,failed:0,pending:0});
  assert.equal(ok.calls[0][0],'cleanup_zero_stock_products_30d');
  assert.equal(ok.calls.at(-1)[0],'complete_product_media_cleanup');
  assert.equal(ok.calls.filter(c=>c[0]==='remove').length,2);
  const partial=client({badBucket:'product-videos'});
  assert.equal((await runCleanup(partial)).failed,1);
  assert.ok(!partial.calls.some(c=>c[0]==='complete_product_media_cleanup'));
  const retry=client();
  assert.equal((await runCleanup(retry)).completed,1);
  assert.ok(!retry.calls.some(c=>c[0]==='cleanup_zero_stock_products_30d'));
  const hostile=client({jobs:[{...job,assets:[{bucket:'product-images',path:'products/another/photo.webp'}]}]});
  assert.equal((await runCleanup(hostile)).failed,1);
  assert.ok(!hostile.calls.some(c=>c[0]==='remove'));
  const failClaim=client({badRpc:'claim_product_media_cleanup'});
  await assert.rejects(runCleanup(failClaim));
  assert.ok(!failClaim.calls.some(c=>c[0]==='remove'));
  assert.equal(ownedPath(id,'unknown',`${id}/file`),false);
  assert.equal(ownedPath(id,'product-videos',`${id}/../other/file`),false);
  const secret='private-test-secret-not-a-live-key-0000';
  let created=0;
  const handler=createCleanupHandler({env:n=>({CLEANUP_FUNCTION_SECRET:secret,SUPABASE_URL:'https://fake.test',SUPABASE_SERVICE_ROLE_KEY:'fake'})[n],
    createClient:()=>{created++;return client();},now:()=>new Date('2026-10-24T06:00:00Z')});
  assert.equal((await handler(new Request('https://fake.test',{method:'POST'}))).status,401);
  assert.equal(created,0);
  const missing=createCleanupHandler({env:()=>'',createClient:()=>{throw Error('Must not create');}});
  assert.equal((await missing(new Request('https://fake.test',{method:'POST'}))).status,503);
  assert.equal((await handler(new Request('https://fake.test',{method:'GET'}))).status,405);
  assert.equal((await handler(new Request('https://fake.test',{method:'POST',headers:{'x-cleanup-secret':secret}}))).status,200);
  console.log('PASS: Storage API deletion, partial-failure retry, ownership, no premature acknowledgments, fail-closed authentication.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
