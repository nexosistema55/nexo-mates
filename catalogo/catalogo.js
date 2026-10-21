const BASE_COMERCIOS_BUSINESS = {
  businessName: "Nexo Mates",
  whatsappNumber: "",
  defaultWhatsappMessage: "Hola {businessName}, quiero consultar por este producto:",
  ...(window.BASE_COMERCIOS_BUSINESS_CONFIG || {}),
};

const BASE_COMERCIOS_CATALOG_CONFIG = {
  supabaseUrl: "",
  supabasePublishableKey: "",
  enabled: false,
  productsView: "catalog_products",
  localStoreKey: "sistema-base-comercios-control-v1",
  sizeAvailabilityMode: BASE_COMERCIOS_BUSINESS.sizeAvailabilityMode || "show-unavailable",
  outOfStockProductMode: BASE_COMERCIOS_BUSINESS.outOfStockProductMode || "show",
  ...(window.BASE_COMERCIOS_CATALOG_REMOTE_CONFIG || {}),
};

const currency = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});

let catalogProducts = [];
let catalogClient = null;
let catalogRemotePaging = false;
let catalogCurrentPage = 1;
let catalogTotalCount = 0;
let catalogPageSize = 20;
let catalogSearchTimer = null;
let catalogPageRequest = 0;

function catalogRootPath() {
  return window.location.protocol === "file:" ? new URL("./", window.location.href).href : `${window.location.origin}/catalogo/`;
}

function catalogSection() {
  return "all";
}

