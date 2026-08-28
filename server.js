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
      const payload = await productLookup(url.searchParams);
      sendJson(res, 200, Array.isArray(payload) ? { results: payload } : payload);
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
  const productUrl = clean(params.get("url"));
  const query = [brand, name, option].filter(Boolean).join(" ");

  if (productUrl) return lookupProductUrl(productUrl);
  if (!query) return [];

  if (store === "musinsa") {
    return lookupMusinsa({ brand, name, option, query });
  }

  return lookupGenericStore({ store, brand, name, option, query });
}

async function lookupProductUrl(productUrl) {
  const debug = { queries: [{ type: "product-url", query: productUrl }], errors: [] };
  try {
    const item = await readProductPage(normalizeProductUrl(productUrl));
    return {
      source: "url",
      results: item.name || item.image ? [item] : [],
      debug,
    };
  } catch (error) {
    debug.errors.push(`product-url: ${error.message}`);
    return { source: "url", results: [], debug };
  }
}

async function lookupMusinsa(input) {
  const debug = { queries: [], errors: [] };
  const apiCandidates = await searchMusinsaApi(input, debug);

  if (apiCandidates.length) {
    return {
      results: rankCandidates(input, apiCandidates).slice(0, 5),
      debug,
    };
  }

  const urls = await findMusinsaProductUrls(input.query, debug);
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

  return {
    results: rankCandidates(input, candidates).slice(0, 5),
    debug,
  };
}

async function searchMusinsaApi(input, debug) {
  const candidates = [];
  const seen = new Set();
  const queries = buildSearchQueries(input);

  for (const query of queries) {
    const url = `https://api.musinsa.com/api2/dp/v1/plp/goods?gf=A&sortCode=POPULAR&caller=SEARCH&keyword=${encodeURIComponent(query)}&page=1&size=20`;
    debug.queries.push({ type: "musinsa-api", query });

    try {
      const payload = await fetchJson(url);
      const goods = extractGoodsFromPayload(payload);
      goods.forEach((item) => {
        const normalized = normalizeMusinsaApiItem(item);
        if (!normalized.url || seen.has(normalized.url)) return;
        seen.add(normalized.url);
        candidates.push(normalized);
      });
    } catch (error) {
      debug.errors.push(`musinsa-api "${query}": ${error.message}`);
    }
  }

  return candidates;
}

function buildSearchQueries(input) {
  const baseName = stripSearchNoise(input.name);
  const withoutColor = stripColorWords(baseName);
  const code = extractProductCode(`${input.name} ${input.option}`);
  const compactName = compactProductName(withoutColor || baseName);
  const tokenVariants = buildTokenVariants(withoutColor || baseName);
  const terms = [
    [input.brand, baseName, code].filter(Boolean).join(" "),
    [input.brand, baseName].filter(Boolean).join(" "),
    baseName,
    [input.brand, withoutColor].filter(Boolean).join(" "),
    withoutColor,
    [input.brand, compactName].filter(Boolean).join(" "),
    compactName,
    ...tokenVariants.map((variant) => [input.brand, variant].filter(Boolean).join(" ")),
    ...tokenVariants,
    code ? [input.brand, code].filter(Boolean).join(" ") : "",
    code,
  ]
    .map((value) => clean(value))
    .filter((value) => value.length >= 2);

  return [...new Set(terms)].slice(0, 10);
}

async function lookupGenericStore(input) {
  const debug = { queries: [], errors: [] };
  const urls = await findGenericProductUrls(input, debug);
  const candidates = [];

  for (const url of urls.slice(0, 5)) {
    try {
      const item = await readProductPage(url);
      if (!item.name && !item.image) continue;
      candidates.push({
        store: input.store || "other",
        brand: item.brand || input.brand,
        name: item.name || input.name,
        price: item.price || "",
        image: item.image || "",
        url: item.url || url,
      });
    } catch (error) {
      debug.errors.push(`product-page: ${error.message}`);
    }
  }

  return {
    results: rankCandidates(input, candidates).slice(0, 5),
    debug,
  };
}

async function findGenericProductUrls(input, debug) {
  const domain = storeDomainHint(input.store);
  const urls = new Set();
  const queries = buildSearchQueries(input);

  for (const query of queries.slice(0, 5)) {
    const searchQuery = domain ? `${query} site:${domain}` : query;
    const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    debug.queries.push({ type: "web-search", query: searchQuery });
    try {
      const html = await fetchText(ddgUrl);
      for (const match of html.matchAll(/href="([^"]+)"/g)) {
        const normalized = unwrapDuckDuckGoUrl(decodeHtml(match[1]));
        if (!isUsableProductUrl(normalized, input.store)) continue;
        urls.add(normalized);
        if (urls.size >= 8) break;
      }
    } catch (error) {
      debug.errors.push(`web-search "${searchQuery}": ${error.message}`);
    }
    if (urls.size >= 5) break;
  }

  return [...urls];
}

