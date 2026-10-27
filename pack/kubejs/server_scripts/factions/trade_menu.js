// priority: 0
"use strict";

/**
 * ОКНО СДЕЛКИ С ТОРГОВЦЕМ.
 *
 * Меню-сундук KubeJS на 6 рядов с инвентарём игрока снизу. Все ячейки меню - кнопки: ничего не берётся и не
 * сдвигается, каждый клик обрабатывает скрипт.
 *   ряды 1-3 (0-26)  - товар торговца страницами (у скупщика и оценщика - витрина);
 *   ряды 4-5 (27-44) - окно сделки: выбранная покупка или то, что отдаёте;
 *   ряд 6   (45-53)  - кошелёк, итог сделки, кнопка "Подтвердить сделку".
 * Клики: ЛКМ - партия товара (или вся стопка), ПКМ - 1 штука, Shift+клик - всё. Клик в окне сделки - вернуть.
 * Предметы на продажу кладутся в окно сделки кликом по своему инвентарю снизу. Обычный торговец берёт только
 * вещи своего профиля (factions/trade_goods.js) по доле реальной цены: 0.1 при отношениях 0, до 0.5 при +100,
 * до 0.05 при -74 и ниже. Покупка и продажа сводятся в одну сделку: платится или выдаётся разница.
 * "Подтвердить сделку" проводит сделку и закрывает окно.
 *
 * ИНВЕНТАРЬ. Пока меню открыто, KubeJS держит предметы игрока во временном контейнере (gui.capturedInventory),
 * а после закрытия сам возвращает в инвентарь СОХРАНЁННЫЕ ОРИГИНАЛЫ (MinecraftServerMixin.kjs$postTickServer,
 * карта restoreInventories) - поэтому раньше оплата "проходила", но монеты и покупки откатывались.
 * Здесь все изменения делаются во временном контейнере, а при закрытии (gui.closed) он записывается в инвентарь
 * игрока, и запись KubeJS о возврате оригиналов удаляется.
 */

const TM_TOP = 27
const TM_BASKET_FROM = 27
const TM_BASKET_SIZE = 18
const TM_WALLET = 45
const TM_PREV = 46                  // страницы товара: ассортимент больше 27 предложений
const TM_PAGE = 47
const TM_NEXT = 48
const TM_TOTAL = 49
const TM_SEARCH = 50               // поиск по названию: ввод в чат
const TM_RESET = 51                // сбросить поиск
const TM_CONFIRM = 53
const TM_MAX_DIST = 8
const TM_BUYER_SHOWCASE = ["gtceu:exquisite_ruby_gem", "gtceu:flawless_emerald_gem", "gtceu:diamond_gem", "gtceu:platinum_plate",
    "gtceu:gold_ingot", "gtceu:silver_rod", "gtmutils:ancient_gold_coin", "createdeco:copper_coin"]
const TM_ItemStack = Java.loadClass("net.minecraft.world.item.ItemStack")

// торговцы, которые только покупают у игрока: скупщик и старьёвщик
function tmBuysOnly(s) { return s.kind === "buyer" || s.kind === "junk" }
function tmBuyOnlyPrice(s, st) {
    var g = global.TFG_TRADE_GOODS
    return s.kind === "junk" ? g.junkPrice(st) : g.buyPrice(st)
}

var TM_SESSIONS = {}            // uuid игрока -> сделка

// ─── Поиск по названию ───────────────────────────────────────────────────────
//
// В окно-сундук текст не ввести, поэтому «Поиск» закрывает окно и ждёт строку в чате
// (в общий чат она не уходит), затем окно открывается снова с подходящими товарами.
// Сервер знает только английские названия - русские берём из таблицы, собранной из
// переводов модов и сборки (kubejs/config/tfg_ru_names.json). Названия GregTech
// склеиваются как в игре: шаблон формы «%s (Пыль)» + материал «Селитра»; ищется и формула.

var TM_ASK = {}                 // uuid -> { player, trader, sel, until, query, ready } - ждём строку поиска
var TM_RU = null
var TM_TEXT = {}                // id -> текст для поиска (кэш)

function tmRu(key) {
    if (TM_RU === null) {
        TM_RU = {}
        try {
            var m = JsonIO.read("kubejs/config/tfg_ru_names.json")
            if (m) TM_RU = m
        } catch (e) { global.tfgLogError("tfg trade", "таблица русских названий", e) }
    }
    if (!key) return ""
    var v = null
    try { v = TM_RU.get ? TM_RU.get(key) : TM_RU[key] } catch (e) { }
    return v === null || v === undefined ? "" : String(v)
}

function tmSnake(name) { return String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() }