function isProductDetailPage() {
  return Boolean(document.getElementById("productDetail"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function productSlug(product) {
  return product.slug || slugify(`${product.code || ""}-${product.name || product.description || ""}-${product.color || ""}`);
}

function productPublicUrl(product) {
  return `${catalogRootPath()}producto.html?slug=${encodeURIComponent(productSlug(product))}`;
}

function normalizeImages(row) {
  const value = row.images || row.imageUrls || row.image_urls || row.photos || row.photo_urls || [];
  if (Array.isArray(value)) {
    return value
      .map((image) => String(image?.url || image?.storage_path || image?.storagePath || image || "").trim())
      .filter(Boolean);
  }
  return String(value || "").split(/\r?\n|,/).map((url) => url.trim()).filter(Boolean);
}

function normalizeSizes(row) {
  const value = row.sizeVariants || row.size_variants || row.sizes || row.variants || [];
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n|,/).map((entry) => {
      const [size, stock = "0"] = entry.split(/[:=]/);
      return { size, stock };
    });
  return list
    .map((variant) => ({
      size: String(variant.size || variant.talle || variant.name || "").trim().toUpperCase(),
      stock: variant.stock == null && variant.available === true
        ? 1
        : Math.max(0, Math.floor(Number(variant.stock || variant.quantity || 0))),
    }))
    .filter((variant) => variant.size);
}

function normalizeCatalogProduct(row) {
  const sizes = normalizeSizes(row);
  const stock = sizes.length
    ? sizes.reduce((total, variant) => total + Number(variant.stock || 0), 0)
    : Number(row.stock || 0);
  const name = row.name || row.description || "Producto";
  return {
    id: row.id,
    slug: row.slug,
    code: row.code || "",
    name,
    description: row.catalogDescription || row.catalog_description || row.description || name,
    category: row.category || "Sin categoria",
    subcategory: row.subcategory || "",
    color: row.color || "",
    colorGroup: row.colorGroup || row.color_group || row.modelSlug || row.model_slug || slugify(name.replace(/\b(negro|blanco|rojo|azul|verde|rosa|beige|marron|gris)\b/gi, "")),
    price: Number(row.price || 0),
    promoPrice: Number(row.promoPrice || row.promo_price || 0),
    wholesalePrice: Number(row.wholesalePrice || row.wholesale_price || 0),
    stock,
    tracksStock: row.tracks_stock ?? row.tracksStock ?? true,
    published: row.published !== false,
    featured: Boolean(row.featured),
    isNew: Boolean(row.isNew || row.is_new),
    images: normalizeImages(row),
    videoId: row.videoId || "",
    videoUrl: row.video_url || row.videoUrl || "",
    sizes,
    createdAt: row.createdAt || row.created_at || "",
  };
}

function renderStatus(message) {
  const status = document.getElementById("catalogStatus");
  if (status) status.textContent = message;
}

function renderBusinessIdentity() {
  document.querySelectorAll(".brand strong").forEach((node) => {
    node.textContent = BASE_COMERCIOS_BUSINESS.businessName;
  });
}

function productHasStock(product) {
  if (!product.tracksStock) return true;
  if (product.sizes.length) return product.sizes.some((variant) => variant.stock > 0);
  return product.stock > 0;
}

function publicProducts() {
  const section = catalogSection();
  return catalogProducts.filter((product) =>
    product.published && (BASE_COMERCIOS_CATALOG_CONFIG.outOfStockProductMode !== "hide" || productHasStock(product))
  );
}

function renderSelectOptions(selectId, values, fallbackLabel) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const selected = select.value || "all";
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  select.innerHTML = [
    `<option value="all">${fallbackLabel}</option>`,
    ...options.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`),
  ].join("");
  select.value = options.includes(selected) ? selected : "all";
}

function sizeFilterTokens(size = "") {
  return String(size || "")
    .trim()
    .toUpperCase()
    .split(/\s*\/\s*/)
    .filter(Boolean);
}

function sizeMatchesFilter(variantSize = "", selectedSize = "all") {
  const selected = String(selectedSize || "all").trim().toUpperCase();
  if (selected === "ALL") return true;
  return sizeFilterTokens(variantSize).includes(selected);
}

function catalogSizeValuesForCategory(products, category = "all") {
  const normalizedCategory = String(category || "all");
  return products
    .filter((product) => normalizedCategory === "all" || product.category === normalizedCategory)
    .flatMap((product) => product.sizes.flatMap((variant) => sizeFilterTokens(variant.size)));
}

function renderCatalogSizeOptions(products = publicProducts()) {
  const category = document.getElementById("catalogCategory")?.value || "all";
  renderSelectOptions("catalogSize", catalogSizeValuesForCategory(products, category), "Variedades");
}

function renderFilterOptions(products) {
  renderSelectOptions("catalogCategory", products.map((product) => product.category), "Categorias");
  renderSelectOptions("catalogSubcategory", products.map((product) => product.subcategory), "Subcategorias");
  renderSelectOptions("catalogColor", products.map((product) => product.color), "Color / Material");
  renderCatalogSizeOptions(products);
}

function renderRemoteFilterOptions(filters = {}) {
  renderSelectOptions("catalogCategory", filters.categories || [], "Categorias");
  renderSelectOptions("catalogSubcategory", filters.subcategories || [], "Subcategorias");
  renderSelectOptions("catalogColor", filters.colors || [], "Color / Material");
  renderSelectOptions("catalogSize", filters.sizes || [], "Variedades");
}

function catalogFilterValues() {
  return {
    query: String(document.getElementById("catalogSearch")?.value || "").trim(),
    category: document.getElementById("catalogCategory")?.value || "all",
    subcategory: document.getElementById("catalogSubcategory")?.value || "all",
    color: document.getElementById("catalogColor")?.value || "all",
    size: document.getElementById("catalogSize")?.value || "all",
    sort: document.getElementById("catalogSort")?.value || "new",
  };
}

function renderCatalogPagination() {
  const pagination = document.getElementById("catalogPagination");
  if (!pagination) return;
  if (catalogTotalCount <= catalogPageSize) {
    pagination.innerHTML = "";
    pagination.hidden = true;
    return;
  }
  const totalPages = Math.max(1, Math.ceil(catalogTotalCount / catalogPageSize));
  catalogCurrentPage = Math.min(Math.max(1, catalogCurrentPage), totalPages);
  pagination.hidden = false;
  const firstVisiblePage = Math.max(1, Math.min(catalogCurrentPage - 2, totalPages - 4));
  const visiblePages = [...new Set([1, totalPages, ...Array.from({ length: 5 }, (_, index) => firstVisiblePage + index)])]
    .filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
  const pageNumbers = visiblePages.map((page, index) => `${index && page - visiblePages[index - 1] > 1 ? '<span aria-hidden="true">…</span>' : ""}
    <button class="secondary-action catalog-page-number" data-catalog-page="${page}" aria-label="Página ${page}" ${page === catalogCurrentPage ? 'aria-current="page"' : ""} type="button">${page}</button>`).join("");
  pagination.innerHTML = `
    <button class="secondary-action" data-catalog-page-delta="-1" ${catalogCurrentPage <= 1 ? "disabled" : ""} type="button">Anterior</button>
    <div class="catalog-page-numbers">${pageNumbers}</div>
    <button class="secondary-action" data-catalog-page-delta="1" ${catalogCurrentPage >= totalPages ? "disabled" : ""} type="button">Siguiente</button>
    <form id="catalogPageJump" class="catalog-page-jump">
      <label for="catalogPageNumber">Ir a página</label>
      <input id="catalogPageNumber" name="page" type="number" min="1" max="${totalPages}" step="1" value="${catalogCurrentPage}" required>
      <span>de ${totalPages}</span>
      <button class="secondary-action" type="submit">Ir</button>
    </form>
  `;
}

function filteredProducts() {
  const query = String(document.getElementById("catalogSearch")?.value || "").trim().toLowerCase();
  const category = document.getElementById("catalogCategory")?.value || "all";
  const subcategory = document.getElementById("catalogSubcategory")?.value || "all";
  const color = document.getElementById("catalogColor")?.value || "all";
  const size = document.getElementById("catalogSize")?.value || "all";
  const sort = document.getElementById("catalogSort")?.value || "new";
  const rows = publicProducts().filter((product) => {
    const matchesCategory = category === "all" || product.category === category;
    const matchesSubcategory = subcategory === "all" || product.subcategory === subcategory;
    const matchesColor = color === "all" || product.color === color;
    const sizeVariants = size === "all" ? product.sizes : product.sizes.filter((variant) => sizeMatchesFilter(variant.size, size));
    const matchesSize = size === "all" || sizeVariants.some((variant) => !product.tracksStock || variant.stock > 0);
    const haystack = [product.code, product.sku, product.name, product.description, product.category, product.subcategory, product.color].join(" ").toLowerCase();
    return matchesCategory && matchesSubcategory && matchesColor && matchesSize && (!query || haystack.includes(query));
  });
  return rows.sort((a, b) => {
    if (sort === "priceAsc") return effectivePrice(a) - effectivePrice(b);
    if (sort === "priceDesc") return effectivePrice(b) - effectivePrice(a);
    return newestFirst(a, b);
  });
}

function newestFirst(a, b) {
  return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
}

function effectivePrice(product) {
  return product.promoPrice > 0 && product.promoPrice < product.price ? product.promoPrice : product.price;
}

function availabilityText(product) {
  return productHasStock(product) ? "Disponible" : "Agotado";
}

function priceBlock(product) {
  if (product.promoPrice > 0 && product.promoPrice < product.price) {
    return `<div class="price-row"><strong>${currency.format(product.promoPrice)}</strong><span>${currency.format(product.price)}</span></div>`;
  }
  return `<div class="price-row"><strong>${currency.format(product.price)}</strong></div>`;
}

function catalogProductVarieties(product) {
  return (product.sizes || []).filter((variant) => {
    const size = String(variant.size || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
    return size && size !== "UNICO";
  });
}

function sizeChips(product, interactive = false, selectedSize = "") {
  const varieties = catalogProductVarieties(product);
  const visibleSizes = BASE_COMERCIOS_CATALOG_CONFIG.sizeAvailabilityMode === "hide-unavailable"
    ? varieties.filter((variant) => variant.stock > 0)
    : varieties;
  if (!visibleSizes.length) return "";
  return visibleSizes.map((variant) => {
    const available = !product.tracksStock || variant.stock > 0;
    const selected = variant.size === selectedSize ? " selected" : "";
    const text = available ? `${variant.size} ✓` : `${variant.size} Agotado`;
    if (!interactive) return `<span class="size-chip ${available ? "ok" : "out"}">${escapeHtml(text)}</span>`;
    return `<button class="size-chip ${available ? "ok" : "out"}${selected}" data-select-size="${escapeHtml(variant.size)}" ${available ? "" : "disabled"} type="button">${escapeHtml(text)}</button>`;
  }).join("");
}

function relatedColorProducts(product) {
  return publicProducts().filter((item) => item.colorGroup && item.colorGroup === product.colorGroup);
}

function colorText(product) {
  const colors = [...new Set(relatedColorProducts(product).map((item) => item.color).filter(Boolean))];
  return colors.length > 1 ? colors.join(", ") : product.color || "Unico";
}

function whatsappHref(product, size = "") {
  const intro = BASE_COMERCIOS_BUSINESS.defaultWhatsappMessage.replace("{businessName}", BASE_COMERCIOS_BUSINESS.businessName);
  const message = [
    intro,
    product.name,
    product.color ? `Color / material: ${product.color}` : "",
    catalogProductVarieties(product).some((variant) => variant.size === size) ? `Variedad: ${size}` : "",
    `Precio: ${currency.format(effectivePrice(product))}`,
    `Link: ${productPublicUrl(product)}`,
  ].filter(Boolean).join("\n");
  const phone = BASE_COMERCIOS_BUSINESS.whatsappNumber.replace(/\D/g, "");
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function productImage(product, className = "product-image") {
  const image = product.images[0];
  if (image) return `<img class="${className}" src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">`;
  return `<div class="${className} placeholder" aria-hidden="true"><img src="../assets/nexo-mates-logo.png?v=1" alt=""></div>`;
}

function productGallery(product) {
  const images = (product.images || []).filter(Boolean);
  const hasVideo = Boolean(product.videoId || product.videoUrl);
  if (!images.length && !hasVideo) {
    return `<section class="product-gallery single">${productImage(product, "gallery-image")}</section>`;
  }
  const firstImage = images[0];
  return `
    <section class="product-gallery" data-product-gallery>
      <div class="gallery-stage">
        ${firstImage ? `<img class="gallery-main-image" data-gallery-main src="${escapeHtml(firstImage)}" alt="${escapeHtml(`${product.name} foto 1`)}">` : ""}
        ${hasVideo ? `<div class="catalog-video" ${firstImage ? "hidden" : ""}><button class="secondary-action" data-load-product-video="${escapeHtml(product.videoId || "")}" data-video-url="${escapeHtml(product.videoUrl || "")}" type="button">Reproducir video</button><p data-video-status role="status"></p><video controls playsinline preload="none" hidden></video></div>` : ""}
        ${images.length + Number(hasVideo) > 1 ? `<button class="gallery-arrow gallery-prev" data-gallery-step="-1" type="button" aria-label="Imagen anterior" title="Anterior"><span aria-hidden="true">&#10094;</span></button><button class="gallery-arrow gallery-next" data-gallery-step="1" type="button" aria-label="Imagen siguiente" title="Siguiente"><span aria-hidden="true">&#10095;</span></button>` : ""}
      </div>
      ${images.length > 1 || hasVideo ? `
        <div class="gallery-thumbs" aria-label="Fotos y video del producto">
          ${images.map((image, index) => {
            const alt = `${product.name} foto ${index + 1}`;
            return `
              <button class="gallery-thumb" data-gallery-thumb data-gallery-image="${escapeHtml(image)}" data-gallery-alt="${escapeHtml(alt)}" aria-current="${index === 0 ? "true" : "false"}" type="button">
                <img src="${escapeHtml(image)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">
              </button>
            `;
          }).join("")}
          ${hasVideo ? `<button class="gallery-thumb gallery-video-thumb" data-gallery-thumb data-load-product-video="${escapeHtml(product.videoId || "")}" data-video-url="${escapeHtml(product.videoUrl || "")}" aria-current="${!firstImage}" aria-label="Ver video del producto" title="Ver video" type="button"><span aria-hidden="true">&#9654;</span><small>Video</small></button>` : ""}
        </div>
      ` : ""}
    </section>
  `;
}

function syncGalleryAspect(gallery) {
  if (!gallery) return;
  const stage = gallery.querySelector(".gallery-stage");
  const image = gallery.querySelector("[data-gallery-main]");
  const video = gallery.querySelector("video");
  const showingImage = image && !image.hidden;
  const width = showingImage ? image.naturalWidth : video?.videoWidth;
  const height = showingImage ? image.naturalHeight : video?.videoHeight;
  stage.style.aspectRatio = width > 0 && height > 0 ? `${width} / ${height}` : "4 / 5";
}

function stepProductGallery(gallery, delta) {
  const thumbs = [...gallery.querySelectorAll("[data-gallery-thumb]")];
  if (thumbs.length < 2) return;
  const current = Math.max(0, thumbs.findIndex((thumb) => thumb.getAttribute("aria-current") === "true"));
  thumbs[(current + delta + thumbs.length) % thumbs.length].click();
}

document.addEventListener("load", (event) => {
  if (event.target.matches?.("[data-gallery-main]")) syncGalleryAspect(event.target.closest("[data-product-gallery]"));
}, true);
document.addEventListener("loadedmetadata", (event) => {
  if (event.target.matches?.(".catalog-video video")) syncGalleryAspect(event.target.closest("[data-product-gallery]"));
}, true);
document.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key) || event.target.matches?.("video, input, select, textarea")) return;
  const gallery = event.target.closest?.("[data-product-gallery]");
  if (!gallery) return;
  event.preventDefault();
  stepProductGallery(gallery, event.key === "ArrowLeft" ? -1 : 1);
});

