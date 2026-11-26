// livelihood_tody 인스타 댓글 → 공개 답글 · 여는 DM · 팔로우 확인 · 링크 DM (Meta 웹훅, Cloudflare Worker)
// 2026-11-26. 비밀 값(IG_TOKEN, APP_SECRET, VERIFY_TOKEN)은 Cloudflare 설정에만 있고 코드·저장소에는 없음.
// 규칙(릴스별 문구·링크)은 rules.json — 이 PC의 인스타/댓글DM_규칙.json 에서 토큰 없이 만들어 올림.
import RULES from "../rules.json";

const GRAPH = "https://graph.facebook.com/v23.0";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function graph(env, method, path, params = {}, body = null) {
  const url = new URL(`${GRAPH}/${path}`);
  url.searchParams.set("access_token", env.IG_TOKEN);
  let init = { method };
  if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else if (body) init = { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  else init = { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) };
  const r = await fetch(url, init);
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  return { ok: r.ok, data: d };
}

const sendDM = (env, recipient, message) => graph(env, "POST", `${env.IG_USER_ID}/messages`, {}, { recipient, message });

async function log(env, line) {
  // 최근 200줄만 KV 에 보관 (/log 로 확인)
  const k = "log";
  const prev = JSON.parse((await env.STATE.get(k)) || "[]");
  prev.push(`${new Date().toISOString()} ${line}`);
  await env.STATE.put(k, JSON.stringify(prev.slice(-200)));
}

const OWN = new Set(["livelihood_tody", "history.magazine_", "history_per_day_"]);

