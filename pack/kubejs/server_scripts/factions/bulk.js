// priority: -5
"use strict";
/**
 * ОПТОВЫЕ ПОСТАВКИ.
 *
 * У любого торговца (гость, походный лагерь, поселение NPC) в разговоре есть «Оптовый заказ»:
 * сырьё большими партиями дешевле розницы. Заказ оплачивается при получении и приезжает
 * через 1-10 дней - чем больше, тем дольше. Привозит тот же человек (та же личность,
 * то же имя) к базе игрока, как обычный гость. В разговоре с ним «Забрать поставку»:
 * деньги - и он отдаёт накладные. Накладная - бумага: приложить к ящику, сундуку, сосуду -
 * и товар сам раскладывается по свободным ячейкам, пока не кончится; пустая накладная
 * становится простой бумагой.
 * Не забрал (отказался или не дождался торговец) - отношения с фракцией падают.
 *
 * Одиночки (охотник, лесоруб, шахтёр, камнелом) берут заказы скромнее, зато дешевле.
 * Окно заказа - режим "order" окна бартера мода tfgui; без мода - выбор в чате.
 */

var BK_SERVER = null
var BK_ORDERS = null                 // [{...}] - все заказы мира
const BK_SESS = {}                   // uuid игрока -> открытый каталог

const BK_DAY = 24000
const BK_MIN_DAYS = 1
const BK_MAX_DAYS = 10
const BK_MAX_UNITS = 4096            // предел одной позиции у торговца
const BK_SOLO_MAX_UNITS = 512        // у одиночки
const BK_PER_DAY = 600               // сколько штук торговец собирает за день
const BK_SOLO_PER_DAY = 64
const BK_DISCOUNT = 0.8              // опт дешевле розницы
const BK_SOLO_DISCOUNT = 0.6         // одиночка - ещё дешевле
const BK_REFUSE_REP = -10            // отказ или не дождался
const BK_TRIES = 6                   // сколько раз пытаемся выслать поставку, пока не сдадимся

// Сверх обычного ассортимента: сырьё, которое у торговца в рознице не лежит
const BK_EXTRA = {
    chemist: ["gtceu:sticky_resin", "gtceu:raw_rubber_dust", "gtceu:rubber_dust", "gtceu:rubber_plate",
        "gtceu:sulfur_dust", "gtceu:saltpeter_dust", "gtceu:coal_dust", "gtceu:charcoal_dust"],
}
// одиночки: своё ремесло целиком
const BK_SOLO_RE = /wood\/log\/|wood\/lumber|lumber|hide|leather|bone|feather|food\/|rock\/|^tfc:ore\/|gem|raw_|crushed/

const BK_TAKEN = ["Вот накладные. Приложишь к ящику - всё само и уляжется.", "Держи бумаги. Товар по ним - твой.",
    "Расчёт верный. Накладные - вот, по ящикам разложишь сам.", "Приятно иметь дело. Бумаги держи."]
const BK_POOR = ["Денег-то не хватает. Я подожду, но недолго.", "Маловато. Соберёшь - зови, я тут ещё побуду.",
    "Без расчёта товар не отдам. Подожду немного."]
const BK_REFUSED = ["Я это через полмира тащил! Запомним.", "Вот, значит, как. Больше с тобой дел не веду... пока.",
    "Ну и ладно. Только слух о тебе пойдёт недобрый.", "Тьфу. Зря вёз. Запомню."]
const BK_ACCEPTED = ["Добро. Соберу и привезу дня через #. Расчёт на месте.", "Запомнил. Жди через # дн., заплатишь при получении.",
    "Сделаем. Дней # - и товар у тебя.", "По рукам. Через # дн. привезу, деньги тогда же."]
const BK_ARRIVED = ["Я привёз то, что ты заказывал.", "Принимай поставку. Всё по уговору.",
    "Вот и я. Товар при мне - рассчитаемся?", "Заказ твой привёз. Считай."]

function bkLog(t) { try { console.log("[опт] " + t) } catch (e) { } }
function bkErr(w, e) { try { console.error("[опт] " + w + ": " + e) } catch (err) { } }
function bkPick(list) { return list[Math.floor(Math.random() * list.length)] }

