// ==UserScript==
// @name         PriceHawk - Multi-Site Price Checker
// @namespace    http://tampermonkey.net/
// @version      4.7
// @description  BD Intelligence — v4.6: biểu đồ dashboard chọn 7/30/60 ngày (mặc định 30), thiếu data thì vẽ full những gì có. Kèm v4.5: khu đối thủ dạng lưới thẻ tổng quan (auto-fit, tự co, không scroll ngang), hover biểu đồ trượt mềm giữa các ngày. Kèm v4.4: tên sản phẩm thật từ HTML, hover xem giá ở biểu đồ nhỏ, nút ⛶ cạnh nút thu nhỏ. Kèm v4.3: biểu đồ hover crosshair + tooltip FPT/đáy TT, biểu đồ trải rộng. Kèm v4.2: sửa lỗi biểu đồ không mở lại được, bỏ dark mode, UI thu gọn có badge hạng, popup dashboard toàn màn hình. Kèm v4.0: phân tích vị thế, thống kê thị trường, cảnh báo giá, sắp xếp/lọc, xuất báo cáo (Copy BD + CSV), auto-refresh.
// @author       Vũ Văn Thế
// @updateURL    https://price.the.id.vn/pricehawk.user.js
// @downloadURL  https://price.the.id.vn/pricehawk.user.js
// @match        https://fptshop.com.vn/*
// @match        https://www.fptshop.com.vn/*
// @match        http://fptshop.com.vn/*
// @match        https://www.thegioididong.com/*
// @match        https://www.dienmayxanh.com/*
// @match        https://cellphones.com.vn/*
// @match        https://shopdunk.com/*
// @match        https://viettelstore.vn/*
// @match        https://hoanghamobile.com/*
// @match        https://didongviet.vn/*
// @match        https://www.dienmaycholon.com/*
// @match        https://dienmaycholon.vn/*
// @match        https://phongvu.vn/*
// @match        https://www.nguyenkim.com/*
// @match        https://mediamart.vn/*
// @match        https://hc.com.vn/*
// @match        https://dienmaygiakhang.vn/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=fptshop.com.vn
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.onurlchange
// @connect      price.the.id.vn
// @connect      https://price.the.id.vn
// @connect      localhost
// @connect      thevu.cloudflareaccess.com
// @connect      cloudflareaccess.com
// ==/UserScript==

