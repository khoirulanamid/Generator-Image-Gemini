#!/usr/bin/env node
/**
 * Gemini Image Bot — Unified (Explore / Pro Stock)
 * - GLOBAL & per-negara trends (live) + future trends (prediksi)
 * - Kategori efektif + profesi
 * - Jamin jumlah topik = limit
 * - Pro Stock: refine, 4K, sharpen/normalize, QC, anti-similar, rasio presisi
 * - ZIP semua hasil, Export CSV (client) + Persistensi similarity hash ke file
 *
 * Node 18+ (ESM)
 */
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import RSSParser from "rss-parser";
import sharp from "sharp";
import archiver from "archiver";
import { GoogleGenAI, Modality } from "@google/genai";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ------------ Config ------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const DEFAULT_REGION = process.env.TRENDS_REGION || "GLOBAL";
const GEMINI_API_KEY = AIzaSyAG4J5t6pQwntxvs6EDZs3wuiHJmO_LFqE  || "";

// Imagen & Gemini models
const IMAGEN_MODEL_STD      = process.env.IMAGEN_MODEL || "imagen-4.0-generate-001";
const IMAGEN_MODEL_FAST     = "imagen-4.0-fast-generate-001";
const GEMINI_IMAGE_FALLBACK = "gemini-2.0-flash-preview-image-generation";
const GEMINI_TEXT_MODEL     = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";

const DATA_DIR     = path.join(__dirname, "data");
const SIMHASH_FILE = path.join(DATA_DIR, "simhashes.json");

const ai   = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const app  = express();
const rss  = new RSSParser();

app.use(express.json({ limit: "30mb" }));
// Serve UI (public / Public—dua-duanya disupport)
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "Public")));

// ------------ Similarity Cache (persisten) ------------
const SIMHASHES = new Set(); // aHash-64

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}
async function loadSimhashes() {
  try {
    const txt = await fs.readFile(SIMHASH_FILE, "utf-8");
    const arr = JSON.parse(txt);
    if (Array.isArray(arr)) arr.forEach(h => typeof h === "string" && SIMHASHES.add(h));
  } catch {}
}
async function saveSimhashes() {
  try {
    await fs.writeFile(SIMHASH_FILE, JSON.stringify(Array.from(SIMHASHES), null, 2), "utf-8");
  } catch {}
}

// ------------ Helpers ------------
const ALL_ASPECTS = ["1:1","3:4","4:3","9:16","16:9"];
const GLOBAL_REGIONS = ["US","GB","IN","ID","JP","BR","DE","FR","CA","AU"];

const pick = (arr)=>arr[Math.floor(Math.random()*arr.length)];
const uniq = (arr)=>Array.from(new Set(arr));
const sanitizeFilename = (name)=>
  (name||"image").toLowerCase().replace(/[^a-z0-9-_]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80) || "image";

function inferAspectFromTopic(topic, fallback="4:3"){
  const t = (topic||"").toLowerCase();
  if (/(wallpaper|story|tiktok|reels|portrait|waterfall|building|skyscraper)/.test(t)) return "9:16";
  if (/(banner|landscape|cinematic|sky|panorama|cityscape|stadium)/.test(t)) return "16:9";
  if (/(macro|product|icon|logo|avatar|pattern|seamless|grid)/.test(t)) return "1:1";
  if (/(architecture|museum|interior|food|still life|flat lay)/.test(t)) return "3:4";
  if (/(wildlife|nature|mountain|forest|ocean|river|science|dna|water)/.test(t)) return "4:3";
  return fallback;
}

