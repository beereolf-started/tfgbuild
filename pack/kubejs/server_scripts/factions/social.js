// priority: 0
"use strict";

/**
 * ОБЩЕНИЕ С ИГРОКОМ (шаг 2 плана): тон по отношениям, приветствие, подарки, реакция на тычок, угощение у костра,
 * слухи по фракциям и музыка. Работает поверх гостей и караванов (factions/guests.js, factions/caravans.js).
 *
 * ТОН. Отношения фракции с игроком (-100..+100) переводятся в шкалу 0..9 (gsTone). Ниже SO_HOSTILE_REP фракция
 * считает игрока врагом: тогда никаких разговоров, только бой (это решает боевой блок в guests.js).
 *
 * ПОДАРКИ. NPC не пылесосит округу: поднимает только то, что лежит в пределах SO_GIFT_RANGE от него и что бросил
 * игрок. Понимает, что получил (еда, выпивка, металл, ткань, вещь), благодарит по тону, растит репутацию по цене
 * предмета и рассказывает о подарке напарнику.
 *
 * МУЗЫКА. Immersive Melodies: инструмент с NBT playing/melody/start_time в руке - и клиенты сами играют мелодию и
 * анимацию. У костра музыкант достаёт инструмент, остальные бросают дела и слушают, потом обсуждают. Если у костра
 * играет игрок, гости так же собираются и хвалят - за это небольшая репутация.
 */

const SO_HOSTILE_REP = -75
const SO_GIFT_RANGE = 1.2           // ближе этого NPC подберёт брошенное игроком
const SO_GREET_RANGE = 6
const SO_GREET_AGAIN = 6000         // поздороваются снова не раньше чем через 5 минут
const SO_TREAT_RANGE = 5            // угощают у костра в этом радиусе
const SO_TREAT_COOLDOWN = 6000
const SO_LIGHT_HIT = 0.1            // урон меньше десятой доли здоровья - "тычок"
const SO_LIGHT_STRIKES = 3          // столько тычков подряд - и терпение кончается
const SO_MUSIC_CHANCE = 0.02        // в секунду у костра
const SO_MUSIC_TICKS = 2400         // выступление примерно две минуты
const SO_MUSIC_COOLDOWN = 9000
const SO_LISTEN_RANGE = 12
const SO_DROP_TAG = "tfg_npc_drop"  // метка предметов, выложенных самими гостями

const SO_DRINKS = ["tfc_gourmet:kvass_bucket", "tfc_gourmet:compote_bucket", "tfc_gourmet:lemonade_bucket",
    "tfc_gourmet:nalivka_bucket", "tfc_gourmet:coffee_bucket", "tfc_gourmet:cocoa_bucket"]
const SO_TREATS = ["tfc_gourmet:bratwurst", "tfc_gourmet:pelmeni", "tfc_gourmet:syrniki", "tfc_gourmet:crepes",
    "tfc_gourmet:oladyi", "firmalife:food/cheddar", "firmalife:food/shosha", "tfc:food/wheat_bread"]
const SO_INSTRUMENTS = ["immersive_melodies:flute", "immersive_melodies:lute", "immersive_melodies:vielle",
    "immersive_melodies:handpan", "immersive_melodies:tiny_drum", "immersive_melodies:bagpipe", "immersive_melodies:didgeridoo"]
const SO_MELODY_LEN = {drunken_sailor: 428, cooleys: 1280, gallopede: 960, clog_waltz: 1000, hopser_walzer: 420, allewander: 1116, ievan_polka: 3182, the_bard_s_song: 3964, saria_s_song: 1124, windmill: 622, castle: 1376, mondscheinsonate: 7710, wet_hands: 1812, skyrim: 2412, harry_potter: 668, mountain_king: 2516, monkey_island: 1364, le_colosse: 640, les_180_pucelles: 432, chinder_vo_jaun: 1098, branda_schottisch: 618, elise_polka: 1116}  // длина мелодии в тиках (посчитано по midi мода)
/** Сколько длится выступление: сама мелодия плюс небольшой хвост, но не дольше пяти минут. */
function soMelodyTicks(melody) {
    var t = SO_MELODY_LEN[melody] || SO_MUSIC_TICKS
    return Math.min(3400, t + 60)
}
const SO_MELODIES = ["drunken_sailor", "cooleys", "gallopede", "clog_waltz", "hopser_walzer", "allewander", "ievan_polka",
    "saria_s_song", "windmill", "castle", "wet_hands", "skyrim", "harry_potter",
    "mountain_king", "monkey_island", "le_colosse", "les_180_pucelles", "chinder_vo_jaun", "branda_schottisch", "elise_polka"]

