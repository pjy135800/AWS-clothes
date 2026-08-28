const categories = [
  "상의",
  "하의",
  "신발",
  "아우터",
  "가방",
  "모자/액세서리",
  "기타",
];

const state = {
  queue: [],
  wardrobe: loadWardrobe(),
  orderImage: null,
  orderFile: null,
  canvasScale: 1,
  selection: null,
  directImageData: "",
};

const $ = (selector) => document.querySelector(selector);
const queueEl = $("#queue");
const wardrobeEl = $("#wardrobe");
const orderCanvas = $("#orderCanvas");
const ctx = orderCanvas.getContext("2d");

init();

function init() {
  fillCategorySelects();
  bindTabs();
  bindOrderFlow();
  bindDirectFlow();
  bindWardrobeTools();
  renderQueue();
  renderWardrobe();
}

function fillCategorySelects() {
  const selects = [$("#directCategory"), $("#categoryFilter")];
  selects.forEach((select) => {
    if (!select) return;
    categories.forEach((category) => {
      if (select.id === "categoryFilter" && category === "기타") return;
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.append(option);
    });
  });
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((node) => node.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((node) => node.classList.remove("active"));
      tab.classList.add("active");
      $(`#${tab.dataset.tab}Tab`).classList.add("active");
    });
  });
}

function bindOrderFlow() {
  $("#orderImage").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    state.orderFile = file;
    state.orderImage = await readImage(file);
    state.selection = null;
    $("#canvasWrap").classList.remove("empty");
    $("#detectBtn").disabled = false;
    $("#ocrBtn").disabled = false;
    $("#manualCropBtn").disabled = false;
    $("#clearSelectionBtn").disabled = false;
    drawOrderImage();
  });

  $("#detectBtn").addEventListener("click", () => {
    if (!state.orderImage) return;
    const crops = detectImageLikeRegions(state.orderImage);
    crops.forEach((crop) => addCandidate({ image: crop.image, source: "자동 썸네일" }));
    renderQueue();
    toast(crops.length ? `${crops.length}개의 썸네일 후보를 만들었어요.` : "자동 후보를 찾지 못했어요. 직접 드래그해서 추가해보세요.");
  });

  $("#ocrBtn").addEventListener("click", runOcr);
  $("#makeTextCandidatesBtn").addEventListener("click", makeTextCandidates);
  $("#manualCropBtn").addEventListener("click", addManualCrop);
  $("#clearSelectionBtn").addEventListener("click", () => {
    state.selection = null;
    drawOrderImage();
  });

  orderCanvas.addEventListener("pointerdown", startSelection);
  orderCanvas.addEventListener("pointermove", moveSelection);
  window.addEventListener("pointerup", endSelection);
}

function bindDirectFlow() {
  $("#directPhoto").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await imageFileToCompressedDataUrl(file);
    state.directImageData = dataUrl;
    $("#directPreview").classList.remove("empty");
    $("#directPreview").innerHTML = `<img src="${dataUrl}" alt="직접 등록 사진 미리보기" />`;

    const inferred = inferFromText(file.name);
    $("#directName").value ||= cleanName(file.name.replace(/\.[^.]+$/, ""));
    $("#directCategory").value = inferred.category;
    $("#directColor").value ||= inferred.color;
    $("#directStyle").value ||= inferred.style;
  });

  $("#directForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.directImageData) {
      toast("먼저 옷 사진을 올려주세요.");
      return;
    }

    const item = normalizeItem({
      image: state.directImageData,
      name: $("#directName").value || "이름 없는 옷",
      category: $("#directCategory").value,
      color: $("#directColor").value,
      style: $("#directStyle").value,
      season: $("#directSeason").value,
      source: "직접 사진",
    });
    state.wardrobe.unshift(item);
    saveWardrobe();
    renderWardrobe();
    event.target.reset();
    $("#directPreview").classList.add("empty");
    $("#directPreview").textContent = "사진을 올리면 미리보기가 보여요.";
    state.directImageData = "";
    toast("옷장에 등록했어요.");
  });
}