function stockSafeConcept(topic){
  const clean = (topic||"").replace(/[#@\[\]{}()"`~]|\|/g,"").trim();
  if (/\b(iphone|samsung|tesla|adidas|nike|olympic|piala|liga|barcelona|taylor swift|messi|avengers|disney|naruto|hello kitty|pokemon|bmw|mercedes|coca-cola|spotify|tiktok)\b/i.test(clean)) {
    return "abstract, brand-free concept related to the general theme only";
  }
  return clean || "abstract concept";
}

// ------------ Categories (efektif) ------------
const CATEGORIES = {
  animals: { keywords:["animal","wildlife","tiger","lion","cat","dog","bird","fish","insect","mammal","reptile","whale","owl","eagle","butterfly"],
             seeds:["endangered wildlife conservation","rainforest biodiversity","savannah lions at dusk","macro insect wings","owls in nocturnal flight","whale migration patterns"] },
  water: { keywords:["water","ocean","sea","lake","river","waterfall","wave","aquatic","underwater","reef","coral","blue economy","desalination"],
           seeds:["blue economy innovation","desalination plant aesthetics","smart irrigation systems at sunrise","aquifer recharge concept art","wastewater recycling technology","coral reef restoration","hydropower microturbines","fog harvesting in desert","water droplets macro bokeh"] },
  blue_economy: { keywords:["blue economy","desalination","aquaculture","marine energy","water investment","hydropower","offshore","aquifer","ocean tech"],
           seeds:["investing in water infrastructure","aquaculture recirculating tanks","offshore wave energy","coastal desalination architecture","hydroponic urban farms","water ETF abstract concept"] },
  investing: { keywords:["invest","investment","stock market","etf","finance","trader","fund","venture","angel"],
           seeds:["financial data visualization, clean charts","sustainable investing themes","retail trader concept without brands","global macro economy abstraction"] },
  business: { keywords:["business","finance","startup","analytics","office","marketing","logistics","supply chain"],
           seeds:["minimal analytics dashboard","team collaboration silhouettes","global logistics routes"] },
  technology: { keywords:["technology","robot","ai","chip","circuit","server","cloud","drone","quantum","semiconductor"],
           seeds:["ai neural imagery","quantum circuits","server room symmetry","drone top-down patterns"] },
  science: { keywords:["science","dna","molecule","neural","space","galaxy","lab","microscope","chemistry","physics"],
           seeds:["DNA double helix macro","galaxy long exposure look","microscope specimen abstract"] },
  climate: { keywords:["climate","sustainability","renewable","solar","wind","geothermal","carbon","net zero"],
           seeds:["solar farm sunrise","wind turbines coastal","carbon capture facility clean"] },
  architecture: { keywords:["architecture","building","skyscraper","bridge","temple","mosque","pagoda","stadium","cityscape","urban"],
           seeds:["minimalist modern facade","bridge leading lines","futuristic skyline at blue hour"] },
  nature: { keywords:["forest","mountain","desert","flower","volcano","rain","thunderstorm","aurora","valley","canyon"],
           seeds:["misty rainforest layers","desert dunes geometry","aurora over snowy peaks"] },
  abstract: { keywords:["abstract","geometric","gradient","fluid","fractal","pattern","isometric"],
           seeds:["isometric geometric pattern","liquid gradient waves","fractal tessellation"] },
  food: { keywords:["food","cuisine","fruit","vegetable","coffee","tea","pastry","bakery","dessert"],
           seeds:["flat-lay fresh ingredients","macro coffee crema","pastry stack studio lighting"] },
  sports: { keywords:["sport","football","soccer","badminton","basketball","motogp","olympic","cycling","running"],
           seeds:["fitness running track","basketball dunk silhouette","badminton shuttle macro"] },
  // Profesi
  profession_doctor: { keywords:["doctor","medical","hospital","healthcare"],
           seeds:["generic healthcare symbols","stethoscope still life (no brand)","medical research abstract"] },
  profession_engineer: { keywords:["engineer","engineering","cad","blueprint","mechanical","civil"],
           seeds:["blueprint patterns","mechanical gears macro","bridge engineering schematic art"] },
  profession_chef: { keywords:["chef","kitchen","culinary"],
           seeds:["chef tools flat lay (no brand)","flame wok silhouette","plating artistry top down"] },
  profession_farmer: { keywords:["farmer","agriculture","irrigation","harvest"],
           seeds:["irrigation channels at sunset","wheat field macro","drone view rice terraces"] },
  profession_investor: { keywords:["investor","portfolio","market","fund"],
           seeds:["portfolio allocation abstract","global finance map","risk-reward curve clean"] },
  profession_programmer: { keywords:["programmer","developer","code","software","data"],
           seeds:["code matrix abstract (no brand)","data nodes network","terminal-style pattern"] },
  profession_photographer: { keywords:["photographer","lens","studio","lighting"],
           seeds:["softbox lighting setup diagram","bokeh test chart abstract","tripod silhouette"] },
  profession_teacher: { keywords:["teacher","education","school","classroom"],
           seeds:["education icons set","chalkboard equations abstract","books and apple still life"] },
};
const CATEGORY_LIST = Object.keys(CATEGORIES);

// sinonim untuk perkaya SEO
const SEO_SYNONYMS = {
  water: ["blue economy","aqua","hydrology","marine","coastal","oceanic","aquifer","desalination","sustainability","renewable water"],
  animals: ["wildlife","fauna","zoology","biodiversity","endangered"],
  technology: ["innovation","digital","ai","automation","electronics","high-tech","future"],
  business: ["corporate","strategy","analytics","market","commerce","finance"],
  investing: ["portfolio","equity","markets","funds","ETF","trading","capital"],
  science: ["laboratory","research","biotech","physics","chemistry","microscope"],
  nature: ["outdoor","landscape","scenic","ecology","natural","wilderness"],
  architecture: ["urban","cityscape","facade","interior","structure","modern design"],
  abstract: ["pattern","gradient","geometric","texture","minimal","background"],
  food: ["culinary","cuisine","ingredients","gourmet","fresh","tasty"],
  sports: ["athlete","fitness","competition","training","stadium","outdoor"],
};

// ------------ Prompts ------------
function uniqueStyle(){
  const palettes = ["jade & amber","sapphire & tangerine","emerald & copper","lavender & charcoal","teal & sand"];
  const moods    = ["minimalist","cinematic","editorial-style","macro detailed","isometric 3D render","digital painting"];
  const lighting = ["soft diffused","dramatic rim","golden hour","studio softbox","volumetric rays"];
  return { palette: pick(palettes), mood: pick(moods), lighting: pick(lighting) };
}
function buildAdobeSafePrompt(topic, aspect){
  const concept = stockSafeConcept(topic);
  const s = uniqueStyle();
  const camera = pick(["35mm f/4 shallow depth","50mm f/8 balanced","85mm f/2 separation","24mm f/5.6 wide"]);
  const detail = pick(["micro-texture fidelity","crisp edges with natural falloff","PBR materials","subsurface scattering for organic materials"]);
  const depth  = pick(["aerial perspective","parallax layering","foreground depth cue","rule-of-thirds with leading lines"]);
  return (
`Create a commercially safe, original stock image with a distinctive signature look.

Subject: ${concept}.
Composition: ${depth}; clear focal subject with generous copy space; perspective matching ${aspect}.
Style: ${s.mood}, palette (${s.palette}), ${s.lighting}. ${camera}. ${detail}.
Lighting: realistic global illumination; no clipped highlights or crushed blacks; natural roll-off; zero motion blur.
Technical (must follow): NO brands/logos/readable text/watermarks/copyrighted characters; accurate proportions; sRGB.
Clarity directive: crisp micro-details, preserved high-frequency texture, clean edges without halos, 4:4:4 chroma quality.
Uniqueness: avoid clichés; vary angle/lighting/composition so it feels fresh and not similar to common stock.
If people appear, keep them generic and non-identifiable (no recognizable faces).
`);
}
const ANGLES   = ["wide angle view","medium shot","close-up macro"];
const LIGHTING = ["golden hour light","studio softbox","dramatic rim light","volumetric fog lighting"];
const FOCUS    = ["macro crisp detail","product clean catalog style","cinematic landscape vista"];
const NEGATIVE = "no plastic skin, no banding, no posterization, no aliased edges, no artifacts, no watermark, no text, no brands/logos";
function buildAdobeSafePromptPro(topic, aspect){
  const angle = pick(ANGLES), light = pick(LIGHTING), focus = pick(FOCUS);
  return `Create an original, stock-safe image. Subject: ${stockSafeConcept(topic)}. Composition: ${angle}, ${focus}, aspect ratio ${aspect}. Lighting: ${light}. Rules: ${NEGATIVE}. Ensure unique style, sRGB, and commercial safe.`;
}

// ------------ Refiners & Meta (SEO) ------------
async function critiqueAndRefinePrompt(topic, draft){
  try{
    const sys = `You are a senior stock content art director. Improve prompts for Adobe Stock: clarity, composition, micro-detail, lighting, copy space, uniqueness. Enforce: no brands/logos/text/watermarks/copyrighted characters. Return only the improved English prompt.`;
    const r = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [{ role:"user", parts:[{ text: `${sys}\n\nTopic: ${topic}\nDraft Prompt:\n${draft}` }]}],
    });
    const out = r.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return out?.length>50 ? out : draft;
  }catch{ return draft; }
}
function wordsFrom(str){ return (str||"").toLowerCase().split(/[^a-z0-9]+/).filter(w => w && w.length>2); }
function genTitleAndKeywords(topic, aspect, category=null){
  const base = [
    "stock image","royalty-free","sRGB","high detail","copy space","commercial safe",
    "no logo","no text","unique style","sharp","high resolution","clean background",
    aspect==="16:9"?"landscape":aspect==="9:16"?"portrait":aspect==="1:1"?"square":""
  ].filter(Boolean);

  const topicWords = wordsFrom(topic);
  const cat = category && CATEGORIES[category] ? category : null;
  const catCore = cat ? (CATEGORIES[cat].keywords || []) : [];
  const catSeeds = cat ? (CATEGORIES[cat].seeds || []) : [];
  const catSeedWords = uniq(catSeeds.flatMap(wordsFrom));
  const synonyms = cat && SEO_SYNONYMS[cat] ? SEO_SYNONYMS[cat] : [];
  const extras = ["editorial-style","cinematic lighting","micro texture","natural color","no artifacts","4:4:4 chroma"];

  let keywords = uniq([...base, ...topicWords, ...catCore, ...catSeedWords, ...synonyms, ...extras]).filter(k => k.length>2);
  const pads = ["creative","background","design","visual","render","photo","image","art","macro","detail","texture","pattern","composition","lighting","perspective","depth","vibrant","minimal","modern"];
  while (keywords.length < 32) keywords.push(pads[(keywords.length*7)%pads.length]);
  keywords = keywords.slice(0, 40);

  const title = `${topic} — ${cat ? cat.replace(/_/g," ")+" · " : ""}${aspect} aspect · royalty-free stock image`;
  return { title, keywords };
}

