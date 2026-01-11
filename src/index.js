export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("ok");
    }

    const update = await request.json();
    await handleUpdate(update, env);
    return new Response("ok");
  }
};

async function handleUpdate(update, env) {
  const msg = update.message;
  const cq = update.callback_query;

  if (cq) {
    const chatId = cq.message.chat.id;
    const data = cq.data;

    if (data.startsWith("game:")) {
      const game = data.split(":")[1];
      await setState(env, cq.from.id, { step: "choose_package", game });
      return editMessage(env, chatId, cq.message.message_id, `${game} packages ရွေးပါ:`, await packagesKeyboard(env, game));
    }

    if (data.startsWith("pkg:")) {
      const packageId = Number(data.split(":")[1]);
      const st = await getState(env, cq.from.id);
      if (!st?.game) return answerCallback(env, cq.id, "အရင် /start လုပ်ပါ");
      await setState(env, cq.from.id, { step: "enter_player", game: st.game, packageId });
      const hint = st.game === "MLBB" ? "PlayerID(ServerID) ဥပမာ 12345678(1234)" : "PUBG UID (ဂဏန်း)";
      return editMessage(env, chatId, cq.message.message_id, `${hint}\n\nPlayer info ကို ရိုက်ထည့်ပါ:`, null);
    }

    if (data.startsWith("pay:")) {
      const pay = data.split(":")[1];
      const st = await getState(env, cq.from.id);
      await setState(env, cq.from.id, { ...st, step: "upload_proof", payMethod: pay });
      return editMessage(
        env,
        chatId,
        cq.message.message_id,
        `Payment Method: ${pay}\n\n${env.PAY_TEXT}\n\nပြီးရင် screenshot (photo) ပို့ပါ 📸`,
        null
      );
    }

    return answerCallback(env, cq.id, "ok");
  }

  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";
  const username = msg.from.username || "";

  // Admin commands
  if (text.startsWith("/pending")) {
    if (!isAdmin(env, userId)) return send(env, chatId, "Admin only.");
    const rows = await env.DB.prepare(
      "SELECT id, game, status, created_at FROM orders WHERE status IN ('PAID','PROCESSING') ORDER BY created_at DESC LIMIT 20"
    ).all();
    if (!rows.results.length) return send(env, chatId, "No pending orders.");
    const lines = rows.results.map(r => `- ${r.id} | ${r.game} | ${r.status} | ${r.created_at}`);
    return send(env, chatId, "Pending:\n" + lines.join("\n"));
  }

  if (text.startsWith("/delivered")) {
    if (!isAdmin(env, userId)) return send(env, chatId, "Admin only.");
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

  if (text.startsWith("/reject")) {
    if (!isAdmin(env, userId)) return send(env, chatId, "Admin only.");
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

  // Start
  if (text.startsWith("/start")) {
    await setState(env, userId, { step: "choose_game" });
    return send(env, chatId, "မင်္ဂလာပါ 🙌\nGame ရွေးပါ:", gameKeyboard());
  }

  // State machine
  const st = await getState(env, userId);

  if (st?.step === "enter_player" && text) {
    const raw = text.trim();
    let playerId = raw, serverId = null;
    if (st.game === "MLBB" && raw.includes("(") && raw.endsWith(")")) {
      playerId = raw.split("(")[0].trim();
      serverId = raw.split("(")[1].replace(")", "").trim();
    }
    await setState(env, userId, { ...st, step: "choose_pay", playerId, serverId });
    return send(env, chatId, "ငွေပေးချေမည့်နည်းလမ်းရွေးပါ:", payKeyboard());
  }

  // proof upload (photo)
  if (st?.step === "upload_proof" && msg.photo?.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    const pkg = await env.DB.prepare("SELECT name, price_mmks FROM packages WHERE id=?")
      .bind(st.packageId).first();
    if (!pkg) return send(env, chatId, "Package မတွေ့ဘူး။ /start ပြန်လုပ်ပါ။");

    const oid = "ORDER-" + crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO orders(id,user_id,username,game,package_id,player_id,server_id,pay_method,pay_proof_file_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      oid, userId, username, st.game, st.packageId, st.playerId, st.serverId, st.payMethod, fileId,
      "PAID", now, now
    ).run();

    await send(env, chatId,
      `✅ Order တင်ပြီးပါပြီ!\nOrder ID: ${oid}\nItem: ${pkg.name} (${pkg.price_mmks} MMK)\nStatus: PAID → PROCESSING\n\nမကြာခင် ဖြည့်ပေးပါမယ် 🙏`
    );

    // notify admins
    const adminIds = parseAdmins(env);
    for (const aid of adminIds) {
      await send(env, aid,
        `🆕 New Order\nOrder: ${oid}\nUser: @${username} (${userId})\nGame: ${st.game}\nPackage: ${pkg.name} / ${pkg.price_mmks} MMK\nPlayer: ${st.playerId}${st.serverId ? `(${st.serverId})` : ""}\nPay: ${st.payMethod}\n\n/delivered ${oid}\n/reject ${oid} reason`
      );
    }

    await clearState(env, userId);
    return;
  }

  if (st?.step === "upload_proof") {
    return send(env, chatId, "Screenshot (photo) ပဲ ပို့ပေးပါနော် 📸");
  }

  // fallback
  return send(env, chatId, "မသိသေးဘူး 😅 /start လုပ်ပါ");
}

// -------- keyboards --------
function gameKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "MLBB Diamonds", callback_data: "game:MLBB" }],
      [{ text: "PUBG UC", callback_data: "game:PUBG" }],
    ]
  };
}

async function packagesKeyboard(env, game) {
  const rows = await env.DB.prepare("SELECT id, name, price_mmks FROM packages WHERE game=? AND is_active=1")
    .bind(game).all();
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
    ]
  };
}

// -------- telegram helpers --------
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
  return tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

async function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// -------- state via KV --------
async function getState(env, userId) {
  const v = await env.KV.get(`st:${userId}`);
  return v ? JSON.parse(v) : null;
}
async function setState(env, userId, obj) {
  await env.KV.put(`st:${userId}`, JSON.stringify(obj), { expirationTtl: 3600 });
}
async function clearState(env, userId) {
  await env.KV.delete(`st:${userId}`);
}

// -------- admin helpers --------
function parseAdmins(env) {
  return String(env.ADMIN_IDS || "")
    .split(",").map(s => Number(s.trim())).filter(Boolean);
}
function isAdmin(env, userId) {
  return parseAdmins(env).includes(userId);
}
