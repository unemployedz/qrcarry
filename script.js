(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll('.tab-btn')];
  const sections = ['upload','scan','browser'].reduce((o,id)=>(o[id]=$(id),o),{});
  const state = {active:'upload',stream:null,raf:0,lastData:'',history:[],historyIndex:-1,browserToken:0};

  const copy = async (text, button) => { if(!text)return; try{await navigator.clipboard.writeText(text)}catch{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()} const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200); };
  const parseQRData = raw => { raw=String(raw||'').trim(); if(!raw)return{type:'Empty',issuer:'—',content:''}; if(/^otpauth:\/\//i.test(raw)){try{const u=new URL(raw),p=decodeURIComponent(u.pathname.slice(1)),ip=p.includes(':')?p.split(':')[0]:'',issuer=u.searchParams.get('issuer')||ip||'Unknown',secret=u.searchParams.get('secret')||'',kind=u.hostname.toLowerCase()==='hotp'?'Authenticator (HOTP)':'Authenticator (TOTP)';return{type:kind,issuer,content:secret.toUpperCase()||raw}}catch{return{type:'OTPAuth URL',issuer:'Unknown',content:raw}}} if(/^wifi:/i.test(raw)){const f={};raw.slice(5).split(';').forEach(x=>{const i=x.indexOf(':');if(i>-1)f[x.slice(0,i).toUpperCase()]=x.slice(i+1)});return{type:'Wi-Fi',issuer:f.S||'Unknown network',content:f.P||raw}} if(/^(https?|ftp):\/\//i.test(raw)){try{const u=new URL(raw);return{type:'URL',issuer:u.hostname,content:raw}}catch{return{type:'URL',issuer:'Invalid URL',content:raw}}} if(/^(BEGIN:VCARD|MECARD:)/i.test(raw))return{type:'Contact',issuer:'vCard',content:raw};if(/^mailto:/i.test(raw))return{type:'Email',issuer:'Mail',content:raw};if(/^tel:/i.test(raw))return{type:'Phone',issuer:'Telephone',content:raw};return{type:'Text / Other',issuer:'QR data',content:raw}; };
  const renderResult=(prefix,data,error='')=>{const box=$(prefix+'Result');box.classList.remove('hidden');if(error){$(prefix+'Type').textContent='Could not decode';$(prefix+'Issuer').textContent='Error';$(prefix+'Seed').textContent=error;return}const p=parseQRData(data);$(prefix+'Type').textContent=p.type;$(prefix+'Issuer').textContent=p.issuer||'—';$(prefix+'Seed').textContent=p.content||'—';const b=$(prefix+'CopyBtn');b.onclick=()=>copy(p.content,b)};

  tabs.forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
  function switchTab(tab){if(!sections[tab]||tab===state.active)return;stopScan();state.active=tab;tabs.forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));Object.entries(sections).forEach(([id,e])=>e.classList.toggle('active',id===tab));if(tab==='scan')startScan()}

  const fileInput=$('fileInput'),uploadArea=$('uploadArea');
  uploadArea.addEventListener('dragover',e=>{e.preventDefault();uploadArea.classList.add('dragging')});uploadArea.addEventListener('dragleave',()=>uploadArea.classList.remove('dragging'));uploadArea.addEventListener('drop',e=>{e.preventDefault();uploadArea.classList.remove('dragging');const f=e.dataTransfer.files[0];if(f)decodeFile(f)});fileInput.addEventListener('change',()=>{const f=fileInput.files[0];if(f)decodeFile(f);fileInput.value='' });

  async function fileToImageSource(file){
    let blob=file;
    const type=(file.type||'').toLowerCase();
    const name=(file.name||'').toLowerCase();
    const isHeic=type.includes('heic')||type.includes('heif')||/\.(heic|heif)$/.test(name);
    if(isHeic){
      if(typeof window.heic2any!=='function')throw new Error('HEIC support is still loading. Please try again.');
      const converted=await window.heic2any({blob:file,toType:'image/jpeg',quality:.95});
      blob=Array.isArray(converted)?converted[0]:converted;
    }
    if('createImageBitmap' in window){try{return await createImageBitmap(blob)}catch{}}
    return await new Promise((resolve,reject)=>{const url=URL.createObjectURL(blob),img=new Image();img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('This image format cannot be decoded by this browser.'))};img.src=url});
  }

  async function barcodeDecode(source){
    if(!('BarcodeDetector' in window))return null;
    try{const supported=await BarcodeDetector.getSupportedFormats();if(!supported.includes('qr_code'))return null;const detector=new BarcodeDetector({formats:['qr_code']});const found=await detector.detect(source);return found[0]?.rawValue||null}catch{return null}
  }

  async function decodeFile(file){
    if(!file.type.startsWith('image/')&&!/\.(heic|heif)$/i.test(file.name||'')){renderResult('result','','Please choose a PNG, JPG, WEBP, GIF, BMP, or HEIC image.');return}
    $('uploadStatus').textContent='Preparing image…';
    try{
      const source=await fileToImageSource(file);
      const native=await barcodeDecode(source);if(native){$('uploadStatus').textContent='Decoded successfully.';renderResult('result',native);if(source.close)source.close();return}
      const w=source.width||source.naturalWidth,h=source.height||source.naturalHeight;if(!w||!h)throw new Error('The image has no readable dimensions.');
      const max=2200,scale=Math.min(1,max/Math.max(w,h)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=false;ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const attempts=[];
      const add=(c)=>{try{const d=c.getImageData(0,0,c.canvas.width,c.canvas.height);attempts.push(d)}catch{}};
      add(ctx);
      if(canvas.width<1800&&canvas.height<1800){const big=document.createElement('canvas');const s=Math.min(2,1800/Math.max(canvas.width,canvas.height));big.width=Math.round(canvas.width*s);big.height=Math.round(canvas.height*s);const bc=big.getContext('2d',{willReadFrequently:true});bc.imageSmoothingEnabled=false;bc.drawImage(canvas,0,0,big.width,big.height);add(bc)}
      let code=null;for(const image of attempts){code=window.jsQR?.(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});if(code?.data)break}
      if(source.close)source.close();
      if(!code?.data){$('uploadStatus').textContent='No QR code found.';renderResult('result','','No QR code found. Use the original QR image or a clearer screenshot.');return}
      $('uploadStatus').textContent='Decoded successfully.';renderResult('result',code.data);
    }catch(err){$('uploadStatus').textContent='Decode failed.';renderResult('result','',err?.message||'Unable to decode this image on this device.')}
  }

  async function startScan(){if(state.stream)return;if(!navigator.mediaDevices?.getUserMedia){$('scanStatus').textContent='Camera is not supported in this browser.';return}$('scanStatus').textContent='Requesting camera…';try{state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});$('video').srcObject=state.stream;await $('video').play();$('cameraBtn').textContent='Stop camera';$('scanStatus').textContent='Point your camera at a QR code';scanLoop()}catch(err){state.stream=null;$('cameraBtn').textContent='Start camera';$('scanStatus').textContent=err.name==='NotAllowedError'?'Camera permission was denied.':'Camera unavailable.'}}
  function stopScan(){if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;const v=$('video');v.pause();v.srcObject=null;$('cameraBtn').textContent='Start camera';const c=$('scanOverlay');c.width=c.clientWidth;c.height=c.clientHeight;c.getContext('2d').clearRect(0,0,c.width,c.height)}$('cameraBtn').addEventListener('click',()=>state.stream?stopScan():startScan());
  function scanLoop(){if(!state.stream)return;state.raf=requestAnimationFrame(scanLoop);const v=$('video');if(v.readyState<2||!v.videoWidth)return;const canvas=$('scanCanvas')||Object.assign(document.createElement('canvas'),{id:'scanCanvas'}),ctx=canvas.getContext('2d',{willReadFrequently:true});canvas.width=v.videoWidth;canvas.height=v.videoHeight;ctx.drawImage(v,0,0);const frame=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR?.(frame.data,frame.width,frame.height,{inversionAttempts:'attemptBoth'}),o=$('scanOverlay');o.width=o.clientWidth;o.height=o.clientHeight;const ov=o.getContext('2d');ov.clearRect(0,0,o.width,o.height);if(!code?.location)return;const p=code.location,sx=o.width/canvas.width,sy=o.height/canvas.height;ov.beginPath();ov.moveTo(p.topLeftCorner.x*sx,p.topLeftCorner.y*sy);ov.lineTo(p.topRightCorner.x*sx,p.topRightCorner.y*sy);ov.lineTo(p.bottomRightCorner.x*sx,p.bottomRightCorner.y*sy);ov.lineTo(p.bottomLeftCorner.x*sx,p.bottomLeftCorner.y*sy);ov.closePath();ov.lineWidth=3;ov.strokeStyle='#fff';ov.stroke();if(code.data!==state.lastData){state.lastData=code.data;renderResult('scan',code.data);$('scanStatus').textContent='QR code detected';if(navigator.vibrate)navigator.vibrate(25)}}

  $('clearBtn').addEventListener('click',()=>{$('uploadResult').classList.add('hidden');$('scanResult').classList.add('hidden');$('uploadStatus').textContent='Ready to decode';state.lastData='';resetBrowser()});
  const frame=$('browserFrame'),empty=$('browserEmpty'),urlInput=$('browserUrl'),message=$('browserMessage'),external=$('openExternal');
  function normalizeUrl(value){const v=value.trim();if(!v)return'';if(/^(https?|about):/i.test(v))return v;if(/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v))return'https://'+v;return'https://www.google.com/search?q='+encodeURIComponent(v)}
  function showBrowserError(url){frame.style.display='none';empty.style.display='flex';$('browserTitle').textContent='Site cannot be embedded';message.textContent='The destination blocks iframe embedding. A normal browser tab is required.';external.classList.remove('hidden');external.onclick=()=>window.open(url,'_blank','noopener,noreferrer')}
  function navigate(value,push=true){const url=normalizeUrl(value);if(!url)return;if(push){state.history=state.history.slice(0,state.historyIndex+1);state.history.push(url);state.historyIndex++}urlInput.value=url;external.classList.add('hidden');$('browserTitle').textContent='Loading';message.textContent='Connecting…';empty.style.display='flex';frame.style.display='block';const token=++state.browserToken;frame.src='about:blank';setTimeout(()=>{if(token===state.browserToken)frame.src=url},20)}
  function resetBrowser(){state.browserToken++;frame.src='about:blank';frame.style.display='none';empty.style.display='flex';$('browserTitle').textContent='Browser workspace';message.textContent='Enter a URL above.';external.classList.add('hidden')}
  frame.addEventListener('load',()=>{if(frame.src==='about:blank')return;clearTimeout(navigate.timer);empty.style.display='none';frame.style.display='block'});
  $('browserForm').addEventListener('submit',e=>{e.preventDefault();navigate(urlInput.value)});$('browserReload').addEventListener('click',()=>{if(frame.src&&frame.src!=='about:blank'){const u=urlInput.value;frame.src='about:blank';setTimeout(()=>frame.src=u,20)}});$('browserBack').addEventListener('click',()=>{if(state.historyIndex>0){state.historyIndex--;navigate(state.history[state.historyIndex],false)}});$('browserForward').addEventListener('click',()=>{if(state.historyIndex<state.history.length-1){state.historyIndex++;navigate(state.history[state.historyIndex],false)}});resetBrowser();
})();
