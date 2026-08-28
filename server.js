import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8787);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/product-lookup") {
      const results = await productLookup(url.searchParams);
      sendJson(res, 200, { results });
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    const file = await readFile(target);
    res.writeHead(200, { "content-type": contentTypes[extname(target)] || "application/octet-stream" });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "Server error", message: error.message });
  }
}).listen(port, () => {
  console.log(`Closet Intake Lab running at http://localhost:${port}`);
});

async function productLookup(params) {
  const store = params.get("store") || "musinsa";
  const brand = clean(params.get("brand"));
  const name = clean(params.get("name"));
  const option = clean(params.get("option"));
  const query = [brand, name, option].filter(Boolean).join(" ");

  if (!query) return [];

  if (store === "musinsa") {
    return lookupMusinsa({ brand, name, option, query });
  }

  return lookupMusinsa({ brand, name, option, query });
}

async function lookupMusinsa(input) {
  const urls = await findMusinsaProductUrls(input.query);
  const candidates = [];

  for (const url of urls.slice(0, 5)) {
    try {
      const item = await readProductPage(url);
      if (!item.name && !item.image) continue;
      candidates.push({
        store: "musinsa",
        brand: item.brand || input.brand,
        name: item.name || input.name,
        price: item.price || "",
        image: item.image || "",
        url: item.url || url,
        score: scoreCandidate(input, item),
      });
    } catch (error) {
      console.warn(`Failed product page: ${url}`, error.message);
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score, ...candidate }) => candidate);
}

async function findMusinsaProductUrls(query) {
  const searchQuery = `${query} site:musinsa.com/products`;
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
  let html = "";
  try {
    html = await fetchText(ddgUrl);
  } catch (error) {
    throw new Error(`외부 검색 요청이 실패했습니다: ${error.message}`);
  }
  const urls = new Set();

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const decoded = decodeHtml(match[1]);
    const normalized = unwrapDuckDuckGoUrl(decoded);
    if (/https?:\/\/(?:www\.)?musinsa\.com\/(?:app\/goods|products)\/\d+/i.test(normalized)) {
      urls.add(normalizeMusinsaProductUrl(normalized));
    }
  }

  return [...urls];
}

async function readProductPage(url) {
  const html = await fetchText(url);
  const jsonLd = parseJsonLdProduct(html);
  const meta = {
    name: getMeta(html, "og:title") || jsonLd.name || "",
    image: absolutize(getMeta(html, "og:image") || firstImage(jsonLd.image), url),
    url: getMeta(html, "og:url") || url,
    brand: readJsonLdBrand(jsonLd),
    price: readJsonLdPrice(jsonLd) || getMeta(html, "product:price:amount") || "",
  };

  meta.name = cleanProductTitle(meta.name);
  if (meta.price && !/원$/.test(meta.price)) meta.price = `${numberWithCommas(meta.price)}원`;
  return meta;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!response.ok) throw new Error(`Fetch failed ${response.status}`);
  return response.text();
}

function parseJsonLdProduct(html) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1].trim()));
      const product = findProductJsonLd(parsed);
      if (product) return product;
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return {};
}

function findProductJsonLd(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findProductJsonLd(entry);
      if (found) return found;
    }
  }
  if (typeof value === "object") {
    const type = value["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return value;
    if (value["@graph"]) return findProductJsonLd(value["@graph"]);
  }
  return null;
}

function getMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegex(property)}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const value = html.match(pattern)?.[1];
    if (value) return decodeHtml(value);
  }
  return "";
}

function unwrapDuckDuckGoUrl(url) {
  const withProtocol = url.startsWith("//") ? `https:${url}` : url;
  try {
    const parsed = new URL(decodeHtml(withProtocol), "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return url;
  }
}

function normalizeMusinsaProductUrl(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/(?:app\/goods|products)\/(\d+)/i);
  return match ? `https://www.musinsa.com/products/${match[1]}` : parsed.href;
}

function scoreCandidate(input, item) {
  const targetTokens = tokenize([input.brand, input.name, input.option].join(" "));
  const itemTokens = tokenize([item.brand, item.name].join(" "));
  let score = 0;

  targetTokens.forEach((token) => {
    if (itemTokens.includes(token)) score += token.length > 3 ? 3 : 1;
  });

  if (input.brand && item.brand && normalizeText(input.brand) === normalizeText(item.brand)) score += 10;
  if (extractProductCode(input.query) && item.name?.includes(extractProductCode(input.query))) score += 12;
  return score;
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^가-힣a-z0-9]+/i)
    .filter((token) => token.length >= 2);
}

function normalizeText(value) {
  return clean(value).toLowerCase().replace(/[_/().-]/g, " ");
}

function extractProductCode(value) {
  return clean(value).match(/[A-Z]{2,}\d{2,}[A-Z0-9_-]*/i)?.[0] || "";
}

function cleanProductTitle(value) {
  return clean(value)
    .replace(/\s*-\s*무신사.*$/i, "")
    .replace(/\s*\|\s*무신사.*$/i, "");
}

function readJsonLdBrand(product) {
  const brand = product?.brand;
  if (!brand) return "";
  if (typeof brand === "string") return brand;
  return brand.name || "";
}

function readJsonLdPrice(product) {
  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  return offers?.price || offers?.lowPrice || "";
}

function firstImage(image) {
  if (Array.isArray(image)) return image[0] || "";
  return image || "";
}

function absolutize(value, base) {
  if (!value) return "";
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function decodeHtml(value) {
  return clean(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function numberWithCommas(value) {
  const digits = String(value).replace(/[^\d]/g, "");
  return digits ? Number(digits).toLocaleString("ko-KR") : value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
