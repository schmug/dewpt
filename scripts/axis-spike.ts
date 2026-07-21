// SPIKE: does projecting bge-m3 embeddings onto a user-named axis produce a
// meaningful ordering? This is the load-bearing assumption behind the
// "term sliders name the axes of the map" design
// (docs/latent-space-navigation-design.md).
//
// Method: three axes with hand-labelled ground truth (plus neutral distractors
// that should land mid-range). For each axis, score every word by three
// candidate projection methods and report AUC — the probability that a random
// positive word outranks a random negative one.
//
// Result on 2026-07-20: pair 0.843 > single 0.763; centering adds nothing
// (0.850). See axis-phrasing-spike.ts for why the concrete↔abstract row is low.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run axis-spike

import {
  DISTRACTORS, EMBED_MODEL, auc, cohensD, cosine, embedTexts, mean, norm, requireCreds, sub,
} from "./axis-lib";

type Axis = {
  name: string;
  negTerm: string;
  posTerm: string;
  neg: string[]; // ground truth: should score low
  pos: string[]; // ground truth: should score high
};

const AXES: Axis[] = [
  {
    // Sanity control. Physical scale is about as unambiguous as semantics gets.
    // If this one fails, nothing else is worth reading.
    name: "small ↔ large (sanity control)",
    negTerm: "small",
    posTerm: "large",
    neg: ["ant", "pebble", "thimble", "crumb", "freckle", "needle", "seed", "button", "splinter", "droplet"],
    pos: ["mountain", "galaxy", "ocean", "cathedral", "glacier", "continent", "whale", "skyscraper", "canyon", "thunderhead"],
  },
  {
    // The axis dewpt already has as a slider. If a typed term can reproduce
    // altitude, user-named axes subsume the built-in ones.
    name: "concrete ↔ abstract",
    negTerm: "concrete",
    posTerm: "abstract",
    neg: ["hammer", "doorknob", "shoelace", "sandwich", "stapler", "bucket", "ladder", "teapot", "wrench", "mailbox"],
    pos: ["justice", "ambiguity", "essence", "virtue", "causality", "ideology", "autonomy", "legitimacy", "transcendence", "plurality"],
  },
  {
    // A genuinely idiosyncratic axis — the kind a user would actually type,
    // and not one any model was trained to expose.
    name: "practical ↔ mystical",
    negTerm: "practical",
    posTerm: "mystical",
    neg: ["checklist", "invoice", "deadline", "spreadsheet", "timesheet", "receipt", "agenda", "inventory", "logbook", "schedule"],
    pos: ["oracle", "incantation", "ley line", "augury", "seance", "talisman", "prophecy", "alchemy", "divination", "reliquary"],
  },
];

type Method = {
  name: string;
  blurb: string;
  score: (wordVec: number[], ctx: { posVec: number[]; negVec: number[]; corpusMean: number[] }) => number;
};

const METHODS: Method[] = [
  {
    name: "single",
    blurb: "axis = the positive term alone; user types one word",
    score: (w, { posVec }) => cosine(w, posVec),
  },
  {
    name: "pair",
    blurb: "axis = pos − neg; user types two words naming both poles",
    score: (w, { posVec, negVec }) => cosine(w, sub(posVec, negVec)),
  },
  {
    name: "pair+centered",
    blurb: "axis = pos − neg, applied after removing the corpus mean",
    score: (w, { posVec, negVec, corpusMean }) => cosine(sub(w, corpusMean), sub(posVec, negVec)),
  },
];

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();

  // One embed call for everything, so the spike costs one round trip per 96
  // texts and every axis shares the same corpus mean.
  const words = [...new Set(AXES.flatMap((a) => [...a.neg, ...a.pos]).concat(DISTRACTORS))];
  const terms = [...new Set(AXES.flatMap((a) => [a.negTerm, a.posTerm]))];
  const all = [...words, ...terms];

  console.log(`model: ${EMBED_MODEL}`);
  console.log(`embedding ${all.length} texts (${words.length} words + ${terms.length} axis terms)…\n`);

  const vecs = await embedTexts(accountId, token, all);
  const byText = new Map(all.map((t, i) => [t, vecs[i]!]));
  const corpusMean = mean(words.map((w) => byText.get(w)!));

  console.log(`dims: ${vecs[0]!.length}   corpus mean ‖·‖: ${norm(corpusMean).toFixed(4)}`);
  console.log("(a large mean norm means one direction dominates — that's what centering removes)\n");

  const summary: { axis: string; method: string; auc: number }[] = [];

  for (const axis of AXES) {
    console.log("═".repeat(74));
    console.log(`AXIS: ${axis.name}`);
    console.log(`      terms typed by user: "${axis.negTerm}" ↔ "${axis.posTerm}"`);
    console.log("═".repeat(74) + "\n");

    const ctx = { posVec: byText.get(axis.posTerm)!, negVec: byText.get(axis.negTerm)!, corpusMean };
    const scored = [...axis.neg, ...axis.pos, ...DISTRACTORS];
    const tag = (w: string) => (axis.pos.includes(w) ? "+" : axis.neg.includes(w) ? "−" : "·");

    for (const method of METHODS) {
      const scores = new Map(scored.map((w) => [w, method.score(byText.get(w)!, ctx)]));
      const posScores = axis.pos.map((w) => scores.get(w)!);
      const negScores = axis.neg.map((w) => scores.get(w)!);
      const a = auc(posScores, negScores);
      summary.push({ axis: axis.name, method: method.name, auc: a });

      const ranked = scored.slice().sort((x, y) => scores.get(y)! - scores.get(x)!);
      const fmt = (w: string) => `${tag(w)} ${w} ${scores.get(w)!.toFixed(3)}`;
      const intruders =
        ranked.slice(0, 5).filter((w) => tag(w) === "·").length +
        ranked.slice(-5).filter((w) => tag(w) === "·").length;

      console.log(`  ── ${method.name}  (${method.blurb})`);
      console.log(`     AUC ${a.toFixed(3)}   Cohen's d ${cohensD(posScores, negScores).toFixed(2)}   distractors in poles: ${intruders}/10`);
      console.log(`     top:    ${ranked.slice(0, 5).map(fmt).join("  ")}`);
      console.log(`     bottom: ${ranked.slice(-5).map(fmt).join("  ")}`);
      console.log("");
    }
  }

  console.log("═".repeat(74));
  console.log("SUMMARY — AUC by method (1.0 = perfect ordering, 0.5 = random)");
  console.log("═".repeat(74) + "\n");
  const header = ["axis".padEnd(34), ...METHODS.map((m) => m.name.padStart(14))].join("");
  console.log(header);
  console.log("─".repeat(header.length));
  for (const axis of AXES) {
    const row = METHODS.map((m) =>
      summary.find((s) => s.axis === axis.name && s.method === m.name)!.auc.toFixed(3).padStart(14),
    );
    console.log([axis.name.slice(0, 33).padEnd(34), ...row].join(""));
  }
  console.log("");
  for (const m of METHODS) {
    const rows = summary.filter((s) => s.method === m.name);
    console.log(`  mean AUC — ${m.name.padEnd(14)} ${(rows.reduce((s, r) => s + r.auc, 0) / rows.length).toFixed(3)}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
