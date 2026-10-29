// priority: 1
"use strict";
/**
 * ОТНОШЕНИЯ (этап 1 плана NPC: Downloads/TFG-NPC-план.md).
 *
 * ГРАФ ПОСЕЛЕНИЯ. У жителей есть связи: супруги, родня (живут в одном доме), друзья, соперники, враги,
 * наставники, должники - у каждой своё мнение -100..+100 с каждой стороны. Граф выводится из номера
 * поселения и номеров жителей (rlBase) и не хранится; хранятся только сдвиги (village.relShift):
 * кто кого обидел, с кем сблизился. Новый житель сразу получает свои связи.
 *
 * ОТНОШЕНИЕ К ИГРОКУ (rlOpinion) складывается из: отношения фракции; личной памяти жителя о игроке
 * (village.pmem: помог, обидел, торговал); того, что игрок сделал его друзьям и врагам (через граф);
 * образа игрока глазами его сословия.
 *
 * ОБРАЗ ИГРОКА - три шкалы 0..1: роскошь (украшения и дорогая одежда, гардероб tfgui и броня),
 * боевитость (оружие и доспех), простота (простая одежда, рабочий инструмент в руках). Раз в минуту
 * шкалы подтягиваются к тому, как игрок одет сейчас, на RL_LOOK_RATE - примерно за двое игровых суток,
 * так что переодеться на ходу и сразу понравиться не выйдет. Знать ценит роскошь, военные -
 * боевитость, простолюдины - простоту (и недолюбливают чванство).
 *
 * ВСТРЕЧА. Житель рядом с игроком иногда бросает реплику: по сословию и по отношению (5 ступеней), а если
 * дело в образе игрока - про него. Один житель - не чаще раза в RL_BARK_COOLDOWN.
 *
 * Команды (оператор): /tfgrel me - образ; /tfgrel npc - житель под прицелом: сословие, отношение и связи.
 * API: global.TFG_RELATIONS - opinion, look, links, note.
 */

const RL_Wardrobe = (() => { try { return Java.loadClass("tfg.ui.wardrobe.Wardrobe") } catch (e) { return null } })()
const RL_Slot = Java.loadClass("net.minecraft.world.entity.EquipmentSlot")
const RL_LOOK_EVERY = 1200          // раз в минуту подтягиваем образ
const RL_LOOK_RATE = 0.025          // доля пути за раз: ~40 минут (двое игровых суток) до нового образа
const RL_BARK_EVERY = 40            // раз в 2 секунды смотрим, кто рядом
const RL_BARK_R = 5                 // столько блоков - «встретились»
const RL_BARK_COOLDOWN = 6000       // житель говорит игроку не чаще раза в 5 минут
const RL_BARK_CHANCE = 0.35

function rlLog(msg) { try { global.tfgLog("tfg relations", msg) } catch (e) { } }

/** Число из строки - для детерминированного графа. */
function rlHash(s) {
    var h = 2166136261
    s = String(s)
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
    return h >>> 0
}
function rlRand(seed, n) { return rlHash(seed) % n }
function rlRange(seed, lo, hi) { return lo + rlHash(seed) % (hi - lo + 1) }

// ─── Граф поселения ──────────────────────────────────────────────────────────

const RL_NAMES = {
    spouse: ["муж", "жена"], kin: ["родня", "родня"], friend: ["друг", "подруга"], rival: ["соперник", "соперница"],
    enemy: ["враг", "враг"], mentor: ["наставник", "ученик"], debt: ["заимодавец", "должник"],
}
var RL_CACHE = {}                   // id поселения -> { key, links }