function bkOrders() {
    if (BK_ORDERS) return BK_ORDERS
    BK_ORDERS = []
    try {
        var pd = BK_SERVER.persistentData
        if (pd.contains("tfg_bulk_orders")) BK_ORDERS = JSON.parse(String(pd.getString("tfg_bulk_orders"))) || []
    } catch (e) { bkErr("чтение заказов", e) }
    return BK_ORDERS
}
function bkSave() {
    // законченные храним сутки - для разговора, дальше выкидываем
    BK_ORDERS = bkOrders().filter(o => o.phase !== "done" || (o.doneAt || 0) > bkNow() - BK_DAY)
    BK_SERVER.persistentData.putString("tfg_bulk_orders", JSON.stringify(BK_ORDERS))
}
function bkNow() { try { return Number(BK_SERVER.overworld().getTime()) } catch (e) { return 0 } }
function bkById(id) { return bkOrders().filter(o => o.id === id)[0] || null }

/** Активный заказ игрока у этой фракции и этого ремесла: двух сразу не берут. */
function bkActive(player, faction, kind) {
    var u = String(player.uuid)
    return bkOrders().filter(o => o.player === u && o.faction === faction && o.kind === kind && o.phase !== "done")[0] || null
}

// ─── Каталог ─────────────────────────────────────────────────────────────────

function bkIsSolo(ctx) { try { return dlgSoloTrader(ctx) } catch (e) { return false } }

function bkStackOf(o, n) {
    if (o.gun || o.ammo) return global.TFG_GUN_ITEMS.offerStack(o, n)
    try { return Item.of(o.item, n) } catch (e) { return null }
}

/** Позиции опта: { item, count(лот), lotPrice(цена лота в рознице без поправок) } */
function bkCatalog(ctx) {
    var out = [], seen = {}
    var solo = bkIsSolo(ctx)
    var offers = []
    try { offers = JSON.parse(String(ctx.trader.persistentData.getString("tfg_trader_offers"))) } catch (e) { }
    offers.forEach(o => {
        if (!o || o.gun) return
        var id = String(o.item)
        var ok = global.TFG_TRADE_GOODS.bulk(o) || (solo && BK_SOLO_RE.test(id))
        if (!ok || seen[id + "|" + (o.ammo || "")]) return
        seen[id + "|" + (o.ammo || "")] = true
        out.push({ item: id, ammo: o.ammo || undefined, count: Math.max(1, o.count), lotPrice: o.price })
    })
    ;(BK_EXTRA[ctx.kind] || []).forEach(id => {
        if (seen[id + "|"]) return
        var st = null
        try { st = Item.of(id) } catch (e) { }
        if (!st || st.isEmpty()) return
        var value = 0
        try { value = Number(global.TFG_MARKET.appraise(st).value) || 0 } catch (e) { }
        if (!(value > 0)) return
        seen[id + "|"] = true
        out.push({ item: id, count: 16, lotPrice: Math.max(1, Math.round(value * 16 * 1.15)) })
    })
    return out
}

/** Сколько стоит штука в опте: от розницы, со скидкой опта и с поправкой на отношения. */
function bkUnitPrice(ctx, c) {
    var f = 1
    try { f = tmBuyFactor({ player: ctx.player, faction: ctx.faction }) } catch (e) { }
    return c.lotPrice / c.count * f * (bkIsSolo(ctx) ? BK_SOLO_DISCOUNT : BK_DISCOUNT)
}

function bkDays(units, solo) {
    var per = solo ? BK_SOLO_PER_DAY : BK_PER_DAY
    return Math.max(BK_MIN_DAYS, Math.min(BK_MAX_DAYS, 1 + Math.floor(units / per)))
}

// ─── Открытие ────────────────────────────────────────────────────────────────