function bindWardrobeTools() {
  $("#clearQueueBtn").addEventListener("click", () => {
    state.queue = [];
    renderQueue();
  });
  $("#categoryFilter").addEventListener("change", renderWardrobe);
  $("#searchFilter").addEventListener("input", renderWardrobe);
  $("#exportBtn").addEventListener("click", exportWardrobe);
  $("#importInput").addEventListener("change", importWardrobe);
}

function drawOrderImage() {
  const img = state.orderImage;
  if (!img) return;

  const maxWidth = $("#canvasWrap").clientWidth;
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  state.canvasScale = scale;
  orderCanvas.width = Math.round(img.naturalWidth * scale);
  orderCanvas.height = Math.round(img.naturalHeight * scale);
  ctx.clearRect(0, 0, orderCanvas.width, orderCanvas.height);
  ctx.drawImage(img, 0, 0, orderCanvas.width, orderCanvas.height);

  if (state.selection) {
    const { x, y, w, h } = state.selection;
    ctx.save();
    ctx.strokeStyle = "#1f6f68";
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = "rgba(31, 111, 104, 0.13)";
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

function startSelection(event) {
  if (!state.orderImage) return;
  const point = canvasPoint(event);
  state.selection = { startX: point.x, startY: point.y, x: point.x, y: point.y, w: 0, h: 0 };
}

function moveSelection(event) {
  if (!state.selection || event.buttons !== 1) return;
  const point = canvasPoint(event);
  const x = Math.min(state.selection.startX, point.x);
  const y = Math.min(state.selection.startY, point.y);
  const w = Math.abs(point.x - state.selection.startX);
  const h = Math.abs(point.y - state.selection.startY);
  state.selection = { ...state.selection, x, y, w, h };
  drawOrderImage();
}

function endSelection() {
  if (!state.selection) return;
  if (state.selection.w < 20 || state.selection.h < 20) {
    state.selection = null;
    drawOrderImage();
  }
}

function canvasPoint(event) {
  const rect = orderCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(orderCanvas.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(orderCanvas.height, event.clientY - rect.top)),
  };
}

function addManualCrop() {
  if (!state.selection || !state.orderImage) {
    toast("스크린샷에서 옷 이미지 영역을 드래그해 주세요.");
    return;
  }

  const crop = cropOriginalImage(state.selection);
  addCandidate({ image: crop, source: "직접 선택" });
  state.selection = null;
  drawOrderImage();
  renderQueue();
  toast("선택 영역을 후보에 추가했어요.");
}

async function runOcr() {
  if (!state.orderFile) return;
  if (!window.Tesseract) {
    toast("OCR 라이브러리를 불러오지 못했어요. 인터넷 연결 후 다시 시도하거나 텍스트를 직접 붙여넣어 주세요.");
    return;
  }

  const button = $("#ocrBtn");
  button.disabled = true;
  button.textContent = "OCR 진행 중...";

  try {
    const result = await Tesseract.recognize(state.orderFile, $("#ocrLang").value, {
      logger: (message) => {
        if (message.status === "recognizing text") {
          button.textContent = `OCR ${Math.round(message.progress * 100)}%`;
        }
      },
    });
    $("#ocrText").value = cleanupOcrText(result.data.text);
    makeTextCandidates();
    toast("OCR에서 상품 후보를 정리했어요. 틀린 부분만 수정하면 됩니다.");
  } catch (error) {
    console.error(error);
    toast("OCR에 실패했어요. 캡처가 흐리면 텍스트를 직접 붙여넣는 방식으로 테스트해 주세요.");
  } finally {
    button.disabled = false;
    button.textContent = "OCR 실행";
  }
}

function makeTextCandidates() {
  const items = parseOrderItems($("#ocrText").value, $("#storeSelect").value);

  items.forEach((item) => {
    const inferred = inferFromText(`${item.brand} ${item.name} ${item.option}`);
    addCandidate({
      name: item.name,
      brand: item.brand || inferred.brand,
      option: item.option,
      price: item.price,
      store: $("#storeSelect").value,
      category: inferred.category,
      color: inferred.color,
      style: inferred.style,
      season: inferred.season,
      source: "OCR 상품 정리",
    });
  });

  renderQueue();
  toast(items.length ? `${items.length}개의 상품 후보를 만들었어요.` : "상품 후보를 찾지 못했어요. OCR 원문에서 상품명 줄만 남겨 다시 눌러보세요.");
}

function addCandidate(data) {
  const inferred = inferFromText(`${data.brand || ""} ${data.name || ""} ${data.option || ""}`);
  state.queue.unshift({
    id: crypto.randomUUID(),
    image: data.image || "",
    name: data.name || "",
    brand: data.brand || inferred.brand,
    option: data.option || "",
    price: data.price || "",
    store: data.store || $("#storeSelect")?.value || "generic",
    productUrl: data.productUrl || "",
    category: data.category || inferred.category,
    color: data.color || inferred.color,
    style: data.style || inferred.style,
    season: data.season || inferred.season,
    source: data.source || "후보",
    lookupStatus: "",
    lookupCandidates: [],
    lookupDebug: null,
  });
}

function renderQueue() {
  queueEl.innerHTML = "";
  state.queue.forEach((candidate) => {
    const card = document.createElement("article");
    card.className = "candidate";
    card.innerHTML = `
      <div class="candidate-media">
        ${candidate.image ? `<img src="${candidate.image}" alt="상품 후보 이미지" />` : `<span class="pill">이미지 없음</span>`}
      </div>
      <div class="candidate-fields">
        <div class="grid-2">
          <label>제품명<input data-field="name" value="${escapeAttr(candidate.name)}" placeholder="상품명 또는 별명" /></label>
          <label>브랜드<input data-field="brand" value="${escapeAttr(candidate.brand)}" placeholder="예: Musinsa Standard" /></label>
        </div>
        <div class="grid-2">
          <label>옵션<input data-field="option" value="${escapeAttr(candidate.option)}" placeholder="예: 블랙.XL / 1개" /></label>
          <label>구매가<input data-field="price" value="${escapeAttr(candidate.price)}" placeholder="예: 32,600원" /></label>
        </div>
        <div class="mini-grid">
          <label>분류<select data-field="category">${categoryOptions(candidate.category)}</select></label>
          <label>색상<input data-field="color" value="${escapeAttr(candidate.color)}" placeholder="색상" /></label>
          <label>무드<input data-field="style" value="${escapeAttr(candidate.style)}" placeholder="무드" /></label>
          <label>계절<select data-field="season">${seasonOptions(candidate.season)}</select></label>
        </div>
        <div class="lookup-box">
          ${renderLookupState(candidate)}
          <span class="pill">${candidate.source}</span>
        </div>
        <div class="candidate-actions">
          <button data-action="lookup" class="secondary" type="button">원본 상품 정보 가져오기</button>
          <button data-action="register" type="button">맞아요, 등록</button>
          <button data-action="replace-image" class="secondary" type="button">이미지 교체</button>
          <button data-action="remove" class="danger" type="button">삭제</button>
          <input data-action="image-input" type="file" accept="image/*" hidden />
        </div>
      </div>
    `;

    card.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        candidate[input.dataset.field] = input.value;
      });
    });
    card.querySelectorAll('[data-action="apply-lookup"]').forEach((button) => {
      button.addEventListener("click", () => applyLookupCandidate(candidate.id, Number(button.dataset.index)));
    });
    card.querySelector('[data-action="lookup"]').addEventListener("click", () => lookupProductInfo(candidate.id));
    card.querySelector('[data-action="register"]').addEventListener("click", () => registerCandidate(candidate.id));
    card.querySelector('[data-action="remove"]').addEventListener("click", () => removeCandidate(candidate.id));
    card.querySelector('[data-action="replace-image"]').addEventListener("click", () => {
      card.querySelector('[data-action="image-input"]').click();
    });
    card.querySelector('[data-action="image-input"]').addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      candidate.image = await imageFileToCompressedDataUrl(file);
      renderQueue();
    });
    queueEl.append(card);
  });
}