/** Тон разговора с игроком: 0 - сквозь зубы, 9 - как с родным. */
function gsTone(v, player) {
    var rep = 0
    try { rep = Number(global.TFG_FACTIONS.rep(player, v.faction)) } catch (e) { }
    if (!isFinite(rep)) rep = 0
    return Math.max(0, Math.min(9, Math.round((rep + 100) / 200 * 9)))
}

function gsToneBand(tone) { return tone <= 2 ? 0 : tone <= 5 ? 1 : tone <= 7 ? 2 : 3 }

/** Случайная реплика нужного тона: в наборе четыре ряда - холодно, сдержанно, приветливо, тепло. */
function gsToneLine(set, tone) { return gsPick(set[gsToneBand(tone)]) }

const SO_GREET = [
    ["Проходи мимо.", "Не стой над душой.", "Чего надо?", "Ну?"],
    ["Здравствуй.", "И тебе не хворать.", "Мир тебе.", "Доброго пути."],
    ["А, знакомое лицо! Здравствуй.", "Рад тебя видеть.", "Здорово, друг.", "Кого я вижу!"],
    ["Друг мой, как я рад встрече!", "Наконец-то знакомое лицо в этой глуши!", "Здравствуй, дорогой!", "Ну здравствуй, родная душа."],
]
const SO_THANKS = [
    ["Хм. Ладно.", "Приму, так и быть.", "Угу.", "Считай, зачтётся."],
    ["Благодарю.", "Спасибо, это кстати.", "Вот спасибо.", "Не откажусь, спасибо."],
    ["Спасибо, дружище!", "Вот это по-нашему, спасибо!", "Щедро, благодарю!", "Ох, спасибо тебе!"],
    ["Спасибо тебе, друг! Не забуду.", "Вот это подарок! Спасибо!", "Ты настоящий друг, спасибо!", "Сердечно благодарю!"],
]
const SO_HIT_LIGHT = [
    ["Ещё раз - и пожалеешь.", "Руки убрал.", "Ты за это ответишь.", "Напрашиваешься?"],
    ["Эй! Полегче.", "Ты чего дерёшься?", "Не балуй.", "Хватит."],
    ["Что я тебе сделал?", "Я не хотел тебя обидеть.", "Давай без этого, а?", "Мы же не ссорились."],
    ["Друг, ты чего? Это же я.", "Я думал, мы друзья...", "Обидно, честное слово.", "Не надо так, прошу."],
]
const SO_TREAT_LINE = [
    ["На, не помри с голоду.", "Держи, и отойди.", "Бери, раз пришёл.", "Ешь молча."],
    ["Угощайся.", "На, подкрепись.", "Возьми, у огня положено.", "Держи, не побрезгуй."],
    ["Угощайся, друг!", "Держи, у нас хватает.", "Бери-бери, не стесняйся.", "К огню - и к столу."],
    ["Самое лучшее - гостю!", "Для друга ничего не жалко.", "Держи, отогрейся как следует.", "Ешь, пей, всё наше - твоё."],
]
const SO_MUSIC_START = [
    ["Ладно, сыграю. Только не мешайте.", "Раз просят - сыграю.", "Слушайте, пока настроение есть.", "Одна песня, и спать."],
]
const SO_MUSIC_COMMENT = [
    ["Хорошо играешь.", "Душевно вышло.", "Аж мороз по коже.", "Ещё бы разок такую."],
    ["Слышал и хуже.", "Пальцы-то помнят.", "Сойдёт для дороги.", "В городе за такое монету бросают."],
    ["Вот это дело! Играй ещё.", "Под такое и шагать легче.", "У нас в лагере так не умеют.", "Запомню мотив."],
]
const SO_PLAYER_MUSIC = [
    ["Гляди, чужак играет.", "А ничего так.", "Слушай, не мешай."],
    ["Хорошо играешь, путник!", "Редко такое услышишь в дороге.", "За такое и угостить не жалко."],
    ["Вот это по-нашему!", "Сыграй ещё, друг!", "Под такую музыку и зима теплее."],
]
// слухи по фракциям: кто что говорит о мире и соседях
const SO_RUMORS = {
    wind: [
        ["Небо честнее дорог.", "На дороге грабят, в небе только ветер.", "И падать выше."],
        ["Синяя сталь держит давление лучше красной.", "Красная - для тех, кто любит чинить.", "А я люблю летать."],
        ["Говорят, на востоке нашли поле руды.", "Говорят многое.", "Зато возить будет чего."],
        ["Эшлендеры обещали шкуры к весне.", "Если доживут.", "Доживут, они живучие."],
        ["Марвины опять просили возить ящики без описи.", "И что?", "А ничего. Мы не возим то, что стонет."],
    ],
    ash: [
        ["Скот нынче дорог.", "Корма дороже.", "А зима ближе."],
        ["В шахте на севере вода пошла.", "Бросили?", "Углубились. Мы же эшлендеры."],
        ["Торговцы ветром опять летят мимо.", "Пусть летят, лишь бы платили.", "Платят исправно, чего уж."],
        ["Альянс зовёт под свои знамёна.", "Пусть сперва долги закроют.", "И то верно."],
        ["Говорят, руду у нас берут за полцены.", "Так продавай дороже.", "Купят у Марвинов, у них дешевле. И грязнее."],
    ],
    marvins: [
        ["Хорошая настойка лечит всё.", "И память отшибает.", "Это как раз главное."],
        ["Альянс опять читал нам мораль.", "У рыцарей всегда чистые руки.", "Потому что за них работают другие."],
        ["Живой товар нынче в цене.", "Тише ты.", "А что? Мы же аптекари."],
        ["На юге спрос на порошки вырос.", "Значит, поедем на юг.", "Как всегда."],
        ["Эшлендеры считают нас падалью.", "Пусть считают. Лечиться всё равно к нам придут.", "Это точно."],
    ],
    alliance: [
        ["Порядок держится на тех, кто встал в строй.", "И на тех, кто платит за сталь.", "И на них тоже."],
        ["Марвины возят людей в ящиках.", "Докажи.", "Докажу - и повешу."],
        ["Тракт до перевала снова чист.", "Надолго ли?", "Насколько нас хватит."],
        ["Говорят, в старых руинах горит свет.", "Ночью туда не ходят.", "Значит, пойдём днём."],
        ["Эшлендеры дали зерно в долг.", "Вернём с процентом.", "Вернём с честью. Процент - потом."],
    ],
}
const SO_RUMORS_COMMON = [
    ["Поселения держатся друг за друга всё слабее.", "Каждый сам за себя.", "Пока не приходят разбойники."],
    ["Дороги пустеют.", "Кто уцелел - сидит за стеной.", "А мы вот ходим."],
    ["Говорят, на севере целый город стоит целым.", "Врут.", "Хорошо бы врали не всё."],
]