async function onComment(env, v) {
  const cid = v.id;
  const from = v.from || {};
  const mid = (v.media || {}).id;
  if (!cid || v.parent_id) return; // 답글에는 반응하지 않음
  if ((from.username || "") === env.IG_USERNAME) return;
  const rule = RULES.find((r) => r.active && String(r.media_id) === String(mid));
  if (!rule) return;
  if (rule.keywords && rule.keywords.length && !rule.keywords.some((k) => (v.text || "").includes(k))) return;
  if (await env.STATE.get(`c:${cid}`)) return; // 이미 처리
  await env.STATE.put(`c:${cid}`, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  const n = parseInt((await env.STATE.get(`n:${rule.name}`)) || "0", 10);
  await env.STATE.put(`n:${rule.name}`, String(n + 1));
  const reply = rule.public_replies[n % rule.public_replies.length];
  const r1 = await graph(env, "POST", `${cid}/replies`, { message: reply });
  const r2 = await sendDM(env, { comment_id: cid }, {
    text: rule.opening_dm,
    quick_replies: [{ content_type: "text", title: rule.button, payload: `FOLLOWED:${rule.name}` }],
  });
  if (from.id && r2.ok) {
    await env.STATE.put(`p:${from.id}`, JSON.stringify({ rule: rule.name, user: from.username, at: Date.now(), link: false, nudged: 0 }), { expirationTtl: 60 * 60 * 24 * 2 });
  }
  const ext = OWN.has(from.username) ? "" : "[외부] ";
  await log(env, `${ext}[${rule.name}] @${from.username} 공개답글 ${r1.ok ? "OK" : "실패 " + JSON.stringify(r1.data).slice(0, 160)} · 여는DM ${r2.ok ? "OK" : "실패 " + JSON.stringify(r2.data).slice(0, 160)}`);
}

async function onMessage(env, m) {
  const sender = (m.sender || {}).id;
  if (!sender || sender === env.IG_USER_ID) return;
  const msg = m.message || {};
  if (msg.is_echo) return;
  const raw = await env.STATE.get(`p:${sender}`);
  if (!raw) return; // 우리가 여는 DM 을 보낸 사람이 아님
  const p = JSON.parse(raw);
  if (p.link) return;
  const rule = RULES.find((r) => r.name === p.rule);
  if (!rule) return;
  if (Date.now() - p.at > 24 * 3600 * 1000) return;
  const f = await graph(env, "GET", sender, { fields: "is_user_follow_business" });
  const following = f.ok ? !!f.data.is_user_follow_business : null;
  const decision = following ? "send" : following === false ? "nudge" : (rule.follow_unknown || "send");
  const ext = OWN.has(p.user) ? "" : "[외부] ";
  if (decision === "send") {
    const r = await sendDM(env, { id: sender }, { text: `${rule.link_dm}\n${rule.link_url}` });
    p.link = r.ok;
    await log(env, `${ext}[${rule.name}] @${p.user} 팔로우=${following} 링크DM ${r.ok ? "OK" : "실패 " + JSON.stringify(r.data).slice(0, 160)}`);
  } else if ((p.nudged || 0) < 3) {
    const r = await sendDM(env, { id: sender }, {
      text: rule.not_following_dm,
      quick_replies: [{ content_type: "text", title: rule.button, payload: `FOLLOWED:${rule.name}` }],
    });
    p.nudged = (p.nudged || 0) + 1;
    await log(env, `${ext}[${rule.name}] @${p.user} 아직 팔로우 아님 → 안내 ${r.ok ? "OK" : "실패"}`);
  }
  await env.STATE.put(`p:${sender}`, JSON.stringify(p), { expirationTtl: 60 * 60 * 24 * 2 });
}

const PRIVACY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>livelihood_tody 개인정보처리방침</title>
<body style="font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.7">
<h1>livelihood_tody 개인정보처리방침</h1>
<p>이 서비스는 인스타그램 계정 <b>@livelihood_tody</b>의 게시물에 댓글을 남긴 분에게, 요청하신 상품 정보 링크를 인스타그램 메시지(DM)로 보내 드리기 위해 운영됩니다.</p>
<h2>처리하는 정보</h2><ul><li>댓글을 남긴 인스타그램 계정의 이용자 ID와 사용자 이름, 댓글 내용</li><li>@livelihood_tody 팔로우 여부(링크 발송 조건 확인용)</li><li>보낸 메시지의 처리 결과</li></ul>
<h2>이용 목적과 보관 기간</h2><p>위 정보는 메시지 발송과 중복 발송 방지에만 쓰며, 다른 목적으로 쓰거나 제3자에게 제공하지 않습니다. 발송 상태 기록은 최대 30일 뒤 자동으로 삭제됩니다.</p>
<h2>광고 표시</h2><p>보내 드리는 링크는 제휴(어필리에이트) 링크이며, 링크를 통해 구매하면 운영자가 수수료를 받을 수 있습니다.</p>
<h2>삭제 요청</h2><p>인스타그램 메시지로 @livelihood_tody 에 "정보 삭제"라고 보내 주시면 관련 기록을 지웁니다. 자세한 방법: <a href="/delete">/delete</a></p>
<p>시행일: 2026년 11월 26일</p></body>`;

const DELETE = `<!doctype html><meta charset="utf-8"><title>데이터 삭제 안내</title><body style="font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.7">
<h1>데이터 삭제 안내</h1><p>@livelihood_tody 에 인스타그램 메시지로 "정보 삭제"라고 보내 주시면, 이 서비스에 남은 회원님의 기록(댓글 처리 여부, 메시지 발송 상태)을 7일 안에 지웁니다. 기록은 요청이 없어도 최대 30일 뒤 자동으로 지워집니다.</p></body>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/privacy") return new Response(PRIVACY, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/delete") return new Response(DELETE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/health") return json({ ok: true, rules: RULES.filter((r) => r.active).map((r) => r.name), secrets: { IG_TOKEN: !!env.IG_TOKEN, APP_SECRET: !!env.APP_SECRET, APP_SECRET2: !!env.APP_SECRET2, VERIFY_TOKEN: !!env.VERIFY_TOKEN }, kv: !!env.STATE });
    if (url.pathname === "/log") {
      if (!env.VERIFY_TOKEN || url.searchParams.get("k") !== env.VERIFY_TOKEN) return json({ error: "forbidden" }, 403);
      return json(JSON.parse((await env.STATE.get("log")) || "[]"));
    }
    if (url.pathname === "/claim") {
      // 이 PC의 15초 확인 도구(comment_dm.py)가 댓글을 처리하기 전에 부름 → 웹훅과 두 번 보내지 않게
      if (!env.VERIFY_TOKEN || url.searchParams.get("k") !== env.VERIFY_TOKEN) return json({ error: "forbidden" }, 403);
      const cid = url.searchParams.get("c") || "";
      if (!/^\d+$/.test(cid)) return json({ error: "bad id" }, 400);
      if (await env.STATE.get(`c:${cid}`)) return json({ claimed: false });
      await env.STATE.put(`c:${cid}`, "poll", { expirationTtl: 60 * 60 * 24 * 30 });
      return json({ claimed: true });
    }
    if (url.pathname !== "/webhook") return new Response("livelihood_tody webhook", { status: 200 });

    if (request.method === "GET") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && env.VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200 }) : new Response("forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("method", { status: 405 });

    const body = await request.arrayBuffer();
    const sig = (request.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
    // 앱 두 개(livelihood tody · livelihood dm)의 서명을 모두 받음
    const secrets = [env.APP_SECRET, env.APP_SECRET2].filter(Boolean);
    let okSig = false;
    for (const sc of secrets) if (sig && safeEqual(sig, await hmacHex(sc, body))) okSig = true;
    if (!okSig) {
      // 원인 확인용: 값은 남기지 않고 길이·개수만
      ctx.waitUntil(log(env, `서명 불일치 (서명 ${sig.length}자, 비밀 ${secrets.length}개, 길이 ${secrets.map((x) => x.length).join("/")})`));
      return new Response("bad signature", { status: 401 });
    }
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response("bad json", { status: 400 }); }

    const work = async () => {
      // 수신 확인용 한 줄 (내용·사용자 이름 없이 필드와 개수만)
      const kinds = (payload.entry || []).flatMap((e) => [...(e.changes || []).map((c) => c.field), ...(e.messaging || []).map(() => "messaging")]);
      await log(env, `수신 ${payload.object || "?"} ${kinds.join(",") || "빈 이벤트"}`);
      for (const entry of payload.entry || []) {
        for (const ch of entry.changes || []) {
          if (ch.field === "comments") await onComment(env, ch.value || {}).catch((e) => log(env, "comment 오류 " + e));
        }
        for (const m of entry.messaging || []) await onMessage(env, m).catch((e) => log(env, "message 오류 " + e));
      }
    };
    ctx.waitUntil(work()); // Meta 에는 바로 200 응답
    return new Response("EVENT_RECEIVED", { status: 200 });
  },
};
