// ===== Konfigurasi Backend =====
const API_BASE = "https://generator-image-gemini-production.up.railway.app"; // ganti ke URL backend kamu

const el = s => document.querySelector(s);
const list = el('#list');

// index untuk CSV / ZIP
window.__imagesIndex = []; // { filename, topic, aspect, title, keywords[], hash, qc }
window.__imagesData  = []; // { filename, dataUrl }

// ===== util CSV / ZIP =====
function arrayToCSV(rows) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}
function downloadCSV() {
  const header = ['filename','topic','aspect','title','keywords','hash','qc'];
  const rows = [header];
  for (const it of window.__imagesIndex) {
    rows.push([
      it.filename,
      it.topic,
      it.aspect,
      it.title || '',
      (it.keywords||[]).join('; '),
      it.hash || '',
      it.qc || ''
    ]);
  }
  const csv = arrayToCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  a.download = `keywords-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
el('#btnCSV').onclick = downloadCSV;

async function downloadZIP() {
  if (!window.__imagesData.length) { alert('Belum ada gambar. Generate dulu ya.'); return; }
  const res = await fetch(`${API_BASE}/api/zip`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ files: window.__imagesData })
  });
  if (!res.ok) { alert('Gagal membuat ZIP'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  a.href = url;
  a.download = `images-${ts}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
el('#btnZIP').onclick = downloadZIP;

// ===== Ambil topik =====
async function fetchTopics(){
  const source   = el('#source').value || 'both';
  const region   = el('#region').value || 'GLOBAL';
  const category = el('#category').value || '';
  const limit    = Number(el('#limit').value) || 8;

  const url = `${API_BASE}/api/trends?region=` + encodeURIComponent(region)
            + '&limit=' + limit + '&source=' + encodeURIComponent(source)
            + (category ? '&category=' + encodeURIComponent(category) : '');

  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok){ alert('Gagal ambil topik'); return []; }
  let items = (data.items || []).map(it => ({ ...it, category }));

  // Tema manual (tetap jaga jumlah == limit)
  const manual = (el('#manual').value||'').split('\n').map(s=>s.trim()).filter(Boolean)
                  .map(t => ({ topic:t, aspect:'4:3', prompt:'', category }));
  const seen=new Set(); const merged=[];
  for (const it of [...items, ...manual]){
    const k=(it.topic||'').toLowerCase();
    if(!seen.has(k)){ seen.add(k); merged.push(it); }
    if(merged.length>=limit) break;
  }
  while (merged.length<limit) merged.push({ topic:(category||'creative')+' concept', aspect:'4:3', prompt:'', category });

  // Pasang aspect & prompt
  items = merged.map(it=>{
    let aspect = it.aspect || '4:3';
    if (el('#aspect').value !== 'auto') aspect = el('#aspect').value;
    const p = it.prompt || `Original stock-safe image about: ${it.topic}. No brands, no logos, no text, unique style.`;
    return { topic: it.topic, aspect, prompt: p, category: it.category || category };
  });
  return items;
}

function render(items){
  list.innerHTML='';
  for (const it of items){
    const card=document.createElement('div');
    card.className='card';
    card.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px">
        <div>
          <div style="font-weight:700">${it.topic}</div>
          <div class="muted">Aspect <span class="chip">${it.aspect}</span> · Cat: <span class="chip">${it.category || '-'}</span></div>
        </div>
        <button class="btn primary bgen">Generate</button>
      </div>
      <div class="muted" style="margin-bottom:6px">Quality: <span class="chip">${el('#quality').value==='pro'?'Pro Stock':'Explore'}</span></div>
      <details><summary class="muted">Lihat prompt</summary><pre style="white-space:pre-wrap">${it.prompt}</pre></details>
      <div class="row out"></div>`;
    card.querySelector('.bgen').onclick=async()=>{ await generateUnified([it], card.querySelector('.out')); };
    list.appendChild(card);
  }
}

async function generateUnified(items, outElAll=null){
  const payload = {
    items,
    imagesPerTopic: Number(el('#count').value)||1,
    aspectOverride: (el('#aspect').value==='auto')?null:el('#aspect').value,
    allowPeople: el('#people').value==='on',
    upscale: el('#upscale').value==='on',
    quality: el('#quality').value,      // "pro" | "explore"
    antiSimilar: el('#antisim').value==='on',
    simThreshold: Number(el('#simth').value)||6
  };
  const res = await fetch(`${API_BASE}/api/generate-unified`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if(!data.ok){ alert(data.error||'Gagal'); return; }

  for (const r of data.results){
    const outEl = outElAll || Array.from(document.querySelectorAll('.card .row.out'))
      .find(p=>p.closest('.card').querySelector('div div').textContent.trim()===r.topic);
    for (const img of r.images){
      const wrap=document.createElement('div');
      wrap.className='imgwrap';
      wrap.innerHTML=`<img src="${img.dataUrl}"/><div style="display:flex;justify-content:space-between;align-items:center;padding:8px"><div class="muted">${r.topic} · ${r.aspect} · ${r.quality}</div><a class="btn ghost" download="${img.filename}" href="${img.dataUrl}">Download</a></div>`;
      outEl.appendChild(wrap);

      // Rekam untuk CSV/ZIP
      window.__imagesIndex.push({
        filename: img.filename,
        topic: r.topic,
        aspect: r.aspect,
        title: (img.meta && img.meta.title) || '',
        keywords: (img.meta && img.meta.keywords) || [],
        hash: img.hash || '',
        qc: img.qc || ''
      });
      window.__imagesData.push({ filename: img.filename, dataUrl: img.dataUrl });
    }
  }
  el('#sum_norm').textContent = 'Skipped similar: ' + (data.skipped||0) + ' | Threshold: ' + data.simThreshold + ' | Quality: ' + data.quality;
}

el('#btnFetch').onclick = async ()=>{ const items = await fetchTopics(); render(items); };
el('#btnGenAll').onclick = async ()=>{ const items = await fetchTopics(); render(items); await generateUnified(items); };
el('#btnReset').onclick = async ()=>{ await fetch(`${API_BASE}/api/similarity/reset`,{method:'POST'}); el('#sum_norm').textContent='Similarity cache direset.' };

// load awal
(async()=>{ const items=await fetchTopics(); render(items); })();