function gsSocialLog(msg) { global.tfgLog("tfg social", msg) }

/** Слухи - в общий список тем разговоров (зовётся из gsContextTopics). */
function gsSocialTopics(v, rt, add) {
    var own = SO_RUMORS[v.faction] || []
    own.forEach((lines, i) => {
        GS_CTX_LINES["rumor_" + v.faction + "_" + i] = lines
        add("rumor_" + v.faction + "_" + i)
    })
    SO_RUMORS_COMMON.forEach((lines, i) => {
        GS_CTX_LINES["rumor_common_" + i] = lines
        add("rumor_common_" + i)
    })
}

// ─── Приветствие ─────────────────────────────────────────────────────────────

function gsGreetTick(v, level, rt, guests, now) {
    rt.greeted = rt.greeted || {}
    GS_SERVER.players.forEach(p => {
        if (String(p.level.getDimension()) !== v.dim || p.isSpectator()) return
        var tone = gsTone(v, p)
        if (tone <= 0 && gsRepOf(v, p) < SO_HOSTILE_REP) return
        var key = String(p.uuid)
        if ((rt.greeted[key] || 0) > now) return
        var best = null, bestD = SO_GREET_RANGE * SO_GREET_RANGE
        guests.forEach(g => {
            if (!g || rt.chatOf && rt.chatOf[String(g.uuid)]) return
            var d = gsDist2(g, p.getX(), p.getZ())
            if (d < bestD) { bestD = d; best = g }
        })
        if (!best) return
        rt.greeted[key] = now + SO_GREET_AGAIN
        var line = gsToneLine(SO_GREET, tone)
        best.getLookControl().setLookAt(p.getX(), p.getEyeY(), p.getZ())
        gsMono(v, rt, best, null, now, 1, line)
    })
}

