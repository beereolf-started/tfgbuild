"use strict";
/**
 * ПОЛИТИКА ФРАКЦИЙ (шаг 4): события мира, которые двигают матрицу отношений.
 *
 * Правила:
 *  - цена события равна цене такого же поступка игрока: налёт на гостей или караван -30, выгодная сделка +20,
 *    мелочи у костра (угощение, подарок, тычок) от -10 до +10;
 *  - событие раздаётся по союзам: союзники участника разделяют его чувства, враги - наоборот (factions/core.js);
 *  - сумма матрицы без разбойников всегда ноль; пары с разбойниками закреплены на -100;
 *  - любая схватка с разбойниками стягивает матрицу к нейтралитету: общий враг сближает;
 *  - разгон: чем хуже отношения, тем чаще пара вредит друг другу, чем лучше - тем чаще помогает;
 *  - пока идёт проверка, обо всех событиях пишем в чат (потом уберём).
 *
 * Хранение: оборот торговли по фракциям за сутки - данные сервера (tfg_pol_trade_*).
 */

var POL_SERVER = null

const POL_EVENT_TICKS = 6000        // раз в шесть часов игрового времени - розыгрыш события
const POL_EVENT_CHANCE = 0.65       // и не каждый раз
// В чат события больше не пишутся: они ложатся в записи поселений (factions/world.js)
// и живут месяц. Игрок узнаёт о них от жителей и гостей, а не из строки в чате.
const POL_ANNOUNCE = false
const POL_TRADE_PER_REP = 100       // медяков оборота на +1 к отношению (каждая сделка - пропорционально)
const POL_TRADE_DAY_CAP = 20        // больше этого за сутки торговлей не набрать
const POL_TRADE_BONUS = 20

// Цены поступков: одинаковы для мира и для игрока.
const POL_PRICE = {
    raid: -30,                      // налёт на гостей или караван
    ambush: -30,                    // засада на дороге
    kill: -30,                      // убийство человека фракции
    theft: -18,                     // угон транспорта, кража груза
    slander: -12,                   // наговор, сорванный уговор
    insult: -6,                     // тычок, грубость
    deal: 20,                       // выгодная сделка (оборот больше POL_TRADE_DAY_LIMIT за сутки)
    escort: 15,                     // проводили караван, отбили нападение
    gift: 8,                        // подарок, гостинец
    feast: 6,                       // посиделки у костра, угощение
    help: 10,                       // помощь в беде
}

/** Плохие события: чем хуже отношения, тем они вероятнее. */
const POL_BAD = [
    { k: "raid", text: "{a} разграбили караван фракции {b}" },
    { k: "ambush", text: "люди фракции {a} устроили засаду на дороге фракции {b}" },
    { k: "kill", text: "человек фракции {a} убил торговца фракции {b}" },
    { k: "theft", text: "{a} угнали повозку у фракции {b}" },
    { k: "slander", text: "{a} сорвали уговор с фракцией {b}" },
    { k: "insult", text: "посланника фракции {b} выставили за порог у {a}" },
]

/** Добрые события: чем лучше отношения, тем они вероятнее. */
const POL_GOOD = [
    { k: "deal", text: "{a} и {b} закрыли крупную сделку" },
    { k: "escort", text: "бойцы фракции {a} отбили караван фракции {b} у разбойников" },
    { k: "help", text: "{a} прислали хлеб и лекарей в поселение фракции {b}" },
    { k: "gift", text: "{a} отправили подарки старшинам фракции {b}" },
    { k: "feast", text: "{a} и {b} сидели у одного костра" },
]

/** Стычки с разбойниками: тянут всех к нейтралитету, общий враг сближает. */
const POL_BANDIT = [
    "отряд фракции {a} разбил шайку разбойников",
    "разбойники сожгли хутор фракции {a}",
    "караван фракции {a} отбился от разбойников на перевале",
]

function polLog(text) { try { console.log("[политика] " + text) } catch (e) { } }
function polPick(list) { return list[Math.floor(Math.random() * list.length)] }
function polName(id) {
    var f = global.TFG_FACTIONS.list.filter(x => x.id === id)[0]
    return f ? f.color + f.name + "§r" : id
}

function polAnnounce(text, factionId, kind) {
    // событие уходит в память мира - к ближайшему поселению той фракции, которой оно касается
    try { global.TFG_WORLD.factionEvent(factionId || null, kind || "весть", String(text).replace(/§./g, "")) } catch (e) { }
    if (!POL_ANNOUNCE || !POL_SERVER) return
    try { POL_SERVER.players.forEach(p => p.tell(Text.of("§5[Мир] §f" + text))) } catch (e) { }
}

