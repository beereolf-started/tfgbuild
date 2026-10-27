"use strict";
/**
 * Разговор с торговцем: отдельное окно в чате с выбором вариантов (не инвентарь).
 *
 * Правый клик по торговцу открывает разговор: приветствие с учётом памяти о игроке и список вариантов.
 * Варианты кликабельные (tellraw с run_command), выбор шлёт /tfgdlg <номер> - номера живут в сессии игрока.
 * "Торговать" есть всегда, услуги открываются по репутации и выполняются в factions/services.js.
 */

var DLG_SERVER = null
const DLG_TTL = 3600                // сколько тиков живёт открытый разговор
const DLG_RANGE = 6                 // дальше этого торговец разговор прерывает

const DLG_SESS = {}                 // uuid игрока -> сессия разговора

function dlgLog(text) { try { console.log("[разговор] " + text) } catch (e) { } }

function dlgNow(player) { try { return Number(player.level.getTime()) } catch (e) { return 0 } }

function dlgFaction(id) { return global.TFG_FACTIONS.list.filter(f => f.id === id)[0] || null }

function dlgRep(player, factionId) {
    try { return Number(global.TFG_FACTIONS.rep(player, factionId)) || 0 } catch (e) { return 0 }
}

function dlgTier(player) {
    try { return Math.max(1, Math.min(10, Number(global.TFG_PLAYER_TIER(player)) || 1)) } catch (e) { return 1 }
}

/** Цвет фракции для tellraw (имена цветов ванильные). */
function dlgColor(faction) {
    var map = { black: "dark_gray", blue: "blue", yellow: "yellow", red: "red", white: "white" }
    return faction && map[faction.dye] ? map[faction.dye] : "white"
}

function dlgTell(player, json) {
    var s = DLG_SESS[String(player.uuid)]
    if (s && s.ui) return dlgUiTell(player, s, json)
    if (!DLG_SERVER) DLG_SERVER = player.getServer()
    DLG_SERVER.runCommandSilent("tellraw " + player.username + " " + JSON.stringify(json))
}

function dlgRule(player) {
    var s = DLG_SESS[String(player.uuid)]
    if (s && s.ui) return
    dlgTell(player, { text: "─────────────────────────────", color: "dark_gray" })
}

// ─── Окно разговора в моде tfgui (factions/ui_bridge.js) ─────────────────────
//
// Если мод стоит у игрока, разговор идёт в окне: реплики - субтитрами, варианты - кнопками.
// Всё остальное прежнее: те же варианты (DLG_OPTIONS), те же проверки и действия. Строки,
// которые раньше уходили в чат (dlgTell), превращаются здесь в реплики или в варианты
// подменю: кликабельная строка с /tfgdlgsub N становится вариантом "s:N".

function dlgUiText(json) {
    var parts = Array.isArray(json) ? json : [json]
    var text = "", sub = null, hint = null
    parts.forEach(p => {
        if (!p) return
        text += String(p.text || "")
        var ce = p.clickEvent
        if (ce && ce.action === "run_command") {
            var m = String(ce.value).match(/^\/tfgdlgsub (\d+)$/)
            if (m) sub = Number(m[1])
        }
        var he = p.hoverEvent
        if (he && typeof he.contents === "string") hint = he.contents
        else if (ce && ce.action === "suggest_command") hint = "Команда: " + ce.value
    })
    return { text: text.replace(/^\s*[▸✖]\s*/, "").trim(), sub: sub, hint: hint }
}

function dlgUiTell(player, s, json) {
    var t = dlgUiText(json)
    if (!t.text || /^─+$/.test(t.text)) return
    if (t.sub !== null) {
        if (!s.uiGotMenu) { s.uiMenu = []; s.uiLabels = {} }
        s.uiGotMenu = true
        s.uiSub = true
        var id = "s:" + t.sub
        s.uiMenu.push({ id: id, label: t.text, hint: t.hint })
        s.uiLabels[id] = t.text
        return global.TFG_UI.update(player, { options: s.uiMenu })
    }
    global.TFG_UI.update(player, { lines: [{ who: "note", text: t.text + (t.hint ? " - " + t.hint : "") }] })
}

/** Варианты разговора в окне: те же, что в чате, с теми же проверками. */
function dlgUiRender(player, s, greeting) {
    var ctx = dlgCtx(player, s)
    var faction = dlgFaction(s.faction)
    var kind = null
    if (!s.merc) { try { kind = global.TFG_TRADE_GOODS.kind(s.kind) } catch (e) { } }
    var name = ""
    try { name = String(global.TFG_NPC.nameOf(s.trader) || "") } catch (e) { }
    s.opts = []
    s.uiLabels = {}
    var opts = []
    var options = dlgOptionsOf(s)
    options.forEach(o => {
        if (o.show && !o.show(ctx)) return
        var enabled = o.rep === undefined || ctx.rep >= o.rep
        var why = enabled ? null : "Нужно отношение " + o.rep + ", у вас " + Math.round(ctx.rep) + "."
        if (enabled && o.avail) {
            var check = o.avail(ctx)
            if (check !== true) { enabled = false; why = String(check) }
        }
        s.opts.push(o.id)
        var id = "o:" + s.opts.length
        var label = String(o.label(ctx))
        s.uiLabels[id] = label
        opts.push({ id: id, label: label, hint: o.hint ? String(o.hint(ctx)) : null, enabled: enabled, why: why })
    })
    s.uiMenu = opts
    s.uiSub = false
    var data = {
        name: name || (s.npc ? s.npc.name : s.merc ? "Старший отряда" : "Торговец"),
        subtitle: (s.npc ? s.npc.word : s.merc ? "Старший отряда" : kind ? kind.name : "") + dlgSpecOf(s) + (faction ? " · " + faction.name : ""),
        // фракция и сам житель (bonds.js): «фракция 35 · лично 42, приятель»
        rep: typeof bdRepLine === "function" ? bdRepLine(ctx) : "отношение " + Math.round(ctx.rep),
        color: dlgUiColor(faction),
        options: opts,
    }
    if (greeting) data.lines = [{ who: "npc", text: String(greeting) }]
    if (!s.uiOpened) {
        s.uiOpened = true
        data.type = "dialogue"
        global.TFG_UI.open(player, data)
    } else {
        global.TFG_UI.update(player, data)
    }
}

