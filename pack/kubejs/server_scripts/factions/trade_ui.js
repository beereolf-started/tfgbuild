"use strict";
/**
 * ОКНО БАРТЕРА В МОДЕ tfgui (factions/ui_bridge.js).
 *
 * Та же сделка, что в сундучном окне (factions/trade_menu.js), - те же предложения торговца
 * (tfg_trader_offers), цены с поправкой на отношения, корзина продажи и проведение сделки
 * через tmDeal. Отличается только показ: мод рисует рюкзак игрока и каталог продавца с
 * категориями, поиском и прокруткой, а сюда присылает действия:
 *   sell {slot, count}  - переложить вещь из рюкзака в корзину продажи;
 *   unsell {k}          - вернуть вещь из корзины;
 *   deal {buy: [[i, штук], ...]} - купить выбранное и продать корзину;
 *   close               - окно закрыто.
 * Открывается из tmOpen, если мод стоит у игрока и у торговца есть товар.
 */

/** Категория товара для вкладок окна: по самому предмету, как он лежит в ассортименте. */
const TU_CATS = [
    { id: "guns", name: "Стволы" }, { id: "ammo", name: "Патроны" }, { id: "weapons", name: "Оружие" },
    { id: "armor", name: "Броня" }, { id: "tools", name: "Инструменты" }, { id: "materials", name: "Металлы и руда" },
    { id: "machines", name: "Механизмы" }, { id: "building", name: "Стройка" }, { id: "textile", name: "Ткани и кожа" },
    { id: "food", name: "Еда" }, { id: "plants", name: "Семена" }, { id: "other", name: "Разное" },
]
const TU_CAT_RULES = [
    ["ammo", /^minecraft:arrow$|^tfc:metal\/javelin\//],
    ["weapons", /_(sword|spear|knife|mace)$|^tfc:metal\/mace\/|^minecraft:(bow|crossbow)$/],
    ["armor", /(helmet|chestplate|greaves|boots|shield|unfinished_helmet|unfinished_chestplate|insulated_leather_)/],
    ["tools", /_(hammer|file|wrench|screwdriver|saw|pickaxe|shovel|hoe|scythe|axe|butchery_knife|mining_hammer|crowbar|wire_cutter|mortar|chisel)$|propick|fishing_rod|^tfc:metal\/(chisel|anvil|tuyere)\/|^tfc:(bellows|crucible)$/],
    ["food", /^(tfc|firmalife):food\/|^afc:maple_sugar/],
    ["plants", /seeds\/|sapling|^tfc:(jute|papyrus)$/],
    ["machines", /^create(addition)?:|^gtceu:(lv|mv|hv|ev|iv|luv)_|_(cable|wire)$|circuit|vacuum_tube|resistor|diode|capacitor|transistor|inductor|smd_/],
    ["textile", /hide|cloth|wool|silk|yarn|leather|textile|fiber|spindle|needle/],
    ["building", /wood\/|lumber|planks|log|brick|rock\/|mortar|clay|thatch|straw|ceramic|alabaster|glass/],
    ["materials", /_(ingot|plate|double_plate|rod|long_rod|bolt|screw|ring|foil|nugget|gear|small_gear|dust|small_dust|tiny_dust|block|frame|round|spring|rotor)$|^tfc:ore\/|^tfc:powder\/|^gtceu:raw_|crushed|^tfc:metal\/(bars|chain|lamp|trapdoor)\/|flux/],
]

function tuCategory(o) {
    if (o.gun) return "guns"
    if (o.ammo) return "ammo"
    var id = String(o.item)
    for (var i = 0; i < TU_CAT_RULES.length; i++) if (TU_CAT_RULES[i][1].test(id)) return TU_CAT_RULES[i][0]
    return "other"
}

/** Цвет фракции торговца (0xRRGGBB) для акцента окна. */
function tuColor(s) {
    try {
        var f = global.TFG_FACTIONS.list.filter(x => x.id === s.faction)[0]
        if (f && typeof trColor === "function") return Number(trColor(f).hex) || 0
    } catch (e) { }
    return 0
}

function tuOfferStack(o) {
    if (o.gun || o.ammo) return global.TFG_GUN_ITEMS.offerStack(o, 1)
    try { return Item.of(o.item, 1) } catch (e) { return null }
}

function tuOffers(s) {
    var f = tmBuyFactor(s)
    var out = []
    s.offers.forEach((o, i) => {
        var st = tuOfferStack(o)
        if (!st || st.isEmpty()) return
        out.push({
            i: i, stack: global.TFG_UI.stackNbt(st), units: o.units, lot: o.count,
            price: o.price * f,                   // окно считает ceil(штук * price / lot) - как tmLotPrice
            cat: tuCategory(o), q: String(o.item) + (o.gun ? " " + o.gun : "") + (o.ammo ? " " + o.ammo : ""),
        })
    })
    return out
}

/** Сколько дадут за штуку каждой вещи рюкзака (0..35); чего не берут - не попадает. */
function tuQuotes(s) {
    var inv = s.player.getInventory()
    var out = []
    for (var i = 0; i < 36; i++) {
        var st = inv.getItem(i)
        if (st.isEmpty() || !tmAccepts(s, st)) continue
        var unit = tmSellUnit(s, st)
        if (unit > 0) out.push([i, Math.round(unit * 100) / 100])
    }
    return out
}

function tuBasket(s) {
    return s.basket.filter(st => !st.isEmpty()).map(st => ({
        stack: global.TFG_UI.stackNbt(st), worth: Math.floor(tmSellUnit(s, st) * st.getCount()),
    }))
}

/** Всё, что меняется от действий: деньги, корзина, оценки рюкзака. */
function tuState(s) {
    return {
        money: Number(global.TFG_COINS.verifiedTotal(s.player)) || 0,
        sale: tmBasketSale(s), basket: tuBasket(s), quotes: tuQuotes(s),
    }
}

function tuOpen(s) {
    s.ui = true
    var data = tuState(s)
    data.type = "barter"
    data.title = String(global.TFG_TRADER_RULES.title(s.trader))
    var spec = String(s.trader.persistentData.getString("tfg_trader_spec") || "")
    if (spec) data.title += " · " + spec
    data.color = tuColor(s)
    data.currency = String(global.TFG_COINS.unit)
    data.buys = true
    data.cats = TU_CATS
    data.offers = tuOffers(s)
    global.TFG_UI.open(s.player, data)
}

/** Сессия этого игрока, если у него открыто именно окно мода. */
function tuSession(player) {
    var s = TM_SESSIONS[String(player.uuid)]
    return s && s.ui && !s.done ? s : null
}

function tuSell(s, a) {
    var slot = Number(a.slot)
    if (!(slot >= 0 && slot < 36)) return
    var src = s.player.getInventory().getItem(slot)
    if (src.isEmpty()) return
    if (!tmAccepts(s, src)) return global.TFG_UI.update(s.player, { message: "Это не по профилю торговца", bad: true })
    var n = Math.max(1, Math.min(src.getCount(), Math.floor(Number(a.count) || src.getCount())))
    var part = src.split(n)
    var left = tmToBasket(s, part)
    if (!left.isEmpty()) {
        src.grow(left.getCount())
        if (left.getCount() === n) return global.TFG_UI.update(s.player, { message: "Корзина продажи заполнена", bad: true })
    }
    global.TFG_UI.update(s.player, tuState(s))
}

function tuUnsell(s, a) {
    var k = Number(a.k)
    var shown = s.basket.filter(st => !st.isEmpty())
    if (!(k >= 0 && k < shown.length)) return
    var st = shown[k]
    s.basket = s.basket.filter(b => b !== st)
    tmGive(s, st)
    global.TFG_UI.update(s.player, tuState(s))
}

function tuDeal(s, a) {
    s.sel = s.offers.map(() => 0)
    ;(a.buy || []).forEach(pair => {
        var i = Number(pair[0]), n = Math.floor(Number(pair[1]))
        if (!(i >= 0 && i < s.offers.length) || !(n > 0)) return
        s.sel[i] = Math.min(n, s.offers[i].units)
    })
    var ok = tmDeal(s)
    s.sel = s.offers.map(() => 0)
    var data = tuState(s)
    if (ok) {
        data.dealt = true
        data.units = s.offers.map((o, i) => [i, o.units])
        data.message = "Сделка состоялась"
    } else {
        data.message = "Сделка не прошла - причина в чате"
        data.bad = true
    }
    global.TFG_UI.update(s.player, data)
}

global.TFG_UI.on("barter", (player, a) => {
    var s = tuSession(player)
    if (!s) return
    tmSafe(s, () => {
        if (a.a === "sell") tuSell(s, a)
        else if (a.a === "unsell") tuUnsell(s, a)
        else if (a.a === "deal") tuDeal(s, a)
        else if (a.a === "close") tmFinish(s)
    })
})