function bkOpen(ctx) {
    var cat = bkCatalog(ctx)
    var solo = bkIsSolo(ctx)
    var max = solo ? BK_SOLO_MAX_UNITS : BK_MAX_UNITS
    var s = { ctx: ctx, cat: cat, solo: solo, max: max }
    BK_SESS[String(ctx.player.uuid)] = s
    if (!cat.length) { dlgSay(ctx, "Оптом мне продать нечего."); return }
    if (global.TFG_UI && global.TFG_UI.has(ctx.player)) {
        dlgClose(ctx.player)
        var offers = []
        cat.forEach((c, i) => {
            var st = bkStackOf(c, 1)
            if (!st || st.isEmpty()) return
            var o = { item: c.item, ammo: c.ammo }
            offers.push({
                i: i, stack: global.TFG_UI.stackNbt(st), units: max, lot: c.count,
                price: bkUnitPrice(ctx, c) * c.count,
                cat: typeof tuCategory === "function" ? tuCategory(o) : "other", q: c.item + (c.ammo ? " " + c.ammo : ""),
            })
        })
        var title = "Оптовый заказ"
        try { title = String(global.TFG_TRADER_RULES.title(ctx.trader)) + " · опт" } catch (e) { }
        global.TFG_UI.open(ctx.player, {
            type: "order", mode: "order", title: title,
            color: typeof tuColor === "function" ? tuColor({ faction: ctx.faction }) : 0,
            currency: String(global.TFG_COINS.unit), money: Number(global.TFG_COINS.verifiedTotal(ctx.player)) || 0,
            cats: typeof TU_CATS !== "undefined" ? TU_CATS : [], offers: offers,
            perDay: solo ? BK_SOLO_PER_DAY : BK_PER_DAY, minDays: BK_MIN_DAYS, maxDays: BK_MAX_DAYS,
            note: "Оплата при получении. Не заберёте - отношения с фракцией " + BK_REFUSE_REP + ".",
        })
        return
    }
    bkChatPick(ctx, s, 0)
}

/** Без мода: позиции по 8 на страницу, потом количество. */
function bkChatPick(ctx, s, page) {
    var per = 8
    var items = s.cat.slice(page * per, page * per + per).map((c, k) => {
        var i = page * per + k
        var name = c.item
        try { name = String(bkStackOf(c, 1).getHoverName().getString()) } catch (e) { }
        return { label: name + " - " + bkFmt(bkUnitPrice(ctx, c)) + " за шт.", run: cx => bkChatAmount(cx, s, i, name) }
    })
    if ((page + 1) * per < s.cat.length) items.push({ label: "Дальше...", run: cx => bkChatPick(cx, s, page + 1) })
    dlgChoice(ctx, "Что везти?", items)
}

function bkChatAmount(ctx, s, i, name) {
    var c = s.cat[i]
    var amounts = [64, 256, 1024, 4096].filter(n => n <= s.max)
    dlgChoice(ctx, "Сколько?", amounts.map(n => ({
        label: n + " шт. - " + Math.ceil(bkUnitPrice(ctx, c) * n) + " " + global.TFG_COINS.unit + ", " + bkDays(n, s.solo) + " дн.",
        run: cx => {
            var res = bkPlace(cx.player, s, [[i, n]])
            dlgSay(cx, res.line)
            dlgClose(cx.player)
        },
    })))
}

function bkFmt(x) { return x >= 10 ? String(Math.round(x)) : String(Math.round(x * 100) / 100) }

// ─── Заказ ───────────────────────────────────────────────────────────────────

/** buy: [[номер позиции, штук]]. Возвращает { ok, line, days }. */
function bkPlace(player, s, buy) {
    var ctx = s.ctx
    if (bkActive(player, ctx.faction, ctx.kind)) return { ok: false, line: "У нас с тобой уже есть уговор. Сперва его закроем." }
    var lines = [], units = 0, total = 0
    ;(buy || []).forEach(pair => {
        var i = Number(pair[0]), n = Math.floor(Number(pair[1]))
        if (!(i >= 0 && i < s.cat.length) || !(n > 0)) return
        n = Math.min(n, s.max)
        var c = s.cat[i]
        var price = Math.ceil(bkUnitPrice(ctx, c) * n)
        lines.push({ item: c.item, ammo: c.ammo, n: n, price: price })
        units += n
        total += price
    })
    if (!lines.length) return { ok: false, line: "Так что везти-то?" }
    var days = bkDays(units, s.solo)
    var now = bkNow()
    var person = ctx.person
    var name = person && person.name ? String(person.name) : ""
    var base = { x: 0, y: 64, z: 0 }
    try { base = svcBase(player) } catch (e) { base = { x: Math.floor(player.getX()), y: Math.floor(player.getY()), z: Math.floor(player.getZ()) } }
    var kindName = ""
    try { kindName = global.TFG_TRADE_GOODS.kind(ctx.kind).name } catch (e) { }
    var o = {
        id: "b" + now + "_" + Math.floor(Math.random() * 1000), player: String(player.uuid), pname: String(player.username),
        faction: ctx.faction, kind: ctx.kind, kindName: kindName, tier: ctx.tier || 1, person: person ? String(person.id) : null,
        name: name, solo: !!s.solo, lines: lines, units: units, total: total, days: days,
        placed: now, due: now + days * BK_DAY, base: base, phase: "wait", tries: 0, visit: null,
    }
    bkOrders().push(o)
    bkSave()
    bkLog(o.pname + " заказал у " + (name || kindName) + " (" + o.faction + "): " + units + " шт. на " + total + ", " + days + " дн.")
    return { ok: true, days: days, line: bkPick(BK_ACCEPTED).replace("#", String(days)) }
}