function applyBusinessSettings(data = {}) {
  BASE_COMERCIOS_BUSINESS.businessName = data.business_name || data.businessName || BASE_COMERCIOS_BUSINESS.businessName;
  BASE_COMERCIOS_BUSINESS.whatsappNumber = data.whatsapp_number || data.whatsappNumber || window.BASE_COMERCIOS_BUSINESS_CONFIG?.whatsappNumber || BASE_COMERCIOS_BUSINESS.whatsappNumber;
  BASE_COMERCIOS_BUSINESS.defaultWhatsappMessage = data.default_whatsapp_message || data.defaultWhatsappMessage || BASE_COMERCIOS_BUSINESS.defaultWhatsappMessage;
  BASE_COMERCIOS_CATALOG_CONFIG.sizeAvailabilityMode = data.size_availability_mode || data.sizeAvailabilityMode || BASE_COMERCIOS_CATALOG_CONFIG.sizeAvailabilityMode;
  BASE_COMERCIOS_CATALOG_CONFIG.outOfStockProductMode = data.out_of_stock_product_mode || data.outOfStockProductMode || BASE_COMERCIOS_CATALOG_CONFIG.outOfStockProductMode;
}

function loadLocalCatalogState() {
  try {
    const raw = sessionStorage.getItem("nexo-catalog-preview") || localStorage.getItem(BASE_COMERCIOS_CATALOG_CONFIG.localStoreKey);
    if (!raw) return false;
    const localState = JSON.parse(raw);
    applyBusinessSettings(localState.catalogSettings || {});
    catalogProducts = (localState.products || []).map(normalizeCatalogProduct);
    return true;
  } catch (error) {
    console.warn("No se pudo leer el catalogo local", error);
    return false;
  }
}

