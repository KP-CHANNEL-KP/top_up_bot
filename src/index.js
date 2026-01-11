export default {
  async fetch(request, env) {
    try {
      if (request.method === "GET") return new Response("ok");
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("ok");
    } catch (e) {
      // Prevent Telegram webhook retries on errors
      return new Response("ok");
    }
  }
};

/* =========================
   Main Update Handler
========================= */
async function handleUpdate(update, env) {
  const msg = update.message;
  const cq = update.callback_query;

  if (cq) return onCallbackQuery(cq, env);
  if (msg) return onMessage(msg, env);
}

/* =========================
   Callback Queries (Buttons)
========================= */
async function onCallbackQuery(cq, env) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const data = cq.data || "";

  // Minimal callback answer (avoid Telegram "loading" stuck)
  await answerCallback(env, cq.id, "");

  if (data === "back:start") {
    await setState(env, userId, { step: "choose_game" });
    return editMessage(env, chatId, cq.message.message_id, "Game ရွေးပါ:", gameKeyboard());
  }

  if (data.startsWith("game:")) {
    const game = data.split(":")[1];
    await setState(env, userId, { step: "choose_package", game });
    const kb = await packagesKeyboard(env, game);
    return editMessage(env, chatId, cq.message.message_id, `${game} packages ရွေးပါ:`, kb);
  }

  if (data.startsWith("pkg:")) {
    const st = await getState(env, userId);
    if (!st?.game) return send(env, chatId, "အရင် /start လုပ်ပါ။");

    const packageId = Number(data.split(":")[1]);
    await setState(env, userId, { ...st, step: "enter_player", packageId });

    const hint = st.game === "MLBB"
      ? "MLBB PlayerID(ServerID) ဥပမာ 12345678(1234)"
      : "PUBG UID (ဂဏန်း)";

    return editMessage(env, chatId, cq.message.message_id, `${hint}\n\nPlayer info ကို ရိုက်ထည့်ပါ:`, null);
  }

  if (data.startsWith("pay:")) {
    const st = await getState(env, userId);
    if (!st?.game || !st?.packageId || !st?.playerId) return send(env, chatId, "Flow ပျက်နေပါတယ်။ /start ပြန်လုပ်ပါ။");

    const payMethod = data.split(":")[1];
    await setState(env, userId, { ...st, step: "upload_proof", payMethod });

    const txt =
      `Payment Method: ${payMethod}\n\n` +
      `${env.PAY_TEXT}\n\n` +
      `ပြီးရင် Screenshot (photo) ပို့ပါ 📸`;

    return editMessage(env, chatId, cq.message.message_id, txt, null);
  }
}

/* =========================
   Messages (Commands / Text / Photos)
========================= */
async function onMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || "";
  const text = (msg.text || "").trim();

  // ---- Admin Commands ----
  if (text === "/prices") return adminPrices(env, chatId, userId);
  if (text.startsWith("/setprice")) return adminSetPrice(env, chatId, userId, text);
  if (text.startsWith("/on ")) return adminToggle(env, chatId, userId, text, 1);
  if (text.startsWith("/off ")) return adminToggle(env, chatId, userId, text, 0);
  if (text.startsWith("/rename")) return adminRename(env, chatId, userId, text);
  if (text.startsWith("/addpkg")) return adminAddPkg(env, chatId, userId, text);
  if (text.startsWith("/pending")) return adminPending(env, chatId, userId);
  if (text.startsWith("/delivered")) return adminDelivered(env, chatId, userId, text);
  if (text.startsWith("/reject")) return adminReject(env, chatId, userId, text);

  // ---- User Commands ----
  if (text === "/start" || text === "/menu") {
    await setState(env, userId, { step: "choose_game" });
    return send(env, chatId, "မင်္ဂလာပါ 🙌\nGame ရွေးပါ:", gameKeyboard());
  }

  // ---- Photo proof upload ----
  const st = await getState(env, userId);

  if (st?.step === "upload_proof") {
    if (!msg.photo?.length) {
      return send(env, chatId, "Payment Screenshot ကို **photo** နဲ့ပဲ ပို့ပေးပါနော် 📸");
    }
    return createOrderFromProof(env, chatId, userId, username, msg);
  }

  // ---- Player input ----
  if (st?.step === "enter_player" && text) {
    const raw = text.trim();
    let playerId = raw;
    let serverId = null;

    if (st.game === "MLBB" && raw.includes("(") && raw.endsWith(")")) {
      playerId = raw.split("(")[0].trim();
      serverId = raw.split("(")[1].replace(")", "").trim();
    }

    // Basic validation
    if (playerId.length < 4) return send(env, chatId, "Player ID မမှန်ပါ။ ပြန်ရိုက်ပေးပါ။");

    await setState(env, userId, { ...st, step: "choose_pay", playerId, serverId });

    return send(env, chatId, "ငွေပေးချေမည့်နည်းလမ်းရွေးပါ:", payKeyboard());
  }

  // ---- Fallback ----
  return send(env, chatId, "မသိသေးဘူး 😅 /start လုပ်ပါ");
}