/** Всё, по чему ищется товар: id, английское и русское название, формула. В нижнем регистре. */
function tmSearchText(id, o) {
    var gunKey = o && o.gun ? o.gun : o && o.ammo ? o.ammo : null
    var key = gunKey ? id + "|" + gunKey : id
    if (TM_TEXT[key] !== undefined) return TM_TEXT[key]
    var parts = [id]
    if (gunKey) parts.push(gunKey)
    try {
        var st = gunKey ? global.TFG_GUN_ITEMS.offerStack(o, 1) : Item.of(id)
        parts.push(String(st.getHoverName().getString()))
        parts.push(tmRu(String(st.getDescriptionId())))
        var gt = typeof mkGT === "function" ? mkGT() : null
        if (gt) {
            var entry = gt.helper.getMaterialEntry(st.getItem())
            if (entry && !entry.isEmpty() && entry.material() && entry.tagPrefix()) {
                var mat = entry.material()
                var matRu = tmRu(String(mat.getUnlocalizedName()))
                var form = tmRu("tagprefix." + tmSnake(entry.tagPrefix().name))
                if (matRu) parts.push(form && form.indexOf("%s") >= 0 ? form.replace("%s", matRu) : matRu)
                try { parts.push(String(mat.getChemicalFormula())) } catch (e) { }
            }
        }
    } catch (e) { }
    TM_TEXT[key] = parts.join(" | ").toLowerCase()
    return TM_TEXT[key]
}

/** Номера предложений, подходящих под поиск: каждое слово запроса должно найтись. */
function tmView(s) {
    var words = String(s.query || "").toLowerCase().split(" ").filter(w => w)
    s.view = []
    s.offers.forEach((o, i) => {
        if (!words.length) { s.view.push(i); return }
        var text = tmSearchText(String(o.item), o)
        if (words.every(w => text.indexOf(w) >= 0)) s.view.push(i)
    })
    s.page = 0
}

function tmLore(lines) { return lines.map(l => JSON.stringify({ text: l, color: "gray", italic: false })) }

/** base - NBT самого предмета (GunId/AmmoId у TACZ), к нему дописываем подпись окна. */
function tmIcon(id, count, name, lore, base) {
    var tag = {}
    if (base) for (var bk in base) tag[bk] = base[bk]
    tag.display = { Lore: tmLore(lore) }
    if (name) tag.display.Name = JSON.stringify({ text: name, italic: false, color: "gold" })
    return Item.of(id, Math.max(1, Math.min(99, count)), tag)
}

function tmSay(player, msg) { player.tell(Text.of(msg)) }

/**
 * Закрыть игроку открытое окно. На сервере KubeJS видит этот метод то под именем
 * closeContainer, то только под именем Forge (m_6915_) - пробуем оба.
 */
function tmCloseScreen(p) {
    if (typeof p.closeContainer === "function") return p.closeContainer()
    if (typeof p.m_6915_ === "function") return p.m_6915_()
    throw new Error("у игрока нет метода закрытия окна")
}

function tmIsShift(e) { return String(e.type) === "QUICK_MOVE" }
function tmIsRight(e) { return Number(e.button) === 1 }

// ─── Открытие ────────────────────────────────────────────────────────────────

function tmOpen(player, trader, opts) {
    var uuid = String(player.uuid)
    var pd = trader.persistentData
    var s = {
        player: player, trader: trader, uuid: uuid,
        kind: String(pd.getString("tfg_trader_kind")), faction: String(pd.getString("tfg_trader_faction")),
        gui: null, basket: [], closeNext: false, done: false,
    }
    if (!tmBuysOnly(s) && s.kind !== "appraiser") {
        s.offers = JSON.parse(String(pd.getString("tfg_trader_offers")))
        s.offers.forEach(o => { if (o.units === undefined) o.units = o.count * o.stock })
        s.sel = s.offers.map(() => 0)
        // после поиска окно открывается заново: выбранное не теряем
        if (opts && opts.sel && opts.sel.length === s.offers.length) {
            s.sel = opts.sel.map((u, i) => Math.max(0, Math.min(u, s.offers[i].units)))
        }
        s.query = opts && opts.query ? String(opts.query) : ""
        tmView(s)
    }
    TM_SESSIONS[uuid] = s
    // продавец стоит у прилавка, пока открыто окно (factions/npc_hold.js)
    try { global.TFG_NPC_HOLD.hold(trader, player, 72000, "trade") } catch (e) { }
    // окно мода tfgui, если оно есть у игрока (factions/trade_ui.js); иначе - сундук, как раньше
    if (s.offers && typeof tuOpen === "function" && global.TFG_UI && global.TFG_UI.has(player)) return tuOpen(s)
    player.openChestGUI(Text.of(global.TFG_TRADER_RULES.title(trader)), 6, gui => {
        s.gui = gui
        gui.playerSlots = true
        gui.anyClicked = e => tmSafe(s, () => tmClickMenu(s, e))
        gui.inventoryClicked = e => tmSafe(s, () => tmClickInventory(s, e))
        gui.closed = () => tmSafe(s, () => tmFinish(s))
        s.page = 0
        tmRender(s, false)
        if (s.query && s.view && !s.view.length) tmSay(player, "§eПо запросу «" + s.query + "» у торговца ничего нет.")
    })
}

