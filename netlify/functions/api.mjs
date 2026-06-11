
import {createRequire as ___nfyCreateRequire} from "module";
import {fileURLToPath as ___nfyFileURLToPath} from "url";
import {dirname as ___nfyPathDirname} from "path";
let __filename=___nfyFileURLToPath(import.meta.url);
let __dirname=___nfyPathDirname(___nfyFileURLToPath(import.meta.url));
let require=___nfyCreateRequire(import.meta.url);


// netlify/functions/api.js
import { getStore } from "@netlify/blobs";
var BLOTATO_BASE = "https://backend.blotato.com/v2";
var SETTINGS_KEY = "settings";
var DEFAULT_MODEL = "claude-sonnet-4-6";
var RETIRED_MODELS = ["claude-sonnet-4-20250514", "claude-sonnet-4-5", "claude_sonnet_4_6"];
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,x-app-password",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS"
    }
  });
}
function getEnv(name) {
  try {
    return Netlify.env.get(name) || "";
  } catch {
    return process.env[name] || "";
  }
}
function store() {
  return getStore("studio-autopilot", { consistency: "strong" });
}
async function getSettings() {
  const current = await store().get(SETTINGS_KEY, { type: "json" }) || {};
  const savedModel = getEnv("ANTHROPIC_MODEL") || current.anthropicModel || "";
  const anthropicModel = !savedModel || RETIRED_MODELS.includes(savedModel) ? DEFAULT_MODEL : savedModel;
  return {
    appPassword: getEnv("APP_PASSWORD") || current.appPassword || "",
    anthropicApiKey: getEnv("ANTHROPIC_API_KEY") || current.anthropicApiKey || "",
    anthropicModel,
    blotatoApiKey: getEnv("BLOTATO_API_KEY") || current.blotatoApiKey || "",
    deepgramApiKey: getEnv("DEEPGRAM_API_KEY") || current.deepgramApiKey || "",
    accounts: current.accounts || {},
    style: current.style || defaultStyle(),
    brandPrompt: current.brandPrompt || "",
    styleExamples: current.styleExamples || ""
  };
}
async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await store().setJSON(SETTINGS_KEY, next);
  return next;
}
function defaultStyle() {
  return `Italiano naturale. Diretto, concreto, utile.
Frasi brevi. Niente tono corporate.
Una sola idea forte per contenuto.
Hook chiaro nella prima riga.
Tono da consulente esperto ma umano.`;
}
async function requireAuth(req) {
  const settings = await getSettings();
  if (!settings.appPassword) return { ok: false, status: 428, error: "setup_required" };
  const provided = req.headers.get("x-app-password") || "";
  if (provided !== settings.appPassword) return { ok: false, status: 401, error: "password_required" };
  return { ok: true, settings };
}
async function blotato(path, opts = {}, apiKey) {
  const res = await fetch(`${BLOTATO_BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      "blotato-api-key": apiKey,
      ...opts.headers || {}
    }
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || data.message || text || `Blotato ${res.status}`);
  return data;
}
async function listAccounts(settings) {
  const data = await blotato("/users/me/accounts", {}, settings.blotatoApiKey);
  const resolved = {};
  for (const acc of data.items || []) {
    const entry = {
      accountId: acc.id,
      username: acc.username || "",
      fullname: acc.fullname || "",
      platform: acc.platform
    };
    if (["facebook", "linkedin", "youtube"].includes(acc.platform)) {
      try {
        const sub = await blotato(`/users/me/accounts/${acc.id}/subaccounts`, {}, settings.blotatoApiKey);
        entry.subaccounts = sub.items || [];
        if (acc.platform === "facebook" && entry.subaccounts[0]) {
          entry.pageId = entry.subaccounts[0].id;
        }
        if (acc.platform === "youtube") {
          entry.playlistIds = entry.subaccounts.map((item) => item.id);
        }
      } catch {
        entry.subaccounts = [];
      }
    }
    resolved[acc.platform] = entry;
  }
  await saveSettings({ accounts: resolved });
  return resolved;
}
async function generateCopy(body, settings) {
  const platforms = body.platforms?.length ? body.platforms : ["instagram", "facebook", "linkedin", "youtube"];
  const variants = Math.min(Math.max(parseInt(body.variants, 10) || 1, 1), 3);
  const rules = {
    instagram: "Instagram Reel: hook forte, caption breve, CTA leggera, 5-8 hashtag.",
    facebook: "Facebook: caldo e diretto, 2-5 frasi, pochi hashtag.",
    linkedin: "LinkedIn: post professionale ma personale, righe brevi, fino a 3000 caratteri, max 3 hashtag.",
    youtube: 'YouTube Short: in "variants" scrivi SOLO la descrizione (no etichette), includi #Shorts. Aggiungi anche un campo "title" (max 80 caratteri, senza < o >).',
    twitter: "X (Twitter): un solo tweet, massimo 280 caratteri, diretto e incisivo, max 2 hashtag."
  };
  const styleBlock = [
    "STILE DI SCRITTURA DA RISPETTARE:",
    body.style || settings.style,
    settings.brandPrompt ? `
REGOLE EDITORIALI / BRAND:
${settings.brandPrompt}` : "",
    settings.styleExamples ? `
ESEMPI DI CONTENUTI NEL MIO STILE (imita tono, ritmo e struttura, NON copiare il contenuto):
${settings.styleExamples}` : ""
  ].filter(Boolean).join("\n");
  const variantInstr = variants > 1 ? `Per OGNI piattaforma proponi ${variants} varianti diverse tra loro (hook e angolazioni differenti), nell'array "variants".` : `Per OGNI piattaforma proponi 1 testo nell'array "variants".`;
  const userPrompt = `Video: ${body.videoName || "senza nome"}
${body.transcript ? `TRASCRIZIONE DEL VIDEO (usala come base dei contenuti, \xE8 ci\xF2 che viene detto):
${body.transcript}
` : ""}${body.note ? `NOTE/INDICAZIONI: ${body.note}
` : ""}
Genera testi pronti per queste piattaforme:
${platforms.map((p) => `- ${p}: ${rules[p] || p}`).join("\n")}

${variantInstr}

Rispondi SOLO con JSON valido in questo formato (niente testo fuori dal JSON):
{"posts":[{"platform":"instagram","variants":["testo prima variante"${variants > 1 ? ',"testo seconda variante"' : ""}]},{"platform":"youtube","title":"titolo","variants":["descrizione"]}]}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.anthropicModel,
      max_tokens: 4500,
      system: [
        { type: "text", text: "Sei un assistente SMM operativo. Scrivi in italiano, nel tono indicato. Rispondi solo con JSON valido." },
        { type: "text", text: styleBlock, cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = data.error?.message || data.error?.type || JSON.stringify(data);
    throw new Error(`Claude API ${res.status}: ${detail}`);
  }
  const raw = (data.content || []).filter((item) => item.type === "text").map((item) => item.text).join("");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Risposta AI non valida");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  for (const post of parsed.posts || []) {
    if (!Array.isArray(post.variants)) post.variants = post.text ? [post.text] : [];
    if (!post.text) post.text = post.variants[0] || "";
  }
  return parsed;
}
async function transcribeVideo(body, settings) {
  if (!settings.deepgramApiKey) throw new Error("Deepgram API key mancante: impostala nelle Impostazioni.");
  if (!body.mediaUrl) throw new Error("URL del video mancante per la trascrizione.");
  const res = await fetch("https://api.deepgram.com/v1/listen?smart_format=true&punctuate=true&detect_language=true", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Token ${settings.deepgramApiKey}`
    },
    body: JSON.stringify({ url: body.mediaUrl })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.err_msg || data.reason || data.message || `Deepgram ${res.status}`);
  const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  return { transcript: alt.transcript || "", language: data?.results?.channels?.[0]?.detected_language || "" };
}
function youtubeTitle(post) {
  const raw = post.title || (post.text || "").split("\n").find((l) => l.trim()) || post.videoName || "Video";
  return raw.replace(/^titolo[:\-\s]*/i, "").replace(/[<>]/g, "").trim().slice(0, 100) || "Video";
}
function buildTarget(platform, account, post) {
  const mediaUrl = post.mediaUrl;
  const target = { targetType: platform };
  if (platform === "facebook") {
    if (account.pageId) target.pageId = account.pageId;
    if (mediaUrl) target.mediaType = "reel";
  }
  if (platform === "instagram" && mediaUrl) target.mediaType = "reel";
  if (platform === "youtube") {
    target.title = youtubeTitle(post);
    target.privacyStatus = "public";
    target.shouldNotifySubscribers = false;
    if (account.playlistIds?.length) target.playlistIds = account.playlistIds;
  }
  return target;
}
async function publishPosts(body, settings) {
  const results = [];
  for (const post of body.posts || []) {
    try {
      const account = settings.accounts[post.platform];
      if (!account?.accountId) throw new Error(`Account ${post.platform} non collegato`);
      const payload = {
        post: {
          accountId: account.accountId,
          content: {
            text: post.text,
            mediaUrls: post.mediaUrl ? [post.mediaUrl] : [],
            platform: post.platform
          },
          target: buildTarget(post.platform, account, post)
        }
      };
      if (post.scheduledTime) payload.scheduledTime = post.scheduledTime;
      const data = await blotato("/posts", {
        method: "POST",
        body: JSON.stringify(payload)
      }, settings.blotatoApiKey);
      results.push({ ok: true, platform: post.platform, submissionId: data.postSubmissionId || data.id || "" });
    } catch (error) {
      results.push({ ok: false, platform: post.platform, error: String(error.message || error) });
    }
  }
  return results;
}
async function route(req, context) {
  const path = `/${(context.params.splat || "").replace(/^\/+/, "")}`;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type,x-app-password",
        "access-control-allow-methods": "GET,POST,PATCH,OPTIONS"
      }
    });
  }
  if (path === "/setup" && req.method === "POST") {
    const existing = await getSettings();
    if (existing.appPassword) {
      const provided = req.headers.get("x-app-password") || "";
      if (provided !== existing.appPassword) {
        return json({ error: "already_configured" }, 403);
      }
    }
    const body = await req.json();
    if (!body.appPassword || !body.blotatoApiKey || !body.anthropicApiKey) {
      return json({ error: "Servono password app, Blotato API key e Claude API key." }, 400);
    }
    await saveSettings({
      appPassword: body.appPassword,
      blotatoApiKey: body.blotatoApiKey,
      anthropicApiKey: body.anthropicApiKey,
      anthropicModel: body.anthropicModel || DEFAULT_MODEL,
      deepgramApiKey: body.deepgramApiKey || "",
      style: body.style || defaultStyle()
    });
    return json({ ok: true });
  }
  const auth = await requireAuth(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const settings = auth.settings;
  if (path === "/status" && req.method === "GET") {
    return json({
      configured: true,
      hasBlotato: !!settings.blotatoApiKey,
      hasClaude: !!settings.anthropicApiKey,
      hasDeepgram: !!settings.deepgramApiKey,
      anthropicModel: settings.anthropicModel,
      accounts: Object.fromEntries(Object.entries(settings.accounts || {}).map(([k, v]) => [k, {
        username: v.username,
        fullname: v.fullname,
        hasPage: !!v.pageId
      }])),
      style: settings.style,
      brandPrompt: settings.brandPrompt,
      styleExamples: settings.styleExamples
    });
  }
  if (path === "/settings" && req.method === "PATCH") {
    const body = await req.json();
    const next = await saveSettings({
      style: body.style ?? settings.style,
      accounts: body.accounts || settings.accounts,
      brandPrompt: body.brandPrompt ?? settings.brandPrompt,
      styleExamples: body.styleExamples ?? settings.styleExamples,
      deepgramApiKey: body.deepgramApiKey ?? settings.deepgramApiKey
    });
    return json({ ok: true, style: next.style, hasDeepgram: !!next.deepgramApiKey });
  }
  if (path === "/accounts" && req.method === "POST") {
    return json({ accounts: await listAccounts(settings) });
  }
  if (path === "/upload-url" && req.method === "POST") {
    const body = await req.json();
    const data = await blotato("/media/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: body.filename || `video-${Date.now()}.mp4` })
    }, settings.blotatoApiKey);
    return json(data);
  }
  if (path === "/generate" && req.method === "POST") {
    try {
      return json(await generateCopy(await req.json(), settings));
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  }
  if (path === "/transcribe" && req.method === "POST") {
    try {
      return json(await transcribeVideo(await req.json(), settings));
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  }
  if (path === "/publish" && req.method === "POST") {
    return json({ results: await publishPosts(await req.json(), settings) });
  }
  return json({ error: "not_found", path }, 404);
}
var api_default = route;
var config = {
  path: "/api/:splat"
};
export {
  config,
  api_default as default
};