/* =========================
   Order Creation
========================= */
async function createOrderFromProof(env, chatId, userId, username, msg) {
  const st = await getState(env, userId);
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  const pkg = await env.DB.prepare(
    "SELECT id, game, name, price_mmks, is_active FROM packages WHERE id=?"
  ).bind(st.packageId).first();

  if (!pkg) return send(env, chatId, "Package မတွေ့ဘူး။ /start ပြန်လုပ်ပါ။");
  if (pkg.is_active !== 1) return send(env, chatId, "Package ပိတ်ထားပါတယ်။ /start ပြန်လုပ်ပြီး တခြား package ရွေးပါ။");

  const oid = "ORDER-" + crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO orders(
      id,user_id,username,game,package_id,player_id,server_id,pay_method,pay_proof_file_id,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    oid,
    userId,
    username,
    pkg.game,
    pkg.id,
    st.playerId,
    st.serverId,
    st.payMethod,
    fileId,
    "PAID",
    now,
    now
  ).run();

  await clearState(env, userId);

  await send(
    env,
    chatId,
    `✅ Order တင်ပြီးပါပြီ!\n` +
    `Order ID: ${oid}\n` +
    `Item: ${pkg.name} (${pkg.price_mmks} MMK)\n` +
    `Status: PAID → PROCESSING\n\n` +
    `မကြာခင် ဖြည့်ပေးပါမယ် 🙏`
  );

  // notify admins
  const admins = parseAdmins(env);
  for (const aid of admins) {
    await send(
      env,
      aid,
      `🆕 New Order\n` +
      `Order: ${oid}\n` +
      `User: @${username || "-"} (${userId})\n` +
      `Game: ${pkg.game}\n` +
      `Package: ${pkg.name} / ${pkg.price_mmks} MMK\n` +
      `Player: ${st.playerId}${st.serverId ? `(${st.serverId})` : ""}\n` +
      `Pay: ${st.payMethod}\n\n` +
      `/delivered ${oid}\n` +
      `/reject ${oid} reason`
    );
  }
}

/* =========================
   Admin: Prices / Edit Packages
========================= */
async function adminPrices(env, chatId, userId) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const rows = await env.DB.prepare(`
    SELECT id, game, name, amount, price_mmks, is_active
    FROM packages
    ORDER BY game, id
  `).all();

  if (!rows.results.length) return send(env, chatId, "No packages.");

  const out = rows.results.map(p =>
    `🆔 ${p.id} | ${p.game} | ${p.is_active ? "ON" : "OFF"}\n` +
    `📦 ${p.name} (${p.amount})\n` +
    `💰 ${p.price_mmks} MMK`
  ).join("\n\n");

  return send(
    env,
    chatId,
    "📋 PRICE LIST\n\n" +
    out +
    "\n\nCommands:\n" +
    "/setprice <id> <price>\n/on <id>\n/off <id>\n/rename <id> <new name>\n/addpkg MLBB \"86 Diamonds\" 86 4500"
  );
}

