export default {
  async fetch(request, env) {
    try {
      if (request.method === "GET") return new Response("ok");
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("ok");
    } catch (e) {
      return new Response("ok");
    }
  }
};

/* =========================
   MAIN HANDLER
========================= */
async function handleUpdate(update, env) {
  if (update.callback_query) {
    await answerCallback(env, update.callback_query.id, "");
    return onCallback(update.callback_query, env);
  }
  if (update.message) {
    return onMessage(update.message, env);
  }
}

/* =========================
   CALLBACKS (BUTTONS)
========================= */
async function onCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const data = cq.data;

  if (data === "back:start") {
    await setState(env, userId, { step: "choose_game" });
    return editMessage(env, chatId, cq.message.message_id, "Game ရွေးပါ:", gameKeyboard());
  }

  if (data.startsWith("game:")) {
    const game = data.split(":")[1];
    await setState(env, userId, { step: "choose_package", game });
    return editMessage(
      env,
      chatId,
      cq.message.message_id,
      `${game} packages ရွေးပါ:`,
      await packagesKeyboard(env, game)
    );
  }

  if (data.startsWith("pkg:")) {
    const st = await getState(env, userId);
    const packageId = Number(data.split(":")[1]);
    await setState(env, userId, { ...st, step: "enter_player", packageId });

    const hint = st.game === "MLBB"
      ? "MLBB PlayerID(ServerID) ဥပမာ 12345678(1234)"
      : "PUBG UID";

    return editMessage(
      env,
      chatId,
      cq.message.message_id,
      `${hint}\n\nPlayer info ကို ရိုက်ထည့်ပါ:`
    );
  }

  if (data.startsWith("pay:")) {
    const st = await getState(env, userId);
    const payMethod = data.split(":")[1];
    await setState(env, userId, { ...st, step: "upload_proof", payMethod });

    return editMessage(
      env,
      chatId,
      cq.message.message_id,
      `Payment: ${payMethod}\n\n${env.PAY_TEXT}\n\nScreenshot (photo) ပို့ပါ 📸`
    );
  }
}

/* =========================
   MESSAGES
========================= */
async function onMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || "";
  const text = (msg.text || "").trim();

  /* ===== ADMIN COMMANDS ===== */
  if (text === "/prices") return adminPrices(env, chatId, userId);
  if (text.startsWith("/setprice")) return adminSetPrice(env, chatId, userId, text);
  if (text.startsWith("/on ")) return adminToggle(env, chatId, userId, text, 1);
  if (text.startsWith("/off ")) return adminToggle(env, chatId, userId, text, 0);
  if (text.startsWith("/rename")) return adminRename(env, chatId, userId, text);
  if (text.startsWith("/addpkg")) return adminAddPkg(env, chatId, userId, text);
  if (text.startsWith("/pending")) return adminPending(env, chatId, userId);
  if (text.startsWith("/delivered")) return adminDelivered(env, chatId, userId, text);
  if (text.startsWith("/reject")) return adminReject(env, chatId, userId, text);

  /* ===== USER FLOW ===== */
  if (text === "/start" || text === "/menu") {
    await setState(env, userId, { step: "choose_game" });
    return send(env, chatId, "မင်္ဂလာပါ 🙌\nGame ရွေးပါ:", gameKeyboard());
  }

  const st = await getState(env, userId);

  if (st?.step === "enter_player") {
    let playerId = text;
    let serverId = null;

    if (st.game === "MLBB" && text.includes("(")) {
      playerId = text.split("(")[0];
      serverId = text.split("(")[1].replace(")", "");
    }

    await setState(env, userId, { ...st, step: "choose_pay", playerId, serverId });
    return send(env, chatId, "ငွေပေးချေမည့်နည်းလမ်းရွေးပါ:", payKeyboard());
  }

  if (st?.step === "upload_proof") {
    if (!msg.photo) {
      return send(env, chatId, "Screenshot ကို photo နဲ့ပဲ ပို့ပါ 📸");
    }
    return createOrder(env, chatId, userId, username, msg);
  }

  return send(env, chatId, "မသိသေးဘူး 😅 /start လုပ်ပါ");
}

/* =========================
   ORDER CREATE
========================= */
async function createOrder(env, chatId, userId, username, msg) {
  const st = await getState(env, userId);
  const fileId = msg.photo.at(-1).file_id;

  const pkg = await env.DB.prepare(
    "SELECT * FROM packages WHERE id=? AND is_active=1"
  ).bind(st.packageId).first();

  if (!pkg) return send(env, chatId, "Package မရှိပါ / ပိတ်ထားပါတယ်");

  const oid = "ORDER-" + crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO orders
    (id,user_id,username,game,package_id,player_id,server_id,pay_method,pay_proof_file_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    oid, userId, username, pkg.game, pkg.id,
    st.playerId, st.serverId, st.payMethod,
    fileId, "PAID", now, now
  ).run();

  await clearState(env, userId);

  await replyResult(env, chatId, "Order created", [
    `Order ID: ${oid}`,
    `Item: ${pkg.name}`,
    `Price: ${pkg.price_mmks} MMK`,
    `Status: PAID → PROCESSING`
  ]);

  for (const aid of parseAdmins(env)) {
    await send(env, aid, `🆕 New Order\n${oid}\n${pkg.name}\n/delivered ${oid}`);
  }
}

/* =========================
   ADMIN – PRICE MANAGEMENT
========================= */
async function adminPrices(env, chatId, userId) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const rows = await env.DB.prepare(
    "SELECT * FROM packages ORDER BY game,id"
  ).all();

  const out = rows.results.map(p =>
    `🆔 ${p.id} | ${p.game} | ${p.is_active ? "ON" : "OFF"}\n📦 ${p.name}\n💰 ${p.price_mmks} MMK`
  ).join("\n\n");

  return send(env, chatId, "📋 PRICE LIST\n\n" + out);
}