function gsRepOf(v, player) {
    try { return Number(global.TFG_FACTIONS.rep(player, v.faction)) || 0 } catch (e) { return 0 }
}

// ─── Подарки ─────────────────────────────────────────────────────────────────

const SO_GIFT_WORDS = [
    [/tfc_gourmet:|_bucket$/, "напиток"], [/food|bread|cheese|pelmeni|bratwurst/, "еда"],
    [/_ingot$|_plate$|_rod$|metal\//, "железо"], [/cloth|wool|yarn|hide|textile/, "ткань"],
    [/coin/, "монеты"], [/gem|diamond|emerald|ruby|sapphire/, "самоцвет"], [/powder|dust/, "порошок"],
]

function gsGiftWord(id) {
    for (var i = 0; i < SO_GIFT_WORDS.length; i++) if (SO_GIFT_WORDS[i][0].test(id)) return SO_GIFT_WORDS[i][1]
    return "вещица"
}

/** Что подарок стоит: цена из прайса торговцев, иначе мелочь. */
function gsGiftValue(stack) {
    var price = 0
    try { price = Number(global.TFG_TRADE_GOODS.itemPrice(String(stack.id))) || 0 } catch (e) { }
    if (price <= 0) price = 2
    return price * stack.getCount()
}

/** Метка на предметах, которые выложили сами гости: такие за подарок игрока не считаем. */
function gsOwnDrop(e) {
    try { if (e.tags && e.tags.contains(SO_DROP_TAG)) return true } catch (err) { }
    try { if (e.getTags().contains(SO_DROP_TAG)) return true } catch (err) { }
    return false
}

function gsGiftTick(v, level, rt, guests, now) {
    rt.giftAt = rt.giftAt || 0
    if (rt.giftAt > now) return
    guests.forEach(g => {
        if (!g) return
        var list
        try {
            list = level.getEntities(g, new RAID_AABBClass(g.getX() - SO_GIFT_RANGE, g.getY() - 1, g.getZ() - SO_GIFT_RANGE,
                g.getX() + SO_GIFT_RANGE, g.getY() + 2, g.getZ() + SO_GIFT_RANGE))
        } catch (e) { return }
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (String(e.type) !== "minecraft:item") continue
            if (gsOwnDrop(e)) continue
            // кто бросил: у выброшенного предмета есть владелец; если API молчит - берём игрока рядом
            var giver = null
            try { giver = e.getOwner() } catch (err) { }
            if (giver && (!giver.isPlayer || !giver.isPlayer())) giver = null
            if (!giver) {
                try { giver = level.getNearestPlayer(e, 5) } catch (err) { }
            }
            if (!giver) continue
            var stack
            try { stack = e.getItem() } catch (err) { continue }
            if (!stack || stack.isEmpty()) continue
            gsAcceptGift(v, level, rt, g, giver, stack, now)
            e.discard()
            rt.giftAt = now + 40
            return
        }
    })
}