/** Специализация торговца (trader.js, trSpec) для подзаголовка: " (мягкие металлы)" или "". */
function dlgSpecOf(s) {
    try {
        var spec = String(s.trader.persistentData.getString("tfg_trader_spec") || "")
        return spec ? " (" + spec + ")" : ""
    } catch (e) { return "" }
}

function dlgUiColor(faction) {
    try { if (faction && typeof trColor === "function") return Number(trColor(faction).hex) || 0 } catch (e) { }
    return 0
}

// ─── Память: чем торговец встречает игрока ───────────────────────────────────

/** Есть ли рядом с торговцем летающий транспорт игрока. */
function dlgAircraftNear(trader) {
    try {
        var list = trader.level.getEntities(trader, new RAID_AABBClass(trader.getX() - 40, trader.getY() - 20, trader.getZ() - 40,
            trader.getX() + 40, trader.getY() + 30, trader.getZ() + 40))
        for (var i = 0; i < list.size(); i++) {
            if (String(list.get(i).type).indexOf("immersive_aircraft:") === 0) return true
        }
    } catch (e) { }
    return false
}

/** Приветствие: первое знакомство, возвращение, память о делах и о технике игрока. */
function dlgGreeting(person, player, trader, factionId) {
    var rep = dlgRep(player, factionId)
    if (!person) return rep < 0 ? "Чего тебе?" : "Слушаю."
    var mem = null
    try { mem = global.TFG_NPC.memOf(person, player) } catch (e) { }
    var gap = -1
    try { gap = global.TFG_NPC.noteMeeting(person, player) } catch (e) { }
    var lines = []
    if (!mem || mem.met <= 1) {
        lines.push(rep < -20 ? "Про вас тут рассказывают нехорошее. Говори коротко."
            : "Не встречались. Меня зовут " + person.name.split(" ")[0] + ".")
    } else if (gap >= 0 && gap < 12) {
        lines.push("Опять ты. Недолго же я отдыхал.")
    } else if (gap >= 120) {
        lines.push("Столько времени прошло, я думал, ты уже в земле.")
    } else {
        lines.push("Снова ты, " + (mem.name || player.username) + ".")
    }
    // техника у базы: заметил в прошлый раз или видит впервые
    var air = dlgAircraftNear(trader)
    var knewAir = mem && mem.events && mem.events.some(ev => ev.k === "aircraft")
    if (air && !knewAir) {
        lines.push("Это твоя машина стоит? Раньше её тут не было.")
        try { global.TFG_NPC.remember(person, player, "aircraft", "у игрока свой летающий аппарат") } catch (e) { }
    } else if (air && knewAir && Math.random() < 0.5) {
        lines.push("Дирижабль всё ещё на ходу? Хорошая машина.")
    } else if (!air && knewAir && Math.random() < 0.4) {
        lines.push("А где твой аппарат? Продал или разбил?")
    }
    if (mem && mem.events && mem.events.length && Math.random() < 0.6) {
        var ev = mem.events[Math.floor(Math.random() * mem.events.length)]
        if (ev.k === "bigdeal") lines.push("Про нашу сделку до сих пор вспоминаю: " + ev.t + ".")
        else if (ev.k !== "aircraft") lines.push(ev.t.charAt(0).toUpperCase() + ev.t.substring(1) + ".")
    }
    if (mem && mem.deals >= 5 && Math.random() < 0.4) lines.push("С тобой торговать не в тягость.")
    // откуда пришёл гость (молва, lore.js): при знакомстве называет дом, потом изредка
    var home = ""
    try { home = String(trader.persistentData.getString("tfg_origin_name") || "") } catch (e) { }
    if (home && (!mem || mem.met <= 1 || Math.random() < 0.15)) {
        lines.push(gsPick(["Мы из «" + home + "».", "Идём из «" + home + "».", "Сами мы из «" + home + "», это недалеко."]))
    }
    return lines.join(" ")
}

// ─── Список вариантов ────────────────────────────────────────────────────────

/**
 * Описание услуги: label(ctx) - текст, rep - нужная репутация, avail(ctx) - доступна ли,
 * hint(ctx) - подсказка при наведении, run(ctx) - что делать по клику.
 */
