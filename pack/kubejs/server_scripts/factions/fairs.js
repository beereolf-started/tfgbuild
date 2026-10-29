"use strict";
/**
 * ТОРГИ В ПОСЕЛЕНИЯХ (этап 4.2): чужие и свои караваны приходят в поселения по тем же
 * правилам, что и к игрокам, - раз в неделю случайный день и час, с шансом GS_WEEKLY_CHANCE.
 * Фракции, с которыми у хозяев вражда (ниже GS_HOSTILE_RELATION), торговать не приходят -
 * это забота осад (factions/sieges.js).
 *
 * Игрок рядом - визит настоящий (factions/guests.js, с пометкой v.settlement):
 *   1. сбор: правитель, двое местных торговцев, гость и его телохранитель сходятся во двор форта;
 *   2. торг: 12-16 реплик над головами - приветствие по отношениям фракций, похвала товару,
 *      торг о цене настоящего товара гостя, нужды поселения или дипломатия;
 *   3. концерт: бард играет 4-5 вещей на разных инструментах, все слушают;
 *   4. свободное время - и караван улетает.
 * Гости-враги игрока ругаются, но на чужой земле первыми не нападают (бой - только если ударить).
 * Игрока нет - исход торга сразу ложится в летопись поселения.
 */

const FR_NEAR = 256                  // игрок ближе - торг настоящий
const FR_GATHER_MAX = 1200           // минута на сбор, отставших переносим
const FR_LINE_TICKS = 90             // реплика висит над головой столько, плюс по тику на букву
const FR_TUNE_TICKS = 600            // одна вещь барда - полминуты
const FR_TUNE_PAUSE = 100            // и пять секунд между вещами
const FR_AFTER = 2400                // после концерта гости две минуты свободны, потом улетают
const FR_JEER_EVERY = 600            // враг игрока ругается на него не чаще раза в полминуты
const FR_DEAL_CHANCE = 0.7           // столько торгов кончаются сделкой (плюс отношения)

var FR_SERVER = null
var FR_DATA = null
var FR_HOLD = {}                     // uuid жителя -> до какого тика им управляет торг
var FR_JEER = {}                     // uuid игрока -> когда ругались в последний раз

function frLog(t) { try { console.log("[торги] " + t) } catch (e) { } }
function frErr(w, e) { try { console.error("[торги] " + w + ": " + e) } catch (err) { } }
function frPick(list) { return list[Math.floor(Math.random() * list.length)] }

function frLoad() {
    if (FR_DATA) return FR_DATA
    try { FR_DATA = JSON.parse(global.TFG_STORE.read(FR_SERVER.persistentData, "tfg_fairs") || "{}") }
    catch (e) { FR_DATA = {}; frErr("чтение", e) }
    if (!FR_DATA.plans) FR_DATA.plans = {}
    return FR_DATA
}

function frSave() {
    if (!FR_SERVER || !FR_DATA) return
    var bad = global.TFG_STORE.write(FR_SERVER.persistentData, "tfg_fairs", JSON.stringify(FR_DATA))
    if (bad) frErr("запись", bad)
}

/** Житель сейчас занят торгом: settlers.js не водит его по распорядку. */
function frHolds(e) {
    var until = FR_HOLD[String(e.uuid)]
    if (!until) return false
    try { if (Number(e.level.getTime()) < until) return true } catch (err) { }
    delete FR_HOLD[String(e.uuid)]
    return false
}

// ─── Слова ───────────────────────────────────────────────────────────────────

const FR_GOODS = {
    weaponsmith: "клинки и луки", gunsmith: "стволы и патроны", armorer: "доспехи", blacksmith: "инструменты", builder: "камень и кирпич",
    carpenter: "доски и мебель", potter: "посуду", butcher: "мясо", cook: "снедь", fisherman: "рыбу",
    hunter: "шкуры и дичь", gardener: "семена и саженцы", tailor: "ткани и одежду", miner: "руду",
    mechanic: "механизмы", electrician: "провода и машины", metallurgist: "слитки", chemist: "реактивы",
    buyer: "драгоценности", junk: "всякую всячину", appraiser: "проверенную монету",
}
const FR_NEEDS = ["железо", "зерно", "стрелы", "доски для частокола", "соль", "лекарства", "уголь", "шкуры",
    "кирпич", "верёвки", "лампы", "гвозди", "бочки", "воск"]
const FR_INSTR = { lute: "лютне", flute: "флейте", bagpipe: "волынке" }

const FR_LINES = {
    greet_same: [
        "С возвращением, {guest}. Свои всегда желанны в «{vname}».",
        "Свои! Проходи, {guest}, крепость открыта для тебя.",
        "Рад видеть своих. Как дорога из «{home}»?",
        "А вот и наши. Давно ждали каравана.",
        "Свои люди под нашими стенами - добрый знак.",
    ],
    greet_hostile: [
        "Люди «{g}» в моей крепости... Говори быстро, пока я добрый.",
        "Не думал, что «{g}» осмелятся сюда сунуться. Ну, раз пришли - торгуйте.",
        "Удивлён. Совесть у «{g}» проснулась или кошелёк опустел?",
        "«{g}»... Стража, глаз с них не спускать.",
    ],
    greet_cool: [
        "Добро пожаловать, люди «{g}». Торгуйте честно - и уйдёте с прибылью.",
        "Не часто «{g}» к нам заглядывают. С чем пожаловали?",
        "Ворота открыты. Но стража смотрит в оба.",
        "Гости из «{g}». Что ж, посмотрим, с чем пришли.",
    ],
    greet_warm: [
        "Рады гостям из «{g}»! Сегодня может совершиться сделка на пользу обоим нашим народам.",
        "«{g}» всегда желанные гости у нас. Проходите к огню.",
        "Хорошо, что «{g}» не забывают дорогу в «{vname}».",
    ],
    greet_friendly: [
        "Друзья из «{g}»! Наши стены - ваши стены.",
        "Ха! «{g}» снова с нами. Вместе нам никакие разбойники не страшны!",
        "Самые дорогие гости! Для «{g}» в «{vname}» всегда найдётся место.",
    ],
    reply_same: [
        "Дорога была долгой, но мы здесь, правитель.",
        "Привезли, что смогли. Времена нынче тяжёлые.",
        "Из «{home}» шли без приключений, слава богам.",
        "Рад служить, правитель. Товар добрый.",
    ],
    reply_hostile: [
        "Мы пришли торговать, а не слушать упрёки.",
        "Наш товар не хуже ваших угроз. Посмотрим, чья возьмёт.",
        "Не бойся, правитель, мы ненадолго.",
        "Деньги не пахнут. Даже ваши.",
    ],
    reply_cool: [
        "С товаром и добрыми намерениями.",
        "Торговать. Остальное - дело правителей.",
        "Мы люди дела. Покажем товар - сами решите.",
    ],
    reply_warm: [
        "Для друзей - лучший товар и честная цена.",
        "Рады стараться для «{v}»!",
        "В «{home}» о вас только доброе говорят.",
    ],
    praise: [
        "Лучшие {goods} от «{home}» до самого моря.",
        "Взгляните: {item}. Такого в округе не найдёте.",
        "{item} - сам проверял. Не сломается, не сгниёт.",
        "За такие {goods} в других краях дерутся.",
        "Только сегодня привезли {item}. Завтра уйдёт.",
        "Кто купит {item} - благодарить будет до весны.",
    ],
    ask: [
        "Почём {item}?",
        "И сколько хочешь за {item}?",
        "{item}, говоришь? Назови цену.",
        "Ну-ка, почём нынче {item}?",
    ],
    price: [
        "{p} медяков{lot}. И это по-дружески.",
        "{p}{lot}. Дешевле не найдёшь.",
        "Цена {p}{lot} - и то себе в убыток.",
        "{p} медяков{lot}, и ни монетой меньше.",
    ],
    counter: [
        "{p}? Побойся богов. Даю {p2}.",
        "За {p} я сам такое сделаю. {p2} - и по рукам.",
        "Дорого. У прошлого каравана было по {p2}.",
        "Ха! {p2}, и то из уважения к дороге.",
    ],
    counter_guest: [
        "{p3} - последнее слово. Дорога нынче опасна.",
        "Ниже {p3} не опущусь, у меня охрана не бесплатная.",
        "Ладно, {p3}. Но только для «{vname}».",
        "{p3}. Не хочешь - соседи возьмут.",
    ],
    remark: [
        "Товар-то и правда добрый. Бери, не жмись.",
        "Посмотри на швы... на края... вроде без обмана.",
        "У нас самих такого не делают - бери.",
        "Я бы ещё поторговался. Но решать тебе.",
        "Цена кусается. Но и вещь хороша.",
    ],
    deal_ok: ["По рукам!", "Идёт. Неси товар в лавку.", "Ладно, уговорил. По рукам.", "Беру. Отсчитывай сдачу."],
    deal_ok_guest: ["Приятно иметь дело.", "Не пожалеете.", "Вот это разговор!"],
    deal_fail: ["Нет. За такие деньги - ищи дураков в другом месте.", "Не сговоримся. Себе дороже.", "Оставь себе. Мы обойдёмся."],
    deal_fail_guest: ["Как знаешь. Покупатель найдётся.", "Пожалеешь, да поздно будет.", "Ну и ладно. Наше не пропадёт."],
    needs: [
        "{guest}, поселению к зиме нужны {need}. Даю не больше {budget} медяков.",
        "Скажу прямо: нам нужны {need}. Казна выдержит {budget}, не больше.",
        "Найди нам {need} - заплачу {budget} медяков, слово правителя.",
    ],
    needs_reply: [
        "Найдём. В «{home}» как раз остались.",
        "За {budget}? Трудно, но попробую.",
        "Будет сделано. Передам старшим.",
    ],
    diplo_hostile: [
        "Передай своим: ещё одна стычка на нашей земле - и торговле конец.",
        "Ваши люди грабят наши караваны, а вы привозите нам товар. Смешно.",
    ],
    diplo_hostile_reply: ["Передам. Но и вы держите своих при себе.", "Сначала разберитесь, кто кого грабит."],
    diplo_cool: [
        "Отношения у нас прохладные. Но торговля - первый шаг к миру.",
        "Мы помним старые обиды. Но кошелёк памяти не имеет.",
    ],
    diplo_cool_reply: ["Дельно сказано. Передам нашим старшинам.", "Мир - дело небыстрое. Начнём с торга."],
    diplo_warm: [
        "Сегодняшняя сделка пойдёт на пользу нашим поселениям. Передай поклон своим.",
        "Нам бы ещё дорогу между нами расчистить - выгодно будет всем.",
    ],
    diplo_warm_reply: ["Передам. «{g}» помнят друзей.", "Дело говоришь, правитель."],
    diplo_friendly: [
        "Если разбойники сунутся к вам - зовите. Мы придём.",
        "С такими соседями и зима не страшна!",
    ],
    diplo_friendly_reply: ["И вы на нас рассчитывайте.", "Выпьем за это вечером!"],
    close: ["А теперь - музыка! Бард, сыграй гостям.", "Довольно о делах. Бард, играй!", "Пусть бард споёт - гости с дороги."],
    piece: ["Эту - для гостей из «{g}»!", "А теперь - на {instr}!", "Старая песня, ещё дедова.", "Последняя - за удачную дорогу!", "Эта - про наш «{vname}»."],
    jeer: [
        "Повезло тебе, что мы в гостях.",
        "Не на своей земле - так бы поговорили иначе.",
        "Смотри-ка, кто тут. Держись подальше.",
        "Ещё встретимся за воротами.",
        "Тьфу. И сюда пролез.",
    ],
}

