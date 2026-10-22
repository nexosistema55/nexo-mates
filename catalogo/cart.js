(() => {
  const key = 'nexo-catalog-cart-v1';
  const root = new URL('./', document.currentScript.src);
  const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let adapter = null;
  let busy = false;
  let revision = 0;
  let timer;
  let previousFocus;
  const clean = (rows) => {
    if (!Array.isArray(rows)) return [];
    const unique = new Map();
    rows.slice(0, 50).forEach((row) => {
      if (!row || typeof row.id !== 'string' || typeof row.slug !== 'string' || !row.id || !row.slug) return;
      const variant = String(row.variant || '').slice(0, 100);
      const item = { id: row.id, slug: row.slug, variant, name: String(row.name || 'Producto').slice(0, 200), code: String(row.code || '').slice(0, 100), image: String(row.image || ''), price: Number.isFinite(Number(row.price)) ? Math.min(1e12, Math.max(0, Number(row.price))) : 0, quantity: Math.min(99, Math.max(1, Math.floor(Number(row.quantity) || 1))), available: row.available !== false };
      unique.set(JSON.stringify([item.id, variant]), item);
    });
    return [...unique.values()];
  };
  const read = () => { try { return clean(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return []; } };
  let items = read();
  const header = document.querySelector('.catalog-header');
  if (!header) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'catalog-cart-trigger';
  trigger.setAttribute('aria-label', 'Abrir carrito');
  trigger.setAttribute('aria-haspopup', 'dialog');
  header.append(trigger);
  const toast = document.createElement('div');
  toast.className = 'catalog-cart-toast';
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  document.body.append(toast);
  const dialog = document.createElement('dialog');
  dialog.className = 'catalog-cart-dialog';
  dialog.setAttribute('aria-labelledby', 'catalogCartTitle');
  dialog.innerHTML = `<div class="catalog-cart-layout"><header class="catalog-cart-head"><h2 id="catalogCartTitle">Tu carrito</h2><button type="button" data-cart-close aria-label="Cerrar carrito" title="Cerrar">&times;</button></header><div class="catalog-cart-items"></div><footer class="catalog-cart-footer"><div class="catalog-cart-total"><span>Total estimado</span><strong></strong></div><p role="status" class="catalog-cart-status"></p><button type="button" class="catalog-cart-checkout">Consultar por WhatsApp</button><button type="button" class="catalog-cart-continue">Seguir viendo productos</button></footer></div>`;
  document.body.append(dialog);
  const list = dialog.querySelector('.catalog-cart-items');
  const status = dialog.querySelector('.catalog-cart-status');
  const checkout = dialog.querySelector('.catalog-cart-checkout');
  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { toast.hidden = true; }, 3000);
  }
  function persist() {
    revision++;
    try { localStorage.setItem(key, JSON.stringify(items)); }
    catch { notify('El navegador no permite guardar el carrito.'); }
  }
  function render() {
    const count = items.reduce((total, item) => total + item.quantity, 0);
    trigger.innerHTML = `<img src="${new URL('../assets/shopping-cart.svg', root).href}" alt="" width="20" height="20">Carrito <span>${count}</span>`;
    trigger.setAttribute('aria-label', `Abrir carrito, ${count} productos`);
    list.innerHTML = items.map((item, index) => {
      const url = new URL('producto.html', root);
      url.searchParams.set('slug', item.slug);
      const image = /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);)/i.test(item.image) ? item.image : '';
      return `<article class="catalog-cart-item">${image ? `<img src="${escape(image)}" alt="" loading="lazy">` : '<div class="catalog-cart-image-empty" aria-hidden="true"></div>'}<div class="catalog-cart-item-info"><a href="${escape(url.href)}">${escape(item.name)}</a><small>${escape([item.code, item.variant].filter(Boolean).join(' · '))}</small><span>${money.format(item.price)} c/u</span>${!item.available ? '<strong class="catalog-cart-unavailable">No disponible</strong>' : ''}<div class="catalog-cart-quantity"><button type="button" data-cart-change="${index}" data-delta="-1" title="Restar una unidad" aria-label="Restar una unidad" ${busy || item.quantity <= 1 ? 'disabled' : ''}>&minus;</button><input type="number" min="1" max="99" step="1" inputmode="numeric" data-cart-quantity="${index}" aria-label="Cantidad de ${escape(item.name)}" value="${item.quantity}" ${busy ? 'disabled' : ''}><button type="button" data-cart-change="${index}" data-delta="1" title="Sumar una unidad" aria-label="Sumar una unidad" ${busy || item.quantity >= 99 ? 'disabled' : ''}>+</button></div></div><div class="catalog-cart-item-end"><button type="button" data-cart-remove="${index}" aria-label="Quitar ${escape(item.name)}" title="Quitar producto" ${busy ? 'disabled' : ''}>&times;</button><strong>${money.format(item.price * item.quantity)}</strong></div></article>`;
    }).join('') || '<div class="catalog-cart-empty">Tu carrito esta vacio.</div>';
    dialog.querySelector('.catalog-cart-total strong').textContent = money.format(items.reduce((total, item) => total + item.price * item.quantity, 0));
    checkout.disabled = busy || !items.length || items.some((item) => !item.available);
    checkout.textContent = busy ? 'Consultando precios y disponibilidad...' : 'Consultar por WhatsApp';
  }
  function close() { dialog.close(); }
  trigger.addEventListener('click', () => {
    previousFocus = document.activeElement;
    status.textContent = '';
    render();
    dialog.showModal();
    document.body.classList.add('catalog-cart-open');
    dialog.querySelector('[data-cart-close]').focus();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('catalog-cart-open');
    previousFocus?.focus();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-cart-close], .catalog-cart-continue')) { close(); return; }
    if (busy) return;
    const remove = event.target.closest('[data-cart-remove]');
    const change = event.target.closest('[data-cart-change]');
    if (remove) items.splice(Number(remove.dataset.cartRemove), 1);
    else if (change) {
      const item = items[Number(change.dataset.cartChange)];
      if (item) item.quantity = Math.min(99, Math.max(1, item.quantity + Number(change.dataset.delta)));
    } else return;
    status.textContent = '';
    persist();
    render();
    if (change) dialog.querySelector(`[data-cart-quantity="${change.dataset.cartChange}"]`)?.focus();
  });
  dialog.addEventListener('change', (event) => {
    if (busy || !event.target.matches('[data-cart-quantity]')) return;
    const item = items[Number(event.target.dataset.cartQuantity)];
    if (!item) return;
    item.quantity = Math.min(99, Math.max(1, Math.floor(Number(event.target.value) || 1)));
    persist();
    render();
  });
  checkout.addEventListener('click', async () => {
    if (busy || !items.length || !adapter) return;
    const business = adapter.getBusiness();
    const phone = String(business.whatsappNumber || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) { status.textContent = 'El WhatsApp del negocio no esta disponible.'; return; }
    busy = true;
    status.textContent = '';
    const started = revision;
    const snapshot = items.map((item) => ({ ...item }));
    render();
    try {
      const fresh = await Promise.all(snapshot.map((item) => adapter.resolve(item)));
      if (started !== revision) { status.textContent = 'El carrito cambio. Revisa el pedido y consulta nuevamente.'; return; }
      let changed = false;
      items = snapshot.map((item, index) => {
        const product = fresh[index];
        if (!product || product.id !== item.id || !product.available) return { ...item, available: false };
        if (product.price !== item.price) changed = true;
        return { ...item, name: product.name, code: product.code, price: product.price, available: true };
      });
      persist();
      if (items.some((item) => !item.available)) { status.textContent = 'Hay productos no disponibles. Quitalos para continuar.'; return; }
      if (changed) { status.textContent = 'Actualizamos los precios. Revisa el total y volve a consultar.'; return; }
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const lines = [`Hola ${business.businessName}, quiero consultar por este pedido:`, '', ...items.map((item) => `${item.quantity} x ${item.name}${item.code ? ` (${item.code})` : ''}${item.variant ? ` - ${item.variant}` : ''} — ${money.format(item.price * item.quantity)}`), '', `Total estimado: ${money.format(total)}`, '', ...items.map((item) => { const url = new URL('producto.html', root); url.searchParams.set('slug', item.slug); return `${item.code || item.name}: ${url.href}`; })];
      const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(lines.join('\n'))}`;
      // Same-tab navigation avoids popup blockers after asynchronous validation.
      window.location.assign(whatsappUrl);
    } catch {
      status.textContent = 'No pudimos verificar el pedido. Volve a intentar cuando tengas conexion.';
    } finally { busy = false; render(); }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    items = read();
    revision++;
    render();
  });
  window.NexoCatalogCart = {
    configure(value) { adapter = value; },
    add(product, variant = '') {
      if (busy) { notify('Espera a que termine la consulta del pedido.'); return; }
      const existing = items.find((item) => item.id === product.id && item.variant === variant);
      if (existing) {
        existing.quantity = Math.min(99, existing.quantity + 1);
        Object.assign(existing, product);
        existing.available = true;
      } else {
        if (items.length >= 50) { notify('El carrito admite hasta 50 productos diferentes.'); return; }
        items.push({ ...product, variant, quantity: 1, available: true });
      }
      persist();
      render();
      notify(`${product.name} agregado al carrito`);
    },
  };
  render();
})();