const DLG_OPTIONS = [
    {
        id: "trade",
        label: () => "Торговать",
        rep: -1000,
        hint: () => "Открыть окно сделки.",
        run: ctx => {
            dlgClose(ctx.player)
            try { global.TFG_TRADE_MENU.open(ctx.player, ctx.trader) } catch (e) { ctx.player.tell(Text.of("§cОкно сделки не открылось: " + e)) }
        },
    },
    {
        id: "summon",
        label: () => "Пригласить торговца",
        rep: 10,
        hint: () => "Сообщить своим, кого прислать. Придёт через несколько дней.",
        run: ctx => dlgKindMenu(ctx),
    },
    {
        id: "guards",
        label: ctx => "Нанять охрану (" + svcGuardPrice(ctx.player) + " " + global.TFG_COINS.unit + ")",
        rep: 45,
        // только у походных и прилетающих торговцев: у торговца в чужом поселении охраны нет
        show: ctx => !dlgSettlementTrader(ctx) && !dlgSoloTrader(ctx),
        hint: ctx => "Отряд бойцов фракции служит неделю: сутки обживается, дальше патрулирует базу.\n" +
            "Цена по вашему уровню: " + svcGuardPrice(ctx.player) + " " + global.TFG_COINS.unit + ".",
        avail: ctx => svcGuardsAvailable(ctx),
        run: ctx => svcHireGuards(ctx),
    },
    {
        id: "flight",
        label: () => "Перелёт дирижаблем",
        rep: 35,
        show: ctx => !dlgSettlementTrader(ctx) && !dlgSoloTrader(ctx),
        hint: () => "Пилот с охраной отвезёт вас в любую точку и заберёт обратно.\nЦена по расстоянию.",
        avail: ctx => svcFlightAvailable(ctx),
        run: ctx => svcFlightMenu(ctx),
    },
    {
        id: "talk",
        label: () => "Поговорить",
        rep: -50,
        hint: () => "Слухи, дороги, чужие фракции.",
        run: ctx => dlgTalk(ctx),
    },
    {
        id: "news",
        label: () => "Что слышно в округе?",
        rep: -50,
        hint: () => "Вести из поселений округи за последний месяц.\nСвежие доходят дня через два, дальние - не все.",
        run: ctx => dlgNews(ctx),
    },
    {
        // гости в поселении игрока: выгнать - уедут сразу, но отношения с фракцией -10
        id: "expel",
        label: () => "Выгнать",
        rep: -1000,
        hint: () => "Гости тут же соберутся и уйдут.\nОтношения с их фракцией упадут на 10.",
        avail: ctx => !!dlgGuestVisit(ctx),
        run: ctx => {
            var v = dlgGuestVisit(ctx)
            if (!v) { dlgClose(ctx.player); return }
            try { global.TFG_FACTIONS.addRep(ctx.player, v.faction, -10, "выгнал гостей") } catch (e) { dlgLog("репутация: " + e) }
            dlgSay(ctx, gsPick(["Вот, значит, как. Запомним.", "Не больно-то и хотелось. Уходим.",
                "Гостеприимство у вас... Собирайтесь, ребята.", "Ладно. Но больше нас не жди."]))
            v.until = gsNow(gsLevel(v))
            gsSave()
            dlgClose(ctx.player)
        },
    },
    {
        id: "leave",
        label: () => "Разойтись",
        rep: -1000,
        hint: () => "Закончить разговор.",
        run: ctx => {
            dlgSay(ctx, gsPick(["Ступай.", "Бывай.", "Дороги ровной.", "Ещё увидимся."]))
            dlgClose(ctx.player)
        },
    },
]

/** Визит гостей (factions/guests.js), к которому относится собеседник, - только у игрока, не налёт. */
function dlgGuestVisit(ctx) {
    try {
        var id = String(ctx.trader.persistentData.getString("tfg_guest_visit") || "")
        if (!id) return null
        var v = gsLoad()[id]
        if (!v || v.raid || v.settlement || v.phase === "board" || v.phase === "depart") return null
        return v
    } catch (e) { return null }
}

/** Торговец поселения NPC (житель или гость, пришедший на торг в поселение) - не походный. */
function dlgSettlementTrader(ctx) {
    try {
        if (ctx.trader.getTags().contains("tfg_settler")) return true
        var id = String(ctx.trader.persistentData.getString("tfg_guest_visit") || "")
        var v = id ? gsLoad()[id] : null
        return !!(v && v.settlement)
    } catch (e) { return false }
}

/** Одиночка (охотник, лесоруб, шахтёр, камнелом - guests.js): ни охраны, ни борта у него не попросишь. */
function dlgSoloTrader(ctx) {
    try {
        var id = String(ctx.trader.persistentData.getString("tfg_guest_visit") || "")
        var v = id ? gsLoad()[id] : null
        return !!(v && v.solo)
    } catch (e) { return false }
}

function dlgOptionsOf(s) { return s.merc ? DLG_SQUAD_OPTIONS : s.npc ? DLG_NPC_OPTIONS : DLG_OPTIONS }

/** Подменю выбора: items - [{ label, hint, run(ctx) }]. В чате - строками, в окне мода - кнопками. */
function dlgChoice(ctx, prompt, items) {
    var s = ctx.sess
    if (prompt) dlgSay(ctx, prompt)
    dlgRule(ctx.player)
    s.menu = { type: "pick", items: items }
    items.forEach((it, i) => {
        dlgTell(ctx.player, [{ text: "  ▸ ", color: "gold" },
            { text: it.label, color: "yellow", underlined: true,
                clickEvent: { action: "run_command", value: "/tfgdlgsub " + (i + 1) },
                hoverEvent: { action: "show_text", contents: it.hint || it.label } }])
    })
    dlgTell(ctx.player, [{ text: "  ▸ ", color: "gold" },
        { text: "Передумал", color: "gray", underlined: true, clickEvent: { action: "run_command", value: "/tfgdlgsub 0" } }])
    dlgRule(ctx.player)
}

const DLG_DAYS = [{ d: 0, t: "Сегодня" }, { d: 1, t: "Завтра" }, { d: 2, t: "Через два дня" }, { d: 3, t: "Через три дня" }, { d: 5, t: "Через пять дней" }]

