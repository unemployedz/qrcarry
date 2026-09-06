(function() {
  // DOM refs
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = {
    upload: document.getElementById('upload'),
    scan: document.getElementById('scan')
  };
  const fileInput = document.getElementById('fileInput');
  const uploadArea = document.getElementById('uploadArea');
  const uploadResult = document.getElementById('uploadResult');
  const resultType = document.getElementById('resultType');
  const resultIssuer = document.getElementById('resultIssuer');
  const resultSeed = document.getElementById('resultSeed');

  const video = document.getElementById('video');
  const scanOverlay = document.getElementById('scanOverlay');
  const scanStatus = document.getElementById('scanStatus');
  const scanResult = document.getElementById('scanResult');
  const scanType = document.getElementById('scanType');
  const scanIssuer = document.getElementById('scanIssuer');
  const scanSeed = document.getElementById('scanSeed');

  let activeTab = 'upload';
  let scanStream = null;
  let scanFrameId = null;
  let scanDecodeTimer = null;

  // Tab switching
  tabs.forEach(btn => {
    btn.addEventListener('click', function(e) {
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

  // Upload: trigger file picker
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
        showUploadResult(null, 'No QR code found in the image.');
      }
    }
  }

  function showUploadResult(data, error) {
    uploadResult.classList.remove('hidden');
    if (error) {
      resultType.textContent = 'Error';
      resultIssuer.textContent = '-';
      resultSeed.textContent = error;
      return;
    }
    const parsed = parseQRData(data);
    resultType.textContent = parsed.type;
    resultIssuer.textContent = parsed.issuer || '-';
    resultSeed.textContent = parsed.seed || parsed.raw;
    resultSeed.style.color = parsed.seed ? '#0f0' : '#fff';
  }

  // QR data parser
  function parseQRData(raw) {
    if (raw.startsWith('otpauth://')) {
      try {
        const url = new URL(raw);
        const path = url.pathname.slice(1);
        const parts = path.split(':');
        const issuerFromPath = parts.length > 1 ? parts[0] : '';
        const account = parts.length > 1 ? parts[1] : parts[0];
        const secret = url.searchParams.get('secret') || '';
        const issuerFromParam = url.searchParams.get('issuer') || '';
        const issuer = issuerFromParam || issuerFromPath || 'Unknown';
        return {
          type: 'Authenticator (TOTP)',
          issuer: issuer,
          seed: secret.toUpperCase(),
          raw: raw
        };
      } catch (_) {
        return { type: 'OTPAuth URL (malformed)', issuer: '-', seed: raw, raw };
      }
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const url = new URL(raw);
        return {
          type: 'URL',
          issuer: url.hostname,
          seed: raw,
          raw: raw
        };
      } catch (_) {
        return { type: 'URL (invalid)', issuer: '-', seed: raw, raw };
      }
    }
    if (raw.startsWith('WIFI:')) {
      const ssidMatch = raw.match(/S:([^;]*)/);
      const pskMatch = raw.match(/P:([^;]*)/);
      const ssid = ssidMatch ? ssidMatch[1] : '?';
      const psk = pskMatch ? pskMatch[1] : '?';
      return {
        type: 'Wi-Fi',
        issuer: ssid,
        seed: psk,
        raw: raw
      };
    }
    if (raw.startsWith('MECARD:') || raw.startsWith('BEGIN:VCARD')) {
      return {
        type: 'Contact',
        issuer: 'vCard',
        seed: raw.substring(0, 80) + (raw.length > 80 ? '…' : ''),
        raw: raw
      };
    }
    return {
      type: 'Text / Other',
      issuer: '-',
      seed: raw,
      raw: raw
    };
  }

  // Scan tab
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
    if (scanFrameId) {
      cancelAnimationFrame(scanFrameId);
      scanFrameId = null;
    }
    if (scanDecodeTimer) {
      clearTimeout(scanDecodeTimer);
      scanDecodeTimer = null;
    }
    if (scanStream) {
      scanStream.getTracks().forEach(t => t.stop());
      scanStream = null;
    }
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

    // overlay
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
      if (scanDecodeTimer) {
        clearTimeout(scanDecodeTimer);
        scanDecodeTimer = null;
      }
      scanStatus.textContent = 'Scanning...';
    }
  }

  function showScanResult(data) {
    const parsed = parseQRData(data);
    scanResult.classList.remove('hidden');
    scanType.textContent = parsed.type;
    scanIssuer.textContent = parsed.issuer || '-';
    scanSeed.textContent = parsed.seed || parsed.raw;
    scanSeed.style.color = parsed.seed ? '#0f0' : '#fff';
    scanStatus.textContent = 'Decoded';
    if (navigator.vibrate) navigator.vibrate(30);
  }

  window.addEventListener('beforeunload', () => {
    stopScan();
  });

  if (document.querySelector('#scan.active')) {
    startScan();
  }
})();