// ------------ Generation ------------
async function generateWithImagen({ prompt, aspectRatio="4:3", numberOfImages=1, sampleImageSize="2K", allowPeople=false, fast=false }){
  const config = {
    numberOfImages: Math.min(Math.max(Number(numberOfImages)||1,1),4),
    aspectRatio: ALL_ASPECTS.includes(aspectRatio) ? aspectRatio : "4:3",
    sampleImageSize, // "1K" | "2K" | "4K"
    personGeneration: allowPeople ? "allow_adult" : "dont_allow",
  };
  const res = await ai.models.generateImages({ model: fast?IMAGEN_MODEL_FAST:IMAGEN_MODEL_STD, prompt, config });
  return res.generatedImages.map(img => Buffer.from(img.image.imageBytes, "base64"));
}
async function generateWithGeminiFallback({ prompt }){
  const response = await ai.models.generateContent({
    model: GEMINI_IMAGE_FALLBACK,
    contents: [{ role:"user", parts:[{ text: prompt }]}],
    config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
  });
  const images = [];
  for (const part of (response.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData) images.push(Buffer.from(part.inlineData.data, "base64"));
  }
  if (!images.length) throw new Error("Fallback did not return images");
  return images;
}
async function ensureSRGBJPEG(buf, { targetRatio=null, upscale=false, minMegapixels=4.1, quality=96 }){
  let img = sharp(buf);
  const meta = await img.metadata();
  if (targetRatio){
    const [w,h] = [meta.width||0, meta.height||0];
    if (w && h){
      const [arW, arH] = targetRatio.split(":").map(Number);
      const target = arW / arH, current = w / h;
      if (Math.abs(current - target) > 0.01){
        const targetW = current > target ? Math.round(h * target) : w;
        const targetH = current > target ? h : Math.round(w / target);
        const left = Math.max(0, Math.floor((w - targetW)/2));
        const top  = Math.max(0, Math.floor((h - targetH)/2));
        img = img.extract({ left, top, width: targetW, height: targetH });
      }
    }
  }
  if (upscale){
    const m = await img.metadata();
    const mp = (m.width||0) * (m.height||0) / 1_000_000;
    if (mp < minMegapixels){
      const scale = Math.sqrt(minMegapixels / Math.max(mp, 0.0001));
      img = img.resize({ width: Math.round((m.width||1024) * scale), height: Math.round((m.height||1024) * scale), fit:"cover" });
    }
  }
  img = img.sharpen(1.25).normalize().gamma();
  return await img.jpeg({ quality, mozjpeg:true, chromaSubsampling:"4:4:4" }).toBuffer();
}