// Жители и стража: поговорить можно с каждым, кто не враждебен. Бард - песня на заказ,
// правитель - перелёт, охрана для вашей базы и приглашение торговца.
const DLG_NPC_OPTIONS = [
    { id: "talk", label: () => "Поговорить", hint: () => "Слухи, дороги, чужие фракции.", run: ctx => dlgTalk(ctx) },
    { id: "news", label: () => "Что слышно в округе?", hint: () => "Вести из поселений округи.", run: ctx => dlgNews(ctx) },
    {
        id: "song",
        label: () => "Заказать песню (" + DLG_SONG_PRICE + " " + global.TFG_COINS.unit + ")",
        hint: () => "Бард сразу сыграет ту песню, что вы назовёте.",
        show: ctx => ctx.sess.npc.role === "бард",
        avail: ctx => {
            try { if (global.TFG_SETTLERS.bardBusy(ctx.trader)) return "Он сейчас играет - дождитесь конца песни." } catch (e) { }
            return true
        },
        run: ctx => dlgSongMenu(ctx),
    },
    {
        id: "ruler_flight",
        label: () => "Попросить перелёт",
        rep: 20,
        hint: () => "Борт поселения отвезёт вас в любую точку и заберёт обратно.\nМожно выбрать день вылета.",
        show: ctx => ctx.sess.npc.role === "правитель",
        avail: ctx => svcFlightOf(ctx.player) ? "Ваш рейс уже в работе." : true,
        run: ctx => dlgChoice(ctx, "Когда выслать борт?", DLG_DAYS.map(o => ({
            label: o.t, run: c => { dlgSay(c, gsPick(DLG_ASK_MASTER_RULER)); svcFlightMenu(c, o.d) },
        }))),
    },
    {
        id: "ruler_guards",
        label: () => "Попросить охрану для своей базы",
        rep: 30,
        hint: () => "Отряд поселения придёт в назначенный день и неделю будет стеречь вашу базу.\nПлатить - старшему, когда придут.",
        show: ctx => ctx.sess.npc.role === "правитель",
        avail: ctx => svcMercOf(ctx.player) || svcGuardsPlanned(ctx.player) ? "Отряд у вас уже есть или уже в пути." : true,
        run: ctx => dlgRulerGuards(ctx),
    },
    {
        id: "summon",
        label: () => "Пригласить торговца",
        rep: 10,
        hint: () => "Поселение пришлёт к вам торговца нужного ремесла.",
        show: ctx => ctx.sess.npc.role === "правитель",
        run: ctx => dlgKindMenu(ctx),
    },
    {
        id: "leave", label: () => "Разойтись", hint: () => "Закончить разговор.",
        run: ctx => { dlgSay(ctx, gsPick(["Ступай.", "Бывай.", "Ну, ступай с миром.", "Ещё увидимся."])); dlgClose(ctx.player) },
    },
]

const DLG_SONG_PRICE = 5
// когда торговец или правитель берётся устроить наём или перелёт
const DLG_ASK_MASTER = ["Хорошо. Я спрошу помощи у моего господина, жди.", "Ладно, пошлю весточку хозяину. Жди ответа.",
    "Добро. Передам наверх - там решат.", "Спрошу у своих. Обожди немного, ответ будет."]
const DLG_ASK_MASTER_RULER = ["Хорошо. Распоряжусь.", "Будет тебе борт. Скажи только, куда.", "Пошлю людей. Жди."]

/** Песня на заказ: выбор мелодии, плата, бард играет сразу. */
function dlgSongMenu(ctx) {
    var list = []
    try { list = SO_MELODIES.slice() } catch (e) { }
    if (!list.length) { dlgSay(ctx, "Инструмент расстроен, не обессудь."); return }
    dlgChoice(ctx, gsPick(["Что сыграть?", "Какую хочешь?", "Назови - сыграю."]), list.map(m => ({
        label: DLG_MELODY_RU[m] || m.replace(/_/g, " "),
        run: c => {
            if (!global.TFG_COINS.pay(c.player, DLG_SONG_PRICE)) { dlgSay(c, "Песня стоит " + DLG_SONG_PRICE + " " + global.TFG_COINS.unit + "."); return }
            var ok = false
            try { ok = global.TFG_SETTLERS.playSong(c.trader, m, c.player) } catch (e) { dlgLog("песня: " + e) }
            dlgSay(c, ok ? gsPick(["Слушай!", "Эх, для хорошего человека!", "Ну, держись!"]) : "Не выходит сейчас, извини.")
            dlgClose(c.player)
        },
    })))
}

const DLG_MELODY_RU = {
    drunken_sailor: "Пьяный матрос", cooleys: "Кулей", gallopede: "Галоп", clog_waltz: "Вальс в деревянных башмаках",
    hopser_walzer: "Хопсер-вальс", allewander: "Странник", ievan_polka: "Иванова полька", the_bard_s_song: "Песнь барда",
    saria_s_song: "Песня Сарии", windmill: "Ветряная мельница", castle: "Замок", mondscheinsonate: "Лунная соната",
    wet_hands: "Мокрые руки", skyrim: "Северная сага", harry_potter: "Волшебная школа", mountain_king: "В пещере горного короля",
    monkey_island: "Остров обезьян", le_colosse: "Колосс", les_180_pucelles: "Сто восемьдесят дев",
    chinder_vo_jaun: "Дети из долины", branda_schottisch: "Бранда-шоттиш", elise_polka: "Полька Элизы",
}

/** Охрана от правителя: день, сколько бойцов, какой выучки. */
function dlgRulerGuards(ctx) {
    var tier = svcTier(ctx.player)
    dlgChoice(ctx, "Когда прислать людей?", DLG_DAYS.map(o => ({
        label: o.t,
        run: c1 => dlgChoice(c1, "Сколько бойцов?", [3, 5, 8].map(n => ({
            label: n + " бойцов",
            run: c2 => dlgChoice(c2, "Каких?", [
                { k: "ополчение", t: Math.max(1, tier - 1) }, { k: "дружина", t: tier }, { k: "гвардия", t: Math.min(10, tier + 2) },
            ].map(p => ({
                label: p.k.charAt(0).toUpperCase() + p.k.substring(1) + " - " + svcGuardPriceFor(p.t, n) + " " + global.TFG_COINS.unit + " за неделю",
                run: c3 => {
                    dlgSay(c3, gsPick(DLG_ASK_MASTER_RULER))
                    svcPlanGuards(c3.player, c3.faction, p.t, n, o.d)
                    dlgSay(c3, (o.d ? "Придут " + o.t.toLowerCase() + ". " : "Выступят сегодня же. ") +
                        "Платить будешь старшему, когда придут: " + svcGuardPriceFor(p.t, n) + " " + global.TFG_COINS.unit + " за неделю.")
                },
            }))),
        }))),
    })))
}