function renderLocalCatalogState() {
  const hasLocalState = loadLocalCatalogState();
  renderBusinessIdentity();
  renderStatus(hasLocalState ? "Vista local conectada" : "Supabase pendiente");
  renderFilterOptions(publicProducts());
  renderCatalogGrid();
  renderProductDetail();
}

async function loadBusinessSettings(client) {
  const { data, error } = await client
    .from("business_settings")
    .select("business_name, whatsapp_number, default_whatsapp_message, size_availability_mode, out_of_stock_product_mode")
    .eq("id", "main")
    .maybeSingle();
  if (error || !data) return;
  applyBusinessSettings(data);
}

function renderCatalogGrid() {
  const grid = document.getElementById("catalogGrid");
  const empty = document.getElementById("catalogEmpty");
  if (!grid) return;
  const filtered = catalogRemotePaging ? [] : filteredProducts();
  if (!catalogRemotePaging) {
    catalogTotalCount = filtered.length;
    catalogCurrentPage = Math.min(Math.max(1, catalogCurrentPage), Math.max(1, Math.ceil(filtered.length / catalogPageSize)));
  }
  const products = catalogRemotePaging ? catalogProducts : filtered.slice((catalogCurrentPage - 1) * catalogPageSize, catalogCurrentPage * catalogPageSize);
  grid.innerHTML = products.map((product) => {
    const slug = productSlug(product);
    const firstSize = product.sizes.find((variant) => variant.stock > 0)?.size || product.sizes[0]?.size || "";
    return `
      <article class="product-card">
          <a class="product-card-main" href="${catalogRootPath()}producto.html?slug=${encodeURIComponent(slug)}">
          ${productImage(product)}
          <div class="card-badges">
            ${!productHasStock(product) ? '<span>Agotado</span>' : ""}
          </div>
          <small>${escapeHtml([product.category, product.color].filter(Boolean).join(" / "))}</small>
          <h2>${escapeHtml(product.name)}</h2>
          ${priceBlock(product)}
          <p class="product-meta">Color / material: ${escapeHtml(colorText(product))}</p>
          ${catalogProductVarieties(product).length ? `<div class="size-row">${sizeChips(product)}</div>` : ""}
        </a>
        <div class="card-actions">
          <a class="secondary-action" href="${catalogRootPath()}producto.html?slug=${encodeURIComponent(slug)}">Ver producto</a>
          <a class="whatsapp-action" href="${whatsappHref(product, firstSize)}" target="_blank" rel="noopener">WhatsApp</a>
        </div>
      </article>
    `;
  }).join("");
  if (empty) empty.hidden = products.length > 0 || catalogProducts.length > 0 || catalogTotalCount > 0;
  renderCatalogPagination();
}

