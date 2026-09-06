(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll('.tab-btn')];
  const sections = ['upload','scan','browser'].reduce((o,id)=>(o[id]=$(id),o),{});
  const state = {active:'upload',stream:null,raf:0,lastData:'',history:[],historyIndex:-1,browserToken:0};

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
  fileInput.addEventListener('change',()=>{if(fileInput.files[0])decodeFile(fileInput.files[0]);fileInput.value=''});

  function decodeFile(file){
    if(!file.type.startsWith('image/')){renderResult('result','','Please choose an image file.');return;}
    $('uploadStatus').textContent='Decoding locally…';const reader=new FileReader();
    reader.onload=e=>{const img=new Image();img.onload=()=>{try{const max=1600,scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,canvas.width,canvas.height);const image=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR?.(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});if(!code?.data){$('uploadStatus').textContent='No QR code found in that image.';renderResult('result','','No QR code found. Try a clearer or larger image.');return;}$('uploadStatus').textContent='Decoded successfully.';renderResult('result',code.data);}catch(err){$('uploadStatus').textContent='Decode failed.';renderResult('result','',err.message||'Unable to decode image.');}};img.onerror=()=>{ $('uploadStatus').textContent='Image could not be opened.';renderResult('result','','Invalid or unsupported image.')};img.src=e.target.result};
    reader.onerror=()=>renderResult('result','','Could not read the selected file.');reader.readAsDataURL(file);
  }

  async function startScan(){if(state.stream)return;if(!navigator.mediaDevices?.getUserMedia){$('scanStatus').textContent='Camera is not supported in this browser.';return;}$('scanStatus').textContent='Requesting camera…';try{state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});$('video').srcObject=state.stream;await $('video').play();$('cameraBtn').textContent='Stop camera';$('scanStatus').textContent='Point your camera at a QR code';scanLoop();}catch(err){state.stream=null;$('cameraBtn').textContent='Start camera';$('scanStatus').textContent=err.name==='NotAllowedError'?'Camera permission was denied.':'Camera unavailable.';}}
  function stopScan(){if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;const v=$('video');v.pause();v.srcObject=null;$('cameraBtn').textContent='Start camera';const c=$('scanOverlay');c.width=c.clientWidth;c.height=c.clientHeight;c.getContext('2d').clearRect(0,0,c.width,c.height);}
  $('cameraBtn').addEventListener('click',()=>state.stream?stopScan():startScan());
  function scanLoop(){if(!state.stream)return;state.raf=requestAnimationFrame(scanLoop);const video=$('video');if(video.readyState<2||!video.videoWidth)return;const canvas=$('scanCanvas')||Object.assign(document.createElement('canvas'),{id:'scanCanvas'}),ctx=canvas.getContext('2d',{willReadFrequently:true});canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const frame=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR?.(frame.data,frame.width,frame.height,{inversionAttempts:'attemptBoth'}),overlay=$('scanOverlay');overlay.width=overlay.clientWidth;overlay.height=overlay.clientHeight;const ov=overlay.getContext('2d');ov.clearRect(0,0,overlay.width,overlay.height);if(!code?.location)return;const p=code.location,sx=overlay.width/canvas.width,sy=overlay.height/canvas.height;ov.beginPath();ov.moveTo(p.topLeftCorner.x*sx,p.topLeftCorner.y*sy);ov.lineTo(p.topRightCorner.x*sx,p.topRightCorner.y*sy);ov.lineTo(p.bottomRightCorner.x*sx,p.bottomRightCorner.y*sy);ov.lineTo(p.bottomLeftCorner.x*sx,p.bottomLeftCorner.y*sy);ov.closePath();ov.lineWidth=3;ov.strokeStyle='#fff';ov.stroke();if(code.data!==state.lastData){state.lastData=code.data;renderResult('scan',code.data);$('scanStatus').textContent='QR code detected';if(navigator.vibrate)navigator.vibrate(25);}}

  $('clearBtn').addEventListener('click',()=>{$('uploadResult').classList.add('hidden');$('scanResult').classList.add('hidden');$('uploadStatus').textContent='Ready to decode';state.lastData='';resetBrowser();});

  const frame=$('browserFrame'),empty=$('browserEmpty'),urlInput=$('browserUrl'),message=$('browserMessage'),external=$('openExternal');
  function normalizeUrl(value){const v=value.trim();if(!v)return'';if(/^(https?|about):/i.test(v))return v;if(/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v))return'https://'+v;return'https://www.google.com/search?q='+encodeURIComponent(v);}
  function showBrowserError(url){frame.style.display='none';empty.style.display='flex';message.textContent='This site does not allow embedded display. Open it normally instead.';external.classList.remove('hidden');external.onclick=()=>window.open(url,'_blank','noopener,noreferrer');}
  function navigate(value,push=true){const url=normalizeUrl(value);if(!url)return;if(push){state.history=state.history.slice(0,state.historyIndex+1);state.history.push(url);state.historyIndex++;}urlInput.value=url;external.classList.add('hidden');message.textContent='Loading…';empty.style.display='flex';frame.style.display='block';const token=++state.browserToken;frame.src='about:blank';setTimeout(()=>{if(token!==state.browserToken)return;frame.src=url;},20);clearTimeout(navigate.timer);navigate.timer=setTimeout(()=>{if(token!==state.browserToken)return;try{const href=frame.contentWindow.location.href;if(href==='about:blank'||href!==url)showBrowserError(url);}catch{showBrowserError(url);}},4500);}
  function resetBrowser(){state.browserToken++;frame.src='about:blank';frame.style.display='none';empty.style.display='flex';message.textContent='Enter a URL above.';external.classList.add('hidden');}
  frame.addEventListener('load',()=>{if(frame.src==='about:blank')return;message.textContent='Loaded';empty.style.display='none';frame.style.display='block';clearTimeout(navigate.timer);});
  frame.addEventListener('error',()=>showBrowserError(urlInput.value));
  $('browserForm').addEventListener('submit',e=>{e.preventDefault();navigate(urlInput.value)});
  $('browserReload').addEventListener('click',()=>{if(frame.src&&frame.src!=='about:blank'){const u=urlInput.value;frame.src='about:blank';setTimeout(()=>frame.src=u,20)}});
  $('browserBack').addEventListener('click',()=>{if(state.historyIndex>0){state.historyIndex--;navigate(state.history[state.historyIndex],false)}});
  $('browserForward').addEventListener('click',()=>{if(state.historyIndex<state.history.length-1){state.historyIndex++;navigate(state.history[state.historyIndex],false)}});
  resetBrowser();
})();
