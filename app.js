/* Remo site — request form.
   Flow: pick category → describe (+ optional photos) → phone → time → submit.
   Photos go to the private `web-requests` bucket first (anon insert only), then the
   request is created through the rate-limited submit_web_request() RPC (migration 0057).
   Ops gets a push and calls the client back; see docs/WEB-SITE.md. */
(function () {
  'use strict';
  const CFG = window.REMO_CONFIG || {};
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const form = $('#request-form');
  if (!form) return;
  const body = document.body;
  const state = {
    category: '',
    service: '',
    label: '',
    time: 'Сегодня',
    files: [], // { file, url }
    busy: false,
  };

  // ---- Supabase client (UMD from jsdelivr; created lazily so a CDN hiccup doesn't break the page) ----
  let sb = null;
  function client() {
    if (sb) return sb;
    if (!window.supabase || !CFG.supabaseUrl) return null;
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return sb;
  }

  // ---- Category chips ----
  const catChips = $$('#category-chips .chip');
  function selectCategory(chip) {
    catChips.forEach((c) => {
      c.classList.toggle('is-selected', c === chip);
      c.setAttribute('aria-checked', c === chip ? 'true' : 'false');
    });
    state.category = chip.dataset.category || '';
    state.service = chip.dataset.service || '';
    state.label = chip.dataset.label || '';
    updateWhatsAppLinks();
  }
  catChips.forEach((c) => {
    c.setAttribute('role', 'radio');
    c.addEventListener('click', () => selectCategory(c));
  });
  // Preselect from the page (category landing) or default to the first chip.
  const preCat = body.dataset.category;
  const preSvc = body.dataset.service;
  const preChip =
    catChips.find((c) => c.dataset.category === preCat && (c.dataset.service || '') === (preSvc || '')) ||
    catChips.find((c) => c.dataset.category === preCat) ||
    catChips[0];
  selectCategory(preChip);

  // ---- Time chips ----
  const timeChips = $$('#time-chips .chip');
  timeChips.forEach((c) => {
    c.setAttribute('role', 'radio');
    c.addEventListener('click', () => {
      timeChips.forEach((x) => x.classList.toggle('is-selected', x === c));
      state.time = c.dataset.time || '';
    });
  });

  // ---- Phone: keep +996 and format as +996 XXX XXX XXX ----
  const phone = $('#phone');
  // Local habit is "0700 123 456"; the trunk 0 must never survive after +996.
  function normalizePhone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d.startsWith('996')) d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
    return /^[1-9]\d{8}$/.test(d) ? '+996' + d : null;
  }
  function formatPhone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d.startsWith('996')) d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
    d = d.slice(0, 9);
    const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean);
    return d ? '+996 ' + parts.join(' ') : '';
  }
  phone.addEventListener('focus', () => {
    if (!phone.value) phone.value = '+996 ';
  });
  phone.addEventListener('input', () => {
    const caretAtEnd = phone.selectionStart === phone.value.length;
    phone.value = formatPhone(phone.value);
    if (caretAtEnd) phone.setSelectionRange(phone.value.length, phone.value.length);
    phone.classList.remove('is-invalid');
  });
  phone.addEventListener('blur', () => {
    if (phone.value.trim() === '+996') phone.value = '';
  });

  // ---- Photos: preview, cap, client-side downscale to ≤1600px JPEG ----
  const photoInput = $('#photos');
  const previews = $('#photo-previews');
  const MAX = Number(CFG.maxPhotos || 3);
  function renderPreviews() {
    previews.innerHTML = '';
    state.files.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      const img = document.createElement('img');
      img.src = f.url;
      img.alt = 'Фото ' + (i + 1);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Убрать фото');
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        URL.revokeObjectURL(f.url);
        state.files.splice(i, 1);
        renderPreviews();
      });
      wrap.append(img, rm);
      previews.appendChild(wrap);
    });
  }
  photoInput.addEventListener('change', () => {
    const incoming = Array.from(photoInput.files || []).filter((f) => f.type.startsWith('image/'));
    for (const file of incoming) {
      if (state.files.length >= MAX) break;
      state.files.push({ file, url: URL.createObjectURL(file) });
    }
    photoInput.value = '';
    renderPreviews();
  });

  function downscale(file) {
    return new Promise((resolve) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(file); // HEIC etc: send as-is
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale === 1 && file.size < 900 * 1024) return resolve(file);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.82);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  async function uploadPhotos() {
    const c = client();
    if (!c || state.files.length === 0) return [];
    const folder = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
    const paths = [];
    for (let i = 0; i < state.files.length; i++) {
      const f = await downscale(state.files[i].file);
      const ext = f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : f.type === 'image/heic' ? 'heic' : 'jpg';
      const path = folder + '/' + (i + 1) + '.' + ext;
      const { error } = await c.storage.from(CFG.photoBucket || 'web-requests').upload(path, f, { contentType: f.type || 'image/jpeg', upsert: false });
      if (error) throw Object.assign(new Error('photo upload failed'), { cause: error });
      paths.push(path);
    }
    return paths;
  }

  // ---- WhatsApp deep links (prefilled with the selected category) ----
  function waUrl(text) {
    const num = String(CFG.whatsapp || '').replace(/\D/g, '');
    return 'https://wa.me/' + num + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  function updateWhatsAppLinks() {
    const what = state.label ? ' Нужен мастер: ' + state.label + '.' : '';
    const text = 'Здравствуйте!' + what + ' Пишу с сайта Remo.';
    ['#wa-link', '#wa-link-sticky', '#wa-link-success'].forEach((id) => {
      const a = $(id);
      if (a) a.href = waUrl(text);
    });
    const m = $('#wa-link-masters');
    if (m) m.href = waUrl('Здравствуйте! Я мастер, хочу подключиться к Remo.');
  }
  updateWhatsAppLinks();

  // ---- Submit ----
  const submitBtn = $('#submit-btn');
  const errorBox = $('#form-error');
  const description = $('#description');
  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
  function friendly(err) {
    const m = String((err && err.message) || '').toLowerCase();
    if (m.includes('invalid phone')) return 'Проверьте номер: нужен кыргызский номер, например +996 555 123 456.';
    if (m.includes('description too short')) return 'Опишите задачу хотя бы парой слов.';
    if (m.includes('too many requests')) return 'Вы уже отправили несколько заявок с этого номера — мы перезвоним. Если срочно, напишите в WhatsApp.';
    if (m.includes('busy')) return 'Сейчас очень много заявок. Попробуйте через минуту или напишите в WhatsApp.';
    if (m.includes('photo upload')) return 'Не удалось загрузить фото. Уберите фото и отправьте заявку без него, или напишите в WhatsApp.';
    return 'Не получилось отправить. Проверьте интернет и попробуйте ещё раз, или напишите в WhatsApp.';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    clearError();

    if (form.website && form.website.value) return; // honeypot

    const desc = description.value.trim();
    if (desc.length < 3) {
      description.classList.add('is-invalid');
      description.focus();
      return showError('Опишите задачу хотя бы парой слов.');
    }
    description.classList.remove('is-invalid');
    const normalized = normalizePhone(phone.value);
    if (!normalized) {
      phone.classList.add('is-invalid');
      phone.focus();
      return showError('Проверьте номер: нужен кыргызский номер, например +996 555 123 456.');
    }

    const c = client();
    if (!c) return showError('Сервис временно недоступен. Напишите в WhatsApp — ответим сразу.');

    state.busy = true;
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    try {
      submitBtn.textContent = state.files.length ? 'Загружаем фото…' : 'Отправляем…';
      const photos = await uploadPhotos();
      submitBtn.textContent = 'Отправляем…';
      const { error } = await c.rpc('submit_web_request', {
        p_phone: normalized,
        p_category: state.category || 'other',
        p_description: desc,
        p_preferred_time: state.time || null,
        p_photos: photos,
        p_service: state.service || null,
        p_name: null,
        p_source: 'site',
        p_page: (body.dataset.page || '/') + (location.search || ''),
      });
      if (error) throw error;

      $('#success-phone').textContent = formatPhone(normalized);
      form.hidden = true;
      const ok = $('#success');
      ok.hidden = false;
      ok.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      showError(friendly(err));
    } finally {
      state.busy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });

  $('#another-btn').addEventListener('click', () => {
    $('#success').hidden = true;
    form.hidden = false;
    description.value = '';
    state.files.forEach((f) => URL.revokeObjectURL(f.url));
    state.files = [];
    renderPreviews();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---- Sticky CTA on mobile once the form is out of view ----
  const sticky = $('#sticky-cta');
  if (sticky && 'IntersectionObserver' in window) {
    sticky.hidden = false;
    const io = new IntersectionObserver(
      (entries) => {
        const formVisible = entries.some((en) => en.isIntersecting);
        sticky.classList.toggle('is-visible', !formVisible && !$('#success').matches(':not([hidden])'));
      },
      { rootMargin: '0px 0px -40% 0px', threshold: 0 },
    );
    io.observe(form);
  }

  // ---- Store buttons: until the apps are listed, route to WhatsApp ----
  $$('[data-store]').forEach((a) => {
    a.addEventListener('click', (e) => {
      if (a.getAttribute('href') === '#') {
        e.preventDefault();
        window.open(waUrl('Здравствуйте! Я мастер, хочу подключиться к Remo.'), '_blank', 'noopener');
      }
    });
  });
})();