function selectedProduct() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug") || slugify(window.location.pathname.split("/").filter(Boolean).pop() || "");
  return publicProducts().find((item) => productSlug(item) === slug);
}

function renderProductDetail(selectedSize = "") {
  const detail = document.getElementById("productDetail");
  if (!detail) return;
  detail.querySelector("video")?.pause();
  clearTimeout(catalogVideoTimer);
  catalogVideoPending = "";
  catalogVideoRequest++;
  const product = selectedProduct();
  if (!product) {
    detail.innerHTML = `
      <section class="catalog-empty">
        <h1>Producto no disponible</h1>
        <p>El catalogo se va a completar cuando conectemos Supabase nuevo para Nexo Mates.</p>
      </section>
    `;
    return;
  }
  document.title = `${product.name} | ${BASE_COMERCIOS_BUSINESS.businessName}`;
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) metaDescription.setAttribute("content", `${product.description} ${currency.format(effectivePrice(product))}`);
  const activeSize = selectedSize || product.sizes.find((variant) => variant.stock > 0)?.size || "";
  const colors = relatedColorProducts(product);
  const colorOptions = colors.length > 1 ? `
    <label class="product-control">
      <span>Color / material</span>
      <select id="productColorSelect">
        ${colors.map((item) => `<option value="${escapeHtml(productSlug(item))}" ${item.id === product.id ? "selected" : ""}>${escapeHtml(item.color || item.name)}</option>`).join("")}
      </select>
    </label>
  ` : `<p class="product-meta">Color / material: ${escapeHtml(product.color || "Unico")}</p>`;
  const related = publicProducts()
    .filter((item) => item.id !== product.id && item.category === product.category)
    .sort((a, b) => Number(productHasStock(b)) - Number(productHasStock(a)) || newestFirst(a, b))
    .slice(0, 4);
  detail.innerHTML = `
    <article class="product-detail">
      ${productGallery(product)}
      <section class="product-info">
        <div class="card-badges inline">
          ${!productHasStock(product) ? '<span>Agotado</span>' : ""}
        </div>
        <small>${escapeHtml(product.category)}</small>
        <h1>${escapeHtml(product.name)}</h1>
        ${product.code ? `<span class="product-code">Código interno: ${escapeHtml(product.code)}</span>` : ""}
        <p>${escapeHtml(product.description)}</p>
        ${priceBlock(product)}
        ${colorOptions}
        ${catalogProductVarieties(product).length ? `<div class="product-control">
          <span>Variedad</span>
          <div class="size-row">${sizeChips(product, true, activeSize)}</div>
        </div>` : ""}
        <p class="${productHasStock(product) ? "stock-ok" : "stock-out"}">${availabilityText(product)}</p>
        <a class="whatsapp-action full" id="productWhatsapp" href="${whatsappHref(product, activeSize)}" target="_blank" rel="noopener">Consultar por WhatsApp</a>
      </section>
    </article>
    ${related.length ? `
      <section class="related-products">
        <h2>Productos relacionados</h2>
        <div class="catalog-grid compact">
          ${related.map((item) => `
            <a class="mini-card" href="producto.html?slug=${encodeURIComponent(productSlug(item))}">
              ${productImage(item, "mini-image")}
              <strong>${escapeHtml(item.name)}</strong>
              <span>${currency.format(effectivePrice(item))}</span>
            </a>
          `).join("")}
        </div>
      </section>
    ` : ""}
  `;
  syncGalleryAspect(detail.querySelector("[data-product-gallery]"));
  if (!detail.querySelector("[data-gallery-main]")) detail.querySelector(".gallery-video-thumb")?.click();
}

function catalogSlugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("slug") || slugify(window.location.pathname.split("/").filter(Boolean).pop() || "");
}

async function loadRemoteCatalogPage(page = catalogCurrentPage) {
  if (!catalogClient) return false;
  const requestId = ++catalogPageRequest;
  const filters = catalogFilterValues();
  renderStatus("Actualizando");
  const { data, error } = await catalogClient.rpc("list_public_catalog_products", {
    p_query: filters.query,
    p_category: filters.category,
    p_subcategory: filters.subcategory,
    p_color: filters.color,
    p_size: filters.size,
    p_sort: filters.sort,
    p_page: page,
    p_page_size: catalogPageSize,
  });
  if (requestId !== catalogPageRequest) return false;
  if (error) throw error;
  catalogRemotePaging = true;
  catalogCurrentPage = Number(data?.page || page || 1);
  catalogPageSize = Number(data?.pageSize || catalogPageSize);
  catalogTotalCount = Number(data?.totalCount || 0);
  catalogProducts = (data?.rows || []).map(normalizeCatalogProduct);
  renderRemoteFilterOptions(data?.filters || {});
  renderCatalogGrid();
  renderStatus(catalogTotalCount ? "Catalogo actualizado" : "Sin productos");
  return true;
}

async function loadRemoteProductDetail() {
  if (!catalogClient) return false;
  renderStatus("Actualizando");
  const { data, error } = await catalogClient.rpc("get_public_catalog_product", {
    p_slug: catalogSlugFromUrl(),
  });
  if (error) throw error;
  const rows = [data?.product, ...(data?.related || [])].filter(Boolean);
  catalogRemotePaging = true;
  catalogProducts = rows.map(normalizeCatalogProduct);
  catalogTotalCount = catalogProducts.length;
  renderProductDetail();
  renderStatus(data?.product ? "Producto actualizado" : "Producto no disponible");
  return true;
}

async function loadLegacyCatalogProducts(client) {
  const { data, error } = await client
    .from(BASE_COMERCIOS_CATALOG_CONFIG.productsView)
    .select("*")
    .eq("published", true)
    .order("description", { ascending: true });
  if (error) throw error;
  catalogRemotePaging = false;
  catalogProducts = (data || []).map(normalizeCatalogProduct);
  catalogTotalCount = catalogProducts.length;
  renderFilterOptions(publicProducts());
  renderCatalogGrid();
  renderProductDetail();
  renderStatus("Catalogo actualizado");
}

function reloadCatalogPage({ resetPage = true, debounce = false } = {}) {
  // Invalidate the previous response immediately, including during debounce.
  catalogPageRequest++;
  if (resetPage) catalogCurrentPage = 1;
  if (!catalogRemotePaging || !catalogClient || isProductDetailPage()) {
    renderCatalogSizeOptions(publicProducts());
    renderCatalogGrid();
    return;
  }
  if (resetPage) catalogCurrentPage = 1;
  const run = () => loadRemoteCatalogPage(catalogCurrentPage).catch((error) => {
    console.warn("No se pudo actualizar la pagina del catalogo", error);
    renderStatus("No disponible");
  });
  if (!debounce) {
    run();
    return;
  }
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(run, 250);
}

function handleCatalogCategoryChange() {
  const sizeSelect = document.getElementById("catalogSize");
  if (sizeSelect) sizeSelect.value = "all";
  if (!catalogRemotePaging || !catalogClient) renderCatalogSizeOptions(publicProducts());
  reloadCatalogPage({ resetPage: true });
}