// ─── /tfgsell <вид> - разбор продажи предмета в руке (диагностика) ──────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgsell").requires(src => src.hasPermission(2))
            .then(Commands.argument("kind", Arguments.STRING.create(event)).executes(ctx => {
                var player = ctx.source.getPlayerOrException()
                var kindId = String(Arguments.STRING.getResult(ctx, "kind"))
                var st = player.getMainHandItem()
                var out = []
                var step = (name, fn) => {
                    try {
                        var v = fn()
                        out.push("§a" + name + ": §f" + v)
                        return v
                    } catch (e) {
                        out.push("§c" + name + " -> ОШИБКА: " + String(e).substring(0, 160))
                        try { out.push("§8" + String(e.stack || "").split("\n").slice(0, 2).join(" | ").substring(0, 200)) } catch (e2) { }
                        return null
                    }
                }
                out.push("§7предмет: §f" + (st && !st.isEmpty() ? st.id : "рука пуста"))
                if (!st || st.isEmpty()) { ctx.source.sendSuccess(Text.of(out.join("\n")), false); return 1 }
                step("вид торговца", () => JSON.stringify(global.TFG_TRADE_GOODS.kind(kindId) ? kindId : "нет такого вида"))
                step("берёт ли по профилю", () => global.TFG_TRADE_GOODS.sellPrice(kindId, st) > 0)
                step("цена за штуку", () => global.TFG_TRADE_GOODS.sellPrice(kindId, st))
                step("цена скупщика", () => global.TFG_TRADE_GOODS.buyPrice(st))
                step("прайс по id", () => global.TFG_TRADE_GOODS.itemPrice(String(st.id)))
                step("износ", () => st.isDamageableItem() + " / " + st.getMaxDamage() + " / " + st.getDamageValue())
                step("имя предмета", () => String(st.getHoverName().getString()))
                step("копия стопки", () => String(st.copy().getCount()))
                ctx.source.sendSuccess(Text.of(out.join("\n")), false)
                return 1
            })))
    } catch (err) {
        console.error("[trade_menu] ошибка регистрации команд: " + err)
    }
})

global.TFG_TRADE_MENU = { open: (player, trader) => tmOpen(player, trader) }

function tmSafe(s, fn) {
    try {
        fn()
    } catch (e) {
        var where = ""
        try { where = String(e.stack || "").split("\n").slice(0, 3).join(" | ") } catch (e3) { }
        global.tfgLogError("tfg trade", "окно сделки" + (where ? " [" + where + "]" : ""), e)
        // игроку - одна строка, всё остальное в серверный лог (grep "[tfg trade")
        try { tmSay(s.player, "§cСделка не прошла - ошибка записана в лог сервера.") } catch (e2) { }
    }
}

// ─── Инвентарь во время сделки ───────────────────────────────────────────────

/** Контейнер с предметами игрока, пока меню открыто (до захвата - сам инвентарь). */
function tmInv(s) {
    return (s.gui && s.gui.capturedInventory) ? s.gui.capturedInventory : s.player.getInventory()
}

/** Положить предмет игроку (во временный контейнер меню), остаток - под ноги. */
function tmGive(s, stack) {
    global.TFG_COINS.insert(s.player, stack)
}

function tmGiveItems(s, id, count) {
    var max = Item.of(id).getMaxStackSize()
    while (count > 0) {
        var n = Math.min(max, count)
        tmGive(s, Item.of(id, n))
        count -= n
    }
}

/** Выдать купленное по предложению: стволы и патроны TACZ собираются со своим id. */
function tmGiveOffer(s, o, count) {
    if (!o.gun && !o.ammo) return tmGiveItems(s, o.item, count)
    var probe = global.TFG_GUN_ITEMS.offerStack(o, 1)
    if (!probe) throw new Error("не собрался предмет " + (o.gun || o.ammo))
    var max = Math.max(1, probe.getMaxStackSize())
    while (count > 0) {
        var n = Math.min(max, count)
        tmGive(s, global.TFG_GUN_ITEMS.offerStack(o, n))
        count -= n
    }
}

/** NBT товара для иконки: только у стволов и патронов TACZ, остальным - ничего. */
function tmOfferTag(o) {
    if (!o.gun && !o.ammo) return null
    try { return global.TFG_GUN_ITEMS.offerTag(o) } catch (e) { return null }
}

/** Название товара для чека. */
function tmOfferName(o) {
    var st = o.gun || o.ammo ? global.TFG_GUN_ITEMS.offerStack(o, 1) : Item.of(o.item)
    return st ? st.getHoverName().getString() : String(o.gun || o.ammo || o.item)
}

/** Закрытие окна: вернуть окно сделки, записать временный контейнер в инвентарь и отменить откат KubeJS. */
var TM_WRITES = {}              // uuid -> { player, items } - повторная запись после возврата оригиналов KubeJS