/** Доложить о событии: текст, цена и что стало с отношениями. */
function polReport(a, b, delta, text, detail) {
    var rel = 0
    try { rel = Number(global.TFG_FACTIONS.relation(a, b)) } catch (e) { }
    polAnnounce(text + " §7(" + (delta > 0 ? "+" : "") + Math.round(delta) + ", теперь " +
        (rel > 0 ? "+" : "") + Math.round(rel) + ")")
    polLog(text.replace(/§./g, "") + " " + (delta > 0 ? "+" : "") + delta + (detail ? " | " + detail : ""))
}

// ─── Розыгрыш событий мира ───────────────────────────────────────────────────

function polPeaceful() {
    return global.TFG_FACTIONS.list.filter(f => f.id !== "bandits").map(f => f.id)
}

/**
 * Разгон: пара выбирается тем чаще, чем сильнее её отношения по модулю,
 * а знак события следует знаку отношений - вражда растит вражду, дружба растит дружбу.
 */
function polRollEvent() {
    var ids = polPeaceful()
    var pairs = []
    for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
            var rel = Number(global.TFG_FACTIONS.relation(ids[i], ids[j]))
            pairs.push({ a: ids[i], b: ids[j], rel: rel, w: 1 + Math.abs(rel) / 25 })
        }
    }
    // иногда вместо разборок между фракциями - дело против разбойников
    if (Math.random() < 0.25) return polBanditEvent(polPick(ids))
    var total = pairs.reduce((s, p) => s + p.w, 0)
    var roll = Math.random() * total
    var pair = pairs[0]
    for (var k = 0; k < pairs.length; k++) { roll -= pairs[k].w; if (roll <= 0) { pair = pairs[k]; break } }
    // вероятность зла растёт с враждой: при -100 почти всегда зло, при +100 почти всегда добро
    var badChance = 0.5 - pair.rel / 250
    var bad = Math.random() < badChance
    var ev = polPick(bad ? POL_BAD : POL_GOOD)
    var base = POL_PRICE[ev.k]
    var delta = base * (0.7 + Math.random() * 0.6)
    var text = ev.text.replace("{a}", polName(pair.a)).replace("{b}", polName(pair.b))
    try { global.TFG_FACTIONS.event(pair.a, pair.b, delta, ev.k) } catch (e) { polLog("сдвиг не прошёл: " + e) }
    polReport(pair.a, pair.b, delta, text)
    return true
}

function polBanditEvent(factionId) {
    var line = polPick(POL_BANDIT).replace("{a}", polName(factionId))
    var strength = 0.6 + Math.random() * 0.8
    var text = ""
    try { text = String(global.TFG_FACTIONS.banditClash(strength, "стычка с разбойниками")) } catch (e) { }
    polAnnounce(line + " §7(общий враг сближает всех)")
    polLog(line.replace(/§./g, "") + " | " + text)
    return true
}

// ─── Поступки игрока по тем же ценам ─────────────────────────────────────────

/**
 * Сделка игрока с фракцией: отношения растут пропорционально обороту (POL_TRADE_PER_REP медяков на +1),
 * но не больше POL_TRADE_DAY_CAP за игровые сутки.
 */
function polTradeTurnover(player, factionId, amount) {
    if (!factionId) return
    if (!POL_SERVER) POL_SERVER = player.getServer()
    var day = 0
    try { day = Number(FAC_Calendars.SERVER.getTotalCalendarDays()) } catch (e) { }
    var pd = POL_SERVER.persistentData
    var key = "tfg_pol_trade_" + String(player.uuid) + "_" + factionId
    var state = { day: day, sum: 0, gained: 0 }
    try { if (pd.contains(key)) state = JSON.parse(String(pd.getString(key))) } catch (e) { }
    if (state.day !== day) state = { day: day, sum: 0, gained: 0 }
    if (state.gained === undefined) state.gained = 0
    var sum = Math.max(0, Number(amount) || 0)
    state.sum += sum
    var gain = Math.min(sum / POL_TRADE_PER_REP, POL_TRADE_DAY_CAP - state.gained)
    if (gain > 0.001) {
        state.gained += gain
        try { global.TFG_FACTIONS.addRep(player, factionId, gain, "сделка на " + Math.round(sum)) } catch (e) { }
        try { player.tell(Text.of("§7Отношения с " + polName(factionId) + ": +" + gain.toFixed(1) +
            (state.gained >= POL_TRADE_DAY_CAP ? " (на сегодня торговлей больше не поднять)" : ""))) } catch (e) { }
    }
    pd.putString(key, JSON.stringify(state))
}

