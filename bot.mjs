import { promises as fs } from "node:fs";
import path from "node:path";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";

// ===== .env loader (без зависимостей) =====
try {
  const env = await fs.readFile(".env", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* no .env — ok */ }

const TOKEN = process.env.TG_BOT_TOKEN;
const OWNER_ID = Number(process.env.TG_OWNER_ID);
const SUPPORT_HANDLE = process.env.SUPPORT_HANDLE || "Doxerfrilen";
if (!TOKEN || !OWNER_ID) {
  console.error("TG_BOT_TOKEN и TG_OWNER_ID обязательны");
  process.exit(1);
}

const FREE_DAILY_LIMIT = 1;
const PREMIUM_DAILY_LIMIT = 50;
const REFERRAL_BONUS = 1;

const PREMIUM_PACKS = [
  { id: "prem_7", days: 7, stars: 75, label: "👑 Премиум 7 дней" },
  { id: "prem_30", days: 30, stars: 250, label: "👑 Премиум 30 дней" },
  { id: "prem_90", days: 90, stars: 600, label: "👑 Премиум 90 дней" },
];
const PULL_PACKS = [
  { id: "pulls_5", pulls: 5, stars: 25, label: "🎯 +5 круток" },
  { id: "pulls_15", pulls: 15, stars: 60, label: "🎯 +15 круток" },
  { id: "pulls_50", pulls: 50, stars: 150, label: "🎯 +50 круток" },
];

// ====================== STORAGE ======================
const DATA_DIR = path.resolve(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");
let cache = null;
let writeQueue = Promise.resolve();

function nextResetTimestamp() {
  const r = new Date(); r.setUTCHours(24, 0, 0, 0); return r.getTime();
}
function defaultUser(id) {
  return {
    id, joinedAt: Date.now(), premiumUntil: 0, bonusPulls: 0,
    pullsUsed: 0, pullsResetAt: nextResetTimestamp(),
    referralsCount: 0, referralsActivated: 0, banned: false,
    totalCaught: 0, caught: [],
  };
}
async function loadData() {
  if (cache) return cache;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { cache = JSON.parse(await fs.readFile(DATA_FILE, "utf8")); }
  catch {
    cache = {
      users: {}, takenUsernames: [],
      stats: { totalChecks: 0, totalFound: 0, starsReceived: 0, starsSpent: 0, giftsSent: 0 },
      payments: [],
    };
    await persist();
  }
  cache.stats ??= { totalChecks: 0, totalFound: 0, starsReceived: 0, starsSpent: 0, giftsSent: 0 };
  cache.stats.starsReceived ??= 0; cache.stats.starsSpent ??= 0; cache.stats.giftsSent ??= 0;
  cache.takenUsernames ??= []; cache.payments ??= [];
  return cache;
}
async function persist() {
  if (!cache) return;
  const snap = JSON.stringify(cache, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(DATA_FILE, snap, "utf8")).catch(console.error);
  await writeQueue;
}
async function getOrCreateUser(id, info) {
  const data = await loadData();
  const k = String(id);
  let u = data.users[k];
  if (!u) { u = defaultUser(id); data.users[k] = u; }
  if (info?.username !== undefined) u.username = info.username;
  if (info?.firstName !== undefined) u.firstName = info.firstName;
  if (Date.now() >= u.pullsResetAt) { u.pullsUsed = 0; u.pullsResetAt = nextResetTimestamp(); }
  return u;
}
async function updateUser(u) { (await loadData()).users[String(u.id)] = u; await persist(); }
async function markUsernameTaken(name) {
  const d = await loadData();
  if (!d.takenUsernames.includes(name)) { d.takenUsernames.push(name); await persist(); }
}
async function isUsernameClaimedBefore(name) {
  return (await loadData()).takenUsernames.includes(name.toLowerCase());
}
async function bumpStats(field, by = 1) { (await loadData()).stats[field] += by; await persist(); }
async function recordPayment(p) {
  const d = await loadData();
  d.payments.push(p); d.stats.starsReceived += p.stars; await persist();
}
async function recordGiftSpend(stars) {
  const d = await loadData(); d.stats.starsSpent += stars; d.stats.giftsSent += 1; await persist();
}

// ====================== USERNAME GEN ======================
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const CONS = ["b","c","d","f","g","h","k","l","m","n","p","r","s","t","v","z"];
const VOW = ["a","e","i","o","u","y"];
const PRETTY = [
  "luna","nova","echo","atlas","orion","lyra","vela","kaiwa","mira","zora","kira",
  "remy","rune","vega","wren","indi","halo","noor","milo","river","sage","iris",
  "ember","onyx","pyre","tide","drift","loom","neva","polar","frost","haven",
  "calm","lume","glow","spark","neon","void","azure","coral","north","vivid",
  "moss","raven","willo","aspen","birch","cedar","olive","thorn","wisp","moon",
];
const PRETTY_SUFFIX = ["","x","io","ly","yo","el","is","ar","in","us","ax"];
const RESERVED_PREFIXES = ["admin","telegram","support","official","bot"];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

function generateCandidate(opts = {}) {
  const pattern = opts.pattern ?? "word";
  const minLen = opts.minLen ?? 5, maxLen = opts.maxLen ?? 8;
  const len = Math.max(minLen, Math.min(maxLen, minLen + Math.floor(Math.random() * (maxLen - minLen + 1))));
  let c = "";
  if (pattern === "word") {
    const base = rnd(PRETTY), suf = rnd(PRETTY_SUFFIX);
    c = (base + suf).slice(0, Math.max(minLen, base.length));
    while (c.length < minLen) c += rnd(VOW);
    if (c.length > maxLen) c = c.slice(0, maxLen);
  } else if (pattern === "lnumber") {
    const ll = Math.max(3, len - 2);
    for (let i = 0; i < ll; i++) c += rnd(ALPHABET);
    while (c.length < len) c += String(Math.floor(Math.random() * 10));
  } else {
    for (let i = 0; i < len; i++) c += i % 2 === 0 ? rnd(CONS) : rnd(VOW);
  }
  return c;
}
function isValidUsername(n) {
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(n)) return false;
  if (n.endsWith("_") || n.includes("__")) return false;
  return !RESERVED_PREFIXES.some((p) => n.startsWith(p));
}
async function checkUsername(bot, username) {
  await bumpStats("totalChecks");
  try { await bot.api.getChat("@" + username); return "taken"; }
  catch (err) {
    if (err instanceof GrammyError) {
      const d = (err.description || "").toLowerCase();
      if (d.includes("chat not found") || d.includes("username_not_occupied")) return "free";
      if (d.includes("username is invalid") || d.includes("username_invalid")) return "invalid";
      if (err.error_code === 429) return "rate_limited";
    }
    return "taken";
  }
}
async function findFreeUsername(bot, opts = {}) {
  const max = opts.maxAttempts ?? 25;
  for (let i = 1; i <= max; i++) {
    const cand = generateCandidate(opts);
    if (!isValidUsername(cand)) continue;
    if (await isUsernameClaimedBefore(cand)) continue;
    const r = await checkUsername(bot, cand);
    if (r === "free") {
      await markUsernameTaken(cand); await bumpStats("totalFound");
      return { username: cand, attempts: i };
    }
    if (r === "rate_limited") await new Promise((s) => setTimeout(s, 1500));
    await new Promise((s) => setTimeout(s, 250));
  }
  return null;
}

// ====================== HELPERS ======================
const isPremium = (u) => u.premiumUntil > Date.now();
const dailyLimit = (u) => isPremium(u) ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
const remainingPulls = (u) => Math.max(0, dailyLimit(u) - u.pullsUsed) + u.bonusPulls;
const isOwner = (id) => id === OWNER_ID;
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fmtDuration(ms) {
  if (ms <= 0) return "0с";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}ч ${m}м`;
  if (m) return `${m}м ${s}с`;
  return `${s}с`;
}
async function safeEdit(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb,
      link_preview_options: { is_disabled: true } });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb,
      link_preview_options: { is_disabled: true } });
  }
}

// ====================== KEYBOARDS / TEXTS ======================
const mainMenu = (admin) => {
  const kb = new InlineKeyboard()
    .text("🎯 Поймать юзернейм", "menu:pull").row()
    .text("👤 Профиль", "menu:profile").text("🛒 Магазин", "menu:shop").row()
    .text("👑 Премиум", "menu:premium").text("🤝 Рефералы", "menu:ref").row()
    .text("💬 Поддержка", "menu:support").text("ℹ️ Помощь", "menu:help");
  if (admin) kb.row().text("🛠 Админ-панель", "admin:panel");
  return kb;
};
const homeText = (n) => [
  `<b>👋 Привет, ${escapeHtml(n ?? "охотник")}!</b>`, "",
  "Я ищу <b>свободные Telegram-юзернеймы</b> и выдаю их по одному.", "",
  "🎯 Жмите кнопку, чтобы поймать ник.",
  `👑 Премиум — ${PREMIUM_DAILY_LIMIT} попыток в день.`,
  "🛒 В магазине можно купить премиум и крутки за ⭐ Telegram Stars.",
  "🤝 Зовите друзей — получайте бонусы.",
].join("\n");
function profileText(u, admin = false) {
  const p = isPremium(u);
  const lines = [
    "<b>👤 Профиль</b>",
    `ID: <code>${u.id}</code>`,
    u.username ? `Юзернейм: @${escapeHtml(u.username)}` : "",
    `Статус: ${p ? "👑 Премиум" : "🆓 Бесплатный"}`,
    p ? `Премиум до: <b>${new Date(u.premiumUntil).toISOString().slice(0, 10)}</b>` : "",
    "",
    `Лимит сегодня: <b>${dailyLimit(u) - u.pullsUsed}</b> / ${dailyLimit(u)}`,
    `Бонусных круток: <b>${u.bonusPulls}</b>`,
    `Сброс: через ${fmtDuration(u.pullsResetAt - Date.now())}`,
    "",
    `Поймано всего: <b>${u.totalCaught}</b>`,
    `Рефералов: <b>${u.referralsCount}</b> (активных ${u.referralsActivated})`,
  ].filter(Boolean);
  if (admin) lines.push("", `Бан: ${u.banned ? "🚫 да" : "—"}`);
  if (u.caught.length) {
    lines.push("", "Последние ники:");
    lines.push(u.caught.slice(-5).map((x) => `@${x}`).join(", "));
  }
  return lines.join("\n");
}
const shopText = () => [
  "<b>🛒 Магазин</b>", "",
  "Оплата проходит через ⭐ <b>Telegram Stars</b> — прямо внутри Telegram.", "",
  "<b>👑 Премиум</b>", ...PREMIUM_PACKS.map((p) => `• ${p.days} дн. — ${p.stars} ⭐`),
  "", "<b>🎯 Бонусные крутки</b>", ...PULL_PACKS.map((p) => `• ${p.pulls} шт. — ${p.stars} ⭐`),
].join("\n");
function shopKb() {
  const kb = new InlineKeyboard();
  for (const p of PREMIUM_PACKS) kb.text(`${p.days} дн · ${p.stars} ⭐`, `buy:${p.id}`);
  kb.row();
  for (const p of PULL_PACKS) kb.text(`+${p.pulls} · ${p.stars} ⭐`, `buy:${p.id}`);
  kb.row().text("⬅️ В меню", "menu:home");
  return kb;
}
const premiumText = (u) => [
  "<b>👑 Премиум</b>", "",
  `• ${PREMIUM_DAILY_LIMIT} попыток в сутки (вместо ${FREE_DAILY_LIMIT})`,
  "• Расширенные шаблоны генерации",
  "• Глубокий поиск (больше попыток за один клик)", "",
  isPremium(u) ? `✅ Активен до <b>${new Date(u.premiumUntil).toISOString().slice(0,10)}</b>` : "❌ Не активен",
  "", "Купите прямо в боте за ⭐:",
].join("\n");
function premiumKb() {
  const kb = new InlineKeyboard();
  for (const p of PREMIUM_PACKS) kb.text(`${p.days} дн · ${p.stars} ⭐`, `buy:${p.id}`).row();
  kb.text("⬅️ В меню", "menu:home");
  return kb;
}
const refText = (u, link) => [
  "<b>🤝 Реферальная программа</b>", "", "Ваша ссылка:", `<code>${link}</code>`, "",
  `Приглашено: <b>${u.referralsCount}</b>`,
  `Активных: <b>${u.referralsActivated}</b>`,
  `Бонусных круток: <b>${u.bonusPulls}</b>`, "",
  `За каждого активированного реферала +${REFERRAL_BONUS} бонусная крутка.`,
].join("\n");
const supportText = () => [
  "<b>💬 Поддержка</b>", "",
  `По всем вопросам, идеям и багам пишите: @${SUPPORT_HANDLE}`, "",
  "Также через поддержку можно:",
  "• Получить премиум вручную",
  "• Сообщить о пропавшем нике",
  "• Предложить новые шаблоны генерации",
].join("\n");
const helpText = () => [
  "<b>ℹ️ Как пользоваться</b>", "",
  "1. Нажмите «🎯 Поймать юзернейм» и выберите шаблон.",
  "2. Бот спросит у Telegram, свободен ли подобранный ник.",
  "3. Если свободен — копируйте и сразу занимайте: <b>Telegram → Настройки → Имя пользователя</b>", "",
  "<b>Лимиты</b>",
  `• Бесплатно: ${FREE_DAILY_LIMIT} попытка/сутки`,
  `• Премиум: ${PREMIUM_DAILY_LIMIT} попыток/сутки`,
  `• Рефералы: +${REFERRAL_BONUS} крутка за активного друга`,
  "• Магазин: премиум и крутки за ⭐ Telegram Stars",
].join("\n");

const adminKb = () => new InlineKeyboard()
  .text("📊 Статистика", "admin:stats").text("👥 Топ", "admin:users").row()
  .text("👑 Премиум-список", "admin:premium_list").text("💳 Платежи", "admin:payments").row()
  .text("🎯 Выдать крутки", "admin:give_pulls").text("👑 Выдать премиум", "admin:grant_premium").row()
  .text("➖ Снять премиум", "admin:revoke_premium").text("🔍 Карточка юзера", "admin:userinfo").row()
  .text("🚫 Бан", "admin:ban").text("✅ Разбан", "admin:unban").row()
  .text("📣 Рассылка", "admin:broadcast").text("🎁 Подарок мне", "admin:gift").row()
  .text("⬅️ В меню", "menu:home");
const cancelKb = () => new InlineKeyboard().text("❌ Отмена", "admin:cancel");

async function statsText() {
  const d = await loadData();
  const us = Object.values(d.users), now = Date.now();
  const prem = us.filter((u) => u.premiumUntil > now).length;
  const banned = us.filter((u) => u.banned).length;
  const total = us.reduce((s, u) => s + u.totalCaught, 0);
  const balance = d.stats.starsReceived - d.stats.starsSpent;
  return ["<b>📊 Статистика</b>", "",
    `Пользователей: <b>${us.length}</b>`, `Премиум: <b>${prem}</b>`, `Забанено: <b>${banned}</b>`, "",
    `Проверок ников: <b>${d.stats.totalChecks}</b>`,
    `Свободных найдено: <b>${d.stats.totalFound}</b>`,
    `Выдано пользователям: <b>${total}</b>`, "",
    `⭐ Получено: <b>${d.stats.starsReceived}</b>`,
    `🎁 Подарков владельцу: <b>${d.stats.giftsSent}</b> (${d.stats.starsSpent} ⭐)`,
    `💰 Баланс бота: <b>${balance}</b> ⭐`,
    `Платежей всего: <b>${d.payments.length}</b>`].join("\n");
}
async function topUsersText() {
  const d = await loadData();
  const top = Object.values(d.users).sort((a, b) => b.totalCaught - a.totalCaught).slice(0, 15);
  if (!top.length) return "Нет пользователей";
  return ["<b>👥 Топ охотников</b>", "", ...top.map((u, i) => {
    const tag = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.firstName ?? String(u.id));
    return `${i + 1}. ${tag} — ${u.totalCaught} (${isPremium(u) ? "👑" : "🆓"}) <code>${u.id}</code>`;
  })].join("\n");
}
async function premiumListText() {
  const d = await loadData(), now = Date.now();
  const list = Object.values(d.users).filter((u) => u.premiumUntil > now);
  if (!list.length) return "Нет активных премиум-пользователей";
  return ["<b>👑 Премиум-пользователи</b>", "", ...list.map((u) => {
    const tag = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.firstName ?? String(u.id));
    return `${tag} — до ${new Date(u.premiumUntil).toISOString().slice(0,10)} (<code>${u.id}</code>)`;
  })].join("\n");
}
async function paymentsText() {
  const d = await loadData();
  const last = d.payments.slice(-15).reverse();
  if (!last.length) return "Платежей пока нет";
  return ["<b>💳 Последние платежи</b>", "", ...last.map((p) => {
    const date = new Date(p.at).toISOString().slice(5, 16).replace("T", " ");
    return `${date} • <code>${p.userId}</code> • ${escapeHtml(p.payload)} • ${p.stars}⭐`;
  })].join("\n");
}

// ====================== BOT ======================
const bot = new Bot(TOKEN);
const pendingAdmin = new Map();

bot.catch(({ error }) => console.error("Bot error:", error));

bot.command("start", async (ctx) => {
  if (!ctx.from) return;
  const user = await getOrCreateUser(ctx.from.id, {
    username: ctx.from.username, firstName: ctx.from.first_name,
  });
  if (user.banned) { await ctx.reply("🚫 Вы заблокированы."); return; }

  const arg = ctx.match?.toString().trim();
  const fresh = !user.referrerId && user.totalCaught === 0;
  if (arg && arg.startsWith("ref_") && fresh) {
    const refId = Number(arg.slice(4));
    if (!Number.isNaN(refId) && refId !== ctx.from.id) {
      const ref = await getOrCreateUser(refId);
      user.referrerId = refId; ref.referralsCount += 1;
      await updateUser(ref);
      try {
        await ctx.api.sendMessage(refId,
          `🎉 Новый реферал: <b>${escapeHtml(ctx.from.first_name ?? "пользователь")}</b>\nКогда он словит первый ник — вы получите +${REFERRAL_BONUS} попытку.`,
          { parse_mode: "HTML" });
      } catch {}
    }
  }
  await updateUser(user);
  await ctx.reply(homeText(ctx.from.first_name), {
    parse_mode: "HTML", reply_markup: mainMenu(isOwner(ctx.from.id)),
  });
});

bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const action = ctx.match[1];
  const user = await getOrCreateUser(ctx.from.id, {
    username: ctx.from.username, firstName: ctx.from.first_name,
  });
  if (user.banned) return;
  const admin = isOwner(ctx.from.id);
  switch (action) {
    case "home": return safeEdit(ctx, homeText(ctx.from.first_name), mainMenu(admin));
    case "pull": return sendPullScreen(ctx, user);
    case "profile": return safeEdit(ctx, profileText(user), backTo(admin));
    case "shop": return safeEdit(ctx, shopText(), shopKb());
    case "premium": return safeEdit(ctx, premiumText(user), premiumKb());
    case "ref": {
      const me = await bot.api.getMe();
      const link = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;
      return safeEdit(ctx, refText(user, link), backTo(admin));
    }
    case "support": return safeEdit(ctx, supportText(), backTo(admin));
    case "help": return safeEdit(ctx, helpText(), backTo(admin));
  }
});

const backTo = (admin) => new InlineKeyboard()
  .text("⬅️ В меню", "menu:home")
  .text(admin ? "🛠 Админ" : "🎯 Поймать", admin ? "admin:panel" : "menu:pull");

bot.callbackQuery(/^pull:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const user = await getOrCreateUser(ctx.from.id);
  if (user.banned) return;
  await runPull(ctx, user, { pattern: ctx.match[1] });
});

bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const id = ctx.match[1];
  const prem = PREMIUM_PACKS.find((p) => p.id === id);
  const pull = PULL_PACKS.find((p) => p.id === id);
  if (!prem && !pull) return;
  const item = prem ?? pull;
  const description = prem
    ? `Премиум-доступ на ${prem.days} дней. ${PREMIUM_DAILY_LIMIT} попыток в сутки и расширенные шаблоны.`
    : `${pull.pulls} бонусных круток. Расходуются раньше дневного лимита и не сгорают.`;
  try {
    await ctx.api.sendInvoice(ctx.from.id, item.label, description, item.id, "XTR",
      [{ label: item.label, amount: item.stars }]);
  } catch (err) {
    console.error("sendInvoice failed", err);
    await ctx.reply("Не удалось создать счёт. Попробуйте позже.");
  }
});

bot.on("pre_checkout_query", async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); }
  catch (err) { console.error("pre_checkout error", err); }
});

bot.on("message:successful_payment", async (ctx) => {
  if (!ctx.from) return;
  const sp = ctx.message.successful_payment;
  const stars = sp.total_amount, payload = sp.invoice_payload;
  const user = await getOrCreateUser(ctx.from.id);
  const prem = PREMIUM_PACKS.find((p) => p.id === payload);
  const pull = PULL_PACKS.find((p) => p.id === payload);

  if (prem) {
    const base = isPremium(user) ? user.premiumUntil : Date.now();
    user.premiumUntil = base + prem.days * 86400000;
    await updateUser(user);
    await ctx.reply(`👑 Премиум активирован на ${prem.days} дней!\nЛимит: ${PREMIUM_DAILY_LIMIT} попыток в сутки.`,
      { reply_markup: mainMenu(isOwner(ctx.from.id)) });
  } else if (pull) {
    user.bonusPulls += pull.pulls;
    await updateUser(user);
    await ctx.reply(`🎯 +${pull.pulls} круток зачислено! Сейчас бонусных: ${user.bonusPulls}`,
      { reply_markup: mainMenu(isOwner(ctx.from.id)) });
  }

  await recordPayment({ userId: ctx.from.id, stars, payload, at: Date.now(),
    telegramChargeId: sp.telegram_payment_charge_id });

  try {
    await ctx.api.sendMessage(OWNER_ID,
      `💫 <b>Новый платёж</b>\nОт: <code>${ctx.from.id}</code> ${ctx.from.username ? "@" + escapeHtml(ctx.from.username) : ""}\nПакет: ${escapeHtml(payload)}\nЗвёзд: <b>${stars}</b>`,
      { parse_mode: "HTML" });
  } catch {}
  void tryGiftOwner();
});

// ===== Admin =====
bot.callbackQuery("admin:panel", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  pendingAdmin.delete(ctx.from.id);
  await safeEdit(ctx, "<b>🛠 Админ-панель</b>\n\nВыберите действие.", adminKb());
});

bot.callbackQuery(/^admin:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const action = ctx.match[1], adminId = ctx.from.id;
  switch (action) {
    case "stats": return safeEdit(ctx, await statsText(), adminKb());
    case "users": return safeEdit(ctx, await topUsersText(), adminKb());
    case "premium_list": return safeEdit(ctx, await premiumListText(), adminKb());
    case "payments": return safeEdit(ctx, await paymentsText(), adminKb());
    case "give_pulls":
      pendingAdmin.set(adminId, { kind: "give_pulls" });
      return safeEdit(ctx, "Отправьте сообщение в формате:\n<code>user_id количество</code>\n\nПример: <code>123456 10</code>", cancelKb());
    case "grant_premium":
      pendingAdmin.set(adminId, { kind: "grant_premium" });
      return safeEdit(ctx, "Отправьте сообщение в формате:\n<code>user_id дни</code>\n\nПример: <code>123456 30</code>", cancelKb());
    case "revoke_premium":
      pendingAdmin.set(adminId, { kind: "revoke_premium" });
      return safeEdit(ctx, "Отправьте <code>user_id</code> для снятия премиума.", cancelKb());
    case "ban":
      pendingAdmin.set(adminId, { kind: "ban" });
      return safeEdit(ctx, "Отправьте <code>user_id</code> для бана.", cancelKb());
    case "unban":
      pendingAdmin.set(adminId, { kind: "unban" });
      return safeEdit(ctx, "Отправьте <code>user_id</code> для разбана.", cancelKb());
    case "userinfo":
      pendingAdmin.set(adminId, { kind: "userinfo" });
      return safeEdit(ctx, "Отправьте <code>user_id</code>, чтобы увидеть карточку пользователя.", cancelKb());
    case "broadcast":
      pendingAdmin.set(adminId, { kind: "broadcast" });
      return safeEdit(ctx, "Отправьте текст для рассылки всем пользователям. HTML поддерживается.", cancelKb());
    case "cancel":
      pendingAdmin.delete(adminId);
      return safeEdit(ctx, "Действие отменено.", adminKb());
    case "gift": {
      await ctx.reply("Пробую отправить вам подарок на накопленные звёзды...");
      const r = await tryGiftOwner(true);
      return ctx.reply(r);
    }
  }
});

bot.on("message:text", async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const action = pendingAdmin.get(ctx.from.id);
  if (!action) return;
  const text = ctx.message.text.trim();
  pendingAdmin.delete(ctx.from.id);

  try {
    if (action.kind === "broadcast") {
      const d = await loadData();
      const ids = Object.keys(d.users);
      await ctx.reply(`📣 Рассылка для ${ids.length} пользователей...`);
      let ok = 0, fail = 0;
      for (const id of ids) {
        try { await ctx.api.sendMessage(Number(id), text, { parse_mode: "HTML" }); ok++; }
        catch { fail++; }
        await new Promise((r) => setTimeout(r, 35));
      }
      return ctx.reply(`✅ Отправлено: ${ok}\n❌ Ошибок: ${fail}`, { reply_markup: adminKb() });
    }

    const parts = text.split(/\s+/);
    const targetId = Number(parts[0]);
    if (!targetId || Number.isNaN(targetId)) return ctx.reply("Неверный user_id.", { reply_markup: adminKb() });
    const target = await getOrCreateUser(targetId);

    switch (action.kind) {
      case "give_pulls": {
        const n = Number(parts[1]);
        if (Number.isNaN(n)) return ctx.reply("Неверное число.", { reply_markup: adminKb() });
        target.bonusPulls += n; await updateUser(target);
        await ctx.reply(`✅ +${n} круток пользователю <code>${targetId}</code>. Всего бонусных: ${target.bonusPulls}`,
          { parse_mode: "HTML", reply_markup: adminKb() });
        try { await ctx.api.sendMessage(targetId, `🎁 Вам начислено ${n} бонусных круток!`); } catch {}
        return;
      }
      case "grant_premium": {
        const days = Number(parts[1] ?? "30");
        if (Number.isNaN(days)) return ctx.reply("Неверное число дней.", { reply_markup: adminKb() });
        const base = isPremium(target) ? target.premiumUntil : Date.now();
        target.premiumUntil = base + days * 86400000;
        await updateUser(target);
        await ctx.reply(`✅ Премиум для <code>${targetId}</code> до ${new Date(target.premiumUntil).toISOString().slice(0,10)}`,
          { parse_mode: "HTML", reply_markup: adminKb() });
        try { await ctx.api.sendMessage(targetId, `👑 Вам выдан премиум на ${days} дн.!`); } catch {}
        return;
      }
      case "revoke_premium":
        target.premiumUntil = 0; await updateUser(target);
        return ctx.reply(`✅ Премиум снят у <code>${targetId}</code>`,
          { parse_mode: "HTML", reply_markup: adminKb() });
      case "ban":
        target.banned = true; await updateUser(target);
        return ctx.reply(`🚫 Пользователь <code>${targetId}</code> забанен`,
          { parse_mode: "HTML", reply_markup: adminKb() });
      case "unban":
        target.banned = false; await updateUser(target);
        return ctx.reply(`✅ Пользователь <code>${targetId}</code> разбанен`,
          { parse_mode: "HTML", reply_markup: adminKb() });
      case "userinfo":
        return ctx.reply(profileText(target, true), { parse_mode: "HTML", reply_markup: adminKb() });
    }
  } catch (err) {
    console.error("admin action error", err);
    await ctx.reply("Ошибка выполнения. Попробуйте ещё раз.", { reply_markup: adminKb() });
  }
});

// ====================== PULL FLOW ======================
async function sendPullScreen(ctx, user) {
  const remaining = remainingPulls(user);
  const text = ["<b>🎯 Поймать юзернейм</b>", "",
    `Доступно сейчас: <b>${remaining}</b>`,
    `(дневной остаток ${dailyLimit(user) - user.pullsUsed} + бонус ${user.bonusPulls})`,
    "", "Выберите стиль ника:"].join("\n");
  const kb = new InlineKeyboard()
    .text("📝 Слово", "pull:word").text("🔤 Произносимый", "pull:random").row()
    .text("🔢 Буквы+цифры", "pull:lnumber").text("⚡ Короткий", "pull:short").row()
    .text("🛒 Купить ещё", "menu:shop").text("⬅️ В меню", "menu:home");
  await safeEdit(ctx, text, kb);
}

async function runPull(ctx, user, opts) {
  if (!ctx.from) return;
  const admin = isOwner(ctx.from.id);
  if (remainingPulls(user) <= 0) {
    await ctx.reply(["❌ Лимит на сегодня исчерпан.",
      `Сброс через: <b>${fmtDuration(user.pullsResetAt - Date.now())}</b>`, "",
      `👑 Премиум даёт ${PREMIUM_DAILY_LIMIT} попыток в день.`].join("\n"),
      { parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🛒 Купить", "menu:shop").text("👑 Премиум", "menu:premium").row()
          .text("⬅️ В меню", "menu:home") });
    return;
  }
  await ctx.reply("🔍 Ищу свободный юзернейм...");
  const premium = isPremium(user);
  const result = await findFreeUsername(bot, {
    pattern: opts.pattern ?? "word",
    minLen: premium ? 5 : 6, maxLen: premium ? 10 : 9,
    maxAttempts: premium ? 40 : 20,
  });
  if (!result) {
    await ctx.reply("😔 За эту попытку свободного ника не нашлось. Попробуйте другой стиль:", {
      reply_markup: new InlineKeyboard()
        .text("📝 Слово", "pull:word").text("🔤 Произносимый", "pull:random").row()
        .text("🔢 Буквы+цифры", "pull:lnumber").text("⚡ Короткий", "pull:short").row()
        .text("⬅️ В меню", "menu:home"),
    });
    return;
  }
  if (user.bonusPulls > 0) user.bonusPulls -= 1;
  else user.pullsUsed += 1;
  user.totalCaught += 1;
  user.caught.push(result.username);
  if (user.caught.length > 50) user.caught = user.caught.slice(-50);

  if (user.referrerId && user.totalCaught === 1) {
    const ref = await getOrCreateUser(user.referrerId);
    ref.referralsActivated += 1; ref.bonusPulls += REFERRAL_BONUS;
    await updateUser(ref);
    try { await ctx.api.sendMessage(user.referrerId,
      `✨ Ваш реферал активировался! +${REFERRAL_BONUS} крутка зачислена.`); } catch {}
  }
  await updateUser(user);
  const remaining = remainingPulls(user);
  await ctx.reply(["🎉 <b>Свободный юзернейм найден!</b>", "",
    `<code>@${result.username}</code>`, "",
    `Длина: ${result.username.length} • попыток: ${result.attempts}`, "",
    "Скорее занимайте: <b>Telegram → Настройки → Имя пользователя</b>", "",
    `Осталось попыток: <b>${remaining}</b>`].join("\n"), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("🎯 Ещё", "menu:pull").text("👤 Профиль", "menu:profile").row()
      .text("🛒 Магазин", "menu:shop").text(admin ? "🛠 Админ" : "⬅️ В меню", admin ? "admin:panel" : "menu:home"),
  });
}

// ====================== GIFTS ======================
async function tryGiftOwner(returnDetails = false) {
  try {
    const d = await loadData();
    const balance = d.stats.starsReceived - d.stats.starsSpent;
    if (balance <= 0) return "Баланс звёзд = 0, дарить пока нечего.";
    const gifts = await bot.api.raw.getAvailableGifts();
    if (!gifts?.gifts?.length) return "Доступных подарков от Telegram сейчас нет.";
    const eligible = gifts.gifts
      .filter((g) => g.star_count > 0 && g.star_count <= balance)
      .sort((a, b) => b.star_count - a.star_count);
    if (!eligible.length) {
      return `Баланс ${balance}⭐ — ни один доступный подарок не подходит (минимум ${
        Math.min(...gifts.gifts.map((g) => g.star_count))}⭐).`;
    }
    const gift = eligible[0];
    try {
      await bot.api.raw.sendGift({
        user_id: OWNER_ID, gift_id: gift.id,
        text: "🎁 Подарок от вашего бота — спасибо за поддержку!",
      });
      await recordGiftSpend(gift.star_count);
      const msg = `🎁 Подарено владельцу: ${gift.star_count}⭐`;
      try { await bot.api.sendMessage(OWNER_ID, msg + ` (gift_id: <code>${gift.id}</code>)`,
        { parse_mode: "HTML" }); } catch {}
      return msg;
    } catch (err) {
      const reason = err instanceof GrammyError ? err.description : String(err);
      console.warn("sendGift failed", err);
      return returnDetails ? `Не удалось отправить подарок: ${reason}` : "";
    }
  } catch (err) {
    console.error("tryGiftOwner error", err);
    return returnDetails ? "Ошибка при попытке подарка." : "";
  }
}

// ====================== START ======================
bot.start({
  drop_pending_updates: true,
  onStart: (info) => console.log("Bot started:", "@" + info.username),
  allowed_updates: ["message", "callback_query", "pre_checkout_query"],
}).catch((err) => console.error("Bot crashed", err));

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());