function tmWrite(player, items) {
    var inv = player.getInventory()
    for (var i = 0; i < items.length; i++) inv.setItem(i, items[i].copy())
    inv.setChanged()
}

function tmFinish(s) {
    if (s.done) return
    s.done = true
    delete TM_SESSIONS[s.uuid]
    try { global.TFG_NPC_HOLD.release(s.trader, "trade") } catch (e) { }
    var p = s.player
    if (s.searchNext) {
        TM_ASK[s.uuid] = { player: p, trader: s.trader, sel: s.sel ? s.sel.slice() : null, until: Number(p.getServer().getTickCount()) + 1200 }
        tmSay(p, "§eНапишите в чат, что ищете (например «селитра» или «KNO3»). «-» - показать всё. Сообщение никто не увидит.")
    }
    var cap = s.gui ? s.gui.capturedInventory : null
    s.basket.forEach(st => { if (!st.isEmpty()) tmGive(s, st) })
    s.basket = []
    if (!cap) return
    var items = []
    for (var i = 0; i < cap.getContainerSize(); i++) items.push(cap.getItem(i).copy())
    // KubeJS в конце тика кладёт в инвентарь сохранённые оригиналы, если запись о них осталась
    try { p.getServer().restoreInventories().remove(p.uuid) } catch (e) { }
    tmWrite(p, items)
    // ServerEvents.tick вызывается уже после этого возврата - там пишем итог ещё раз, если откат всё же случился
    TM_WRITES[s.uuid] = { player: p, items: items }
}

// ─── Отрисовка ───────────────────────────────────────────────────────────────

function tmSet(s, slot, stack) { s.gui.slots[slot].setItem(stack) }

/** Отношения фракции с игроком, приведённые к 0..1 (-100 и ниже - 0, +100 - 1). */
function tmRepShare(s) {
    var rep = Number(global.TFG_FACTIONS.rep(s.player, s.faction))
    if (!isFinite(rep)) rep = 0
    return Math.max(0, Math.min(1, (rep + 100) / 200))
}

/** Наценка при покупке: линейно от 1.25 при вражде до 0.75 при полном доверии. */
function tmBuyFactor(s) { return 1.25 - 0.5 * tmRepShare(s) }

/** Доля реальной цены при продаже торговцу: линейно от 0.05 при вражде до 0.5 при полном доверии. */
function tmSellFactor(s) { return 0.05 + 0.45 * tmRepShare(s) }

/** Фракция сделки: у торговца записана своя, а нет (торговец без фракции) - та, по которой считались цены. */
function tmFactionOf(s) {
    var f = ""
    try { f = String(s.trader.persistentData.getString("tfg_trader_faction")) } catch (e) { }
    return f || String(s.faction || "")
}

/** Цена партии товара с учётом отношений. */
function tmLotPrice(s, o, units) { return Math.ceil(units * o.price * tmBuyFactor(s) / o.count) }

function tmShopCost(s) {
    var cost = 0
    s.sel.forEach((u, i) => { if (u > 0) cost += tmLotPrice(s, s.offers[i], u) })
    return cost
}

function tmSellUnit(s, st) {
    var goods = global.TFG_TRADE_GOODS
    var id = String(st.id)
    return s.offers
        ? tmPriceOf(() => goods.sellPrice(s.kind, st), id) * tmSellFactor(s)
        : tmPriceOf(() => tmBuyOnlyPrice(s, st), id)
}

function tmBasketSale(s) {
    return Math.floor(s.basket.reduce((sum, st) => sum + tmSellUnit(s, st) * st.getCount(), 0))
}

/** Сколько ячеек окна сделки занято покупками. */
function tmChosenCount(s) {
    return s.sel ? s.sel.filter(u => u > 0).length : 0
}

function tmBasketCoins(s) {
    var coins = global.TFG_COINS
    return s.basket.reduce((sum, st) => sum + coins.faceValue(st) * st.getCount(), 0)
}

function tmAppraiseBlock(s) {
    var rules = global.TFG_TRADER_RULES
    var rep = global.TFG_FACTIONS.rep(s.player, s.faction)
    if (rep < rules.appraiserRep) return "Нужны отношения от " + rules.appraiserRep + " (сейчас " + Math.round(rep) + ")."
    var wait = rules.appraiseWait(s.player, s.faction)
    if (wait > 0) return "Эта фракция уже проверяла ваши монеты. Снова - через " + wait + " дн."
    return null
}

