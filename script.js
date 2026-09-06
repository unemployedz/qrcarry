(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll('.tab-btn')];
  const sections = ['upload','scan','browser'].reduce((o,id)=>(o[id]=$(id),o),{});
  const state = {active:'upload',stream:null,raf:0,lastData:'',history:[],historyIndex:-1};

  const copy = async (text, button) => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    const old=button.textContent; button.textContent='Copied'; setTimeout(()=>button.textContent=old,1200);
  };

  const parseQRData = raw => {
    raw=String(raw||'').trim();
    if(!raw) return {type:'Empty',issuer:'—',content:''};
    if(/^otpauth:\/\//i.test(raw)){try{const u=new URL(raw),path=decodeURIComponent(u.pathname.slice(1)),issuerPath=path.includes(':')?path.split(':')[0]:'',issuer=u.searchParams.get('issuer')||issuerPath||'Unknown',secret=u.searchParams.get('secret')||'',kind=u.hostname.toLowerCase()==='hotp'?'Authenticator (HOTP)':'Authenticator (TOTP)';return{type:kind,issuer,content:secret.toUpperCase()||raw};}catch{return{type:'OTPAuth URL',issuer:'Unknown',content:raw};}}
    if(/^wifi:/i.test(raw)){const f={};raw.slice(5).split(';').forEach(p=>{const i=p.indexOf(':');if(i>-1)f[p.slice(0,i).toUpperCase()]=p.slice(i+1)});return{type:'Wi-Fi',issuer:f.S||'Unknown network',content:f.P||raw};}
    if(/^(https?|ftp):\/\//i.test(raw)){try{const u=new URL(raw);return{type:'URL',issuer:u.hostname,content:raw};}catch{return{type:'URL',issuer:'Invalid URL',content:raw};}}
    if(/^(BEGIN:VCARD|MECARD:)/i.test(raw))return{type:'Contact',issuer:'vCard',content:raw};
    if(/^mailto:/i.test(raw))return{type:'Email',issuer:'Mail',content:raw};
    if(/^tel:/i.test(raw))return{type:'Phone',issuer:'Telephone',content:raw};
    return{type:'Text / Other',issuer:'QR data',content:raw};
  };

  const renderResult=(prefix,data,error='')=>{const box=$(prefix+'Result');box.classList.remove('hidden');if(error){$(prefix+'Type').textContent='Could not decode';$(prefix+'Issuer').textContent='Error';$(prefix+'Seed').textContent=error;return;}const p=parseQRData(data);$(prefix+'Type').textContent=p.type;$(prefix+'Issuer').textContent=p.issuer||'—';$(prefix+'Seed').textContent=p.content||'—';const btn=$(prefix+'CopyBtn');btn.onclick=()=>copy(p.content,btn);};

  tabs.forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
  function switchTab(tab){if(!sections[tab]||tab===state.active)return;stopScan();state.active=tab;tabs.forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));Object.entries(sections).forEach(([id,el])=>el.classList.toggle('active',id===tab));if(tab==='scan')startScan();}

  const fileInput=$('fileInput'),uploadArea=$('uploadArea');
  uploadArea.addEventListener('dragover',e=>{e.preventDefault();uploadArea.classList.add('dragging')});
  uploadArea.addEventListener('dragleave',()=>uploadArea.classList.remove('dragging'));
  uploadArea.addEventListener('drop',e=>{e.preventDefault();uploadArea.classList.remove('dragging');const f=e.dataTransfer.files[0];if(f)decodeFile(f)});
  fileInput.addEventListener('change',()=>{const f=fileInput.files?.[0];if(f)decodeFile(f);fileInput.value=''});

  async function fileToUsableBlob(file){
    const name=(file.name||'').toLowerCase(),type=(file.type||'').toLowerCase();
    const heic=type.includes('heic')||type.includes('heif')||/\.(heic|heif)$/.test(name);
    if(heic&&typeof window.heic2any==='function'){
      try{const converted=await window.heic2any({blob:file,toType:'image/jpeg',quality:0.95});return Array.isArray(converted)?converted[0]:converted;}catch{}
    }
    return file;
  }

  async function imageToCanvas(blob){
    const img=new Image(),objectUrl=URL.createObjectURL(blob);
    try{
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('The browser could not open this image.'));img.src=objectUrl;});
      const max=2400,scale=Math.min(1,max/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round((img.naturalWidth||img.width)*scale));canvas.height=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
      canvas.getContext('2d',{willReadFrequently:true}).drawImage(img,0,0,canvas.width,canvas.height);return canvas;
    }finally{URL.revokeObjectURL(objectUrl)}
  }

  async function decodeWithZXing(blob){
    if(!window.ZXing?.BrowserQRCodeReader)return null;
    const url=URL.createObjectURL(blob);
    try{
      const reader=new window.ZXing.BrowserQRCodeReader();
      const result=await reader.decodeFromImageUrl(url);
      return result?.getText?.()||result?.text||null;
    }catch{return null;}finally{URL.revokeObjectURL(url);}
  }

  function decodeCanvas(canvas){
    const ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height);
    const attempts=[image];
    if(canvas.width>1400){const small=document.createElement('canvas'),ratio=1400/canvas.width;small.width=1400;small.height=Math.round(canvas.height*ratio);small.getContext('2d').drawImage(canvas,0,0,small.width,small.height);attempts.push(small.getContext('2d',{willReadFrequently:true}).getImageData(0,0,small.width,small.height));}
    for(const frame of attempts)for(const inversionAttempts of ['attemptBoth','dontInvert']){try{const code=window.jsQR?.(frame.data,frame.width,frame.height,{inversionAttempts,greyScaleWeights:{red:0.299,green:0.587,blue:0.114}});if(code?.data)return code.data;}catch{}}
    return null;
  }

  async function decodeOnServer(file){
    const form=new FormData();form.append('file',file,file.name||'qrcode');
    const response=await fetch('/api/decode',{method:'POST',body:form,headers:{'accept':'application/json'}});
    let payload={};try{payload=await response.json();}catch{}
    if(!response.ok)throw new Error(payload.error||'The server could not decode this image.');
    return payload.data||null;
  }

  async function decodeFile(file){
    if(!file)return;
    $('uploadResult').classList.add('hidden');$('uploadStatus').textContent='Preparing image…';
    try{
      const blob=await fileToUsableBlob(file);
      $('uploadStatus').textContent='Trying local decoders…';
      let data=await decodeWithZXing(blob);
      if(!data){const canvas=await imageToCanvas(blob);data=decodeCanvas(canvas);}
      if(data){$('uploadStatus').textContent='Decoded locally.';renderResult('result',data);return;}
      $('uploadStatus').textContent='Local decode missed it. Using server decoder…';
      data=await decodeOnServer(file);
      if(!data)throw new Error('No QR code could be detected.');
      $('uploadStatus').textContent='Decoded successfully.';renderResult('result',data);
    }catch(err){console.error(err);$('uploadStatus').textContent='Decode failed.';renderResult('result','',err?.message||'Unable to decode this image.');}
  }

  async function startScan(){if(state.stream)return;if(!navigator.mediaDevices?.getUserMedia){$('scanStatus').textContent='Camera is not supported in this browser.';return;}$('scanStatus').textContent='Requesting camera…';try{state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});$('video').srcObject=state.stream;await $('video').play();$('cameraBtn').textContent='Stop camera';$('scanStatus').textContent='Point your camera at a QR code';scanLoop();}catch(err){state.stream=null;$('cameraBtn').textContent='Start camera';$('scanStatus').textContent=err.name==='NotAllowedError'?'Camera permission was denied.':'Camera unavailable.';}}
  function stopScan(){if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;const v=$('video');v.pause();v.srcObject=null;$('cameraBtn').textContent='Start camera';const c=$('scanOverlay');c.width=c.clientWidth;c.height=c.clientHeight;c.getContext('2d').clearRect(0,0,c.width,c.height);}
  $('cameraBtn').addEventListener('click',()=>state.stream?stopScan():startScan());
  function scanLoop(){if(!state.stream)return;state.raf=requestAnimationFrame(scanLoop);const video=$('video');if(video.readyState<2||!video.videoWidth)return;const canvas=$('scanCanvas')||Object.assign(document.createElement('canvas'),{id:'scanCanvas'}),ctx=canvas.getContext('2d',{willReadFrequently:true});canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const frame=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR?.(frame.data,frame.width,frame.height,{inversionAttempts:'attemptBoth'}),overlay=$('scanOverlay');overlay.width=overlay.clientWidth;overlay.height=overlay.clientHeight;const ov=overlay.getContext('2d');ov.clearRect(0,0,overlay.width,overlay.height);if(!code?.location)return;const p=code.location,sx=overlay.width/canvas.width,sy=overlay.height/canvas.height;ov.beginPath();ov.moveTo(p.topLeftCorner.x*sx,p.topLeftCorner.y*sy);ov.lineTo(p.topRightCorner.x*sx,p.topRightCorner.y*sy);ov.lineTo(p.bottomRightCorner.x*sx,p.bottomRightCorner.y*sy);ov.lineTo(p.bottomLeftCorner.x*sx,p.bottomLeftCorner.y*sy);ov.closePath();ov.lineWidth=3;ov.strokeStyle='#fff';ov.stroke();if(code.data!==state.lastData){state.lastData=code.data;renderResult('scan',code.data);$('scanStatus').textContent='QR code detected';if(navigator.vibrate)navigator.vibrate(25);}}

  $('clearBtn').addEventListener('click',()=>{$('uploadResult').classList.add('hidden');$('scanResult').classList.add('hidden');$('uploadStatus').textContent='Ready to decode';state.lastData='';resetBrowser();});

  const frame=$('browserFrame'),empty=$('browserEmpty'),urlInput=$('browserUrl'),message=$('browserMessage'),external=$('openExternal');
  function normalizeUrl(value){let v=String(value||'').trim();if(!v)return'';if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(v))v='https://'+v;try{const u=new URL(v);if(!['http:','https:'].includes(u.protocol))return'';if(u.hostname.toLowerCase()==='roblox.com')u.hostname='www.roblox.com';return u.href;}catch{return'';}}
  function proxyUrl(target){return '/api/proxy?url='+encodeURIComponent(target);}
  function showBrowserError(url,detail){frame.style.display='none';empty.style.display='flex';$('browserTitle').textContent='Could not load site';message.textContent=detail||'The destination could not be rendered through the compatibility proxy.';external.classList.remove('hidden');external.onclick=()=>window.open(url,'_blank','noopener,noreferrer');}
  function navigate(value,push=true){const url=normalizeUrl(value);if(!url){message.textContent='Enter a valid http:// or https:// address.';return;}if(push){state.history=state.history.slice(0,state.historyIndex+1);state.history.push(url);state.historyIndex++;}urlInput.value=url;external.classList.add('hidden');$('browserTitle').textContent='Loading';message.textContent='Fetching '+new URL(url).hostname+'…';empty.style.display='flex';frame.style.display='block';frame.src=proxyUrl(url);}
  function resetBrowser(){frame.src='about:blank';frame.style.display='none';empty.style.display='flex';$('browserTitle').textContent='Browser workspace';message.textContent='Enter a URL above.';external.classList.add('hidden');}
  frame.addEventListener('load',()=>{if(frame.src==='about:blank')return;empty.style.display='none';frame.style.display='block';});
  frame.addEventListener('error',()=>showBrowserError(urlInput.value,'The proxy could not fetch this destination.'));
  $('browserForm').addEventListener('submit',e=>{e.preventDefault();navigate(urlInput.value)});
  $('browserReload').addEventListener('click',()=>{if(urlInput.value)navigate(urlInput.value,false)});
  $('browserBack').addEventListener('click',()=>{if(state.historyIndex>0){state.historyIndex--;navigate(state.history[state.historyIndex],false)}});
  $('browserForward').addEventListener('click',()=>{if(state.historyIndex<state.history.length-1){state.historyIndex++;navigate(state.history[state.historyIndex],false)}});
  resetBrowser();
})();
