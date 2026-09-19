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
     a placeholder and not the answer.

     Measured, same leave-one-out as the table above, 134 examples:

       this heuristic alone   55% top-1   78% top-3
       ranked by the model    81% top-1   93% top-3

     So it is worth drawing immediately and worth never trusting. Its three
     folders usually contain the right one, but it puts the right one first
     only half the time -- and the first card is the one that gets pressed.
     That gap is the argument against "just show the fast answer": the
     reorder is nearly the whole value, which is why the model call is
     streamed rather than replaced with something cheaper. */
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

  /* Pull whole suggestions out of a half-written JSON reply.

     The model streams `{"suggestions":[{"folder":"03 PDS","why":"..."},...`
     and the folder name -- the only part needed to draw a pressable button --
     closes long before the reply does. So a suggestion counts as usable the
     moment its folder string is terminated; `why` fills in a beat later.
     Folder names are matched with the closing quote required, so a
     half-typed name can never be rendered as a real one. */
  const SUGG_RE =
    /\{\s*"folder"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"why"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;

  function parsePartial(text, valid) {
    const out = [];
    const seen = new Set();
    SUGG_RE.lastIndex = 0;
    let m;
    while ((m = SUGG_RE.exec(text))) {
      let folder, why;
      try {
        folder = JSON.parse('"' + m[1] + '"');
        why = m[2] == null ? "" : JSON.parse('"' + m[2] + '"');
      } catch { continue; }          // escape half-written; wait for more
      if (valid && !valid.has(folder)) continue;
      if (seen.has(folder)) continue;
      seen.add(folder);
      out.push({ folder, why });
      if (out.length === 3) break;
    }
    return out;
  }

  /* model is optional so an eval harness can sweep it without touching MODEL.
     onPartial, if given, is called with the suggestions readable so far --
     that is the whole point of streaming here. Latency to the *final* answer
     is unchanged. What shortens is the wait for the top button: fed a typical
     reply one character at a time, the first folder name is complete after
     about a fifth of it, the rest being the two lower suggestions and their
     evidence. That fifth is a fraction of generation only -- time to first
     token is unchanged, so treat it as a useful cut, not a halving. */
  async function rank(msg, hits, folders, apiKey, model, onPartial) {
    // Haiku 4.5 rejects output_config.effort outright ("This model does not
    // support the effort parameter"), so only send it where it is supported.
    const body = {
      model: model || MODEL,
      max_tokens: 400,
      stream: true,
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

    const valid = new Set(folders);
    let text = "";

    if (resp.body && resp.body.getReader) {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let shown = 0;
      for (;;) {
        const { value, done } = await reader.read();
        // On the last read, append the frame terminator rather than breaking
        // out: that lets the split below pick up a tail frame the server did
        // not blank-line off, so it cannot silently drop the third suggestion.
        buf += done ? "\n\n" : dec.decode(value, { stream: true });

        // SSE frames are blank-line separated; keep any trailing partial.
        const frames = buf.split("\n\n");
        buf = frames.pop();
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let ev;
            try { ev = JSON.parse(raw); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta) {
              text += ev.delta.text || ev.delta.partial_json || "";
            } else if (ev.type === "error") {
              throw new Error("Anthropic stream: " +
                ((ev.error && ev.error.message) || "unknown"));
            }
          }
        }

        if (onPartial) {
          const soFar = parsePartial(text, valid);
          // Only call up when there is genuinely more to draw, so a click
          // target is not rebuilt underneath a finger on every chunk.
          if (soFar.length > shown) { shown = soFar.length; onPartial(soFar); }
        }
        if (done) break;
      }
    } else {
      // No streaming support in this engine -- take the whole body at once.
      const data = await resp.json();
      text = (data.content || [])
        .filter(b => b.type === "text").map(b => b.text).join("");
    }

    const out = parsePartial(text, valid);
    if (!out.length) throw new Error("model returned no valid folder");
    return out;
  }

  return { tokenize, retrieve, heuristic, rank, parsePartial, MODEL };
})();

if (typeof window !== "undefined") window.FilingClassifier = FilingClassifier;
