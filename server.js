import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8787);
const weatherCache = new Map();

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

    if (url.pathname === "/api/weather") {
      const payload = await weatherLookup(url.searchParams);
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname === "/api/style-inspirations") {
      const payload = await styleInspirationsLookup(url.searchParams);
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname === "/api/image-proxy") {
      await proxyImage(url.searchParams, res);
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    const file = await readFile(target);
    res.writeHead(200, {
      "content-type": contentTypes[extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
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
    const normalizedUrl = normalizeProductUrl(productUrl);
    const item = await readProductPage(normalizedUrl);
    return {
      source: "url",
      results: [item],
      debug,
    };
  } catch (error) {
    debug.errors.push(`product-url: ${error.message}`);
    return { source: "url", results: [fallbackUrlItem(productUrl)], debug };
  }
}

async function weatherLookup(params) {
  const location = clean(params.get("location")) || "Seoul";
  const cacheKey = normalizeText(location);
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.payload;

  try {
    const place = knownPlace(location) || (await findWeatherPlace(location));
    if (!place) throw new Error("Location not found");

    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const forecast = await fetchJson(forecastUrl, 3000);
    const current = forecast.current || {};
    const daily = forecast.daily || {};
    const code = current.weather_code;
    const condition = weatherCodeLabel(code);
    const payload = {
      location: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      temperature: Number(current.temperature_2m ?? daily.temperature_2m_max?.[0] ?? 24),
      feelsLike: Number(current.apparent_temperature ?? current.temperature_2m ?? 24),
      min: Number(daily.temperature_2m_min?.[0] ?? current.temperature_2m ?? 19),
      max: Number(daily.temperature_2m_max?.[0] ?? current.temperature_2m ?? 27),
      precipitation: Number(daily.precipitation_probability_max?.[0] ?? 0),
      wind: Number(current.wind_speed_10m ?? 0),
      icon: condition.icon,
      summary: condition.label,
      detail: `최고 ${Math.round(Number(daily.temperature_2m_max?.[0] ?? current.temperature_2m ?? 0))}°C · 최저 ${Math.round(Number(daily.temperature_2m_min?.[0] ?? current.temperature_2m ?? 0))}°C · 강수확률 ${Number(daily.precipitation_probability_max?.[0] ?? 0)}%`,
      source: "open-meteo",
    };
    weatherCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  } catch (error) {
    return {
      location,
      temperature: 24,
      min: 19,
      max: 27,
      precipitation: 0,
      wind: 0,
      icon: "--",
      summary: "실시간 날씨 연결 실패",
      detail: `기본 날씨값으로 추천합니다. ${error.message}`,
      source: "fallback",
    };
  }
}

async function findWeatherPlace(location) {
  const placeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=ko&format=json`;
  const placePayload = await fetchJson(placeUrl, 2200);
  return placePayload?.results?.[0] || null;
}

function knownPlace(location) {
  const key = normalizeText(location);
  if (["seoul", "서울", "서울시", "서울특별시"].includes(key)) {
    return {
      name: "서울특별시",
      admin1: "서울특별시",
      country: "대한민국",
      latitude: 37.5665,
      longitude: 126.978,
    };
  }
  return null;
}

async function styleInspirationsLookup(params) {
  const concept = clean(params.get("concept")) || "캐주얼";
  const temp = Number(params.get("temp") || 24);
  const climate = temp >= 27 ? "summer" : temp <= 12 ? "winter" : "spring autumn";
  const query = `${concept} ${climate} outfit pinterest`;
  const debug = { queries: [{ type: "pinterest", query }], errors: [] };

  try {
    const images = await findPinterestImages(query);
    if (images.length) {
      return {
        results: buildStyleCards(concept, temp, images, "pinterest"),
        debug,
      };
    }
  } catch (error) {
    debug.errors.push(error.message);
  }

  return {
    results: buildStyleCards(concept, temp, fallbackStyleImages(concept), "fallback"),
    debug,
  };
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

async function fetchJson(url, timeout = 9000) {
  const text = await fetchText(url, "application/json,text/plain,*/*", timeout);
  return JSON.parse(text);
}

async function readProductPage(url) {
  const html = await fetchText(url);
  const jsonLd = parseJsonLdProduct(html);
  const nextData = parseNextData(html);
  const deepProduct = findProductLikeObject(nextData);
  const title = getMeta(html, "og:title") || getMeta(html, "twitter:title") || readHtmlTitle(html);
  const image =
    getMeta(html, "og:image") ||
    getMeta(html, "twitter:image") ||
    firstImage(jsonLd.image) ||
    firstImage(deepProduct?.image) ||
    firstImage(deepProduct?.images) ||
    deepProduct?.imageUrl ||
    deepProduct?.thumbnail ||
    deepProduct?.goodsImageUrl ||
    "";
  const meta = {
    name: title || jsonLd.name || deepProduct?.name || deepProduct?.productName || deepProduct?.goodsName || "",
    image: absolutize(cleanImageUrl(image), url),
    url: getMeta(html, "og:url") || deepProduct?.url || url,
    brand: readJsonLdBrand(jsonLd) || readDeepBrand(deepProduct),
    price: readJsonLdPrice(jsonLd) || getMeta(html, "product:price:amount") || deepProduct?.price || deepProduct?.finalPrice || deepProduct?.salePrice || "",
  };

  meta.name = cleanProductTitle(meta.name);
  if (isBlankMetaValue(meta.name)) meta.name = "";
  if (meta.price && !/원$/.test(meta.price)) meta.price = `${numberWithCommas(meta.price)}원`;
  if (!meta.name && !meta.image) return fallbackUrlItem(url);
  return meta;
}

async function fetchText(url, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": accept,
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    if (!response.ok) throw new Error(`Fetch failed ${response.status}`);
    return response.text();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Fetch timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function findPinterestImages(query) {
  const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, "text/html,*/*", 3200);
  const urls = new Set();
  for (const match of html.matchAll(/https?:\\?\/\\?\/i\.pinimg\.com\\?\/[^"'\\<>\s]+/gi)) {
    const image = cleanImageUrl(match[0]).replace(/\\u0026/g, "&");
    if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(image)) continue;
    urls.add(image);
    if (urls.size >= 3) break;
  }
  return [...urls];
}

function buildStyleCards(concept, temp, images, source) {
  const climateTitle =
    temp >= 27 ? "더운 날 가벼운 상하의" : temp <= 12 ? "쌀쌀한 날 긴팔 중심" : "일교차 대응 데일리";
  const titles = {
    "캐주얼": [climateTitle, "티셔츠/셔츠 + 데님", "편한 실루엣 중심"],
    "포멀": [climateTitle, "셔츠 + 슬랙스", "단정한 무채색 조합"],
    "미니멀": [climateTitle, "솔리드 톤 조합", "블랙/화이트/그레이 중심"],
    "스트릿": [climateTitle, "오버핏 + 와이드 팬츠", "포켓/그래픽 포인트"],
    "데이트": [climateTitle, "부드러운 톤 상의", "깔끔한 데님/슬랙스"],
    "출근": [climateTitle, "셔츠 + 다크 팬츠", "업무용 미니멀 조합"],
  };
  const descriptions = [
    `${Math.round(temp)}°C 날씨에 맞춘 ${concept} 참고 이미지`,
    "옷장 안 상의/하의 색감 비교에 사용할 후보",
    "최종 추천 전 분위기 기준으로 쓰는 예시",
  ];
  return (titles[concept] || titles["캐주얼"]).slice(0, 3).map((title, index) => ({
    title,
    description: descriptions[index],
    image: images[index % images.length],
    visual: styleVisualProfile(concept, temp, index),
    source,
  }));
}

async function proxyImage(params, res) {
  const rawUrl = clean(params.get("url"));
  try {
    const imageUrl = new URL(rawUrl);
    if (!/^https?:$/.test(imageUrl.protocol)) throw new Error("Only http images are allowed");
    if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/i.test(imageUrl.hostname)) {
      throw new Error("Private image hosts are blocked");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(imageUrl.href, {
      signal: controller.signal,
      headers: {
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    }).finally(() => clearTimeout(timer));

    if (!response.ok) throw new Error(`Image fetch failed ${response.status}`);
    const type = response.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) throw new Error("URL is not an image");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    });
    res.end(buffer);
  } catch (error) {
    sendJson(res, 400, { error: "Image proxy failed", message: error.message });
  }
}

function styleVisualProfile(concept, temp, index) {
  const warm = temp >= 27 ? 0.58 : temp <= 12 ? 0.42 : 0.5;
  const base = {
    "캐주얼": [
      { families: ["화이트/아이보리", "블루/데님", "블랙"], brightness: 0.66, saturation: 0.34, warmth: warm },
      { families: ["블루/데님", "화이트/아이보리", "그레이"], brightness: 0.62, saturation: 0.38, warmth: warm },
      { families: ["블랙", "블루/데님", "화이트/아이보리"], brightness: 0.45, saturation: 0.32, warmth: warm },
    ],
    "포멀": [
      { families: ["화이트/아이보리", "블랙", "그레이"], brightness: 0.55, saturation: 0.18, warmth: 0.48 },
      { families: ["네이비", "화이트/아이보리", "그레이"], brightness: 0.5, saturation: 0.2, warmth: 0.45 },
      { families: ["블랙", "그레이", "화이트/아이보리"], brightness: 0.42, saturation: 0.16, warmth: 0.42 },
    ],
    "미니멀": [
      { families: ["화이트/아이보리", "블랙", "그레이"], brightness: 0.58, saturation: 0.12, warmth: 0.48 },
      { families: ["그레이", "블랙", "화이트/아이보리"], brightness: 0.5, saturation: 0.12, warmth: 0.45 },
      { families: ["네이비", "화이트/아이보리", "블랙"], brightness: 0.48, saturation: 0.18, warmth: 0.42 },
    ],
    "스트릿": [
      { families: ["블랙", "그레이", "블루/데님"], brightness: 0.36, saturation: 0.28, warmth: 0.42 },
      { families: ["블루/데님", "블랙", "그레이"], brightness: 0.43, saturation: 0.35, warmth: 0.44 },
      { families: ["카키/올리브", "블랙", "그레이"], brightness: 0.4, saturation: 0.32, warmth: 0.46 },
    ],
    "데이트": [
      { families: ["화이트/아이보리", "블루/데님", "베이지"], brightness: 0.68, saturation: 0.25, warmth: 0.56 },
      { families: ["베이지", "화이트/아이보리", "블루/데님"], brightness: 0.62, saturation: 0.22, warmth: 0.6 },
      { families: ["그레이", "블루/데님", "화이트/아이보리"], brightness: 0.56, saturation: 0.2, warmth: 0.5 },
    ],
    "출근": [
      { families: ["화이트/아이보리", "네이비", "블랙"], brightness: 0.52, saturation: 0.18, warmth: 0.45 },
      { families: ["그레이", "블랙", "화이트/아이보리"], brightness: 0.48, saturation: 0.14, warmth: 0.45 },
      { families: ["네이비", "그레이", "화이트/아이보리"], brightness: 0.45, saturation: 0.18, warmth: 0.43 },
    ],
  };
  const profiles = base[concept] || base["캐주얼"];
  return profiles[index % profiles.length];
}

function fallbackStyleImages(concept) {
  const common = [
    "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=640&q=80",
    "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=640&q=80",
    "https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80",
  ];
  const map = {
    "캐주얼": [
      "https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=640&q=80",
    ],
    "포멀": [
      "https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1508243529287-e21914733111?auto=format&fit=crop&w=640&q=80",
    ],
    "미니멀": [
      "https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?auto=format&fit=crop&w=640&q=80",
    ],
    "스트릿": [
      "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1523398002811-999ca8dec234?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1506629905607-d9e297d33b54?auto=format&fit=crop&w=640&q=80",
    ],
    "데이트": [
      "https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1503341455253-b2e723bb3dbb?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=640&q=80",
    ],
    "출근": [
      "https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80",
      "https://images.unsplash.com/photo-1508243529287-e21914733111?auto=format&fit=crop&w=640&q=80",
    ],
  };
  return map[concept] || common;
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

function parseNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(decodeHtml(match[1].trim()));
  } catch {
    return null;
  }
}

function findProductLikeObject(value, depth = 0) {
  if (!value || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findProductLikeObject(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const keys = Object.keys(value);
  const hasName = keys.some((key) => /^(name|productName|goodsName|title)$/i.test(key));
  const hasImage = keys.some((key) => /image|thumbnail|goodsImage/i.test(key));
  const hasPrice = keys.some((key) => /price|amount/i.test(key));
  if (hasName && (hasImage || hasPrice)) return value;
  for (const entry of Object.values(value)) {
    const found = findProductLikeObject(entry, depth + 1);
    if (found) return found;
  }
  return null;
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

function readDeepBrand(product) {
  const brand = product?.brand || product?.brandName || product?.brandNameKor || product?.maker;
  if (!brand) return "";
  if (typeof brand === "string") return brand;
  return brand.name || "";
}

function firstImage(image) {
  if (Array.isArray(image)) return image[0] || "";
  if (typeof image === "object") return image?.url || image?.src || "";
  return image || "";
}

function cleanImageUrl(value) {
  return decodeHtml(String(value || ""))
    .replace(/\\u002F/g, "/")
    .replace(/\\/g, "")
    .trim();
}

function absolutize(value, base) {
  if (!value) return "";
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function readHtmlTitle(html) {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
}

function fallbackUrlItem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL(`https://${String(url).replace(/^\/+/, "")}`);
  }
  return {
    store: /musinsa\.com/i.test(parsed.hostname) ? "musinsa" : "generic",
    brand: "",
    name: parsed.hostname.replace(/^www\./, ""),
    price: "",
    image: "",
    url,
  };
}

function weatherCodeLabel(code) {
  if ([0].includes(code)) return { label: "맑음", icon: "SUN" };
  if ([1, 2, 3].includes(code)) return { label: "구름 조금", icon: "CLD" };
  if ([45, 48].includes(code)) return { label: "안개", icon: "FOG" };
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: "비", icon: "RAIN" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: "눈", icon: "SNOW" };
  if ([95, 96, 99].includes(code)) return { label: "뇌우", icon: "!" };
  return { label: "날씨 정보", icon: "--" };
}

function decodeHtml(value) {
  return clean(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isBlankMetaValue(value) {
  return !clean(value).replace(/&nbsp;|\s|[\u00a0]/g, "");
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