function tmRender(s, sync) {
    var coins = global.TFG_COINS
    var rules = global.TFG_TRADER_RULES
    var pane = tmIcon("minecraft:gray_stained_glass_pane", 1, " ", [])
    for (var i = 0; i < 54; i++) tmSet(s, i, TM_ItemStack.EMPTY)
    for (var j = TM_WALLET; j <= TM_CONFIRM; j++) tmSet(s, j, pane)

    var ready = false
    var totalLore
    if (s.offers) {
        var pages = Math.max(1, Math.ceil(s.view.length / TM_TOP))
        if (s.page >= pages) s.page = pages - 1
        var from = s.page * TM_TOP
        for (var pi = 0; pi < TM_TOP && from + pi < s.view.length; pi++) {
            var o = s.offers[s.view[from + pi]]
            var avail = o.units - s.sel[s.view[from + pi]]
            tmSet(s, pi, tmIcon(o.item, avail, null, [
                "Цена: " + tmLotPrice(s, o, o.count) + " " + coins.unit + " за " + o.count + " шт.",
                avail > 0 ? "Доступно: " + avail : "Нет в наличии",
                "ЛКМ - партия (" + o.count + "), ПКМ - 1 шт., Shift - всё",
            ], tmOfferTag(o)))
        }
        var k = 0
        s.sel.forEach((u, i) => {
            if (u <= 0 || k >= TM_BASKET_SIZE) return
            var o = s.offers[i]
            tmSet(s, TM_BASKET_FROM + k++, tmIcon(o.item, u, null, [
                "Выбрано: " + u + " шт., " + tmLotPrice(s, o, u) + " " + coins.unit,
                "ЛКМ - убрать партию, ПКМ - 1 шт., Shift - всё",
            ], tmOfferTag(o)))
        })
        s.basket.forEach(st => {
            if (k >= TM_BASKET_SIZE) return
            var shown = st.copy()
            var worth = Math.floor(tmSellUnit(s, st) * st.getCount())
            shown.setHoverName(Text.of("Продаёте: " + st.getHoverName().getString() + " - " + worth + " " + coins.unit))
            tmSet(s, TM_BASKET_FROM + k++, shown)
        })
        var factor = tmSellFactor(s)
        if (pages > 1) {
            tmSet(s, TM_PREV, tmIcon("minecraft:arrow", 1, "Предыдущая страница", ["Товара на " + pages + " страниц."]))
            tmSet(s, TM_NEXT, tmIcon("minecraft:arrow", 1, "Следующая страница", ["Товара на " + pages + " страниц."]))
        }
        tmSet(s, TM_SEARCH, tmIcon("minecraft:spyglass", 1, "Поиск по названию", [
            "Нажмите и напишите в чат, что ищете: «селитра», «KNO3», «стальн слиток».",
            "Можно по-русски, по-английски и по химической формуле."]))
        if (s.query) tmSet(s, TM_RESET, tmIcon("minecraft:barrier", 1, "Сбросить поиск", ["Сейчас показано: «" + s.query + "», найдено " + s.view.length + "."]))
        tmSet(s, TM_PAGE, tmIcon("minecraft:writable_book", 1, "Страница " + (s.page + 1) + " из " + pages, [
            (s.query ? "Найдено по «" + s.query + "»: " + s.view.length + " из " + s.offers.length : "Всего предложений: " + s.offers.length) + ".",
            "Цены для вас: покупка x" + tmBuyFactor(s).toFixed(2) + " (от 1.25 при вражде до 0.75 при дружбе).",
            "Продать торговцу: беру вещи своего профиля за " + Math.round(factor * 100) + "% цены",
            "(от 5% при вражде до 50% при полном доверии).",
            "Кликните по вещи в своём инвентаре снизу: ЛКМ - стопка, ПКМ - 1 шт., Shift - все такие."]))
        var cost = tmShopCost(s)
        var sale = tmBasketSale(s)
        var net = cost - sale
        var have = coins.verifiedTotal(s.player)
        totalLore = ["Покупка: " + cost + ", продажа: " + sale + " " + coins.unit,
            cost === 0 && sale === 0 ? "Выберите товар сверху или положите вещи на продажу."
                : net > 0 ? (net > have ? "К оплате " + net + ": не хватает " + (net - have) + " " + coins.unit : "К оплате: " + net + " " + coins.unit)
                : "Вы получите: " + (-net) + " " + coins.unit]
        ready = (cost > 0 || sale > 0) && !(s.basket.length > 0 && sale <= 0) && net <= have
    } else {
        if (tmBuysOnly(s)) {
            var slot = 0
            // у старьёвщика витрины нет: он берёт что угодно, кроме денег
            if (s.kind === "junk") tmSet(s, 13, tmIcon("minecraft:bundle", 1, "Беру всё", [
                "Любую вещь, кроме денег, - за треть её цены.",
                "Драгоценное выгоднее нести скупщику, ремесленное - своему мастеру."]))
            if (s.kind === "buyer") TM_BUYER_SHOWCASE.forEach(id => {
                var probe
                try { probe = Item.of(id) } catch (e) { return }
                if (probe.isEmpty()) return
                tmSet(s, slot++, tmIcon(id, 1, null, [
                    "Скупаю: " + global.TFG_TRADE_GOODS.buyPrice(probe) + " " + coins.unit + " за штуку",
                    id.indexOf("_gem") >= 0 ? "и другие самоцветы GregTech любой огранки"
                        : id.indexOf("coin") >= 0 ? "неверифицированные монеты - как безделушки" : "и другие драгметаллы и сплавы",
                ]))
            })
            tmSet(s, 22, tmIcon("minecraft:writable_book", 1, "Как продать", [
                "Кликните по вещи в своём инвентаре снизу: ЛКМ - стопка,", "ПКМ - 1 шт., Shift - все такие. Затем \"Подтвердить сделку\"."]))
            var sale = tmBasketSale(s)
            totalLore = ["Вы получите: " + sale + " " + coins.unit, "Оплата - верифицированными монетами."]
            ready = sale > 0
        } else {
            tmSet(s, 13, tmIcon("minecraft:writable_book", 1, "Верификация монет", [
                "Раз в месяц календаря TFC, у каждой фракции свой срок.",
                "За раз - до " + rules.appraiseLimit + " " + coins.unit + ", комиссия " + Math.round(rules.commission * 100) + "%.",
                "Нужны отношения фракции с вами от " + rules.appraiserRep + ".",
                "Кликните по неверифицированным монетам в инвентаре снизу."]))
            var block = tmAppraiseBlock(s)
            var value = Math.min(tmBasketCoins(s), rules.appraiseLimit)
            var fee = Math.ceil(value * rules.commission)
            totalLore = block ? [block] : ["На проверку: " + value + " " + coins.unit, "Комиссия " + fee + ", получите " + (value - fee)]
            ready = !block && value > 0
        }
        s.basket.forEach((st, i) => {
            if (i >= TM_BASKET_SIZE) return
            var shown = st.copy()
            tmSet(s, TM_BASKET_FROM + i, shown)
        })
    }
    tmSet(s, TM_WALLET, tmIcon("createdeco:gold_coin", 1, "Кошелёк",
        ["Верифицированных монет: " + coins.verifiedTotal(s.player) + " " + coins.unit, "Сдачу торговец даёт сам."]))
    tmSet(s, TM_TOTAL, tmIcon("minecraft:paper", 1, "Итог сделки", totalLore))
    tmSet(s, TM_CONFIRM, tmIcon(ready ? "minecraft:lime_concrete" : "minecraft:red_concrete", 1, "Подтвердить сделку",
        [ready ? "Нажмите, чтобы совершить сделку." : "Сделка пока невозможна - см. итог."]))
    if (sync) s.gui.sync()
}