/** Связи поселения без сдвигов: [{ a, b, type, ab, ba }] (ab - мнение a о b). */
function rlBase(village) {
    var people = village.settlers.filter(s => !s.dead)
    var key = people.map(s => s.id).join(",")
    var c = RL_CACHE[village.id]
    if (c && c.key === key) return c.links
    var links = [], seen = {}
    var add = (a, b, type, ab, ba) => {
        if (a.id === b.id) return
        var k = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id
        if (seen[k]) return
        seen[k] = true
        links.push({ a: a.id, b: b.id, type: type, ab: ab, ba: ba })
    }
    // одна койка-дом: семья (по дому и близости коек)
    var houses = {}
    people.forEach(s => {
        var hk = String(s.home || "") + "@" + Math.round((s.bed ? s.bed.x : 0) / 10) + "," + Math.round((s.bed ? s.bed.z : 0) / 10)
        ;(houses[hk] = houses[hk] || []).push(s)
    })
    for (var hk in houses) {
        var h = houses[hk]
        if (h.length < 2 || String(hk).indexOf("форт") === 0) continue
        var man = h.filter(s => !s.female)[0], wife = h.filter(s => s.female)[0]
        if (man && wife) add(man, wife, "spouse", rlRange(village.id + man.id + "s", 30, 90), rlRange(village.id + wife.id + "s", 30, 90))
        h.forEach((x, i) => h.slice(i + 1).forEach(y => add(x, y, "kin", rlRange(village.id + x.id + y.id, 10, 70), rlRange(village.id + y.id + x.id, 10, 70))))
    }
    var est = s => global.TFG_SETTLERS.estateOf(s)
    people.forEach(s => {
        var seed = village.id + "/" + s.id
        var same = people.filter(o => o.id !== s.id && est(o) === est(s))
        var any = people.filter(o => o.id !== s.id)
        if (!any.length) return
        for (var f = 0; f < 2 && same.length; f++) {
            var fr = same[rlRand(seed + "f" + f, same.length)]
            add(s, fr, "friend", rlRange(seed + "fa" + f, 25, 75), rlRange(seed + "fb" + f, 15, 70))
        }
        if (rlRand(seed + "r", 100) < 45) {
            var role = people.filter(o => o.id !== s.id && o.role === s.role)
            if (role.length) add(s, role[rlRand(seed + "rw", role.length)], "rival", -rlRange(seed + "ra", 10, 45), -rlRange(seed + "rb", 5, 40))
        }
        if (rlRand(seed + "e", 100) < 18) add(s, any[rlRand(seed + "ew", any.length)], "enemy", -rlRange(seed + "ea", 45, 90), -rlRange(seed + "eb", 30, 85))
        if (rlRand(seed + "m", 100) < 25) {
            var role2 = people.filter(o => o.id !== s.id && o.role === s.role)
            if (role2.length) add(s, role2[rlRand(seed + "mw", role2.length)], "mentor", rlRange(seed + "ma", 20, 60), rlRange(seed + "mb", 30, 70))
        }
        if (rlRand(seed + "d", 100) < 15) add(s, any[rlRand(seed + "dw", any.length)], "debt", -rlRange(seed + "da", 5, 35), rlRange(seed + "db", -10, 20))
    })
    RL_CACHE[village.id] = { key: key, links: links }
    return links
}

/** Связи жителя с учётом сдвигов: [{ other, type, word, mine, theirs }]. */
function rlLinks(village, sid) {
    var shift = village.relShift || {}
    var out = []
    rlBase(village).forEach(l => {
        if (l.a !== sid && l.b !== sid) return
        var me = l.a === sid, other = me ? l.b : l.a
        var k = l.a + "|" + l.b
        var mine = (me ? l.ab : l.ba) + (shift[me ? k + ">" : k + "<"] || 0)
        var theirs = (me ? l.ba : l.ab) + (shift[me ? k + "<" : k + ">"] || 0)
        var w = RL_NAMES[l.type]
        out.push({ other: other, type: l.type, word: l.type === "mentor" || l.type === "debt" ? (me ? w[0] : w[1]) : w[0],
            mine: Math.max(-100, Math.min(100, mine)), theirs: Math.max(-100, Math.min(100, theirs)) })
    })
    return out
}

// ─── Жизнь графа: раз в игровые сутки что-то случается ─────────────────────────

