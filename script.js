(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tabs = [...document.querySelectorAll('.tab-btn')];
  const sections = ['upload', 'scan', 'browser'].reduce((o, id) => (o[id] = $(id), o), {});
  const state = { active: 'upload', stream: null, raf: 0, lastData: '', history: [], historyIndex: -1 };

  const copy = async (text, button) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1200);
  };

  const parseQRData = (raw) => {
    raw = String(raw || '').trim();
    if (!raw) return { type: 'Empty', issuer: '—', content: '' };
    if (/^otpauth:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const path = decodeURIComponent(url.pathname.slice(1));
        const issuerPath = path.includes(':') ? path.split(':')[0] : '';
        const issuer = url.searchParams.get('issuer') || issuerPath || 'Unknown';
        const secret = url.searchParams.get('secret') || '';
        const kind = url.hostname.toLowerCase() === 'hotp' ? 'Authenticator (HOTP)' : 'Authenticator (TOTP)';
        return { type: kind, issuer, content: secret.toUpperCase() || raw };
      } catch { return { type: 'OTPAuth URL', issuer: 'Unknown', content: raw }; }
    }
    if (/^wifi:/i.test(raw)) {
      const fields = {};
      raw.slice(5).split(';').forEach(part => { const i = part.indexOf(':'); if (i > -1) fields[part.slice(0, i).toUpperCase()] = part.slice(i + 1); });
      return { type: 'Wi-Fi', issuer: fields.S || 'Unknown network', content: fields.P || raw };
    }
    if (/^(https?|ftp):\/\//i.test(raw)) {
      try { const url = new URL(raw); return { type: 'URL', issuer: url.hostname, content: raw }; }
      catch { return { type: 'URL', issuer: 'Invalid URL', content: raw }; }
    }
    if (/^(BEGIN:VCARD|MECARD:)/i.test(raw)) return { type: 'Contact', issuer: 'vCard', content: raw };
    if (/^mailto:/i.test(raw)) return { type: 'Email', issuer: 'Mail', content: raw };
    if (/^tel:/i.test(raw)) return { type: 'Phone', issuer: 'Telephone', content: raw };
    return { type: 'Text / Other', issuer: 'QR data', content: raw };
  };

  const renderResult = (prefix, data, error = '') => {
    const box = $(prefix + 'Result');
    box.classList.remove('hidden');
    if (error) {
      $(prefix + 'Type').textContent = 'Could not decode';
      $(prefix + 'Issuer').textContent = 'Error';
      $(prefix + 'Seed').textContent = error;
      return;
    }
    const p = parseQRData(data);
    $(prefix + 'Type').textContent = p.type;
    $(prefix + 'Issuer').textContent = p.issuer || '—';
    $(prefix + 'Seed').textContent = p.content || '—';
    const btn = $(prefix + 'CopyBtn');
    btn.onclick = () => copy(p.content, btn);
  };

  tabs.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  function switchTab(tab) {
    if (!sections[tab] || tab === state.active) return;
    stopScan();
    state.active = tab;
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    Object.entries(sections).forEach(([id, el]) => el.classList.toggle('active', id === tab));
    if (tab === 'scan') startScan();
  }

  const fileInput = $('fileInput');
  const uploadArea = $('uploadArea');
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragging'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragging'));
  uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.classList.remove('dragging'); const file = e.dataTransfer.files[0]; if (file) decodeFile(file); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) decodeFile(fileInput.files[0]); fileInput.value = ''; });

  function decodeFile(file) {
    if (!file.type.startsWith('image/')) { renderResult('result', '', 'Please choose an image file.'); return; }
    $('uploadStatus').textContent = 'Decoding locally…';
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1600, scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.jsQR?.(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
          if (!code?.data) { $('uploadStatus').textContent = 'No QR code found in that image.'; renderResult('result', '', 'No QR code found. Try a clearer or larger image.'); return; }
          $('uploadStatus').textContent = 'Decoded successfully.';
          renderResult('result', code.data);
        } catch (err) { $('uploadStatus').textContent = 'Decode failed.'; renderResult('result', '', err.message || 'Unable to decode image.'); }
      };
      img.onerror = () => { $('uploadStatus').textContent = 'Image could not be opened.'; renderResult('result', '', 'Invalid or unsupported image.'); };
      img.src = e.target.result;
    };
    reader.onerror = () => renderResult('result', '', 'Could not read the selected file.');
    reader.readAsDataURL(file);
  }

  async function startScan() {
    if (state.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) { $('scanStatus').textContent = 'Camera is not supported in this browser.'; return; }
    $('scanStatus').textContent = 'Requesting camera…';
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      $('video').srcObject = state.stream;
      await $('video').play();
      $('cameraBtn').textContent = 'Stop camera';
      $('scanStatus').textContent = 'Point your camera at a QR code';
      scanLoop();
    } catch (err) {
      state.stream = null;
      $('cameraBtn').textContent = 'Start camera';
      $('scanStatus').textContent = err.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Camera unavailable.';
    }
  }

  function stopScan() {
    if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0;
    state.stream?.getTracks().forEach(t => t.stop()); state.stream = null;
    const video = $('video'); video.pause(); video.srcObject = null;
    $('cameraBtn').textContent = 'Start camera';
    const c = $('scanOverlay'); c.width = c.clientWidth; c.height = c.clientHeight; c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
  $('cameraBtn').addEventListener('click', () => state.stream ? stopScan() : startScan());

  function scanLoop() {
    if (!state.stream) return;
    state.raf = requestAnimationFrame(scanLoop);
    const video = $('video');
    if (video.readyState < 2 || !video.videoWidth) return;
    const canvas = $('scanCanvas') || Object.assign(document.createElement('canvas'), { id: 'scanCanvas' });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx.drawImage(video, 0, 0);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR?.(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
    const overlay = $('scanOverlay'); overlay.width = overlay.clientWidth; overlay.height = overlay.clientHeight; const ov = overlay.getContext('2d'); ov.clearRect(0,0,overlay.width,overlay.height);
    if (!code?.location) return;
    const pts = code.location; const sx = overlay.width / canvas.width, sy = overlay.height / canvas.height;
    ov.beginPath(); ov.moveTo(pts.topLeftCorner.x*sx, pts.topLeftCorner.y*sy); ov.lineTo(pts.topRightCorner.x*sx,pts.topRightCorner.y*sy); ov.lineTo(pts.bottomRightCorner.x*sx,pts.bottomRightCorner.y*sy); ov.lineTo(pts.bottomLeftCorner.x*sx,pts.bottomLeftCorner.y*sy); ov.closePath(); ov.lineWidth=3; ov.strokeStyle='#fff'; ov.stroke();
    if (code.data !== state.lastData) { state.lastData = code.data; renderResult('scan', code.data); $('scanStatus').textContent='QR code detected'; if (navigator.vibrate) navigator.vibrate(25); }
  }

  $('clearBtn').addEventListener('click', () => {
    $('uploadResult').classList.add('hidden'); $('scanResult').classList.add('hidden'); $('uploadStatus').textContent='Ready to decode'; state.lastData='';
    $('browserFrame').src='about:blank'; $('browserFrame').style.display='none'; $('browserEmpty').style.display='flex';
  });

  const frame = $('browserFrame'), empty = $('browserEmpty'), urlInput = $('browserUrl');
  function normalizeUrl(value) {
    const v = value.trim(); if (!v) return '';
    if (/^(https?|about):/i.test(v)) return v;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return 'https://' + v;
    return 'https://www.google.com/search?q=' + encodeURIComponent(v);
  }
  function navigate(value, push=true) {
    const url = normalizeUrl(value); if (!url) return;
    if (push) { state.history = state.history.slice(0, state.historyIndex + 1); state.history.push(url); state.historyIndex++; }
    urlInput.value=url; frame.src=url; frame.style.display='block'; empty.style.display='none';
  }
  $('browserForm').addEventListener('submit', e => { e.preventDefault(); navigate(urlInput.value); });
  $('browserReload').addEventListener('click', () => { if (frame.src && frame.src !== 'about:blank') frame.src = frame.src; });
  $('browserBack').addEventListener('click', () => { if (state.historyIndex > 0) { state.historyIndex--; navigate(state.history[state.historyIndex], false); } });
  $('browserForward').addEventListener('click', () => { if (state.historyIndex < state.history.length - 1) { state.historyIndex++; navigate(state.history[state.historyIndex], false); } });
  frame.src='about:blank'; frame.style.display='none';
})();