/** Поступок игрока: цена та же, что у события мира. */
function polPlayerDeed(player, factionId, kind, detail) {
    var price = POL_PRICE[kind]
    if (price === undefined) return
    try { global.TFG_FACTIONS.addRep(player, factionId, price, detail || kind) } catch (e) { }
    if (kind === "raid" || kind === "kill" || kind === "ambush") {
        // нападение на чужих людей видят все: разбойникам это только в радость
        try { global.TFG_FACTIONS.banditClash(-0.5, "чужие дерутся между собой") } catch (e) { }
    }
    polAnnounce("§f" + player.username + ": " + (detail || kind) + " §7(" + (price > 0 ? "+" : "") + price +
        " к отношению с " + polName(factionId) + ")")
}

global.TFG_POLITICS = {
    price: POL_PRICE,
    deed: (player, factionId, kind, detail) => polPlayerDeed(player, factionId, kind, detail),
    turnover: (player, factionId, amount) => polTradeTurnover(player, factionId, amount),
    roll: () => polRollEvent(),
    announce: text => polAnnounce(text),
}

// ─── Смерти: убийство человека фракции и стычки с разбойниками ───────────────

function polFactionTagOf(e) {
    var found = null
    try {
        e.getTags().forEach(t => {
            var s = String(t)
            if (s.indexOf("tfg_faction:") === 0) found = s.substring(12)
        })
    } catch (err) { }
    return found
}

EntityEvents.death(event => {
    try {
        var e = event.entity
        if (!e || !e.getTags) return
        var tags = e.getTags()
        var player = event.source ? event.source.player : null
        var faction = polFactionTagOf(e)
        if (!faction) return
        if (faction === "bandits") {
            // разбойника убили - общий враг сближает остальных
            try { global.TFG_FACTIONS.banditClash(0.4, "разбойник убит") } catch (err) { }
            return
        }
        if (!player) return
        if (!tags.contains("tfg_guest") && !tags.contains("tfg_trader") && !tags.contains("tfg_npc")) return
        polPlayerDeed(player, faction, "kill", "убийство человека фракции")
    } catch (err) {
        polLog("смерть: " + err)
    }
})

// ─── Тик: события мира по игровому времени ───────────────────────────────────

ServerEvents.tick(event => {
    if (!POL_SERVER) POL_SERVER = event.server
    if (event.server.tickCount % 200 !== 0) return
    try {
        var now = Number(event.server.overworld().getTime())
        var pd = event.server.persistentData
        if (!pd.contains("tfg_pol_next")) { pd.putLong("tfg_pol_next", now + POL_EVENT_TICKS); return }
        if (now < Number(pd.getLong("tfg_pol_next"))) return
        pd.putLong("tfg_pol_next", now + POL_EVENT_TICKS)
        if (Math.random() > POL_EVENT_CHANCE) return
        polRollEvent()
    } catch (e) {
        polLog("событие мира: " + e)
    }
})

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgpolitics")
            .requires(s => s.hasPermission(2))
            .executes(ctx => {
                if (!POL_SERVER) POL_SERVER = ctx.source.getServer()
                polRollEvent()
                return 1
            })
            .then(Commands.literal("roll").then(Commands.argument("count", Arguments.INTEGER.create(event)).executes(ctx => {
                if (!POL_SERVER) POL_SERVER = ctx.source.getServer()
                var n = Math.max(1, Math.min(200, Number(Arguments.INTEGER.getResult(ctx, "count"))))
                for (var i = 0; i < n; i++) polRollEvent()
                ctx.source.sendSuccess(Text.of("Разыграно событий: " + n), false)
                return 1
            })))
            .then(Commands.literal("prices").executes(ctx => {
                var rows = []
                for (var k in POL_PRICE) rows.push(k + ": " + (POL_PRICE[k] > 0 ? "+" : "") + POL_PRICE[k])
                ctx.source.sendSuccess(Text.of(rows.join("\n")), false)
                return 1
            })))
    } catch (err) {
        console.error("[politics] ошибка регистрации команд: " + err)
    }
})