const RL_DAY = 24000
const RL_LOG_MAX = 40               // столько последних событий помнит поселение (для сплетен и дневников)
/** Событие между двумя жителями: сдвиг мнения a о b и b об a; когда оно уместно (по мнению a о b). */
const RL_EVENTS = [
    { kind: "сблизились", ab: [5, 12], ba: [5, 12], when: m => m > 20 },
    { kind: "поссорились", ab: [-25, -10], ba: [-20, -8], when: m => m > -20 },
    { kind: "помирились", ab: [10, 25], ba: [10, 20], when: m => m < -10 },
    { kind: "подрались", ab: [-30, -15], ba: [-30, -15], when: m => m < -30 },
    { kind: "одолжил денег", ab: [3, 8], ba: [-10, -3], when: m => m > 0 },
    { kind: "вернул долг", ab: [5, 10], ba: [8, 15], when: m => m > -40 },
    { kind: "сделал подарок", ab: [2, 6], ba: [8, 18], when: m => m > 10 },
    { kind: "оскорбил", ab: [-5, 0], ba: [-25, -10], when: m => m < 10 },
    { kind: "ухаживает", ab: [8, 15], ba: [-5, 15], when: m => m > 30 },
]

function rlShift(village, l, dab, dba) {
    var sh = village.relShift || (village.relShift = {})
    var k = l.a + "|" + l.b
    sh[k + ">"] = Math.max(-150, Math.min(150, (sh[k + ">"] || 0) + dab))
    sh[k + "<"] = Math.max(-150, Math.min(150, (sh[k + "<"] || 0) + dba))
}

/** Прожить день: в каждом поселении 1-3 события между связанными жителями; сдвиги и летопись. */
function rlDailyLife(server) {
    var level = server.overworld()
    var day = Math.floor(Number(level.getTime()) / RL_DAY)
    var villages = global.TFG_SETTLERS.list()
    var n = 0
    for (var vid in villages) {
        var v = villages[vid]
        if (!v.settlers || v.settlers.filter(s => !s.dead).length < 4) continue
        var links = rlBase(v)
        if (!links.length) continue
        var times = 1 + Math.floor(Math.random() * 3)
        for (var i = 0; i < times; i++) {
            var l = links[Math.floor(Math.random() * links.length)]
            var flip = Math.random() < 0.5
            var a = flip ? l.b : l.a, b = flip ? l.a : l.b
            var mine = rlLinks(v, a).filter(x => x.other === b)[0]
            var ok = RL_EVENTS.filter(ev => ev.when(mine ? mine.mine : 0))
            if (!ok.length) continue
            var ev = ok[Math.floor(Math.random() * ok.length)]
            var r = x => x[0] + Math.floor(Math.random() * (x[1] - x[0] + 1))
            var dab = r(ev.ab), dba = r(ev.ba)
            if (flip) rlShift(v, l, dba, dab)
            else rlShift(v, l, dab, dba)
            var log = v.relLog || (v.relLog = [])
            log.push({ day: day, a: a, b: b, kind: ev.kind })
            while (log.length > RL_LOG_MAX) log.shift()
            n++
        }
    }
    if (n) {
        try { global.TFG_SETTLERS.save() } catch (e) { }
        rlLog("день " + day + ": событий между жителями " + n)
    }
}

// ─── Образ игрока ────────────────────────────────────────────────────────────

/** Что на игроке сейчас: роскошь, боевитость, простота (0..1). */
function rlLookNow(player) {
    var lux = 0, war = 0, tool = false
    var add = st => {
        if (!st || st.isEmpty()) return
        var id = String(st.id)
        var w = null
        try { w = global.TFG_WARDROBE_PRICE(id) } catch (e) { }
        if (w) { lux += w.value; return }
        var price = 0
        try { price = Number(global.TFG_TRADE_GOODS.itemPrice(id)) || 0 } catch (e) { }
        if (st.isDamageableItem()) war += price
    }
    try { [RL_Slot.HEAD, RL_Slot.CHEST, RL_Slot.LEGS, RL_Slot.FEET].forEach(s => add(player.getItemBySlot(s))) } catch (e) { }
    try {
        if (RL_Wardrobe) {
            var wr = RL_Wardrobe.of(player)
            for (var i = 0; wr && i < wr.getSlots(); i++) add(wr.getStackInSlot(i))
        }
    } catch (e) { }
    var hand = player.getMainHandItem()
    var hid = String(hand.id)
    if (/(pickaxe|_axe|shovel|hoe|scythe|hammer|saw|chisel|knife|mattock|propick|sickle)/.test(hid)) tool = true
    else add(hand)
    add(player.getOffhandItem())
    var luxN = Math.min(1, Math.log(1 + lux) / Math.log(2500))
    var warN = Math.min(1, Math.log(1 + war) / Math.log(1500))
    var simple = Math.max(0, (tool ? 0.6 : 0.2) + (luxN < 0.25 ? 0.4 : 0) - luxN * 0.5 - warN * 0.3)
    return { lux: luxN, war: warN, simple: Math.min(1, simple) }
}

