// SPIKE 2: is the weak "concrete ↔ abstract" result caused by POLYSEMY of the
// axis term rather than a limit of the embedding model?
//
// axis-spike.ts found AUC 0.640 for "concrete" ↔ "abstract", with building
// materials (porcelain, linoleum) colonising the negative pole — the signature
// of embed("concrete") being dragged toward cement. If that's the cause, then
// naming the same axis with unambiguous words or phrases should recover the
// ordering. If AUC stays flat across all phrasings, the model just can't
// express this dimension and the finding is a real ceiling.
//
// Control: also re-phrase the axis that already worked (practical ↔ mystical),
// to check that phrasing changes don't degrade a healthy axis.
//
// Result on 2026-07-20: polysemy confirmed. Descriptive phrases take
// concrete↔abstract from 0.640 to 0.980 and hold practical↔mystical at 1.000.
// This is the source of the phrasing table in
// docs/latent-space-navigation-design.md, and the reason axis poles must be
// expanded to phrases before embedding.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run axis-phrasing-spike

import { DISTRACTORS, EMBED_MODEL, auc, cosine, embedTexts, requireCreds, sub } from "./axis-lib";

type Variant = { label: string; neg: string; pos: string };
type Probe = { name: string; neg: string[]; pos: string[]; variants: Variant[] };

const PROBES: Probe[] = [
  {
    name: "concrete ↔ abstract  (the weak axis)",
    neg: ["hammer", "doorknob", "shoelace", "sandwich", "stapler", "bucket", "ladder", "teapot", "wrench", "mailbox"],
    pos: ["justice", "ambiguity", "essence", "virtue", "causality", "ideology", "autonomy", "legitimacy", "transcendence", "plurality"],
    variants: [
      { label: "bare (axis-spike baseline)", neg: "concrete", pos: "abstract" },
      { label: "unambiguous synonyms", neg: "tangible", pos: "conceptual" },
      { label: "two-word", neg: "physical object", pos: "abstract idea" },
      { label: "descriptive phrase", neg: "a physical object you can touch", pos: "an abstract idea or principle" },
    ],
  },
  {
    name: "practical ↔ mystical  (control: already AUC 1.000)",
    neg: ["checklist", "invoice", "deadline", "spreadsheet", "timesheet", "receipt", "agenda", "inventory", "logbook", "schedule"],
    pos: ["oracle", "incantation", "ley line", "augury", "seance", "talisman", "prophecy", "alchemy", "divination", "reliquary"],
    variants: [
      { label: "bare (axis-spike baseline)", neg: "practical", pos: "mystical" },
      { label: "unambiguous synonyms", neg: "mundane", pos: "occult" },
      { label: "two-word", neg: "everyday admin", pos: "esoteric ritual" },
      { label: "descriptive phrase", neg: "a routine practical task", pos: "a mystical or magical practice" },
    ],
  },
];

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();

  const words = [...new Set(PROBES.flatMap((p) => [...p.neg, ...p.pos]).concat(DISTRACTORS))];
  const terms = [...new Set(PROBES.flatMap((p) => p.variants.flatMap((v) => [v.neg, v.pos])))];
  const all = [...words, ...terms];

  console.log(`model: ${EMBED_MODEL} — embedding ${all.length} texts\n`);
  const vecs = await embedTexts(accountId, token, all);
  const byText = new Map(all.map((t, i) => [t, vecs[i]!]));

  for (const probe of PROBES) {
    console.log("═".repeat(78));
    console.log(`PROBE: ${probe.name}`);
    console.log("═".repeat(78) + "\n");

    const scored = [...probe.neg, ...probe.pos, ...DISTRACTORS];
    const tag = (w: string) => (probe.pos.includes(w) ? "+" : probe.neg.includes(w) ? "−" : "·");

    for (const v of probe.variants) {
      const axis = sub(byText.get(v.pos)!, byText.get(v.neg)!);
      const scores = new Map(scored.map((w) => [w, cosine(byText.get(w)!, axis)]));
      const a = auc(probe.pos.map((w) => scores.get(w)!), probe.neg.map((w) => scores.get(w)!));
      const ranked = scored.slice().sort((x, y) => scores.get(y)! - scores.get(x)!);
      const intruders =
        ranked.slice(0, 5).filter((w) => tag(w) === "·").length +
        ranked.slice(-5).filter((w) => tag(w) === "·").length;

      console.log(`  ${v.label}`);
      console.log(`     "${v.neg}"  ↔  "${v.pos}"`);
      console.log(`     AUC ${a.toFixed(3)}   distractors in poles: ${intruders}/10`);
      console.log(`     top:    ${ranked.slice(0, 5).map((w) => `${tag(w)}${w}`).join("  ")}`);
      console.log(`     bottom: ${ranked.slice(-5).map((w) => `${tag(w)}${w}`).join("  ")}\n`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
