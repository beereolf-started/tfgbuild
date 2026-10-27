"use strict";
/**
 * КОМУ ПРОДАТЬ: теги на предметах по тем же правилам, по которым торговцы покупают.
 *
 * На предмет вешается tfg:komu_prodat/<торговец> - по одному тегу на каждого, кто его берёт.
 * Видно в подсказке предмета списком тегов (мод Cucumber, F3+H). Старьёвщика нет: он берёт
 * всё, кроме денег. Монеты не помечаются - их несут оценщику.
 *
 * Считается при каждом /reload из правил factions/trade_goods.js и разметки рынка
 * factions/trade_market.js, поэтому тег и окно сделки не расходятся.
 */

const TT_PREFIX = "tfg:komu_prodat/"
// id тега - только латиница, поэтому имя торговца транслитом
const TT_NAMES = {
    weaponsmith: "oruzheynik", armorer: "bronnik", blacksmith: "kuznec", builder: "stroitel",
    carpenter: "plotnik", potter: "gonchar", butcher: "myasnik", cook: "povar", fisherman: "rybak",
    hunter: "okhotnik", gardener: "sadovnik", tailor: "portnoy", miner: "shakhter", mechanic: "mekhanik",
    electrician: "elektrik", metallurgist: "metallurg", chemist: "khimik", buyer: "skupshchik",
}

ServerEvents.tags("item", event => {
    var started = Date.now()
    var list = null
    try { list = Item.getTypeList() } catch (e) { console.error("[кому продать] нет списка предметов: " + e); return }
    var total = list.length !== undefined ? list.length : list.size()
    var kinds = TG_KINDS.filter(k => k.goods && !k.special && TT_NAMES[k.id])
    var known = {}
    kinds.forEach(k => { known[k.id] = true })
    var byTag = {}
    var tagged = 0, failed = 0
    for (var i = 0; i < total; i++) {
        var id = String(list.get ? list.get(i) : list[i])
        try {
            var stack = Item.of(id)
            if (!stack || stack.isEmpty()) continue
            if (global.TFG_COINS && global.TFG_COINS.isCoin(stack)) continue
            var who = {}
            kinds.forEach(k => { if (tgKindBuys(k, id)) who[k.id] = true })
            var a = null
            try { a = global.TFG_MARKET.appraise(stack) } catch (e) { }
            if (a && a.kinds) a.kinds.forEach(kid => { if (known[String(kid)]) who[String(kid)] = true })
            if (global.TFG_TRADE_GOODS.buyPrice(stack) > 0) who.buyer = true
            var any = false
            for (var kid in who) {
                var tag = TT_PREFIX + TT_NAMES[kid]
                if (!byTag[tag]) byTag[tag] = []
                byTag[tag].push(id)
                any = true
            }
            if (any) tagged++
        } catch (e) {
            failed++
        }
    }
    var rows = []
    for (var t in byTag) {
        event.add(t, byTag[t])
        rows.push(t.substring(TT_PREFIX.length) + " " + byTag[t].length)
    }
    console.log("[кому продать] предметов " + total + ", помечено " + tagged + ", ошибок " + failed +
        ", за " + (Date.now() - started) + " мс: " + rows.join(", "))
})