function renderLookupState(candidate) {
  if (candidate.lookupCandidates?.length) {
    return `
      <div class="lookup-results">
        ${candidate.lookupCandidates
          .map(
            (result, index) => `
              <button class="lookup-result" data-action="apply-lookup" data-index="${index}" type="button">
                ${result.image ? `<img src="${escapeAttr(result.image)}" alt="" />` : ""}
                <span>
                  <strong>${escapeHtml(result.name)}</strong>
                  <small>${escapeHtml([result.brand, result.price].filter(Boolean).join(" · "))}</small>
                </span>
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  if (candidate.lookupStatus) {
    return `
      <p class="lookup-status">${escapeHtml(candidate.lookupStatus)}</p>
      ${renderLookupDebug(candidate.lookupDebug)}
    `;
  }

  return `<p class="lookup-status">OCR 후보를 확인한 뒤 원본 상품 정보 가져오기를 누르면, 서버 어댑터가 연결된 경우 실제 상품 사진과 정보를 후보로 표시합니다.</p>`;
}

function renderLookupDebug(debug) {
  if (!debug?.queries?.length && !debug?.errors?.length) return "";
  const queries = (debug.queries || [])
    .map((entry) => `${entry.type}: ${entry.query}`)
    .slice(0, 5)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  const errors = (debug.errors || [])
    .slice(0, 3)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  return `
    <details class="lookup-debug">
      <summary>조회 로그</summary>
      ${queries ? `<strong>검색어</strong><ul>${queries}</ul>` : ""}
      ${errors ? `<strong>오류</strong><ul>${errors}</ul>` : ""}
    </details>
  `;
}

async function lookupProductInfo(id) {
  const candidate = state.queue.find((entry) => entry.id === id);
  if (!candidate) return;

  candidate.lookupStatus = "상품 정보 조회 중...";
  candidate.lookupCandidates = [];
  renderQueue();

  try {
    const payload = await fetchProductLookup(candidate);
    candidate.lookupCandidates = payload.results;
    candidate.lookupDebug = payload.debug;
    candidate.lookupStatus = payload.results.length
      ? "가져온 후보 중 맞는 상품을 선택해 주세요."
      : "일치하는 상품 후보를 찾지 못했어요. 아래 조회 로그의 검색어를 보고 상품명/브랜드를 조금 줄여 다시 조회해보세요.";
  } catch (error) {
    console.error(error);
    candidate.lookupStatus = error.message;
  }

  renderQueue();
}

async function fetchProductLookup(candidate) {
  if (location.protocol === "file:") {
    throw new Error("상품 조회는 서버 실행이 필요합니다. 이 폴더에서 npm start로 열면 버튼이 /api/product-lookup을 호출합니다.");
  }

  const params = new URLSearchParams({
    store: candidate.store || "musinsa",
    brand: candidate.brand || "",
    name: candidate.name || "",
    option: candidate.option || "",
  });
  const response = await fetch(`/api/product-lookup?${params.toString()}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "상품 조회 서버에서 응답을 받지 못했어요.");
  }
  return {
    results: Array.isArray(payload.results) ? payload.results : [],
    debug: payload.debug || null,
  };
}

function applyLookupCandidate(candidateId, resultIndex) {
  const candidate = state.queue.find((entry) => entry.id === candidateId);
  const result = candidate?.lookupCandidates?.[resultIndex];
  if (!candidate || !result) return;

  candidate.image = result.image || candidate.image;
  candidate.name = result.name || candidate.name;
  candidate.brand = result.brand || candidate.brand;
  candidate.price = result.price || candidate.price;
  candidate.productUrl = result.url || candidate.productUrl;

  const inferred = inferFromText(`${candidate.brand} ${candidate.name} ${candidate.option}`);
  candidate.category ||= inferred.category;
  candidate.color ||= inferred.color;
  candidate.style ||= inferred.style;
  candidate.season ||= inferred.season;
  candidate.lookupStatus = "원본 상품 정보를 적용했어요.";
  candidate.lookupCandidates = [];
  renderQueue();
}

function registerCandidate(id) {
  const index = state.queue.findIndex((candidate) => candidate.id === id);
  if (index < 0) return;
  const [candidate] = state.queue.splice(index, 1);
  state.wardrobe.unshift(normalizeItem(candidate));
  saveWardrobe();
  renderQueue();
  renderWardrobe();
  toast("옷장에 등록했어요.");
}

function removeCandidate(id) {
  state.queue = state.queue.filter((candidate) => candidate.id !== id);
  renderQueue();
}

function renderWardrobe() {
  const category = $("#categoryFilter").value;
  const query = $("#searchFilter").value.trim().toLowerCase();
  const items = state.wardrobe.filter((item) => {
    const categoryMatch = category === "all" || item.category === category;
    const text = [item.name, item.brand, item.color, item.style, item.season].join(" ").toLowerCase();
    return categoryMatch && (!query || text.includes(query));
  });

  $("#wardrobeCount").textContent = state.wardrobe.length;
  wardrobeEl.innerHTML = "";
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-media">
        ${item.image ? `<img src="${item.image}" alt="${escapeAttr(item.name)}" />` : `<span class="pill">이미지 없음</span>`}
      </div>
      <div>
        <h3>${escapeHtml(item.name || "이름 없는 옷")}</h3>
        <div class="meta">
          ${[item.brand, item.category, item.color, item.style, item.season].filter(Boolean).map((value) => `<span class="pill">${escapeHtml(value)}</span>`).join("")}
        </div>
        <div class="item-actions">
          <button class="danger" data-action="delete" type="button">삭제</button>
        </div>
      </div>
    `;
    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.wardrobe = state.wardrobe.filter((entry) => entry.id !== item.id);
      saveWardrobe();
      renderWardrobe();
    });
    wardrobeEl.append(card);
  });
}