/** Разговор с жителем поселения или стражем гостей. */
function dlgOpenNpc(player, e) {
    if (!DLG_SERVER) DLG_SERVER = player.getServer()
    var tags = e.getTags()
    var faction = "", role = "страж", name = "", word = "Страж"
    try {
        var tl = tags.toArray()
        for (var i = 0; i < tl.length; i++) {
            var tg = String(tl[i])
            if (tg.indexOf("tfg_faction_") === 0) faction = tg.substring(12)
            else if (tg.indexOf("tfg_faction:") === 0) faction = tg.substring(12)
        }
    } catch (err) { }
    if (tags.contains("tfg_settler")) {
        try { role = seRoleOf(e) } catch (err) { role = "крестьянин" }
    }
    try {
        var full = String(e.getCustomName().getString())
        var parts = full.split(" · ")
        if (parts.length >= 2) { name = parts[0]; word = parts[1] } else word = full
    } catch (err) { }
    var s = {
        trader: e, faction: faction || "ash", kind: null, tier: 1, person: null,
        npc: { role: role, name: name || word, word: word }, until: dlgNow(player) + DLG_TTL, opts: [], menu: null,
    }
    DLG_SESS[String(player.uuid)] = s
    s.ui = global.TFG_UI.has(player)
    try { global.TFG_NPC_HOLD.hold(e, player, DLG_TTL, "dialogue") } catch (err) { dlgLog("удержание: " + err) }
    var rep = dlgRep(player, s.faction)
    var pool = role === "правитель" ? ["Говори, я слушаю.", "С чем пришёл?", "Слушаю тебя, путник."]
        : role === "бард" ? ["Песню? Можно и песню.", "Слушатель! Это хорошо.", "Чего желаешь, друг?"]
        : role === "страж" || role === "рыцарь" || role === "стрелок" || role === "дружинник" ? ["Проходи, не задерживай.", "Чего надо?", "Говори, только быстро."]
        : ["Здравствуй.", "Чего тебе?", "Слушаю.", "А, путник. Здравствуй."]
    if (rep < -20) pool = ["Чего тебе?", "Говори и уходи."]
    dlgRender(player, s, gsPick(pool))
}

/** Варианты разговора со старшим наёмного отряда. */
const DLG_SQUAD_OPTIONS = [
    {
        id: "pay",
        label: ctx => "Заплатить " + svcGuardPrice(ctx.player) + " " + global.TFG_COINS.unit + " за неделю",
        avail: ctx => {
            if (ctx.merc.paid) return "Нам уже уплачено."
            if (String(ctx.player.uuid) !== ctx.merc.employer) return "Мы пришли не к вам."
            var price = svcGuardPrice(ctx.player)
            var have = 0
            try { have = Number(global.TFG_COINS.verifiedTotal(ctx.player)) || 0 } catch (e) { }
            return have >= price ? true : "Не хватает " + (price - have) + " " + global.TFG_COINS.unit + "."
        },
        hint: ctx => "Отряд сразу встаёт в караул вокруг базы и служит семь дней.",
        run: ctx => {
            var res = svcPaySquad(ctx.player, ctx.merc)
            if (res !== true) { dlgSay(ctx, String(res)); return }
            dlgSay(ctx, gsPick(["Уговор. Люди, по местам!", "Принято. С этой минуты мы на службе.",
                "Считано верно. Будем держать периметр."]))
            dlgClose(ctx.player)
        },
    },
    {
        id: "squad_status",
        label: () => "Как дела у отряда",
        hint: () => "Сколько бойцов и сколько осталось служить.",
        run: ctx => {
            var now = dlgNow(ctx.player)
            var left = Math.max(0, Math.round((ctx.merc.until - now) / 24000 * 10) / 10)
            dlgSay(ctx, ctx.merc.paid
                ? "Нас " + ctx.merc.guards.length + ". Служим ещё " + left + " сут., потом уходим."
                : "Нас " + ctx.merc.guards.length + ". Стоим без дела: уговора нет. Ждать будем ещё " + left + " сут.")
        },
    },
    {
        id: "squad_leave",
        label: () => "Разойтись",
        hint: () => "Закончить разговор.",
        run: ctx => {
            dlgSay(ctx, gsPick(["Ага.", "Как скажешь.", "Мы тут."]))
            dlgClose(ctx.player)
        },
    },
]

function dlgCtx(player, s) {
    return {
        player: player, trader: s.trader, faction: s.faction, kind: s.kind, tier: s.tier,
        person: s.person ? global.TFG_NPC.person(s.person) : null, sess: s, rep: dlgRep(player, s.faction),
        merc: s.merc ? dlgMercById(s.merc) : null,
    }
}

/** Запись наёмного отряда по её номеру (после /reload объект визита создаётся заново). */
function dlgMercById(id) {
    try { return gsLoad()[String(id)] || null } catch (e) { return null }
}

/** Реплика торговца в чат игроку (и над головой, если он рядом). */
/** Голос собеседника (guests.js): звучит, если реплика озвучена; нет - пишется в список недостающих. */
var DLG_VOICE_UNTIL = {}             // uuid собеседника -> тик сервера, когда он договорит