async function adminSetPrice(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  return safeRun(env, chatId, async () => {
    const [, id, price] = text.split(" ");
    const before = await env.DB.prepare(
      "SELECT price_mmks FROM packages WHERE id=?"
    ).bind(id).first();

    await env.DB.prepare(
      "UPDATE packages SET price_mmks=? WHERE id=?"
    ).bind(price, id).run();

    return replyResult(env, chatId, "Price updated", [
      `ID: ${id}`,
      `Before: ${before.price_mmks} MMK`,
      `After: ${price} MMK`
    ]);
  });
}

async function adminToggle(env, chatId, userId, text, active) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const id = text.split(" ")[1];
  await env.DB.prepare(
    "UPDATE packages SET is_active=? WHERE id=?"
  ).bind(active, id).run();

  return replyResult(env, chatId, "Package status changed", [
    `ID: ${id}`,
    `Status: ${active ? "ON" : "OFF"}`
  ]);
}

async function adminRename(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const id = text.split(" ")[1];
  const newName = text.split(" ").slice(2).join(" ");

  await env.DB.prepare(
    "UPDATE packages SET name=? WHERE id=?"
  ).bind(newName, id).run();

  return replyResult(env, chatId, "Package renamed", [
    `ID: ${id}`,
    `New name: ${newName}`
  ]);
}

async function adminAddPkg(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const m = text.match(/^\/addpkg\s+(MLBB|PUBG)\s+"([^"]+)"\s+(\d+)\s+(\d+)/i);
  if (!m) return replyWarn(env, chatId, "Usage", [' /addpkg MLBB "86 Diamonds" 86 4500 ']);

  await env.DB.prepare(
    "INSERT INTO packages(game,name,amount,price_mmks,is_active) VALUES (?,?,?,?,1)"
  ).bind(m[1], m[2], m[3], m[4]).run();

  return replyResult(env, chatId, "Package added", [
    `Game: ${m[1]}`,
    `Name: ${m[2]}`,
    `Price: ${m[4]} MMK`
  ]);
}

/* =========================
   ADMIN – ORDERS
========================= */
async function adminPending(env, chatId, userId) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const rows = await env.DB.prepare(
    "SELECT id,game,created_at FROM orders WHERE status='PAID'"
  ).all();

  return send(env, chatId,
    rows.results.map(r => `• ${r.id} | ${r.game}`).join("\n") || "No pending orders"
  );
}

async function adminDelivered(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const oid = text.split(" ")[1];
  await env.DB.prepare(
    "UPDATE orders SET status='DELIVERED', updated_at=? WHERE id=?"
  ).bind(new Date().toISOString(), oid).run();

  return replyResult(env, chatId, "Order delivered", [`Order: ${oid}`]);
}

async function adminReject(env, chatId, userId, text) {
  if (!isAdmin(env, userId)) return send(env, chatId, "Admin only ❌");

  const oid = text.split(" ")[1];
  await env.DB.prepare(
    "UPDATE orders SET status='REJECTED', updated_at=? WHERE id=?"
  ).bind(new Date().toISOString(), oid).run();

  return replyResult(env, chatId, "Order rejected", [`Order: ${oid}`]);
}

/* =========================
   HELPERS
========================= */
function gameKeyboard() {
  return { inline_keyboard: [[{ text: "MLBB", callback_data: "game:MLBB" }],[{ text: "PUBG", callback_data: "game:PUBG" }]] };
}
function payKeyboard() {
  return { inline_keyboard: [[{ text: "Wave", callback_data: "pay:WAVE" }],[{ text: "KBZPay", callback_data: "pay:KBZ" }]] };
}
async function packagesKeyboard(env, game) {
  const r = await env.DB.prepare(
    "SELECT id,name,price_mmks FROM packages WHERE game=? AND is_active=1"
  ).bind(game).all();

  return { inline_keyboard: r.results.map(p => [{ text: `${p.name} — ${p.price_mmks} MMK`, callback_data: `pkg:${p.id}` }]) };
}

/* =========================
   STATE + TELEGRAM
========================= */
async function getState(env, uid){ const v=await env.KV.get(`st:${uid}`); return v?JSON.parse(v):null;}
async function setState(env, uid, s){ await env.KV.put(`st:${uid}`,JSON.stringify(s),{expirationTtl:3600});}
async function clearState(env, uid){ await env.KV.delete(`st:${uid}`);}

async function tg(env, method, body){
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{
    method:"POST",headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
}
const send=(e,c,t,k)=>tg(e,"sendMessage",{chat_id:c,text:t,reply_markup:k});
const editMessage=(e,c,m,t,k)=>tg(e,"editMessageText",{chat_id:c,message_id:m,text:t,reply_markup:k});
const answerCallback=(e,id,t)=>tg(e,"answerCallbackQuery",{callback_query_id:id,text:t||""});

function parseAdmins(env){ return String(env.ADMIN_IDS).split(",").map(n=>Number(n.trim()));}
function isAdmin(env,id){ return parseAdmins(env).includes(id);}

/* ===== Reply Logic ===== */
const nowISO=()=>new Date().toISOString();
const replyResult=(e,c,t,l)=>send(e,c,`✅ ${t}\n${(l||[]).map(x=>"• "+x).join("\n")}\n🕒 ${nowISO()}`);
const replyWarn=(e,c,t,l)=>send(e,c,`⚠️ ${t}\n${(l||[]).join("\n")}`);
const safeRun=async(e,c,fn)=>{try{return await fn();}catch(err){return send(e,c,"❌ Error\n"+err.message);}};