/** Образ игрока - сглаженный (то, что о нём думают). */
function rlLook(player) {
    var pd = player.persistentData
    if (!pd.contains("tfg_look_lux")) {
        var now = rlLookNow(player)
        return { lux: now.lux * 0.5, war: now.war * 0.5, simple: 0.5 }
    }
    return { lux: Number(pd.getDouble("tfg_look_lux")), war: Number(pd.getDouble("tfg_look_war")), simple: Number(pd.getDouble("tfg_look_simple")) }
}

function rlLookTick(player) {
    var now = rlLookNow(player)
    var pd = player.persistentData
    var first = !pd.contains("tfg_look_lux")
    ;["lux", "war", "simple"].forEach(k => {
        var cur = first ? 0.3 : Number(pd.getDouble("tfg_look_" + k))
        pd.putDouble("tfg_look_" + k, cur + (now[k] - cur) * RL_LOOK_RATE)
    })
}

/** Как образ игрока смотрится глазами сословия: { value, aspect, sign }. */
function rlLookAffinity(look, estate) {
    var parts
    if (estate === "знать") parts = { lux: look.lux * 45, war: look.war * 10, simple: -look.simple * 20 }
    else if (estate === "военные") parts = { lux: -look.lux * 5, war: look.war * 45, simple: look.simple * 5 }
    else parts = { lux: -Math.max(0, look.lux - 0.4) * 30, war: look.war * 5, simple: look.simple * 35 }
    var value = 0, aspect = null, top = 0
    for (var k in parts) {
        value += parts[k]
        if (Math.abs(parts[k]) > Math.abs(top)) { top = parts[k]; aspect = k }
    }
    return { value: value, aspect: aspect, sign: top >= 0 ? 1 : -1, strength: Math.abs(top) }
}

// ─── Отношение жителя к игроку ───────────────────────────────────────────────

/** Личная память поселения о игроке: что он сделал каждому жителю (-100..+100). */
function rlMem(village, player) {
    var m = village.pmem || (village.pmem = {})
    return m[String(player.uuid)] || (m[String(player.uuid)] = {})
}

/** Отметить поступок игрока к жителю (помог +, обидел -). Друзья и враги жителя тоже это запомнят. */
function rlNote(village, player, sid, d, why) {
    var mem = rlMem(village, player)
    mem[sid] = Math.max(-100, Math.min(100, (mem[sid] || 0) + d))
    try { global.TFG_SETTLERS.save() } catch (e) { }
    rlLog("поселение " + village.id + ": " + player.username + " -> " + sid + " " + (d > 0 ? "+" : "") + d + " (" + why + ")")
}

function rlOpinion(player, village, s) {
    var faction = 0
    try { faction = Number(global.TFG_FACTIONS.rep(player, village.faction)) * 0.5 } catch (e) { }
    var mem = rlMem(village, player)
    var personal = mem[s.id] || 0
    var social = 0
    rlLinks(village, s.id).forEach(l => {
        var done = mem[l.other]
        if (done) social += done * l.mine / 100 * 0.5            // друга обидел - и мне обидно; врага - мне по душе
    })
    var estate = global.TFG_SETTLERS.estateOf(s)
    var look = rlLookAffinity(rlLook(player), estate)
    var value = Math.max(-100, Math.min(100, faction + personal + social + look.value))
    return { value: value, faction: faction, personal: personal, social: social, look: look, estate: estate }
}

function rlTier(v) { return v < -50 ? 0 : v < -15 ? 1 : v < 15 ? 2 : v < 50 ? 3 : 4 }