/**
 * Голос реплики. Реплики одного ответа идут очередью: следующая звучит, когда договорена прежняя
 * (длина записи - TFG_VOICE_LEN из voice_index.js), иначе две-три реплики звучали разом.
 */
function dlgVoice(e, text) {
    try {
        if (!e || !text || typeof gsPlayVoice !== "function") return
        var t = String(text)
        var len = 0
        try { var key = gsVoiceKeyOf(gsVoiceText(t)); len = key && global.TFG_VOICE_LEN ? Number(global.TFG_VOICE_LEN[key]) || 0 : 0 } catch (err2) { }
        if (!len) return                                 // записи нет - и ждать нечего
        var now = Number(GS_SERVER.tickCount)
        var u = String(e.uuid)
        var start = Math.max(now, DLG_VOICE_UNTIL[u] || 0)
        DLG_VOICE_UNTIL[u] = start + len + 6             // небольшая пауза между репликами
        if (start <= now) return gsPlayVoice(e, t)
        GS_SERVER.scheduleInTicks(start - now, () => { try { if (e.isAlive()) gsPlayVoice(e, t) } catch (err3) { } })
    } catch (err) { dlgLog("голос: " + err) }
}

/** Пометка рассказчика в разговоре (имена, кто кому кем приходится): без голоса, курсивом. */
function dlgNote(ctx, text) {
    if (ctx.sess && ctx.sess.ui) return global.TFG_UI.update(ctx.player, { lines: [{ who: "note", text: String(text) }] })
    dlgTell(ctx.player, [{ text: String(text), color: "gray", italic: true }])
}

function dlgSay(ctx, text) {
    dlgVoice(ctx.trader, text)
    if (ctx.sess && ctx.sess.ui) return global.TFG_UI.update(ctx.player, { lines: [{ who: "npc", text: String(text) }] })
    var faction = dlgFaction(ctx.faction)
    var name = ""
    try { name = String(global.TFG_NPC.nameOf(ctx.trader) || "") } catch (e) { }
    dlgTell(ctx.player, [
        { text: (name || "Торговец") + ": ", color: dlgColor(faction), bold: true },
        { text: text, color: "white" },
    ])
}

function dlgOptionJson(n, label, hint, enabled, why) {
    if (!enabled) {
        return [{ text: "  ✖ ", color: "dark_gray" },
            { text: label, color: "dark_gray", strikethrough: false,
                hoverEvent: { action: "show_text", contents: why || "Пока недоступно." } }]
    }
    return [{ text: "  ▸ ", color: "gold" },
        { text: label, color: "yellow", underlined: true,
            clickEvent: { action: "run_command", value: "/tfgdlg " + n },
            hoverEvent: { action: "show_text", contents: hint || label } }]
}

function dlgRender(player, s, greeting) {
    if (greeting) dlgVoice(s.trader, greeting)
    if (s.ui) return dlgUiRender(player, s, greeting)
    var ctx = dlgCtx(player, s)
    var faction = dlgFaction(s.faction)
    var kind = null
    if (!s.merc) { try { kind = global.TFG_TRADE_GOODS.kind(s.kind) } catch (e) { } }
    var name = ""
    try { name = String(global.TFG_NPC.nameOf(s.trader) || "") } catch (e) { }
    dlgRule(player)
    dlgTell(player, [
        { text: name ? name + " " : s.npc ? s.npc.name + " " : "", color: dlgColor(faction), bold: true },
        { text: (s.npc ? "· " + s.npc.word + " " : s.merc ? "· Старший отряда " : kind ? "· " + kind.name + " " : "") + (faction ? "· " + faction.name : ""),
            color: dlgColor(faction) },
        { text: "   отношение " + Math.round(ctx.rep), color: "dark_gray" },
    ])
    if (greeting) dlgTell(player, { text: "«" + greeting + "»", color: "gray", italic: true })
    s.opts = []
    var options = dlgOptionsOf(s)
    options.forEach(o => {
        if (o.show && !o.show(ctx)) return
        var enabled = o.rep === undefined || ctx.rep >= o.rep
        var why = enabled ? null : "Нужно отношение " + o.rep + ", у вас " + Math.round(ctx.rep) + "."
        if (enabled && o.avail) {
            var check = o.avail(ctx)
            if (check !== true) { enabled = false; why = String(check) }
        }
        s.opts.push(o.id)
        var n = s.opts.length
        dlgTell(player, dlgOptionJson(n, String(o.label(ctx)), o.hint ? String(o.hint(ctx)) : null, enabled, why))
    })
    dlgRule(player)
}

function dlgOpen(player, trader) {
    if (!DLG_SERVER) DLG_SERVER = player.getServer()
    var pd = trader.persistentData
    var s = {
        trader: trader, faction: String(pd.getString("tfg_trader_faction")), kind: String(pd.getString("tfg_trader_kind")),
        tier: Number(pd.getInt("tfg_trader_tier")) || 1, person: pd.contains("tfg_npc_id") ? String(pd.getString("tfg_npc_id")) : null,
        until: dlgNow(player) + DLG_TTL, opts: [], menu: null,
    }
    DLG_SESS[String(player.uuid)] = s
    s.ui = global.TFG_UI.has(player)
    try { global.TFG_NPC_HOLD.hold(trader, player, DLG_TTL, "dialogue") } catch (e) { dlgLog("удержание: " + e) }
    var person = s.person ? global.TFG_NPC.person(s.person) : null
    var greeting = dlgGreeting(person, player, trader, s.faction)
    dlgRender(player, s, greeting)
}

function dlgClose(player) {
    var s = DLG_SESS[String(player.uuid)]
    delete DLG_SESS[String(player.uuid)]
    try { global.TFG_NPC_HOLD.releasePlayer(player, "dialogue") } catch (e) { }
    // окно разговора закрываем только его: если поверх уже открыт бартер, он остаётся
    if (s && s.ui) global.TFG_UI.update(player, { close: "dialogue" })
}