// ─── Клики ───────────────────────────────────────────────────────────────────

function tmClickMenu(s, e) {
    var slot = Number(e.slot.index)
    if (slot === TM_CONFIRM) return tmConfirm(s)
    if (s.offers && slot === TM_SEARCH) {
        s.searchNext = true
        s.closeNext = true
        return
    }
    if (s.offers && slot === TM_RESET && s.query) {
        s.query = ""
        tmView(s)
        return tmRender(s, true)
    }
    if (s.offers && (slot === TM_PREV || slot === TM_NEXT)) {
        var pages = Math.max(1, Math.ceil(s.view.length / TM_TOP))
        s.page = (s.page + (slot === TM_NEXT ? 1 : pages - 1)) % pages
        return tmRender(s, true)
    }
    var chosen = []
    if (s.offers) s.sel.forEach((u, i) => { if (u > 0) chosen.push(i) })
    if (s.offers && slot < TM_TOP && s.page * TM_TOP + slot < s.view.length) {
        var idx = s.view[s.page * TM_TOP + slot]
        var o = s.offers[idx]
        if (s.sel[idx] === 0 && chosen.length + s.basket.length >= TM_BASKET_SIZE) return tmSay(s.player, "§eОкно сделки заполнено.")
        var avail = o.units - s.sel[idx]
        var add = tmIsShift(e) ? avail : tmIsRight(e) ? 1 : o.count
        s.sel[idx] += Math.max(0, Math.min(avail, add))
    } else if (s.offers && slot >= TM_BASKET_FROM && slot < TM_BASKET_FROM + chosen.length) {
        var idx = chosen[slot - TM_BASKET_FROM]
        var take = tmIsShift(e) ? s.sel[idx] : tmIsRight(e) ? 1 : s.offers[idx].count
        s.sel[idx] = Math.max(0, s.sel[idx] - take)
    } else if (slot >= TM_BASKET_FROM && slot < TM_BASKET_FROM + TM_BASKET_SIZE) {
        var st = s.basket[slot - TM_BASKET_FROM - chosen.length]
        if (!st) return
        if (tmIsShift(e)) {
            var same = s.basket.filter(b => TM_ItemStack.isSameItemSameTags(b, st))
            s.basket = s.basket.filter(b => !TM_ItemStack.isSameItemSameTags(b, st))
            same.forEach(b => tmGive(s, b))
        } else {
            tmGive(s, st.split(tmIsRight(e) ? 1 : st.getCount()))
            s.basket = s.basket.filter(b => !b.isEmpty())
        }
    }
    tmRender(s, true)
}