function gsAcceptGift(v, level, rt, g, player, stack, now) {
    var tone = gsTone(v, player)
    var word = gsGiftWord(String(stack.id))
    var value = gsGiftValue(stack)
    var gain = Math.max(0.5, Math.min(8, value / 40))
    try { global.TFG_FACTIONS.addRep(player, v.faction, gain, "подарок гостю") } catch (e) { }
    gsSocialLog(v.id + ": " + player.username + " подарил " + stack.id + " x" + stack.getCount() + " (" + word + "), репутация +" + gain.toFixed(1))
    try { g.setItemSlot(Java.loadClass("net.minecraft.world.entity.EquipmentSlot").OFFHAND, stack.copy()) } catch (e) { }
    gsMono(v, rt, g, null, now, 1, gsToneLine(SO_THANKS, tone))
    // напарник спрашивает, что дали - и завязывается короткий разговор
    var partner = gsTalkPartner(v, rt, g, null, 8)
    if (!partner) return
    var lines = [gsToneLine(SO_THANKS, tone), "Что он тебе дал?", "Это " + word + ". Гостинец от местных.",
        tone >= 6 ? "Неожиданно после всего, что мы видели в пути." : "Ну хоть кто-то не бросил камень."]
    rt.chats = rt.chats || []
    rt.chatOf = rt.chatOf || {}
    rt.chatCd = rt.chatCd || {}
    var chat = { a: String(g.uuid), b: String(partner.uuid), lines: lines, idx: 0, next: now, now: now }
    chat.lines.voice = lines
    rt.chats.push(chat)
    rt.chatOf[chat.a] = chat
    rt.chatOf[chat.b] = chat
}

// ─── Тычок: лёгкий удар без серьёзного урона ─────────────────────────────────

/** true - удар был лёгкий и обошёлся ворчанием, вражду объявлять не надо. */
function gsLightHit(v, e, player, amount) {
    var max = 20
    try { max = Number(e.getMaxHealth()) || 20 } catch (err) { }
    if (!(amount < max * SO_LIGHT_HIT)) return false
    var rep = gsRepOf(v, player)
    if (rep < SO_HOSTILE_REP) return false
    var rt = gsRt(v.id)
    rt.strikes = rt.strikes || {}
    var key = String(player.uuid)
    var st = rt.strikes[key] || { n: 0, at: 0 }
    var now = gsNow(e.level)
    if (now - st.at > 600) st.n = 0
    st.n++
    st.at = now
    rt.strikes[key] = st
    if (st.n >= SO_LIGHT_STRIKES) {
        rt.strikes[key] = { n: 0, at: now }
        return false
    }
    gsMono(v, rt, e, null, now, 1, gsToneLine(SO_HIT_LIGHT, gsTone(v, player)))
    try { global.TFG_FACTIONS.addRep(player, v.faction, -1, "тычок гостю") } catch (err) { }
    return true
}

// ─── Угощение у костра ───────────────────────────────────────────────────────

function gsTreatTick(v, level, rt, guests, now) {
    rt.treatAt = rt.treatAt || {}
    GS_SERVER.players.forEach(p => {
        if (String(p.level.getDimension()) !== v.dim || p.isSpectator()) return
        var key = String(p.uuid)
        if ((rt.treatAt[key] || 0) > now) return
        var tone = gsTone(v, p)
        if (tone < 3) return
        var host = null
        guests.forEach(g => {
            if (host || !g) return
            var act = rt.acts[String(g.uuid)]
            if (!act || (act.id !== "warm" && act.id !== "shelter") || act.stage !== "do") return
            if (gsDist2(g, p.getX(), p.getZ()) < SO_TREAT_RANGE * SO_TREAT_RANGE) host = g
        })
        if (!host) return
        rt.treatAt[key] = now + SO_TREAT_COOLDOWN
        var id = Math.random() < 0.5 ? gsPick(SO_DRINKS) : gsPick(SO_TREATS)
        if (!gsItem(id)) id = "tfc:food/wheat_bread"
        try {
            // кладём прямо перед игроком: иначе гость подбирает собственное угощение обратно
            GS_SERVER.runCommandSilent("execute in " + v.dim + " run summon minecraft:item " + p.getX().toFixed(2) + " " +
                (p.getY() + 1).toFixed(2) + " " + p.getZ().toFixed(2) + ' {Tags:["' + SO_DROP_TAG + '"],Owner:"' + p.uuid +
                '",Item:{id:"' + id + '",Count:1b},Motion:[0.0,0.1,0.0]}')
        } catch (e) { }
        gsMono(v, rt, host, null, now, 1, gsToneLine(SO_TREAT_LINE, tone))
        try { global.TFG_FACTIONS.addRep(p, v.faction, 0.5, "угощение у костра") } catch (e) { }
        gsSocialLog(v.id + ": угостили " + p.username + " (" + id + ")")
    })
}

