(function() {
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = {
    upload: document.getElementById('upload'),
    scan: document.getElementById('scan')
  };
  const fileInput = document.getElementById('fileInput');
  const uploadArea = document.getElementById('uploadArea');
  const uploadResult = document.getElementById('uploadResult');
  const resultBadge = document.getElementById('resultBadge');
  const resultOrigin = document.getElementById('resultOrigin');
  const resultSeed = document.getElementById('resultSeed');
  const resultFull = document.getElementById('resultFull');
  const copyBtn = document.getElementById('copyBtn');
  const copyStatus = document.getElementById('copyStatus');

  const video = document.getElementById('video');
  const scanOverlay = document.getElementById('scanOverlay');
  const scanStatus = document.getElementById('scanStatus');
  const scanResult = document.getElementById('scanResult');
  const scanBadge = document.getElementById('scanBadge');
  const scanOrigin = document.getElementById('scanOrigin');
  const scanSeed = document.getElementById('scanSeed');
  const scanFull = document.getElementById('scanFull');
  const scanCopyBtn = document.getElementById('scanCopyBtn');
  const scanCopyStatus = document.getElementById('scanCopyStatus');

  let activeTab = 'upload';
  let scanStream = null;
  let scanFrameId = null;
  let scanDecodeTimer = null;
  let lastCopiedSeed = null;

  // Tab switching
  tabs.forEach(btn => {
    btn.addEventListener('click', function() {
      const tab = this.dataset.tab;
      if (tab === activeTab) return;
      tabs.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      Object.keys(contents).forEach(k => {
        contents[k].classList.toggle('active', k === tab);
      });
      activeTab = tab;
      if (tab === 'scan') startScan();
      else stopScan();
    });
  });

  // Upload
  uploadArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFile);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      const img = new Image();
      img.onload = function() {
        decodeQRFromImage(img);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  }

  function decodeQRFromImage(img) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const size = 600;
    canvas.width = size;
    canvas.height = size;
    ctx.drawImage(img, 0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size);
    let code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code && code.data) {
      showUploadResult(code.data);
    } else {
      code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });
      if (code && code.data) {
        showUploadResult(code.data);
      } else {
        showUploadResult(null, 'No QR code found');
      }
    }
  }

  function showUploadResult(data, error) {
    uploadResult.classList.remove('hidden');
    if (error) {
      resultBadge.textContent = 'Error';
      resultBadge.className = 'result-badge text';
      resultOrigin.textContent = '-';
      resultSeed.textContent = error;
      resultSeed.style.color = '#f55';
      resultFull.textContent = '';
      copyBtn.disabled = true;
      return;
    }
    const parsed = parseQRData(data);
    resultBadge.textContent = parsed.badge;
    resultBadge.className = 'result-badge ' + parsed.badgeClass;
    resultOrigin.textContent = parsed.origin;
    resultSeed.textContent = parsed.seed;
    resultSeed.style.color = '#0f0';
    resultFull.textContent = parsed.raw;
    copyBtn.disabled = false;
    copyStatus.classList.add('hidden');
    lastCopiedSeed = parsed.seed;
  }

  // Copy button (one-time)
  function setupCopy(btn, statusEl, getSeed) {
    btn.addEventListener('click', function() {
      if (this.disabled) return;
      const seed = getSeed();
      if (!seed) return;
      navigator.clipboard.writeText(seed).then(() => {
        this.disabled = true;
        statusEl.classList.remove('hidden');
      }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = seed;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this.disabled = true;
        statusEl.classList.remove('hidden');
      });
    });
  }

  setupCopy(copyBtn, copyStatus, () => resultSeed.textContent);
  setupCopy(scanCopyBtn, scanCopyStatus, () => scanSeed.textContent);

  // QR parser with badge/origin
  function parseQRData(raw) {
    // OTPAuth
    if (raw.startsWith('otpauth://')) {
      try {
        const url = new URL(raw);
        const path = url.pathname.slice(1);
        const parts = path.split(':');
        const issuerFromPath = parts.length > 1 ? parts[0] : '';
        const secret = url.searchParams.get('secret') || '';
        const issuerFromParam = url.searchParams.get('issuer') || '';
        const issuer = issuerFromParam || issuerFromPath || 'Authenticator';
        return {
          badge: 'TOTP',
          badgeClass: 'auth',
          origin: issuer,
          seed: secret.toUpperCase() || raw,
          raw: raw
        };
      } catch (_) {
        return { badge: 'OTPAuth', badgeClass: 'auth', origin: 'Malformed', seed: raw, raw };
      }
    }
    // URL
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const url = new URL(raw);
        return {
          badge: 'URL',
          badgeClass: 'url',
          origin: url.hostname,
          seed: raw,
          raw: raw
        };
      } catch (_) {
        return { badge: 'URL', badgeClass: 'url', origin: 'Invalid', seed: raw, raw };
      }
    }
    // Wi-Fi
    if (raw.startsWith('WIFI:')) {
      const ssidMatch = raw.match(/S:([^;]*)/);
      const pskMatch = raw.match(/P:([^;]*)/);
      const ssid = ssidMatch ? ssidMatch[1] : 'Unknown';
      const psk = pskMatch ? pskMatch[1] : '(no PSK)';
      return {
        badge: 'Wi-Fi',
        badgeClass: 'wifi',
        origin: ssid,
        seed: psk,
        raw: raw
      };
    }
    // vCard / MECARD
    if (raw.startsWith('MECARD:') || raw.startsWith('BEGIN:VCARD')) {
      const nameMatch = raw.match(/N:([^;]*)/) || raw.match(/FN:([^;]*)/);
      const name = nameMatch ? nameMatch[1] : 'Contact';
      return {
        badge: 'Contact',
        badgeClass: 'contact',
        origin: name,
        seed: raw.substring(0, 64) + (raw.length > 64 ? '...' : ''),
        raw: raw
      };
    }
    // Plain text
    return {
      badge: 'Text',
      badgeClass: 'text',
      origin: 'Plain',
      seed: raw.length > 80 ? raw.substring(0, 80) + '...' : raw,
      raw: raw
    };
  }

  // Scan
  async function startScan() {
    if (scanStream) return;
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      video.srcObject = scanStream;
      await video.play();
      scanStatus.textContent = 'Scanning...';
      scanResult.classList.add('hidden');
      scanDecodeLoop();
    } catch (err) {
      scanStatus.textContent = 'Camera unavailable: ' + err.message;
    }
  }

  function stopScan() {
    if (scanFrameId) { cancelAnimationFrame(scanFrameId); scanFrameId = null; }
    if (scanDecodeTimer) { clearTimeout(scanDecodeTimer); scanDecodeTimer = null; }
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    video.srcObject = null;
    scanStatus.textContent = 'Camera stopped';
    const ctx = scanOverlay.getContext('2d');
    ctx.clearRect(0, 0, scanOverlay.width, scanOverlay.height);
  }

  function scanDecodeLoop() {
    if (!scanStream) return;
    scanFrameId = requestAnimationFrame(scanDecodeLoop);
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });

    const ov = scanOverlay.getContext('2d');
    ov.clearRect(0, 0, scanOverlay.width, scanOverlay.height);
    scanOverlay.width = scanOverlay.clientWidth;
    scanOverlay.height = scanOverlay.clientHeight;

    if (code && code.data) {
      const pts = code.location.points;
      ov.strokeStyle = '#0f0';
      ov.lineWidth = 3;
      ov.beginPath();
      ov.moveTo(pts[0].x * (scanOverlay.width / canvas.width), pts[0].y * (scanOverlay.height / canvas.height));
      for (let i = 1; i < pts.length; i++) {
        ov.lineTo(pts[i].x * (scanOverlay.width / canvas.width), pts[i].y * (scanOverlay.height / canvas.height));
      }
      ov.closePath();
      ov.stroke();

      if (!scanDecodeTimer) {
        scanDecodeTimer = setTimeout(() => {
          scanDecodeTimer = null;
          showScanResult(code.data);
        }, 300);
      }
    } else {
      if (scanDecodeTimer) { clearTimeout(scanDecodeTimer); scanDecodeTimer = null; }
      scanStatus.textContent = 'Scanning...';
    }
  }

  function showScanResult(data) {
    const parsed = parseQRData(data);
    scanResult.classList.remove('hidden');
    scanBadge.textContent = parsed.badge;
    scanBadge.className = 'result-badge ' + parsed.badgeClass;
    scanOrigin.textContent = parsed.origin;
    scanSeed.textContent = parsed.seed;
    scanSeed.style.color = '#0f0';
    scanFull.textContent = parsed.raw;
    scanCopyBtn.disabled = false;
    scanCopyStatus.classList.add('hidden');
    scanStatus.textContent = 'Decoded';
    if (navigator.vibrate) navigator.vibrate(30);
  }

  window.addEventListener('beforeunload', stopScan);
  if (document.querySelector('#scan.active')) startScan();
})();