function normalizeItem(data) {
  return {
    id: data.id || crypto.randomUUID(),
    image: data.image || "",
    name: cleanName(data.name || "이름 없는 옷"),
    brand: cleanName(data.brand || ""),
    option: cleanName(data.option || ""),
    price: cleanName(data.price || ""),
    store: data.store || "generic",
    productUrl: data.productUrl || "",
    category: data.category || "기타",
    color: cleanName(data.color || ""),
    style: cleanName(data.style || ""),
    season: data.season || "사계절",
    source: data.source || "",
    createdAt: new Date().toISOString(),
  };
}

function parseOrderItems(text, store) {
  const lines = cleanupOcrText(text)
    .split("\n")
    .map(normalizeOcrLine)
    .filter(Boolean)
    .filter((line) => !isOrderNoise(line));

  if (store === "musinsa") return parseMusinsaOrderLines(lines);
  return parseGenericOrderLines(lines);
}

function parseMusinsaOrderLines(lines) {
  const items = [];
  let current = null;
  let expectingBrand = false;

  lines.forEach((line) => {
    if (isPurchaseStatus(line)) {
      pushCurrentItem(items, current);
      current = null;
      expectingBrand = true;
      return;
    }

    if (isDateLine(line)) {
      pushCurrentItem(items, current);
      current = null;
      expectingBrand = false;
      return;
    }

    if (isPriceLine(line)) {
      if (current) {
        current.price = extractPrice(line);
        pushCurrentItem(items, current);
        current = null;
      }
      expectingBrand = false;
      return;
    }

    if (expectingBrand && isLikelyBrandLine(line)) {
      current = { brand: line, nameParts: [], optionParts: [], price: "" };
      expectingBrand = false;
      return;
    }

    if (!current && isLikelyBrandLine(line)) {
      current = { brand: line, nameParts: [], optionParts: [], price: "" };
      return;
    }

    if (!current) return;

    if (isOptionLine(line)) {
      current.optionParts.push(line);
      return;
    }

    if (isProductCodeLine(line) && current.nameParts.length) {
      current.nameParts.push(line);
      return;
    }

    if (isLikelyProductName(line)) {
      current.nameParts.push(line);
    }
  });

  pushCurrentItem(items, current);
  return dedupeItems(items);
}