async function loadCatalogProducts() {
  if (!BASE_COMERCIOS_CATALOG_CONFIG.enabled || !BASE_COMERCIOS_CATALOG_CONFIG.supabaseUrl || !BASE_COMERCIOS_CATALOG_CONFIG.supabasePublishableKey) {
    renderLocalCatalogState();
    return;
  }

  try {
    renderStatus("Actualizando");
    catalogClient = window.supabase.createClient(
      BASE_COMERCIOS_CATALOG_CONFIG.supabaseUrl,
      BASE_COMERCIOS_CATALOG_CONFIG.supabasePublishableKey
    );
    await loadBusinessSettings(catalogClient);
    renderBusinessIdentity();
    if (isProductDetailPage()) {
      await loadRemoteProductDetail();
      return;
    }
    await loadRemoteCatalogPage(1);
  } catch (error) {
    console.warn("No se pudo cargar el catalogo publico", error);
    renderStatus("No disponible");
    renderCatalogGrid();
    renderProductDetail();
  }
}

document.getElementById("catalogSearch")?.addEventListener("input", () => reloadCatalogPage({ resetPage: true, debounce: true }));
document.getElementById("catalogCategory")?.addEventListener("change", handleCatalogCategoryChange);
document.getElementById("catalogSubcategory")?.addEventListener("change", () => reloadCatalogPage({ resetPage: true }));
document.getElementById("catalogColor")?.addEventListener("change", () => reloadCatalogPage({ resetPage: true }));
document.getElementById("catalogSize")?.addEventListener("change", () => reloadCatalogPage({ resetPage: true }));
document.getElementById("catalogSort")?.addEventListener("change", () => reloadCatalogPage({ resetPage: true }));
let catalogVideoUrl = "";
let catalogVideoPending = "";
let catalogVideoTimer;
let catalogVideoRequest = 0;

function showCatalogVideo(blob, remoteUrl = "") {
  clearTimeout(catalogVideoTimer);
  const container = document.querySelector(".catalog-video");
  if (!container) return;
  const status = container.querySelector("[data-video-status]");
  const button = container.querySelector("button");
  button.disabled = false;
  const thumb = document.querySelector(".gallery-video-thumb");
  if (thumb) thumb.disabled = false;
  if (!(blob instanceof Blob) && !remoteUrl) {
    status.textContent = "Video no disponible. Abrí el catálogo desde el sistema donde lo cargaste.";
    return;
  }
  if (catalogVideoUrl) URL.revokeObjectURL(catalogVideoUrl);
  catalogVideoUrl = remoteUrl ? "" : URL.createObjectURL(blob);
  const video = container.querySelector("video");
  video.muted = true;
  video.loop = true;
  video.hidden = true;
  status.textContent = "Cargando video...";
  video.onloadeddata = () => {
    video.hidden = false;
    status.textContent = "";
  };
  video.onplaying = () => {
    video.hidden = false;
    status.textContent = "";
    button.hidden = true;
  };
  video.onerror = () => {
    status.textContent = "No pude reproducir el video. Volve a intentarlo.";
    button.hidden = false;
    video.hidden = true;
  };
  video.src = remoteUrl || catalogVideoUrl;
  button.hidden = true;
  video.play().catch(() => {
    video.hidden = false;
    button.hidden = false;
    status.textContent = "Toca reproducir para ver el video.";
  });
}

window.addEventListener("message", (event) => {
  if (window.location.protocol !== "file:" || event.source !== window.opener || event.data?.type !== "nexo-video-response" || event.data.id !== catalogVideoPending) return;
  showCatalogVideo(event.data.blob);
});
window.addEventListener("pagehide", () => { if (catalogVideoUrl) URL.revokeObjectURL(catalogVideoUrl); });

