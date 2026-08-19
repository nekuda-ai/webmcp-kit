import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const STATE_FILE = process.env.STATE_FILE || join(ROOT, "data", "state.json");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = parsePort(process.env.PORT ?? "4173");

const PRODUCTS = Object.freeze([
  {
    id: "aurora-lamp",
    name: "Aurora task lamp",
    category: "Lighting",
    price: 148,
    inventory: 4,
    tone: "amber",
    description: "A low, warm pool of light with a hand-finished brass stem.",
  },
  {
    id: "indigo-throw",
    name: "Indigo woven throw",
    category: "Textiles",
    price: 96,
    inventory: 6,
    tone: "indigo",
    description: "Soft washed cotton, woven in a quiet windowpane pattern.",
  },
  {
    id: "juniper-tray",
    name: "Juniper catchall tray",
    category: "Tabletop",
    price: 54,
    inventory: 3,
    tone: "sage",
    description: "Solid ash with a shallow carved well for everyday objects.",
  },
  {
    id: "loam-planter",
    name: "Loam stoneware planter",
    category: "Ceramics",
    price: 72,
    inventory: 5,
    tone: "clay",
    description: "Speckled stoneware with an integrated drainage saucer.",
  },
  {
    id: "orbit-bookends",
    name: "Orbit bookends",
    category: "Objects",
    price: 88,
    inventory: 2,
    tone: "charcoal",
    description: "A weighty pair of powder-coated arcs for a favorite shelf.",
  },
  {
    id: "reed-vase",
    name: "Reed glass vase",
    category: "Objects",
    price: 64,
    inventory: 4,
    tone: "aqua",
    description: "Recycled glass with fine vertical ribs and a softened rim.",
  },
]);

function parsePort(raw) {
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`PORT must be an integer from 0 to 65535; received ${raw}`);
  const port = Number(raw);
  if (port < 0 || port > 65535) throw new Error(`PORT must be an integer from 0 to 65535; received ${raw}`);
  return port;
}

function freshState() {
  return {
    version: 1,
    stock: Object.fromEntries(PRODUCTS.map((product) => [product.id, product.inventory])),
    reservations: [],
  };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.stock !== "object" || !Array.isArray(parsed.reservations)) {
      throw new Error("unsupported state shape");
    }
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Could not read ${STATE_FILE}: ${error.message}`);
    const initial = freshState();
    await persistState(initial);
    return initial;
  }
}

async function persistState(nextState) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  await rename(temporary, STATE_FILE);
}

let state = await loadState();
let mutationQueue = Promise.resolve();

function mutate(operation) {
  const result = mutationQueue.then(async () => {
    const next = structuredClone(state);
    const response = await operation(next);
    await persistState(next);
    state = next;
    return response;
  });
  mutationQueue = result.catch(() => {});
  return result;
}

function catalog(searchParams = new URLSearchParams()) {
  const query = (searchParams.get("q") || "").trim().toLocaleLowerCase();
  const category = (searchParams.get("category") || "").trim();
  const onlyAvailable = searchParams.get("available") === "true";
  const products = PRODUCTS.map((product) => ({ ...product, available: state.stock[product.id] ?? 0 }))
    .filter((product) => !query || `${product.name} ${product.category} ${product.description}`.toLocaleLowerCase().includes(query))
    .filter((product) => !category || product.category === category)
    .filter((product) => !onlyAvailable || product.available > 0);

  return {
    products,
    categories: [...new Set(PRODUCTS.map((product) => product.category))].sort(),
    summary: {
      matches: products.length,
      availableUnits: PRODUCTS.reduce((total, product) => total + (state.stock[product.id] ?? 0), 0),
      reservationCount: state.reservations.length,
    },
  };
}

function reservationView(reservation) {
  const product = PRODUCTS.find((candidate) => candidate.id === reservation.productId);
  return { ...reservation, productName: product?.name ?? reservation.productId };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

async function serveStatic(pathname, response) {
  const routes = new Map([
    ["/", "index.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
  ]);
  const filename = routes.get(pathname);
  if (!filename) return false;
  const body = await readFile(join(PUBLIC_DIR, filename));
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(filename)];
  response.writeHead(200, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": body.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok", service: "reading-room-supply", stateVersion: state.version });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/catalog") {
      json(response, 200, catalog(url.searchParams));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/reservations") {
      json(response, 200, { reservations: state.reservations.map(reservationView).toReversed() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reservations") {
      const input = await requestJson(request);
      const product = PRODUCTS.find((candidate) => candidate.id === input.productId);
      const quantity = Number(input.quantity ?? 1);
      if (!product) throw Object.assign(new Error("Choose a product from the catalog"), { status: 400 });
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 3) {
        throw Object.assign(new Error("Quantity must be a whole number from 1 to 3"), { status: 400 });
      }

      const reservation = await mutate((next) => {
        if ((next.stock[product.id] ?? 0) < quantity) {
          throw Object.assign(new Error(`Only ${next.stock[product.id] ?? 0} available`), { status: 409 });
        }
        next.stock[product.id] -= quantity;
        const created = {
          id: `hold-${randomUUID().slice(0, 8)}`,
          productId: product.id,
          quantity,
          createdAt: new Date().toISOString(),
        };
        next.reservations.push(created);
        return created;
      });
      json(response, 201, { reservation: reservationView(reservation), available: state.stock[product.id] });
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/reservations/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/reservations/".length));
      const released = await mutate((next) => {
        const index = next.reservations.findIndex((reservation) => reservation.id === id);
        if (index < 0) throw Object.assign(new Error("Reservation not found"), { status: 404 });
        const [reservation] = next.reservations.splice(index, 1);
        next.stock[reservation.productId] += reservation.quantity;
        return reservation;
      });
      json(response, 200, { released: reservationView(released), available: state.stock[released.productId] });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      await mutate((next) => Object.assign(next, freshState()));
      json(response, 200, { reset: true, ...catalog().summary });
      return;
    }

    if (request.method === "GET" && (await serveStatic(url.pathname, response))) return;
    json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(response, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});

server.on("error", (error) => {
  console.error(`Server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`Reading Room Supply ready at http://${HOST}:${port}`);
  console.log(`State file: ${STATE_FILE}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
