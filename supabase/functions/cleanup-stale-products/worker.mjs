export function ownedPath(productId, bucket, path) {
  const prefix = bucket === 'product-images' ? `products/${productId}/`
    : bucket === 'product-videos' ? `${productId}/` : '';
  return Boolean(prefix && typeof path === 'string' && path.startsWith(prefix)
    && path.length > prefix.length && !path.includes('..') && !path.includes('\\'));
}

export async function runCleanup(client, { expireProducts = false, deadline = Date.now() + 90000 } = {}) {
  const rpc = async (name, args) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
  const archived = expireProducts ? await rpc('cleanup_zero_stock_products_30d') : 0;
  const jobs = await rpc('claim_product_media_cleanup');
  let completed = 0;
  let failed = 0;
  for (const job of jobs || []) {
    if (Date.now() >= deadline) break;
    try {
      if (!/^[0-9a-f-]{36}$/i.test(job.product_id) || !Array.isArray(job.assets)) throw new Error('Invalid job');
      for (const asset of job.assets) {
        if (!ownedPath(job.product_id, asset.bucket, asset.path)) throw new Error('Unowned asset');
      }
      for (const bucket of ['product-images', 'product-videos']) {
        const paths = [...new Set(job.assets.filter(a => a.bucket === bucket).map(a => a.path))];
        for (let i = 0; i < paths.length; i += 100) {
          if (Date.now() >= deadline) throw new Error('Time budget exceeded');
          const { error } = await client.storage.from(bucket).remove(paths.slice(i, i + 100));
          if (error) throw new Error(`Storage: ${error.message}`);
        }
      }
      const confirmed = await rpc('complete_product_media_cleanup', {
        p_product_id: job.product_id, p_token: job.token,
      });
      if (!confirmed) throw new Error('Expired cleanup lease');
      completed++;
    } catch {
      // Never acknowledge incomplete deletion. Lease expiry permits a safe retry.
      failed++;
    }
  }
  return { archived, completed, failed, pending: (jobs || []).length - completed };
}

export function createCleanupHandler({ env, createClient, now = () => new Date() }) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  return async req => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const secret = env('CLEANUP_FUNCTION_SECRET');
    if (!secret || secret.length < 32) return json({ error: 'Cleanup not configured' }, 503);
    if (req.headers.get('x-cleanup-secret') !== secret) return json({ error: 'Unauthorized' }, 401);
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'Missing server configuration' }, 503);
    try {
      // Only the 06:00 UTC daily window expires products. Other invocations retry files.
      const date = now();
      const expireProducts = date.getUTCHours() === 6 && date.getUTCMinutes() < 15;
      const result = await runCleanup(createClient(url, key, { auth: { persistSession: false } }), { expireProducts });
      return json(result, result.failed ? 500 : 200);
    } catch {
      return json({ error: 'Cleanup failed; pending work will retry' }, 500);
    }
  };
}