/** Разговор со старшим наёмного отряда: оплата и состояние. */
function dlgOpenSquad(player, guard, v) {
    if (!DLG_SERVER) DLG_SERVER = player.getServer()
    var s = {
        trader: guard, faction: v.faction, kind: null, tier: v.tier, person: null, merc: v.id,
        until: dlgNow(player) + DLG_TTL, opts: [], menu: null,
    }
    DLG_SESS[String(player.uuid)] = s
    s.ui = global.TFG_UI.has(player)
    try { global.TFG_NPC_HOLD.hold(guard, player, DLG_TTL, "dialogue") } catch (e) { dlgLog("удержание: " + e) }
    var greeting = v.paid
        ? gsPick(["Служим. Всё спокойно.", "Мы на месте, хозяин.", "Караул стоит."])
        : String(player.uuid) === v.employer
            ? "Нас прислали к тебе. Неделя службы - " + svcGuardPrice(player) + " " + global.TFG_COINS.unit +
              ". Не сговоримся за сутки - уйдём."
            : "Мы наняты не тобой. Иди своей дорогой."
    dlgRender(player, s, greeting)
}

ItemEvents.entityInteracted(event => {
    var target = event.target
    var ok = false
    try {
        ok = target && String(target.type) === "minecraft:husk" && target.getTags().contains("tfg_guest") &&
            String(event.hand) === "MAIN_HAND"
    } catch (e) { }
    if (!ok) return
    var v = null
    try { v = svcMercVisitOf(target) } catch (e) { }
    if (!v) {
        // страж обычных гостей: поговорить можно, если гости не враждебны
        try {
            if (target.getTags().contains("tfg_trader")) return
            var gid = String(target.persistentData.getString("tfg_guest_visit") || "")
            var gv = gid ? gsLoad()[gid] : null
            if (gv && (gv.hostile || gv.raid)) { event.player.tell(Text.of("§7Не до разговоров.")); return }
            if (target.getTarget && target.getTarget()) return
            dlgOpenNpc(event.player, target)
        } catch (err) { dlgLog("разговор со стражем: " + err) }
        return
    }
    try {
        var leader = svcSquadLeader(v)
        if (leader && String(leader.uuid) !== String(target.uuid)) {
            event.player.tell(Text.of("§7Этот боец кивает в сторону старшего отряда."))
        } else {
            dlgOpenSquad(event.player, target, v)
        }
    } catch (err) {
        dlgLog("разговор с отрядом: " + err)
    }
    event.cancel()
})

// ─── Подменю: кого прислать ──────────────────────────────────────────────────

function dlgKindMenu(ctx) {
    var s = ctx.sess
    var wait = svcSummonWait(ctx.player, ctx.faction)
    if (wait > 0) {
        dlgSay(ctx, "Мы уже послали весточку. Подожди ещё " + wait + " дн.")
        return
    }
    var kinds = []
    try { kinds = global.TFG_TRADE_GOODS.kindsFor(ctx.tier) || [] } catch (e) { }
    if (!kinds.length) { try { kinds = global.TFG_TRADE_GOODS.kinds } catch (e) { kinds = [] } }
    dlgRule(ctx.player)
    dlgSay(ctx, "Кого прислать? Дойдёт за несколько дней.")
    s.menu = { type: "kind", list: [] }
    kinds.forEach(k => {
        s.menu.list.push(k.id)
        var n = s.menu.list.length
        dlgTell(ctx.player, [{ text: "  ▸ ", color: "gold" },
            { text: k.name, color: "yellow", underlined: true,
                clickEvent: { action: "run_command", value: "/tfgdlgsub " + n },
                hoverEvent: { action: "show_text", contents: "Позвать: " + k.name } }])
    })
    dlgTell(ctx.player, [{ text: "  ▸ ", color: "gold" },
        { text: "Передумал", color: "gray", underlined: true, clickEvent: { action: "run_command", value: "/tfgdlgsub 0" } }])
    dlgRule(ctx.player)
}

// ─── Разговор ни о чём: слухи и обстановка ───────────────────────────────────

function dlgTalk(ctx) {
    var lines = []
    try {
        var set = SO_RUMORS[ctx.faction] || []
        var band = 1
        try { band = gsToneBand(gsTone({ faction: ctx.faction }, ctx.player)) } catch (e) { }
        if (set.length) lines.push(gsPick(set[Math.min(set.length - 1, band)]))
        if (SO_RUMORS_COMMON.length) lines.push(gsPick(SO_RUMORS_COMMON[Math.min(SO_RUMORS_COMMON.length - 1, band)]))
    } catch (e) { }
    if (!lines.length) lines.push("Дороги пустые, а цены злые. Вот и весь сказ.")
    dlgSay(ctx, gsPick(lines))
    try {
        var person = ctx.person
        if (person) global.TFG_NPC.remember(person, ctx.player, "talk", "мы уже говорили о делах на дорогах")
    } catch (e) { }
}

/** Вести округи: что дошло до этого человека (молва, lore.js). */
function dlgNews(ctx) {
    var said = []
    try {
        var view = global.TFG_LORE.view(ctx.trader)
        global.TFG_LORE.known(ctx.player.level, view.ref, view.who, 3).forEach(k => said.push(global.TFG_LORE.tell(k, view.site)))
    } catch (e) { dlgLog("вести не собрались: " + e) }
    if (!said.length) said.push(gsPick(["Тихо у нас. Ничего такого не слышал.", "Вестей нет - и слава богам.",
        "Кто его знает. Давно никто с новостями не заходил."]))
    said.forEach(t => dlgSay(ctx, t))
}

