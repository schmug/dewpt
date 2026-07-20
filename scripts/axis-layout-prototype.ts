// PROTOTYPE: does a 2–3 named-axis layout read as a *place*?
//
// Open question #2 in docs/latent-space-navigation-design.md. axis-spike.ts
// proved a single axis ORDERS words correctly; that is not the same as three
// axes producing a legible map. The worry is clumping: most words are neutral
// on most axes, so they may all pile into the middle and the "map" becomes a
// blob with a few outliers.
//
// This generates real dewpt candidates for a seed (same generation path the app
// uses), embeds them, projects onto three phrase-named axes, and emits a
// self-contained HTML explorer with the coordinates baked in. It also prints
// distribution stats, so the clumping question gets a number and not a vibe.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
//     npm run axis-layout -- "your seed here" [--out=path.html] [--count=40]

import { generateCandidates, type AiRunner } from "../src/generation";
import { EMBED_MODEL, cosine, embedTexts, requireCreds, sub } from "./axis-lib";

const GEN_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Poles are descriptive phrases, not bare words — axis-phrasing-spike.ts shows
 *  bare words lose ~0.34 AUC to polysemy. These are the expansions the app's
 *  pole-expansion step would produce. */
const AXES = [
  {
    key: "concrete",
    label: "concrete ↔ abstract",
    neg: "a physical object you can touch",
    pos: "an abstract idea or principle",
  },
  {
    key: "practical",
    label: "practical ↔ mystical",
    neg: "a routine practical task",
    pos: "a mystical or magical practice",
  },
  {
    key: "scale",
    label: "intimate ↔ monumental",
    neg: "something small, intimate, and personal in scale",
    pos: "something vast, monumental, and impersonal in scale",
  },
];

// Sample the strangeness bands the field actually serves, so the layout is
// tested against real near- and far-field vocabulary rather than one flavour.
const BANDS = [
  { strangeness: 0.2, altitude: 0.3, tier: 0 },
  { strangeness: 0.5, altitude: 0.5, tier: 1 },
  { strangeness: 0.85, altitude: 0.7, tier: 2 },
];

