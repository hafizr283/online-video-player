/**
 * Comments under the player.
 *
 * One level of replies: a reply to a reply is posted against the root, which is
 * also what the server enforces. Text is inserted with textContent, never as
 * HTML — the server stores exactly what was typed and this file is the only
 * place it becomes visible.
 */

const list = document.getElementById("comments-list");
const form = document.getElementById("comment-form");
const hint = document.getElementById("comment-hint");
const more = document.getElementById("comments-more");
const countEl = document.getElementById("comments-count");
const nameInput = document.getElementById("comment-name");
const textInput = document.getElementById("comment-text");
const trap = document.getElementById("comment-site");

let titleId = null;
try {
  titleId = JSON.parse(document.getElementById("fpTitleMeta").textContent).id;
} catch { /* not a watch page */ }

let nextBefore = null;
let drawn = 0;

const clock = (ms) => {
  const secs = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
};

const setHint = (message, kind = "") => {
  hint.textContent = message;
  hint.className = "comments__hint" + (kind ? ` is-${kind}` : "");
};

function commentNode(comment, isReply = false) {
  const article = document.createElement("article");
  article.className = "comment" + (isReply ? " comment--reply" : "");
  article.dataset.id = comment.id;

  const head = document.createElement("div");
  head.className = "comment__head";
  const name = document.createElement("span");
  name.className = "comment__name";
  name.textContent = comment.name || "Guest";
  const at = document.createElement("span");
  at.className = "comment__at";
  at.textContent = clock(comment.at);
  head.append(name, at);

  const body = document.createElement("p");
  body.className = "comment__text";
  body.textContent = comment.text;

  article.append(head, body);

  if (!isReply) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "comment__reply";
    reply.textContent = "Reply";
    reply.addEventListener("click", () => openReply(comment.id, article));
    article.append(reply);

    const replies = document.createElement("div");
    replies.className = "comment__replies";
    for (const child of comment.replies || []) replies.append(commentNode(child, true));
    article.append(replies);
  }
  return article;
}

function openReply(rootId, article) {
  if (article.querySelector(".comment__reply-form")) return;
  const box = document.createElement("form");
  box.className = "comment__reply-form comments__form";
  box.style.marginTop = "10px";

  const input = document.createElement("textarea");
  input.rows = 2;
  input.maxLength = 1000;
  input.placeholder = "Write a reply…";
  input.required = true;

  const row = document.createElement("div");
  row.className = "comments__actions";
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "btn btn--primary";
  send.textContent = "Reply";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "comment__reply";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => box.remove());
  row.append(send, cancel);
  box.append(input, row);

  box.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ok = await post(input.value, rootId);
    if (ok) box.remove();
  });

  article.append(box);
  input.focus();
}

async function post(text, parent) {
  const clean = String(text || "").trim();
  if (!clean) return false;
  setHint("Posting…");
  try {
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: titleId,
        parent: parent || null,
        name: nameInput ? nameInput.value : "",
        text: clean,
        website: trap ? trap.value : "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const messages = {
        slow_down: "You just posted — give it 15 seconds.",
        too_many: "That is a lot of comments in an hour. Try again later.",
        too_many_links: "Two links per comment, at most.",
        too_long: "That comment is over 1,000 characters.",
        empty: "Write something first.",
      };
      setHint(messages[data.error] || "Could not post that. Try again.", "error");
      return false;
    }
    if (parent) {
      const root = list.querySelector(`.comment[data-id="${parent}"] .comment__replies`);
      if (root) root.append(commentNode(data.comment, true));
    } else {
      const empty = list.querySelector(".comments__empty");
      if (empty) empty.remove();
      list.prepend(commentNode(data.comment));
      if (textInput) textInput.value = "";
    }
    drawn += 1;
    updateCount();
    setHint("Posted.", "ok");
    setTimeout(() => setHint("Be kind. No spoilers in the first line."), 2500);
    return true;
  } catch {
    setHint("Network error — try again.", "error");
    return false;
  }
}

function updateCount() {
  if (countEl) countEl.textContent = drawn ? `${drawn}${nextBefore ? "+" : ""}` : "";
}

async function load(before) {
  const url = `/api/comments?title=${encodeURIComponent(titleId)}${before ? `&before=${before}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  if (!before) {
    list.textContent = "";
    drawn = 0;
  }
  if (!data.comments.length && !before) {
    const empty = document.createElement("p");
    empty.className = "comments__empty";
    empty.textContent = "No comments yet. Be the first.";
    list.append(empty);
  }
  for (const comment of data.comments) {
    list.append(commentNode(comment));
    drawn += 1 + (comment.replies || []).length;
  }
  nextBefore = data.next || null;
  if (more) more.hidden = !nextBefore;
  updateCount();
}

if (titleId && list && form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ok = await post(textInput.value, null);
    if (ok) textInput.value = "";
  });

  more?.addEventListener("click", () => {
    if (!nextBefore) return;
    load(nextBefore).catch(() => setHint("Could not load more.", "error"));
  });

  load(null).catch(() => {
    list.innerHTML = '<p class="comments__empty">Comments are unavailable right now.</p>';
  });
}