// ─── Музыка ──────────────────────────────────────────────────────────────────

function gsInstrumentStack(id, melody, startTime) {
    return Item.of(id, '{playing:1b,melody:"immersive_melodies:' + melody + '",start_time:' + Math.floor(startTime) + 'L}')
}

// ─── Ноты с сервера ──────────────────────────────────────────────────────────
//
// Immersive Melodies играет мелодию только у игрока (и у попугая с аллеем): у хаска инструмент
// в руках виден, но молчит. Поэтому ноты играет сервер - по записи мелодии (melodies_data.js,
// собрано из MIDI мода), сэмплами самого инструмента: flute.c1..c8, высота - тоном playsound.

var SO_PLAYING = {}                  // uuid -> { e, notes, i, start, inst, dim, item }
var SO_NOTES = {}                    // мелодия -> [[тик, нота, громкость]] (разобранная запись)

function soNotes(melody) {
    if (SO_NOTES[melody]) return SO_NOTES[melody]
    var raw = null
    try { raw = global.TFG_MELODY_NOTES[melody] } catch (e) { }
    if (!raw) return null
    SO_NOTES[melody] = String(raw).split(";").map(s => s.split(".").map(x => parseInt(x, 36)))
    return SO_NOTES[melody]
}

/** Музыкант с инструментом в руке начал мелодию в тик start. */
function soPlayStart(e, inst, melody, start) {
    var notes = soNotes(melody)
    if (!notes || !notes.length) { gsSocialLog("нет нот мелодии " + melody); return }
    SO_PLAYING[String(e.uuid)] = { e: e, notes: notes, i: 0, start: Math.floor(start), inst: String(inst).replace(/^.*:/, ""),
        dim: String(e.level.getDimension()), item: String(inst) }
}

function soPlayNote(p, note, vel) {
    // сэмпл - ближайшее «до» (c4 = нота 60), остальное добирает тон
    var oct = Math.floor(note / 12) - 1, semi = note - 12 * (oct + 1)
    if (semi > 6) { oct++; semi -= 12 }
    if (oct < 1) { semi -= (1 - oct) * 12; oct = 1 }
    if (oct > 8) { semi += (oct - 8) * 12; oct = 8 }
    var pitch = Math.max(0.5, Math.min(2, Math.pow(2, semi / 12)))
    var vol = 0.6 + 1.4 * Math.min(1, vel / 110)
    var e = p.e
    GS_SERVER.runCommandSilent("execute in " + p.dim + " positioned " + e.getX().toFixed(1) + " " + (e.getY() + 1.2).toFixed(1) + " " +
        e.getZ().toFixed(1) + " run playsound immersive_melodies:" + p.inst + ".c" + oct + " record @a[distance=..48] ~ ~ ~ " +
        vol.toFixed(2) + " " + pitch.toFixed(3))
}

ServerEvents.tick(event => {
    var any = false
    for (var u in SO_PLAYING) { any = true; break }
    if (!any) return
    if (!GS_SERVER) GS_SERVER = event.server
    for (var key in SO_PLAYING) {
        var p = SO_PLAYING[key]
        try {
            var e = p.e
            // убрал инструмент из рук (кончил, тревога, сел) - и музыка смолкла
            if (!e || !e.isAlive() || String(e.getMainHandItem().id) !== p.item) { delete SO_PLAYING[key]; continue }
            var t = Number(e.level.getTime()) - p.start
            var played = 0
            while (p.i < p.notes.length && p.notes[p.i][0] <= t) {
                // отстали (выгружался чанк) - старые ноты пропускаем, а не играем разом
                if (t - p.notes[p.i][0] < 4 && played < 6) { soPlayNote(p, p.notes[p.i][1], p.notes[p.i][2]); played++ }
                p.i++
            }
            if (p.i >= p.notes.length) delete SO_PLAYING[key]
        } catch (err) { delete SO_PLAYING[key] }
    }
})