// ─── Реплики при встрече ─────────────────────────────────────────────────────

/** По сословию и ступени отношения: 0 - враждебно, 1 - холодно, 2 - ровно, 3 - тепло, 4 - с почтением. */
const RL_LINES = {
    "знать": [
        ["Стража! Пусть этот уберётся с глаз.", "Не смей подходить ко мне.", "Тебе здесь не рады. Ступай прочь.", "Я запомнил твоё лицо. Пожалеешь.",
            "Ещё шаг - и тебя вышвырнут за ворота.", "Мерзость. Кто тебя сюда пустил?", "Говорить с тобой - пачкать язык.", "Тебя бы в колодки, а не по улицам."],
        ["Хм. Опять ты.", "Не задерживай меня, у меня дела.", "Мне некогда.", "Чего тебе? Говори быстрее.",
            "Ты здесь не по делу, полагаю.", "Держись поодаль.", "Мы с тобой не ровня.", "Не жди от меня милостей."],
        ["Доброго дня.", "Проходи, коли пришёл.", "Ты по делу или так?", "Путник. Что ж.",
            "Здесь порядок. Не нарушай его.", "Если есть дело - говори с управителем.", "День как день.", "Смотри, не наследи."],
        ["А, рад видеть.", "Добро пожаловать, друг.", "Ты всегда кстати.", "Заходи, поговорим.",
            "Приятно видеть знакомое лицо.", "Для тебя у меня найдётся минута.", "Как дорога? Без бед?", "Ты держишься достойно, это видно."],
        ["Какая честь! Прошу, прошу.", "Для тебя двери моего дома открыты.", "Ты украшаешь наш город своим присутствием.", "Слово твоё здесь весит немало.",
            "Позволь угостить тебя вином.", "Я велел слугам принимать тебя как родного.", "Таких гостей мы ждём годами.", "Скажи - и всё будет сделано."],
    ],
    "военные": [
        ["Руку с оружия. Медленно.", "Ещё раз увижу - пожалеешь.", "Я за тобой слежу.", "Шаг в сторону - и я рублю.",
            "Мразь. Только дай повод.", "Не стой у меня за спиной.", "Ты нам враг, и все это знают.", "Проваливай, пока цел."],
        ["Не задерживайся.", "Проходи, не толпись.", "Без глупостей тут.", "Что у тебя в мешке?",
            "Оружие держи в ножнах.", "Не нравишься ты мне.", "Смотри у меня.", "Гуляй дальше."],
        ["Проходи.", "Всё спокойно?", "Не шуми у ворот.", "Ворота на закате закрываем.",
            "Тихо сегодня.", "Дорога чистая была?", "Если что - зови стражу.", "Порядок тут блюдём."],
        ["Здорово, свой!", "О, ты! Как дела?", "Рад видеть, брат.", "Надо будет - зови, подсоблю.",
            "Хороший день, правда?", "С тобой спокойнее.", "Слыхал, ты в деле не трус.", "Заходи к нам в караулку."],
        ["Честь тебе, воин!", "За тобой - хоть в огонь.", "О твоих делах уже песни поют.", "Для меня честь стоять рядом.",
            "Командуй - мы с тобой.", "Таких бойцов поискать.", "Ребята, смирно! Свои.", "Твоё слово - закон для меня."],
    ],
    "простолюдины": [
        ["Уйди от меня!", "Что тебе надо? Не трогай!", "Люди, держитесь от него подальше.", "Проклятый. Чтоб тебя.",
            "Тебе тут не рады.", "Ничего у меня нет, иди мимо.", "Сгинь, нечистый.", "Опять беда пришла."],
        ["Чего встал?", "Иди своей дорогой.", "Нам и без тебя забот хватает.", "Ну, чего надо?",
            "Ходят тут всякие.", "Не мешай работать.", "Мимо, мимо.", "Некогда мне."],
        ["Здравствуй.", "День добрый.", "Работы невпроворот.", "Погода нынче ничего.",
            "Ты к кому?", "У нас тут тихо.", "Урожай бы собрать.", "Ходи, смотри."],
        ["О, здравствуй! Рад тебя видеть.", "Заходи, пирогом угощу.", "Свои люди - всегда кстати.", "Помнишь, как ты помог? Не забыли.",
            "Как здоровье?", "Хороший ты человек.", "С тобой и работа спорится.", "Детишки про тебя спрашивали."],
        ["Благодетель наш!", "Поклон тебе до земли.", "За тебя всем селом молимся.", "Дай руку пожму!",
            "Что угодно - только скажи.", "Такие, как ты, мир держат.", "Хлеб-соль тебе в любой час.", "Ты нам как родной."],
    ],
}