global.TFG_UI.on("order", (player, a) => {
    var s = BK_SESS[String(player.uuid)]
    if (!s) return
    try {
        if (a.a === "close") { delete BK_SESS[String(player.uuid)]; return }
        if (a.a !== "order") return
        var res = bkPlace(player, s, a.buy)
        global.TFG_UI.update(player, { dealt: res.ok, message: res.line, bad: !res.ok })
        if (res.ok) {
            try { player.tell(Text.of("§6[Опт] §f" + (s.ctx.person && s.ctx.person.name ? s.ctx.person.name + ": " : "") + "«" + res.line + "»")) } catch (e) { }
        }
    } catch (e) { bkErr("окно заказа", e) }
})

// ─── Доставка ────────────────────────────────────────────────────────────────

function bkPlayer(o) {
    var found = null
    BK_SERVER.players.forEach(p => { if (String(p.uuid) === o.player) found = p })
    return found
}

function bkDispatch(o) {
    var p = bkPlayer(o)
    if (!p) return                         // без хозяина не везём: подождём, пока зайдёт
    var level = BK_SERVER.overworld()
    if (String(p.level.getDimension()) !== String(level.getDimension())) return
    var before = {}
    try { Object.keys(gsLoad()).forEach(k => before[k] = true) } catch (e) { }
    var err = null
    try {
        err = gsVisit(level, { x: o.base.x + 0.5, y: o.base.y, z: o.base.z + 0.5 }, o.faction, o.kind, o.tier,
            { person: o.person, bulk: o.id })
    } catch (e) { err = String(e) }
    if (err) {
        o.tries++
        bkLog(o.id + ": не выехал (" + err + "), попытка " + o.tries)
        if (o.tries >= BK_TRIES) {
            o.phase = "done"
            o.doneAt = bkNow()
            p.tell(Text.of("§6[Опт] §fПоставка от " + (o.name || o.kindName) + " не пришла: в дороге что-то стряслось. Платить ничего не нужно."))
        } else o.due = bkNow() + 1200
        bkSave()
        return
    }
    var visits = gsLoad()
    for (var k in visits) if (!before[k]) { o.visit = k; break }
    o.phase = "sent"
    o.sentAt = bkNow()
    bkSave()
    p.tell(Text.of("§6[Опт] §f" + (o.name ? o.name + " (" + o.kindName + ")" : o.kindName) + " везёт ваш заказ: " + o.units +
        " шт., к оплате " + o.total + " " + global.TFG_COINS.unit + ". Расчёт на месте."))
}

/** Торговец уехал, а заказ не забран - обида фракции. */
function bkLost(o) {
    o.phase = "done"
    o.doneAt = bkNow()
    o.lost = true
    var p = bkPlayer(o)
    try { if (p) global.TFG_FACTIONS.addRep(p, o.faction, BK_REFUSE_REP, "не забрал оптовый заказ") } catch (e) { bkErr("репутация", e) }
    if (p) p.tell(Text.of("§c[Опт] §f" + (o.name || o.kindName) + " не дождался расчёта и увёз товар. Отношения с фракцией " + BK_REFUSE_REP + "."))
    bkLog(o.id + ": не забран")
    bkSave()
}