function storeDomainHint(store) {
  if (store === "zara") return "zara.com";
  return "";
}

function isUsableProductUrl(url, store) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (/duckduckgo|google|naver|facebook|instagram|youtube|pinterest/i.test(parsed.hostname)) return false;
    if (store === "zara") return /zara\.com$/i.test(parsed.hostname) || /\.zara\.com$/i.test(parsed.hostname);
    return true;
  } catch {
    return false;
  }
}

function stripSearchNoise(value) {
  return clean(value)
    .replace(/구매\s*확정|배송\s*조회|재구매|스냅\s*보기|후기\s*작성.*$/g, " ")
    .replace(/(?:\d{1,3},)*\d{3}\s*원/g, " ")
    .replace(/\s*\/\s*\d+\s*개/g, " ")
    .replace(/\b(XS|S|M|L|XL|XXL|\d{2,3})\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactProductName(value) {
  return clean(value)
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[_/().-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTokenVariants(value) {
  const tokens = tokenize(value).filter((token) => token.length >= 2);
  const variants = [];
  if (tokens.length >= 4) variants.push(tokens.slice(0, 4).join(" "));
  if (tokens.length >= 3) variants.push(tokens.slice(0, 3).join(" "));
  if (tokens.length >= 4) variants.push(tokens.slice(1, 5).join(" "));
  return variants;
}

function stripColorWords(value) {
  return clean(value)
    .replace(/\[?(블랙|검정|화이트|아이보리|그레이|차콜|네이비|베이지|브라운|카키|올리브|핑크|그린|레드|black|white|ivory|gray|grey|navy|beige|brown|khaki|olive|pink|green|red)\]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGoodsFromPayload(payload) {
  const found = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;
    if (value.goodsNo || value.goodsNumber || value.goodsId) found.push(value);
    Object.values(value).forEach(visit);
  };
  visit(payload?.data || payload);
  return found;
}

function normalizeMusinsaApiItem(item) {
  const goodsNo = item.goodsNo || item.goodsNumber || item.goodsId;
  const price = item.finalPrice || item.price || item.normalPrice || item.salePrice || "";
  return {
    store: "musinsa",
    brand: item.brandName || item.brand || item.brandNameKor || "",
    name: item.goodsName || item.productName || item.name || "",
    price: price ? `${numberWithCommas(price)}원` : "",
    image: absolutize(item.imageUrl || item.thumbnail || item.goodsImageUrl || item.image || "", "https://www.musinsa.com"),
    url: goodsNo ? `https://www.musinsa.com/products/${goodsNo}` : item.linkUrl || item.url || "",
  };
}

async function findMusinsaProductUrls(query, debug = { queries: [], errors: [] }) {
  const searchQuery = `${query} site:musinsa.com/products`;
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
  let html = "";
  debug.queries.push({ type: "duckduckgo", query: searchQuery });
  try {
    html = await fetchText(ddgUrl);
  } catch (error) {
    debug.errors.push(`duckduckgo: ${error.message}`);
    return [];
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

async function fetchJson(url) {
  const text = await fetchText(url, "application/json,text/plain,*/*");
  return JSON.parse(text);
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

async function fetchText(url, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") {
  const response = await fetch(url, {
    headers: {
      "accept": accept,
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

function normalizeProductUrl(url) {
  if (/musinsa\.com/i.test(url)) return normalizeMusinsaProductUrl(url);
  return new URL(url).href;
}

function scoreCandidate(input, item) {
  const targetTokens = tokenize([input.brand, input.name, input.option].join(" "));
  const itemTokens = tokenize([item.brand, item.name].join(" "));
  let score = 0;

  targetTokens.forEach((token) => {
    if (itemTokens.includes(token)) score += token.length > 3 ? 3 : 1;
    else if (itemTokens.some((itemToken) => isNearToken(token, itemToken))) score += 1;
  });

  if (input.brand && item.brand && normalizeText(input.brand) === normalizeText(item.brand)) score += 10;
  if (extractProductCode(input.query) && item.name?.includes(extractProductCode(input.query))) score += 12;
  return score;
}

function isNearToken(a, b) {
  if (a.length < 3 || b.length < 3) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return levenshtein(a, b) <= 1;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function rankCandidates(input, candidates) {
  return candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(input, candidate) }))
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...candidate }) => candidate);
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