/** Про образ игрока: сословие -> черта -> «по душе» (1) или «не по душе» (-1). */
const RL_LOOK_LINES = {
    "знать": {
        lux: { "1": ["Изящная работа. Перстень, вижу, не из дешёвых.", "Сразу видно человека со вкусом.", "Какой мех! Где такой добыли?", "Наряд, достойный двора."],
               "-1": ["Блеску много, а толку?", "Нацепил побрякушек - и думает, что ровня.", "Пыль в глаза пускаешь.", "Золото не делает человека."] },
        war: { "1": ["Добрая сталь. Видно, ты не из пугливых.", "Оружие у тебя знатное.", "Рыцарская выправка.", "С таким доспехом и в королевскую гвардию."],
               "-1": ["Убери железо, тут не поле боя.", "Не люблю, когда с оружием лезут.", "Кровью от тебя пахнет.", "Наёмник, что ли?"] },
        simple: { "1": ["Скромно, но опрятно.", "Простота - тоже достоинство.", "Рабочий человек, уважаю.", "Не по чину, но честно."],
                  "-1": ["Фу, от тебя несёт конюшней.", "В таком тряпье - и к нам?", "Переоделся бы хоть.", "Чернь у ворот - к беде."] },
    },
    "военные": {
        war: { "1": ["Хороший клинок. Покажешь как-нибудь?", "Доспех ладный, сидит как влитой.", "Вот это я понимаю - снаряжение!", "С таким не страшно и в дозор."],
               "-1": ["Ржавчина на клинке - позор бойцу.", "С такой железкой только кур гонять.", "Подтяни ремни, вояка.", "Доспех бы тебе получше."] },
        lux: { "1": ["Богато живёшь, видно.", "Красиво, но в бою не поможет.", "Цацки - это хорошо, а меч где?", "Не потеряй своё золото."],
               "-1": ["Разряженный, как павлин.", "Золото не защитит от стрелы.", "Неженка.", "В таких тряпках только на пир."] },
        simple: { "1": ["Работяга, сразу видно.", "Без лишнего - так и надо.", "Простой ты человек, это хорошо.", "Руки у тебя рабочие."],
                  "-1": ["Безоружный бродить вздумал?", "Хоть нож при себе держи.", "Ты бы хоть копьё взял.", "Беззащитный ты."] },
    },
    "простолюдины": {
        simple: { "1": ["Свой, рабочий человек!", "Мозоли-то настоящие, вижу.", "Инструмент у тебя добрый.", "С нами одной породы."],
                  "-1": ["Руки белые, не работал никогда.", "Не нашего ты поля ягода.", "Пахать бы тебя отправить.", "Чистенький слишком."] },
        lux: { "1": ["Ох, красота какая!", "Вот бы мне такое колечко.", "Богато, богато.", "Знатный гость, видать."],
               "-1": ["Ишь, вырядился.", "Золотом звенит, а мы голодаем.", "Нам бы твоё колечко - год прожили бы.", "Барин, чтоб его."] },
        war: { "1": ["С таким защитником спокойно.", "Оружие что надо.", "Ты разбойников-то гоняешь?", "Сильный, видать, человек."],
               "-1": ["Убери железо, детей пугаешь.", "Опять воители пожаловали.", "Не люблю я оружных.", "От вас, вояк, одни беды."] },
    },
}

var RL_BARKED = {}                  // "игрок|житель" -> когда говорил

function rlPick(list) { return list[Math.floor(Math.random() * list.length)] }

