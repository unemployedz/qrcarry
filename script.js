(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll('.tab-btn')];
  const sections = { upload: $('upload'), scan: $('scan') };
  const state = { active:'upload', stream:null, raf:0, lastData:'' };

  async function copy(text, button) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove(); }
    const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);
  }

  function parseQRData(raw) {
    raw=String(raw||'').trim();
    if(!raw)return{type:'Empty',issuer:'—',content:''};
    if(/^otpauth:\/\//i.test(raw)) { try { const u=new URL(raw), p=decodeURIComponent(u.pathname.slice(1)), issuer=u.searchParams.get('issuer')||(p.includes(':')?p.split(':')[0]:'Unknown'), secret=u.searchParams.get('secret')||''; return {type:u.hostname.toLowerCase()==='hotp'?'Authenticator (HOTP)':'Authenticator (TOTP)',issuer,content:secret.toUpperCase()||raw}; } catch {} }
    if(/^wifi:/i.test(raw)){const f={};raw.slice(5).split(';').forEach(p=>{const i=p.indexOf(':');if(i>-1)f[p.slice(0,i).toUpperCase()]=p.slice(i+1)});return{type:'Wi-Fi',issuer:f.S||'Unknown network',content:f.P||raw};}
    if(/^(https?|ftp):\/\//i.test(raw)){try{return{type:'URL',issuer:new URL(raw).hostname,content:raw};}catch{}}
    if(/^(BEGIN:VCARD|MECARD:)/i.test(raw))return{type:'Contact',issuer:'vCard',content:raw};
    if(/^mailto:/i.test(raw))return{type:'Email',issuer:'Mail',content:raw};
    if(/^tel:/i.test(raw))return{type:'Phone',issuer:'Telephone',content:raw};
    return{type:'Text / Other',issuer:'QR data',content:raw};
  }

  function renderResult(kind,data,error='') {
    const ids=kind==='upload'?{box:'uploadResult',type:'resultType',issuer:'resultIssuer',seed:'resultSeed',copy:'resultCopyBtn',open:'resultOpenBtn'}:{box:'scanResult',type:'scanType',issuer:'scanIssuer',seed:'scanSeed',copy:'scanCopyBtn',open:'scanOpenBtn'};
    const box=$(ids.box);if(!box)return;box.classList.remove('hidden');
    const open=$(ids.open);open.classList.add('hidden');open.onclick=null;
    if(error){$(ids.type).textContent='Could not decode';$(ids.issuer).textContent='Error';$(ids.seed).textContent=error;return;}
    const p=parseQRData(data);$(ids.type).textContent=p.type;$(ids.issuer).textContent=p.issuer||'—';$(ids.seed).textContent=p.content||'—';
    const btn=$(ids.copy);btn.onclick=()=>copy(p.content,btn);
    if(/^(https?|ftp):\/\//i.test(p.content)){open.classList.remove('hidden');open.onclick=()=>window.open(p.content,'_blank','noopener,noreferrer');}
  }

  tabs.forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
  function switchTab(tab){if(!sections[tab]||tab===state.active)return;stopScan();state.active=tab;tabs.forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));Object.entries(sections).forEach(([id,el])=>el.classList.toggle('active',id===tab));if(tab==='scan')startScan();}

  const fileInput=$('fileInput'),uploadArea=$('uploadArea');
  uploadArea.addEventListener('dragover',e=>{e.preventDefault();uploadArea.classList.add('dragging')});
  uploadArea.addEventListener('dragleave',()=>uploadArea.classList.remove('dragging'));
  uploadArea.addEventListener('drop',e=>{e.preventDefault();uploadArea.classList.remove('dragging');const f=e.dataTransfer.files[0];if(f)decodeFile(f)});
  fileInput.addEventListener('change',()=>{const f=fileInput.files?.[0];if(f)decodeFile(f);fileInput.value='' });

  async function fileToUsableBlob(file){
    const name=(file.name||'').toLowerCase(),type=(file.type||'').toLowerCase();
    const heic=type.includes('heic')||type.includes('heif')||/\.(heic|heif)$/.test(name);
    if(heic&&typeof window.heic2any==='function'){try{const out=await window.heic2any({blob:file,toType:'image/jpeg',quality:.98});return Array.isArray(out)?out[0]:out;}catch{}}
    return file;
  }

  async function imageToCanvas(blob){
    const url=URL.createObjectURL(blob),img=new Image();
    try { await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('iPhone image could not be opened.'));img.src=url;});
      const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,max=2600,s=Math.min(1,max/Math.max(w,h));
      const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*s));c.height=Math.max(1,Math.round(h*s));c.getContext('2d',{willReadFrequently:true}).drawImage(img,0,0,c.width,c.height);return c;
    } finally {URL.revokeObjectURL(url)}
  }

  function decodeCanvas(canvas){
    if(!window.jsQR)return null;
    const frames=[];
    const add=c=>{const ctx=c.getContext('2d',{willReadFrequently:true});frames.push(ctx.getImageData(0,0,c.width,c.height));};
    add(canvas);
    if(canvas.width>1600){const c=document.createElement('canvas'),s=1600/canvas.width;c.width=1600;c.height=Math.round(canvas.height*s);c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);add(c)}
    for(const frame of frames) for(const inversionAttempts of ['attemptBoth','dontInvert','onlyInvert']) for(const weights of [{red:.299,green:.587,blue:.114},{red:.2126,green:.7152,blue:.0722}]) {try{const r=jsQR(frame.data,frame.width,frame.height,{inversionAttempts,greyScaleWeights:weights});if(r?.data)return r.data}catch{}}
    return null;
  }

  async function decodeWithZXing(blob){
    if(!window.ZXing?.BrowserQRCodeReader)return null;const url=URL.createObjectURL(blob);try{const reader=new ZXing.BrowserQRCodeReader();const r=await reader.decodeFromImageUrl(url);return r?.getText?.()||r?.text||null}catch{return null}finally{URL.revokeObjectURL(url)}}

  async function decodeOnServer(file){
    const form=new FormData();form.append('file',file,file.name||'qrcode');
    const r=await fetch('/api/decode',{method:'POST',body:form,headers:{accept:'application/json'}});let p={};try{p=await r.json()}catch{}
    if(!r.ok)throw new Error(p.error||`Server decoder returned HTTP ${r.status}`);return p.data||null;
  }

  async function decodeFile(file){
    if(!file)return;$('uploadResult').classList.add('hidden');$('uploadStatus').textContent='Preparing image…';
    try{
      const blob=await fileToUsableBlob(file);let data=null;
      $('uploadStatus').textContent='Trying QR decoders…';
      data=await decodeWithZXing(blob);
      if(!data){const canvas=await imageToCanvas(blob);data=decodeCanvas(canvas)}
      if(data){$('uploadStatus').textContent='Decoded successfully.';renderResult('upload',data);return}
      $('uploadStatus').textContent='Using secure server decoder…';
      data=await decodeOnServer(file);
      if(!data)throw new Error('No QR code was detected.');
      $('uploadStatus').textContent='Decoded successfully.';renderResult('upload',data);
    }catch(err){console.error('QR decode:',err);$('uploadStatus').textContent='Decode failed — '+(err?.message||'unknown error');renderResult('upload','',err?.message||'Unable to decode this image.')}
  }

  async function startScan(){if(state.stream)return;if(!navigator.mediaDevices?.getUserMedia){$('scanStatus').textContent='Camera is not supported here.';return}$('scanStatus').textContent='Requesting camera…';try{state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});$('video').srcObject=state.stream;await $('video').play();$('cameraBtn').textContent='Stop camera';$('scanStatus').textContent='Point your camera at a QR code';scanLoop()}catch(e){state.stream=null;$('cameraBtn').textContent='Start camera';$('scanStatus').textContent=e.name==='NotAllowedError'?'Camera permission was denied.':'Camera unavailable.'}}
  function stopScan(){if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;const v=$('video');v.pause();v.srcObject=null;$('cameraBtn').textContent='Start camera'}
  $('cameraBtn').addEventListener('click',()=>state.stream?stopScan():startScan());
  function scanLoop(){if(!state.stream)return;state.raf=requestAnimationFrame(scanLoop);const v=$('video');if(v.readyState<2||!v.videoWidth)return;const c=$('scanCanvas')||Object.assign(document.createElement('canvas'),{id:'scanCanvas'}),ctx=c.getContext('2d',{willReadFrequently:true});c.width=v.videoWidth;c.height=v.videoHeight;ctx.drawImage(v,0,0);const code=decodeCanvas(c);if(code&&code!==state.lastData){state.lastData=code;renderResult('scan',code);$('scanStatus').textContent='QR code detected';if(navigator.vibrate)navigator.vibrate(25)}}
  $('clearBtn').addEventListener('click',()=>{$('uploadResult').classList.add('hidden');$('scanResult').classList.add('hidden');$('uploadStatus').textContent='Ready to decode';state.lastData='';stopScan()});
})();