async function adminSetPrice(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");
  const parts = text.split(" ");
  if (parts.length < 3) return send(env, chatId, "Usage:\n/setprice <id> <price_mmks>");

  const id = Number(parts[1]);
  const price = Number(parts[2]);
  if (!Number.isFinite(id) || !Number.isFinite(price) || price <= 0) {
    return send(env, chatId, "Invalid id/price.");
  }

  const r = await env.DB.prepare("UPDATE packages SET price_mmks=? WHERE id=?")
    .bind(price, id).run();

  return send(env, chatId, r.success ? `✅ Updated: ${id} → ${price} MMK` : "Update failed.");
}

async function adminToggle(env, chatId, userId, text, active) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");
  const parts = text.split(" ");
  const id = Number(parts[1]);
  if (!Number.isFinite(id)) return send(env, chatId, active ? "Usage: /on <id>" : "Usage: /off <id>");

  await env.DB.prepare("UPDATE packages SET is_active=? WHERE id=?")
    .bind(active, id).run();

  return send(env, chatId, active ? `✅ Package ON: ${id}` : `🚫 Package OFF: ${id}`);
}

async function adminRename(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");
  const parts = text.split(" ");
  const id = Number(parts[1]);
  const newName = parts.slice(2).join(" ").trim();

  if (!Number.isFinite(id) || !newName) return send(env, chatId, "Usage:\n/rename <id> <new name>");

  await env.DB.prepare("UPDATE packages SET name=? WHERE id=?")
    .bind(newName, id).run();

  return send(env, chatId, `✅ Renamed: ${id} → ${newName}`);
}

async function adminAddPkg(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  // /addpkg MLBB "86 Diamonds" 86 4500
  const m = text.match(/^\/addpkg\s+(MLBB|PUBG)\s+"([^"]+)"\s+(\d+)\s+(\d+)$/i);
  if (!m) {
    return send(env, chatId, 'Usage:\n/addpkg MLBB "86 Diamonds" 86 4500');
  }

  const game = m[1].toUpperCase();
  const name = m[2];
  const amount = Number(m[3]);
  const price = Number(m[4]);

  await env.DB.prepare(
    "INSERT INTO packages(game,name,amount,price_mmks,is_active) VALUES (?,?,?,?,1)"
  ).bind(game, name, amount, price).run();

  return send(env, chatId, `✅ Added: ${game} | ${name} | ${amount} | ${price} MMK\nUse /prices to see ID.`);
}

/* =========================
   Admin: Orders
========================= */
async function adminPending(env, chatId, userId) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const rows = await env.DB.prepare(`
    SELECT id, game, status, created_at
    FROM orders
    WHERE status IN ('PAID','PROCESSING')
    ORDER BY created_at DESC
    LIMIT 30
  `).all();

  if (!rows.results.length) return send(env, chatId, "No pending orders.");

  const out = rows.results.map(r => `- ${r.id} | ${r.game} | ${r.status} | ${r.created_at}`).join("\n");
  return send(env, chatId, "Pending orders:\n" + out);
}