document.addEventListener("click", async (event) => {
  const galleryArrow = event.target.closest("[data-gallery-step]");
  if (galleryArrow) {
    stepProductGallery(galleryArrow.closest("[data-product-gallery]"), Number(galleryArrow.dataset.galleryStep));
    return;
  }
  const videoButton = event.target.closest("[data-load-product-video]");
  if (videoButton) {
    const gallery = videoButton.closest("[data-product-gallery]");
    const mainImage = gallery?.querySelector("[data-gallery-main]");
    if (mainImage) mainImage.hidden = true;
    syncGalleryAspect(gallery);
    gallery?.querySelectorAll("[data-gallery-thumb]").forEach((button) => button.setAttribute("aria-current", String(button.hasAttribute("data-load-product-video"))));
    const container = gallery?.querySelector(".catalog-video");
    if (container) container.hidden = false;
    const currentVideo = container?.querySelector("video");
    if (currentVideo?.getAttribute("src") && currentVideo.readyState >= 2 && !currentVideo.error) {
      currentVideo.hidden = false;
      currentVideo.play().catch(() => { container.querySelector("button").hidden = false; });
      return;
    }
    catalogVideoPending = videoButton.dataset.loadProductVideo;
    videoButton.disabled = true;
    document.querySelector("[data-video-status]").textContent = "Cargando video...";
    const remoteUrl = videoButton.dataset.videoUrl;
    if (remoteUrl) {
      const request = ++catalogVideoRequest;
      if (currentVideo) currentVideo.hidden = true;
      try {
        const url = new URL(remoteUrl);
        if (url.protocol !== "https:") throw new Error("URL invalida");
        // Optimized clips are capped at 5 MB. Decode the complete file just as
        // the product editor does, without depending on another tab's cache.
        const response = await fetch(url.href);
        if (!response.ok) throw new Error("No se pudo cargar el video");
        const blob = await response.blob();
        if (!blob.size || blob.size > 5 * 1024 * 1024) throw new Error("Video invalido");
        if (request === catalogVideoRequest) showCatalogVideo(blob);
      } catch {
        if (request === catalogVideoRequest) {
          showCatalogVideo(null);
          container.querySelector("[data-video-status]").textContent = "No pude cargar el video. Toca reproducir para reintentar.";
        }
      }
      return;
    }
    if (window.location.protocol === "file:" && window.opener) {
      window.opener.postMessage({ type: "nexo-video-request", id: catalogVideoPending, page: window.location.href.split(/[?#]/)[0] }, "*");
      catalogVideoTimer = setTimeout(() => showCatalogVideo(null), 10000);
    } else {
      const requestedId = catalogVideoPending;
      try {
        const blob = await NexoMedia.get(requestedId);
        if (catalogVideoPending === requestedId) showCatalogVideo(blob);
      } catch { if (catalogVideoPending === requestedId) showCatalogVideo(null); }
    }
    return;
  }
  const pageButton = event.target.closest("[data-catalog-page-delta], [data-catalog-page]");
  if (pageButton) {
    if (pageButton.disabled) return;
    catalogCurrentPage = pageButton.dataset.catalogPage ? Number(pageButton.dataset.catalogPage) : catalogCurrentPage + Number(pageButton.dataset.catalogPageDelta || 0);
    reloadCatalogPage({ resetPage: false });
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const galleryThumb = event.target.closest("[data-gallery-thumb]");
  if (galleryThumb) {
    const gallery = galleryThumb.closest("[data-product-gallery]");
    const mainImage = gallery?.querySelector("[data-gallery-main]");
    if (mainImage && galleryThumb.dataset.galleryImage) {
      catalogVideoRequest++;
      catalogVideoPending = "";
      clearTimeout(catalogVideoTimer);
      const videoContainer = gallery.querySelector(".catalog-video");
      if (videoContainer) {
        videoContainer.querySelector("video").pause();
        videoContainer.hidden = true;
      }
      gallery.querySelectorAll("[data-load-product-video]").forEach((button) => { button.disabled = false; });
      mainImage.hidden = false;
      mainImage.src = galleryThumb.dataset.galleryImage;
      mainImage.alt = galleryThumb.dataset.galleryAlt || mainImage.alt;
      syncGalleryAspect(gallery);
      gallery.querySelectorAll("[data-gallery-thumb]").forEach((button) => button.setAttribute("aria-current", "false"));
      galleryThumb.setAttribute("aria-current", "true");
    }
    return;
  }
  const sizeButton = event.target.closest("[data-select-size]");
  if (sizeButton) renderProductDetail(sizeButton.dataset.selectSize);
});
document.addEventListener("submit", (event) => {
  if (event.target.id !== "catalogPageJump") return;
  event.preventDefault();
  const page = Number(new FormData(event.target).get("page"));
  const totalPages = Math.max(1, Math.ceil(catalogTotalCount / catalogPageSize));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) return;
  catalogCurrentPage = page;
  reloadCatalogPage({ resetPage: false });
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.addEventListener("change", (event) => {
  if (event.target.id === "productColorSelect") {
    window.location.href = `producto.html?slug=${encodeURIComponent(event.target.value)}`;
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === BASE_COMERCIOS_CATALOG_CONFIG.localStoreKey && !BASE_COMERCIOS_CATALOG_CONFIG.enabled) {
    renderLocalCatalogState();
  }
});
function requestLocalCatalogPreview() {
  if (window.location.protocol === "file:" && window.opener) {
    window.opener.postMessage({ type: "nexo-catalog-request", page: window.location.href.split(/[?#]/)[0] }, "*");
  }
}

window.addEventListener("message", (event) => {
  if (window.location.protocol !== "file:" || event.source !== window.opener || event.data?.type !== "nexo-catalog-state") return;
  sessionStorage.setItem("nexo-catalog-preview", JSON.stringify(event.data.state));
  renderLocalCatalogState();
});
window.addEventListener("focus", () => {
  if (!BASE_COMERCIOS_CATALOG_CONFIG.enabled) {
    renderLocalCatalogState();
    requestLocalCatalogPreview();
  }
});
loadCatalogProducts();
requestLocalCatalogPreview();