var BK_TICK = 0
ServerEvents.tick(event => {
    if (++BK_TICK % 200 !== 0) return
    try {
        if (!BK_SERVER) BK_SERVER = event.server
        var now = bkNow()
        var visits = null
        bkOrders().slice().forEach(o => {
            if (o.phase === "wait" && now >= o.due) bkDispatch(o)
            else if (o.phase === "sent") {
                if (!visits) visits = gsLoad()
                if (!o.visit || !visits[o.visit]) bkLost(o)
            }
        })
    } catch (e) { bkErr("такт", e) }
})

// ─── Разговор: заказ, получение, отказ ──────────────────────────────────────

/** Заказ, который привёз этот торговец этому игроку. */
function bkHere(ctx) {
    try {
        var pd = ctx.trader.persistentData
        if (!pd.contains("tfg_bulk_order")) return null
        var o = bkById(String(pd.getString("tfg_bulk_order")))
        return o && o.phase === "sent" && o.player === String(ctx.player.uuid) ? o : null
    } catch (e) { return null }
}

function bkCanOrder(ctx) {
    if (!ctx.kind || ctx.kind === "buyer" || ctx.kind === "junk" || ctx.kind === "appraiser") return false
    try { if (ctx.trader.persistentData.contains("tfg_bulk_order")) return false } catch (e) { }
    return true
}

function bkInvoice(o, line) {
    var st = bkStackOf(line, 1)
    var desc = st ? String(st.getDescriptionId()) : line.item
    var data = { item: line.item, ammo: line.ammo, left: line.n, from: o.name || o.kindName, u: o.id + "_" + Math.floor(Math.random() * 1e6) }
    return Item.of("minecraft:paper", 1, bkInvoiceTag(data, desc))
}

function bkInvoiceTag(data, desc) {
    return {
        tfg_invoice: JSON.stringify(data), tfg_invoice_desc: desc,
        display: {
            Name: JSON.stringify({ text: "Накладная: ", color: "gold", italic: false, extra: [{ translate: desc }, { text: " ×" + data.left }] }),
            Lore: [JSON.stringify({ text: "От: " + data.from, color: "gray", italic: false }),
                JSON.stringify({ text: "Приложите к ящику, сундуку или сосуду -", color: "dark_gray", italic: false }),
                JSON.stringify({ text: "товар разложится по свободным ячейкам.", color: "dark_gray", italic: false })],
        },
    }
}

function bkTake(ctx) {
    var o = bkHere(ctx)
    if (!o) return dlgClose(ctx.player)
    if (!global.TFG_COINS.pay(ctx.player, o.total)) {
        dlgSay(ctx, bkPick(BK_POOR) + " Нужно " + o.total + " " + global.TFG_COINS.unit + ".")
        return
    }
    o.lines.forEach(line => ctx.player.give(bkInvoice(o, line)))
    o.phase = "done"
    o.doneAt = bkNow()
    o.taken = true
    bkSave()
    try { ctx.trader.persistentData.remove("tfg_bulk_order") } catch (e) { }
    dlgSay(ctx, bkPick(BK_TAKEN))
    dlgClose(ctx.player)
    bkLog(o.id + ": забран, " + o.total)
}

function bkRefuse(ctx) {
    var o = bkHere(ctx)
    if (!o) return dlgClose(ctx.player)
    o.phase = "done"
    o.doneAt = bkNow()
    o.refused = true
    bkSave()
    try { ctx.trader.persistentData.remove("tfg_bulk_order") } catch (e) { }
    try { global.TFG_FACTIONS.addRep(ctx.player, o.faction, BK_REFUSE_REP, "отказался от оптового заказа") } catch (e) { bkErr("репутация", e) }
    dlgSay(ctx, bkPick(BK_REFUSED))
    // обиженный торговец долго не задерживается
    try {
        var v = gsLoad()[o.visit]
        if (v) { v.until = Math.min(v.until, gsNow(gsLevel(v)) + 1200); gsSave() }
    } catch (e) { }
    dlgClose(ctx.player)
}

