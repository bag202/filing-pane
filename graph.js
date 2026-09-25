/* Microsoft Graph calls the filing pane needs: read the real folder tree, and
   move every message in a thread.

   The folder tree matters more than it looks. Deriving the folder list from
   the example bank only ever surfaces folders that already have history, so a
   newly created folder would be invisible and unfileable. Reading it live also
   means the pane never holds a stale copy of the mailbox's shape. */

const Graph = (() => {

  const ROOT = "https://graph.microsoft.com/v1.0";
  const MAX_DEPTH = 4;            // deeper than the mailbox tree actually goes
  const BATCH_MAX = 20;           // Graph's per-$batch request limit

  async function call(token, path, init) {
    const resp = await fetch(ROOT + path, Object.assign({
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json"
      }
    }, init || {}));

    if (!resp.ok) {
      let detail = "";
      try {
        const body = await resp.json();
        detail = (body.error && body.error.message) || "";
      } catch { /* non-JSON error body */ }
      throw new Error(`Graph ${resp.status}${detail ? ": " + detail : ""}`);
    }
    return resp.status === 204 ? null : resp.json();
  }

  /* Flatten the mail folder tree into [{ id, path }] with slash-separated
     paths, so the pane shows a full folder path the way the
     example bank and the folder rubric both write it. */
  async function listFolders(token) {
    const out = [];

    async function walk(parentPath, endpoint, depth) {
      if (depth > MAX_DEPTH) return;
      let url = endpoint + "?$top=200&$select=id,displayName,childFolderCount";
      while (url) {
        const page = await call(token, url);
        for (const f of page.value || []) {
          const path = parentPath ? parentPath + "/" + f.displayName : f.displayName;
          out.push({ id: f.id, path });
          if (f.childFolderCount > 0) {
            await walk(path, `/me/mailFolders/${f.id}/childFolders`, depth + 1);
          }
        }
        // @odata.nextLink is absolute; strip the base so call() can prepend it.
        url = page["@odata.nextLink"]
          ? page["@odata.nextLink"].replace(ROOT, "")
          : null;
      }
    }

    // Start below Inbox as well as at the root: most filing folders are
    // Inbox children, but some mailboxes keep a few at the top level too.
    await walk("", "/me/mailFolders", 0);
    return out;
  }

  async function messagesInConversation(token, conversationId) {
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
    const page = await call(token,
      `/me/messages?$filter=${filter}&$select=id&$top=100`);
    return (page.value || []).map(m => m.id);
  }

  async function moveMessage(token, messageId, destinationId) {
    return call(token, `/me/messages/${messageId}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId })
    });
  }

  /* Move the whole thread, matching what the user does by hand and what the
     triage app already did. Returns how many messages moved.

     Takes only the message id and asks Graph for the conversation itself.
     Office.js hands out EWS-format ids and its conversationId is the EWS
     one, which Graph does not recognise -- so the caller converts the item
     id with convertToRestId and we resolve the thread from there rather than
     trying to reconcile two id schemes. */
  async function moveThread(token, messageId, destinationId) {
    if (!messageId) throw new Error("nothing to move");

    let ids = [messageId];
    try {
      const msg = await call(token,
        `/me/messages/${messageId}?$select=id,conversationId`);
      if (msg && msg.conversationId) {
        const siblings = await messagesInConversation(token, msg.conversationId);
        if (siblings.length) ids = siblings;
      }
    } catch {
      // Thread lookup failed; moving just the open message is still correct,
      // just less complete. Better than refusing to file at all.
    }

    /* One $batch per 20 moves rather than one request per message. Moving
       one at a time was fine for the handful a thread usually holds, but a
       15-message thread took several seconds of round trips -- long enough
       for Outlook to reload the pane under us. Anything the batch could not
       move (a 429 inside it, say) is retried on its own, sequentially, so a
       throttled burst still ends with the whole thread filed. */
    let moved = 0;
    const retry = [];
    for (let i = 0; i < ids.length; i += BATCH_MAX) {
      const chunk = ids.slice(i, i + BATCH_MAX);
      let responses;
      try {
        const out = await call(token, "/$batch", {
          method: "POST",
          body: JSON.stringify({
            requests: chunk.map((id, n) => ({
              id: String(n),
              method: "POST",
              url: `/me/messages/${id}/move`,
              headers: { "content-type": "application/json" },
              body: { destinationId }
            }))
          })
        });
        responses = (out && out.responses) || [];
      } catch {
        responses = [];            // whole batch refused; retry every item
      }
      const ok = new Set(responses
        .filter(r => r.status >= 200 && r.status < 300)
        .map(r => Number(r.id)));
      chunk.forEach((id, n) => { if (ok.has(n)) moved++; else retry.push(id); });
    }

    for (const id of retry) {
      await moveMessage(token, id, destinationId);
      moved++;
    }
    return moved;
  }

  /* ---- the example bank, stored in OneDrive -------------------------

     Lives in the app folder (/me/drive/special/approot, which surfaces as
     "Apps/<app name>" in OneDrive) rather than an arbitrary path.
     That lets the add-in ask for Files.ReadWrite.AppFolder instead of
     Files.ReadWrite -- it can touch its own folder and nothing else in the
     drive. For a file holding years of mail metadata, the narrower grant is
     worth the slightly fiddlier path.

     It cannot live beside the add-in's static files: an Azure Blob static
     website serves $web anonymously, so anything hosted there is public. */

  const BANK_PATH = "/me/drive/special/approot:/examples.json";

  async function loadExamples(token) {
    const resp = await fetch(ROOT + BANK_PATH + ":/content", {
      headers: { authorization: "Bearer " + token }
    });
    if (resp.status === 404) return [];        // first run, nothing saved yet
    if (!resp.ok) throw new Error("Graph " + resp.status + " reading the bank");
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  async function saveExamples(token, bank) {
    const resp = await fetch(ROOT + BANK_PATH + ":/content", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json"
      },
      body: JSON.stringify(bank)
    });
    if (!resp.ok) throw new Error("Graph " + resp.status + " writing the bank");
    return resp.json();
  }

  return { listFolders, moveThread, call, loadExamples, saveExamples };
})();

if (typeof window !== "undefined") window.Graph = Graph;
