const elements = {
  filters: document.querySelector("#catalog-filters"),
  category: document.querySelector("#category"),
  grid: document.querySelector("#product-grid"),
  resultCount: document.querySelector("#result-count"),
  availableUnits: document.querySelector("#available-units"),
  reservationCount: document.querySelector("#reservation-count"),
  asideCount: document.querySelector("#aside-count"),
  reservationList: document.querySelector("#reservation-list"),
  resetButton: document.querySelector("#reset-button"),
  dialog: document.querySelector("#reserve-dialog"),
  reserveForm: document.querySelector("#reserve-form"),
  dialogProductId: document.querySelector("#dialog-product-id"),
  dialogProductName: document.querySelector("#dialog-product-name"),
  quantity: document.querySelector("#quantity"),
  toast: document.querySelector("#toast"),
};

let catalog = [];
let changedProductId = null;
let toastTimer;

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
}

function formatPrice(price) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(price);
}

function renderProducts(products) {
  elements.grid.replaceChildren();
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No pieces match those filters. Try a broader search.";
    elements.grid.append(empty);
  }

  products.forEach((product, index) => {
    const article = document.createElement("article");
    article.className = "product-card";
    article.dataset.productId = product.id;
    article.dataset.changed = String(product.id === changedProductId);
    article.dataset.tone = product.tone;

    const art = document.createElement("div");
    art.className = "product-art";
    art.setAttribute("aria-hidden", "true");
    const number = document.createElement("span");
    number.className = "product-number";
    number.textContent = String(index + 1).padStart(2, "0");
    art.append(number);

    const body = document.createElement("div");
    body.className = "product-body";
    const meta = document.createElement("div");
    meta.className = "product-meta";
    const category = document.createElement("span");
    category.textContent = product.category;
    const price = document.createElement("span");
    price.textContent = formatPrice(product.price);
    meta.append(category, price);

    const heading = document.createElement("h3");
    heading.textContent = product.name;
    const description = document.createElement("p");
    description.textContent = product.description;
    const footer = document.createElement("div");
    footer.className = "product-footer";
    const stock = document.createElement("span");
    stock.className = `stock${product.available ? "" : " sold-out"}`;
    stock.textContent = product.available ? `${product.available} on shelf` : "Shelf empty";
    const button = document.createElement("button");
    button.className = "reserve-button";
    button.type = "button";
    button.disabled = product.available === 0;
    button.textContent = product.available ? "Reserve piece" : "Unavailable";
    button.setAttribute("aria-label", `Reserve ${product.name}`);
    button.addEventListener("click", () => openReservation(product));
    footer.append(stock, button);
    body.append(meta, heading, description, footer);
    article.append(art, body);
    elements.grid.append(article);
  });
  elements.grid.setAttribute("aria-busy", "false");
}

function renderReservations(reservations) {
  elements.reservationList.replaceChildren();
  elements.asideCount.textContent = String(reservations.length);
  if (!reservations.length) {
    const empty = document.createElement("p");
    empty.className = "empty-shelf";
    empty.textContent = "Nothing held yet.";
    elements.reservationList.append(empty);
    return;
  }
  reservations.forEach((reservation) => {
    const row = document.createElement("div");
    row.className = "reservation";
    const name = document.createElement("strong");
    name.textContent = reservation.productName;
    const detail = document.createElement("span");
    detail.textContent = `${reservation.quantity} ${reservation.quantity === 1 ? "piece" : "pieces"} · ${new Date(reservation.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const release = document.createElement("button");
    release.className = "release-button";
    release.type = "button";
    release.textContent = "Release";
    release.setAttribute("aria-label", `Release ${reservation.productName}`);
    release.addEventListener("click", () => releaseReservation(reservation));
    row.append(name, detail, release);
    elements.reservationList.append(row);
  });
}

async function loadCatalog() {
  elements.grid.setAttribute("aria-busy", "true");
  const params = new URLSearchParams(new FormData(elements.filters));
  if (!elements.filters.available.checked) params.delete("available");
  else params.set("available", "true");
  const data = await api(`/api/catalog?${params}`);
  catalog = data.products;
  elements.availableUnits.textContent = String(data.summary.availableUnits);
  elements.reservationCount.textContent = String(data.summary.reservationCount);
  elements.resultCount.textContent = `${data.summary.matches} ${data.summary.matches === 1 ? "piece" : "pieces"}`;
  if (elements.category.options.length === 1) {
    data.categories.forEach((name) => elements.category.add(new Option(name, name)));
  }
  renderProducts(catalog);
}

async function loadReservations() {
  const data = await api("/api/reservations");
  renderReservations(data.reservations);
}

function openReservation(product) {
  elements.dialogProductId.value = product.id;
  elements.dialogProductName.textContent = product.name;
  elements.quantity.value = "1";
  [...elements.quantity.options].forEach((option) => { option.disabled = Number(option.value) > product.available; });
  elements.dialog.showModal();
  elements.quantity.focus();
}

async function confirmReservation() {
  const productId = elements.dialogProductId.value;
  const quantity = Number(elements.quantity.value);
  const product = catalog.find((candidate) => candidate.id === productId);
  const data = await api("/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId, quantity }),
  });
  changedProductId = productId;
  await Promise.all([loadCatalog(), loadReservations()]);
  showToast(`Reserved ${quantity} × ${product?.name || data.reservation.productName}. Inventory saved.`);
}

async function releaseReservation(reservation) {
  if (!window.confirm(`Release ${reservation.productName} back to the studio shelf?`)) return;
  await api(`/api/reservations/${encodeURIComponent(reservation.id)}`, { method: "DELETE" });
  changedProductId = reservation.productId;
  await Promise.all([loadCatalog(), loadReservations()]);
  showToast(`${reservation.productName} returned to the shelf.`);
}

elements.filters.addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await loadCatalog(); } catch (error) { showToast(error.message); }
});

elements.reserveForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  try {
    await confirmReservation();
    elements.dialog.close();
  } catch (error) { showToast(error.message); }
});

elements.resetButton.addEventListener("click", async () => {
  if (!window.confirm("Restore all starting inventory and clear every local reservation?")) return;
  try {
    await api("/api/reset", { method: "POST" });
    changedProductId = null;
    await Promise.all([loadCatalog(), loadReservations()]);
    showToast("Starting inventory restored.");
  } catch (error) { showToast(error.message); }
});

try {
  await Promise.all([loadCatalog(), loadReservations()]);
} catch (error) {
  elements.grid.setAttribute("aria-busy", "false");
  showToast(`Could not load the shelf: ${error.message}`);
}