// aHash-64 + Hamming
async function aHash64(buf){
  const s = await sharp(buf).grayscale().resize(8,8,{ fit:"fill" }).raw().toBuffer();
  let sum=0; for (let i=0;i<s.length;i++) sum+=s[i];
  const avg = sum / s.length;
  let bits=0n; for (let i=0;i<s.length;i++) bits = (bits<<1n) | (s[i] >= avg ? 1n : 0n);
  return bits.toString(16).padStart(16,"0");
}
function hammingHex(a,b){
  const x = (BigInt("0x"+a) ^ BigInt("0x"+b));
  let c=0n, y=x; while (y){ y&=(y-1n); c++; }
  return Number(c);
}

// --------- Trends (live + future) ----------
async function fetchLiveTrends({ region=DEFAULT_REGION, limit=12 }){
  const regions = region.toUpperCase()==="GLOBAL" ? GLOBAL_REGIONS : [region];
  const urls = regions.map(r => `https://trends.google.com/trending/rss?geo=${encodeURIComponent(r)}`);
  const all=[];
  for (const u of urls){
    try{
      const feed = await rss.parseURL(u);
      for (const it of (feed.items||[])) if (it.title) all.push(it.title);
    }catch{ /* ignore */ }
  }
  const cleaned = all.filter(t => !/\b([A-Z][a-z]+ ){2,}[A-Z][a-z]+/.test(t||"")); // buang 3+ ProperNames
  return uniq(cleaned).slice(0, limit*3);
}
function filterByCategory(topics, category){
  if (!category || !CATEGORIES[category]) return topics;
  const keys = CATEGORIES[category].keywords.map(k => k.toLowerCase());
  return topics.filter(t => keys.some(k => (t||"").toLowerCase().includes(k)));
}
function categorySeeds(category, n=20){
  if (!category || !CATEGORIES[category]) return [];
  const seeds = CATEGORIES[category].seeds || [];
  const extra = seeds.flatMap(s => [s, `modern ${s}`, `minimal ${s}`, `cinematic ${s}`, `${s} at golden hour`, `${s} macro detail`]);
  return uniq(extra).slice(0, n);
}
async function generateFutureTopics({ category=null, region=DEFAULT_REGION, limit=10 }){
  try{
    const catText = category && CATEGORIES[category]
      ? `Category focus: ${category} (${CATEGORIES[category].keywords.join(", ")})`
      : "General creative stock topics without brands.";
    const sys = `Propose short, brand-safe, commercially useful stock topics (max 6 words each). Avoid celebrity/brand/real company/team names.`;
    const r = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [{ role:"user", parts:[{ text:
`${sys}
Region: ${region}.
${catText}
Return ${limit} distinct topics (one per line).`}]}],
    });
    const txt = r.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const lines = txt.split(/\r?\n/).map(s=>s.replace(/^\d+[\).\s-]*/,"").trim()).filter(Boolean);
    return uniq(lines).slice(0, limit);
  }catch{
    return categorySeeds(category, limit);
  }
}
async function buildTopics({ region=DEFAULT_REGION, limit=8, category=null, source="both" }){
  let candidates=[];
  if (source==="live" || source==="both"){
    const live = await fetchLiveTrends({ region, limit });
    const filtered = filterByCategory(live, category);
    candidates = candidates.concat(filtered);
  }
  if (candidates.length < limit && (source==="future" || source==="both")){
    const futureNeed = limit - candidates.length + 5;
    const future = await generateFutureTopics({ category, region, limit: Math.max(futureNeed, limit) });
    candidates = candidates.concat(future);
  }
  if (candidates.length < limit){
    candidates = candidates.concat(categorySeeds(category, limit*2));
  }
  let final = uniq(candidates).slice(0, limit*3);
  if (category && CATEGORIES[category]){
    const keys = CATEGORIES[category].keywords.map(k=>k.toLowerCase());
    final = final.map(t => keys.some(k=>t.toLowerCase().includes(k)) ? t : `${t} — ${keys[0]}`);
  }
  final = final.slice(0, limit);
  while (final.length < limit) final.push(`abstract ${category||"creative"} concept`);
  return final;
}