function parseGenericOrderLines(lines) {
  const items = [];
  let chunk = [];

  lines.forEach((line) => {
    chunk.push(line);
    if (isPriceLine(line)) {
      const price = extractPrice(line);
      const body = chunk.filter((entry) => !isPriceLine(entry));
      const brand = body.find(isLikelyBrandLine) || "";
      const name = body
        .filter((entry) => entry !== brand)
        .filter(isLikelyProductName)
        .sort((a, b) => b.length - a.length)[0];
      if (name) items.push(buildOrderItem({ brand, nameParts: [name], optionParts: body.filter(isOptionLine), price }));
      chunk = [];
    }
  });

  if (!items.length) {
    lines
      .filter(isLikelyProductName)
      .slice(0, 20)
      .forEach((line) => items.push(buildOrderItem({ brand: "", nameParts: [line], optionParts: [], price: "" })));
  }

  return dedupeItems(items);
}

function pushCurrentItem(items, current) {
  if (!current) return;
  const item = buildOrderItem(current);
  if (item.name) items.push(item);
}

function buildOrderItem(current) {
  const name = cleanName((current.nameParts || []).join(" "));
  const option = cleanName((current.optionParts || []).join(" "));
  return {
    brand: cleanName(current.brand || ""),
    name,
    option,
    price: cleanName(current.price || ""),
  };
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.brand}|${item.name}|${item.option}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return item.name.length >= 4;
  });
}