function frFill(text, ctx) {
    var out = String(text).replace(/\{([a-z0-9]+)\}/g, (m, k) => ctx[k] === undefined ? m : String(ctx[k]))
    return out.charAt(0).toUpperCase() + out.substring(1)
}

/** Отношения как полоса: вражда, прохлада, тепло, дружба. */
function frBand(rel) {
    if (rel < -20) return "hostile"
    if (rel < 10) return "cool"
    if (rel < 40) return "warm"
    return "friendly"
}

/** Русское название товара: таблица переводов окна сделки, у GregTech - форма + материал. */
/** Название товара из предложения: у стволов и патронов TACZ - по их собственному id. */
function frOfferName(o) {
    if (o.gun || o.ammo) {
        try {
            var st = global.TFG_GUN_ITEMS.offerStack(o, 1)
            if (st) return String(st.getHoverName().getString())
        } catch (e) { }
        return o.gun ? "ствол" : "патроны"
    }
    return frItemName(o.item)
}

function frItemName(id) {
    try {
        var st = Item.of(id)
        if (typeof tmRu === "function") {
            var gt = typeof mkGT === "function" ? mkGT() : null
            if (gt) {
                var entry = gt.helper.getMaterialEntry(st.getItem())
                if (entry && !entry.isEmpty() && entry.material() && entry.tagPrefix()) {
                    var mat = tmRu(String(entry.material().getUnlocalizedName()))
                    var form = tmRu("tagprefix." + tmSnake(entry.tagPrefix().name))
                    if (mat) return (form && form.indexOf("%s") >= 0 ? form.replace("%s", mat) : mat).toLowerCase()
                }
            }
            var ru = tmRu(String(st.getDescriptionId()))
            if (ru) return ru.toLowerCase()
        }
        return String(st.getHoverName().getString()).toLowerCase()
    } catch (e) { return "товар" }
}

/**
 * Сценарий торга: список { who, text }. who - ruler, guest, t1, t2, guard.
 * Товар и цена - настоящие, из предложений торговца-гостя.
 */
function frScript(v, village, trader, deal) {
    var same = v.faction === village.faction
    var rel = 0
    try { rel = Number(global.TFG_FACTIONS.relation(village.faction, v.faction)) } catch (e) { }
    var band = frBand(rel)
    var offers = []
    try { offers = JSON.parse(String(trader.persistentData.getString("tfg_trader_offers"))) } catch (e) { }
    var o = offers.length ? frPick(offers) : null
    var p = o ? Math.max(1, Math.round(o.price)) : 40
    var kind = String(trader.persistentData.getString("tfg_trader_kind"))
    var home = null
    try { home = String(trader.persistentData.getString("tfg_origin_name")) || null } catch (e) { }
    var guestName = ""
    try { guestName = String(global.TFG_NPC.nameOf(trader) || "").split(" ")[0] } catch (e) { }
    var ctx = {
        g: gsFactionName(v.faction), v: gsFactionName(village.faction), vname: sgName(village),
        home: home || "своих краёв", guest: guestName || "торговец", goods: FR_GOODS[kind] || "товар",
        item: o ? frOfferName(o) : "товар", p: p, p2: Math.max(1, Math.round(p * 0.7)), p3: Math.max(1, Math.round(p * 0.85)),
        lot: o && o.count > 1 ? " за " + o.count + " шт." : "", need: frPick(FR_NEEDS),
        budget: 50 * (4 + Math.floor(Math.random() * 27)),
    }
    var L = FR_LINES
    var s = []
    var say = (who, pool) => s.push({ who: who, text: frFill(frPick(pool), ctx) })
    say("ruler", same ? L.greet_same : L["greet_" + band])
    say("guest", same ? L.reply_same : L["reply_" + (band === "friendly" ? "warm" : band)])
    say("guest", L.praise)
    say("t1", L.ask)
    say("guest", L.price)
    say("t1", L.counter)
    say("guest", L.counter_guest)
    say("t2", L.remark)
    say("t1", deal ? L.deal_ok : L.deal_fail)
    say("guest", deal ? L.deal_ok_guest : L.deal_fail_guest)
    if (same) {
        say("ruler", L.needs)
        say("guest", L.needs_reply)
    } else {
        say("ruler", L["diplo_" + band])
        say("guest", L["diplo_" + band + "_reply"])
    }
    say("ruler", L.close)
    return { lines: s, ctx: ctx }
}

// ─── Сцена ───────────────────────────────────────────────────────────────────

/**
 * Подвести к месту; не дошёл к концу сбора - перенести. Затем смотреть в середину.
 * Дошёл - место за ним: стоит и беседует, пока его не отнесёт дальше четырёх блоков. Раньше
 * любой толчок выводил за два блока - и участник шёл обратно, туда-сюда всю сцену.
 */
var FR_SEATED = {}                   // uuid -> { x, z } - место, которое он уже занял

function frPlace(level, e, x, z, cx, cz, late) {
    if (!e) return true
    var dx = e.getX() - x, dz = e.getZ() - z
    var key = String(e.uuid)
    var seat = FR_SEATED[key]
    if (seat && Math.abs(seat.x - x) < 0.6 && Math.abs(seat.z - z) < 0.6) {
        if (dx * dx + dz * dz <= 16) {
            try { e.getNavigation().stop() } catch (err) { }
            try { e.getLookControl().setLookAt(cx, e.getEyeY(), cz) } catch (err) { }
            return true
        }
        delete FR_SEATED[key]
    }
    var far = dx * dx + dz * dz > 4
    if (far) {
        if (late) {
            try { gsTp(level, e, x, gsSurface(level, Math.floor(x), Math.floor(z)), z) } catch (err) { }
        } else {
            try { if (e.getNavigation().isDone()) gsWalk(e, x, e.getY(), z, 0.9) } catch (err) { }
        }
        return false
    }
    try { e.getNavigation().stop() } catch (err) { }
    try { e.getLookControl().setLookAt(cx, e.getEyeY(), cz) } catch (err) { }
    FR_SEATED[key] = { x: x, z: z }
    return true
}

/** Сказать реплику: житель - своим голосом (settlers.js), гость - над головой. */
function frSpeak(e, text, settler) {
    if (!e) return
    if (settler) { try { seVoice(e, text); return } catch (err) { } }
    try { gsSay(e, null, text, text) } catch (err) { }      // гость тоже вслух, если реплика озвучена
}

function frQuiet(f, cast) {
    if (!f.lastGuest) return
    var e = cast[f.lastGuest]
    if (e) { try { gsRestoreName(e) } catch (err) { } }
    f.lastGuest = null
}

/** Ругань гостей-врагов на игрока: на чужой земле только словами. */
function frJeers(v, level, now, people) {
    people.forEach(e => {
        if (!e) return
        var p = null
        try { p = level.getNearestPlayer(e, 10) } catch (err) { }
        if (!p || p.isCreative() || p.isSpectator()) return
        var key = String(p.uuid)
        if (FR_JEER[key] && now - FR_JEER[key] < FR_JEER_EVERY) return
        var rep = 0
        try { rep = Number(global.TFG_FACTIONS.rep(p, v.faction)) } catch (err) { }
        if (rep >= -20) return
        FR_JEER[key] = now
        frSpeak(e, frPick(FR_LINES.jeer), false)
    })
}

/**
 * Вызывается из gsVisitTick в фазе «stay», если визит пришёл в поселение. true - этот тик
 * гостями управляет торг (их обычные занятия не идут).
 */
function frStayTick(v, level, now, trader, guards, rt, fighting) {
    if (!v.settlement) return false
    var village = seLoad().villages[v.settlement]
    if (!village) return false
    var bodyguard = guards.filter(g => String(g.persistentData.getString("tfg_guest_role")) === "bodyguard")[0] || null
    frJeers(v, level, now, [trader].concat(guards))
    if (!v.fair) {
        v.fair = { stage: "сбор", at: now, i: 0, next: 0, tune: 0, tunes: 4 + Math.floor(Math.random() * 2) }
        gsSave()
        frLog(sgName(village) + ": караван " + v.faction + " собирается в форт")
    }
    var f = v.fair
    if (f.stage === "свободно") return false
    if (v.homecoming) {
        if (v.hostile || village.state !== "мир") { f.stage = "свободно"; gsSave(); return false }
        return frHomeTick(v, level, now, trader, guards, rt, fighting, village)
    }
    if (v.warband) {
        if (v.hostile || village.state !== "мир") { f.stage = "свободно"; gsSave(); return false }
        return frWarTick(v, level, now, trader, guards, rt, fighting, village)
    }
    // ударили гостей или жителей - сцене конец, дальше обычные правила
    if (v.hostile || village.state !== "мир" || !trader) {
        f.stage = "свободно"
        gsSave()
        return false
    }

    var fort = seFortSpot(village)
    var meet = frMeet(village, fort, now)                 // у костра во дворе крепости
    var cx = meet.x, cz = meet.z
    var ents = []
    try { ents = seEntities(level, village) } catch (e) { }
    var ruler = ents.filter(e => seRoleOf(e) === "правитель")[0] || null
    var traders = ents.filter(e => seRoleOf(e) === "торговец").slice(0, 2)
    var bard = ents.filter(e => seRoleOf(e) === "бард")[0] || null
    var cast = { ruler: ruler, guest: trader, t1: traders[0] || null, t2: traders[1] || traders[0] || null, guard: bodyguard, bard: bard }
    ;[ruler, traders[0], traders[1], bard].forEach(e => { if (e) FR_HOLD[String(e.uuid)] = now + 100 })

    // места: правитель и гость друг против друга, торговцы по бокам, охрана позади гостя;
    // на концерте в середине бард, остальные кругом
    var concert = f.stage === "концерт"
    var r = concert ? 4 : 2.5
    var spots = {
        ruler: [cx + r, cz], guest: [cx - r, cz], t1: [cx, cz + r], t2: [cx, cz - r],
        guard: [cx - r - 2, cz + 1], bard: concert ? [cx, cz] : [cx + r + 2, cz + 2],
    }
    var late = now - f.at > FR_GATHER_MAX
    var ready = true
    for (var k in spots) {
        var e = cast[k]
        if (!e || (k === "t2" && cast.t2 === cast.t1)) continue
        var lookX = concert && bard && k !== "bard" ? bard.getX() : cx
        var lookZ = concert && bard && k !== "bard" ? bard.getZ() : cz
        if (!frPlace(level, e, spots[k][0], spots[k][1], lookX, lookZ, late)) ready = false
    }
    // прочая охрана гостя - у ворот снаружи: в форт посторонние не заходят
    frGuardsAtGate(level, village, guards.filter(g => g !== bodyguard), bodyguard, fighting, late)

    if (f.stage === "сбор") {
        if (!ready && !late) return true
        var deal = Math.random() < FR_DEAL_CHANCE + (v.faction === village.faction ? 0.15 : 0)
        var sc = frScript(v, village, trader, deal)
        f.lines = sc.lines
        f.ctx = sc.ctx
        f.deal = deal
        f.stage = "торг"
        f.next = now
        gsSave()
        return true
    }

    if (f.stage === "торг") {
        if (now < f.next) return true
        frQuiet(f, cast)
        while (f.i < f.lines.length && !cast[f.lines[f.i].who]) f.i++         // говорящего нет - пропускаем
        if (f.i >= f.lines.length) {
            frResult(v, village, f)
            f.stage = bard ? "концерт" : "свободно"
            f.next = now + 40
            if (!bard) v.until = now + FR_AFTER
            gsSave()
            return !!bard
        }
        var line = f.lines[f.i++]
        var who = cast[line.who]
        frSpeak(who, line.text, line.who !== "guest" && line.who !== "guard")
        if (line.who === "guest" || line.who === "guard") f.lastGuest = line.who
        f.next = now + FR_LINE_TICKS + line.text.length
        return true
    }

    if (f.stage === "концерт") {
        var bu = bard ? String(bard.uuid) : null
        var play = bu ? SE_PLAY[bu] : null
        // вещь длиннее одного наигрыша: доиграл фразу - следующая
        if (play && play.i >= play.notes.length && now < play.until) {
            play.notes = SE_TUNES[Math.floor(Math.random() * SE_TUNES.length)]
            play.i = 0
        }
        if (now < f.next) return true
        if (!bard || f.tune >= f.tunes) {
            if (bu) delete SE_PLAY[bu]
            f.stage = "свободно"
            v.until = now + FR_AFTER
            gsSave()
            frLog(sgName(village) + ": концерт окончен, гости свободны")
            return false
        }
        var inst = SE_INSTRUMENTS[f.tune % SE_INSTRUMENTS.length]
        SE_PLAY[bu] = {
            notes: SE_TUNES[Math.floor(Math.random() * SE_TUNES.length)], i: 0, next: 0, inst: inst,
            dim: village.dim, e: bard, village: village, until: now + FR_TUNE_TICKS, restUntil: now + FR_TUNE_TICKS + FR_TUNE_PAUSE,
        }
        var instName = "лютне"
        for (var ik in FR_INSTR) if (inst.indexOf(ik) >= 0) instName = FR_INSTR[ik]
        var ctx = { instr: instName }
        for (var ck in (f.ctx || {})) ctx[ck] = f.ctx[ck]
        frSpeak(bard, frFill(frPick(FR_LINES.piece), ctx), true)
        f.tune++
        f.next = now + FR_TUNE_TICKS + FR_TUNE_PAUSE
        gsSave()
        return true
    }
    return false
}