function rlBarkTick(server) {
    var level = server.overworld()
    var now = Number(level.getTime())
    var villages = global.TFG_SETTLERS.list()
    server.players.forEach(p => {
        if (p.level !== level) return
        var near = level.getEntities(p, p.getBoundingBox().inflate(RL_BARK_R))
        for (var i = 0; i < near.size(); i++) {
            var e = near.get(i)
            if (!e.getTags || !e.getTags().contains("tfg_settler")) continue
            var vid = null, sid = null
            var it = e.getTags().iterator()
            while (it.hasNext()) {
                var t = String(it.next())
                if (t.indexOf("tfg_v_") === 0) vid = t.substring(6)
                if (t.indexOf("tfg_sid_") === 0) sid = t.substring(8)
            }
            var v = vid && villages[vid]
            var s = v && v.settlers.filter(x => x.id === sid)[0]
            if (!s) continue
            var k = String(p.uuid) + "|" + vid + "|" + sid
            if (RL_BARKED[k] && now - RL_BARKED[k] < RL_BARK_COOLDOWN) continue
            RL_BARKED[k] = now
            if (Math.random() > RL_BARK_CHANCE) continue
            if (v.state && v.state !== "мир") continue           // тревога - не до разговоров
            var op = rlOpinion(p, v, s)
            var line = null
            var ll = RL_LOOK_LINES[op.estate] && RL_LOOK_LINES[op.estate][op.look.aspect]
            if (ll && op.look.strength >= 12 && Math.random() < 0.5) line = rlPick(ll[String(op.look.sign)])
            if (!line) line = rlPick(RL_LINES[op.estate][rlTier(op.value)])
            try { if (typeof seVoice === "function") seVoice(e, line) } catch (err) { }
            return                                                // одна реплика за раз
        }
    })
}

ServerEvents.tick(event => {
    var t = event.server.tickCount
    if (t % RL_LOOK_EVERY === 0) {
        event.server.players.forEach(p => { try { rlLookTick(p) } catch (e) { } })
    }
    if (t % RL_DAY === 600) {
        try { rlDailyLife(event.server) } catch (e) { rlLog("жизнь графа: " + e) }
    }
    if (t % RL_BARK_EVERY === 0) {
        try { rlBarkTick(event.server) } catch (e) { rlLog("встреча: " + e) }
    }
})

// ─── Поступки игрока к жителям ───────────────────────────────────────────────

/**
 * МЕТКИ СУЩЕСТВА - ДВУМЯ ПУТЯМИ (28.10.2026).
 *
 * getTags() в этой сборке местами отдаёт пустоту. Здесь это стоило дорого: rlSettlerOf не
 * опознавал жителя, из-за чего tkWho возвращал ничего - и РАЗГОВОР НЕ ЗНАЛ, КТО ПЕРЕД НИМ.
 * Кнопки в разговоре молчали, наём спутника тихо ничего не делал, реплик не было.
 *
 * Поэтому: сперва обычный путь, а если он пуст - читаем Tags прямо из данных существа.
 */
function rlTags(e) {
    var out = []
    try {
        var it = e.getTags().iterator()
        while (it.hasNext()) out.push(String(it.next()))
    } catch (err) { }
    if (out.length) return out
    try {
        var list = e.nbt ? e.nbt.getList("Tags", 8) : null
        if (list) for (var i = 0; i < list.size(); i++) out.push(String(list.getString(i)))
    } catch (err) { }
    return out
}

function rlSettlerOf(e) {
    if (!e) return null
    var tags = rlTags(e)
    var vid = null, sid = null, isSettler = false
    for (var i = 0; i < tags.length; i++) {
        var t = tags[i]
        if (t === "tfg_settler") isSettler = true
        if (t.indexOf("tfg_v_") === 0) vid = t.substring(6)
        if (t.indexOf("tfg_sid_") === 0) sid = t.substring(8)
    }
    if (!isSettler) return null
    var v = vid && global.TFG_SETTLERS.list()[vid]
    return v ? { v: v, sid: sid } : null
}

EntityEvents.hurt(event => {
    try {
        var p = event.source.player
        if (!p) return
        var who = rlSettlerOf(event.entity)
        if (who) rlNote(who.v, p, who.sid, -10, "ударил")
    } catch (e) { }
})