/** Цена не должна ронять окно: если прайс споткнулся, считаем, что предмет не по профилю. */
function tmPriceOf(fn, what) {
    try {
        var v = Number(fn())
        return isFinite(v) ? v : 0
    } catch (e) {
        global.tfgLogError("tfg trade", "цена предмета (" + what + ")", e)
        return 0
    }
}

function tmAccepts(s, st) {
    if (st.isEmpty()) return false
    if (s.offers) return tmPriceOf(() => global.TFG_TRADE_GOODS.sellPrice(s.kind, st), String(st.id)) > 0
    if (tmBuysOnly(s)) return tmPriceOf(() => tmBuyOnlyPrice(s, st), String(st.id)) > 0
    return global.TFG_COINS.isCoin(st) && !global.TFG_COINS.isVerified(st)
}

/** Переложить часть стопки в окно сделки; вернуть, сколько не поместилось. */
function tmToBasket(s, part) {
    for (var i = 0; i < s.basket.length && !part.isEmpty(); i++) {
        var b = s.basket[i]
        if (!TM_ItemStack.isSameItemSameTags(b, part)) continue
        var n = Math.min(b.getMaxStackSize() - b.getCount(), part.getCount())
        if (n > 0) {
            b.grow(n)
            part.shrink(n)
        }
    }
    while (!part.isEmpty() && s.basket.length < TM_BASKET_SIZE - tmChosenCount(s)) {
        var m = Math.min(part.getMaxStackSize(), part.getCount())
        s.basket.push(part.split(m))
    }
    return part
}

function tmClickInventory(s, e) {
    var st = e.getItem()
    if (st.isEmpty()) return
    if (!tmAccepts(s, st)) {
        return tmSay(s.player, s.offers ? "§eЭто не по профилю торговца - он такое не берёт."
            : s.kind === "buyer" ? "§eСкупщик берёт только драгоценное: самоцветы, драгметаллы, украшения."
            : s.kind === "junk" ? "§eДеньги старьёвщик не берёт." : "§eОценщик проверяет только неверифицированные монеты.")
    }
    var inv = tmInv(s)
    var sources = []
    if (tmIsShift(e)) {
        for (var i = 0; i < inv.getContainerSize(); i++) {
            var other = inv.getItem(i)
            if (!other.isEmpty() && TM_ItemStack.isSameItemSameTags(other, st)) sources.push(other)
        }
    } else {
        sources.push(st)
    }
    sources.forEach((src, n) => {
        var part = src.split(tmIsRight(e) && !tmIsShift(e) ? 1 : src.getCount())
        var left = tmToBasket(s, part)
        if (!left.isEmpty()) src.grow(left.getCount())
    })
    if (s.basket.length + tmChosenCount(s) >= TM_BASKET_SIZE) tmSay(s.player, "§eОкно сделки заполнено.")
    tmRender(s, true)
}

// ─── Сделка ──────────────────────────────────────────────────────────────────