const BK_OPTIONS = [
    {
        id: "bulk_take",
        label: ctx => { var o = bkHere(ctx); return "Забрать поставку (" + (o ? o.total : "?") + " " + global.TFG_COINS.unit + ")" },
        rep: -1000,
        show: ctx => !!bkHere(ctx),
        hint: ctx => {
            var o = bkHere(ctx)
            return o ? bkPick(BK_ARRIVED) + "\n" + o.units + " шт. в " + o.lines.length + " накладн., к оплате " + o.total + " " + global.TFG_COINS.unit + "." : ""
        },
        run: ctx => bkTake(ctx),
    },
    {
        id: "bulk_refuse",
        label: () => "Отказаться от поставки",
        rep: -1000,
        show: ctx => !!bkHere(ctx),
        hint: () => "Торговец уедет с товаром.\nОтношения с фракцией " + BK_REFUSE_REP + ".",
        run: ctx => bkRefuse(ctx),
    },
    {
        id: "bulk_order",
        label: () => "Оптовый заказ",
        rep: 0,
        show: ctx => bkCanOrder(ctx),
        hint: ctx => (bkIsSolo(ctx) ? "Немного, зато дёшево: до " + BK_SOLO_MAX_UNITS + " шт. позиции." :
            "Сырьё большими партиями дешевле розницы: до " + BK_MAX_UNITS + " шт. позиции.") +
            "\nПривезут к вашей базе через " + BK_MIN_DAYS + "-" + BK_MAX_DAYS + " дн., оплата при получении.",
        avail: ctx => {
            var o = bkActive(ctx.player, ctx.faction, ctx.kind)
            if (!o) return true
            var left = Math.max(0, Math.ceil((o.due - bkNow()) / BK_DAY))
            return o.phase === "sent" ? "Ваш заказ уже в пути." : "Заказ уже принят: привезут через " + left + " дн."
        },
        run: ctx => bkOpen(ctx),
    },
]

try {
    var bkAt = DLG_OPTIONS.map(o => o.id).indexOf("trade")
    BK_OPTIONS.forEach((o, k) => DLG_OPTIONS.splice(bkAt + 1 + k, 0, o))
} catch (e) { bkErr("варианты разговора", e) }

// ─── Накладная: приложить к хранилищу ───────────────────────────────────────

const BK_Caps = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities")

BlockEvents.rightClicked(event => {
    var st = event.item
    if (!st || st.isEmpty() || String(st.id) !== "minecraft:paper" || !st.nbt || !st.nbt.contains("tfg_invoice")) return
    var handled = false
    try {
        var be = event.block.getEntity()
        if (!be) return
        var h = be.getCapability(BK_Caps.ITEM_HANDLER, event.facing).orElse(null)
        if (!h) h = be.getCapability(BK_Caps.ITEM_HANDLER).orElse(null)
        if (!h) return
        handled = true                                  // хранилище - ящик не открываем (отмена - в конце)
        var data = JSON.parse(String(st.nbt.getString("tfg_invoice")))
        var desc = String(st.nbt.getString("tfg_invoice_desc") || data.item)
        var proto = bkStackOf(data, 1)
        if (!proto || proto.isEmpty()) return
        var maxStack = Math.max(1, proto.getMaxStackSize())
        var put = 0
        for (var slot = 0; slot < h.getSlots() && data.left > 0; slot++) {
            // в ячейку - сколько влезет; что не влезло, остаётся в накладной
            var n = Math.min(maxStack, data.left)
            var rest = h.insertItem(slot, bkStackOf(data, n), false)
            var went = n - (rest && !rest.isEmpty() ? rest.getCount() : 0)
            if (went > 0) {
                data.left -= went
                put += went
                if (went === n && data.left > 0) slot--      // ячейка могла принять ещё (большие ячейки)
            }
        }
        var p = event.player
        if (put <= 0) { p.setStatusMessage(Text.of("§eСюда ничего не влезает")); return }
        if (data.left <= 0) {
            st.shrink(1)
            p.give(Item.of("minecraft:paper"))
            p.setStatusMessage(Text.of("§aРазложено " + put + " шт. Накладная пуста."))
        } else {
            var one = Item.of("minecraft:paper", 1, bkInvoiceTag(data, desc))
            st.shrink(1)
            p.give(one)
            p.setStatusMessage(Text.of("§aРазложено " + put + " шт., в накладной осталось " + data.left))
        }
    } catch (e) { bkErr("накладная", e) }
    // вне try и после раскладки: cancel() в KubeJS обрывает обработчик исключением-выходом -
    // стоял до раскладки, и товар не попадал в ящик
    if (handled) event.cancel()
})