function normalizeOcrLine(line) {
  return cleanName(
    line
      .replace(/[|{}[\]<>]/g, " ")
      .replace(/[•·]\s*1개/g, " / 1개")
      .replace(/\s*\/\s*/g, " / ")
  );
}

function isOrderNoise(line) {
  return [
    /^(\d{1,2}:)?\d{1,2}\s*%?$/,
    /^LTE$/i,
    /^주문\s*내역$/,
    /^주문\s*상세$/,
    /^상품명\s*\/\s*브랜드명/,
    /검색하세요/,
    /^전체$/,
    /^온라인\s*주문$/,
    /^오프라인\s*구매$/,
    /^유즈드$/,
    /^상품권$/,
    /^티켓$/,
    /^안 입는 옷/,
    /^스냅\s*보기$/,
    /^후기\s*작성/,
    /^배송\s*조회$/,
    /^재구매$/,
    /^홈$/,
  ].some((regex) => regex.test(line));
}

function isPurchaseStatus(line) {
  return /구매\s*확정|배송\s*완료|결제\s*완료|주문\s*완료/.test(line);
}

function isDateLine(line) {
  return /^\d{2,4}[.\/-]\d{1,2}[.\/-]\d{1,2}/.test(line);
}

function isPriceLine(line) {
  return /(?:\d{1,3},)*\d{3}\s*원|\d+\s*원/.test(line);
}

function extractPrice(line) {
  return line.match(/(?:\d{1,3},)*\d{3}\s*원|\d+\s*원/)?.[0]?.replace(/\s+/g, "") || "";
}

function isLikelyBrandLine(line) {
  if (line.length < 2 || line.length > 24) return false;
  if (isOptionLine(line) || isPriceLine(line) || isDateLine(line)) return false;
  if (/[\/\d]/.test(line) && !/29CM|8seconds|87MM/i.test(line)) return false;
  if (/\s/.test(line) && !/^[A-Z0-9&.\-\s]+$/.test(line)) return false;
  return /[가-힣A-Za-z]/.test(line);
}

function isProductCodeLine(line) {
  return /^[A-Z]{1,6}\d{2,}[A-Z0-9_-]*$/i.test(line);
}

function isOptionLine(line) {
  return (
    /\/\s*\d+\s*개/.test(line) ||
    /(블랙|네이비|화이트|아이보리|그레이|차콜|베이지|브라운|카키|올리브|핑크|그린|레드|BLACK|NAVY|WHITE|IVORY|GRAY|GREY|BEIGE|BROWN|KHAKI|OLIVE|PINK|GREEN|RED).*(XS|S|M|L|XL|XXL|\d{2,3})/i.test(line) ||
    /^[A-Z0-9_-]+[._-](BLACK|NAVY|WHITE|IVORY|GRAY|GREY|BEIGE|BROWN|KHAKI|OLIVE|DARK|LIGHT)/i.test(line)
  );
}

function isLikelyProductName(line) {
  if (line.length < 4 || line.length > 90) return false;
  if (isOrderNoise(line) || isPriceLine(line) || isDateLine(line)) return false;
  if (/^\d+$/.test(line)) return false;
  return /[가-힣A-Za-z]/.test(line);
}