// ─── Команды выбора ──────────────────────────────────────────────────────────

function dlgSession(player) {
    var s = DLG_SESS[String(player.uuid)]
    if (!s) { player.tell(Text.of("§7Разговор уже закончен.")); return null }
    if (dlgNow(player) > s.until || !s.trader || !s.trader.isAlive()) {
        dlgClose(player)
        player.tell(Text.of("§7Разговор окончен."))
        return null
    }
    var dx = s.trader.getX() - player.getX(), dz = s.trader.getZ() - player.getZ()
    if (dx * dx + dz * dz > DLG_RANGE * DLG_RANGE * 4) {
        dlgClose(player)
        player.tell(Text.of("§7Вы отошли слишком далеко."))
        return null
    }
    return s
}

/** Выбор варианта n (с 1): из чата командой /tfgdlg n или из окна мода. */
function dlgPick(player, n) {
    var s = dlgSession(player)
    if (!s) return
    var id = s.opts[n - 1]
    var opt = dlgOptionsOf(s).filter(o => o.id === id)[0]
    if (!opt) { player.tell(Text.of("§7Такого ответа нет.")); return }
    var ctx = dlgCtx(player, s)
    if (s.merc && !ctx.merc) { dlgClose(player); player.tell(Text.of("§7Отряда больше нет.")); return }
    if (opt.rep !== undefined && ctx.rep < opt.rep) { dlgSay(ctx, "Для такого мы с тобой пока недостаточно знакомы."); return }
    if (opt.avail && opt.avail(ctx) !== true) { dlgSay(ctx, String(opt.avail(ctx))); return }
    try { opt.run(ctx) } catch (err) { dlgLog("вариант " + id + ": " + err); player.tell(Text.of("§cНе вышло: " + err)) }
}

/** Выбор в подменю (0 - назад): /tfgdlgsub n или окно мода. */
function dlgPickSub(player, n) {
    var s = dlgSession(player)
    if (!s || !s.menu) return
    var ctx = dlgCtx(player, s)
    if (n === 0) { s.menu = null; dlgRender(player, s, null); return }
    if (s.menu.type === "pick") {
        var item = s.menu.items[n - 1]
        if (!item) return
        s.menu = null
        try { item.run(ctx) } catch (err) { player.tell(Text.of("§cНе вышло: " + err)) }
        return
    }
    if (s.menu.type === "kind") {
        var kindId = s.menu.list[n - 1]
        if (!kindId) return
        s.menu = null
        try { svcRequestTrader(ctx, kindId) } catch (err) { player.tell(Text.of("§cНе вышло: " + err)) }
    }
}

// действия из окна разговора: id "o:N" - вариант, "s:N" - подменю; команды чата не нужны
global.TFG_UI.on("dialogue", (player, a) => {
    var s = DLG_SESS[String(player.uuid)]
    if (!s || !s.ui) return
    if (a.a === "close") return dlgClose(player)
    if (a.a !== "pick") return
    var m = String(a.id || "").match(/^([os]):(\d+)$/)
    if (!m) return
    var label = s.uiLabels ? s.uiLabels[a.id] : null
    if (label) global.TFG_UI.update(player, { lines: [{ who: "player", text: label }] })
    s.uiGotMenu = false
    if (m[1] === "o") dlgPick(player, Number(m[2]))
    else dlgPickSub(player, Number(m[2]))
    // подменю кончилось ничем - вернуть основные варианты
    if (DLG_SESS[String(player.uuid)] === s && s.uiSub && !s.uiGotMenu) dlgRender(player, s, null)
})

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgdlg")
            .then(Commands.argument("n", Arguments.INTEGER.create(event)).executes(ctxc => {
                dlgPick(ctxc.source.getPlayerOrException(), Number(Arguments.INTEGER.getResult(ctxc, "n")))
                return 1
            })))
        event.register(Commands.literal("tfgdlgsub")
            .then(Commands.argument("n", Arguments.INTEGER.create(event)).executes(ctxc => {
                dlgPickSub(ctxc.source.getPlayerOrException(), Number(Arguments.INTEGER.getResult(ctxc, "n")))
                return 1
            })))

    } catch (err) {
        console.error("[dialogue] ошибка регистрации команд: " + err)
    }
})

// Жители поселений (кроме торговцев - у них свой разговор, trader.js): поговорить с любым,
// если поселение не считает вас врагом и житель не в бою.
ItemEvents.entityInteracted(event => {
    var target = event.target
    var ok = false
    try {
        ok = target && String(target.type) === "minecraft:husk" && target.getTags().contains("tfg_settler") &&
            !target.getTags().contains("tfg_trader") && String(event.hand) === "MAIN_HAND"
    } catch (e) { }
    if (!ok) return
    try {
        if (target.getTarget && target.getTarget()) return
        var vid = "", tl = target.getTags().toArray()
        for (var i = 0; i < tl.length; i++) if (String(tl[i]).indexOf("tfg_v_") === 0) vid = String(tl[i]).substring(6)
        var village = vid ? seLoad().villages[vid] : null
        var t = village && village.threat ? village.threat[String(event.player.uuid)] : null
        if (t && t.hostile) { event.player.tell(Text.of("§7С вами здесь говорить не станут.")); return }
        if (village && village.state !== "мир" && village.state !== "сдалось") { event.player.tell(Text.of("§7Не до разговоров - тревога!")); return }
        dlgOpenNpc(event.player, target)
    } catch (err) { dlgLog("разговор с жителем: " + err) }
})

global.TFG_DIALOGUE = {
    open: (player, trader) => dlgOpen(player, trader),
    say: (ctx, text) => dlgSay(ctx, text),
    close: player => dlgClose(player),
    render: (player, s) => dlgRender(player, s, null),
}