/** Итог торга: летопись поселения и отношения фракций. */
function frResult(v, village, f) {
    var who = v.faction === village.faction ? "свой караван" : "караван фракции «" + gsFactionName(v.faction) + "»"
    var text = "приходил " + who + (v.kindName ? " (" + String(v.kindName).toLowerCase() + ")" : "") +
        (f.deal ? ", сторговались" : ", не сторговались")
    try { sgEvent(village, "караван", text, { by: v.faction }) } catch (e) { frErr("летопись", e) }
    if (v.faction !== village.faction) {
        try { global.TFG_FACTIONS.event(village.faction, v.faction, f.deal ? 2 : -1, "торг в поселении") } catch (e) { }
    }
    frLog(sgName(village) + ": " + text)
}


// ─── Свои караваны (этап 4.3) ────────────────────────────────────────────────
//
// У поселения FR_CARAVANS караванов. Каждый ходит в настоящее поселение округи (не к врагам)
// и возвращается: распродали и привезли деньги, слетали впустую или на них напали; дорога
// лёгкая или тяжёлая. Без игрока это строки летописи. С игроком - сцена в форте: глава
// каравана докладывает правителю и уходит отдыхать, к правителю подходит местный торговец,
// получает наказ и улетает с караваном (его самого в поселении нет, пока караван в пути).

const FR_CARAVANS = 5
const FR_TRAVEL_MIN = 2              // дней в пути туда и обратно, ближе всего
const FR_TRAVEL_MAX = 10
const FR_REST_MIN = 1                // и дней отдыха дома
const FR_REST_MAX = 3
const FR_DEST_R = 15000              // куда летают
const FR_CARAVAN_KINDS = ["blacksmith", "weaponsmith", "armorer", "builder", "carpenter", "potter", "butcher",
    "tailor", "miner", "hunter", "gardener", "cook"]

const FR_HOME_LINES = {
    greet: ["{leader}! Живой! Рассказывай.", "Вернулись. Ну, с чем пришли?", "Долго же вас не было, {leader}.",
        "А вот и наш караван. Говори, {leader}, не томи."],
    sold: ["В «{dest}» всё распродали. Привезли {money} медяков.", "Торговля шла бойко: {goods} ушли за два дня. Вот {money} медяков.",
        "Взяли у нас всё, правитель. И заказали ещё. В казну - {money}."],
    empty: ["Слетали впустую. В «{dest}» и своего хватает.", "Цены там упали - продали меньше трети.",
        "Никто не брал. Будто мор у них в «{dest}»."],
    attacked: ["На нас напали на обратном пути. Отбились, но груз частью потеряли.", "Разбойники ждали на перевале. Охрана не зря ест свой хлеб.",
        "Нас пытались ограбить у самой «{dest}». Еле ушли."],
    easy: ["Дорога лёгкая, ни облачка.", "Долетели быстро, ветер был попутный.", "Путь спокойный, правитель."],
    hard: ["Дорога тяжёлая: ветер, дожди, три дня в грязи.", "Обратно летели в шторм. Еле дотянули.", "Путь вымотал всех. Людям нужен отдых."],
    ruler_sold: ["Добрая работа. Казна скажет спасибо.", "Вот это я понимаю. Ступайте, отдыхайте.", "Молодцы. Вечером - за мой счёт."],
    ruler_empty: ["Плохо. Но не всякий поход в прибыль.", "Ничего. В другой раз повезёт.", "Значит, в «{dest}» больше не летаем."],
    ruler_attacked: ["Живы - и ладно. Охрану в следующий раз удвоим.", "Разбойники... Я с ними ещё поговорю.", "Главное - люди целы."],
    leave: ["С вашего позволения - пойду отосплюсь.", "Пойду к своим, правитель. Месяц не видел.", "Разрешите идти. Ноги не держат."],
    call: ["{trader}! Подойди.", "{trader}, иди сюда. Есть дело.", "Где {trader}? Позовите."],
    orders: ["Бери караван и лети в «{dest2}». Там нужны {goods2}, привези {need}.",
        "Твой путь - «{dest2}». Продай {goods2}, да не продешеви.",
        "Летишь в «{dest2}». Говорят, там спокойно, но охрану возьми. Вернись к {back}-му дню."],
    reply: ["Будет исполнено, правитель.", "Вернусь с прибылью.", "Не подведу.", "Сегодня же и вылетим."],
    off: ["По местам! Отлетаем!", "Грузимся, ребята!", "Ну, с богом."],
    no_trader: ["Отдыхайте. Следующий караван подождёт.", "Торговцев сейчас нет - все в разъездах."],
}

/** Караваны поселения; при первом обращении заводятся. */
function frCaravans(village) {
    var data = frLoad()
    if (!data.caravans) data.caravans = {}
    if (!data.caravans[village.id]) {
        var today = trToday()
        var list = []
        for (var i = 0; i < FR_CARAVANS; i++) {
            var master = seName("торговец", Math.random() < 0.3)
            list.push({ id: village.id + "_c" + i, master: master, leader: master, sid: null,
                kind: frPick(FR_CARAVAN_KINDS), state: "дома", rest: today + Math.floor(Math.random() * 6), dest: null, back: 0, trips: 0 })
        }
        data.caravans[village.id] = list
        frSave()
    }
    return data.caravans[village.id]
}

/** Куда лететь: поселение округи своей или не враждебной фракции. */
function frDest(level, village) {
    var near = []
    try { near = global.TFG_WORLD.near(level, village.x, village.z, FR_DEST_R, true) } catch (e) { }
    var own = sgSiteOf(village)
    var cand = near.filter(n => {
        if (own && n.site.id === own.id) return false
        if (n.site.state === "нет площадки в ячейке") return false
        if (n.site.faction === village.faction) return true
        try { return Number(global.TFG_FACTIONS.relation(village.faction, n.site.faction)) >= GS_HOSTILE_RELATION } catch (e) { return false }
    })
    if (!cand.length) return null
    var n = frPick(cand.slice(0, 8))
    return { id: n.site.id, name: n.site.name, faction: n.site.faction, dist: n.dist }
}

/** Свободный торговец поселения (один всегда остаётся дома). Запись жителя или null. */
function frFreeTrader(village) {
    var free = village.settlers.filter(s => s.role === "торговец" && !s.dead && !s.away)
    return free.length >= 2 ? frPick(free) : null
}

/** Исход похода: напали, впустую или распродали; лёгкая ли была дорога. */
function frOutcome(village, c) {
    var rel = 50
    if (c.dest && c.dest.faction !== village.faction) {
        try { rel = Number(global.TFG_FACTIONS.relation(village.faction, c.dest.faction)) } catch (e) { rel = 0 }
    }
    var dist = c.dest ? c.dest.dist : 5000
    var attackP = 0.12 + (rel < -20 ? 0.12 : 0) + Math.min(0.1, dist / 100000)
    var r = Math.random()
    var kind = r < attackP ? "attacked" : r < attackP + 0.25 ? "empty" : "sold"
    return {
        kind: kind, hard: Math.random() < 0.25 + dist / 40000,
        money: kind === "sold" ? 50 * (4 + Math.floor(Math.random() * 27)) : 0,
    }
}

/** Караван ушёл: в летопись, торговец-житель уходит с ним. */
function frDepart(village, c, dest, trader) {
    var today = trToday()
    c.dest = dest
    c.state = "в пути"
    c.out = today
    c.back = today + Math.min(FR_TRAVEL_MAX, FR_TRAVEL_MIN + Math.round(dest.dist / 2500))
    c.backAt = Math.floor(Math.random() * 20000)
    c.pending = false
    // ведёт свой постоянный глава; житель-торговец - только в этом походе
    if (trader) {
        c.sid = trader.id
        c.leader = trader.name
        trader.away = c.id
        seSave()
    } else {
        c.sid = null
        c.leader = c.master || c.leader
    }
    try { sgEvent(village, "караван", "ушёл караван " + c.leader + " в «" + dest.name + "»", { caravan: c.id }) } catch (e) { }
    frSave()
}

/** Караван вернулся: итог в летопись, торговец-житель снова дома. */
function frReturn(village, c, o) {
    c.state = "дома"
    c.pending = false
    c.rest = trToday() + FR_REST_MIN + Math.floor(Math.random() * (FR_REST_MAX - FR_REST_MIN + 1))
    c.trips = (c.trips || 0) + 1
    c.last = o
    var where = c.dest ? "«" + c.dest.name + "»" : "дальних краёв"
    var text = "вернулся караван " + c.leader + " из " + where + ": " + (o.kind === "sold" ? "распродали товар, привезли " + o.money + " медяков"
        : o.kind === "empty" ? "слетали впустую" : "на них напали в дороге") + (o.hard ? ", дорога была тяжёлой" : "")
    try { sgEvent(village, "караван", text, { caravan: c.id }) } catch (e) { }
    if (o.kind === "sold" && c.dest && c.dest.faction !== village.faction) {
        try { global.TFG_FACTIONS.event(village.faction, c.dest.faction, 1, "удачный караван") } catch (e) { }
    }
    if (c.sid) {
        var rec = village.settlers.filter(s => s.id === c.sid)[0]
        if (rec && !rec.dead) {
            delete rec.away
            // сущность убрали, когда уходил, - пусть снова появится у своей койки (sieges.js sgPeopleTick)
            if (rec.goneBody) { rec.newcomer = true; delete rec.goneBody }
        }
        seSave()
    }
    frSave()
    frLog(sgName(village) + ": " + text)
}