function inferFromText(text) {
  const lower = text.toLowerCase();
  const rules = [
    [/패딩|코트|자켓|재킷|점퍼|바람막이|후드집업|블레이저|cardigan|jacket|coat|parka/, "아우터"],
    [/팬츠|바지|데님|진|슬랙스|쇼츠|반바지|스커트|pants|jeans|shorts|slacks|skirt/, "하의"],
    [/스니커즈|운동화|구두|부츠|로퍼|샌들|shoes|sneakers|boots|loafer|sandal/, "신발"],
    [/티셔츠|반팔|긴팔|셔츠|니트|맨투맨|후디|후드|탑|블라우스|tee|shirt|knit|sweatshirt|hoodie|blouse/, "상의"],
    [/백팩|가방|토트|크로스백|bag|backpack|tote/, "가방"],
    [/캡|비니|모자|벨트|머플러|hat|cap|beanie|belt|scarf/, "모자/액세서리"],
  ];
  const colorRules = [
    [/블랙|검정|black|bk/, "블랙"],
    [/화이트|흰|white|ivory|아이보리|cream|크림/, "화이트/아이보리"],
    [/그레이|회색|gray|grey|charcoal|차콜/, "그레이"],
    [/네이비|navy/, "네이비"],
    [/블루|파랑|청|denim|데님|blue/, "블루/데님"],
    [/카키|khaki|olive|올리브/, "카키/올리브"],
    [/베이지|beige|sand|샌드/, "베이지"],
    [/브라운|brown|mocha|모카/, "브라운"],
    [/레드|빨강|red|burgundy|버건디/, "레드/버건디"],
    [/핑크|pink/, "핑크"],
    [/그린|초록|green/, "그린"],
  ];
  const brandRules = [
    [/무신사|musinsa|무탠다드|musinsa standard/, "Musinsa"],
    [/zara|자라/, "ZARA"],
    [/29cm/, "29CM"],
    [/uniqlo|유니클로/, "UNIQLO"],
    [/nike|나이키/, "Nike"],
    [/adidas|아디다스/, "Adidas"],
  ];

  return {
    category: matchRule(lower, rules) || "기타",
    color: matchRule(lower, colorRules) || "",
    brand: matchRule(lower, brandRules) || "",
    style: /슬랙스|셔츠|블레이저|로퍼|coat|shirt|slacks|loafer/.test(lower)
      ? "포멀/미니멀"
      : /후드|맨투맨|데님|스니커즈|hoodie|sneakers|denim/.test(lower)
        ? "캐주얼"
        : "",
    season: /반팔|쇼츠|반바지|샌들|shorts|sandal/.test(lower)
      ? "여름"
      : /패딩|코트|니트|머플러|padding|coat|knit|scarf/.test(lower)
        ? "겨울"
        : "사계절",
  };
}

function matchRule(text, rules) {
  const match = rules.find(([regex]) => regex.test(text));
  return match?.[1] || "";
}

function detectImageLikeRegions(img) {
  const maxSide = 700;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const localCtx = canvas.getContext("2d", { willReadFrequently: true });
  localCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data, width, height } = localCtx.getImageData(0, 0, canvas.width, canvas.height);
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max - min;
      const isDarkText = max < 80 && saturation < 35;
      const isLightBackground = r > 236 && g > 236 && b > 236;
      const hasImageSignal = !isLightBackground && !isDarkText && (saturation > 14 || max < 215);
      if (hasImageSignal) mask[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(width * height);
  const boxes = [];
  const stack = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      visited[start] = 1;
      stack.push(start);
      while (stack.length) {
        const current = stack.pop();
        const cx = current % width;
        const cy = Math.floor(current / width);
        count += 1;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        const neighbors = [current - 1, current + 1, current - width, current + width];
        neighbors.forEach((next) => {
          if (next < 0 || next >= mask.length || visited[next] || !mask[next]) return;
          const nx = next % width;
          if (Math.abs(nx - cx) > 1) return;
          visited[next] = 1;
          stack.push(next);
        });
      }

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const ratio = boxW / boxH;
      const area = boxW * boxH;
      const fill = count / area;
      if (boxW >= 36 && boxH >= 36 && area >= 1800 && ratio > 0.35 && ratio < 2.8 && fill > 0.08) {
        boxes.push({ x: minX, y: minY, w: boxW, h: boxH, area });
      }
    }
  }

  const merged = mergeBoxes(boxes, width, height)
    .filter((box) => box.w >= 42 && box.h >= 42)
    .sort((a, b) => b.area - a.area)
    .slice(0, 16)
    .map((box) => {
      const pad = 8;
      const source = {
        x: Math.max(0, Math.round((box.x - pad) / scale)),
        y: Math.max(0, Math.round((box.y - pad) / scale)),
        w: Math.min(img.naturalWidth, Math.round((box.w + pad * 2) / scale)),
        h: Math.min(img.naturalHeight, Math.round((box.h + pad * 2) / scale)),
      };
      return { ...source, image: cropToDataUrl(img, source) };
    });

  return merged;
}