async function adminDelivered(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");
  const parts = text.split(" ");
  if (parts.length < 2) return send(env, chatId, "Usage: /delivered ORDER-...");

  const oid = parts[1].trim();
  const row = await env.DB.prepare("SELECT user_id FROM orders WHERE id=?").bind(oid).first();
  if (!row) return send(env, chatId, "Order not found.");

  await env.DB.prepare("UPDATE orders SET status='DELIVERED', updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), oid).run();

  await send(env, chatId, `✅ DELIVERED: ${oid}`);
  return send(env, row.user_id, `✅ Order ${oid} ကို ဖြည့်ပြီးပါပြီ။ ကျေးဇူးတင်ပါတယ် 🙏`);
}

async function adminReject(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");
  const parts = text.split(" ");
  if (parts.length < 2) return send(env, chatId, "Usage: /reject ORDER-... reason");

  const oid = parts[1].trim();
  const reason = parts.slice(2).join(" ").trim() || "Payment မရှင်းလင်းပါ";

  const row = await env.DB.prepare("SELECT user_id FROM orders WHERE id=?").bind(oid).first();
  if (!row) return send(env, chatId, "Order not found.");

  await env.DB.prepare("UPDATE orders SET status='REJECTED', updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), oid).run();

  await send(env, chatId, `❌ REJECTED: ${oid}`);
  return send(env, row.user_id, `❌ Order ${oid} ကို Reject လုပ်လိုက်ပါတယ်။ Reason: ${reason}`);
}

/* =========================
   Keyboards
========================= */
function gameKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "MLBB Diamonds", callback_data: "game:MLBB" }],
      [{ text: "PUBG UC", callback_data: "game:PUBG" }],
    ]
  };
}

async function packagesKeyboard(env, game) {
  const rows = await env.DB.prepare(`
    SELECT id, name, price_mmks
    FROM packages
    WHERE game=? AND is_active=1
    ORDER BY id
  `).bind(game).all();

  return {
    inline_keyboard: [
      ...rows.results.map(r => [{ text: `${r.name} — ${r.price_mmks} MMK`, callback_data: `pkg:${r.id}` }]),
      [{ text: "⬅️ Back", callback_data: "back:start" }]
    ]
  };
}

function payKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Wave Money", callback_data: "pay:WAVE" }, { text: "KBZPay", callback_data: "pay:KBZPAY" }],
      [{ text: "Bank Transfer", callback_data: "pay:BANK" }],
      [{ text: "⬅️ Back", callback_data: "back:start" }]
    ]
  };
}

/* =========================
   Telegram API Helpers
========================= */
async function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function send(env, chatId, text, replyMarkup = null) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup
  });
}

async function editMessage(env, chatId, messageId, text, replyMarkup = null) {
  return tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup
  });
}

async function answerCallback(env, callbackQueryId, text) {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || ""
  });
}

/* =========================
   KV State
========================= */
async function getState(env, userId) {
  const v = await env.KV.get(`st:${userId}`);
  return v ? JSON.parse(v) : null;
}

async function setState(env, userId, obj) {
  // 1 hour session
  await env.KV.put(`st:${userId}`, JSON.stringify(obj), { expirationTtl: 3600 });
}

async function clearState(env, userId) {
  await env.KV.delete(`st:${userId}`);
}

/* =========================
   Admin Helpers
========================= */
function parseAdmins(env) {
  return String(env.ADMIN_IDS || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(Boolean);
}

function isAdmin(env, userId) {
  return parseAdmins(env).includes(userId);
}

function nowISO() {
  return new Date().toISOString();
}

function fmtMMK(n) {
  return `${Number(n).toLocaleString("en-US")} MMK`;
}

async function replyResult(env, chatId, title, lines = []) {
  const body = lines.length ? ("\n" + lines.map(l => `• ${l}`).join("\n")) : "";
  return send(env, chatId, `✅ ${title}${body}\n\n🕒 ${nowISO()}`);
}

async function replyWarn(env, chatId, title, lines = []) {
  const body = lines.length ? ("\n" + lines.map(l => `• ${l}`).join("\n")) : "";
  return send(env, chatId, `⚠️ ${title}${body}\n\n🕒 ${nowISO()}`);
}

async function replyError(env, chatId, title, err) {
  // Err ကို user အတွက် friendly ဖြစ်အောင်
  const msg = (err && err.message) ? err.message : String(err || "Unknown error");
  return send(env, chatId, `❌ ${title}\n• ${msg}\n\n🕒 ${nowISO()}`);
}

/** Safe executor: အလုပ်တစ်ခုလုပ် → error တက်ရင် bot ကစာပြန် */
async function safeRun(env, chatId, fn, errorTitle = "Something went wrong") {
  try {
    return await fn();
  } catch (e) {
    return replyError(env, chatId, errorTitle, e);
  }
}