function restRunner(accountId: string, token: string): AiRunner {
  return {
    async run(model, inputs) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(inputs),
      });
      const body = (await res.json()) as { success: boolean; result?: unknown; errors?: { message: string }[] };
      if (!res.ok || !body.success) {
        throw new Error(`${model}: ${body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
      }
      return body.result;
    },
  };
}

// ── distribution stats — the actual answer to "does it clump?" ──────────────

function stats(xs: number[]): { sd: number; range: number; midShare: number } {
  const mu = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  // Share of words sitting in the middle fifth of the observed range. Uniform
  // spread → ~0.20. Heavy clumping → much higher. This is the clumping metric.
  const midLo = lo + (hi - lo) * 0.4;
  const midHi = lo + (hi - lo) * 0.6;
  return { sd, range: hi - lo, midShare: xs.filter((x) => x >= midLo && x <= midHi).length / xs.length };
}

function histogram(xs: number[], bins = 20): string {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const counts = new Array(bins).fill(0);
  for (const x of xs) counts[Math.min(bins - 1, Math.floor(((x - lo) / (hi - lo || 1)) * bins))]++;
  const peak = Math.max(...counts);
  return counts.map((c) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((c / peak) * 7))]).join("");
}

/** JSON for embedding inside a <script> block. JSON.stringify does not escape
 *  `<`, so a generated candidate containing "</script>" would break out of the
 *  block — and candidates are model output, i.e. untrusted. U+2028/2029 are
 *  literal newlines in JS source but legal in JSON strings. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildHtml(seed: string, words: { text: string; tier: number; coords: number[] }[]): string {
  const data = jsonForScript({ seed, axes: AXES.map((a) => ({ key: a.key, label: a.label, neg: a.neg, pos: a.pos })), words });
  return `<!doctype html>
<meta charset="utf-8">
<title>dewpt — axis layout prototype</title>
<style>
  :root { --bg:#0b0d12; --fg:#c9d1e0; --dim:#5a6478; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  header { padding:16px 20px 8px; }
  h1 { margin:0 0 2px; font-size:15px; font-weight:600; letter-spacing:.02em; }
  .sub { color:var(--dim); font-size:12px; }
  .wrap { display:grid; grid-template-columns: 1fr 260px; gap:20px; padding:12px 20px 24px; }
  @media (max-width:820px) { .wrap { grid-template-columns:1fr; } }
  #field { position:relative; height:clamp(380px,62vh,680px); border:1px solid #1c2130; border-radius:10px;
           background:radial-gradient(ellipse at 50% 45%, #10141d 0%, var(--bg) 70%); overflow:hidden; }
  .word { position:absolute; white-space:nowrap; cursor:default; transform:translate(-50%,-50%);
          transition:opacity .25s, filter .25s, font-size .25s; }
  .t0 { color:#8f9bb3; } .t1 { color:#b6a8e0; } .t2 { color:#e0a874; }
  .panel { font-size:12px; }
  .ctl { margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid #1a1f2c; }
  .ctl:last-child { border-bottom:0; }
  label { display:block; color:var(--dim); margin-bottom:4px; text-transform:uppercase; letter-spacing:.06em; font-size:10px; }
  select, input[type=range] { width:100%; }
  select { background:#141926; color:var(--fg); border:1px solid #232a3a; border-radius:6px; padding:4px 6px; }
  .poles { display:flex; justify-content:space-between; color:var(--dim); font-size:10px; margin-top:3px; }
  .stat { color:var(--dim); font-size:11px; margin-top:8px; }
  .stat b { color:var(--fg); font-weight:600; }
  code { color:#8f9bb3; }
</style>
<header>
  <h1>axis layout prototype — <span id="seed"></span></h1>
  <div class="sub">Real dewpt candidates, embedded and projected onto phrase-named axes. Does this read as a <em>place</em>?</div>
</header>
<div class="wrap">
  <div id="field"></div>
  <div class="panel" id="panel"></div>
</div>
<script>
const DATA = ${data};
document.getElementById('seed').textContent = DATA.seed;
const field = document.getElementById('field'), panel = document.getElementById('panel');
const state = { x:0, y:1, z:2, pos:[0,0,0] };

function sd(xs){const m=xs.reduce((s,x)=>s+x,0)/xs.length;return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/xs.length);}

function buildPanel(){
  panel.innerHTML = '';
  // Built via DOM APIs rather than innerHTML: axis labels and poles are
  // constants today, but the word data alongside them is model output and this
  // file is a template for the real control. textContent by default.
  const el=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=txt;return n;};
  [['x','horizontal'],['y','vertical'],['z','depth']].forEach(([dim,name])=>{
    const a = DATA.axes[state[dim]];
    const d = el('div','ctl');
    d.appendChild(el('label',null,name+' axis'));
    const sel = document.createElement('select'); sel.dataset.dim = dim;
    DATA.axes.forEach((ax,i)=>{
      const o=el('option',null,ax.label); o.value=String(i); o.selected=state[dim]===i; sel.appendChild(o);
    });
    d.appendChild(sel);
    const lo=el('div','poles'); lo.appendChild(el('span',null,a.neg)); d.appendChild(lo);
    const hi=el('div','poles'); const hs=el('span',null,a.pos);
    hs.style.textAlign='right'; hs.style.width='100%'; hi.appendChild(hs); d.appendChild(hi);
    const pl=el('label',null,'your position along it'); pl.style.marginTop='8px'; d.appendChild(pl);
    const r=document.createElement('input');
    r.type='range'; r.min='-100'; r.max='100'; r.value=String(state.pos[state[dim]]*100); r.dataset.pos=dim;
    d.appendChild(r);
    panel.appendChild(d);
  });
  const coords = DATA.axes.map((_,i)=>DATA.words.map(w=>w.coords[i]));
  const s = el('div','ctl');
  s.appendChild(el('label',null,'spread per axis (sd)'));
  DATA.axes.forEach((a,i)=>{
    const row=el('div','stat',a.label+' — ');
    row.appendChild(el('b',null,sd(coords[i]).toFixed(3)));
    s.appendChild(row);
  });
  const foot=el('div','stat',DATA.words.length+' words · drag a position slider to walk the axis');
  foot.style.marginTop='8px'; s.appendChild(foot);
  panel.appendChild(s);
  panel.querySelectorAll('select').forEach(el=>el.onchange=e=>{state[e.target.dataset.dim]=+e.target.value;buildPanel();render();});
  panel.querySelectorAll('input[data-pos]').forEach(el=>el.oninput=e=>{state.pos[state[e.target.dataset.pos]]=+e.target.value/100;render();});
}

function render(){
  const ax=[state.x,state.y,state.z];
  const cs=ax.map(i=>DATA.words.map(w=>w.coords[i]));
  const lo=cs.map(c=>Math.min(...c)), hi=cs.map(c=>Math.max(...c));
  const nrm=(v,i)=>(v-lo[i])/((hi[i]-lo[i])||1);
  field.innerHTML='';
  for(const w of DATA.words){
    const x=nrm(w.coords[ax[0]],0), y=1-nrm(w.coords[ax[1]],1), z=nrm(w.coords[ax[2]],2);
    // focus: distance from your position along the depth axis drives clarity,
    // replacing the field's Math.random() depth with a real one
    const zt=(state.pos[ax[2]]+1)/2, near=1-Math.min(1,Math.abs(z-zt)*2);
    const el=document.createElement('span');
    el.className='word t'+w.tier; el.textContent=w.text;
    el.style.left=(6+x*88)+'%'; el.style.top=(8+y*84)+'%';
    el.style.fontSize=(12+near*10).toFixed(1)+'px';
    el.style.filter='blur('+((1-near)*1.6).toFixed(2)+'px)';
    el.style.opacity=(0.28+near*0.72).toFixed(2);
    el.title=DATA.axes.map((a,i)=>a.label+': '+w.coords[i].toFixed(3)).join('\\n');
    field.appendChild(el);
  }
}
buildPanel(); render();
</script>`;
}

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();
  const args = process.argv.slice(2);
  const flags = new Map(args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...r] = a.slice(2).split("=");
    return [k!, r.join("=")] as const;
  }));
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim() || "tools for thinking";
  const count = Number(flags.get("count")) || 40;
  const out = flags.get("out") || "axis-layout.html";

  const ai = restRunner(accountId, token);
  console.log(`seed: "${seed}"   ${count} candidates × ${BANDS.length} bands   models: ${GEN_MODEL}, ${EMBED_MODEL}\n`);

  const batches = await Promise.all(
    BANDS.map((b) => generateCandidates(ai, GEN_MODEL, {
      seed, strangeness: b.strangeness, altitude: b.altitude, anchors: [], exclude: [], count,
    })),
  );

  const seen = new Set<string>();
  const words: { text: string; tier: number }[] = [];
  batches.forEach((batch, i) => {
    for (const text of batch) {
      const k = text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      words.push({ text, tier: BANDS[i]!.tier });
    }
  });
  console.log(`generated ${words.length} unique candidates`);

  const poles = AXES.flatMap((a) => [a.neg, a.pos]);
  const vecs = await embedTexts(accountId, token, [...words.map((w) => w.text), ...poles]);
  const wordVecs = vecs.slice(0, words.length);
  const poleVecs = vecs.slice(words.length);
  const axisVecs = AXES.map((_, i) => sub(poleVecs[i * 2 + 1]!, poleVecs[i * 2]!));

  const placed = words.map((w, i) => ({ ...w, coords: axisVecs.map((av) => cosine(wordVecs[i]!, av)) }));

  console.log("\n── distribution per axis (the clumping question) ──");
  console.log("   midShare = fraction sitting in the middle fifth of the range.");
  console.log("   ~0.20 = evenly spread · >0.40 = clumping · >0.60 = a blob\n");
  AXES.forEach((a, i) => {
    const xs = placed.map((p) => p.coords[i]!);
    const s = stats(xs);
    const verdict = s.midShare > 0.6 ? "BLOB" : s.midShare > 0.4 ? "clumped" : "spread";
    console.log(`   ${a.label.padEnd(24)} sd ${s.sd.toFixed(3)}  range ${s.range.toFixed(3)}  midShare ${s.midShare.toFixed(2)}  ${verdict}`);
    console.log(`   ${" ".repeat(24)} ${histogram(xs)}`);
  });

  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, buildHtml(seed, placed), "utf8");
  console.log(`\nwrote ${out} — open it to judge legibility`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