/** Провести сделку по выбранному (s.sel) и корзине. true - прошла; иначе игрок уже получил причину. */
function tmDeal(s) {
    var p = s.player
    var coins = global.TFG_COINS
    if (s.offers) {
        var cost = tmShopCost(s)
        var sale = tmBasketSale(s)
        if (cost <= 0 && sale <= 0) return tmSay(p, "§cВыберите товар сверху или положите вещи на продажу (клик по своему инвентарю).")
        if (s.basket.length > 0 && sale <= 0) return tmSay(p, "§cВещи на продажу стоят меньше 1 " + coins.unit + " - добавьте ещё или заберите их.")
        var net = cost - sale
        if (net > 0 && !coins.pay(p, net)) return tmSay(p, "§cНе хватает верифицированных монет: нужно " + net + ", у вас " + coins.verifiedTotal(p) + " " + coins.unit + ".")
        var soldCount = s.basket.reduce((n, st) => n + st.getCount(), 0)
        s.basket = []
        if (net < 0) coins.give(p, -net)
        var bought = []
        s.sel.forEach((u, i) => {
            if (u <= 0) return
            var o = s.offers[i]
            tmGiveOffer(s, o, u)
            o.units = Math.max(0, o.units - u)
            o.stock = Math.floor(o.units / o.count)
            bought.push(u + " x " + tmOfferName(o))
        })
        s.sel = s.offers.map(() => 0)
        s.trader.persistentData.putString("tfg_trader_offers", JSON.stringify(s.offers))
        if (bought.length > 0) tmSay(p, "§aКуплено за " + cost + " " + coins.unit + ": " + bought.join(", "))
        if (soldCount > 0) tmSay(p, "§aПродано " + soldCount + " шт. за " + sale + " " + coins.unit + ".")
        tmSay(p, net > 0 ? "§aОплачено: " + net + " " + coins.unit : net < 0 ? "§aПолучено: " + (-net) + " " + coins.unit : "§aОбмен без доплаты.")
        // торговец запоминает объём сделки: крупные потом вспоминает при встрече
        try { global.TFG_NPC.noteDeal(global.TFG_NPC.personOf(s.trader), p, cost + sale) } catch (e) { }
        // оборот за сутки: перевалит за предел - фракция считает торговлю выгодной (factions/politics.js)
        try { global.TFG_POLITICS.turnover(p, tmFactionOf(s), cost + sale) } catch (e) { }
        try { global.TFG_RELATIONS.dealt(p, s.trader, cost + sale) } catch (e) { }
    } else if (tmBuysOnly(s)) {
        var total = tmBasketSale(s)
        if (total <= 0) return tmSay(p, "§cПоложите в окно сделки то, что " + (s.kind === "junk" ? "старьёвщик" : "скупщик") +
            " покупает (клик по своему инвентарю).")
        s.basket = []
        coins.giveRandom(p, total)
        tmSay(p, "§aПродано на " + total + " " + coins.unit + ", оплата верифицированными монетами.")
        try { global.TFG_NPC.noteDeal(global.TFG_NPC.personOf(s.trader), p, total) } catch (e) { }
        try { global.TFG_POLITICS.turnover(p, tmFactionOf(s), total) } catch (e) { }
        try { global.TFG_RELATIONS.dealt(p, s.trader, total) } catch (e) { }
    } else {
        var rules = global.TFG_TRADER_RULES
        var block = tmAppraiseBlock(s)
        if (block) return tmSay(p, "§c" + block)
        var taken = 0
        s.basket.forEach(st => {
            var face = coins.faceValue(st)
            var n = Math.min(st.getCount(), Math.floor((rules.appraiseLimit - taken) / face))
            if (n <= 0) return
            st.shrink(n)
            taken += n * face
        })
        s.basket = s.basket.filter(b => !b.isEmpty())    // сверх лимита - вернётся при закрытии
        if (taken <= 0) return tmSay(p, "§cПоложите в окно сделки неверифицированные монеты (клик по своему инвентарю).")
        var fee = Math.ceil(taken * rules.commission)
        coins.give(p, taken - fee)
        rules.markAppraised(p, s.faction)
        tmSay(p, "§aПроверено монет на " + taken + " " + coins.unit + ", комиссия " + fee + ", получено верифицированных: " + (taken - fee) + ".")
    }
    return true
}

function tmConfirm(s) {
    if (!tmDeal(s)) return
    s.closeNext = true
    tmRender(s, true)
}

// ─── Тик: закрыть после сделки, при уходе торговца или игрока ────────────────

ServerEvents.tick(event => {
    for (var wid in TM_WRITES) {
        try {
            var w = TM_WRITES[wid]
            if (!w.player.isRemoved()) tmWrite(w.player, w.items)
        } catch (e) {
            global.tfgLogError("tfg trade", "запись инвентаря после сделки", e)
        }
        delete TM_WRITES[wid]
    }
    for (var aid in TM_ASK) {
        var a = TM_ASK[aid]
        try {
            if (a.player.isRemoved() || Number(event.server.getTickCount()) > a.until) { delete TM_ASK[aid]; continue }
            if (!a.ready) continue
            delete TM_ASK[aid]
            if (!a.trader.isAlive() || a.trader.distanceToEntity(a.player) > TM_MAX_DIST) {
                tmSay(a.player, "§7Торговец уже далеко - подойдите и откройте сделку заново.")
                continue
            }
            tmOpen(a.player, a.trader, { query: a.query === "-" ? "" : a.query, sel: a.sel })
        } catch (e) {
            global.tfgLogError("tfg trade", "поиск " + aid, e)
            delete TM_ASK[aid]
        }
    }
    for (var uuid in TM_SESSIONS) {
        var s = TM_SESSIONS[uuid]
        try {
            var p = s.player
            if (p.isRemoved()) {
                tmFinish(s)
                continue
            }
            if (s.closeNext || !s.trader.isAlive() || s.trader.distanceToEntity(p) > TM_MAX_DIST) {
                s.closeNext = false
                // окно мода закрываем его же командой; сундук - закрытием контейнера
                if (s.ui) {
                    global.TFG_UI.close(p)
                    tmFinish(s)
                    continue
                }
                tmCloseScreen(p)
            }
        } catch (e) {
            global.tfgLogError("tfg trade", "сделка " + uuid, e)
            delete TM_SESSIONS[uuid]
        }
    }
})

// Строка поиска приходит в чат: забираем её себе, в общий чат она не уходит.
PlayerEvents.chat(event => {
    try {
        var a = TM_ASK[String(event.player.uuid)]
        if (!a || a.ready) return
        a.query = String(event.message).trim()
        a.ready = true
        event.cancel()
    } catch (e) { global.tfgLogError("tfg trade", "строка поиска", e) }
})