// --------- API ---------
app.get("/api/health", (_req,res)=>res.json({ ok:true, categories: CATEGORY_LIST }));

// GET /api/trends?region=GLOBAL&limit=8&category=water&source=both
app.get("/api/trends", async (req,res)=>{
  const region   = (req.query.region||DEFAULT_REGION).toString();
  const limit    = Math.max(1, Math.min(Number(req.query.limit)||8, 30));
  const category = req.query.category ? req.query.category.toString() : null;
  const source   = (req.query.source||"both").toString(); // live | future | both

  const topics   = await buildTopics({ region, limit, category, source });
  const items    = topics.map(t => {
    const aspect = inferAspectFromTopic(t);
    return { topic:t, aspect, prompt: buildAdobeSafePrompt(t, aspect), category };
  });
  res.json({ ok:true, region, source, limit, category, items });
});

// Unified generate: quality = "pro" | "explore"
app.post("/api/generate-unified", async (req,res)=>{
  try{
    const { items, imagesPerTopic=1, aspectOverride=null,
            allowPeople=false, upscale=true,
            quality="pro", // "pro" default
            antiSimilar=true, simThreshold=6 } = req.body||{};

    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error:"items required" });

    const results=[]; let skipped=0;
    for (const it of items){
      const topic  = it.topic || "abstract art";
      const aspect = (aspectOverride && ALL_ASPECTS.includes(aspectOverride)) ? aspectOverride : (it.aspect || inferAspectFromTopic(topic));
      const category = it.category || null;
      let prompt   = it.prompt || buildAdobeSafePrompt(topic, aspect);

      const isPro = quality === "pro";
      if (isPro) prompt = await critiqueAndRefinePrompt(topic, prompt);

      let bufs=[];
      try{
        bufs = await generateWithImagen({
          prompt,
          aspectRatio: aspect,
          numberOfImages: imagesPerTopic,
          sampleImageSize: isPro ? "4K" : "2K",
          allowPeople,
          fast: !isPro // explore=fast
        });
      }catch{
        bufs = await generateWithGeminiFallback({ prompt });
      }

      const outs=[];
      for (let i=0;i<bufs.length;i++){
        const jpeg = await ensureSRGBJPEG(bufs[i], { targetRatio: aspect, upscale: !!upscale });
        const hash = await aHash64(jpeg);

        let isSimilar=false;
        if (antiSimilar){
          for (const h of SIMHASHES){
            const d = hammingHex(hash, h);
            if (d <= simThreshold){ isSimilar=true; break; }
          }
        }
        if (isSimilar){ skipped++; continue; }
        SIMHASHES.add(hash);
        saveSimhashes(); // persist tiap ada yang lolos

        const entry = {
          filename: `${sanitizeFilename(topic)}-${aspect}-${i+1}.jpg`,
          dataUrl : `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          meta    : genTitleAndKeywords(topic, aspect, category),
          hash
        };
        if (isPro){
          entry.qc = await qcCheck(prompt, topic);
        }
        outs.push(entry);
      }
      results.push({ topic, aspect, prompt, category, quality, images: outs });
    }
    res.json({ ok:true, results, skipped, simThreshold, quality });
  }catch(err){ res.status(500).json({ error: err.message||"internal error" }); }
});

// QC singkat (text)
async function qcCheck(prompt, topic){
  try{
    const sys = `You are a QC inspector. Check compliance for Adobe Stock: no text, no brand/logo, no artifacts, realistic lighting, clear subject. Return a short verdict: OK or list issues.`;
    const r = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [{ role:"user", parts:[{ text:`${sys}\nTopic:${topic}\nPrompt:${prompt}` }]}],
    });
    return r.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "QC unknown";
  }catch{ return "QC skipped"; }
}

// Reset similarity cache (clear + persist)
app.post("/api/similarity/reset", async (_req,res)=>{
  SIMHASHES.clear();
  await saveSimhashes();
  res.json({ ok:true });
});

// ZIP semua hasil: POST {files:[{filename,dataUrl}]}
app.post("/api/zip", async (req,res)=>{
  try{
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ error: "files required" });

    const ts = new Date().toISOString().replace(/[:.]/g,"-");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="images-${ts}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err)=>{ res.status(500); res.end(String(err)); });
    archive.pipe(res);

    for (const f of files){
      const fn = (f.filename && String(f.filename)) || "image.jpg";
      const m  = /^data:image\/\w+;base64,(.+)$/i.exec(f.dataUrl || "");
      const buf= m ? Buffer.from(m[1], "base64") : Buffer.alloc(0);
      archive.append(buf, { name: fn });
    }
    await archive.finalize();
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

// ---- boot ----
(async () => {
  await ensureDataDir();
  await loadSimhashes();
  app.listen(PORT, ()=>console.log(`✅ Unified dashboard ready: http://localhost:${PORT}`));
})();
