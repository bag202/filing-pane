/* Folder suggestion: retrieval over previously-filed mail, then one LLM call
   to rank. The archive is the authority -- where the archive and the folder
   rubric disagree, the archive wins. That is not a style preference: in the
   2026-09 backtest it took top-3 accuracy from 69% to 84%, almost entirely by
   correcting folders the rubric described wrongly.

   Deliberately NOT a scoring engine. Nothing here decides when to file --
   only where, and only as a suggestion. */

const FilingClassifier = (() => {

  // Measured, not assumed. Leave-one-out over the example bank (eval.html).
  //
  //                 51 examples / 7 folders   134 examples / 12 folders
  //   Opus 5        90% / 100%  2.6s          82% / 96%  2.7s (5.6s max)
  //   Sonnet 5      86% /  96%  1.8s          81% / 93%  1.8s (4.2s max)
  //   Haiku 4.5     78% /  94%  1.4s          75% / 88%  1.5s (2.2s max)
  //                 (top-1 / top-3, median latency)
  //
  // Everything dropped on the larger bank because the test got harder, not
  // because the classifier got worse -- twelve folders to confuse instead of
  // seven. The useful part is that Opus's lead over Sonnet on top-1 nearly
  // vanished (90 vs 86 became 82 vs 81) while Haiku stayed ~6 points behind
  // on top-3. More real data narrowed the gap at the top and not at the
  // bottom.
  //
  // Sonnet: statistically indistinguishable from Opus on top-1 here, 0.9s
  // faster at the median, and half the cost. Re-run eval.html as the bank
  // grows; if Haiku closes the top-3 gap it becomes the obvious pick.
  const MODEL = "claude-sonnet-5";
  const MAX_EXAMPLES = 24;      // examples sent to the model
  const HALF_LIFE_DAYS = 365;   // recency weighting; conventions drift

  const STOP = new Set(("re fw fwd the a an and or of for to in on at is are was " +
    "were be been with from your you our my this that it as by not but if we us " +
    "i about please thanks thank hi hello all can will would could external " +
    "caution spoofing").split(" "));

  const tokenize = s => (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t));

  const domainOf = addr => ((addr || "").split("@")[1] || "").toLowerCase();

  // Exponential decay so a 2015 convention doesn't outvote a 2026 one.
  function recencyWeight(ts) {
    if (!ts) return 0.5;
    const days = (Date.now() - ts) / 86400000;
    return Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  /* Similarity between the open message and one archive example.
     Sender identity dominates: an exact sender match is far stronger evidence
     than shared subject words. But it can't dominate completely -- internal
     colleagues mail about everything, which is why subject overlap matters at
     all. (In the backtest one internal sender appeared in six folders.) */
  function similarity(msg, ex, msgTokens) {
    let score = 0;
    const s1 = (msg.sender || "").toLowerCase();
    const s2 = (ex.sender || "").toLowerCase();

    if (s1 && s1 === s2) score += 3.0;
    else if (s1 && domainOf(s1) && domainOf(s1) === domainOf(s2)) score += 0.8;

    const exTokens = ex._tokens || (ex._tokens = tokenize(ex.subject));
    if (exTokens.length && msgTokens.length) {
      const set = new Set(exTokens);
      let shared = 0;
      for (const t of msgTokens) if (set.has(t)) shared++;
      // Normalised against the shorter side so a long subject isn't penalised.
      score += 4.0 * (shared / Math.min(msgTokens.length, exTokens.length));
    }
    return score * recencyWeight(ex.ts);
  }

  function retrieve(msg, bank) {
    const msgTokens = tokenize(msg.subject);
    return bank
      .map(ex => ({ ex, score: similarity(msg, ex, msgTokens) }))
      .filter(r => r.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_EXAMPLES);
  }

  /* Instant, no-network guess used while the model call is in flight.
     Aggregates retrieved examples by folder. Usually right for vendor mail
     and usually wrong for internal colleagues -- which is exactly why it is
     a placeholder and not the answer. */
  function heuristic(hits) {
    const byFolder = new Map();
    for (const { ex, score } of hits) {
      const cur = byFolder.get(ex.folder) || { folder: ex.folder, score: 0, n: 0 };
      cur.score += score; cur.n++;
      byFolder.set(ex.folder, cur);
    }
    return [...byFolder.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(f => ({
        folder: f.folder,
        why: f.n === 1 ? "1 similar thread" : `${f.n} similar threads`,
        provisional: true
      }));
  }

  function buildPrompt(msg, hits, folders) {
    const examples = hits.map(({ ex }) =>
      `${ex.sender}\t${ex.subject}\t-> ${ex.folder}`).join("\n");
    return `Decide which Outlook folder this email should be filed in.

SIMILAR EMAILS FROM THE ARCHIVE (sender, subject, folder actually used):
${examples || "(no similar mail found)"}

ALL VALID FOLDERS:
${folders.join("\n")}

EMAIL TO FILE:
From: ${msg.sender}
Subject: ${msg.subject}
${msg.preview ? "Preview: " + msg.preview : ""}

The archive above is the authority. Where it shows a pattern, follow it even
if the folder's name suggests somewhere else. Where the archive is silent or
contradicts itself, reason from the folder names.

Reply with JSON only:
{"suggestions":[{"folder":"<exact path>","why":"<max 6 words, cite the evidence>"},...]}
Exactly 3 suggestions, best first, all different, all from the valid list.`;
  }

  // model is optional so an eval harness can sweep it without touching MODEL.
  async function rank(msg, hits, folders, apiKey, model) {
    // Haiku 4.5 rejects output_config.effort outright ("This model does not
    // support the effort parameter"), so only send it where it is supported.
    const body = {
      model: model || MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: buildPrompt(msg, hits, folders) }]
    };
    if (!/haiku/i.test(body.model)) {
      body.output_config = { effort: "low" };   // classification, not deliberation
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON in model reply");

    const parsed = JSON.parse(match[0]);
    const valid = new Set(folders);
    const out = (parsed.suggestions || [])
      .filter(s => s && valid.has(s.folder))
      .slice(0, 3);
    if (!out.length) throw new Error("model returned no valid folder");
    return out;
  }

  return { tokenize, retrieve, heuristic, rank, MODEL };
})();

if (typeof window !== "undefined") window.FilingClassifier = FilingClassifier;