(function() {
    'use strict';

    // ================= CONFIG =================
    const DEBUG = false;
    const SERVER_URL      = "https://price.the.id.vn";
    const API_ENDPOINT    = `${SERVER_URL}/api/get_competitor_price`;
    const API_HISTORY     = `${SERVER_URL}/api/history`;
    const AUTH_URL        = `${SERVER_URL}/auth-check`;
    const API_FORCE_CHECK = `${SERVER_URL}/api/extension/force_check`;
    const API_REPORT      = `${SERVER_URL}/api/report_issue`;
    const API_TREND       = `${SERVER_URL}/api/trend`;

    // Ngưỡng cảnh báo: FPT bị coi là "đắt hơn thị trường" khi cao hơn đối thủ
    // rẻ nhất vượt quá tỉ lệ này (%). BD chỉnh nhanh ở đây nếu cần.
    const ALERT_THRESHOLD_PCT = 1.0;
    const AUTO_REFRESH_MIN    = 5;   // phút — chu kỳ auto-refresh (chỉ đọc cache, không force-check)

    // ================= STATE =================
    let isCollapsed   = false;
    let currentUrl    = window.location.href;
    let loginInterval = null;
    let sortMode      = GM_getValue('ph_sort', 'diff');    // diff | price_asc | price_desc | name
    let filterMode    = GM_getValue('ph_filter', 'all');   // all | cheaper | hcm | hn
    let autoRefreshOn = GM_getValue('ph_autorefresh', false);
    let autoRefreshTimer = null;
    let checkTimer       = null;   // interval của checkPrice (chặn chạy chồng)
    let urlChangeDebounce = null;  // debounce khi URL đổi (tránh nháy lúc SPA hydrate)
    const isFptSite   = window.location.hostname.includes("fptshop.com.vn");

    // ================= HELPERS =================
    function log(...a) { if (DEBUG) console.debug("[PH]", ...a); }
    function safeJson(t, fb=null) { try { return JSON.parse(t); } catch(e) { return fb; } }
    // Nhận diện response bị Cloudflare Access chặn (chưa đăng nhập). Khi đó request
    // bị redirect sang trang login *.cloudflareaccess.com — kiểm tra qua finalUrl
    // (URL sau redirect) hoặc dấu vết trang login CF trong HTML trả về.
    function isCfLogin(r) {
        if (!r) return false;
        const fu = (r.finalUrl || "").toLowerCase();
        if (fu.includes("cloudflareaccess.com") || fu.includes("/cdn-cgi/access/login")) return true;
        const t = r.responseText || "";
        return /cloudflareaccess\.com|cdn-cgi\/access\/login/i.test(t) && !safeJson(t);
    }
    function buildUrl(base, p={}) {
        const parts = Object.entries(p).filter(([,v])=>v!=null).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        return parts.length ? `${base}?${parts.join("&")}` : base;
    }
    function today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    function removeOverlay() { document.getElementById('ph-root')?.remove(); }
    function humanize(amount, dec=2) {
        const v = Math.abs(Math.round(Number(amount)||0));
        const sign = Number(amount)<0?"-":"";
        function strip(s) { return s.replace(/\.0+$|(\.\d*?)0+$/,'$1').replace(/\.$/,''); }
        if (v>=1e9) return sign+strip((v/1e9).toFixed(dec))+" tỷ";
        if (v>=1e6) return sign+strip((v/1e6).toFixed(dec))+" triệu";
        return sign+new Intl.NumberFormat('vi-VN').format(v)+" đ";
    }
    function normHost(url) {
        try { return (new URL(url).hostname||"").replace(/^www\./i,"").toLowerCase(); }
        catch(e) { return (String(url).split('/')[2]||"").replace(/^www\./i,'').split(':')[0].toLowerCase(); }
    }
    // URL "chuẩn hóa" để so sánh có phải đổi SANG SẢN PHẨM KHÁC hay không.
    // SPA (Next.js) sau khi hydrate hay tự replaceState đổi query / thêm bớt dấu "/"
    // cuối path dù vẫn là cùng 1 trang → chỉ so origin+path (bỏ query, hash, "/" cuối)
    // để không coi những thay đổi vô hại đó là "đổi trang" (nguyên nhân nháy trắng).
    function canonUrl(url) {
        try {
            const u = new URL(url);
            return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
        } catch(e) {
            return String(url||"").split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
        }
    }
    function fmtName(raw) {
        if (!raw) return "Đối thủ";
        const u = raw.toUpperCase();
        let b = "";
        if (u.includes("HCM")||u.includes(" NAM")) b='<span class="ph-reg hcm">HCM</span>';
        else if (u.includes(" HN")||u.includes("HA NOI")) b='<span class="ph-reg hn">HN</span>';
        if (u.includes("DMX")||u.includes("ĐMX")||u.includes("TGDD")||u.includes("THE GIOI")) return "TGDD / ĐMX"+b;
        if (u.includes("CPS")||u.includes("CELL")) return "CellphoneS"+b;
        if (u.includes("SHOPDUNK")) return "ShopDunk"+b;
        if (u.includes("VIETTEL")||u.includes("VTS")) return "Viettel Store"+b;
        if (u.includes("HOANGHA")||(u.includes("HOANG")&&u.includes("HA"))) return "Hoàng Hà"+b;
        if (u.includes("DIDONG")||u.includes("DDV")) return "Di Động Việt"+b;
        if (u.includes("CHO LON")||u.includes("DMCL")) return "ĐM Chợ Lớn"+b;
        if (u.includes("PHONG")||u.includes("PV")) return "Phong Vũ"+b;
        if (u.includes("KHANG")||u.includes("GK")) return "Gia Khang"+b;
        if (u.includes("NGUYEN")||u.includes("NK")) return "Nguyễn Kim"+b;
        if (u.includes("MEDIA")||u.includes("MM")) return "MediaMart"+b;
        if ((u.includes("HC ")||u.endsWith("HC"))&&!u.includes("HCM")) return "ĐM HC"+b;
        return raw.replace(/Link|HCM|HN|\(.*?\)/gi,"").trim()+b;
    }
    // Tên đối thủ dạng text thuần (bỏ HTML badge) — dùng cho CSV / báo cáo copy.
    function plainName(raw) {
        return String(fmtName(raw)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
    // Tên sản phẩm thật lấy từ HTML trang (ưu tiên) — đẹp hơn nhiều so với suy
    // từ đuôi URL. Thử h1 chuẩn của FPT trước, rồi h1 chung, cuối cùng fallback
    // về data server / <title>. data: object từ API (có thể chứa product_name).
    function getProductName(data) {
        const sels = [
            'h1.text-textOnWhitePrimary',   // FPT Shop (mới)
            'h1.st-name',                    // một số trang
            '.product-info h1', '.product-name h1', '#product-name',
            'h1',                            // chung
        ];
        for (const s of sels) {
            const el = document.querySelector(s);
            const t = el && el.textContent ? el.textContent.trim() : "";
            if (t && t.length >= 3) return t.replace(/\s+/g, " ");
        }
        if (data && data.product_name) return String(data.product_name).trim();
        return (document.title.split("|")[0] || "Sản phẩm").trim();
    }

    // Vùng của một đối thủ (HCM/HN/"") suy từ tên.
    function regionOf(raw) {
        const u = String(raw||"").toUpperCase();
        if (u.includes("HCM")||u.includes(" NAM")) return "HCM";
        if (u.includes(" HN")||u.includes("HA NOI")) return "HN";
        return "";
    }

    // ========== BỘ PHÂN TÍCH CẠNH TRANH (BD) ==========
    // Nhận data thô từ API, trả về các chỉ số vị thế/thị trường để render.
    // Thuần tính toán, không đụng DOM — dễ kiểm tra và tái dùng cho CSV/báo cáo.
    function analyze(data) {
        const my = Number(data.my_price) || 0;
        const comps = (Array.isArray(data.competitors) ? data.competitors : [])
            .map(c => ({
                name: plainName(c.name),
                rawName: c.name || "",
                region: regionOf(c.name),
                price: Number(c.price) || 0,
                price_display: c.price_display || "",
                url: c.url || "",
            }))
            .filter(c => c.price > 0);

        const prices = comps.map(c => c.price);
        const n = prices.length;
        const sorted = [...prices].sort((a, b) => a - b);
        const sum = prices.reduce((s, p) => s + p, 0);
        const min = n ? sorted[0] : 0;
        const max = n ? sorted[n - 1] : 0;
        const avg = n ? Math.round(sum / n) : 0;
        const median = n ? (n % 2 ? sorted[(n - 1) / 2]
            : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2)) : 0;

        // Đếm rẻ/đắt/bằng so với FPT.
        let cheaper = 0, pricier = 0, equal = 0;
        comps.forEach(c => { if (c.price < my) cheaper++; else if (c.price > my) pricier++; else equal++; });

        // Xếp hạng FPT trong toàn bộ giá (FPT + đối thủ), đồng giá tính cùng hạng.
        let rank = 1, totalPlayers = n + (my > 0 ? 1 : 0);
        if (my > 0) prices.forEach(p => { if (p < my) rank++; });

        // Đối thủ rẻ nhất đang thấp hơn FPT = mối đe dọa số 1.
        let threat = null;
        if (my > 0 && n) {
            const below = comps.filter(c => c.price < my).sort((a, b) => a.price - b.price);
            if (below.length) threat = below[0];
        }

        // Vị thế tổng quát.
        let posType = "none", posLabel = "Chưa có dữ liệu đối thủ";
        if (my > 0 && n) {
            if (my <= min) { posType = "best"; posLabel = "Rẻ nhất thị trường"; }
            else if (my <= median) { posType = "good"; posLabel = "Cạnh tranh tốt"; }
            else if (my <= avg) { posType = "mid"; posLabel = "Ngang thị trường"; }
            else { posType = "bad"; posLabel = "Đắt hơn thị trường"; }
        }

        const gapToMin = (my > 0 && n) ? my - min : 0;         // >0 = FPT đắt hơn đáy
        const gapToMinPct = min ? (gapToMin / min * 100) : 0;
        const gapToMedian = (my > 0 && n) ? my - median : 0;

        return {
            my, comps, n, min, max, avg, median,
            cheaper, pricier, equal, rank, totalPlayers,
            threat, posType, posLabel, gapToMin, gapToMinPct, gapToMedian,
        };
    }

    // Sắp xếp + lọc danh sách đối thủ theo state hiện tại (sortMode/filterMode).
    function arrangeComps(comps, my) {
        let arr = comps.slice();
        if (filterMode === "cheaper") arr = arr.filter(c => c.price < my);
        else if (filterMode === "hcm") arr = arr.filter(c => c.region === "HCM");
        else if (filterMode === "hn")  arr = arr.filter(c => c.region === "HN");

        if (sortMode === "price_asc")  arr.sort((a, b) => a.price - b.price);
        else if (sortMode === "price_desc") arr.sort((a, b) => b.price - a.price);
        else if (sortMode === "name")  arr.sort((a, b) => a.name.localeCompare(b.name));
        // "diff" (mặc định): rẻ hơn FPT trước, chênh lệch lớn xếp trên.
        else arr.sort((a, b) => (a.price - my) - (b.price - my));
        return arr;
    }

    // ========== BÁO CÁO & XUẤT DỮ LIỆU ==========
    // Tạo đoạn tóm tắt BD gọn để dán vào Telegram/Zalo/email.
    function buildBdSummary(data) {
        const a = analyze(data);
        const name = data.product_name ? data.product_name.trim() : getProductName();
        const L = [];
        L.push(`📊 ${name}`);
        if (a.my) L.push(`💎 Giá FPT: ${humanize(a.my)}`);
        if (a.n) {
            L.push(`📍 Vị thế: ${a.posLabel} (hạng ${a.rank}/${a.totalPlayers})`);
            L.push(`🏷️ Thị trường: thấp nhất ${humanize(a.min)} · trung vị ${humanize(a.median)} · cao nhất ${humanize(a.max)}`);
            if (a.threat) L.push(`⚠️ Rẻ nhất: ${a.threat.name} ${humanize(a.threat.price)} (thấp hơn FPT ${humanize(a.my - a.threat.price)})`);
            const below = a.comps.filter(c => c.price < a.my).sort((x, y) => x.price - y.price);
            if (below.length) {
                L.push(`🔻 ${below.length} đối thủ rẻ hơn FPT:`);
                below.slice(0, 8).forEach(c => {
                    const d = a.my - c.price, pct = a.my ? (d / a.my * 100) : 0;
                    L.push(`  • ${c.name}: ${humanize(c.price)} (-${humanize(d)} / ${pct.toFixed(1)}%)`);
                });
            } else {
                L.push(`✅ FPT đang rẻ hơn hoặc bằng mọi đối thủ.`);
            }
        } else {
            L.push(`(Chưa có dữ liệu đối thủ)`);
        }
        L.push(`🔗 ${(data.fpt_url || window.location.href).split('?')[0]}`);
        L.push(`— PriceHawk · ${new Date().toLocaleString('vi-VN')}`);
        return L.join("\n");
    }

    // Xuất bảng so sánh ra CSV (BOM UTF-8 để Excel đọc tiếng Việt).
    function buildCsv(data) {
        const a = analyze(data);
        const rows = [["Đối thủ", "Vùng", "Giá", "Chênh lệch với FPT", "%", "Link"]];
        const arr = a.comps.slice().sort((x, y) => x.price - y.price);
        arr.forEach(c => {
            const d = a.my ? (a.my - c.price) : 0;
            const pct = a.my ? (d / a.my * 100) : 0;
            rows.push([c.name, c.region || "-", c.price,
                d, pct.toFixed(1) + "%", c.url]);
        });
        const esc = v => {
            const s = String(v == null ? "" : v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return "﻿" + rows.map(r => r.map(esc).join(",")).join("\r\n");
    }

    function downloadCsv(data) {
        const name = (data.product_name || "sanpham").replace(/[^\w\-]+/g, "_").slice(0, 40);
        const csv = buildCsv(data);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `PriceHawk_${name}_${today()}.csv`;
        document.body.appendChild(a); a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
    }

    // Mở nhanh các đối thủ đang rẻ hơn FPT trong tab mới (giới hạn 6 để không spam).
    function openCheaperTabs(data) {
        const a = analyze(data);
        const below = a.comps.filter(c => c.price < a.my && c.url)
            .sort((x, y) => x.price - y.price).slice(0, 6);
        below.forEach(c => window.open(c.url, "_blank"));
        return below.length;
    }

    // Chip xu hướng giá FPT (so hôm qua / 7 ngày). trend = {d1, d7} là chênh lệch
    // tuyệt đối (âm = giảm giá). Giảm giá tô xanh (tốt cho khách), tăng tô đỏ.
    function trendChip(trend) {
        if (!trend) return "";
        const parts = [];
        const one = (d, label) => {
            if (d == null || d === 0) return `<span class="ph-trend flat">→ ${label} 0</span>`;
            const up = d > 0;
            const cls = up ? "up" : "down";
            const arrow = up ? "▲" : "▼";
            return `<span class="ph-trend ${cls}">${arrow} ${label} ${humanize(Math.abs(d))}</span>`;
        };
        if (trend.d1 != null) parts.push(one(trend.d1, "hôm qua"));
        if (trend.d7 != null) parts.push(one(trend.d7, "7n"));
        return parts.join(" ");
    }

    // ========== AUTO-REFRESH ==========
    // Bật/tắt tự làm mới. Chỉ đọc lại cache qua checkPrice (KHÔNG force-check để
    // tránh dính rate-limit của server). Timer bị xoá khi tắt hoặc khi render lại.
    function setAutoRefresh(on) {
        autoRefreshOn = on;
        try { GM_setValue('ph_autorefresh', on); } catch(e){}
        if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
        if (on) {
            autoRefreshTimer = setInterval(() => {
                // Chỉ refresh khi panel đang mở & không xem lịch sử.
                const dp = document.querySelector('#ph-root #ph-date');
                if (!document.getElementById('ph-root')) return;
                if (dp && dp.value && dp.value !== today()) return;
                removeOverlay(); checkPrice();
            }, AUTO_REFRESH_MIN * 60 * 1000);
        }
    }

    // Toast nhỏ góc dưới panel — báo hành động nhanh (bật/tắt auto-refresh…).
    function showToast(msg) {
        let t = document.getElementById('ph-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'ph-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.className = 'ph-toast-show';
        clearTimeout(showToast._tm);
        showToast._tm = setTimeout(() => { t.className = ''; }, 2200);
    }

    // ========== POSITION MEMORY ==========
    function savePos(top, right) {
        try { GM_setValue('ph_pos', JSON.stringify({top,right})); } catch(e){}
    }
    function loadPos() {
        let pos = { top: 20, right: 0 };
        try {
            const p = GM_getValue('ph_pos', null);
            if (p) { const parsed = JSON.parse(p); if (parsed) pos = parsed; }
        } catch(e){}
        // Kẹp vị trí vào trong màn hình HIỆN TẠI. GM storage theo từng máy và lưu
        // pixel tuyệt đối; nếu máy trước kéo panel xuống thấp/ra xa, sang máy màn
        // hình nhỏ hơn panel rơi ngoài mép nhìn → như "biến mất". Luôn để lộ header.
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 720;
        let top   = Number(pos.top);   if (!isFinite(top))   top = 20;
        let right = Number(pos.right); if (!isFinite(right)) right = 0;
        top   = Math.max(0, Math.min(top,   vh - 60));   // chừa 60px để thấy header
        right = Math.max(0, Math.min(right, vw - 48));   // chừa 48px (bề rộng khi thu gọn)
        return { top, right };
    }

    // ========== SPARKLINE CHART (2 đường: giá FPT + đáy thị trường) ==========
    // prices: mảng giá FPT theo ngày (cũ→mới). opts.market: mảng giá thấp nhất
    // đối thủ theo ngày (cùng độ dài, có thể null từng điểm). opts.myPrice: giá
    // hiện tại để vẽ đường tham chiếu.
    function drawSparkline(canvas, prices, opts) {
        opts = opts || {};
        const market = opts.market || null;
        const myPrice = opts.myPrice;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0,0,W,H);
        const vals = (prices||[]).map(p=>Number(p)||0);
        if (vals.length < 2) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '10px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('Chưa đủ dữ liệu', W/2, H/2+4);
            return;
        }
        // Miền giá trị gộp cả 2 đường để cùng thang đo.
        const all = vals.filter(v=>v>0).slice();
        const mkt = (market||[]).map(p=>Number(p)||0);
        mkt.forEach(v=>{ if(v>0) all.push(v); });
        const min = Math.min(...all) * 0.998;
        const max = Math.max(...all) * 1.002;
        const range = max - min || 1;
        const pad = { t:6, b:20, l:4, r:4 };
        const cw = W - pad.l - pad.r;
        const ch = H - pad.t - pad.b;
        const xOf = i => pad.l + (i/(vals.length-1))*cw;
        const yOf = v => pad.t + (1-(v-min)/range)*ch;

        const curve = (arr, i) => { const cx=xOf(i-0.5); ctx.bezierCurveTo(cx,yOf(arr[i-1]),cx,yOf(arr[i]),xOf(i),yOf(arr[i])); };

        // Fill gradient dưới đường FPT.
        const grad = ctx.createLinearGradient(0,pad.t,0,H-pad.b);
        grad.addColorStop(0,'rgba(239,68,68,0.15)');
        grad.addColorStop(1,'rgba(239,68,68,0)');
        ctx.beginPath(); ctx.moveTo(xOf(0), yOf(vals[0]));
        for (let i=1;i<vals.length;i++) curve(vals,i);
        ctx.lineTo(xOf(vals.length-1), H-pad.b); ctx.lineTo(xOf(0), H-pad.b);
        ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

        // Đường đáy thị trường (xanh lá, nét đứt) — vẽ trước để nằm dưới.
        if (mkt.length === vals.length && mkt.some(v=>v>0)) {
            ctx.beginPath(); ctx.setLineDash([4,3]);
            let started=false;
            for (let i=0;i<mkt.length;i++) {
                if (mkt[i]<=0) { started=false; continue; }
                if (!started) { ctx.moveTo(xOf(i), yOf(mkt[i])); started=true; }
                else curve(mkt,i);
            }
            ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1.5; ctx.stroke();
            ctx.setLineDash([]);
        }

        // Đường giá FPT (đỏ).
        ctx.beginPath(); ctx.moveTo(xOf(0), yOf(vals[0]));
        for (let i=1;i<vals.length;i++) curve(vals,i);
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5; ctx.stroke();

        // Đường tham chiếu giá hiện tại.
        if (myPrice && myPrice >= min && myPrice <= max) {
            const y = yOf(myPrice);
            ctx.beginPath(); ctx.setLineDash([3,3]);
            ctx.moveTo(pad.l, y); ctx.lineTo(W-pad.r, y);
            ctx.strokeStyle = 'rgba(239,68,68,0.4)'; ctx.lineWidth = 1; ctx.stroke();
            ctx.setLineDash([]);
        }

        // Chấm đầu/cuối đường FPT.
        [[0,vals[0]],[vals.length-1,vals[vals.length-1]]].forEach(([i,v])=>{
            ctx.beginPath(); ctx.arc(xOf(i),yOf(v),3,0,Math.PI*2);
            ctx.fillStyle = '#ef4444'; ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        });

        // Nhãn trục ngày (đầu, giữa, cuối). opts.dates: mảng ngày "YYYY-MM-DD" (nếu
        // có) → nhãn chuẩn theo dữ liệu thật; không có thì suy ngược từ hôm nay.
        ctx.fillStyle = '#94a3b8'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
        const labels = vals.map((_,i)=> {
            const ds = opts.dates && opts.dates[i];
            if (ds) { const p = String(ds).split('-'); return p.length===3 ? `${+p[2]}/${+p[1]}` : ds; }
            const d=new Date(); d.setDate(d.getDate()-(vals.length-1-i)); return `${d.getDate()}/${d.getMonth()+1}`;
        });
        [0, Math.floor(vals.length/2), vals.length-1].forEach(i=> ctx.fillText(labels[i], xOf(i), H-4));

        // Trả hình học để lớp gọi gắn tooltip hover (map chuột → điểm gần nhất).
        return {
            n: vals.length, W, H,
            points: vals.map((v,i)=>({ i, x: xOf(i), yFpt: yOf(v), fpt: v,
                floor: (mkt.length===vals.length && mkt[i]>0) ? mkt[i] : 0,
                label: labels[i] })),
            xOf, yOf, pad, min, max,
        };
    }

    // Gắn tương tác hover cho sparkline: crosshair dọc + tooltip giá theo ngày.
    // canvas: thẻ canvas đã vẽ; geo: object trả về từ drawSparkline; myPrice để
    // hiển thị chênh lệch. Tự tạo overlay tuyệt đối trong wrapper (position:relative).
    function attachSparkHover(canvas, geo, myPrice) {
        if (!geo || !geo.points || geo.points.length < 2) return;
        const wrap = canvas.parentElement;
        if (!wrap) return;
        if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

        // Dọn overlay cũ nếu vẽ lại.
        wrap.querySelectorAll('.ph-spark-cross,.ph-spark-tip,.ph-spark-dot').forEach(e=>e.remove());

        const cross = document.createElement('div'); cross.className = 'ph-spark-cross';
        const dot   = document.createElement('div'); dot.className   = 'ph-spark-dot';
        const tip   = document.createElement('div'); tip.className   = 'ph-spark-tip';
        wrap.appendChild(cross); wrap.appendChild(dot); wrap.appendChild(tip);

        // canvas.width là toạ độ nội bộ; hiển thị co giãn theo CSS → cần tỉ lệ.
        // Overlay định vị theo pixel trong wrapper = offset của canvas + toạ độ
        // nội bộ × tỉ lệ hiển thị (chính xác bất kể padding của chartbox).
        let curIdx = -1;   // nhớ ngày đang hiện để không dựng lại tooltip mỗi pixel
        const show = (clientX) => {
            const rect = canvas.getBoundingClientRect();
            const dispScaleX = rect.width  / geo.W;      // px hiển thị / px nội bộ
            const dispScaleY = rect.height / geo.H;
            const px = (clientX - rect.left) / dispScaleX; // về toạ độ nội bộ canvas
            // Điểm ngày gần nhất theo trục x.
            let best = geo.points[0], bd = Infinity;
            for (const p of geo.points) { const d = Math.abs(p.x - px); if (d < bd) { bd = d; best = p; } }

            const cx = canvas.offsetLeft + best.x * dispScaleX;   // px trong wrapper
            const cy = canvas.offsetTop  + best.yFpt * dispScaleY;
            cross.style.left = cx + 'px';
            dot.style.left = cx + 'px'; dot.style.top = cy + 'px';
            cross.classList.add('on'); dot.classList.add('on'); tip.classList.add('on');

            // Tooltip: một điểm neo (left) + transform để lật — transition trượt mềm.
            const flip = cx > wrap.clientWidth * 0.62;
            tip.style.left = cx + 'px';
            tip.style.transform = flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)';

            if (best.i === curIdx) return;   // cùng ngày → chỉ dời vị trí, khỏi render lại
            curIdx = best.i;
            let html = `<div class="ph-tip-date">${best.label}</div>`;
            html += `<div class="ph-tip-row"><span class="ph-tip-k"><i style="background:#ef4444"></i>FPT</span><b>${best.fpt?humanize(best.fpt):'—'}</b></div>`;
            if (best.floor) html += `<div class="ph-tip-row"><span class="ph-tip-k"><i style="background:#10b981"></i>Đáy TT</span><b>${humanize(best.floor)}</b></div>`;
            if (best.floor && best.fpt) {
                const gd = best.fpt - best.floor;
                html += `<div class="ph-tip-gap ${gd>0?'c':(gd<0?'h':'')}">${gd>0?'FPT cao hơn đáy ':(gd<0?'FPT thấp hơn đáy ':'Ngang đáy')} ${gd?humanize(Math.abs(gd)):''}</div>`;
            }
            tip.innerHTML = html;
        };
        const hide = () => { curIdx = -1; cross.classList.remove('on'); dot.classList.remove('on'); tip.classList.remove('on'); };

        canvas.onmousemove = e => show(e.clientX);
        canvas.onmouseleave = hide;
        canvas.style.cursor = 'crosshair';
    }

    // ========== STYLES ==========
    GM_addStyle(`
        #ph-root * { box-sizing:border-box; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }

        #ph-root {
            position:fixed;
            width:320px;
            max-height:calc(100vh - 20px);
            z-index:999999;
            display:flex;
            flex-direction:column;
            border-radius:16px 0 0 16px;
            overflow:hidden;
            background:#fff;
            color:#334155;
            font-size:13px;
            box-shadow:-4px 0 28px rgba(15,23,42,0.1),0 4px 12px rgba(15,23,42,0.05);
            border-left:1px solid #e2e8f0;
            border-top:1px solid #e2e8f0;
            border-bottom:1px solid #e2e8f0;
            transition:width 0.2s cubic-bezier(0.4,0,0.2,1), opacity 0.15s;
        }
        #ph-root.ph-entering { animation: phSlideIn 0.25s cubic-bezier(0.4,0,0.2,1) both; }
        @keyframes phSlideIn { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }

        /* HEADER */
        .ph-header {
            background:#fff; padding:12px 14px;
            display:flex; justify-content:space-between; align-items:center;
            border-bottom:1px solid #f1f5f9; flex-shrink:0;
            cursor:grab; user-select:none;
        }
        .ph-header:active { cursor:grabbing; }
        .ph-logo { display:flex; align-items:center; gap:8px; font-weight:700; font-size:14px; color:#0f172a; letter-spacing:-0.2px; }
        .ph-logo-icon { width:26px; height:26px; background:linear-gradient(135deg,#ef4444,#dc2626); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:14px; box-shadow:0 2px 6px rgba(239,68,68,0.25); }
        .ph-header-right { display:flex; align-items:center; gap:5px; }
        .ph-icon-btn { background:transparent; border:none; color:#94a3b8; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:13px; transition:all 0.15s; }
        .ph-icon-btn:hover { background:#f1f5f9; color:#475569; }
        .ph-report-btn { background:#fef2f2; border:1px solid #fee2e2; color:#ef4444; border-radius:8px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer; transition:all 0.15s; }
        .ph-report-btn:hover { background:#fee2e2; }

        /* TOOLBAR */
        .ph-toolbar { padding:9px 14px; background:#f8fafc; border-bottom:1px solid #f1f5f9; display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .ph-date-wrap { flex:1; position:relative; display:flex; align-items:center; }
        .ph-date-wrap svg { position:absolute; left:9px; color:#94a3b8; pointer-events:none; }
        .ph-date-input { width:100%; background:#fff; border:1px solid #e2e8f0; border-radius:8px; color:#334155; font-size:12px; font-weight:500; padding:6px 9px 6px 30px; outline:none; cursor:pointer; transition:all 0.15s; }
        .ph-date-input:focus { border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,0.1); }
        .ph-time-chip { background:#fef2f2; color:#ef4444; font-size:11px; font-weight:700; padding:3px 7px; border-radius:20px; white-space:nowrap; margin-left:6px; }
        .ph-action-btn { border:none; border-radius:8px; padding:7px 13px; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; transition:all 0.15s; }
        .ph-action-btn:active { transform:scale(0.95); }
        .ph-action-btn.primary { background:#ef4444; color:#fff; box-shadow:0 2px 6px rgba(239,68,68,0.25); }
        .ph-action-btn.primary:hover { background:#dc2626; }
        .ph-action-btn.secondary { background:#fff; color:#475569; border:1px solid #cbd5e1; }
        .ph-action-btn.secondary:hover { background:#f8fafc; }
        .ph-action-btn:disabled { opacity:0.5; cursor:not-allowed; }

        /* MY PRICE */
        .ph-myprice { padding:14px; background:#fff; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
        .ph-myprice-label { font-size:10px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:2px; }
        .ph-myprice-value { font-size:22px; font-weight:700; color:#0f172a; letter-spacing:-0.5px; }
        .ph-open-fpt { background:#fef2f2; color:#ef4444; border:1px solid #fee2e2; border-radius:20px; padding:5px 11px; font-size:11px; font-weight:700; text-decoration:none; transition:all 0.15s; white-space:nowrap; }
        .ph-open-fpt:hover { background:#fee2e2; }

        /* SUMMARY */
        .ph-summary { padding:9px 14px; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:flex; gap:12px; flex-shrink:0; }
        .ph-stat { display:flex; align-items:center; gap:5px; font-size:12px; }
        .ph-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
        .ph-dot.c { background:#ef4444; } .ph-dot.e { background:#94a3b8; } .ph-dot.h { background:#10b981; }
        .ph-stat-n { color:#0f172a; font-weight:700; }
        .ph-stat-l { color:#64748b; font-weight:500; }

        /* CHART SECTION — thanh tiêu đề LUÔN hiển thị, chỉ vùng canvas co lại.
           (Trước đây cả section co lại nên nút thu gọn cũng bị ẩn → không mở lại được.) */
        .ph-chart-section { background:#fff; border-bottom:1px solid #f1f5f9; flex-shrink:0; }
        .ph-chart-title { padding:8px 14px 4px; font-size:10px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; display:flex; justify-content:space-between; align-items:center; }
        .ph-chart-toggle { cursor:pointer; color:#94a3b8; font-size:10px; font-weight:700; background:none; border:none; padding:2px 4px; border-radius:6px; transition:all 0.12s; }
        .ph-chart-toggle:hover { color:#ef4444; background:#fef2f2; }
        .ph-chart-body { overflow:visible; max-height:90px; transition:max-height 0.3s ease, padding 0.3s ease; padding:0 14px 6px; position:relative; }
        .ph-chart-body.closed { max-height:0; padding-top:0; padding-bottom:0; overflow:hidden; }

        /* HISTORY LABEL */
        .ph-hist-label { padding:7px 14px; background:#fffbeb; border-bottom:1px solid #fde68a; font-size:11px; color:#d97706; font-weight:600; text-align:center; flex-shrink:0; }

        /* LIST */
        .ph-list { flex:1; overflow-y:auto; overscroll-behavior:contain; }
        .ph-list::-webkit-scrollbar { width:3px; }
        .ph-list::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:99px; }

        /* SKELETON */
        .ph-skeleton { padding:8px 14px; }
        .ph-skel-item { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #f1f5f9; }
        .ph-skel-bar { background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%); background-size:200% 100%; border-radius:6px; animation:phShimmer 1.4s ease-in-out infinite; }
        @keyframes phShimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

        /* ROWS */
        .ph-row { padding:11px 14px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:#fff; transition:background 0.12s; animation:phFadeRow 0.2s ease both; }
        @keyframes phFadeRow { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        .ph-row:hover { background:#f8fafc; }
        .ph-row.here { background:#f8fafc; border-left:3px solid #94a3b8; }
        .ph-row.cr { border-left:3px solid #ef4444; }
        .ph-row.hr { border-left:3px solid #10b981; }
        .ph-row-l { display:flex; flex-direction:column; gap:3px; }
        .ph-row-name { font-size:13px; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
        .ph-badge { font-size:9px; font-weight:700; padding:2px 6px; border-radius:4px; letter-spacing:0.04em; text-transform:uppercase; }
        .ph-badge.here { background:#e2e8f0; color:#475569; }
        .ph-badge.best { background:#ecfdf5; color:#059669; border:1px solid #a7f3d0; }
        .ph-reg { font-size:9px; font-weight:700; padding:2px 5px; border-radius:4px; }
        .ph-reg.hcm { background:#fef2f2; color:#dc2626; }
        .ph-reg.hn  { background:#eff6ff; color:#2563eb; }
        .ph-diff { font-size:11px; font-weight:600; }
        .ph-diff.c { color:#dc2626; } .ph-diff.h { color:#059669; } .ph-diff.e { color:#64748b; }
        .ph-row-r { text-align:right; display:flex; flex-direction:column; gap:4px; align-items:flex-end; }
        .ph-price { font-size:14px; font-weight:700; color:#0f172a; letter-spacing:-0.3px; }
        .ph-row-actions { display:flex; gap:4px; align-items:center; }
        .ph-view-link { font-size:10px; color:#64748b; text-decoration:none; padding:2px 7px; border-radius:4px; background:#f1f5f9; font-weight:600; transition:all 0.12s; }
        .ph-view-link:hover { color:#0f172a; background:#e2e8f0; }
        .ph-copy-link { font-size:10px; color:#64748b; background:#f1f5f9; border:none; padding:2px 7px; border-radius:4px; font-weight:600; cursor:pointer; transition:all 0.12s; }
        .ph-copy-link:hover { color:#0f172a; background:#e2e8f0; }

        .ph-empty { padding:36px 16px; text-align:center; color:#64748b; font-size:13px; font-weight:500; }

        /* FOOTER */
        .ph-footer { padding:8px 14px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; justify-content:center; gap:10px; flex-shrink:0; }
        .ph-footer a { font-size:11px; color:#64748b; text-decoration:none; font-weight:600; transition:color 0.12s; }
        .ph-footer a:hover { color:#0f172a; }
        .ph-sep { color:#cbd5e1; font-size:11px; }

        /* COLLAPSED — thanh dọc gọn, hiện hạng vị thế + đếm rẻ/bằng/đắt */
        #ph-root.collapsed { width:54px; border-radius:14px 0 0 14px; cursor:pointer; }
        #ph-root.collapsed:hover { width:58px; }
        .ph-coll-inner { padding:12px 0 14px; display:flex; flex-direction:column; align-items:center; gap:9px; }
        .ph-coll-logo { width:34px; height:34px; background:linear-gradient(135deg,#ef4444,#dc2626); border-radius:11px; display:flex; align-items:center; justify-content:center; font-size:17px; box-shadow:0 2px 8px rgba(239,68,68,0.3); }
        .ph-coll-rank { display:flex; flex-direction:column; align-items:center; line-height:1; padding:5px 0; border-radius:10px; width:40px; }
        .ph-coll-rank.best { background:#ecfdf5; } .ph-coll-rank.good { background:#f0fdf4; }
        .ph-coll-rank.mid { background:#fffbeb; }  .ph-coll-rank.bad { background:#fef2f2; }
        .ph-coll-rank-n { font-size:16px; font-weight:800; color:#0f172a; }
        .ph-coll-rank-t { font-size:8px; font-weight:700; color:#64748b; margin-top:2px; }
        .ph-coll-div { width:24px; height:1px; background:#e2e8f0; }
        .ph-coll-stat { display:flex; flex-direction:column; align-items:center; gap:2px; }
        .ph-coll-n { font-size:13px; font-weight:700; color:#0f172a; line-height:1; }
        .ph-coll-dot { width:7px; height:7px; border-radius:50%; }
        .ph-coll-hint { font-size:14px; color:#cbd5e1; margin-top:2px; }

        /* LOGIN */
        .ph-login-wrap { padding:28px 20px; display:flex; flex-direction:column; align-items:center; gap:12px; }
        .ph-login-icon { width:54px; height:54px; background:#fef2f2; border-radius:16px; display:flex; align-items:center; justify-content:center; font-size:26px; border:1px solid #fee2e2; }
        .ph-login-title { font-size:16px; font-weight:700; color:#0f172a; }
        .ph-login-sub { font-size:13px; color:#64748b; text-align:center; line-height:1.5; }
        .ph-login-btn { width:100%; background:#ef4444; color:#fff; border:none; border-radius:10px; padding:12px; font-size:14px; font-weight:700; cursor:pointer; transition:all 0.15s; box-shadow:0 4px 12px rgba(239,68,68,0.2); margin-top:6px; }
        .ph-login-btn:hover { background:#dc2626; transform:translateY(-1px); }
        .ph-login-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; box-shadow:none; }

        /* MISSING */
        .ph-missing-wrap { padding:20px; }
        .ph-missing-title { font-size:14px; font-weight:700; color:#d97706; margin-bottom:6px; }
        .ph-missing-name { font-size:13px; color:#475569; margin-bottom:14px; line-height:1.5; font-weight:500; }
        .ph-copy-btn { width:100%; background:#fffbeb; border:1px solid #fde68a; color:#d97706; border-radius:10px; padding:11px; font-size:13px; font-weight:700; cursor:pointer; transition:all 0.15s; }
        .ph-copy-btn:hover { background:#fef3c7; }

        /* MODAL */
        .ph-modal-overlay { position:fixed; inset:0; background:rgba(15,23,42,0.55); backdrop-filter:blur(3px); z-index:1000000; display:flex; align-items:center; justify-content:center; animation:phFadeIn 0.15s ease; }
        @keyframes phFadeIn { from{opacity:0} to{opacity:1} }
        .ph-modal { background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:24px; width:360px; box-shadow:0 20px 40px rgba(0,0,0,0.12); animation:phSlideUp 0.2s cubic-bezier(0.4,0,0.2,1); }
        @keyframes phSlideUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        .ph-modal-title { font-size:16px; font-weight:700; color:#0f172a; margin-bottom:6px; }
        .ph-modal-sub { font-size:13px; color:#64748b; margin-bottom:14px; }
        .ph-modal-ta { width:100%; height:100px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:10px; color:#334155; font-size:13px; padding:11px; outline:none; resize:none; transition:all 0.15s; font-family:inherit; }
        .ph-modal-ta:focus { border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,0.1); }
        .ph-modal-acts { display:flex; justify-content:flex-end; gap:10px; margin-top:14px; }
        .ph-modal-cancel { background:#f1f5f9; border:1px solid #e2e8f0; color:#475569; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; }
        .ph-modal-cancel:hover { background:#e2e8f0; }
        .ph-modal-send { background:#ef4444; border:none; color:#fff; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 2px 6px rgba(239,68,68,0.2); transition:all 0.15s; }
        .ph-modal-send:hover { background:#dc2626; }
        .ph-modal-send:disabled { opacity:0.5; box-shadow:none; cursor:not-allowed; }

        /* ===== v4.0 BD INTELLIGENCE ===== */
        /* TOOLS — sắp xếp / lọc */
        .ph-tools { padding:8px 14px; background:#fff; border-bottom:1px solid #f1f5f9; display:flex; gap:8px; align-items:center; flex-shrink:0; }
        .ph-sel { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; color:#334155; font-size:12px; font-weight:600; padding:6px 8px; outline:none; cursor:pointer; }
        .ph-sel:focus { border-color:#ef4444; }

        /* HERO VỊ THẾ */
        .ph-hero { padding:12px 14px; border-bottom:1px solid #f1f5f9; flex-shrink:0; display:flex; align-items:center; gap:12px; border-left:4px solid #94a3b8; }
        .ph-hero-best { background:#ecfdf5; border-left-color:#10b981; }
        .ph-hero-good { background:#f0fdf4; border-left-color:#4ade80; }
        .ph-hero-mid  { background:#fffbeb; border-left-color:#f59e0b; }
        .ph-hero-bad  { background:#fef2f2; border-left-color:#ef4444; }
        .ph-hero-rank { font-size:26px; font-weight:800; color:#0f172a; line-height:1; white-space:nowrap; }
        .ph-hero-rank span { font-size:13px; font-weight:600; color:#64748b; }
        .ph-hero-body { flex:1; min-width:0; }
        .ph-hero-label { font-size:14px; font-weight:800; color:#0f172a; margin-bottom:2px; }
        .ph-hero-sub { font-size:11px; color:#64748b; font-weight:600; }

        /* TOAST */
        #ph-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%) translateY(20px);
            background:#0f172a; color:#fff; font-size:12px; font-weight:600; padding:9px 16px; border-radius:10px;
            box-shadow:0 8px 24px rgba(0,0,0,0.25); z-index:1000001; opacity:0; pointer-events:none; transition:all 0.25s; }
        #ph-toast.ph-toast-show { opacity:1; transform:translateX(-50%) translateY(0); }

        /* CẢNH BÁO */
        .ph-alert { padding:10px 14px; font-size:12px; font-weight:600; display:block; flex-shrink:0; line-height:1.5; background:#fef2f2; color:#b91c1c; border-bottom:1px solid #fecaca; }

        /* THỐNG KÊ THỊ TRƯỜNG */
        .ph-market { padding:10px 14px; background:#f8fafc; border-bottom:1px solid #f1f5f9; display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; flex-shrink:0; }
        .ph-market-cell { display:flex; flex-direction:column; gap:2px; text-align:center; }
        .ph-market-l { font-size:9px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }
        .ph-market-v { font-size:13px; font-weight:700; color:#0f172a; }
        .ph-market-v.c { color:#dc2626; } .ph-market-v.h { color:#059669; }

        /* TREND CHIP (xu hướng giá FPT) */
        .ph-trend { display:inline-flex; align-items:center; gap:3px; font-size:10px; font-weight:700; padding:2px 6px; border-radius:6px; margin-left:4px; vertical-align:middle; }
        .ph-trend.up { background:#fef2f2; color:#dc2626; } /* giá tăng = xấu cho khách, đỏ */
        .ph-trend.down { background:#ecfdf5; color:#059669; }
        .ph-trend.flat { background:#f1f5f9; color:#64748b; }

        /* TOOLS — sort / filter selects */
        .ph-tools { padding:8px 14px; background:#f8fafc; border-bottom:1px solid #f1f5f9; display:flex; gap:8px; align-items:center; flex-shrink:0; }
        .ph-sel { flex:1; min-width:0; background:#fff; border:1px solid #e2e8f0; border-radius:8px; color:#334155; font-size:12px; font-weight:600; padding:6px 8px; outline:none; cursor:pointer; transition:all 0.12s; }
        .ph-sel:focus { border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,0.1); }

        /* AUTO-REFRESH nút trong toolbar */
        .ph-icon-btn.ph-auto-on { background:#ecfdf5; color:#059669; }

        /* THANH HÀNH ĐỘNG BD (Copy báo cáo / CSV / Mở rẻ hơn) */
        .ph-actbar { padding:10px 14px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; gap:6px; flex-shrink:0; }
        .ph-act2 { flex:1; border:1px solid #cbd5e1; background:#fff; color:#334155; border-radius:8px; padding:8px 6px; font-size:11px; font-weight:700; cursor:pointer; transition:all 0.12s; white-space:nowrap; }
        .ph-act2:hover { background:#f1f5f9; border-color:#94a3b8; }
        .ph-act2:active { transform:scale(0.96); }
        .ph-act2.ok { background:#ecfdf5; color:#059669; border-color:#a7f3d0; }

        /* ===== FULL DASHBOARD (popup to) ===== */
        .ph-dash-overlay { position:fixed; inset:0; background:rgba(15,23,42,0.55); backdrop-filter:blur(4px);
            z-index:1000002; display:flex; align-items:center; justify-content:center; padding:24px; animation:phFadeIn 0.15s ease; }
        .ph-dash { width:min(1040px,96vw); height:min(660px,92vh); background:#f8fafc; border-radius:18px;
            display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,0.3);
            animation:phSlideUp 0.2s cubic-bezier(0.4,0,0.2,1); }
        .ph-dash-head { display:flex; justify-content:space-between; align-items:center; padding:14px 20px;
            background:#fff; border-bottom:1px solid #e2e8f0; flex-shrink:0; }
        .ph-dash-title { display:flex; align-items:center; gap:11px; }
        .ph-dash-logo { width:38px; height:38px; background:linear-gradient(135deg,#ef4444,#dc2626); border-radius:11px;
            display:flex; align-items:center; justify-content:center; font-size:19px; box-shadow:0 2px 8px rgba(239,68,68,0.3); }
        .ph-dash-name { font-size:15px; font-weight:800; color:#0f172a; max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .ph-dash-sub { font-size:11px; color:#94a3b8; font-weight:600; }
        .ph-dash-close { width:34px; height:34px; border-radius:9px; border:none; background:#f1f5f9; color:#64748b;
            font-size:15px; cursor:pointer; transition:all 0.12s; }
        .ph-dash-close:hover { background:#fee2e2; color:#dc2626; }
        .ph-dash-grid { flex:1; display:grid; grid-template-columns:290px 1fr; gap:14px; padding:16px; overflow:hidden; min-height:0; }
        .ph-dash-col { display:flex; flex-direction:column; gap:12px; min-height:0; }
        .ph-dash-left { overflow-y:auto; }
        /* Cột phải: biểu đồ (cao tự nhiên) trên, bảng (co giãn, cuộn riêng) dưới. */
        .ph-dash-right { overflow:hidden; }
        .ph-dash-mid { flex:0 0 auto; display:flex; flex-direction:column; gap:6px; }
        .ph-dash-tablecol { flex:1 1 auto; display:flex; flex-direction:column; gap:6px; min-height:0; }
        .ph-dash-col::-webkit-scrollbar { width:5px; } .ph-dash-col::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:99px; }

        .ph-dash-hero { padding:16px; border-radius:14px; border-left:5px solid #94a3b8; }
        .ph-dash-rank { font-size:34px; font-weight:800; color:#0f172a; line-height:1; }
        .ph-dash-rank span { font-size:15px; font-weight:600; color:#64748b; }
        .ph-dash-poslabel { font-size:16px; font-weight:800; color:#0f172a; margin-top:6px; }
        .ph-dash-posbar { font-size:12px; color:#64748b; font-weight:600; margin-top:3px; }
        .ph-dash-cards { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
        .ph-dash-card { background:#fff; border:1px solid #e2e8f0; border-radius:11px; padding:11px 12px; }
        .ph-dash-cl { font-size:10px; color:#64748b; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; }
        .ph-dash-cv { font-size:16px; font-weight:800; color:#0f172a; margin-top:3px; }
        .ph-dash-cv.c { color:#dc2626; } .ph-dash-cv.h { color:#059669; }
        .ph-dash-gap { background:#fff; border:1px solid #e2e8f0; border-radius:11px; padding:11px 12px; }
        .ph-dash-gl { font-size:10px; color:#64748b; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; }
        .ph-dash-gv { font-size:13px; font-weight:700; margin-top:4px; }
        .ph-dash-gv.c { color:#dc2626; } .ph-dash-gv.h { color:#059669; } .ph-dash-gv.e { color:#64748b; }
        .ph-dash-threat { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; font-size:12px; font-weight:600;
            padding:10px 12px; border-radius:11px; line-height:1.5; }

        .ph-dash-secttitle { font-size:12px; font-weight:800; color:#0f172a; display:flex; justify-content:space-between;
            align-items:center; gap:8px; padding-bottom:2px; }
        .ph-dash-chartbox { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:14px 12px 6px; position:relative; }
        .ph-dash-trend { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
        .ph-dash-chartnote { position:absolute; top:14px; right:14px; font-size:10px; font-weight:700; color:#f59e0b;
            background:#fffbeb; border:1px solid #fde68a; padding:2px 7px; border-radius:6px; pointer-events:none; }
        .ph-dash-chartnote:empty { display:none; }

        /* Crosshair + tooltip khi hover biểu đồ (dùng chung .ph-dash-chartbox position:relative) */
        /* transition x/opacity để trượt mềm khi chuyển giữa các ngày. */
        .ph-spark-cross { position:absolute; top:14px; bottom:6px; width:1px; background:#94a3b8; pointer-events:none;
            opacity:0; z-index:2; transition:left 0.13s cubic-bezier(0.4,0,0.2,1), opacity 0.13s; }
        .ph-spark-dot { position:absolute; width:9px; height:9px; border-radius:50%; background:#ef4444; border:2px solid #fff;
            pointer-events:none; opacity:0; transform:translate(-50%,-50%); z-index:3; box-shadow:0 1px 4px rgba(0,0,0,0.3);
            transition:left 0.13s cubic-bezier(0.4,0,0.2,1), top 0.13s cubic-bezier(0.4,0,0.2,1), opacity 0.13s; }
        .ph-spark-tip { position:absolute; top:16px; pointer-events:none; background:#0f172a; color:#fff; border-radius:9px;
            padding:8px 11px; font-size:11px; line-height:1.5; white-space:nowrap; opacity:0;
            box-shadow:0 6px 20px rgba(0,0,0,0.28); z-index:4;
            transition:left 0.13s cubic-bezier(0.4,0,0.2,1), transform 0.13s cubic-bezier(0.4,0,0.2,1), opacity 0.13s; }
        .ph-spark-cross.on, .ph-spark-dot.on, .ph-spark-tip.on { opacity:1; }
        .ph-spark-tip b { font-weight:800; margin-left:12px; }
        .ph-tip-date { color:#94a3b8; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.03em; margin-bottom:4px; }
        .ph-tip-row { display:flex; justify-content:space-between; align-items:center; gap:6px; }
        .ph-tip-k { display:inline-flex; align-items:center; gap:5px; color:#cbd5e1; }
        .ph-tip-k i { width:8px; height:8px; border-radius:2px; display:inline-block; }
        .ph-tip-gap { margin-top:4px; font-size:10px; font-weight:700; }
        .ph-tip-gap.c { color:#f87171; } .ph-tip-gap.h { color:#34d399; }

        /* Lưới thẻ đối thủ — auto-fit nhiều cột, xem tổng quan không scroll */
        .ph-dash-cardgrid { flex:1; min-height:0; overflow-y:auto; display:grid; gap:8px; align-content:start;
            grid-template-columns:repeat(auto-fill, minmax(158px, 1fr)); padding-right:2px; }
        .ph-dash-cardgrid.dense  { grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:7px; }
        .ph-dash-cardgrid.xdense { grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:6px; }
        .ph-dash-cardgrid::-webkit-scrollbar { width:5px; } .ph-dash-cardgrid::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:99px; }
        .ph-ccard { background:#fff; border:1px solid #e8edf3; border-left:3px solid #cbd5e1; border-radius:11px;
            padding:9px 11px; display:flex; flex-direction:column; gap:3px; transition:transform 0.1s, box-shadow 0.1s; }
        .ph-ccard:hover { transform:translateY(-2px); box-shadow:0 6px 16px rgba(15,23,42,0.1); }
        .ph-ccard.c { border-left-color:#ef4444; } .ph-ccard.h { border-left-color:#10b981; } .ph-ccard.e { border-left-color:#94a3b8; }
        .ph-ccard.best { background:#f0fdf9; border-color:#a7f3d0; }
        .ph-ccard-top { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
        .ph-ccard-name { font-size:12px; font-weight:700; color:#1e293b; line-height:1.25; }
        .ph-ccard-best { font-size:8px; font-weight:800; color:#059669; background:#ecfdf5; border:1px solid #a7f3d0;
            padding:1px 5px; border-radius:4px; letter-spacing:0.03em; }
        .ph-ccard-price { font-size:15px; font-weight:800; color:#0f172a; letter-spacing:-0.3px; }
        .ph-dash-cardgrid.xdense .ph-ccard-price { font-size:13px; }
        .ph-ccard-diff { font-size:10px; font-weight:700; }
        .ph-ccard-diff.c { color:#dc2626; } .ph-ccard-diff.h { color:#059669; } .ph-ccard-diff.e { color:#64748b; }
        .ph-dash-empty { grid-column:1/-1; text-align:center; color:#94a3b8; padding:24px; font-weight:600; }

        .ph-dash-foot { display:flex; gap:8px; padding:12px 20px; background:#fff; border-top:1px solid #e2e8f0; flex-shrink:0; }
        .ph-dash-foot .ph-act2 { flex:0 0 auto; padding:9px 16px; }

        @media (max-width: 720px) {
            .ph-dash-grid { grid-template-columns:1fr; overflow-y:auto; }
            .ph-dash-col { overflow:visible; }
        }

        /* ===== RESPONSIVE (màn hình nhỏ / mobile) ===== */
        @media (max-width: 480px) {
            #ph-root { width:100vw !important; right:0 !important; left:0 !important;
                       border-radius:16px 16px 0 0 !important; max-height:70vh; top:auto !important; bottom:0; }
        }
    `);

    // ========== DRAGGABLE ==========
    function makeDraggable(panel, handle) {
        let dragging = false, startX, startY, startRight, startTop;

        handle.addEventListener('mousedown', e => {
            if (e.target.closest('button,a,input')) return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startRight = window.innerWidth - rect.right;
            startTop = rect.top;
            document.body.style.userSelect = 'none';
            handle.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newRight = startRight - dx;
            let newTop  = startTop  + dy;
            newRight = Math.max(0, Math.min(newRight, window.innerWidth - 48));
            newTop   = Math.max(10, Math.min(newTop, window.innerHeight - 100));
            panel.style.right = newRight + 'px';
            panel.style.top   = newTop   + 'px';
            panel.style.borderRadius = newRight > 0 ? '16px' : '16px 0 0 16px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            handle.style.cursor = 'grab';
            // save position
            const rect = panel.getBoundingClientRect();
            savePos(rect.top, window.innerWidth - rect.right);
        });
    }

    // ========== FACTORY HELPERS ==========
    function makeRoot() {
        removeOverlay();
        const c = document.createElement('div');
        c.id = 'ph-root';
        c.classList.add('ph-entering');
        const pos = loadPos();
        c.style.top   = pos.top   + 'px';
        c.style.right = pos.right + 'px';
        if (pos.right > 0) c.style.borderRadius = '16px';
        document.body.appendChild(c);
        return c;
    }

    function makeHeader(actions=true) {
        const h = document.createElement('div');
        h.className = 'ph-header';
        h.innerHTML = `
            <div class="ph-logo"><div class="ph-logo-icon">🦅</div>PricingEdge</div>
            <div class="ph-header-right">
                ${actions ? `<button class="ph-report-btn" id="ph-rep">⚠ Báo sai</button>` : ''}
                ${actions ? `<button class="ph-icon-btn" id="ph-expand" title="Xem toàn màn hình">⛶</button>` : ''}
                <button class="ph-icon-btn" id="ph-min" title="Thu nhỏ">─</button>
            </div>`;
        return h;
    }

    function makeFooter() {
        const f = document.createElement('div');
        f.className = 'ph-footer';
        f.innerHTML = `<a href="mailto:vuvanthe64@gmail.com">Vũ Văn Thế</a><span class="ph-sep">|</span><a href="tel:0943455667">0943 455 667</a><span class="ph-sep">|</span><a href="https://t.me/thevv" target="_blank">@thevv</a>`;
        return f;
    }

    // ========== SKELETON LOADING ==========
    function renderSkeleton() {
        const c = makeRoot();
        const hdr = makeHeader(false);
        c.appendChild(hdr);
        const sk = document.createElement('div');
        sk.className = 'ph-skeleton';
        for (let i=0;i<5;i++) {
            sk.innerHTML += `<div class="ph-skel-item">
                <div>
                    <div class="ph-skel-bar" style="width:${100+Math.random()*60|0}px;height:12px;margin-bottom:6px"></div>
                    <div class="ph-skel-bar" style="width:${70+Math.random()*40|0}px;height:10px"></div>
                </div>
                <div class="ph-skel-bar" style="width:70px;height:18px"></div>
            </div>`;
        }
        c.appendChild(sk);
        // make draggable even on skeleton
        makeDraggable(c, hdr);
        hdr.querySelector('#ph-min').onclick = e => { e.stopPropagation(); c.remove(); };
        return c;
    }

    // ========== CHART SECTION ==========
    // Vẽ biểu đồ + tính xu hướng. onTrend(trend) trả về {d1, d1pct, d7, d7pct, last}
    // để render chip xu hướng ở khối giá FPT. Ưu tiên /api/trend (1 request),
    // fallback về 7 request history song song nếu server chưa có endpoint đó.
    function makeChartSection(myPrice, onTrend) {
        const section = document.createElement('div');
        section.className = 'ph-chart-section';
        section.id = 'ph-chart-section';
        section.innerHTML = `
            <div class="ph-chart-title">
                <span>📈 Xu hướng 7 ngày <span style="color:#ef4444">━</span> FPT
                    <span style="color:#10b981">┄</span> Đáy TT</span>
                <button class="ph-chart-toggle" id="ph-chart-toggle">Thu gọn ▲</button>
            </div>
            <div class="ph-chart-body" id="ph-chart-body">
                <canvas id="ph-sparkline" width="280" height="70" style="width:100%;height:70px;display:block"></canvas>
            </div>`;
        let open = true;

        // Nhận chuỗi {date, price, floor} đã sắp xếp tăng dần → vẽ + báo xu hướng.
        const render = (series) => {
            const fpt = series.map(s => s.price || null);
            const floor = series.map(s => s.floor || null);
            const canvas = document.getElementById('ph-sparkline');
            if (canvas) {
                const geo = drawSparkline(canvas, fpt, { myPrice, market: floor });
                attachSparkHover(canvas, geo, myPrice);   // di chuột xem giá từng ngày
            }
            if (typeof onTrend === 'function') {
                const valid = series.filter(s => s.price > 0);
                const last = valid.length ? valid[valid.length - 1].price : myPrice;
                const prev = valid.length > 1 ? valid[valid.length - 2].price : last;
                const first = valid.length ? valid[0].price : last;
                const d1 = last - prev, d7 = last - first;
                onTrend({
                    d1, d1pct: prev ? d1 / prev * 100 : 0,
                    d7, d7pct: first ? d7 / first * 100 : 0, last,
                });
            }
        };

        fetchTrendSeries(window.location.href, render);

        return { section, bindToggle: () => {
            const btn = section.querySelector('#ph-chart-toggle');
            const body = section.querySelector('#ph-chart-body');
            if (btn && body) btn.onclick = () => {
                open = !open;
                body.classList.toggle('closed', !open);
                btn.textContent = open ? 'Thu gọn ▲' : 'Xem biểu đồ ▼';
            };
        }};
    }

    // Lấy chuỗi giá `days` ngày (mặc định 7). Thử /api/trend trước; lỗi/không có →
    // fallback history. Server tự trả về đúng số ngày có dữ liệu (có thể ít hơn
    // days nếu chưa đủ lịch sử) → cb nhận bao nhiêu là vẽ bấy nhiêu.
    function fetchTrendSeries(url, cb, days) {
        days = days || 7;
        GM_xmlhttpRequest({
            method:'GET', url: buildUrl(API_TREND, { url, days }), timeout: 20000,
            onload(resp) {
                const res = safeJson(resp.responseText, null);
                if (res && Array.isArray(res.series) && res.series.length) {
                    cb(res.series.map(s => ({
                        date: s.date, price: Number(s.price)||0, floor: Number(s.floor)||0,
                    })).sort((a,b)=>a.date.localeCompare(b.date)));
                } else {
                    fetchTrendFallback(url, cb, days);
                }
            },
            onerror() { fetchTrendFallback(url, cb, days); },
            ontimeout() { fetchTrendFallback(url, cb, days); },
        });
    }

    // Fallback: gọi song song /api/history `days` ngày (chỉ có giá FPT, không có
    // đáy TT). Ngày nào không có giá → price 0 (drawSparkline vẽ thành khoảng trống).
    function fetchTrendFallback(url, cb, days) {
        days = days || 7;
        const series = []; let fetched = 0;
        for (let i=days-1; i>=0; i--) {
            const d = new Date(); d.setDate(d.getDate()-i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            GM_xmlhttpRequest({
                method:'GET', url: buildUrl(API_HISTORY, { url, date: dateStr }),
                onload(resp) {
                    fetched++;
                    const res = safeJson(resp.responseText, null);
                    let price = 0;
                    if (res && res.status==='success' && res.data && res.data[0]) {
                        const rec = res.data[0], di = rec.data_json;
                        price = di && typeof di==='object' ? Number(di.my_price||0) : Number(rec.my_price||0);
                    }
                    series.push({ date: dateStr, price, floor: 0 });
                    if (fetched === days) cb(series.sort((a,b)=>a.date.localeCompare(b.date)));
                },
                onerror() { fetched++; series.push({ date: dateStr, price: 0, floor: 0 });
                    if (fetched === days) cb(series.sort((a,b)=>a.date.localeCompare(b.date))); },
            });
        }
    }

    // ========== RENDER LỖI KẾT NỐI (khác với yêu cầu đăng nhập) ==========
    function renderConnError(msg) {
        removeOverlay();
        const c = makeRoot();
        const hdr = makeHeader(false);
        c.appendChild(hdr);
        makeDraggable(c, hdr);
        hdr.querySelector('#ph-min').onclick = e => { e.stopPropagation(); c.remove(); };
        const body = document.createElement('div');
        body.className = 'ph-login-wrap';
        body.innerHTML = `
            <div class="ph-login-icon" style="background:#fffbeb;border-color:#fde68a">🌐</div>
            <div class="ph-login-title">Không kết nối được máy chủ</div>
            <div class="ph-login-sub">${msg || 'Máy chủ PriceHawk đang bận hoặc mất mạng. Thử lại sau giây lát.'}</div>
            <button class="ph-login-btn" id="ph-retry-btn">🔄 Thử lại</button>`;
        c.appendChild(body);
        c.appendChild(makeFooter());
        body.querySelector('#ph-retry-btn').onclick = function() {
            this.textContent = "Đang thử lại…"; this.disabled = true;
            removeOverlay(); checkPrice();
        };
    }

    // ========== RENDER LOGIN ==========
    function renderLoginRequest() {
        const c = makeRoot();
        const hdr = makeHeader(false);
        c.appendChild(hdr);
        makeDraggable(c, hdr);
        const body = document.createElement('div');
        body.className = 'ph-login-wrap';
        body.innerHTML = `
            <div class="ph-login-icon">🔐</div>
            <div class="ph-login-title">Yêu cầu đăng nhập</div>
            <div class="ph-login-sub">Bạn cần đăng nhập để xem bảng giá đối thủ.</div>
            <button class="ph-login-btn" id="ph-login-btn">Đăng nhập ngay</button>`;
        c.appendChild(body);
        c.appendChild(makeFooter());
        hdr.querySelector('#ph-min').onclick = e => { e.stopPropagation(); c.remove(); };
        body.querySelector('#ph-login-btn').onclick = function() {
            window.open(AUTH_URL,"PriceHawkLogin","width=500,height=600,top=100,left=100");
            this.textContent = "Đang chờ đăng nhập…";
            this.disabled = true; this.dataset.waiting = "1";
            startLoginPolling();
        };
    }

    // ========== RENDER MISSING ==========
    function renderMissingUI() {
        const c = makeRoot();
        const hdr = makeHeader(false);
        c.appendChild(hdr);
        makeDraggable(c, hdr);
        let name = document.title.split("|")[0].trim();
        const h1 = document.querySelector('h1.text-textOnWhitePrimary,h1.st-name,h1');
        if (h1) name = h1.innerText.trim();
        const body = document.createElement('div');
        body.className = 'ph-missing-wrap';
        body.innerHTML = `
            <div class="ph-missing-title">⚠ Chưa có trong Database</div>
            <div class="ph-missing-name">${name}</div>
            <button class="ph-copy-btn" id="ph-copy-btn">📋 Copy để thêm vào Sheet</button>`;
        c.appendChild(body);
        c.appendChild(makeFooter());
        hdr.querySelector('#ph-min').onclick = e => { e.stopPropagation(); c.remove(); };
        body.querySelector('#ph-copy-btn').onclick = function() {
            GM_setClipboard(`${name}\t\t${window.location.href}`);
            this.textContent = "✓ Đã copy!";
            this.style.cssText = "background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.3);color:#059669";
            setTimeout(()=>{ this.textContent="📋 Copy để thêm vào Sheet"; this.style.cssText=""; }, 3000);
        };
    }

    // ========== RENDER CHƯA MAP (trên trang đối thủ) ==========
    // Khi mở trên trang đối thủ mà server không tra ngược ra link FPT → thay vì
    // panel trắng, báo rõ + cho copy link để thêm mapping.
    function renderUnmappedUI(msg) {
        removeOverlay();
        const c = makeRoot();
        const hdr = makeHeader(false);
        c.appendChild(hdr);
        makeDraggable(c, hdr);
        hdr.querySelector('#ph-min').onclick = e => { e.stopPropagation(); c.remove(); };
        let name = document.title.split("|")[0].trim();
        const h1 = document.querySelector('h1');
        if (h1 && h1.innerText.trim()) name = h1.innerText.trim();
        const body = document.createElement('div');
        body.className = 'ph-missing-wrap';
        body.innerHTML = `
            <div class="ph-missing-title">🔗 Link đối thủ chưa được ghép</div>
            <div class="ph-missing-name">${name}<br><span style="font-size:11px;color:#94a3b8">${msg || 'Chưa map với sản phẩm FPT nào trong hệ thống.'}</span></div>
            <button class="ph-copy-btn" id="ph-copy-btn">📋 Copy link để thêm mapping</button>`;
        c.appendChild(body);
        c.appendChild(makeFooter());
        body.querySelector('#ph-copy-btn').onclick = function() {
            GM_setClipboard(`${name}\t${window.location.href}`);
            this.textContent = "✓ Đã copy!";
            this.style.cssText = "background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.3);color:#059669";
            setTimeout(()=>{ this.textContent="📋 Copy link để thêm mapping"; this.style.cssText=""; }, 3000);
        };
    }

    // ========== REPORT MODAL ==========
    function showReportModal() {
        const m = document.createElement('div');
        m.className = 'ph-modal-overlay';
        m.innerHTML = `<div class="ph-modal">
            <div class="ph-modal-title">⚠ Báo cáo sai giá / Lỗi</div>
            <div class="ph-modal-sub">Mô tả vấn đề (VD: giá sai, link chết, hết hàng…)</div>
            <textarea class="ph-modal-ta" id="ph-rep-txt" placeholder="Nhập mô tả…"></textarea>
            <div class="ph-modal-acts">
                <button class="ph-modal-cancel" id="ph-rep-cancel">Hủy</button>
                <button class="ph-modal-send" id="ph-rep-send">Gửi báo cáo</button>
            </div></div>`;
        document.body.appendChild(m);
        m.onclick = e => { if(e.target===m) m.remove(); };
        m.querySelector('#ph-rep-cancel').onclick = ()=>m.remove();
        m.querySelector('#ph-rep-send').onclick = function() {
            const comment = m.querySelector('#ph-rep-txt').value||"";
            this.disabled=true; this.textContent="Đang gửi…";
            GM_xmlhttpRequest({
                method:"POST", url:API_REPORT,
                headers:{"Content-Type":"application/json"},
                data:JSON.stringify({fpt_url:window.location.href.split('?')[0],comment}),
                onload(r){ m.remove(); alert(r.status===200?"✅ Đã gửi! Cảm ơn.":"❌ Gửi thất bại."); },
                onerror(){ m.remove(); alert("❌ Lỗi kết nối."); }
            });
        };
    }

    // ========== FULL DASHBOARD (popup to) ==========
    // Overlay lớn giữa màn hình, bố cục dashboard. Tái dùng analyze() + các hàm
    // báo cáo/CSV/mở tab sẵn có; không cần thêm API mới (biểu đồ tự fetch trend).
    function showFullDashboard(data) {
        document.getElementById('ph-dash-overlay')?.remove();
        const A = analyze(data);
        const my = A.my;
        const name = getProductName(data);

        const ov = document.createElement('div');
        ov.id = 'ph-dash-overlay';
        ov.className = 'ph-dash-overlay';

        // Header + 3 khối: cột trái (vị thế/thị trường), giữa (biểu đồ), phải (bảng).
        ov.innerHTML = `
          <div class="ph-dash">
            <div class="ph-dash-head">
                <div class="ph-dash-title"><span class="ph-dash-logo">🦅</span>
                    <div><div class="ph-dash-name">${name}</div>
                    <div class="ph-dash-sub">PricingEdge · Bảng phân tích cạnh tranh</div></div>
                </div>
                <button class="ph-dash-close" id="ph-dash-close" title="Đóng (Esc)">✕</button>
            </div>
            <div class="ph-dash-grid">
                <div class="ph-dash-col ph-dash-left"></div>
                <div class="ph-dash-col ph-dash-right">
                    <div class="ph-dash-mid"></div>
                    <div class="ph-dash-tablecol"></div>
                </div>
            </div>
            <div class="ph-dash-foot">
                <button class="ph-act2" id="ph-dash-copy">📋 Copy báo cáo BD</button>
                <button class="ph-act2" id="ph-dash-csv">⬇️ Xuất CSV</button>
                <button class="ph-act2" id="ph-dash-open">🔗 Mở đối thủ rẻ hơn</button>
            </div>
          </div>`;
        document.body.appendChild(ov);

        // ----- CỘT TRÁI: vị thế + thống kê thị trường -----
        const left = ov.querySelector('.ph-dash-left');
        const gapCls = A.gapToMin > 0 ? 'c' : (A.gapToMin < 0 ? 'h' : 'e');
        left.innerHTML = `
            <div class="ph-dash-hero ph-hero-${A.posType==='none'?'mid':A.posType}">
                <div class="ph-dash-rank">#${A.rank}<span>/${A.totalPlayers}</span></div>
                <div class="ph-dash-poslabel">${A.posLabel}</div>
                <div class="ph-dash-posbar">${A.cheaper} rẻ hơn · ${A.equal} bằng · ${A.pricier} đắt hơn</div>
            </div>
            <div class="ph-dash-cards">
                <div class="ph-dash-card"><div class="ph-dash-cl">Giá FPT</div><div class="ph-dash-cv">${my?humanize(my):'—'}</div></div>
                <div class="ph-dash-card"><div class="ph-dash-cl">Thấp nhất TT</div><div class="ph-dash-cv c">${A.n?humanize(A.min):'—'}</div></div>
                <div class="ph-dash-card"><div class="ph-dash-cl">Trung vị TT</div><div class="ph-dash-cv">${A.n?humanize(A.median):'—'}</div></div>
                <div class="ph-dash-card"><div class="ph-dash-cl">Cao nhất TT</div><div class="ph-dash-cv h">${A.n?humanize(A.max):'—'}</div></div>
            </div>
            ${A.n?`<div class="ph-dash-gap">
                <div class="ph-dash-gl">Chênh lệch với đáy thị trường</div>
                <div class="ph-dash-gv ${gapCls}">${A.gapToMin>0?'FPT đắt hơn đáy ':(A.gapToMin<0?'FPT rẻ hơn đáy ':'Ngang đáy ')}${humanize(Math.abs(A.gapToMin))} (${Math.abs(A.gapToMinPct).toFixed(1)}%)</div>
            </div>`:''}
            ${A.threat?`<div class="ph-dash-threat">⚠️ Đe dọa số 1: <b>${A.threat.name}</b> — ${humanize(A.threat.price)}</div>`:''}`;

        // ----- BIỂU ĐỒ xu hướng to (trên cùng cột phải, rộng hết ngang) -----
        // Cho chọn 7/30/60 ngày (mặc định 30). Nếu server chưa đủ data cho khoảng
        // đã chọn thì vẽ full những gì có (drawSparkline dùng đúng mốc ngày thật).
        const mid = ov.querySelector('.ph-dash-mid');
        mid.innerHTML = `
            <div class="ph-dash-secttitle">📈 Xu hướng giá
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-weight:600;color:#94a3b8"><span style="color:#ef4444">━</span> FPT <span style="color:#10b981">┄</span> Đáy TT · <i style="color:#cbd5e1">di chuột xem giá</i></span>
                    <select class="ph-sel" id="ph-dash-days" style="max-width:110px">
                        <option value="7">7 ngày</option>
                        <option value="30" selected>30 ngày</option>
                        <option value="60">60 ngày</option>
                    </select>
                </div>
            </div>
            <div class="ph-dash-chartbox" id="ph-dash-chartbox">
                <canvas id="ph-dash-canvas" width="900" height="220" style="width:100%;height:220px;display:block"></canvas>
                <div class="ph-dash-chartnote" id="ph-dash-chartnote"></div>
            </div>
            <div class="ph-dash-trend" id="ph-dash-trend"></div>`;
        const daysSel = mid.querySelector('#ph-dash-days');

        const drawTrend = (series, reqDays) => {
            const canvas = document.getElementById('ph-dash-canvas');
            if (canvas) {
                const geo = drawSparkline(canvas,
                    series.map(s => s.price || null),
                    { myPrice: my, market: series.map(s => s.floor || null),
                      dates: series.map(s => s.date) });
                attachSparkHover(canvas, geo, my);   // crosshair + tooltip giá theo ngày
            }
            const valid = series.filter(s => s.price > 0);
            const slot = document.getElementById('ph-dash-trend');
            if (slot && valid.length > 1) {
                const last = valid[valid.length-1].price, prev = valid[valid.length-2].price, first = valid[0].price;
                slot.innerHTML = trendChip({ d1: last-prev, d7: last-first });
            } else if (slot) slot.innerHTML = '';
            // Báo khi data ít hơn khoảng yêu cầu.
            const note = document.getElementById('ph-dash-chartnote');
            if (note) note.textContent = (valid.length && valid.length < reqDays)
                ? `Chỉ có ${valid.length} ngày dữ liệu` : '';
        };

        const loadTrend = (days) => {
            const canvas = document.getElementById('ph-dash-canvas');
            if (canvas) { const cx = canvas.getContext('2d'); cx.clearRect(0,0,canvas.width,canvas.height);
                cx.fillStyle='#94a3b8'; cx.font='11px system-ui'; cx.textAlign='center';
                cx.fillText('Đang tải…', canvas.width/2, canvas.height/2); }
            fetchTrendSeries(window.location.href, (series) => drawTrend(series, days), days);
        };
        daysSel.onchange = () => loadTrend(Number(daysSel.value));
        loadTrend(30);

        // ----- LƯỚI THẺ ĐỐI THỦ — xem tổng quan, không cần scroll -----
        // Mỗi đối thủ = 1 thẻ nhỏ; grid tự xếp số cột theo bề ngang, thẻ tự thu nhỏ
        // để mọi đối thủ hiện cùng lúc trong khung (auto-fit + font co giãn).
        const right = ov.querySelector('.ph-dash-tablecol');
        right.innerHTML = `
            <div class="ph-dash-secttitle">Đối thủ (${A.n})
                <div style="display:flex;gap:6px;align-items:center">
                    <select class="ph-sel" id="ph-dash-sort" style="max-width:150px">
                        <option value="diff">Chênh lệch FPT</option><option value="price">↑ Giá thấp→cao</option>
                        <option value="name">Tên A→Z</option><option value="region">Theo vùng</option>
                    </select>
                    <select class="ph-sel" id="ph-dash-filter" style="max-width:130px">
                        <option value="all">Tất cả</option><option value="cheaper">Chỉ rẻ hơn FPT</option>
                        <option value="hcm">Vùng HCM</option><option value="hn">Vùng HN</option>
                    </select>
                </div>
            </div>
            <div class="ph-dash-cardgrid" id="ph-dash-cardgrid"></div>`;
        const dfilter = right.querySelector('#ph-dash-filter');
        const dsort   = right.querySelector('#ph-dash-sort');
        dfilter.value = filterMode;
        dsort.value = (sortMode === 'price_asc' || sortMode === 'price_desc') ? 'price' : (sortMode || 'diff');

        const renderCards = () => {
            const box = right.querySelector('#ph-dash-cardgrid');
            let arr = A.comps.slice();
            const f = dfilter.value;
            if (f === 'cheaper') arr = arr.filter(c => c.price < my);
            else if (f === 'hcm') arr = arr.filter(c => c.region === 'HCM');
            else if (f === 'hn')  arr = arr.filter(c => c.region === 'HN');
            const s = dsort.value;
            arr.sort((a,b) => {
                if (s === 'name')   return a.name.localeCompare(b.name);
                if (s === 'region') return (a.region||'').localeCompare(b.region||'') || (a.price-b.price);
                if (s === 'price')  return a.price - b.price;
                return (a.price-my) - (b.price-my); // diff (mặc định)
            });
            // Thẻ tự co nhỏ dần khi càng nhiều đối thủ → luôn vừa khung không scroll.
            box.classList.toggle('dense', arr.length > 12);
            box.classList.toggle('xdense', arr.length > 24);
            if (!arr.length) { box.innerHTML = `<div class="ph-dash-empty">Không có đối thủ khớp bộ lọc</div>`; return; }
            box.innerHTML = arr.map(comp => {
                const diff = my - comp.price;
                const pct = my > 0 ? (Math.abs(diff)/my*100).toFixed(1) : '0.0';
                const dc = diff > 0 ? 'c' : (diff < 0 ? 'h' : 'e');
                const dt = diff > 0 ? `↓ ${humanize(Math.abs(diff))} · ${pct}%`
                    : (diff < 0 ? `↑ ${humanize(Math.abs(diff))} · ${pct}%` : 'Bằng giá');
                const isBest = comp.price === A.min;
                const reg = comp.region ? `<span class="ph-reg ${comp.region==='HCM'?'hcm':'hn'}">${comp.region}</span>` : '';
                const clickable = comp.url ? ` data-url="${comp.url}"` : '';
                return `<div class="ph-ccard ${dc}${isBest?' best':''}"${clickable}>
                    <div class="ph-ccard-top">
                        <span class="ph-ccard-name">${plainName(comp.rawName)}</span>${reg}
                        ${isBest?'<span class="ph-ccard-best">RẺ NHẤT</span>':''}
                    </div>
                    <div class="ph-ccard-price">${comp.price_display||humanize(comp.price)}</div>
                    <div class="ph-ccard-diff ${dc}">${dt}</div>
                </div>`;
            }).join('');
            // Click thẻ có link → mở tab đối thủ.
            box.querySelectorAll('.ph-ccard[data-url]').forEach(card => {
                card.style.cursor = 'pointer';
                card.onclick = () => window.open(card.dataset.url, '_blank');
            });
        };
        renderCards();
        dfilter.onchange = renderCards;
        dsort.onchange = renderCards;

        // ----- ĐÓNG + THANH HÀNH ĐỘNG -----
        const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc); };
        const onEsc = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onEsc);
        ov.querySelector('#ph-dash-close').onclick = close;
        ov.onclick = e => { if (e.target === ov) close(); };
        ov.querySelector('#ph-dash-copy').onclick = function(){
            GM_setClipboard(buildBdSummary(data));
            const o=this.textContent; this.textContent='✓ Đã copy'; this.classList.add('ok');
            setTimeout(()=>{ this.textContent=o; this.classList.remove('ok'); }, 1800);
        };
        ov.querySelector('#ph-dash-csv').onclick = () => downloadCsv(data);
        ov.querySelector('#ph-dash-open').onclick = function(){
            const n = openCheaperTabs(data);
            const o=this.textContent; this.textContent = n?`↗ Mở ${n} tab`:'Không có';
            setTimeout(()=>{ this.textContent=o; }, 1800);
        };
    }

    // ========== RENDER COLLAPSED ==========
    function renderCollapsed(c, lower, higher, equal, data) {
        c.classList.add('collapsed');
        const A = analyze(data);
        const inner = document.createElement('div');
        inner.className = 'ph-coll-inner';
        let h = `<div class="ph-coll-logo">🦅</div>`;
        // Badge hạng vị thế FPT (chỉ khi có dữ liệu đối thủ) — màu theo posType.
        if (A.posType !== 'none') {
            h += `<div class="ph-coll-rank ${A.posType}" title="${A.posLabel}">
                    <div class="ph-coll-rank-n">#${A.rank}</div>
                    <div class="ph-coll-rank-t">/${A.totalPlayers}</div>
                  </div>`;
        }
        if (lower||equal||higher) h += `<div class="ph-coll-div"></div>`;
        if (lower)  h+=`<div class="ph-coll-stat" title="${lower} đối thủ rẻ hơn FPT"><div class="ph-coll-dot" style="background:#ef4444"></div><div class="ph-coll-n">${lower}</div></div>`;
        if (equal)  h+=`<div class="ph-coll-stat" title="${equal} đối thủ bằng giá FPT"><div class="ph-coll-dot" style="background:#94a3b8"></div><div class="ph-coll-n">${equal}</div></div>`;
        if (higher) h+=`<div class="ph-coll-stat" title="${higher} đối thủ đắt hơn FPT"><div class="ph-coll-dot" style="background:#10b981"></div><div class="ph-coll-n">${higher}</div></div>`;
        if (!lower&&!equal&&!higher) h+=`<div style="font-size:9px;color:#64748b;margin-top:4px;text-align:center">Chưa<br>có DL</div>`;
        h += `<div class="ph-coll-hint">‹</div>`;
        inner.innerHTML = h;
        c.appendChild(inner);
        c.title = "Bấm để mở rộng";
        c.onclick = ()=>{ isCollapsed=false; renderInterface(data); };
    }

    // ========== RENDER EXPANDED ==========
    function renderExpanded(c, data) {
        c.classList.remove('collapsed');
        const todayStr = today();
        const dispDate = data.history_date || todayStr;
        const isHist   = dispDate !== todayStr;
        const A = analyze(data);   // chỉ số cạnh tranh cho BD

        // time
        let timeStr = "";
        const tKeys = ["last_checked_at","last_checked","updated_at","update_time","checked_at"];
        for (const k of tKeys) {
            const raw = data[k]; if (!raw) continue;
            if (typeof raw==="number") { const dt=new Date(raw*1000); if(!isNaN(dt)) timeStr=`${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; }
            else if (typeof raw==="string") { const m=raw.match(/(\d{1,2}):(\d{2})/); if(m) timeStr=`${m[1].padStart(2,'0')}:${m[2]}`; }
            if (timeStr) break;
        }

        // stats
        let lower=0, higher=0, equal=0;
        if (Array.isArray(data.competitors)) {
            data.competitors.forEach(comp=>{
                const d=Number(data.my_price)-Number(comp.price||0);
                if(d>0)lower++; else if(d<0)higher++; else equal++;
            });
        }

        // HEADER
        const hdr = makeHeader(true);
        c.appendChild(hdr);
        makeDraggable(c, hdr);
        hdr.querySelector('#ph-min').onclick   = e=>{ e.stopPropagation(); isCollapsed=true; renderInterface(data); };
        hdr.querySelector('#ph-rep').onclick   = e=>{ e.stopPropagation(); showReportModal(); };
        const bExp = hdr.querySelector('#ph-expand');
        if (bExp) bExp.onclick = e=>{ e.stopPropagation(); showFullDashboard(data); };

        // HISTORY LABEL
        if (isHist) {
            const hl=document.createElement('div'); hl.className='ph-hist-label';
            hl.textContent=`📅 Lịch sử: ${dispDate}`; c.appendChild(hl);
        }

        // TOOLBAR
        const tb=document.createElement('div'); tb.className='ph-toolbar';
        tb.innerHTML=`
            <div class="ph-date-wrap">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <input id="ph-date" class="ph-date-input" type="date" value="${dispDate}" max="${todayStr}">
                ${timeStr?`<span class="ph-time-chip">${timeStr}</span>`:''}
            </div>
            <button class="ph-icon-btn ${autoRefreshOn?'ph-auto-on':''}" id="ph-auto" title="Tự động làm mới mỗi ${AUTO_REFRESH_MIN} phút">${autoRefreshOn?'⏸️':'🔄'}</button>
            <button class="ph-action-btn ${isHist?'secondary':'primary'}" id="ph-act">${isHist?'Hôm nay':'⚡ Check'}</button>`;
        c.appendChild(tb);

        // TOOLS — sắp xếp / lọc đối thủ (chỉ khi có dữ liệu đối thủ)
        if (A.n) {
            const tools=document.createElement('div'); tools.className='ph-tools';
            const sel=(id,val,opts)=>`<select class="ph-sel" id="${id}">`+
                opts.map(([v,l])=>`<option value="${v}"${v===val?' selected':''}>${l}</option>`).join('')+`</select>`;
            tools.innerHTML=
                sel('ph-sort', sortMode, [
                    ['price_asc','↑ Giá thấp→cao'],['price_desc','↓ Giá cao→thấp'],
                    ['diff','Chênh lệch FPT'],['name','Tên A→Z'],
                ])+
                sel('ph-filter', filterMode, [
                    ['all','Tất cả'],['cheaper','Chỉ rẻ hơn FPT'],['hcm','Vùng HCM'],['hn','Vùng HN'],
                ]);
            c.appendChild(tools);
        }

        // HERO VỊ THẾ (BD) — hạng của FPT trong thị trường
        if (!isHist && A.posType !== 'none') {
            const hero=document.createElement('div');
            hero.className=`ph-hero ph-hero-${A.posType}`;
            hero.innerHTML=`
                <div class="ph-hero-rank">#${A.rank}<span>/${A.totalPlayers}</span></div>
                <div class="ph-hero-body">
                    <div class="ph-hero-label">${A.posLabel}</div>
                    <div class="ph-hero-sub">${A.cheaper} rẻ hơn · ${A.equal} bằng · ${A.pricier} đắt hơn FPT</div>
                </div>`;
            c.appendChild(hero);
        }

        // CẢNH BÁO CHỦ ĐỘNG — FPT đang bị phá giá
        if (!isHist && A.threat) {
            const al=document.createElement('div'); al.className='ph-alert';
            al.innerHTML=`⚠️ <b>${A.threat.name}</b> đang rẻ hơn FPT <b>${humanize(A.gapToMin)}</b> (${A.gapToMinPct.toFixed(1)}%) — ${humanize(A.threat.price)}`;
            c.appendChild(al);
        }

        // MY PRICE — fallback nếu my_price_display bị thiếu
        const myPriceDisp = data.my_price_display
            || (data.my_price ? new Intl.NumberFormat('vi-VN').format(Number(data.my_price)) : null);
        const mp=document.createElement('div'); mp.className='ph-myprice';
        if (!myPriceDisp) {
            // Không có giá FPT — ẩn block này đi
            mp.style.display = 'none';
        } else {
            mp.innerHTML=`<div>
                <div class="ph-myprice-label">Giá FPT Shop${isHist&&data.my_price_time?` <span style="font-weight:500;color:#94a3b8;font-size:9px;text-transform:none;letter-spacing:0">(thấp nhất ${data.my_price_time})</span>`:''}</div>
                <div class="ph-myprice-value">${myPriceDisp} đ <span id="ph-trend-slot"></span></div>
            </div>`
                +(isFptSite?'': `<a class="ph-open-fpt" href="${data.fpt_url||'#'}" target="_blank">Mở FPT ↗</a>`);
        }
        c.appendChild(mp);

        // SUMMARY
        const sum=document.createElement('div'); sum.className='ph-summary';
        sum.innerHTML=(lower?`<div class="ph-stat"><div class="ph-dot c"></div><span class="ph-stat-n">${lower}</span><span class="ph-stat-l">rẻ hơn</span></div>`:'')
            +(equal?`<div class="ph-stat"><div class="ph-dot e"></div><span class="ph-stat-n">${equal}</span><span class="ph-stat-l">bằng giá</span></div>`:'')
            +(higher?`<div class="ph-stat"><div class="ph-dot h"></div><span class="ph-stat-n">${higher}</span><span class="ph-stat-l">đắt hơn</span></div>`:'')
            +(!lower&&!equal&&!higher?'<span style="font-size:11px;color:#64748b">Chưa có dữ liệu</span>':'');
        c.appendChild(sum);

        // THỐNG KÊ THỊ TRƯỜNG (BD) — min/median/max của đối thủ
        if (!isHist && A.n) {
            const ms=document.createElement('div'); ms.className='ph-market';
            ms.innerHTML=`
                <div class="ph-market-cell"><div class="ph-market-l">Thấp nhất</div><div class="ph-market-v c">${humanize(A.min)}</div></div>
                <div class="ph-market-cell"><div class="ph-market-l">Trung vị</div><div class="ph-market-v">${humanize(A.median)}</div></div>
                <div class="ph-market-cell"><div class="ph-market-l">Cao nhất</div><div class="ph-market-v h">${humanize(A.max)}</div></div>`;
            c.appendChild(ms);
        }

        // CHART + XU HƯỚNG (chỉ show khi xem hôm nay)
        if (!isHist) {
            const { section, bindToggle } = makeChartSection(Number(data.my_price), (trend) => {
                // Gắn chip xu hướng vào ô giá FPT khi có dữ liệu lịch sử.
                const host = c.querySelector('#ph-trend-slot');
                if (host && trend) host.innerHTML = trendChip(trend);
            });
            c.appendChild(section);
            setTimeout(bindToggle, 0);
        }

        // LIST — dùng A.comps (đã chuẩn hóa) + arrangeComps (tôn trọng sort/lọc).
        const list=document.createElement('div'); list.className='ph-list';
        const curHost = normHost(window.location.href);
        const cheapest = A.n ? A.min : null;
        if (A.n) {
            const arranged = arrangeComps(A.comps, A.my);
            if (!arranged.length) {
                list.innerHTML=`<div class="ph-empty">Không có đối thủ khớp bộ lọc</div>`;
            }
            arranged.forEach((comp,idx)=>{
                const diff=A.my-comp.price;
                const isCur = comp.url ? (normHost(comp.url)===curHost) : false;
                const isBest = comp.price===cheapest;
                let cls="ph-row"+(isCur?" here":diff>0?" cr":diff<0?" hr":"");
                let dc="e", dt="⬜ Bằng giá";
                if(diff>0){ dc="c"; const pct=(A.my>0?(Math.abs(diff)/A.my*100).toFixed(2):"0.00"); dt=`↓ Rẻ hơn ${humanize(Math.abs(diff))} (${pct}%)`; }
                else if(diff<0){ dc="h"; const pct=(A.my>0?(Math.abs(diff)/A.my*100).toFixed(2):"0.00"); dt=`↑ Đắt hơn ${humanize(Math.abs(diff))} (${pct}%)`; }

                const row=document.createElement('div');
                row.className=cls;
                row.style.animationDelay=`${idx*25}ms`;
                row.innerHTML=`
                    <div class="ph-row-l">
                        <div class="ph-row-name">${fmtName(comp.rawName)}
                            ${isCur?'<span class="ph-badge here">TẠI ĐÂY</span>':''}
                            ${isBest?'<span class="ph-badge best">RẺ NHẤT</span>':''}
                        </div>
                        <div class="ph-diff ${dc}">${dt}</div>
                    </div>
                    <div class="ph-row-r">
                        <div class="ph-price">${comp.price_display||humanize(comp.price)}</div>
                        <div class="ph-row-actions">
                            ${!isCur&&comp.url?`<a class="ph-view-link" href="${comp.url}" target="_blank">Xem →</a>`:''}
                            ${comp.url?`<button class="ph-copy-link" data-url="${comp.url}" title="Copy link">⎘</button>`:''}
                        </div>
                    </div>`;
                list.appendChild(row);
            });

            list.querySelectorAll('.ph-copy-link').forEach(btn=>{
                btn.onclick = function(e) {
                    e.stopPropagation();
                    GM_setClipboard(this.dataset.url);
                    const orig=this.textContent; this.textContent='✓';
                    setTimeout(()=>{ this.textContent=orig; }, 1500);
                };
            });
        } else {
            list.innerHTML=`<div class="ph-empty">📭 Chưa có dữ liệu đối thủ</div>`;
        }
        c.appendChild(list);

        // THANH HÀNH ĐỘNG BD — Copy báo cáo / Xuất CSV / Mở đối thủ rẻ hơn
        if (A.n) {
            const bar=document.createElement('div'); bar.className='ph-actbar';
            bar.innerHTML=`
                <button class="ph-act2" id="ph-copy-bd" title="Copy tóm tắt để gửi Telegram/Zalo">📋 Copy báo cáo</button>
                <button class="ph-act2" id="ph-csv" title="Xuất bảng so sánh CSV">⬇️ CSV</button>
                <button class="ph-act2" id="ph-open-cheaper" title="Mở tab các đối thủ rẻ hơn">🔗 Mở rẻ hơn</button>`;
            c.appendChild(bar);
        }
        c.appendChild(makeFooter());

        // TOOLBAR EVENTS
        const btnAct  = c.querySelector('#ph-act');
        const datePkr = c.querySelector('#ph-date');
        if (btnAct) btnAct.onclick = function() {
            const picked = datePkr?.value;
            if (picked && picked!==todayStr) { if(datePkr)datePkr.value=todayStr; removeOverlay(); checkPrice(); }
            else handleForceCheck(this);
        };
        if (datePkr) datePkr.onchange = function() {
            const v=this.value; if(!v)return;
            if(v!==todayStr) fetchHistory(v); else { removeOverlay(); checkPrice(); }
        };

        // SORT / LỌC — đổi state rồi vẽ lại panel với cùng data (giữ nguyên vị trí).
        const selSort = c.querySelector('#ph-sort');
        const selFilter = c.querySelector('#ph-filter');
        if (selSort) selSort.onchange = function(){ sortMode=this.value; try{GM_setValue('ph_sort',sortMode);}catch(e){} renderInterface(data); };
        if (selFilter) selFilter.onchange = function(){ filterMode=this.value; try{GM_setValue('ph_filter',filterMode);}catch(e){} renderInterface(data); };

        // AUTO-REFRESH — bật/tắt tự làm mới cache mỗi N phút (không spam force-check).
        const btnAuto = c.querySelector('#ph-auto');
        if (btnAuto) btnAuto.onclick = function(e){
            e.stopPropagation();
            autoRefreshOn = !autoRefreshOn;
            try { GM_setValue('ph_autorefresh', autoRefreshOn); } catch(err){}
            setAutoRefresh(autoRefreshOn);
            this.classList.toggle('ph-auto-on', autoRefreshOn);
            this.textContent = autoRefreshOn ? '⏸️' : '🔄';
            showToast(autoRefreshOn ? `Tự làm mới mỗi ${AUTO_REFRESH_MIN} phút` : 'Đã tắt tự làm mới');
        };

        // THANH HÀNH ĐỘNG BD
        const bCopy = c.querySelector('#ph-copy-bd');
        if (bCopy) bCopy.onclick = function(){
            GM_setClipboard(buildBdSummary(data));
            const o=this.textContent; this.textContent='✓ Đã copy'; this.classList.add('ok');
            setTimeout(()=>{ this.textContent=o; this.classList.remove('ok'); }, 1800);
        };
        const bCsv = c.querySelector('#ph-csv');
        if (bCsv) bCsv.onclick = function(){ downloadCsv(data); };
        const bOpen = c.querySelector('#ph-open-cheaper');
        if (bOpen) bOpen.onclick = function(){
            const n = openCheaperTabs(data);
            const o=this.textContent; this.textContent = n?`↗ Mở ${n} tab`:'Không có';
            setTimeout(()=>{ this.textContent=o; }, 1800);
        };
    }

    // ========== RENDER INTERFACE ==========
    function renderInterface(data) {
        const c = makeRoot();
        let lower=0,higher=0,equal=0;
        if(Array.isArray(data.competitors)){
            data.competitors.forEach(comp=>{
                const d=Number(data.my_price)-Number(comp.price||0);
                if(d>0)lower++;else if(d<0)higher++;else equal++;
            });
        }
        if(isCollapsed) renderCollapsed(c,lower,higher,equal,data);
        else renderExpanded(c,data);
    }

    // ========== CORE ==========
    function init() {
        window.addEventListener("message",e=>{ if(e.data==="PRICEHAWK_LOGIN_SUCCESS") window.location.reload(); });
        window.addEventListener("focus",()=>{
            const btn=document.getElementById('ph-login-btn');
            if(btn&&btn.dataset.waiting){ btn.textContent="Đang kiểm tra…"; checkLoginAndReload(); }
        });
        setTimeout(checkPrice, 1500);

        // Chỉ chạy lại khi ĐỔI SANG SẢN PHẨM KHÁC (canonUrl khác), có debounce để
        // gom nhiều lần replaceState liên tiếp lúc SPA hydrate thành 1 lần → hết nháy.
        let lastCanon = canonUrl(location.href);
        let urlChangeTimer = null;
        const onUrlMaybeChanged = () => {
            const now = canonUrl(location.href);
            if (now === lastCanon) return;           // cùng sản phẩm (chỉ đổi query/"/") → bỏ qua
            clearTimeout(urlChangeTimer);
            urlChangeTimer = setTimeout(() => {
                if (canonUrl(location.href) === lastCanon) return;
                lastCanon = canonUrl(location.href);
                currentUrl = location.href;
                removeOverlay();
                checkPrice();
            }, 400);
        };

        if('onurlchange' in window) {
            window.onurlchange = onUrlMaybeChanged;
        } else {
            new MutationObserver(onUrlMaybeChanged).observe(document, { subtree:true, childList:true });
        }
    }

    function checkLoginAndReload() {
        const p=isFptSite?{fpt_url:window.location.href}:{current_url:window.location.href};
        GM_xmlhttpRequest({ method:"GET", url:buildUrl(API_ENDPOINT,p), onload(r){ if(r.status===200&&safeJson(r.responseText)) window.location.reload(); }, onerror(){} });
    }

    function startLoginPolling() {
        if(loginInterval) clearInterval(loginInterval);
        let tries=0;
        loginInterval=setInterval(()=>{
            tries++;
            // Dừng poll sau ~5 phút (150 lần) để không chạy vô hạn.
            if(tries>150){ clearInterval(loginInterval); loginInterval=null; return; }
            const p=isFptSite?{fpt_url:window.location.href}:{current_url:window.location.href};
            GM_xmlhttpRequest({ method:"GET", url:buildUrl(API_ENDPOINT,p), timeout:15000,
                onload(r){ if(r.status===200&&safeJson(r.responseText)){ clearInterval(loginInterval); loginInterval=null; checkPrice(); } },
                onerror(){}, ontimeout(){} });
        },2000);
    }

    function isProductPage() {
        if(isFptSite&&document.getElementById('advanced-filter')) return false;
        if(!isFptSite){ const c=(window.location.pathname.split('?')[0]||'/').replace(/\/+$/,''); if(c===''||c==='/') return false; return true; }
        return !!(document.getElementById('price-product')||document.querySelector('.st-price__main,.product-info'));
    }

    function checkPrice() {
        // Huỷ vòng dò trang cũ (nếu người dùng đổi trang khi lần trước chưa xong) để
        // không có 2 setInterval cùng render → tránh nháy/đè panel.
        if (checkPrice._loop) { clearInterval(checkPrice._loop); checkPrice._loop = null; }
        const url=window.location.href;
        let att=0;
        // show skeleton immediately
        renderSkeleton();
        const loop=checkPrice._loop=setInterval(()=>{
            att++;
            if(isProductPage()) {
                clearInterval(loop);
                const p=isFptSite?{fpt_url:url,t:Date.now()}:{current_url:url,t:Date.now()};
                GM_xmlhttpRequest({
                    method:"GET", url:buildUrl(API_ENDPOINT,p), timeout:20000,
                    onload(r){
                        // Chưa đăng nhập Cloudflare Access → hiện màn Đăng nhập (không phải lỗi kết nối)
                        if(isCfLogin(r)){ renderLoginRequest(); return; }
                        if(r.status===200){ const d=safeJson(r.responseText,null); if(d){
                            // Lỗi link chưa map — hiện inline thay vì alert chặn UI
                            if(d.status==='error'&&d.message){
                                removeOverlay();
                                const c=makeRoot();
                                const hdr=makeHeader(false); c.appendChild(hdr);
                                makeDraggable(c,hdr);
                                hdr.querySelector('#ph-min').onclick=e=>{e.stopPropagation();c.remove();};
                                const body=document.createElement('div');
                                body.style.cssText='padding:20px;text-align:center;';
                                body.innerHTML=`<div style="font-size:24px;margin-bottom:10px">⚠️</div><div style="font-size:13px;color:#64748b;line-height:1.5">${d.message}</div>`;
                                c.appendChild(body); c.appendChild(makeFooter());
                                return;
                            }
                            // Không có gì để hiển thị (found:false, không giá, không đối thủ).
                            const isEmpty = !d.found && !d.my_price && !(d.competitors&&d.competitors.length);
                            if(isEmpty){
                                if(isFptSite) renderMissingUI();
                                else renderUnmappedUI(d.message);  // trang đối thủ: báo rõ chưa map
                                return;
                            }
                            renderInterface(d);return;
                        }
                            // 200 nhưng body hỏng → lỗi máy chủ, KHÔNG phải chưa đăng nhập
                            renderConnError('Máy chủ trả về dữ liệu không hợp lệ.');return; }
                        if(r.status===403||r.status===401){renderLoginRequest();return;}
                        // status 0 = mạng lỗi/CORS; 5xx = server lỗi → báo lỗi kết nối
                        renderConnError(r.status?`Máy chủ báo lỗi (${r.status}).`:null);
                    },
                    onerror(r){ if(isCfLogin(r)){ renderLoginRequest(); return; } renderConnError(); },
                    ontimeout(){ renderConnError('Máy chủ phản hồi quá lâu (timeout).'); }
                });
                return;
            }
            if(document.getElementById('advanced-filter')){ clearInterval(loop); removeOverlay(); return; }
            if(att>=20){ clearInterval(loop); removeOverlay(); }
        },500);
    }

    function handleForceCheck(btn) {
        if(!btn)return;
        btn.disabled=true; btn.textContent="⏳";
        GM_xmlhttpRequest({
            method:"GET", url:buildUrl(API_FORCE_CHECK,{url:window.location.href}), timeout:60000,
            onload(r){
                const d=safeJson(r.responseText,null);
                if(!d){btn.textContent="❌";btn.disabled=false;alert("Server lỗi.");return;}
                if(d.status==='success'){btn.textContent="✓";btn.style.background="#16a34a";setTimeout(()=>{removeOverlay();checkPrice();},1200);}
                else if(d.status==='rate_limited'||r.status===429){alert(d.message||"Vui lòng đợi.");btn.textContent="⚡ Check";btn.disabled=false;}
                else{alert("Lỗi: "+(d.message||"Unknown"));btn.textContent="❌";setTimeout(()=>{removeOverlay();checkPrice();},1200);}
            },
            onerror(){alert("Lỗi kết nối!");btn.textContent="❌";btn.disabled=false;},
            ontimeout(){alert("Máy chủ phản hồi quá lâu, thử lại sau.");btn.textContent="⚡ Check";btn.disabled=false;}
        });
    }

    function fetchHistory(dateStr) {
        const listDiv=document.querySelector('#ph-root .ph-list');
        if(listDiv) listDiv.innerHTML=`<div class="ph-empty">⏳ Đang tải ${dateStr}…</div>`;
        GM_xmlhttpRequest({
            method:"GET", url:buildUrl(API_HISTORY,{url:window.location.href,date:dateStr}), timeout:20000,
            onload(r){
                if(r.status===200){const res=safeJson(r.responseText,null);if(res&&res.status==='success'&&res.data&&res.data[0]){
                    let d=res.data[0];
                    // Unwrap data_json (API history trả về object lồng)
                    const inner = d.data_json;
                    if(inner&&typeof inner==='object'){
                        d=Object.assign({},inner,{
                            is_history:true,
                            history_date:dateStr,
                            _recorded_at:d._recorded_at||d.created_at||''
                        });
                    }else if(inner&&typeof inner==='string'){
                        try{
                            const parsed=JSON.parse(inner);
                            d=Object.assign({},parsed,{
                                is_history:true,
                                history_date:dateStr,
                                _recorded_at:d._recorded_at||d.created_at||''
                            });
                        }catch(e){d.is_history=true;d.history_date=dateStr;}
                    }else{
                        d.is_history=true;d.history_date=dateStr;
                    }
                    renderInterface(d);return;}}
                alert(`Không có dữ liệu ngày ${dateStr}.`);
                const p=document.getElementById('ph-date');if(p)p.value=today();
                removeOverlay();checkPrice();
            },
            onerror(){ const l=document.querySelector('#ph-root .ph-list'); if(l) l.innerHTML=`<div class="ph-empty">🌐 Lỗi kết nối khi tải lịch sử. Thử lại sau.</div>`; },
            ontimeout(){ const l=document.querySelector('#ph-root .ph-list'); if(l) l.innerHTML=`<div class="ph-empty">⏱️ Tải lịch sử quá lâu (timeout).</div>`; }
        });
    }

    init();
})();