/** Сидящий у огня достаёт инструмент; остальные подтягиваются слушать. */
function gsMusicStart(v, level, rt, player, now) {
    var guards = v.guards.map(u => gsEntity(v, u)).filter(e => e)
    var fires = rt.pois && rt.pois.fires ? rt.pois.fires : []
    var musician = null, spot = null
    guards.forEach(g => {
        if (musician || g.isPassenger()) return
        var act = rt.acts[String(g.uuid)]
        if (!act || act.id !== "warm" || act.stage !== "do") return
        musician = g
        spot = act.poi
    })
    if (!musician) return false
    var melody = gsPick(SO_MELODIES)
    var instrument = gsPick(SO_INSTRUMENTS)
    if (!gsItem(instrument)) return false
    var key = String(musician.uuid)
    var act = rt.acts[key]
    var dur = soMelodyTicks(melody)
    rt.music = { musician: key, until: now + dur, melody: melody, spot: spot, hand: String(musician.getMainHandItem().id), commented: false }
    v.music = { musician: key, until: now + dur, melody: melody, hand: rt.music.hand }
    try { musician.setMainHandItem(gsInstrumentStack(instrument, melody, Number(level.getTime()))) } catch (e) { v.music = null; return false }
    soPlayStart(musician, instrument, melody, Number(level.getTime()))
    gsMono(v, rt, musician, null, now, 1, gsPick(SO_MUSIC_START[0]))
    gsSocialLog(v.id + ": " + melody + " на " + instrument + " у костра " + (spot ? spot.x + " " + spot.z : "?"))
    // остальные бросают дела и идут слушать
    guards.forEach(g => {
        if (g === musician) return
        var gk = String(g.uuid)
        gsFinishAct(g, rt.acts[gk])
        rt.acts[gk] = { id: "listen", stage: "go", poi: spot, until: now + dur + 200, next: 0, started: now, dur: dur }
    })
    return true
}

function gsMusicStop(v, level, rt, now) {
    var m = rt.music
    if (!m) return
    var musician = gsEntity(v, m.musician)
    if (musician) {
        try { musician.setMainHandItem(Item.of(m.hand && m.hand !== "minecraft:air" ? m.hand : "tfc:metal/javelin/copper")) } catch (e) { }
    }
    rt.music = null
    v.music = null
    rt.musicCd = now + SO_MUSIC_COOLDOWN
    // слушатели расходятся и обсуждают
    v.guards.forEach(u => {
        var g = gsEntity(v, u)
        if (!g) return
        var act = rt.acts[u]
        if (act && act.id === "listen") act.until = now
    })
    var a = gsEntity(v, m.musician)
    var b = a ? gsTalkPartner(v, rt, a, null, 12) : null
    if (a && b) {
        var lines = [gsPick(SO_MUSIC_COMMENT[0]), gsPick(SO_MUSIC_COMMENT[1]), gsPick(SO_MUSIC_COMMENT[2])]
        rt.chats = rt.chats || []
        rt.chatOf = rt.chatOf || {}
        rt.chatCd = rt.chatCd || {}
        var chat = { a: String(b.uuid), b: String(a.uuid), lines: lines, idx: 0, next: now, now: now }
        chat.lines.voice = lines
        rt.chats.push(chat)
        rt.chatOf[chat.a] = chat
        rt.chatOf[chat.b] = chat
    }
}

