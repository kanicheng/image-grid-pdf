/* =========================================================================
 * 圖片整理排版工具 — 純前端，產出單一 A4 PDF
 * 設計重點：
 *  - 排版幾何（mm）由 computeLayout() 單一來源計算，預覽與 PDF 共用 → 兩者一致
 *  - 標題/日期/標籤用 canvas 畫成圖片再放進 PDF → 完整支援中文，免嵌字型
 *  - 圖片於「產出時」才逐張解碼、畫到 canvas、立即釋放 → 數十張大圖也不爆記憶體
 *  - EXIF 方向用 createImageBitmap({imageOrientation:'from-image'}) 自動校正
 * ========================================================================= */
(function () {
  "use strict";

  const FONT_STACK = '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif';

  // 字級（mm）與間距（mm）— 預覽與 PDF 共用
  const TITLE_MM = 8;
  const SUB_MM = 4.5;
  const DATE_MM = 4.8;
  const CAPTION_MM = 3.2;
  const TITLE_GAP_MM = 5;   // 標題區與圖片格之間（預設值，可由使用者調整）
  const DATE_GAP_MM = 4;    // 圖片格與日期之間
  const CAPTION_GAP_MM = 1; // 圖片與其標籤之間

  const PREVIEW_PAGE_CAP = 24; // 預覽最多顯示頁數（PDF 不受限）
  const STORAGE_KEY = "image-grid-pdf:v1"; // localStorage 鍵，用於設定持久化

  function defaultSettings() {
    return {
      title: "",
      subtitle: "",
      date: "",
      orientation: "portrait",
      cols: 2,
      rows: 3,
      fit: "cover",         // cover | contain
      showCaptions: false,
      captionType: "filename", // filename | number
      margin: 12,
      gap: 6,
      titleGap: TITLE_GAP_MM, // 標題與圖片之間的留白（mm）
      dpi: 150,
      cellBorder: false,
    };
  }

  function todayStr() {
    const t = new Date();
    return `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, "0")}/${String(t.getDate()).padStart(2, "0")}`;
  }

  // ---- 狀態 ----
  const state = {
    images: [],            // { id, name, file, url }
    settings: defaultSettings(),
    zoom: 1,
  };

  const imgPool = new Map(); // id -> <img>（預覽用，建立一次重複使用，避免重載閃爍）
  let nextId = 1;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("title"), subtitle: $("subtitle"),
    datePicker: $("datePicker"),
    cols: $("cols"), rows: $("rows"),
    perPageHint: $("perPageHint"),
    showCaptions: $("showCaptions"), captionTypeField: $("captionTypeField"),
    margin: $("margin"), gap: $("gap"), titleGap: $("titleGap"),
    quality: $("quality"), qualityLabel: $("qualityLabel"),
    cellBorder: $("cellBorder"), resetBtn: $("resetSettings"),
    dropzone: $("dropzone"), fileInput: $("fileInput"),
    thumbs: $("thumbs"), imgCount: $("imgCount"), clearAll: $("clearAll"),
    pages: $("pages"), previewEmpty: $("previewEmpty"), previewScroll: $("previewScroll"),
    pageCount: $("pageCount"), sheetInfo: $("sheetInfo"),
    zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), zoomLabel: $("zoomLabel"),
    generate: $("generate"), generateLabel: $("generateLabel"),
    status: $("status"),
    overlay: $("overlay"), overlayText: $("overlayText"), progressBar: $("progressBar"),
  };

  // 量測用 canvas（用 Noto Sans TC 量字寬，確保預覽/PDF 一致）
  const measCtx = document.createElement("canvas").getContext("2d");

  /* ===================== 幾何計算（mm，單一來源） ===================== */
  function pageSizeMm(orientation) {
    return orientation === "landscape"
      ? { w: 297, h: 210 }
      : { w: 210, h: 297 };
  }

  // 量測文字在指定字級（mm）下的寬度（mm）；若超過 maxWmm 則回傳縮小後的字級
  function fitFontMm(text, fontMm, maxWmm, weight) {
    if (!text) return fontMm;
    const probe = 100;
    measCtx.font = `${weight} ${probe}px ${FONT_STACK}`;
    const wPerEm = measCtx.measureText(text).width / probe; // 每 1px 字級的寬度
    const textWmm = fontMm * wPerEm;
    if (textWmm <= maxWmm || maxWmm <= 0) return fontMm;
    return fontMm * (maxWmm / textWmm);
  }

  function computeLayout(s) {
    const page = pageSizeMm(s.orientation);
    const m = s.margin;
    const innerW = page.w - 2 * m;

    const title = s.title.trim();
    const subtitle = s.subtitle.trim();
    const date = s.date.trim();

    const titleFit = fitFontMm(title, TITLE_MM, innerW, 900);
    const subFit = fitFontMm(subtitle, SUB_MM, innerW, 700);
    const dateFit = fitFontMm(date, DATE_MM, innerW, 700);

    const titleHmm = title ? titleFit * 1.3 : 0;
    const subHmm = subtitle ? subFit * 1.4 : 0;
    const headHmm = titleHmm + subHmm;
    const titleBlockH = headHmm > 0 ? headHmm + s.titleGap : 0;

    const dateHmm = date ? dateFit * 1.3 : 0;
    const dateBlockH = dateHmm > 0 ? dateHmm + DATE_GAP_MM : 0;

    const gridX = m;
    const gridY = m + titleBlockH;
    const gridW = innerW;
    const gridH = page.h - m - titleBlockH - dateBlockH - m;

    const cols = Math.max(1, s.cols);
    const rows = Math.max(1, s.rows);
    const cellW = Math.max(0, (gridW - (cols - 1) * s.gap) / cols);
    const cellH = Math.max(0, (gridH - (rows - 1) * s.gap) / rows);

    const captionH = s.showCaptions ? CAPTION_MM * 1.3 : 0;
    const imgH = cellH - (s.showCaptions ? captionH + CAPTION_GAP_MM : 0);

    return {
      page, m, innerW,
      title, subtitle, date,
      titleFit, subFit, dateFit,
      titleHmm, subHmm, dateHmm, titleBlockH, dateBlockH,
      gridX, gridY, gridW, gridH,
      cols, rows, perPage: cols * rows,
      cellW, cellH, imgH, captionH,
      valid: cellW > 1 && imgH > 1,
    };
  }

  function captionFor(img, index) {
    if (state.settings.captionType === "number") return String(index + 1);
    return img.name.replace(/\.[^.]+$/, "");
  }

  /* ===================== 預覽（HTML，鏡像 PDF 幾何） ===================== */
  function render() {
    persistSettings(); // 任何設定/縮放變更都會走到 render，藉此持久化（已防抖）
    const s = state.settings;
    const L = computeLayout(s);
    const pp = 2.6 * state.zoom; // px per mm

    const total = state.images.length;
    const pageCount = total > 0 ? Math.ceil(total / L.perPage) : 0;

    el.previewEmpty.style.display = total === 0 ? "" : "none";
    el.pageCount.textContent = `${pageCount} 頁`;
    el.sheetInfo.textContent = `A4 ${s.orientation === "landscape" ? "橫式" : "直式"}`;
    el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    el.perPageHint.textContent = `每頁 ${L.perPage} 張，超過會自動分頁。`;
    el.generate.disabled = total === 0;

    el.pages.innerHTML = "";
    if (total === 0 || !L.valid) {
      if (total > 0 && !L.valid) {
        setStatus("版面太小，容不下圖片格，請減少欄/列數或縮小邊界、間距。", "error");
      } else {
        setStatus("");
      }
      return;
    }
    setStatus("");

    const shownPages = Math.min(pageCount, PREVIEW_PAGE_CAP);
    for (let p = 0; p < shownPages; p++) {
      el.pages.appendChild(buildPagePreview(L, pp, p));
    }
    if (pageCount > PREVIEW_PAGE_CAP) {
      const note = document.createElement("p");
      note.className = "muted";
      note.style.cssText = "font-size:13px;text-align:center;padding:8px;";
      note.textContent = `預覽僅顯示前 ${PREVIEW_PAGE_CAP} 頁，產出的 PDF 會包含全部 ${pageCount} 頁。`;
      el.pages.appendChild(note);
    }
  }

  function buildPagePreview(L, pp, pageIndex) {
    const s = state.settings;
    const mm = (v) => `${v * pp}px`;

    const page = document.createElement("div");
    page.className = "page";
    page.style.width = mm(L.page.w);
    page.style.height = mm(L.page.h);

    // 標題（左上）
    if (L.title) {
      const t = document.createElement("div");
      t.className = "page__title";
      t.textContent = L.title;
      t.style.left = mm(L.m);
      t.style.top = mm(L.m);
      t.style.fontSize = mm(L.titleFit);
      t.style.maxWidth = mm(L.innerW);
      t.style.whiteSpace = "nowrap";
      page.appendChild(t);

      if (L.subtitle) {
        const st = document.createElement("div");
        st.className = "page__title page__subtitle";
        st.textContent = L.subtitle;
        st.style.left = mm(L.m);
        st.style.top = mm(L.m + L.titleHmm);
        st.style.fontSize = mm(L.subFit);
        st.style.maxWidth = mm(L.innerW);
        st.style.whiteSpace = "nowrap";
        page.appendChild(st);
      }
    }

    // 日期（右下）
    if (L.date) {
      const d = document.createElement("div");
      d.className = "page__date";
      d.textContent = L.date;
      d.style.right = mm(L.m);
      d.style.bottom = mm(L.m);
      d.style.fontSize = mm(L.dateFit);
      d.style.maxWidth = mm(L.innerW);
      d.style.whiteSpace = "nowrap";
      page.appendChild(d);
    }

    // 圖片格
    const grid = document.createElement("div");
    grid.className = "page__grid";
    grid.style.left = mm(L.gridX);
    grid.style.top = mm(L.gridY);
    grid.style.width = mm(L.gridW);
    grid.style.height = mm(L.gridH);
    grid.style.gridTemplateColumns = `repeat(${L.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${L.rows}, 1fr)`;
    grid.style.gap = mm(s.gap);

    const start = pageIndex * L.perPage;
    for (let i = 0; i < L.perPage; i++) {
      const idx = start + i;
      const img = state.images[idx];
      const cell = document.createElement("div");
      cell.className = "cell cell--" + s.fit + (s.cellBorder ? " cell--border" : "");
      if (!img) { cell.classList.add("cell--empty"); grid.appendChild(cell); continue; }

      const imgBox = document.createElement("div");
      imgBox.className = "cell__img";
      const im = getPoolImg(img);
      imgBox.appendChild(im);
      cell.appendChild(imgBox);

      if (s.showCaptions) {
        const cap = document.createElement("div");
        cap.className = "cell__caption";
        cap.style.fontSize = mm(CAPTION_MM);
        cap.style.height = mm(L.captionH);
        cap.style.lineHeight = mm(L.captionH);
        cap.textContent = captionFor(img, idx);
        cell.appendChild(cap);
      }
      grid.appendChild(cell);
    }
    page.appendChild(grid);
    return page;
  }

  function getPoolImg(img) {
    let im = imgPool.get(img.id);
    if (!im) {
      im = document.createElement("img");
      im.src = img.url;
      im.alt = img.name;
      imgPool.set(img.id, im);
    }
    return im;
  }

  let rafId = 0;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  /* ===================== 縮圖清單 + 排序 ===================== */
  function renderThumbs() {
    el.imgCount.textContent = String(state.images.length);
    el.clearAll.disabled = state.images.length === 0;
    el.thumbs.innerHTML = "";
    state.images.forEach((img, i) => {
      const li = document.createElement("li");
      li.className = "thumb";
      li.dataset.id = img.id;

      const im = document.createElement("img");
      im.src = img.url;
      im.alt = img.name;
      im.onerror = () => { li.classList.add("is-broken"); img.broken = true; setStatus(`「${img.name}」無法在此瀏覽器顯示／解碼（例如 HEIC）。`, "error"); };
      li.appendChild(im);

      const idx = document.createElement("span");
      idx.className = "thumb__idx";
      idx.textContent = String(i + 1);
      li.appendChild(idx);

      const del = document.createElement("button");
      del.className = "thumb__del";
      del.type = "button";
      del.setAttribute("aria-label", "移除此圖");
      del.textContent = "×";
      del.addEventListener("click", (e) => { e.stopPropagation(); removeImage(img.id); });
      li.appendChild(del);

      el.thumbs.appendChild(li);
    });
  }

  function cancelDrag() {
    if (drag) { if (drag.li) drag.li.classList.remove("is-dragging"); drag = null; }
  }

  function freePoolImg(id) {
    const im = imgPool.get(id);
    if (im) { im.src = ""; imgPool.delete(id); } // 清空 src 釋放已解碼的點陣圖
  }

  function removeImage(id) {
    cancelDrag(); // 拖曳進行中刪除會破壞排序，先取消
    const idx = state.images.findIndex((x) => x.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(state.images[idx].url);
    freePoolImg(id);
    state.images.splice(idx, 1);
    renderThumbs();
    render();
  }

  function clearAll() {
    cancelDrag();
    state.images.forEach((x) => { URL.revokeObjectURL(x.url); freePoolImg(x.id); });
    state.images = [];
    imgPool.clear();
    renderThumbs();
    render();
  }

  // 指標式拖曳排序（滑鼠 + 觸控通用）
  let drag = null;
  function onThumbPointerDown(e) {
    const li = e.target.closest(".thumb");
    if (!li || e.target.closest(".thumb__del")) return;
    if (e.button !== undefined && e.button !== 0) return;
    drag = { id: li.dataset.id, li, moved: false };
    li.setPointerCapture(e.pointerId);
    li.classList.add("is-dragging");
  }
  function onThumbPointerMove(e) {
    if (!drag) return;
    drag.moved = true;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const overLi = target && target.closest && target.closest(".thumb");
    if (!overLi || overLi === drag.li || !el.thumbs.contains(overLi) || !el.thumbs.contains(drag.li)) return;
    const items = [...el.thumbs.children];
    const dragIdx = items.indexOf(drag.li);
    const overIdx = items.indexOf(overLi);
    if (dragIdx < 0 || overIdx < 0) return; // 清單已重建（例如刪除）→ 放棄此次移動
    if (dragIdx < overIdx) el.thumbs.insertBefore(drag.li, overLi.nextSibling);
    else el.thumbs.insertBefore(drag.li, overLi);
  }
  function onThumbPointerUp() {
    if (!drag) return;
    drag.li.classList.remove("is-dragging");
    if (drag.moved && el.thumbs.contains(drag.li)) {
      // dataset.id 為字串，state.images 的 id 為數字 → 用字串比較才會對應
      const order = [...el.thumbs.children].map((c) => c.dataset.id);
      state.images.sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
      renderThumbs();
      render();
    }
    drag = null;
  }

  /* ===================== 上傳 ===================== */
  function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name));
    if (files.length === 0) {
      setStatus("沒有可用的圖片檔。", "error");
      return;
    }
    for (const f of files) {
      state.images.push({ id: nextId++, name: f.name, file: f, url: URL.createObjectURL(f) });
    }
    renderThumbs();
    render();
    setStatus(`已加入 ${files.length} 張，共 ${state.images.length} 張。`, "ok");
  }

  /* ===================== PDF 產出 ===================== */
  let isGenerating = false;
  async function generatePdf() {
    if (isGenerating || state.images.length === 0) return; // 防止重複點擊造成重複輸出
    const s = state.settings;
    const L = computeLayout(s);
    if (!L.valid) { setStatus("版面太小，無法產出，請調整欄列數或邊界。", "error"); return; }

    isGenerating = true;
    el.generate.disabled = true;
    showOverlay(true, "準備中…", 0);
    const failed = [];
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: s.orientation, unit: "mm", format: "a4" });
      const pxPerMm = s.dpi / 25.4;
      const total = state.images.length;
      const pageCount = Math.ceil(total / L.perPage);

      // 預先把標題/副標/日期畫成圖（每頁相同，畫一次重複用）
      const titleImg = L.title ? renderTextImage(L.title, L.titleFit, 900, "#111111") : null;
      const subImg = L.subtitle ? renderTextImage(L.subtitle, L.subFit, 700, "#333333") : null;
      const dateImg = L.date ? renderTextImage(L.date, L.dateFit, 700, "#111111") : null;

      const work = document.createElement("canvas");
      const wctx = work.getContext("2d");

      for (let p = 0; p < pageCount; p++) {
        if (p > 0) doc.addPage();

        // 標題（左上）
        if (titleImg) doc.addImage(titleImg.dataUrl, "PNG", L.m, L.m, titleImg.wMm, titleImg.hMm);
        if (subImg) doc.addImage(subImg.dataUrl, "PNG", L.m, L.m + L.titleHmm, subImg.wMm, subImg.hMm);
        // 日期（右下）
        if (dateImg) doc.addImage(dateImg.dataUrl, "PNG", L.page.w - L.m - dateImg.wMm, L.page.h - L.m - dateImg.hMm, dateImg.wMm, dateImg.hMm);

        const start = p * L.perPage;
        for (let i = 0; i < L.perPage; i++) {
          const idx = start + i;
          if (idx >= total) break;
          const img = state.images[idx];

          const col = i % L.cols;
          const row = Math.floor(i / L.cols);
          const cellX = L.gridX + col * (L.cellW + s.gap);
          const cellY = L.gridY + row * (L.cellH + s.gap);

          showOverlay(true, `處理第 ${idx + 1} / ${total} 張…`, (idx) / total * 100);

          try {
            await drawImageIntoCell(doc, img, wctx, work, pxPerMm, {
              x: cellX, y: cellY, w: L.cellW, h: L.imgH, fit: s.fit, border: s.cellBorder,
            });
          } catch (err) {
            failed.push(img.name);
            // 失敗格畫一個淺色佔位 + 檔名，明確顯示而非靜默略過
            doc.setDrawColor(210); doc.setFillColor(245, 245, 245);
            doc.rect(cellX, cellY, L.cellW, L.imgH, "FD");
          }

          if (s.showCaptions) {
            const cap = renderTextImage(captionFor(img, idx), CAPTION_MM, 400, "#444444");
            const capW = Math.min(cap.wMm, L.cellW);
            const capX = cellX + (L.cellW - capW) / 2;
            const capY = cellY + L.imgH + CAPTION_GAP_MM;
            doc.addImage(cap.dataUrl, "PNG", capX, capY, capW, cap.hMm);
          }
        }
      }

      showOverlay(true, "輸出檔案…", 100);
      const fname = buildFileName(L);
      doc.save(fname);

      if (failed.length) {
        setStatus(`已產出 ${fname}，但有 ${failed.length} 張無法解碼（${failed.slice(0, 3).join("、")}${failed.length > 3 ? "…" : ""}）。`, "error");
      } else {
        setStatus(`已產出 ${fname}（${pageCount} 頁 / ${total} 張）。`, "ok");
      }
    } catch (err) {
      console.error(err);
      setStatus("產出失敗：" + (err && err.message ? err.message : String(err)), "error");
    } finally {
      showOverlay(false);
      isGenerating = false;
      el.generate.disabled = state.images.length === 0;
    }
  }

  // 解碼 → 依 cover/contain 畫到 canvas → addImage；畫完立即釋放 bitmap
  async function drawImageIntoCell(doc, img, wctx, work, pxPerMm, opt) {
    const bmp = await decode(img.file);
    try {
      // ImageBitmap 只有 width/height；HTMLImageElement 用 naturalWidth/Height 取得原始尺寸
      const sw = (bmp instanceof HTMLImageElement) ? bmp.naturalWidth : bmp.width;
      const sh = (bmp instanceof HTMLImageElement) ? bmp.naturalHeight : bmp.height;
      if (!sw || !sh) throw new Error("empty image");
      if (opt.fit === "cover") {
        const tw = Math.max(1, Math.round(opt.w * pxPerMm));
        const th = Math.max(1, Math.round(opt.h * pxPerMm));
        work.width = tw; work.height = th;
        wctx.clearRect(0, 0, tw, th);
        // 置中裁切
        const sa = sw / sh, ta = opt.w / opt.h;
        let sx, sy, scw, sch;
        if (sa > ta) { sch = sh; scw = sh * ta; sx = (sw - scw) / 2; sy = 0; }
        else { scw = sw; sch = sw / ta; sx = 0; sy = (sh - sch) / 2; }
        wctx.drawImage(bmp, sx, sy, scw, sch, 0, 0, tw, th);
        if (opt.border) { wctx.strokeStyle = "#d0d3d8"; wctx.lineWidth = 1; wctx.strokeRect(0.5, 0.5, tw - 1, th - 1); }
        doc.addImage(work.toDataURL("image/jpeg", 0.9), "JPEG", opt.x, opt.y, opt.w, opt.h, undefined, "FAST");
      } else {
        // contain：整張置中，依長邊縮放
        const sa = sw / sh, ta = opt.w / opt.h;
        let dwMm, dhMm;
        if (sa > ta) { dwMm = opt.w; dhMm = opt.w / sa; }
        else { dhMm = opt.h; dwMm = opt.h * sa; }
        const dx = opt.x + (opt.w - dwMm) / 2;
        const dy = opt.y + (opt.h - dhMm) / 2;
        const tw = Math.max(1, Math.round(dwMm * pxPerMm));
        const th = Math.max(1, Math.round(dhMm * pxPerMm));
        work.width = tw; work.height = th;
        wctx.clearRect(0, 0, tw, th);
        wctx.drawImage(bmp, 0, 0, tw, th);
        doc.addImage(work.toDataURL("image/jpeg", 0.92), "JPEG", dx, dy, dwMm, dhMm, undefined, "FAST");
        if (opt.border) { doc.setDrawColor(208, 211, 216); doc.rect(dx, dy, dwMm, dhMm); }
      }
    } finally {
      if (bmp.close) bmp.close();
      if (bmp._url) URL.revokeObjectURL(bmp._url);
    }
  }

  function decode(file) {
    // 自動套用 EXIF 方向
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch((err) => {
        console.warn("createImageBitmap 失敗，改用 <img> 解碼：", file.name, err);
        return decodeViaImg(file);
      });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im._url = url; // 供呼叫端用後釋放
      im.onload = () => resolve(im);
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      im.src = url;
    });
  }

  // 把文字畫成 PNG（透明背景），回傳 dataUrl 與其 mm 尺寸
  // 加上快取：相同文字（如重複的編號標籤、每頁的標題/日期）只算一次，避免大量圖片時記憶體線性成長
  const textImgCache = new Map();
  function renderTextImage(text, fontMm, weight, color) {
    const key = `${text}|${fontMm}|${weight}|${color}`;
    const hit = textImgCache.get(key);
    if (hit) return hit;
    const out = renderTextImageRaw(text, fontMm, weight, color);
    if (textImgCache.size < 600) textImgCache.set(key, out);
    return out;
  }
  function renderTextImageRaw(text, fontMm, weight, color) {
    const dpi = 300; // 文字固定高 DPI，確保清晰
    const pxPerMm = dpi / 25.4;
    const fontPx = fontMm * pxPerMm;
    measCtx.font = `${weight} ${fontPx}px ${FONT_STACK}`;
    const w = Math.max(1, Math.ceil(measCtx.measureText(text).width + fontPx * 0.12));
    const h = Math.ceil(fontPx * 1.3);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d");
    cx.font = `${weight} ${fontPx}px ${FONT_STACK}`;
    cx.fillStyle = color;
    cx.textBaseline = "middle";
    cx.textAlign = "left";
    cx.fillText(text, fontPx * 0.06, h / 2);
    return { dataUrl: c.toDataURL("image/png"), wMm: w / pxPerMm, hMm: h / pxPerMm };
  }

  function buildFileName(L) {
    const base = (L.title || "圖片排版").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    const d = (L.date || "").trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 20);
    return (d ? `${base}_${d}` : base) + ".pdf";
  }

  /* ===================== UI 輔助 ===================== */
  function setStatus(msg, kind) {
    el.status.textContent = msg || "";
    el.status.className = "actionbar__status" + (kind === "error" ? " is-error" : kind === "ok" ? " is-ok" : "");
  }
  function showOverlay(show, text, pct) {
    el.overlay.classList.toggle("is-hidden", !show);
    if (show) {
      if (text != null) el.overlayText.textContent = text;
      if (pct != null) el.progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
  }
  function qualityWord(dpi) {
    if (dpi <= 110) return "省空間";
    if (dpi <= 170) return "標準";
    if (dpi <= 230) return "高清";
    return "最高";
  }

  /* ===================== 設定綁定 ===================== */
  function selectSegment(btn) {
    const setting = btn.dataset.setting;
    const value = btn.dataset.value;
    [...btn.parentNode.children].forEach((b) => {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1; // roving tabindex：群組只留一個 Tab 停留點
    });
    state.settings[setting] = value;
    if (setting === "orientation" || setting === "fit") render();
    else scheduleRender();
  }
  function bindSegmented(container) {
    container.setAttribute("role", container.getAttribute("role") || "radiogroup");
    [...container.children].forEach((b) => {
      if (!b.classList.contains("segmented__btn")) return;
      b.setAttribute("role", "radio");
      const on = b.classList.contains("is-active");
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    container.addEventListener("click", (e) => {
      const btn = e.target.closest(".segmented__btn");
      if (btn) selectSegment(btn);
    });
    container.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const btns = [...container.querySelectorAll(".segmented__btn")];
      const cur = btns.indexOf(document.activeElement);
      if (cur === -1) return;
      e.preventDefault();
      const dir = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1;
      const next = btns[(cur + dir + btns.length) % btns.length];
      next.focus();
      selectSegment(next);
    });
  }

  /* ===================== 設定持久化（localStorage） ===================== */
  // 這些屬於「每次重來」的內容，不持久化：日期、標題、副標題
  const NON_PERSISTED = ["date", "title", "subtitle"];
  let persistTimer = 0;
  function persistSettings() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const persistable = {};
        for (const k of Object.keys(state.settings)) {
          if (!NON_PERSISTED.includes(k)) persistable[k] = state.settings[k];
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: persistable, zoom: state.zoom }));
      } catch (e) {
        console.warn("無法儲存設定（localStorage 不可用）：", e);
      }
    }, 300);
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.settings && typeof data.settings === "object") {
        for (const k of Object.keys(state.settings)) {
          if (NON_PERSISTED.includes(k)) continue; // 日期/標題/副標題不還原
          const v = data.settings[k];
          // 只接受型別相符的值，忽略損壞或舊版殘留資料
          if (v !== undefined && v !== null && typeof v === typeof state.settings[k]) {
            state.settings[k] = v;
          }
        }
      }
      if (typeof data.zoom === "number" && isFinite(data.zoom)) {
        state.zoom = Math.max(0.5, Math.min(1.5, data.zoom));
      }
    } catch (e) {
      console.warn("無法讀取已儲存的設定：", e);
    }
  }

  // 把目前 state.settings 同步到所有控制項（程式化設值不會觸發事件，故不會造成迴圈）
  function syncSegment(setting, value) {
    document.querySelectorAll(`.segmented__btn[data-setting="${setting}"]`).forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
  }
  function syncControlsFromState() {
    const s = state.settings;
    el.title.value = s.title;
    el.subtitle.value = s.subtitle;
    el.datePicker.value = /^\d{4}\/\d{2}\/\d{2}$/.test(s.date) ? s.date.replace(/\//g, "-") : "";
    el.cols.value = s.cols;
    el.rows.value = s.rows;
    el.margin.value = s.margin;
    el.gap.value = s.gap;
    el.titleGap.value = s.titleGap;
    el.quality.value = s.dpi;
    el.qualityLabel.textContent = qualityWord(s.dpi);
    el.showCaptions.checked = s.showCaptions;
    el.captionTypeField.classList.toggle("is-hidden", !s.showCaptions);
    el.cellBorder.checked = s.cellBorder;
    syncSegment("orientation", s.orientation);
    syncSegment("fit", s.fit);
    syncSegment("captionType", s.captionType);
  }

  function resetSettings() {
    if (!confirm("確定要把所有設定重設為預設值嗎？（已上傳的圖片不會受影響）")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    state.settings = defaultSettings();
    state.settings.date = todayStr();
    state.zoom = 1;
    syncControlsFromState();
    render();
    setStatus("已重設為預設值。", "ok");
  }

  function init() {
    // 預設日期 = 今天（日期不持久化），再還原其他已儲存設定
    state.settings.date = todayStr();
    loadSettings();

    // 文字欄位
    el.title.addEventListener("input", () => { state.settings.title = el.title.value; scheduleRender(); });
    el.subtitle.addEventListener("input", () => { state.settings.subtitle = el.subtitle.value; scheduleRender(); });
    // 日期：只用日曆選擇，值統一輸出為 YYYY/MM/DD；留空則不顯示日期
    el.datePicker.addEventListener("change", () => {
      if (el.datePicker.value) {
        const [yy, mm, dd] = el.datePicker.value.split("-");
        state.settings.date = `${yy}/${mm}/${dd}`;
      } else {
        state.settings.date = "";
      }
      scheduleRender();
    });

    // 數字欄位
    const clampNum = (input, min, max) => {
      let v = parseInt(input.value, 10);
      if (isNaN(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      input.value = String(v);
      return v;
    };
    el.cols.addEventListener("input", () => { state.settings.cols = clampNum(el.cols, 1, 6); render(); });
    el.rows.addEventListener("input", () => { state.settings.rows = clampNum(el.rows, 1, 8); render(); });
    el.margin.addEventListener("input", () => { state.settings.margin = clampNum(el.margin, 0, 40); render(); });
    el.gap.addEventListener("input", () => { state.settings.gap = clampNum(el.gap, 0, 30); render(); });
    el.titleGap.addEventListener("input", () => { state.settings.titleGap = clampNum(el.titleGap, 0, 60); render(); });
    el.quality.addEventListener("input", () => {
      state.settings.dpi = parseInt(el.quality.value, 10);
      el.qualityLabel.textContent = qualityWord(state.settings.dpi);
    });

    // 開關
    el.showCaptions.addEventListener("change", () => {
      state.settings.showCaptions = el.showCaptions.checked;
      el.captionTypeField.classList.toggle("is-hidden", !el.showCaptions.checked);
      render();
    });
    el.cellBorder.addEventListener("change", () => { state.settings.cellBorder = el.cellBorder.checked; render(); });

    // 分段控制
    document.querySelectorAll(".segmented").forEach(bindSegmented);

    // 上傳
    el.dropzone.addEventListener("click", () => el.fileInput.click());
    el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
    el.fileInput.addEventListener("change", () => { if (el.fileInput.files.length) addFiles(el.fileInput.files); el.fileInput.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("is-drag"); }));
    ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("is-drag"); }));
    el.dropzone.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    // 整頁也可拖放
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => { if (e.target.closest && e.target.closest("#dropzone")) return; e.preventDefault(); });
    // 拖曳中斷（離開視窗、Esc 取消、放開於別處）時，確保高亮狀態被清除
    const clearDragState = () => el.dropzone.classList.remove("is-drag");
    document.addEventListener("dragend", clearDragState, true);
    document.addEventListener("drop", clearDragState, true);
    window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) clearDragState(); });

    el.clearAll.addEventListener("click", clearAll);

    // 縮圖排序
    el.thumbs.addEventListener("pointerdown", onThumbPointerDown);
    el.thumbs.addEventListener("pointermove", onThumbPointerMove);
    el.thumbs.addEventListener("pointerup", onThumbPointerUp);
    el.thumbs.addEventListener("pointercancel", onThumbPointerUp);

    // 縮放
    el.zoomIn.addEventListener("click", () => { state.zoom = Math.min(1.5, state.zoom + 0.1); render(); });
    el.zoomOut.addEventListener("click", () => { state.zoom = Math.max(0.5, state.zoom - 0.1); render(); });

    // 產出
    el.generate.addEventListener("click", generatePdf);

    // 重設設定
    el.resetBtn.addEventListener("click", resetSettings);

    // 把已還原的設定同步到所有控制項（程式化設值不會觸發上面的事件）
    syncControlsFromState();

    // 等字型載入完成再首次渲染（量字寬才準）
    const start = () => render();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(start).catch(start);
    else start();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
