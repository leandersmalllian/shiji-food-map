/* 食迹 · 中国美食地图 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const state = {
    places: [], meta: null, status: 'all', city: 'all', query: '',
    selected: null, onlyGuides: false, markers: new Map(), firstRender: true,
    cloud: false, encrypted: null, bootstrapPhrase: '', lastCloudRefresh: 0,
  };

  let map = null;
  let cluster = null;
  let searchTimer = null;

  const STATUS_LABEL = { eaten: '吃过', wishlist: '想去' };
  const KIND_LABEL = { guide: '收藏合集', find: '店名待补', place: '' };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    setupMap();
    bindEvents();
    setupPwa();
    consumeKeyFromHash();
    try {
      await loadData();
    } catch (err) {
      console.error(err);
      $('#place-list').innerHTML = `<div class="empty-state"><strong>地图没有打开</strong>${state.cloud ? '请检查网络后重试，或点右上角刷新云端。' : '请用 <code>start.command</code> 启动本地服务，或检查 <code>data/places.json</code>。'}</div>`;
      toast('数据加载失败：' + err.message, true);
    }
  }

  /* ---------- map ---------- */
  function setupMap() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      minZoom: 3.5,
      maxZoom: 18,
      zoomSnap: 0.25,
      worldCopyJump: false,
    }).setView([29.2, 112.6], 5);

    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 18,
      attribution: '© 高德地图',
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
      maxClusterRadius: 46,
      disableClusteringAtZoom: 12,
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(cluster);

    map.on('click', () => closeDetail());
    window.addEventListener('resize', () => {
      map.invalidateSize();
      if (window.innerWidth <= 920 && !state.selected) setTimeout(() => fitAll(false), 120);
    }, { passive: true });
  }

  function clusterIcon(clusterGroup) {
    const markers = clusterGroup.getAllChildMarkers();
    const count = markers.length;
    const eaten = markers.filter(m => m.placeStatus === 'eaten').length;
    const wish = markers.filter(m => m.placeStatus === 'wishlist').length;
    const allGuides = markers.every(m => m.placeKind === 'guide');
    const cls = eaten && wish ? 'mixed' : wish ? 'wishlist' : 'eaten';
    const size = Math.round(33 + Math.min(20, Math.log2(count + 1) * 4));
    const label = allGuides ? '篇' : '家';
    return L.divIcon({
      html: `<div class="food-cluster ${cls}" style="width:${size}px;height:${size}px"><span class="c-count">${count}</span><span class="c-label">${label}</span></div>`,
      className: 'food-marker-wrap',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  /* ---------- data ---------- */
  async function loadData() {
    const enc = await fetchEncrypted();
    if (enc) {
      state.cloud = true;
      state.encrypted = enc;
      updateCloudUI();
      const stored = getStoredKey();
      const phrase = state.bootstrapPhrase;
      state.bootstrapPhrase = '';
      if (!stored && !phrase) {
        showLock(enc);
        return false;
      }
      try {
        const rawKey = stored || await deriveKey(phrase, enc);
        const doc = await decryptDoc(enc, rawKey);
        storeKey(rawKey);
        hideLock();
        applyData(doc);
        state.lastCloudRefresh = Date.now();
        registerServiceWorker();
        return true;
      } catch (err) {
        clearKey();
        showLock(enc, '口令不对，或这份数据已经重新加密。请再试一次。');
        return false;
      }
    }

    state.cloud = false;
    updateCloudUI();
    const res = await fetch('data/places.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyData(await res.json());
    return true;
  }

  function applyData(doc) {
    state.meta = doc.meta || {};
    state.places = (doc.places || []).map(p => {
      const lat = Number(p.lat), lng = Number(p.lng);
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
      const gcj = hasCoords ? wgs84ToGcj02(lat, lng) : null;
      return { ...p, _gcj: gcj };
    });
    if (state.city !== 'all' && !state.places.some(p => p.city === state.city)) state.city = 'all';
    if (state.selected && !state.places.some(p => p.id === state.selected)) closeDetail();
    renderStats();
    if (state.cloud) $('#stats-note').textContent += ' · 云端只读';
    render();
    updateCloudUI();
    if (state.firstRender) {
      state.firstRender = false;
      requestAnimationFrame(() => fitAll(false));
      setTimeout(() => { map.invalidateSize(); fitAll(false); }, 350);
    }
    map.invalidateSize();
    maybeShowInstallHint();
  }

  let installHintShown = false;
  function maybeShowInstallHint() {
    if (installHintShown || !state.cloud) return;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isIOS || standalone || localStorage.getItem('shiji.installDismissed') === '1') return;
    if (!$('#lock-screen').hidden) return;
    installHintShown = true;
    setTimeout(() => {
      if ($('#lock-screen').hidden && state.cloud) $('#install-hint').classList.add('show');
    }, 1400);
  }

  async function fetchEncrypted() {
    try {
      const res = await fetch('data/places.enc.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      // 网络失败时优先用内存里上一次成功解密的密文
      if (state.encrypted) return state.encrypted;
      throw err;
    }
  }

  function updateCloudUI() {
    const btn = $('#sync-btn');
    if (!btn) return;
    const span = btn.querySelector('span');
    if (state.cloud) {
      span.textContent = '刷新云端';
      btn.title = '从加密云端拉取最新数据';
      document.body.dataset.mode = 'cloud';
      const note = $('#cloud-help');
      if (note) note.hidden = false;
      const phone = $('#phone-card');
      if (phone) phone.hidden = true;
    } else {
      span.textContent = '同步备忘录';
      btn.title = '同步 Apple 备忘录';
      document.body.dataset.mode = 'local';
      const note = $('#cloud-help');
      if (note) note.hidden = true;
      const phone = $('#phone-card');
      if (phone) phone.hidden = false;
      const steps = $('#help-steps');
      if (steps) steps.hidden = false;
    }
    if (state.cloud) {
      const steps = $('#help-steps');
      if (steps) steps.hidden = true;
    }
  }

  function filteredPlaces() {
    const q = normalize(state.query);
    return state.places.filter(p => {
      if (state.onlyGuides && p.kind !== 'guide') return false;
      if (state.status !== 'all' && p.status !== state.status) return false;
      if (state.city !== 'all' && p.city !== state.city) return false;
      if (!q) return true;
      const name = normalize(p.name);
      const city = normalize(p.city + (p.area || ''));
      const cuisine = normalize((p.cuisine || []).join(' '));
      const dishes = normalize((p.dishes || []).join(' '));
      const address = normalize(p.address || '');
      const note = normalize([p.note, p.source && p.source.title, p.source && p.source.author].filter(Boolean).join(' '));
      const hay = name + city + cuisine + dishes + address + note;
      if (!hay.includes(q)) return false;
      let score = 0;
      if (name.includes(q)) score += 8;
      if (city.includes(q)) score += 5;
      if (cuisine.includes(q)) score += 4;
      if (dishes.includes(q)) score += 3;
      if (note.includes(q)) score += 1;
      p._searchScore = score;
      return true;
    });
  }

  function render() {
    const list = filteredPlaces();
    renderCityStrip();
    renderLegend();
    renderList(list);
    renderMarkers(list);
    if (state.selected && !list.some(p => p.id === state.selected)) closeDetail();
    if (state.selected) markActive(state.selected);
    updateMapSub(list);
  }

  function renderStats() {
    const total = state.places.length;
    const eaten = state.places.filter(p => p.status === 'eaten').length;
    const wish = state.places.filter(p => p.status === 'wishlist' && p.kind !== 'guide').length;
    const guides = state.places.filter(p => p.kind === 'guide').length;
    const cities = new Set(state.places.map(p => p.city)).size;
    const rated = state.places.filter(p => p.status === 'eaten' && p.rating != null).length;
    $('#stat-total').textContent = total;
    $('#stat-eaten').textContent = eaten;
    $('#stat-wishlist').textContent = wish;
    const pending = state.places.filter(p => p.kind !== 'guide' && !p._gcj).length;
    $('#stats-note').textContent = `横跨 ${cities} 个城市 · ${rated} 家评分 · ${pending} 家地址待补`;
    $('#legend-eaten').textContent = eaten;
    $('#legend-wishlist').textContent = wish;
    $('#legend-guide').textContent = guides;
    $('#help-wishlist').textContent = wish;
    $('#help-guides').textContent = guides;
    $('#foot-source').textContent = `Apple 备忘录 ${eaten} 家 + 小红书 ${wish} 家 · ${guides} 篇合集`;
    const located = state.places.filter(p => p._gcj && p.kind !== 'guide').length;
    $('#map-caption').textContent = `${located} 家已定位 · ${pending} 家地址待补 · 点击标记查看详情`;
  }

  function renderCityStrip() {
    const base = state.places.filter(p => {
      if (state.onlyGuides && p.kind !== 'guide') return false;
      if (state.status !== 'all' && p.status !== state.status) return false;
      if (!state.query) return true;
      const q = normalize(state.query);
      return normalize([p.name, p.city, p.area, (p.cuisine || []).join(' '), (p.dishes || []).join(' '), p.address, p.note].join(' ')).includes(q);
    });
    const counts = new Map();
    for (const p of base) counts.set(p.city, (counts.get(p.city) || 0) + 1);
    if (state.city !== 'all' && !counts.has(state.city)) state.city = 'all';
    const cities = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
    const total = base.length;
    const chips = [`<button class="city-chip ${state.city === 'all' ? 'active' : ''}" data-city="all">全部 <b>${total}</b></button>`]
      .concat(cities.map(([city, n]) => `<button class="city-chip ${state.city === city ? 'active' : ''}" data-city="${escapeAttr(city)}">${escapeHtml(city)} <b>${n}</b></button>`));
    const el = $('#city-strip');
    el.innerHTML = chips.join('');
  }

  function renderLegend() {
    $$('.legend-item').forEach(btn => {
      const legend = btn.dataset.legend;
      if (legend === 'guide') btn.classList.toggle('active', state.onlyGuides);
      else if (legend === 'eaten') btn.classList.toggle('active', !state.onlyGuides && state.status === 'eaten');
      else if (legend === 'wishlist') btn.classList.toggle('active', !state.onlyGuides && state.status === 'wishlist');
    });
  }

  function updateMapSub(list) {
    if (state.onlyGuides) {
      $('#map-sub').textContent = `${list.length} 篇收藏合集，点开看店单。`;
    } else if (state.city !== 'all') {
      $('#map-sub').textContent = `${state.city} · ${list.length} 家，放大看街区。`;
    } else if (state.query) {
      $('#map-sub').textContent = `“${state.query}” · 找到 ${list.length} 家。`;
    } else {
      $('#map-sub').textContent = `${state.places.length} 家私藏，${new Set(state.places.map(p => p.city)).size} 个城市。`;
    }
    $('#list-count').textContent = state.onlyGuides ? `${list.length} 篇合集` : `${list.length} 家`;
    const randomBtn = $('#random-btn');
    randomBtn.innerHTML = (state.status === 'wishlist' ? '随机去一家' : '随便吃一家') + ' <span aria-hidden="true">↗</span>';
  }

  /* ---------- list ---------- */
  function renderList(list) {
    const el = $('#place-list');
    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><strong>这张桌上还没有菜</strong>换个关键词，或者切回「全部」看看。</div>`;
      return;
    }
    const cityCounts = new Map();
    for (const p of list) cityCounts.set(p.city, (cityCounts.get(p.city) || 0) + 1);
    const cityRank = new Map([...cityCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([c], i) => [c, i]));
    const sorted = [...list].sort((a, b) => {
      const sa = a.status === 'eaten' ? 0 : 1;
      const sb = b.status === 'eaten' ? 0 : 1;
      if (state.query) {
        const qa = a._searchScore || 0, qb = b._searchScore || 0;
        if (qa !== qb) return qb - qa;
      }
      if (sa !== sb) return sa - sb;
      const ka = a.kind === 'guide' ? 1 : 0;
      const kb = b.kind === 'guide' ? 1 : 0;
      if (ka !== kb) return ka - kb;
      if (state.query) {
        if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
      }
      if (sa === 1) {
        const ca = cityRank.get(a.city) ?? 99, cb = cityRank.get(b.city) ?? 99;
        if (ca !== cb) return ca - cb;
      } else if ((b.rating || 0) !== (a.rating || 0)) {
        return (b.rating || 0) - (a.rating || 0);
      }
      return a.city.localeCompare(b.city, 'zh') || a.name.localeCompare(b.name, 'zh');
    });
    el.innerHTML = sorted.map((p, i) => {
      const tags = [];
      if (p.kind === 'guide') tags.push('<span class="mini-tag guide">合集</span>');
      if (p.geo_status === 'pending') tags.push('<span class="mini-tag find">地址待补</span>');
      if (p.geo_status === 'mall') tags.push('<span class="mini-tag">商圈级</span>');
      for (const c of (p.cuisine || []).slice(0, p.kind === 'guide' ? 1 : 2)) tags.push(`<span class="mini-tag">${escapeHtml(c)}</span>`);
      const meta = [p.city, p.area, p.kind === 'guide' ? '攻略合集' : (p.cuisine || [])[0]].filter(Boolean).join(' · ');
      const side = p.kind === 'guide'
        ? `<span class="card-state">合集</span>`
        : p.rating != null && p.status === 'eaten'
          ? `<span class="rating-mini"><span class="star">★</span>${formatRating(p.rating)}</span>`
          : `<span class="card-state">${p.status === 'eaten' ? '吃过' : '想去'}</span>`;
      return `<button class="place-card ${state.selected === p.id ? 'active' : ''}" data-id="${escapeAttr(p.id)}" role="listitem" aria-label="${escapeAttr(p.name)}，${escapeAttr(p.city)}">
        <span class="card-index">${String(i + 1).padStart(2, '0')}</span>
        <span class="card-main">
          <span class="card-top"><span class="card-name">${escapeHtml(p.name)}</span><i class="status-dot ${p.status}"></i></span>
          <span class="card-meta">${escapeHtml(meta)}</span>
          <span class="card-tags">${tags.join('')}</span>
        </span>
        <span class="card-side">${side}</span>
      </button>`;
    }).join('');
  }

  /* ---------- markers ---------- */
  function renderMarkers(list) {
    cluster.clearLayers();
    state.markers.clear();
    const layers = [];
    for (const p of list) {
      if (!p._gcj) continue;
      const isGuide = p.kind === 'guide';
      const isFind = p.kind === 'find';
      const marker = L.marker(p._gcj, {
        icon: markerIcon(p),
        title: p.name,
        alt: `${p.name} · ${p.city}`,
        riseOnHover: true,
        keyboard: true,
      });
      marker.placeStatus = p.status;
      marker.placeKind = p.kind || 'place';
      marker.placeId = p.id;
      marker.bindTooltip(
        `<b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.city)}${p.area ? ' · ' + escapeHtml(p.area) : ''} · ${p.status === 'eaten' ? '吃过' : isGuide ? '合集' : '想去'}</span>`,
        { direction: 'top', offset: [0, -11], className: 'food-tip', opacity: 1 }
      );
      marker.on('click', () => selectPlace(p.id, { fly: false }));
      state.markers.set(p.id, marker);
      layers.push(marker);
    }
    cluster.addLayers(layers);
  }

  function markerIcon(p) {
    const cls = `food-pin ${p.status} ${p.kind || 'place'}`;
    const label = p.kind === 'guide' ? '册' : p.kind === 'find' ? '?' : p.status === 'eaten' ? '吃' : '想';
    return L.divIcon({
      className: 'food-marker-wrap',
      html: `<div class="${cls}"><span>${label}</span></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  /* ---------- detail ---------- */
  function selectPlace(id, opts = {}) {
    const p = state.places.find(x => x.id === id);
    if (!p) return;
    state.selected = id;
    renderDetail(p);
    const detail = $('#detail');
    detail.classList.add('open');
    detail.setAttribute('aria-hidden', 'false');
    markActive(id);
    if (opts.fly !== false) {
      if (p._gcj) {
        const zoom = p.kind === 'guide' ? 10.5 : 15;
        map.flyTo(p._gcj, Math.max(map.getZoom(), zoom), { duration: 0.9 });
      } else {
        const fallback = cityCenter(p.city);
        if (fallback) map.flyTo(fallback, 11, { duration: 0.9 });
      }
    }
    const card = $(`.place-card[data-id="${cssEscape(id)}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function markActive(id) {
    $$('.place-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
    for (const [pid, marker] of state.markers) {
      const el = marker.getElement();
      if (!el) continue;
      const pin = el.querySelector('.food-pin');
      if (pin) pin.classList.toggle('active', pid === id);
    }
  }

  function renderDetail(p) {
    const isGuide = p.kind === 'guide';
    const isFind = p.kind === 'find';
    const statusClass = isGuide ? 'guide' : isFind ? 'find' : p.status;
    const statusText = p.status === 'eaten' ? '吃过' : isGuide ? '想去 · 合集' : isFind ? '想去 · 店名待补' : '想去';
    const pending = p.geo_status === 'pending';
    const addressLine = p.address
      ? `<p class="detail-address ${pending ? 'muted-address' : ''}">${pending ? '大概位置：' : '📍 '}${escapeHtml(p.address)}${pending ? ' · 精确地址待补' : ''}</p>`
      : (isGuide ? `<p class="detail-address muted-address">攻略合集 · 不在地图上标注单一位置</p>` : '');
    const rating = isGuide
      ? `<div class="rating-row"><span class="muted">攻略合集，不参与评分</span></div>`
      : p.rating != null
      ? `<div class="rating-row"><span class="stars"><span>★★★★★</span><span class="stars-fill" style="width:${Math.max(0, Math.min(100, p.rating / 5 * 100))}%">★★★★★</span></span><span class="rating-num">${formatRating(p.rating)}</span><span class="muted">/ 5</span></div>`
      : `<div class="rating-row"><span class="muted">${p.status === 'eaten' ? '备忘录里没有打分' : '收藏待去，尚未打分'}</span></div>`;
    const chips = [
      ...(p.cuisine || []).map(c => `<span class="detail-chip">${escapeHtml(c)}</span>`),
      isGuide ? '<span class="detail-chip">合集</span>' : '',
      isFind ? '<span class="detail-chip">店名待补</span>' : '',
      pending ? '<span class="detail-chip">地址待补</span>' : '',
    ].filter(Boolean).join('');
    const dishes = (p.dishes || []).length
      ? `<div class="detail-section"><h3>${p.status === 'eaten' ? '记得点' : '想试'}</h3><div class="dish-list">${p.dishes.map(d => `<span class="dish">${escapeHtml(d)}</span>`).join('')}</div></div>`
      : '';
    const note = (p.note || '').trim();
    const quote = note ? `<div class="detail-quote">${escapeHtml(note)}</div>` : '';
    const url = p.source && p.source.url;
    const safeUrl = url && /^https:\/\/www\.xiaohongshu\.com\//.test(url) ? url : '';
    const sourceLabel = p.source && p.source.type === 'xiaohongshu' ? '小红书收藏' : 'Apple 备忘录';
    const sourceExtra = p.source && p.source.type === 'xiaohongshu' && p.source.author
      ? ` · @${escapeHtml(p.source.author)}` : '';
    const date = p.status === 'eaten' ? formatDate(p.recorded_at) : (p.source && p.source.published_at ? formatDate(p.source.published_at) : '');
    const dateLabel = p.status === 'eaten' ? '记录于' : '原笔记';
    const raw = p.note_raw && p.note_raw !== p.note
      ? `<details class="raw-note"><summary>查看${p.source && p.source.type === 'xiaohongshu' ? '笔记正文' : '备忘录原文'}</summary><pre>${escapeHtml(p.note_raw)}</pre></details>`
      : '';
    const mapQuery = encodeURIComponent(`${p.name} ${p.address || ''} ${p.city}`.trim());
    const amapUrl = `https://uri.amap.com/search?keyword=${mapQuery}&city=${encodeURIComponent(p.city)}&view=map&callnative=0`;
    const primaryLink = safeUrl
      ? `<a class="detail-btn primary" href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">小红书原文 <span>↗</span></a>`
      : (isGuide ? '' : `<a class="detail-btn primary" href="${escapeAttr(amapUrl)}" target="_blank" rel="noopener noreferrer">高德搜索 <span>↗</span></a>`);
    const secondLink = isGuide
      ? `<span class="detail-btn">这是攻略合集</span>`
      : safeUrl
        ? `<a class="detail-btn" href="${escapeAttr(amapUrl)}" target="_blank" rel="noopener noreferrer">高德搜索</a>`
        : `<span class="detail-btn">${p.address ? '地址见上方' : '地址待补'}</span>`;
    $('#detail-inner').innerHTML = `
      <div class="detail-head">
        <span class="status-pill ${statusClass}"><i></i>${statusText}</span>
        <button class="detail-close" data-close aria-label="关闭详情">×</button>
      </div>
      <div class="detail-kicker">${escapeHtml(p.city)}${p.area ? ' / ' + escapeHtml(p.area) : ''}${isGuide ? ' · GUIDE' : ''}</div>
      <h2>${escapeHtml(p.name)}</h2>
      <p class="detail-sub">${escapeHtml([p.city, p.area, (p.cuisine || []).join(' / ')].filter(Boolean).join(' · '))}</p>
      ${addressLine}
      ${rating}
      ${chips ? `<div class="detail-chips">${chips}</div>` : ''}
      ${quote}
      ${dishes}
      <div class="detail-actions">${primaryLink}${secondLink}</div>
      <div class="detail-meta"><span>${sourceLabel}${sourceExtra}</span><span>${date ? dateLabel + ' ' + date : (p.geo_status === 'pending' ? '地址待补' : p.geo_status === 'mall' ? '商圈级定位' : p.geo_status === 'street' ? '街道级定位' : '地址来自 Apple Maps')}</span></div>
      ${raw}
      <div class="source-line">${p.source && p.source.title ? `原始标题：<b>${escapeHtml(p.source.title)}</b>` : ''}</div>
    `;
  }

  function closeDetail() {
    state.selected = null;
    const detail = $('#detail');
    detail.classList.remove('open');
    detail.setAttribute('aria-hidden', 'true');
    $$('.place-card').forEach(c => c.classList.remove('active'));
    $$('.food-pin.active').forEach(pin => pin.classList.remove('active'));
  }

  /* ---------- view helpers ---------- */
  function fitAll(animate = true) {
    const list = state.places.map(p => p._gcj).filter(Boolean);
    if (!list.length) return;
    if (list.length === 1) {
      map.setView(list[0], 12, { animate });
      return;
    }
    const compact = window.innerWidth <= 920;
    const bounds = L.latLngBounds(list);
    map.fitBounds(bounds, {
      paddingTopLeft: [compact ? 26 : 52, compact ? 78 : 168],
      paddingBottomRight: [compact ? 26 : 52, compact ? 58 : 112],
      maxZoom: compact ? 6 : 6.8,
      animate,
    });
  }

  function cityCenter(city) {
    const pts = state.places.filter(p => p.city === city && p._gcj).map(p => p._gcj);
    if (pts.length) {
      return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    }
    const fallback = {
      '广州': [23.1291, 113.2644], '深圳': [22.5431, 114.0579], '佛山': [23.0215, 113.1214],
      '珠海': [22.2707, 113.5767], '中山': [22.5176, 113.3926], '惠州': [23.1115, 114.4161],
      '香港': [22.3193, 114.1694], '汕头': [23.3541, 116.6819], '潮州': [23.6567, 116.6226],
      '揭阳': [23.5497, 116.3728], '上海': [31.2304, 121.4737], '北京': [39.9042, 116.4074],
      '青岛': [36.0671, 120.3826],
    };
    return fallback[city] || null;
  }

  function fitCity(city) {
    const pts = state.places.filter(p => p.city === city).map(p => p._gcj).filter(Boolean);
    if (!pts.length) return;
    if (pts.length === 1) { map.flyTo(pts[0], 12, { duration: 0.8 }); return; }
    const compact = window.innerWidth <= 920;
    map.flyToBounds(L.latLngBounds(pts), {
      paddingTopLeft: compact ? [24, 66] : [70, 150],
      paddingBottomRight: compact ? [24, 46] : [70, 100],
      maxZoom: compact ? 10.5 : 11.5, duration: 0.85,
    });
  }

  function randomPlace() {
    let list = filteredPlaces().filter(p => p.kind !== 'guide' && p._gcj);
    if (!list.length) list = state.places.filter(p => p.kind !== 'guide' && p._gcj);
    if (!list.length) { toast('还没有可以随机的地方'); return; }
    const pool = state.status === 'all' ? list.filter(p => p.status === 'eaten') : list;
    const finalPool = pool.length ? pool : list;
    const p = finalPool[Math.floor(Math.random() * finalPool.length)];
    selectPlace(p.id, { fly: true });
    toast(`今天就吃：${p.name}`);
  }

  /* ---------- sync ---------- */
  async function syncNotes() {
    if (state.cloud) {
      await refreshCloud(false);
      return;
    }
    if (location.protocol === 'file:') {
      toast('请用 start.command 启动本地服务后再同步', true);
      return;
    }
    const btn = $('#sync-btn');
    if (btn.disabled) return;
    const span = btn.querySelector('span');
    const old = span.textContent;
    btn.disabled = true;
    btn.classList.add('loading');
    span.textContent = '正在翻备忘录…';
    try {
      const res = await fetch('/api/sync', { method: 'POST', headers: { 'Accept': 'application/json' } });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || '同步服务没有响应');
      await loadData();
      const pub = j.publish || {};
      const pubText = pub.ok ? (pub.pushed ? '，已发布到手机端' : (pub.skipped ? '，手机端已是最新' : '，已更新云端')) : '，但云端发布失败（下次会自动重试）';
      if (j.added > 0) {
        toast(`同步完成：新增 ${j.added} 家，更新 ${j.updated} 条${pubText}。`);
        const first = (j.added_names || [])[0];
        if (first) {
          const p = state.places.find(x => x.name === first);
          if (p) selectPlace(p.id, { fly: true });
        }
      } else {
        toast(`已是最新：扫了 ${j.scanned} 条，没有新店${pubText}。`);
      }
    } catch (err) {
      console.error(err);
      toast('同步失败：' + err.message + '。请确认本地服务在运行。', true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
      span.textContent = old;
    }
  }

  async function refreshCloud(silent = false) {
    const btn = $('#sync-btn');
    if (btn.disabled) return;
    const span = btn.querySelector('span');
    const old = span.textContent;
    btn.disabled = true;
    btn.classList.add('loading');
    span.textContent = '正在拉取云端…';
    try {
      const enc = await fetchEncrypted();
      if (!enc) throw new Error('云端还没有加密数据');
      state.encrypted = enc;
      const stored = getStoredKey();
      if (!stored) {
        showLock(enc);
        return;
      }
      let doc;
      try {
        doc = await decryptDoc(enc, stored);
      } catch (err) {
        clearKey();
        showLock(enc, '云端数据已重新加密，请重新输入设备口令。');
        return;
      }
      const before = state.meta && state.meta.synced_at;
      applyData(doc);
      state.lastCloudRefresh = Date.now();
      registerServiceWorker();
      const after = state.meta && state.meta.synced_at;
      if (!silent) toast(before && before === after ? '已经是最新版本。' : '已同步到最新。');
    } catch (err) {
      console.error(err);
      if (!silent) toast('刷新失败：' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
      span.textContent = state.cloud ? '刷新云端' : '同步备忘录';
    }
  }

  /* ---------- encrypted cloud + PWA ---------- */
  function setupPwa() {
    $('#install-dismiss').addEventListener('click', () => {
      localStorage.setItem('shiji.installDismissed', '1');
      $('#install-hint').classList.remove('show');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.cloud && state.meta && Date.now() - state.lastCloudRefresh > 60000) {
        refreshCloud(true);
      }
    });
    $('#lock-form').addEventListener('submit', unlockFromForm);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW', err));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function consumeKeyFromHash() {
    if (!location.hash) return;
    try {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      const key = params.get('key') || params.get('pass') || '';
      if (key) {
        state.bootstrapPhrase = canonicalPhrase(key);
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (e) { /* ignore malformed hash */ }
  }

  function showLock(enc, message = '') {
    state.encrypted = enc;
    $('#lock-screen').hidden = false;
    document.body.classList.add('locked');
    $('#lock-error').textContent = message;
    setTimeout(() => $('#passphrase').focus(), 150);
  }

  function hideLock() {
    $('#lock-screen').hidden = true;
    document.body.classList.remove('locked');
    $('#passphrase').value = '';
    $('#lock-error').textContent = '';
  }

  async function unlockFromForm(event) {
    event.preventDefault();
    if (!state.encrypted) return;
    const input = $('#passphrase');
    const btn = $('#unlock-btn');
    const phrase = input.value.trim();
    if (canonicalPhrase(phrase).length < 6) {
      $('#lock-error').textContent = '口令至少需要 6 个字符。';
      return;
    }
    btn.disabled = true;
    $('#lock-error').textContent = '';
    try {
      const rawKey = await deriveKey(phrase, state.encrypted);
      const doc = await decryptDoc(state.encrypted, rawKey);
      storeKey(rawKey);
      hideLock();
      applyData(doc);
      state.lastCloudRefresh = Date.now();
      registerServiceWorker();
      toast('解密成功，欢迎回来。');
    } catch (err) {
      console.error(err);
      clearKey();
      $('#lock-error').textContent = '口令不对，请再试一次。';
      input.select();
    } finally {
      btn.disabled = false;
    }
  }

  async function deriveKey(phrase, enc) {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(canonicalPhrase(phrase)), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(enc.salt), iterations: Number(enc.iterations) || 200000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, true, ['decrypt']
    );
    return bytesToB64(await crypto.subtle.exportKey('raw', key));
  }

  async function decryptDoc(enc, rawKeyB64) {
    if (!enc || enc.v !== 1 || !enc.data || !enc.iv || !enc.tag) throw new Error('加密数据格式不对');
    const key = await crypto.subtle.importKey('raw', b64ToBytes(rawKeyB64), 'AES-GCM', false, ['decrypt']);
    const data = b64ToBytes(enc.data);
    const tag = b64ToBytes(enc.tag);
    const combined = new Uint8Array(data.byteLength + tag.byteLength);
    combined.set(data, 0);
    combined.set(tag, data.byteLength);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(enc.iv), tagLength: 128 }, key, combined
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function canonicalPhrase(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function getStoredKey() {
    try { return localStorage.getItem('shiji.key') || ''; } catch (e) { return ''; }
  }

  function storeKey(rawKey) {
    try { localStorage.setItem('shiji.key', rawKey); } catch (e) {}
  }

  function clearKey() {
    try { localStorage.removeItem('shiji.key'); } catch (e) {}
  }

  /* ---------- events ---------- */
  function bindEvents() {
    $$('.seg').forEach(btn => {
      btn.addEventListener('click', () => {
        state.status = btn.dataset.status;
        state.onlyGuides = false;
        $$('.seg').forEach(b => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', String(on));
        });
        $('.segmented').style.setProperty('--seg-index', btn.dataset.status === 'all' ? 0 : btn.dataset.status === 'eaten' ? 1 : 2);
        render();
        if (state.city !== 'all') fitCity(state.city); else fitAll();
      });
    });

    $('#city-strip').addEventListener('click', e => {
      const chip = e.target.closest('.city-chip');
      if (!chip) return;
      state.city = chip.dataset.city;
      state.onlyGuides = false;
      render();
      if (state.city === 'all') fitAll(); else fitCity(state.city);
    });

    $('#search').addEventListener('input', e => {
      clearTimeout(searchTimer);
      const val = e.target.value;
      searchTimer = setTimeout(() => {
        state.query = val.trim();
        if (state.query) state.city = 'all';
        render();
        if (!state.query) fitAll(false);
      }, 120);
    });

    $('#place-list').addEventListener('click', e => {
      const card = e.target.closest('.place-card');
      if (!card) return;
      selectPlace(card.dataset.id, { fly: true });
    });

    $('#detail').addEventListener('click', e => {
      if (e.target.closest('[data-close]')) closeDetail();
    });

    $('#random-btn').addEventListener('click', randomPlace);
    $('#reset-view').addEventListener('click', () => {
      state.city = 'all'; state.query = ''; state.onlyGuides = false; state.status = 'all';
      $('#search').value = '';
      $$('.seg').forEach(b => {
        const on = b.dataset.status === 'all';
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      $('.segmented').style.setProperty('--seg-index', 0);
      render();
      fitAll();
    });
    $('#sync-btn').addEventListener('click', syncNotes);
    $$('.help-trigger').forEach(b => b.addEventListener('click', () => $('#help-dialog').showModal()));

    $$('.legend-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.legend;
        if (key === 'guide') {
          state.onlyGuides = !state.onlyGuides;
          state.status = 'all';
          state.query = '';
          $('#search').value = '';
          $$('.seg').forEach(b => {
            b.classList.toggle('active', b.dataset.status === 'all');
            b.setAttribute('aria-selected', String(b.dataset.status === 'all'));
          });
          $('.segmented').style.setProperty('--seg-index', 0);
        } else {
          state.onlyGuides = false;
          state.status = key;
          $$('.seg').forEach(b => {
            b.classList.toggle('active', b.dataset.status === key);
            b.setAttribute('aria-selected', String(b.dataset.status === key));
          });
          $('.segmented').style.setProperty('--seg-index', key === 'eaten' ? 1 : 2);
        }
        render();
        fitAll();
      });
    });

    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (e.key === 'Escape') {
        if ($('#help-dialog').open) $('#help-dialog').close();
        else closeDetail();
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
      if (e.key.toLowerCase() === 'r') randomPlace();
    });
  }

  /* ---------- utils ---------- */
  function normalize(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[·・,，。.!！?？\-—–_/\\()（）]/g, '');
  }

  function formatRating(n) {
    if (n == null) return '';
    return Number(n).toFixed(1).replace(/\.0$/, '');
  }

  function formatDate(v) {
    if (!v) return '';
    if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
      const n = Number(v);
      const d = new Date(n > 999999999999 ? n : n * 1000);
      if (!isNaN(d.getTime())) return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const m = String(v).match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}.${m[2]}` : String(v);
  }

  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3600);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const escapeAttr = escapeHtml;

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* WGS84 → GCJ-02：让标记和国内地图瓦片对齐 */
  function wgs84ToGcj02(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    const a = 6378245.0, ee = 0.00669342162296594323;
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lat + dLat, lng + dLng];
  }
  function outOfChina(lat, lng) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
  function transformLat(x, y) {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return r;
  }
  function transformLng(x, y) {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return r;
  }
})();