function mergeBoxes(boxes, width, height) {
  const sorted = boxes.sort((a, b) => b.area - a.area);
  const result = [];
  sorted.forEach((box) => {
    const expanded = {
      x: Math.max(0, box.x - 18),
      y: Math.max(0, box.y - 18),
      w: Math.min(width, box.w + 36),
      h: Math.min(height, box.h + 36),
      area: box.area,
    };
    const hit = result.find((target) => intersectionOverUnion(expanded, target) > 0.22 || contains(target, expanded));
    if (hit) {
      const x1 = Math.min(hit.x, expanded.x);
      const y1 = Math.min(hit.y, expanded.y);
      const x2 = Math.max(hit.x + hit.w, expanded.x + expanded.w);
      const y2 = Math.max(hit.y + hit.h, expanded.y + expanded.h);
      Object.assign(hit, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, area: (x2 - x1) * (y2 - y1) });
    } else {
      result.push(expanded);
    }
  });
  return result;
}

function intersectionOverUnion(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union ? intersection / union : 0;
}

function contains(a, b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

function cropOriginalImage(selection) {
  const scale = state.canvasScale;
  const source = {
    x: Math.round(selection.x / scale),
    y: Math.round(selection.y / scale),
    w: Math.round(selection.w / scale),
    h: Math.round(selection.h / scale),
  };
  return cropToDataUrl(state.orderImage, source);
}

function cropToDataUrl(img, source) {
  const canvas = document.createElement("canvas");
  const size = 520;
  const ratio = Math.min(size / source.w, size / source.h, 1.5);
  canvas.width = Math.max(1, Math.round(source.w * ratio));
  canvas.height = Math.max(1, Math.round(source.h * ratio));
  const localCtx = canvas.getContext("2d");
  localCtx.fillStyle = "#ffffff";
  localCtx.fillRect(0, 0, canvas.width, canvas.height);
  localCtx.drawImage(img, source.x, source.y, source.w, source.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

function cleanupOcrText(text) {
  return text
    .split(/\n+/)
    .map((line) => cleanName(line.replace(/[|{}[\]<>]/g, " ")))
    .filter((line) => line.length >= 2)
    .join("\n");
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function categoryOptions(selected) {
  return categories
    .map((category) => `<option value="${category}" ${category === selected ? "selected" : ""}>${category}</option>`)
    .join("");
}

function seasonOptions(selected) {
  return ["사계절", "봄/가을", "여름", "겨울"]
    .map((season) => `<option value="${season}" ${season === selected ? "selected" : ""}>${season}</option>`)
    .join("");
}

function loadWardrobe() {
  try {
    return JSON.parse(localStorage.getItem("closet-intake-wardrobe") || "[]");
  } catch {
    return [];
  }
}

function saveWardrobe() {
  localStorage.setItem("closet-intake-wardrobe", JSON.stringify(state.wardrobe));
}

function exportWardrobe() {
  const blob = new Blob([JSON.stringify(state.wardrobe, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `wardrobe-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importWardrobe(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error("Invalid wardrobe data");
    state.wardrobe = imported.map(normalizeItem);
    saveWardrobe();
    renderWardrobe();
    toast("JSON 옷장을 가져왔어요.");
  } catch {
    toast("가져올 수 없는 JSON 파일이에요.");
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function imageFileToCompressedDataUrl(file) {
  const img = await readImage(file);
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const localCtx = canvas.getContext("2d");
  localCtx.fillStyle = "#ffffff";
  localCtx.fillRect(0, 0, canvas.width, canvas.height);
  localCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.86);
}

async function readImage(file) {
  const dataUrl = await fileToDataUrl(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function toast(message) {
  const previous = document.querySelector(".toast");
  previous?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 3200);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