/** Возвращение с игроком рядом: настоящий визит своей фракции с пометкой каравана. */
function frHomecoming(level, village, c) {
    var fort = seFortSpot(village)
    var cx = fort ? fort.gate.x : village.x, cz = fort ? fort.gate.z : village.z
    var cy = 70
    try { cy = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", cx, cz)) } catch (e) { }
    try {
        var gsp = global.TFG_GROUND_SPOT(level, cx, cz, 12)      // у ворот на земле, не на надвратной башне
        if (gsp) { cx = Math.floor(gsp.x); cz = Math.floor(gsp.z); cy = gsp.y }
    } catch (e) { }
    var tier = typeof SE_TRADE_TIER === "number" ? SE_TRADE_TIER : 4
    sgPlayers(village, FR_NEAR).forEach(p => { try { tier = Math.max(tier, Number(global.TFG_PLAYER_TIER(p)) || 1) } catch (e) { } })
    var err = gsVisit(level, { x: cx, y: cy, z: cz }, village.faction, c.kind, Math.min(10, tier),
        { settlement: village.id, name: sgName(village), homecoming: c.id })
    if (err) return err
    // глава каравана - тот самый человек, что уходил
    try {
        var e = TR_LAST_ENTITY
        var pd = e.persistentData
        pd.remove("tfg_npc_id")
        pd.putString("tfg_npc_name", c.leader)
        var site = sgSiteOf(village)
        if (site) { pd.putString("tfg_origin", String(site.id)); pd.putString("tfg_origin_name", String(site.name)) }
        gsRestoreName(e)
    } catch (e2) { frErr("имя главы каравана", e2) }
    c.pending = true
    c.pendingAt = trToday()
    frSave()
    frLog(sgName(village) + ": возвращается караван " + c.leader)
    return null
}

/** Раз в сутки: уходы и возвращения без игрока; с игроком - настоящие возвращения. */
function frCaravanTick(level, village) {
    var today = trToday()
    // изредка прилетает своя дружина - только при игроке рядом и в мирное время
    try {
        var dataW = frLoad()
        if (!dataW.warDay) dataW.warDay = {}
        if (dataW.warDay[village.id] !== today) {
            dataW.warDay[village.id] = today
            frSave()
            if (sgPlayers(village, FR_NEAR).length && village.state === "мир" && Math.random() < FR_WAR_CHANCE) {
                var werr = frWarband(level, village)
                if (werr) frLog(sgName(village) + ": дружина не прилетела - " + werr)
            }
        }
    } catch (e) { frErr("дружина", e) }
    var t = Number(level.getDayTime()) % 24000
    var near = sgPlayers(village, FR_NEAR).length > 0
    var list = frCaravans(village)
    list.forEach(c => {
        // сцену возвращения прервали (бой, перезапуск) - через сутки решаем без неё
        if (c.state === "в пути" && c.pending && today > (c.pendingAt || 0) + 1 && !frActiveFor(village.id)) {
            frReturn(village, c, frOutcome(village, c))
            return
        }
        if (c.state === "в пути" && !c.pending && (today > c.back || (today === c.back && t >= (c.backAt || 0)))) {
            var real = near && village.state === "мир" && !frActiveFor(village.id) && !(typeof sgActiveFor === "function" && sgActiveFor(village.id))
            if (real && !frHomecoming(level, village, c)) return
            frReturn(village, c, frOutcome(village, c))
        } else if (c.state === "дома" && today >= c.rest && !near) {
            // при игроке рядом в путь отправляет только сцена: торговец не должен исчезнуть на глазах
            var dest = frDest(level, village)
            if (!dest) { c.rest = today + 2; return }
            frDepart(village, c, dest, frFreeTrader(village))
        }
    })
}

/** Ушедших с караваном жителей нет в поселении: если их сущность попалась - убрать. */
function frAwayPurge(level, village) {
    if (!village.settlers.some(s => s.away)) return
    var ents = []
    try { ents = seEntities(level, village) } catch (e) { return }
    var changed = false
    ents.forEach(e => {
        var rec = village.settlers.filter(s => s.id === seSidOf(e))[0]
        if (!rec || !rec.away) return
        // спутник и житель базы тоже «в отлучке», но их тело - при игроке: не трогать (29.10.2026 их тут и убирало)
        if (rec.comp || rec.away === "спутник" || rec.away === "база") return
        try { if (e.getTags().contains("tfg_companion")) return } catch (err0) { }
        try { e.discard() } catch (err) { }
        rec.goneBody = true
        changed = true
    })
    if (changed) seSave()
}

// ─── Возвращение своего каравана ─────────────────────────────────────────────
//
// 1. Аудиенция: глава каравана идёт в форт к правителю. Охрана каравана в форт не заходит -
//    встаёт у ворот снаружи и стережёт, как дружина. Транспорт стоит там, где сел.
// 2. Доклад: правитель расспрашивает о походе (FR_AUDIENCE - вопрос и ответ), глава
//    рассказывает, где был, что почём, какие слухи; в конце - итог и слово правителя.
// 3. Сутки дома: глава торгует за свободным прилавком двора (лавка для караванов, settlers.js),
//    охрана говорит о доме (FR_HOME_TALK), а не о чужом поселении.
// 4. На второй день правитель зовёт другого торговца, даёт наказ - куда лететь (настоящие
//    поселения округи), что продать, что купить, - и тот с охраной улетает.

const FR_HOME_DAY = 24000            // сутки глава каравана торгует дома
const FR_AUDIENCE_PAIRS = 6          // столько вопросов задаёт правитель на докладе

// Вопрос правителя и ответ главы каравана. {dest} - куда летали, {destf} - чьё оно, {goods} -
// что возили, {cheap}/{dear} - что там дёшево и дорого, {need} - чего им не хватает,
// {days} - дней в пути, {leader} - глава, {home} - наше поселение.
const FR_AUDIENCE = [
    ["Как встретили в «{dest}»?", "Сперва настороженно, правитель. А как увидели {goods} - сразу подобрели."],
    ["Кто там нынче всем заправляет?", "Прежний хозяин, крепко держит. Нашим поклон передавал."],
    ["Что почём на тамошнем торгу?", "{dear} у них в цене, а {cheap} - за бесценок. Взял, сколько смог увезти."],
    ["Сколько дней шли?", "{days} дня туда и обратно. Шли бы быстрее, да груз тяжёл."],
    ["Чего им не хватает?", "Просят {need}. Говорят, заплатят вдвое, если привезём к холодам."],
    ["Разбойников видели?", "Следы видели, костры брошенные. Сами не сунулись - охрану нашу разглядели."],
    ["А стража у них какая?", "Крепкая. Ворота днём и ночью стерегут, на стенах стрелки."],
    ["Слухи какие везёшь?", "Говорят, {destf} с соседями спорят из-за лесных угодий. Может, и до драки дойдёт."],
    ["Наших там помнят?", "Помнят. Спрашивали, когда снова прилетим."],
    ["Где ночевали?", "На постоялом дворе у их ворот. Клопы, правитель, - размером с монету."],
    ["Обмануть пытались?", "Пытались весы подкрутить. Я свои гири вожу с собой - не вышло."],
    ["Кто взял больше всех?", "Их кузнец. Забрал почти всё разом и ещё заказал."],
    ["Погода в пути какая была?", "Туда - ветер в спину, обратно - дождь стеной. Но долетели."],
    ["Люди целы?", "Все целы. Один ногу подвернул на трапе, уже ходит."],
    ["Что у них строят?", "Новую стену кладут, камень возят телегами. Деньги, видать, водятся."],
    ["Почём там хлеб?", "Втрое дороже нашего. Поля у них побило засухой."],
    ["Про «{home}» что говорят?", "Что у нас лучший товар в округе. Сам слышал, не вру."],
    ["Обратно что привезли?", "{cheap}, да немного {need}. Всё на складе, к вечеру перепишу."],
    ["Пошлину брали?", "Брали, правитель. С каждого тюка по монете. Грабёж, но законный."],
    ["Чужие караваны встречали?", "Встретили караван «{destf}». Разошлись мирно, даже табаком угостили."],
    ["Транспорт цел?", "Обшивку на днище подлатать надо. Мастеру уже сказал."],
    ["Звали ли нас ещё?", "Звали. В следующий раз, говорят, везите больше: {goods} у них нарасхват."],
    ["Дорога годна для следующего похода?", "Через перевал - да. Вдоль реки не ходите: топко и неспокойно."],
    ["С тобой их правитель говорил?", "Говорил. Расспрашивал о наших запасах. Я сказал ровно столько, сколько надо."],
]
const FR_RULER_NOD = ["Так.", "Понятно.", "Запомню.", "Добро.", "Ишь ты.", "Хм. Дальше.", "Это хорошо.", "Это плохо."]

// Наказ уходящему торговцу. {dest2}/{destf2} - куда, {via} - другие поселения округи по пути,
// {goods2} - что продать, {need2} - что купить, {back} - к какому дню вернуться.
const FR_ORDERS = [
    "Летишь в «{dest2}», это земли «{destf2}». По пути загляни в {via}. Продашь {goods2}, купишь {need2}. Вернись к {back}-му дню.",
    "Твой путь - «{dest2}». Туда - {goods2}, оттуда - {need2}. Если там не возьмут, иди дальше: {via}. К {back}-му дню жду.",
    "Слушай. «{dest2}» просит {goods2} - вези. Нам нужны {need2}, у них есть. Если дорогу закроют - сворачивай на {via}. Вернёшься к {back}-му.",
    "Пойдёшь в «{dest2}», к «{destf2}». Продай {goods2} не дешевле, чем в прошлый раз, а на выручку возьми {need2}. Обратно - через {via}, к {back}-му дню.",
]
const FR_ORDER_ASK = [
    "А охрану сколько брать?", "Если цены упадут - продавать?", "А если там опять неспокойно?", "Кого за старшего в охране?",
]
const FR_ORDER_ANSWER = [
    "Сколько всегда. И чтоб трезвые.", "Не продавай себе в убыток. Лучше привези обратно.",
    "Тогда не рискуй. Товар - дело наживное, люди - нет.", "Того, кто в прошлый раз вернулся. Ему верю.",
]

// Охрана своего каравана дома: о доме, жаловании, усталости. {home}, {ruler}, {dest}.
const FR_HOME_TALK = [
    ["Дома... Даже воздух другой.", "Воздух как воздух. Навозом пахнет.", "Вот я и говорю - родной навоз."],
    ["Слышал? Жалование подняли.", "На сколько?", "На две монеты.", "Разбогатеем. Лет через сто."],
    ["Первым делом - в баню.", "Первым делом - к жене.", "А потом в баню.", "Потом уже не успеешь."],
    ["Тяжёлый был поход.", "Тяжёлый. Но дома всё забывается.", "Кроме спины. Спина помнит."],
    ["Как думаешь, {ruler} доволен?", "Раз не ругается - доволен.", "Он и довольный хмурый."],
    ["В «{home}» хоть кормят по-человечески.", "Это точно. Не то что в «{dest}».", "Там суп был из одних обещаний."],
    ["Опять завтра в дорогу?", "Не нам. Другой торговец полетит.", "Слава богам. Хоть высплюсь."],
    ["Глянь, частокол подлатали, пока нас не было.", "И колокол во дворе повесили.", "Растём, значит."],
    ["Мать у меня тут, у восточной тропы.", "Сходишь вечером?", "Схожу. Если сержант отпустит."],
    ["Скучал по здешней каше.", "По каше? Ты в своём уме?", "Ты в «{dest}» кашу не ел."],
    ["Говорят, доплатят за риск.", "Говорят много чего.", "А вдруг?", "Вдруг бывает только у торговцев."],
    ["Ноги отваливаются.", "Посиди у костра во дворе.", "Нам в форт нельзя, мы на страже.", "Вот и стой тогда."],
    ["Здесь хоть спать можно спокойно.", "Свои стены - не чужие.", "И свои воры - не чужие.", "Это да."],
    ["Ты весь поход ворчал, что дома лучше.", "И был прав.", "Ты и дома ворчишь.", "Дома - по-домашнему."],
    ["Сколько нам тут стоять?", "Сутки, пока торговец своё распродаст.", "Сутки дома - уже праздник."],
    ["В «{dest}» на нас смотрели как на чужаков.", "А тут каждая собака знает.", "Вон та меня в прошлый раз укусила.", "Значит, помнит."],
    ["Вернусь - женюсь.", "Ты каждый поход так говоришь.", "В этот раз точно.", "И невеста в этот раз другая."],
    ["Бард вечером будет играть?", "У костра в форте. Отстоишь караул - послушаешь.", "Если не усну стоя."],
    ["Хорошо, что живыми вернулись.", "Хорошо. Не все в этом году вернулись.", "Помолчим."],
    ["Пиво тут дешевле, чем в «{dest}».", "И лучше.", "И ближе.", "Главное - ближе."],
    ["Слышал, {ruler} новый караван снаряжает.", "Пусть снаряжает. Лишь бы не нас.", "Нас всегда."],
    ["Жалование когда дадут?", "Как торговец расторгуется.", "Значит, завтра.", "Значит, когда-нибудь."],
]

/** Несколько настоящих поселений округи (кроме своего и пункта назначения): «А», «Б» и «В». */
function frViaList(level, village, skipId, n) {
    var near = []
    try { near = global.TFG_WORLD.near(level, village.x, village.z, FR_DEST_R, true) } catch (e) { }
    var own = sgSiteOf(village)
    var names = near.filter(x => (!own || x.site.id !== own.id) && x.site.id !== skipId && x.site.state !== "нет площадки в ячейке")
        .slice(0, 12).map(x => "«" + x.site.name + "»")
    var out = []
    while (names.length && out.length < (n || 2)) out.push(names.splice(Math.floor(Math.random() * names.length), 1)[0])
    if (!out.length) return "соседние сёла"
    return out.length === 1 ? out[0] : out.slice(0, -1).join(", ") + " и " + out[out.length - 1]
}

function frFacName(id) {
    try { var f = global.TFG_FACTIONS.list.filter(x => x.id === id)[0]; if (f) return String(f.name) } catch (e) { }
    return id || "чужих"
}

/**
 * Место аудиенции - у костра во дворе крепости (settlers.js ставит его и зажигает, пока идёт
 * беседа); костра нет - середина двора.
 */
function frMeet(village, fort, now) {
    var y = village.yard
    if (y && y.fire) {
        y.meetUntil = now + 400                              // огонь горит, пока идёт сцена
        return { x: y.fire.x + 0.5, z: y.fire.z + 0.5 }
    }
    return { x: fort ? fort.inside.x + 0.5 : village.x + 0.5, z: fort ? fort.inside.z + 0.5 : village.z + 0.5 }
}

/**
 * Своя дружина на аудиенции - у костра: полукругом по обе стороны от правителя и воеводы
 * (они стоят друг против друга вдоль оси x), каждый на своём месте.
 */
function frGuardsAround(level, guards, cx, cz, fighting, late) {
    var slots = [3.141592653589793 / 2, -3.141592653589793 / 2, 3.141592653589793 / 2 - 0.55, 3.141592653589793 / 2 + 0.55, -3.141592653589793 / 2 + 0.55, -3.141592653589793 / 2 - 0.55,
        3.141592653589793 / 2 - 1.05, 3.141592653589793 / 2 + 1.05, -3.141592653589793 / 2 + 1.05, -3.141592653589793 / 2 - 1.05]
    guards.forEach((g, i) => {
        if (!g || fighting[String(g.uuid)]) return
        var a = slots[i % slots.length], r = 4.5 + Math.floor(i / slots.length) * 1.5
        frPlace(level, g, cx + Math.cos(a) * r, cz + Math.sin(a) * r, cx, cz, late)
    })
}

/** Охрана каравана - у ворот форта снаружи: в форт посторонние не заходят. */
function frGuardsAtGate(level, village, guards, bodyguard, fighting, late) {
    var fort = seFortSpot(village)
    if (!fort) return
    var gx = fort.inside.x - fort.gate.x, gz = fort.inside.z - fort.gate.z
    var out = Math.abs(gx) >= Math.abs(gz) ? { dx: gx > 0 ? -1 : 1, dz: 0 } : { dx: 0, dz: gz > 0 ? -1 : 1 }
    var list = guards.slice()
    list.forEach((g, i) => {
        if (!g || fighting[String(g.uuid)]) return
        var side = (i % 2 ? 1 : -1) * (2 + Math.floor(i / 2) * 2)
        var x = fort.gate.x + 0.5 + out.dx * 4 + (out.dx ? 0 : side)
        var z = fort.gate.z + 0.5 + out.dz * 4 + (out.dz ? 0 : side)
        frPlace(level, g, x, z, x + out.dx * 5, z + out.dz * 5, late)
    })
}

function frHomeTick(v, level, now, trader, guards, rt, fighting, village) {
    var c = frCaravans(village).filter(x => x.id === v.homecoming)[0]
    if (!c) return false
    var f = v.fair
    var fort = seFortSpot(village)
    var meet = frMeet(village, fort, now)                 // у костра во дворе крепости
    var cx = meet.x, cz = meet.z
    var ents = []
    try { ents = seEntities(level, village) } catch (e) { }
    var ruler = ents.filter(e => seRoleOf(e) === "правитель")[0] || null
    var bodyguard = guards.filter(g => String(g.persistentData.getString("tfg_guest_role")) === "bodyguard")[0] || null
    var next = f.nextSid ? ents.filter(e => seSidOf(e) === f.nextSid)[0] || null : null
    var late = now - (f.stageAt || f.at) > FR_GATHER_MAX
    var L = FR_HOME_LINES
    var fill = (pool) => frFill(frPick(pool), f.ctx || {})
    var talking = f.stage === "сбор" || f.stage === "доклад" || f.stage === "вызов" || f.stage === "наказ"
    if (talking && ruler) FR_HOLD[String(ruler.uuid)] = now + 100
    if (talking && next) FR_HOLD[String(next.uuid)] = now + 100
    var cast = { ruler: ruler, guest: trader, next: next }

    // ── 1. сбор: правитель и глава каравана - в форт; охрана - у ворот снаружи ──
    if (f.stage === "сбор") {
        frGuardsAtGate(level, village, guards, bodyguard, fighting, late)
        var ready = frPlace(level, ruler, cx + 2, cz, cx, cz, late)
        ready = frPlace(level, trader, cx - 2, cz, cx, cz, late) && ready
        if (!ready && !late) return true
        var o = frOutcome(village, c)
        var kinds = FR_CARAVAN_KINDS.filter(k => k !== c.kind)
        var site = c.dest ? (function () { try { return global.TFG_WORLD.byId(c.dest.id) } catch (e) { return null } })() : null
        var rulerRec = village.settlers.filter(s => s.role === "правитель" && !s.dead && !s.replaced)[0]
        f.outcome = o
        f.ctx = {
            leader: c.leader, dest: c.dest ? c.dest.name : "дальних краёв", destf: frFacName(c.dest ? c.dest.faction : null),
            money: o.money, goods: FR_GOODS[c.kind] || "товар", need: frPick(FR_NEEDS),
            cheap: FR_GOODS[frPick(kinds)] || "железо", dear: FR_GOODS[frPick(kinds)] || "соль",
            days: Math.max(2, (c.back || trToday()) - (c.out || trToday() - 4)), home: sgName(village),
            ruler: rulerRec ? rulerRec.name : "правитель",
        }
        if (site && site.people && site.people.ruler) f.ctx.destRuler = site.people.ruler.name
        // доклад: приветствие, шесть разных вопросов с ответами, итог и слово правителя
        var pairs = FR_AUDIENCE.map((p, i) => i)
        var chosen = []
        while (chosen.length < FR_AUDIENCE_PAIRS && pairs.length) chosen.push(pairs.splice(Math.floor(Math.random() * pairs.length), 1)[0])
        var lines = [{ who: "ruler", text: fill(L.greet) }]
        chosen.forEach(k => {
            lines.push({ who: "ruler", text: frFill(FR_AUDIENCE[k][0], f.ctx) })
            lines.push({ who: "guest", text: frFill(FR_AUDIENCE[k][1], f.ctx) })
            if (Math.random() < 0.4) lines.push({ who: "ruler", text: frPick(FR_RULER_NOD) })
        })
        lines.push({ who: "guest", text: fill(L[o.kind]) })
        lines.push({ who: "guest", text: fill(L[o.hard ? "hard" : "easy"]) })
        lines.push({ who: "ruler", text: fill(L["ruler_" + o.kind]) })
        lines.push({ who: "ruler", text: "Сутки отдыхай и торгуй у свободного прилавка. Завтра решим, кто полетит дальше." })
        f.lines = lines
        f.i = 0
        f.stage = "доклад"
        f.stageAt = now
        f.next = now
        gsSave()
        return true
    }
    // ── 2. доклад ──
    if (f.stage === "доклад") {
        frGuardsAtGate(level, village, guards, bodyguard, fighting, false)
        frPlace(level, ruler, cx + 2, cz, cx, cz, false)
        frPlace(level, trader, cx - 2, cz, cx, cz, false)
        if (now < f.next) return true
        frQuiet(f, cast)
        while (f.i < f.lines.length && !cast[f.lines[f.i].who]) f.i++
        if (f.i >= f.lines.length) {
            frReturn(village, c, f.outcome)
            f.stage = "торг"
            f.stageAt = now
            f.tradeFrom = now
            v.until = now + FR_HOME_DAY + 12000           // визит не кончится раньше наказа
            gsSave()
            return true
        }
        var line = f.lines[f.i++]
        frSpeak(cast[line.who], line.text, line.who === "ruler")
        if (line.who === "guest") f.lastGuest = "guest"
        f.next = now + FR_LINE_TICKS + line.text.length
        return true
    }
    // ── 3. сутки дома: глава у свободного прилавка, охрана живёт своим (говорит о доме) ──
    if (f.stage === "торг") {
        frQuiet(f, cast)
        var stall = null
        try { stall = global.TFG_FORT_YARD.caravanStall(village.id) } catch (e) { }
        if (trader && stall) {
            var sx = stall.stand.x + 0.5, sz = stall.stand.z + 0.5
            frPlace(level, trader, sx, sz, sx + stall.front.dx * 4, sz + stall.front.dz * 4, now - f.stageAt > FR_GATHER_MAX)
        }
        if (bodyguard && trader && !fighting[String(bodyguard.uuid)]) frGuardsAtGate(level, village, [bodyguard], bodyguard, fighting, false)
        if (now - f.tradeFrom < FR_HOME_DAY) return false   // охрана - обычными занятиями (темы - домашние)
        var rec = frFreeTrader(village)
        var dest2 = rec ? frDest(level, village) : null
        if (!dest2) rec = null
        f.nextSid = rec ? rec.id : null
        f.dest2 = dest2
        var back = trToday() + (dest2 ? Math.min(FR_TRAVEL_MAX, FR_TRAVEL_MIN + Math.round(dest2.dist / 2500)) : 5)
        f.ctx.trader = rec ? rec.name : ""
        f.ctx.dest2 = dest2 ? dest2.name : ""
        f.ctx.destf2 = dest2 ? frFacName(dest2.faction) : ""
        f.ctx.via = frViaList(level, village, dest2 ? dest2.id : null, 2)
        f.ctx.goods2 = FR_GOODS[rec && rec.trade ? rec.trade : c.kind] || "товар"
        f.ctx.need2 = frPick(FR_NEEDS)
        f.ctx.back = back
        var ask = Math.floor(Math.random() * FR_ORDER_ASK.length)
        f.lines = rec
            ? [{ who: "ruler", text: fill(L.call) }, { who: "ruler", text: frFill(frPick(FR_ORDERS), f.ctx) },
               { who: "next", text: FR_ORDER_ASK[ask] }, { who: "ruler", text: FR_ORDER_ANSWER[ask] },
               { who: "next", text: fill(L.reply) }, { who: "next", text: fill(L.off) }]
            : [{ who: "ruler", text: fill(L.no_trader) }]
        f.i = 0
        f.stage = "вызов"
        f.stageAt = now
        f.next = now
        gsSave()
        return true
    }
    // ── 4. вызов и наказ: правитель и уходящий торговец в форте ──
    if (f.stage === "вызов" || f.stage === "наказ") {
        var lateN = now - f.stageAt > FR_GATHER_MAX
        var r1 = frPlace(level, ruler, cx + 2, cz, cx, cz, lateN)
        var r2 = next ? frPlace(level, next, cx - 2, cz, cx, cz, lateN) : true
        if (f.stage === "вызов") {
            if (!(r1 && r2) && !lateN) return true
            f.stage = "наказ"
            f.next = now
        }
        if (now < f.next) return true
        while (f.i < f.lines.length && !cast[f.lines[f.i].who]) f.i++
        if (f.i >= f.lines.length) {
            var rec2 = f.nextSid ? village.settlers.filter(s => s.id === f.nextSid)[0] : null
            if (rec2 && f.dest2) {
                // Меняются местами: прибывший глава остаётся жить в поселении - на койке и у
                // прилавка уезжающего, со своим ремеслом; уезжающий становится главой этого
                // же каравана и улетает с его охраной.
                var arrived = { name: c.leader, kind: c.kind }
                c.master = rec2.name
                c.kind = rec2.trade || c.kind
                frDepart(village, c, f.dest2, null)
                rec2.name = arrived.name
                rec2.trade = arrived.kind
                rec2.female = SE_NAMES_F.indexOf(arrived.name) >= 0
                delete rec2.voice                              // другой человек - свой голос
                delete rec2.away
                f.swap = rec2.id
                seSave()
                frLog(sgName(village) + ": " + arrived.name + " остаётся в поселении, " + c.master + " ведёт караван в «" + f.dest2.name + "»")
            }
            f.stage = "отлёт"
            f.stageAt = now
            gsSave()
            return true
        }
        var ln = f.lines[f.i++]
        frSpeak(cast[ln.who], ln.text, true)
        f.next = now + FR_LINE_TICKS + ln.text.length
        return true
    }
    // ── 5. отлёт: прежний глава уходит домой, новый торговец с охраной - к транспорту ──
    if (f.stage === "отлёт") {
        if (trader) {
            frPlace(level, trader, village.x + 0.5, village.z + 0.5, village.x, village.z, false)
            if (!gsSeen(level, trader) || now - f.stageAt > 1200) { try { trader.discard() } catch (e) { } }
        }
        if (next) {
            FR_HOLD[String(next.uuid)] = now + 100            // идёт к транспорту, а не к своей лавке
            var gx = v.arrive.x + 0.5, gz = v.arrive.z + 0.5
            var at = frPlace(level, next, gx, gz, gx, gz, false)
            if (at || now - f.stageAt > 900) {
                try { next.discard() } catch (e) { }
                var r3 = village.settlers.filter(s => s.id === f.nextSid)[0]
                // поменялись местами - у этой койки теперь живёт прибывший: он и появится
                if (r3) { if (f.swap === r3.id) r3.newcomer = true; else r3.goneBody = true; seSave() }
                next = null
            }
            if (next) return true
        }
        f.stage = "свободно"
        v.until = now                                       // охрана грузится и улетает
        gsSave()
        return false
    }
    return false
}

/** Домашний разговор охраны своего каравана (вместо разговоров о чужом поселении). */
function frHomeTalk(v) {
    var village = null
    try { village = seLoad().villages[v.settlement] } catch (e) { }
    var c = village ? frCaravans(village).filter(x => x.id === v.homecoming)[0] : null
    var rulerRec = village ? village.settlers.filter(s => s.role === "правитель" && !s.dead && !s.replaced)[0] : null
    var ctx = {
        home: village ? sgName(village) : "дома", ruler: rulerRec ? rulerRec.name : "правитель",
        dest: c && c.dest ? c.dest.name : "чужих краях",
    }
    var hi = typeof gsPickFreshIndex === "function" ? gsPickFreshIndex(FR_HOME_TALK.length, "home") : Math.floor(Math.random() * FR_HOME_TALK.length)
    return FR_HOME_TALK[hi].map(s => frFill(s, ctx))
}
// ─── Прилёт своей дружины ────────────────────────────────────────────────────
//
// Воины поселения (те, кто ходит в рейды от его имени) прилетают погостить и за новым
// заданием. Воевода идёт к правителю к костру во дворе крепости, дружина стоит у ворот.
// Правитель отмечает заслуги, расспрашивает об успехах, обсуждают жалование, и он выдаёт
// новое задание - одно из FR_WAR_TASKS, не всегда захватническое; места и фракции - из
// настоящего мира. Потом полсуток отдыха дома (разговоры дружины - о доме и жаловании),
// и отряд улетает. Запуск: /tfgfair воины; сам - изредка, когда рядом игрок.

const FR_WAR_STAY = 12000            // полсуток дружина отдыхает дома
const FR_WAR_CHANCE = 0.06           // шанс в сутки, что дружина прилетит сама (если рядом игрок)
const FR_WAR_QA_N = 4                // столько вопросов об успехах задаёт правитель

const FR_WAR_GREET = ["{leader}! Добро пожаловать домой, воины.", "А вот и наша дружина. Подходи к огню, {leader}.",
    "Слава о вас дошла раньше вас, {leader}.", "Живы, все при оружии. Хорошо. Садись, {leader}, рассказывай."]
const FR_WAR_PRAISE = ["За {deed} - низкий поклон от всего «{home}».", "Вы славно потрудились: {deed}. Поселение это помнит.",
    "Люди говорят о вас у костров. {deed} - не каждому по силам.", "{deed} - вот за это я вас и держу."]
const FR_WAR_DEEDS = ["разбитых разбойников на перевале", "караван, который вы довели целым", "отбитый хутор у реки",
    "разведку северных земель", "то, что вернулись все до одного", "стену, которую вы удержали у соседей"]
// вопрос правителя - ответ воеводы. {site}/{sitef} - настоящее поселение округи и его фракция,
// {hero} - отличившийся, {trophy} - трофеи, {days} - дней в пути, {biome} - край у «{site}»
const FR_WAR_QA = [
    ["Скольких потеряли?", "Ни одного, правитель. Двоих ранили, уже на ногах."],
    ["Трофеи есть?", "Есть: {trophy}. Сложили на склад у ворот."],
    ["Кто держался лучше всех?", "{hero}. Первым пошёл на стену и последним ушёл."],
    ["Враг силён?", "Числом - да. Выучкой - нет. Бегут, как только строй ломается."],
    ["Пленных брали?", "Двоих. Отпустили за выкуп, как ты велел."],
    ["Что видели в пути?", "Сожжённый хутор у «{site}». Чьих рук дело - не знаем, но следы ведут на {dir}."],
    ["Оружие цело?", "Мечи - да. Щиты под замену, половина в трещинах."],
    ["Кормились чем в дороге?", "Сами себя кормили. Охотники у нас толковые."],
    ["Слухи о нас ходят?", "Ходят. Разбойники нашу метку издалека узнают и сворачивают."],
    ["Чужие отряды встречали?", "Отряд «{sitef}» у «{site}». Разошлись, никто и не дёрнулся."],
    ["Порядок в отряде держали?", "Один напился в «{site}». Отработал позором и лишним караулом."],
    ["Сколько дней были в пути?", "{days}, без малого. Кони устали больше нас."],
    ["Что скажешь о землях у «{site}»?", "Край {biome}. Земля добрая, но людей мало - защищать некому."],
    ["Есть, кого наградить особо?", "{hero}. Вынес раненого из-под стрел. Прошу за него."],
    ["Враг вернётся?", "Вернётся. Но не скоро и не теми силами."],
    ["Деньги от похода остались?", "Немного. Сдадим в казну. Почти всё."],
]
// разговор о жаловании: воевода, правитель, воевода, правитель
const FR_WAR_PAY = [
    ["Правитель, о жаловании. Люди просят прибавки.", "Сколько?", "По {raise} монеты на брата.", "Дам. Заслужили."],
    ["Жалование задержали на неделю.", "Знаю. Караван ещё не расторговался.", "Люди ропщут.", "Завтра заплачу. Слово правителя."],
    ["За раненых доплата будет?", "Будет. Лекарю - за мой счёт.", "Спасибо, правитель.", "Не мне спасибо - казне."],
    ["Сколько нам за прошлый поход?", "По {pay} монет каждому и бочка пива на всех.", "С пивом ты угадал.", "Я всегда угадываю."],
    ["Новичкам платить, как всем?", "Как всем - после первого похода.", "Справедливо.", "Потому и держимся."],
    ["Правитель, люди хотят жалование вперёд.", "Вперёд не плачу никому.", "Хоть половину?", "Треть. И не проси больше."],
]
// задания: что велит правитель и зачем. {site}/{sitef} - настоящее поселение и его фракция,
// {dir} - сторона света, {biome} - край, {days} - дней пути, {goods} - товар, {rivalf} - соперник
const FR_WAR_TASKS = [
    { short: "сопроводить караван", text: "Наш караван идёт в «{site}». Сопроводите его туда и обратно.", why: "На той дороге неспокойно, а везём мы {goods}." },
    { short: "разведать земли", text: "Разведайте земли на {dir} от нас, за «{site}». Там {biome} край.", why: "Нам нужны новая пашня и лес, а карты у нас старые." },
    { short: "стеречь сделку", text: "В «{site}» сделка: покупаем {goods}. Явитесь и стерегите, пока не ударят по рукам.", why: "Сделка большая, а к «{sitef}» гости ходят всякие." },
    { short: "помочь союзникам", text: "«{site}» просит помощи: на них наседают разбойники. Идите и помогите.", why: "Сегодня мы им - завтра они нам." },
    { short: "очистить дорогу", text: "Пройдите дорогой до «{site}» и обратно. Где засели разбойники - выбейте.", why: "Купцы боятся ходить, торговля стоит." },
    { short: "убить зверя", text: "У «{site}» завёлся зверь, режет скот. Найдите и убейте.", why: "Люди просят. А нам их зерно нужно." },
    { short: "разведать соседа", text: "Узнайте, сколько бойцов у «{rivalf}». Тихо, без драки.", why: "Хочу знать, чего от них ждать, прежде чем решать." },
    { short: "отвезти письмо", text: "Отвезите письмо правителю «{site}» и дождитесь ответа.", why: "Дело тонкое, простому гонцу не доверю." },
    { short: "стеречь поселение", text: "Останьтесь дома неделю. Стрелки на сборах, стены пустые.", why: "Без вас «{home}» - лёгкая добыча." },
    { short: "обучить дружину", text: "Обучите нашу дружину строю. Хоть азам.", why: "Дружинники смелые, но бьют вразнобой." },
    { short: "сопроводить посла", text: "Наш посол идёт в «{site}». Ведите его и стерегите.", why: "От этих переговоров зависит мир с «{sitef}»." },
    { short: "найти пропавшего", text: "Пропал наш лесоруб у «{site}». Найдите - живого или нет.", why: "У него трое детей. Я обещал вдове ответ." },
    { short: "удержать жилу", text: "У «{site}» нашли рудную жилу. Займите место и держите, пока не придут шахтёры.", why: "Не мы - так «{rivalf}» заберут." },
    { short: "занять поселение", text: "«{site}» слабеет, их правитель ничего не держит. Займите его, без лишней крови.", why: "Земли там добрые, а люди устали от безвластия." },
    { short: "наказать разбойников", text: "Разбойники, что сожгли хутор, сидят у «{site}». Выкурите их.", why: "Чтобы другим неповадно было." },
    { short: "напомнить о долге", text: "«{site}» задолжали нам за прошлый караван. Напомните. Вежливо.", why: "Слово дали - пусть держат." },
    { short: "осмотреть руины", text: "На {dir} от нас, в {days} днях пути, стоят старые руины. Посмотрите, что там.", why: "Говорят, там железо лежит прямо под ногами." },
    { short: "встретить беженцев", text: "Из «{site}» к нам идут беженцы. Встретьте и доведите.", why: "Новые руки нам нужны, а дорога опасная." },
    { short: "выступить на турнире", text: "В «{site}» турнир. Выставьте лучших - пусть знают, чьи мы.", why: "Слава - тоже оружие." },
    { short: "поставить дозор", text: "Поставьте дозорную вышку на дороге в «{site}».", why: "Хочу видеть, кто к нам идёт, за день до того, как придёт." },
    { short: "отдыхать", text: "А теперь - отдыхайте. Неделю никуда.", why: "Уставший меч тупится быстрее." },
]
const FR_WAR_ASK = ["Сколько людей брать?", "Когда выступать?", "А если там бой?", "Награда какая?", "Кто старший над нами там?"]
const FR_WAR_ANSWER = ["Всех, кого не ранили.", "Как отдохнёте - через полсуток.", "Тогда бейтесь, но людей берегите.",
    "Двойное жалование по возвращении.", "Ты, {leader}. Как всегда."]
const FR_WAR_REPLY = ["Сделаем, правитель.", "Будет исполнено.", "Слово дружины.", "Не подведём."]
// разговоры дружины дома
const FR_WAR_TALK = [
    ["Дома и стены теплее.", "Стены как стены.", "Свои - теплее."],
    ["Жалование, говорят, прибавят.", "Говорят каждый поход.", "В этот раз правитель сам обещал."],
    ["Рука ещё ноет после того боя.", "Покажи лекарю.", "Лекарь скажет - не маши мечом.", "А ты маши потише."],
    ["Опять куда-то пошлют.", "На то мы и дружина.", "Дружина тоже спать хочет."],
    ["В «{home}» хоть пиво честное.", "Не то что там, откуда мы.", "Там его водой разбавляли.", "Там и воду разбавляли."],
    ["{ruler} нами доволен?", "Раз зовёт к огню - доволен.", "А если бы не был?", "Звал бы к колоколу."],
    ["Видел, как на нас смотрят?", "Как на героев.", "Как на тех, кто съест всё в погребе.", "И это тоже."],
    ["Мой щит опять треснул.", "Отдай кузнецу.", "Кузнец сказал - новый дешевле.", "Значит, новый."],
    ["Сколько нам тут стоять?", "Полсуток, потом снова в путь.", "Полсуток дома - уже праздник."],
    ["Помнишь того, у переправы?", "Помню. Хороший был боец.", "Выпьем за него вечером.", "Выпьем."],
    ["Новенький наш - ничего так.", "В первом бою не побежал.", "Значит, приживётся."],
    ["Жена говорит - бросай службу.", "А ты?", "А я говорю - а жалование кто принесёт?", "Резонно."],
]
const FR_WAR_TROPHY = ["два ящика стрел и разбойничьи топоры", "трофейные кольчуги, чинить их и чинить", "лошадь с полным вьюком",
    "мешок медяков и чужое знамя", "оружие, что не пропили"]
const FR_WAR_HERO = ["Молодой Ратша", "Твердислав", "Мирон Косой", "Ждан", "Остромир", "Белослава"]
const FR_DIRS = ["север", "северо-восток", "восток", "юго-восток", "юг", "юго-запад", "запад", "северо-запад"]

function frDirTo(dx, dz) {
    var a = Math.atan2(dx, -dz)                              // 0 - север, по часовой
    var k = Math.round(a / (3.141592653589793 / 4))
    return FR_DIRS[((k % 8) + 8) % 8]
}

/** Настоящее поселение округи для заданий и рассказов: имя, фракция, край, сторона, дни пути. */
function frWarSite(level, village) {
    var near = []
    try { near = global.TFG_WORLD.near(level, village.x, village.z, FR_DEST_R, true) } catch (e) { }
    var own = sgSiteOf(village)
    var list = near.filter(n => (!own || n.site.id !== own.id) && n.site.state !== "нет площадки в ячейке").slice(0, 10)
    if (!list.length) return { name: "соседнее село", faction: null, biome: "лесистый", dir: "север", days: 3 }
    var n = frPick(list)
    var s = n.site
    var biome = String(s.biome || "")
    var land = /mountain|highland|plateau/.test(biome) ? "горный" : /ocean|shore|beach|sea/.test(biome) ? "приморский"
        : /lake|river/.test(biome) ? "речной" : /marsh|swamp|bog/.test(biome) ? "болотистый" : /canyon|badland/.test(biome) ? "каменистый" : "равнинный"
    return { name: s.name, faction: s.faction, biome: land, dir: frDirTo(s.x - village.x, s.z - village.z), days: Math.max(2, Math.round(n.dist / 2500) + 1) }
}

/** Воевода и дружина прилетают в поселение. Текст ошибки или null. */
function frWarband(level, village) {
    if (village.state !== "мир") return "в поселении не мир"
    if (typeof sgActiveFor === "function" && sgActiveFor(village.id)) return "поселение в осаде"
    if (frActiveFor(village.id)) return "в поселении уже гости"
    var fort = seFortSpot(village)
    var cx = fort ? fort.gate.x : village.x, cz = fort ? fort.gate.z : village.z, cy = 70
    try { cy = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", cx, cz)) } catch (e) { }
    try {
        var gsp = global.TFG_GROUND_SPOT(level, cx, cz, 12)
        if (gsp) { cx = Math.floor(gsp.x); cz = Math.floor(gsp.z); cy = gsp.y }
    } catch (e) { }
    var tier = typeof SE_TRADE_TIER === "number" ? SE_TRADE_TIER : 4
    sgPlayers(village, FR_NEAR).forEach(p => { try { tier = Math.max(tier, Number(global.TFG_PLAYER_TIER(p)) || 1) } catch (e) { } })
    var err = gsVisit(level, { x: cx, y: cy, z: cz }, village.faction, "weaponsmith", Math.min(10, tier),
        { settlement: village.id, name: sgName(village), warband: true })
    if (err) return err
    var data = frLoad()
    if (!data.warbands) data.warbands = {}
    var wb = data.warbands[village.id]
    if (!wb) wb = data.warbands[village.id] = { leader: seName("рыцарь", false), trips: 0, last: null }
    try {
        var e = TR_LAST_ENTITY
        var pd = e.persistentData
        pd.remove("tfg_npc_id")
        pd.putString("tfg_npc_name", wb.leader)
        pd.putString("tfg_title_override", wb.leader + " · Рыцарь-воевода · " + frFacName(village.faction))
        pd.putString("tfg_voice_id", "m5")                    // воевода - бас
        gsRestoreName(e)
    } catch (e2) { frErr("имя воеводы", e2) }
    frSave()
    frLog(sgName(village) + ": прилетает дружина воеводы " + wb.leader)
    return null
}

function frWarTick(v, level, now, leader, guards, rt, fighting, village) {
    var f = v.fair
    var fort = seFortSpot(village)
    var meet = frMeet(village, fort, now)
    var cx = meet.x, cz = meet.z
    var ents = []
    try { ents = seEntities(level, village) } catch (e) { }
    var ruler = ents.filter(e => seRoleOf(e) === "правитель")[0] || null
    var bodyguard = guards.filter(g => String(g.persistentData.getString("tfg_guest_role")) === "bodyguard")[0] || null
    var late = now - (f.stageAt || f.at) > FR_GATHER_MAX
    var cast = { ruler: ruler, guest: leader }
    var data = frLoad()
    var wb = (data.warbands || {})[village.id] || { leader: "воевода", trips: 0, last: null }
    var talking = f.stage === "сбор" || f.stage === "доклад"
    if (talking && ruler) FR_HOLD[String(ruler.uuid)] = now + 100

    if (f.stage === "сбор") {
        frGuardsAround(level, guards, cx, cz, fighting, late)
        var ready = frPlace(level, ruler, cx + 2.5, cz, cx, cz, late)
        ready = frPlace(level, leader, cx - 2.5, cz, cx, cz, late) && ready
        if (!ready && !late) return true
        var site = frWarSite(level, village)
        var site2 = frWarSite(level, village)
        var rulerRec = village.settlers.filter(s => s.role === "правитель" && !s.dead && !s.replaced)[0]
        var rival = null
        try {
            var foes = global.TFG_FACTIONS.list.filter(x => x.id !== "bandits" && x.id !== village.faction)
            rival = foes.length ? frPick(foes) : null
        } catch (e) { }
        var task = frPick(FR_WAR_TASKS)
        f.ctx = {
            leader: wb.leader, home: sgName(village), ruler: rulerRec ? rulerRec.name : "правитель",
            deed: wb.last ? wb.last : frPick(FR_WAR_DEEDS), site: site.name, sitef: frFacName(site.faction), biome: site.biome,
            dir: site.dir, days: site.days, hero: frPick(FR_WAR_HERO), trophy: frPick(FR_WAR_TROPHY),
            raise: 1 + Math.floor(Math.random() * 3), pay: 20 + 5 * Math.floor(Math.random() * 7),
            goods: FR_GOODS[frPick(FR_CARAVAN_KINDS)] || "товар", rivalf: rival ? String(rival.name) : "соседей",
        }
        // задание - про другое поселение, чем рассказ о походе
        var tctx = {}
        for (var k in f.ctx) tctx[k] = f.ctx[k]
        tctx.site = site2.name; tctx.sitef = frFacName(site2.faction); tctx.biome = site2.biome; tctx.dir = site2.dir; tctx.days = site2.days
        var fill = (s, c) => frFill(s, c || f.ctx)
        var lines = [{ who: "ruler", text: fill(frPick(FR_WAR_GREET)) }, { who: "ruler", text: fill(frPick(FR_WAR_PRAISE)) }]
        var qa = FR_WAR_QA.map((x, i) => i), pickQa = []
        while (pickQa.length < FR_WAR_QA_N && qa.length) pickQa.push(qa.splice(Math.floor(Math.random() * qa.length), 1)[0])
        pickQa.forEach(i => {
            lines.push({ who: "ruler", text: fill(FR_WAR_QA[i][0]) })
            lines.push({ who: "guest", text: fill(FR_WAR_QA[i][1]) })
            if (Math.random() < 0.35) lines.push({ who: "ruler", text: frPick(FR_RULER_NOD) })
        })
        var pay = frPick(FR_WAR_PAY)
        pay.forEach((s, i) => lines.push({ who: i % 2 === 0 ? "guest" : "ruler", text: fill(s) }))
        lines.push({ who: "ruler", text: "Теперь о деле. " + fill(task.text, tctx) })
        lines.push({ who: "ruler", text: fill(task.why, tctx) })
        var ask = Math.floor(Math.random() * FR_WAR_ASK.length)
        lines.push({ who: "guest", text: FR_WAR_ASK[ask] })
        lines.push({ who: "ruler", text: fill(FR_WAR_ANSWER[ask]) })
        lines.push({ who: "guest", text: frPick(FR_WAR_REPLY) })
        f.lines = lines
        f.i = 0
        f.task = { short: task.short, site: tctx.site }
        f.stage = "доклад"
        f.stageAt = now
        f.next = now
        gsSave()
        return true
    }
    if (f.stage === "доклад") {
        frGuardsAround(level, guards, cx, cz, fighting, false)
        frPlace(level, ruler, cx + 2.5, cz, cx, cz, false)
        frPlace(level, leader, cx - 2.5, cz, cx, cz, false)
        if (now < f.next) return true
        frQuiet(f, cast)
        while (f.i < f.lines.length && !cast[f.lines[f.i].who]) f.i++
        if (f.i >= f.lines.length) {
            wb.trips = (wb.trips || 0) + 1
            wb.last = f.task.short === "отдыхать" ? null : f.task.short + (f.task.site ? " у «" + f.task.site + "»" : "")
            if (!data.warbands) data.warbands = {}
            data.warbands[village.id] = wb
            frSave()
            try { sgEvent(village, "дружина", "прилетала дружина воеводы " + wb.leader + ", новое задание - " + f.task.short +
                (f.task.site ? " («" + f.task.site + "»)" : ""), { warband: true }) } catch (e) { }
            f.stage = "отдых"
            f.stageAt = now
            v.until = now + FR_WAR_STAY
            gsSave()
            frLog(sgName(village) + ": дружина получила задание - " + f.task.short)
            return true
        }
        var line = f.lines[f.i++]
        frSpeak(cast[line.who], line.text, line.who === "ruler")
        if (line.who === "guest") f.lastGuest = "guest"
        f.next = now + FR_LINE_TICKS + line.text.length
        return true
    }
    if (f.stage === "отдых") {
        frQuiet(f, cast)
        // воевода у костра; дружина отдыхает своими делами (свои люди - и во дворе, и в селе)
        if (leader) frPlace(level, leader, cx - 2.5, cz + 1, cx, cz, false)
        return false
    }
    return false
}

/** Разговор дружины дома. */
function frWarTalk(v) {
    var village = null
    try { village = seLoad().villages[v.settlement] } catch (e) { }
    var rulerRec = village ? village.settlers.filter(s => s.role === "правитель" && !s.dead && !s.replaced)[0] : null
    var ctx = { home: village ? sgName(village) : "дома", ruler: rulerRec ? rulerRec.name : "правитель" }
    var wi = typeof gsPickFreshIndex === "function" ? gsPickFreshIndex(FR_WAR_TALK.length, "war") : Math.floor(Math.random() * FR_WAR_TALK.length)
    return FR_WAR_TALK[wi].map(s => frFill(s, ctx))
}

// ─── Расписание ──────────────────────────────────────────────────────────────

/** Кто придёт: любая фракция, кроме разбойников и тех, с кем у хозяев вражда. Свои тоже. */
function frVisitor(village) {
    var list = []
    try {
        global.TFG_FACTIONS.list.forEach(fc => {
            if (fc.id === "bandits") return
            if (fc.id !== village.faction && Number(global.TFG_FACTIONS.relation(village.faction, fc.id)) < GS_HOSTILE_RELATION) return
            list.push(fc.id)
        })
    } catch (e) { }
    return list.length ? frPick(list) : null
}

function frActiveFor(vid) {
    var visits = gsLoad()
    for (var id in visits) if (visits[id].settlement === vid) return visits[id]
    return null
}

/** Торг в поселении. real=false - без сущностей, сразу в летопись. Текст ошибки или null. */
function frStart(level, village, faction, real) {
    if (village.state !== "мир") return "в поселении не мир"
    if (typeof sgActiveFor === "function" && sgActiveFor(village.id)) return "поселение в осаде"
    if (frActiveFor(village.id)) return "караван уже в поселении"
    faction = faction || frVisitor(village)
    if (!faction) return "некому прийти"
    var near = sgPlayers(village, FR_NEAR)
    var tier = typeof SE_TRADE_TIER === "number" ? SE_TRADE_TIER : 4
    near.forEach(p => { try { tier = Math.max(tier, Number(global.TFG_PLAYER_TIER(p)) || 1) } catch (e) { } })
    tier = Math.min(10, tier)
    if (!real) {
        var same = faction === village.faction
        var deal = Math.random() < FR_DEAL_CHANCE + (same ? 0.15 : 0)
        frResult({ faction: faction, kindName: null }, village, { deal: deal })
        return null
    }
    var kinds = []
    try { kinds = global.TFG_TRADE_GOODS.kindsFor(tier).map(k => k.id) } catch (e) { }
    var kind = kinds.length ? frPick(kinds) : "blacksmith"
    var fort = seFortSpot(village)
    var cx = fort ? fort.gate.x : village.x, cz = fort ? fort.gate.z : village.z
    var cy = 70
    try { cy = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", cx, cz)) } catch (e) { }
    try {
        var gsp = global.TFG_GROUND_SPOT(level, cx, cz, 12)      // у ворот на земле, не на надвратной башне
        if (gsp) { cx = Math.floor(gsp.x); cz = Math.floor(gsp.z); cy = gsp.y }
    } catch (e) { }
    var err = gsVisit(level, { x: cx, y: cy, z: cz }, faction, kind, tier, { settlement: village.id, name: sgName(village) })
    if (!err) frLog(sgName(village) + ": идёт караван " + faction + " (" + kind + ", тир " + tier + ")")
    return err
}

function frWeeklyTick(level) {
    var today = trToday()
    var week = Math.floor(today / 7)
    var plans = frLoad().plans
    var villages = seLoad().villages
    var changed = false
    for (var vid in villages) {
        var village = villages[vid]
        if (!village.spawned) continue
        var plan = plans[vid]
        if (!plan || plan.week !== week) {
            plan = plans[vid] = { week: week, day: Math.random() < GS_WEEKLY_CHANCE ? week * 7 + Math.floor(Math.random() * 7) : -1,
                at: Math.floor(Math.random() * 20000), done: false }
            changed = true
        }
        try { frCaravanTick(level, village) } catch (e) { frErr("караваны " + vid, e) }
        try { frAwayPurge(level, village) } catch (e) { frErr("ушедшие " + vid, e) }
        if (plan.done || plan.day !== today) continue
        var t = Number(level.getDayTime()) % 24000
        if (!isFinite(t) || t < plan.at) continue
        plan.done = true
        changed = true
        var real = sgPlayers(village, FR_NEAR).length > 0
        var err = null
        try { err = frStart(level, village, null, real) } catch (e) { err = String(e) }
        if (err && real) {
            frLog(sgName(village) + ": настоящий торг не вышел (" + err + ") - в летопись")
            try { frStart(level, village, null, false) } catch (e) { }
        }
    }
    if (changed) frSave()
}

ServerEvents.tick(event => {
    if (!FR_SERVER) FR_SERVER = event.server
    if (event.server.tickCount % 200 !== 0) return
    try { frWeeklyTick(event.server.overworld()) } catch (e) { frErr("расписание", e) }
})

// ─── Наружу и команды ────────────────────────────────────────────────────────

global.TFG_FAIRS = {
    holds: e => frHolds(e),
    start: (level, village, faction, real) => frStart(level, village, faction, real),
}

ServerEvents.commandRegistry(event => {
    try {
        var Commands = event.commands
        var Arguments = event.arguments
        var run = (ctx, faction) => {
            if (!FR_SERVER) FR_SERVER = ctx.source.getServer()
            var p = ctx.source.getPlayerOrException()
            var village = sgNearestVillage(p)
            if (!village) { ctx.source.sendFailure(Text.of("Поселений нет.")); return 1 }
            var err = frStart(FR_SERVER.overworld(), village, faction, true)
            if (err) ctx.source.sendFailure(Text.of("§c" + err))
            else ctx.source.sendSuccess(Text.of("К «" + sgName(village) + "» идёт караван."), false)
            return 1
        }
        // торг в ближайшем поселении прямо сейчас: /tfgfair [фракция]; /tfgfair home - вернуть свой караван
        event.register(Commands.literal("tfgfair").requires(s => s.hasPermission(2))
            .executes(ctx => run(ctx, null))
            .then(Commands.literal("home")
                // не ждать сутки торговли: сразу к наказу следующему торговцу
                .then(Commands.literal("дальше").executes(ctx => {
                    if (!FR_SERVER) FR_SERVER = ctx.source.getServer()
                    var vil = sgNearestVillage(ctx.source.getPlayerOrException())
                    var vis = vil ? frActiveFor(vil.id) : null
                    if (!vis || !vis.homecoming || !vis.fair || vis.fair.stage !== "торг") {
                        ctx.source.sendFailure(Text.of("Караван дома сейчас не торгует (нет сцены «торг»).")); return 1
                    }
                    vis.fair.tradeFrom = Number(FR_SERVER.overworld().getTime()) - FR_HOME_DAY
                    gsSave()
                    ctx.source.sendSuccess(Text.of("Сутки торговли пропущены: правитель зовёт следующего торговца."), false)
                    return 1
                }))
                .executes(ctx => {
                if (!FR_SERVER) FR_SERVER = ctx.source.getServer()
                var village = sgNearestVillage(ctx.source.getPlayerOrException())
                if (!village) { ctx.source.sendFailure(Text.of("Поселений нет.")); return 1 }
                var list = frCaravans(village)
                var c = list.filter(x => x.state === "в пути" && !x.pending)[0]
                if (!c) {
                    c = list.filter(x => x.state === "дома")[0]
                    var d = c ? frDest(FR_SERVER.overworld(), village) : null
                    if (!c || !d) { ctx.source.sendFailure(Text.of("Нет каравана, который мог бы вернуться.")); return 1 }
                    frDepart(village, c, d, null)
                }
                var err = frHomecoming(FR_SERVER.overworld(), village, c)
                if (err) ctx.source.sendFailure(Text.of("§c" + err))
                else ctx.source.sendSuccess(Text.of("Возвращается караван " + c.leader + "."), false)
                return 1
            }))
            // своя дружина прилетает за новым заданием: /tfgfair воины
            .then(Commands.literal("воины").executes(ctx => {
                if (!FR_SERVER) FR_SERVER = ctx.source.getServer()
                var vil = sgNearestVillage(ctx.source.getPlayerOrException())
                if (!vil) { ctx.source.sendFailure(Text.of("Поселений нет.")); return 1 }
                var werr = frWarband(FR_SERVER.overworld(), vil)
                if (werr) ctx.source.sendFailure(Text.of("§c" + werr))
                else ctx.source.sendSuccess(Text.of("К «" + sgName(vil) + "» летит своя дружина."), false)
                return 1
            }))
            .then(Commands.literal("list").executes(ctx => {
                if (!FR_SERVER) FR_SERVER = ctx.source.getServer()
                var village = sgNearestVillage(ctx.source.getPlayerOrException())
                if (!village) return 1
                var rows = frCaravans(village).map(c => "§f" + c.leader + " §7(" + (FR_GOODS[c.kind] || c.kind) + "): " + c.state +
                    (c.state === "в пути" && c.dest ? " в «" + c.dest.name + "», вернётся в день " + c.back : ", отдыхает до дня " + c.rest) +
                    (c.sid ? ", житель" : ""))
                ctx.source.sendSuccess(Text.of("§fКараваны «" + sgName(village) + "», сегодня день " + trToday() + ":\n" + rows.join("\n")), false)
                return 1
            }))
            .then(Commands.argument("faction", Arguments.STRING.create(event))
                .executes(ctx => run(ctx, String(Arguments.STRING.getResult(ctx, "faction"))))))
    } catch (err) {
        console.error("[торги] ошибка регистрации команд: " + err)
    }
})