EntityEvents.death(event => {
    try {
        var p = event.source.player
        if (!p) return
        var who = rlSettlerOf(event.entity)
        if (who) rlNote(who.v, p, who.sid, -100, "убил")
    } catch (e) { }
})

// ─── Команды ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    event.register(Commands.literal("tfgrel").requires(s => s.hasPermission(2))
        .then(Commands.literal("day").executes(ctx => {
            rlDailyLife(ctx.source.getServer())
            ctx.source.sendSuccess(Text.of("Прожит день: события между жителями - в /tfgrel npc (раздел «недавно»)."), false)
            return 1
        }))
        .then(Commands.literal("me").executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var l = rlLook(p), n = rlLookNow(p)
            var f = x => (x * 100).toFixed(0) + "%"
            ctx.source.sendSuccess(Text.of("Образ (что о тебе думают / как одет сейчас):\n роскошь " + f(l.lux) + " / " + f(n.lux) +
                "\n боевитость " + f(l.war) + " / " + f(n.war) + "\n простота " + f(l.simple) + " / " + f(n.simple)), false)
            return 1
        }))
        .then(Commands.literal("npc").executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            // житель, на которого смотрят: ближе 6 блоков и почти прямо по взгляду
            var look = p.getLookAngle(), eye = p.getEyePosition()
            var who = null, best = 0.9
            var list = p.level.getEntities(p, p.getBoundingBox().inflate(6))
            for (var i = 0; i < list.size(); i++) {
                var cand = rlSettlerOf(list.get(i))
                if (!cand) continue
                var ce = list.get(i)
                var dx = ce.getX() - Number(eye.x), dy = ce.getY() + ce.getBbHeight() / 2 - Number(eye.y), dz = ce.getZ() - Number(eye.z)
                var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
                var dot = (dx * Number(look.x) + dy * Number(look.y) + dz * Number(look.z)) / d
                if (dot > best) { best = dot; who = cand }
            }
            if (!who) { ctx.source.sendFailure(Text.of("Наведи прицел на жителя.")); return 1 }
            var s = who.v.settlers.filter(x => x.id === who.sid)[0]
            var op = rlOpinion(p, who.v, s)
            var name = id => { var o = who.v.settlers.filter(x => x.id === id)[0]; return o ? o.name + " (" + o.role + ")" : id }
            var links = rlLinks(who.v, s.id).map(l => "  " + l.word + ": " + name(l.other) + " - " + Math.round(l.mine) + " / " + Math.round(l.theirs))
            var told = (who.v.relLog || []).filter(x => x.a === s.id || x.b === s.id).slice(-5)
                .map(x => "  день " + x.day + ": " + name(x.a) + " " + x.kind + " - " + name(x.b))
            ctx.source.sendSuccess(Text.of("§f" + s.name + " §7(" + s.role + ", " + op.estate + ")\nк тебе: " + Math.round(op.value) +
                " = фракция " + Math.round(op.faction) + " + лично " + Math.round(op.personal) + " + друзья/враги " + Math.round(op.social) +
                " + образ " + Math.round(op.look.value) + "\nсвязи (он о нём / тот о нём):\n" + (links.join("\n") || "  нет") +
                (told.length ? "\nнедавно:\n" + told.join("\n") : "")), false)
            return 1
        })))
})

global.TFG_RELATIONS = {
    opinion: (player, village, s) => rlOpinion(player, village, s),
    look: player => rlLook(player),
    links: (village, sid) => rlLinks(village, sid),
    note: (village, player, sid, d, why) => rlNote(village, player, sid, d, why),
    // сделка с жителем: +1 к личному отношению за каждые 100 медяков, не больше +10 за раз
    dealt: (player, entity, amount) => {
        var who = rlSettlerOf(entity)
        var d = Math.min(10, Math.floor((Number(amount) || 0) / 100))
        if (who && d > 0) rlNote(who.v, player, who.sid, d, "сделка на " + Math.round(amount))
    },
    tier: v => rlTier(v),
    // летопись поселения: последние события между жителями [{ day, a, b, kind }]
    log: village => village.relLog || [],
}