/** Играет ли игрок рядом на инструменте Immersive Melodies. */
function gsPlayerMusician(v, level, guests) {
    var found = null
    GS_SERVER.players.forEach(p => {
        if (found || String(p.level.getDimension()) !== v.dim) return
        var stack = p.getMainHandItem()
        if (!stack || stack.isEmpty() || String(stack.id).indexOf("immersive_melodies:") !== 0) return
        var playing = false
        try {
            var nbt = stack.nbt || (typeof stack.getNbt === "function" ? stack.getNbt() : null)
            playing = !!nbt && String(nbt.getBoolean("playing")) === "true"
        } catch (err) { }
        if (!playing) return
        var near = guests.some(g => g && gsDist2(g, p.getX(), p.getZ()) < SO_LISTEN_RANGE * SO_LISTEN_RANGE)
        if (near) found = p
    })
    return found
}

/** Инструмент в руках без живого выступления (например, после /reload) - убрать. */
function gsMusicSweep(v, level, rt, guests, now) {
    var live = rt.music && now < rt.music.until ? String(rt.music.musician) : null
    guests.forEach(g => {
        if (!g) return
        var key = String(g.uuid)
        if (key === live) return
        var id = ""
        try { id = String(g.getMainHandItem().id) } catch (e) { return }
        if (id.indexOf("immersive_melodies:") !== 0) return
        var hand = v.music && v.music.hand && v.music.hand !== "minecraft:air" ? v.music.hand : "tfc:metal/javelin/copper"
        try { g.setMainHandItem(Item.of(hand)) } catch (e) { }
        gsSocialLog(v.id + ": убрали забытый инструмент у " + key.substring(0, 8))
    })
}

function gsMusicTick(v, level, rt, guests, now) {
    if (v.raid || v.fleeing) {
        if (rt.music) gsMusicStop(v, level, rt, now)
        return
    }
    // выступление пережило перезагрузку скриптов - восстанавливаем состояние, чтобы было чем закончить
    if (!rt.music && v.music) rt.music = { musician: v.music.musician, until: v.music.until, melody: v.music.melody, hand: v.music.hand, spot: null, commented: false }
    var m = rt.music
    if (m) {
        if (now >= m.until) gsMusicStop(v, level, rt, now)
        return
    }
    gsMusicSweep(v, level, rt, guests, now)
    // игрок играет рядом - слушаем его
    var player = gsPlayerMusician(v, level, guests)
    if (player) {
        if ((rt.playerMusicAt || 0) > now) return
        rt.playerMusicAt = now + SO_MUSIC_COOLDOWN
        var spot = { x: player.getX(), y: player.getY(), z: player.getZ() }
        guests.forEach(g => {
            if (!g) return
            var gk = String(g.uuid)
            gsFinishAct(g, rt.acts[gk])
            rt.acts[gk] = { id: "listen", stage: "go", poi: spot, until: now + SO_MUSIC_TICKS, next: 0, started: now, dur: SO_MUSIC_TICKS }
        })
        var tone = gsTone(v, player)
        var who = guests[Math.floor(Math.random() * guests.length)]
        if (who) gsMono(v, rt, who, null, now, 1, gsPick(SO_PLAYER_MUSIC[Math.min(2, gsToneBand(tone))]))
        try { global.TFG_FACTIONS.addRep(player, v.faction, 1.5, "музыка у костра") } catch (e) { }
        gsSocialLog(v.id + ": слушают музыку игрока " + player.username)
        return
    }
    if ((rt.musicCd || 0) > now) return
    if (Math.random() > SO_MUSIC_CHANCE) return
    gsMusicStart(v, level, rt, null, now)
}

// ─── Общий тик общения (зовётся из gsVisitTick) ──────────────────────────────

function gsSocialTick(v, level, rt, trader, guards, now) {
    var guests = [trader].concat(guards).filter(e => e)
    if (!guests.length) return
    try { gsGreetTick(v, level, rt, guests, now) } catch (e) { gsErr("приветствие", e) }
    try { gsGiftTick(v, level, rt, guests, now) } catch (e) { gsErr("подарок", e) }
    if (!v.caravan) {
        try { gsTreatTick(v, level, rt, guards, now) } catch (e) { gsErr("угощение", e) }
        try { gsMusicTick(v, level, rt, guards, now) } catch (e) { gsErr("музыка", e) }
    }
}
