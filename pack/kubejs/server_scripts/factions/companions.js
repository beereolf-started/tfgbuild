// priority: -14
"use strict";
/**
 * СПУТНИКИ И ЖИТЕЛИ БАЗЫ (этап 7 плана NPC: Downloads/TFG-NPC-план.md).
 *
 * СПУТНИК. «Пойдёшь со мной?» - друг идёт даром, приятель - за 100 медяков, прочие откажут; правитель
 * поселения не бросит. Не больше двух спутников. Спутник:
 *   - ходит следом; отстал дальше 32 блоков, застрял, попал в воду или лаву - переносится к игроку;
 *   - садится к игроку в лодку или повозку, если есть место; нет - едет «следом» переносами;
 *   - бьёт того, кто ударил игрока, и того, кого бьёт игрок;
 *   - не гибнет от падения, утопления и удушья в стене; случайный удар хозяина его не ранит;
 *   - иногда заговаривает в пути;
 *   - «Подожди здесь» / «Идём дальше», «Возвращайся домой».
 * Игрок вышел и вошёл, а спутник остался далеко (или пропал) - он появляется рядом.
 *
 * ЖИТЕЛЬ БАЗЫ. «Живи у меня на базе» (нужна база фракции игрока, settlements.js) - житель уходит на базу
 * и живёт там: бродит около неё, воины бьют монстров в 20 блоках, все едят дважды в день самое сытное
 * из хранилищ базы; три дня голода - уходит домой с обидой. «Возвращайся домой» - обратно в поселение.
 *
 * Запись жителя: s.away = "спутник" | "база", s.comp = { owner, mode: "идёт"|"ждёт"|"база", base, hungry, ... }.
 * Сущность - метка tfg_companion; деревенские дела (settlers.js) её не трогают (seEntities её пропускает).
 */

const CP_MAX = 2
const CP_HIRE_PRICE = 100
// Замысел (задан пользователем, уточнён 29.10.2026):
//   держится в 32 блоках от игрока; дальше 32 - идёт к нему; дальше 64 - бежит;
//   перенос к игроку за спину - только если дальше 64, застрял И игрок не видел его 20+ секунд.
const CP_HOLD = 32                     // дальше этого идёт к игроку
const CP_RUN_FAR = 64                  // дальше этого бежит; только дальше этого возможен перенос
const CP_KEEP = 6                      // ближе этого стоит, дальше - подтягивается шагом
const CP_STUCK_T = 100                 // столько тиков не приближался хотя бы на 2 блока - застрял (5 секунд)
const CP_NOPATH = 60                   // столько тиков без дороги, прежде чем счесть, что её нет
const CP_UNSEEN = 400                  // сколько тиков игрок не должен на него смотреть (20 секунд)
const CP_SEEN_DOT = 0.45               // насколько прямо игрок смотрит, чтобы счесть «видит»
const CP_SEEN_R = 96                   // дальше этого не видит всё равно
const CP_SEEN_AT = {}                  // uuid -> когда игрок последний раз его видел
const CP_NEAR = 4
const CP_BASE_R = 20
const CP_DAY = 24000
const CP_UUID = Java.loadClass("java.util.UUID")

var CP_STUCK = {}                     // uuid сущности -> { d, at }
var CP_SAID = {}                      // uuid сущности -> когда последний раз писали о нём в журнал
var CP_BARK_AT = {}                   // uuid сущности -> тик сервера
var CP_LOST = {}                      // "vid|sid" -> тик, с которого спутника нет в мире

function cpLog(m) { try { global.tfgLog("tfg companions", m) } catch (e) { } }
function cpPick(a) { return a[Math.floor(Math.random() * a.length)] }

// ─── Записи ──────────────────────────────────────────────────────────────────

/** Номер игрока к одному виду: без чёрточек, в нижнем регистре - форматы записи различались. */
function cpUuid(x) { return String(x).replace(/-/g, "").toLowerCase() }

function cpMine(player) {
    var out = [], u = cpUuid(player.uuid), vs = global.TFG_SETTLERS.list()
    for (var vid in vs) vs[vid].settlers.forEach(s => {
        if (s.comp && !s.dead && cpUuid(s.comp.owner) === u) out.push({ v: vs[vid], s: s })
    })
    return out
}

/** Все записи со спутниками, чей бы ни был - для разбора, почему команда показывает ноль. */
function cpAllRecords() {
    var out = [], vs = global.TFG_SETTLERS.list()
    for (var vid in vs) vs[vid].settlers.forEach(s => { if (s.comp) out.push({ v: vs[vid], s: s }) })
    return out
}

/**
 * ВСЕ СУЩЕСТВА РЯДОМ С ИГРОКАМИ.
 *
 * Прежде и погоня, и сторож потерявшихся брали общий список существ мира (level.getEntities()).
 * В этой сборке он ничего не отдаёт - и из этого вышло всё разом: погоня не работала, спутник
 * отставал, сторож его не находил и каждые 60 секунд СОЗДАВАЛ нового рядом с игроком. В журнале
 * это и видно: «догнал (появился рядом)» ровно каждые 70 секунд, у обоих сразу.
 *
 * Теперь обходим коробку вокруг каждого игрока - тем же способом, каким считает тварей
 * iceandfire/iaf_cap.js, он в этой сборке работает. Спутник всегда возле игрока, так что
 * ничего не теряется, а расход не зависит от размера мира.
 */
const CP_SCAN_R = 160
const CP_AABB = Java.loadClass("net.minecraft.world.phys.AABB")

function cpNearbyEntities(level) {
    var out = [], seen = {}
    var players = []
    try { players = level.getServer().getPlayerList().getPlayers() } catch (err) { }
    // Длину и способ доступа считаем ОДИН раз. Прежде здесь стояло
    //   for (var i = 0; i < players.size ? players.size() : players.length; i++)
    // и из-за старшинства операций сравнение съедало тернарный оператор: условие всегда было
    // числом, цикл не останавливался и выходил за границы списка (IndexOutOfBounds).
    var isJava = false
    try { isJava = typeof players.size === "function" } catch (err) { isJava = false }
    var n = 0
    try { n = isJava ? players.size() : players.length } catch (err) { n = 0 }
    if (!n) {
        try {
            players = SERVER.getPlayerList().getPlayers()
            isJava = typeof players.size === "function"
            n = isJava ? players.size() : players.length
        } catch (err) { players = []; isJava = false; n = 0 }
    }
    for (var i = 0; i < n; i++) {
        var p = isJava ? players.get(i) : players[i]
        if (!p) continue
        try {
            if (String(p.level.getDimension()) !== String(level.getDimension())) continue
        } catch (err) { }
        var box
        try {
            box = new CP_AABB(p.getX() - CP_SCAN_R, p.getY() - 64, p.getZ() - CP_SCAN_R,
                              p.getX() + CP_SCAN_R, p.getY() + 64, p.getZ() + CP_SCAN_R)
        } catch (err) { continue }
        var list = null
        try { list = level.getEntitiesWithin(box) } catch (err) { list = null }
        if (!list) continue
        for (var j = 0; j < list.size(); j++) {
            var e = list.get(j)
            if (!e) continue
            var u = String(e.uuid)
            if (seen[u]) continue
            seen[u] = 1
            out.push(e)
        }
    }
    // Счёт в журнал раз в минуту: без него не отличить «обход не работает» от «спутник далеко».
    try {
        var nowT = Number(SERVER.tickCount)
        if (!cpNearbyEntities.said || nowT - cpNearbyEntities.said > 1200) {
            cpNearbyEntities.said = nowT
            var comp = 0, sett = 0
            for (var q = 0; q < out.length; q++) {
                try {
                    if (cpHasTag(out[q], "tfg_companion")) comp++
                    if (cpTagValue(out[q], "tfg_v_") !== null) sett++
                } catch (err) { }
            }
            cpLog("обход: игроков " + n + ", существ рядом " + out.length + ", жителей " + sett + ", спутников " + comp)
        }
    } catch (err) { }

    // запас: если игроков нет или коробка не сработала - прежний общий список
    if (!out.length) {
        try {
            var all = level.getEntities()
            for (var k = 0; k < all.size(); k++) out.push(all.get(k))
        } catch (err) { }
    }
    return out
}

/**
 * МЕТКИ СУЩЕСТВА - НАДЁЖНО.
 *
 * Обход вокруг игрока видит шестьсот существ, а спутников среди них ноль: значит метки либо
 * не ставятся, либо не читаются через getTags(). Это уже третий случай подряд, когда способ
 * игры молча отдаёт пустоту (так было со взглядом игрока и с признаком «не исчезать»).
 *
 * Поэтому читаем метки двумя путями: сперва getTags(), а если он пуст - из данных самого
 * существа (Tags в NBT). Возвращаем обычный массив строк.
 */
function cpTags(e) {
    var out = []
    try {
        var s = e.getTags()
        if (s) {
            var it = s.iterator()
            while (it.hasNext()) out.push(String(it.next()))
        }
    } catch (err) { }
    if (out.length) return out
    try {
        var nbt = e.nbt
        var list = nbt ? nbt.getList("Tags", 8) : null
        if (list) for (var i = 0; i < list.size(); i++) out.push(String(list.getString(i)))
    } catch (err) { }
    return out
}

function cpHasTag(e, tag) {
    var tags = cpTags(e)
    for (var i = 0; i < tags.length; i++) if (tags[i] === tag) return true
    return false
}

/** Значение метки с приставкой: tfg_v_7 -> "7". */
function cpTagValue(e, prefix) {
    var tags = cpTags(e)
    for (var i = 0; i < tags.length; i++) if (tags[i].indexOf(prefix) === 0) return tags[i].substring(prefix.length)
    return null
}
const CP_UUIDC = Java.loadClass("java.util.UUID")
const CP_ENT_CACHE = {}

/**
 * НАЙТИ СПУТНИКА - ПО НОМЕРУ СУЩЕСТВА, КАК У ГОСТЕЙ.
 *
 * Поиск по меткам не работал: getTags() в этой сборке местами отдаёт пустоту, и спутник считался
 * потерянным, хотя стоял рядом. Гости (guests.js, gsEntity) ищут по номеру существа через
 * level.getEntity - это работает у них месяцами. Делаем так же.
 *
 * Номер берём из записи (comp.euuid). У старых записей его нет - тогда разово ищем по меткам и
 * запоминаем, чтобы дальше работало по номеру.
 */
function cpByUuid(level, uuid) {
    if (!uuid) return null
    var e = CP_ENT_CACHE[uuid]
    try { if (e && !e.isRemoved()) return e.isAlive() ? e : null } catch (err) { }
    try { e = level.getEntity(CP_UUIDC.fromString(uuid)) } catch (err) { e = null }
    if (e) CP_ENT_CACHE[uuid] = e
    try { return e && e.isAlive() ? e : null } catch (err) { return null }
}

function cpEntity(level, v, s) {
    if (s.comp && s.comp.euuid) {
        var byId = cpByUuid(level, s.comp.euuid)
        if (byId) return byId
    }
    var list = cpNearbyEntities(level)
    for (var i = 0; i < list.length; i++) {
        var e = list[i]
        try {
            if (!e.isAlive()) continue
            if (cpHasTag(e, "tfg_v_" + v.id) && cpHasTag(e, "tfg_sid_" + s.id)) {
                // нашли по меткам - запоминаем номер, дальше будет по нему
                try { if (s.comp) s.comp.euuid = String(e.uuid) } catch (err2) { }
                return e
            }
        } catch (err) { }
    }
    return null
}

/** Существо жителя где угодно в прогруженном мире (общий список существ), не только у игрока. */
function cpAnywhere(level, v, s) {
    try {
        var all = level.getEntities()
        for (var i = 0; i < all.size(); i++) {
            var e = all.get(i)
            if (!e || !e.isAlive()) continue
            if (cpHasTag(e, "tfg_v_" + v.id) && cpHasTag(e, "tfg_sid_" + s.id)) return e
        }
    } catch (err) { }
    return null
}

/** Точка в dist блоках за спиной игрока: { x, z }. */
function cpBehind(p, dist) {
    var look = null
    try { look = cpLook(p) } catch (err) { }
    var bx = 0, bz = 0
    if (look) { var l = Math.sqrt(look.x * look.x + look.z * look.z); if (l > 0.01) { bx = -look.x / l; bz = -look.z / l } }
    if (!bx && !bz) { var a = Math.random() * 6.283185307179586; bx = Math.cos(a); bz = Math.sin(a) }
    return { x: Math.floor(p.getX() + bx * dist), z: Math.floor(p.getZ() + bz * dist) }
}

/** Все спутники и жители базы в мире: { e, v, s }. */
/**
 * ВСЕ СПУТНИКИ - ОТ ЗАПИСЕЙ, А НЕ ОБХОДОМ МИРА.
 *
 * Прежде мы обходили сотни существ вокруг игрока и искали среди них своих по меткам. Теперь идём
 * от записей поселений: у кого есть хозяин - того и ищем по номеру существа. Расход не зависит от
 * числа существ рядом, и метки больше ни при чём.
 */
function cpAll(level) {
    var out = [], vs = global.TFG_SETTLERS.list()
    for (var vid in vs) {
        var v = vs[vid]
        for (var i = 0; i < v.settlers.length; i++) {
            var s = v.settlers[i]
            if (!s.comp || s.dead) continue
            var e = cpEntity(level, v, s)
            if (e) out.push({ e: e, v: v, s: s })
        }
    }
    return out
}

/**
 * ХОД ОТРЕЗКАМИ - КАК У ГОСТЕЙ (guests.js, gsWalk, GS_LEG = 32).
 *
 * Навигация хаска длинных путей не строит: приказ идти к игроку за сто блоков просто не
 * исполняется, спутник стоит. Поэтому ведём его отрезками по 32 блока в сторону цели, беря
 * высоту по карте поверхности. У гостей так работает месяцами.
 */
const CP_LEG = 32
const CP_HEIGHT = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types").MOTION_BLOCKING_NO_LEAVES

function cpWalk(e, x, y, z, speed) {
    var dx = x - e.getX(), dz = z - e.getZ()
    var d = Math.sqrt(dx * dx + dz * dz)
    if (d > CP_LEG + 4) {
        x = e.getX() + dx / d * CP_LEG
        z = e.getZ() + dz / d * CP_LEG
        try { y = Number(e.level.getHeight(CP_HEIGHT, Math.floor(x), Math.floor(z))) } catch (err) { }
    }
    try { e.getNavigation().moveTo(x, y, z, speed) } catch (err) { }
}
function cpOwner(server, s) {
    try { return server.getPlayerList().getPlayer(CP_UUID.fromString(s.comp.owner)) } catch (e) { return null }
}

function cpMark(e, on) {
    try { if (on) e.addTag("tfg_companion"); else e.removeTag("tfg_companion") } catch (err) { }
    if (on) cpKeep(e)
}

/**
 * СПУТНИК НЕ ДОЛЖЕН ИСЧЕЗАТЬ НИКОГДА.
 *
 * Жители - это хаски, то есть для игры обычные чудовища. Игра сама убирает чудовищ, когда игрок
 * отошёл: случайно за 32 блоками и всегда за 128. Поэтому спутник "появлялся, говорил и пропадал" -
 * его стирала сама игра, а не наш код.
 *
 * Лечится признаком PersistenceRequired: он хранится в самой сущности и переживает выгрузку куска
 * мира. Ставим его при найме и подтверждаем на каждом ходу - на случай, если житель был создан
 * заново из записи поселения и признак не достался.
 */
const CP_KEPT = {}
function cpKeep(e) {
    var u = String(e.uuid)
    if (CP_KEPT[u]) return
    try { e.setPersistenceRequired(); CP_KEPT[u] = 1; return } catch (err) { }
    // Способа нет - ставим признак командой. Команды есть всегда, а имена способов в этой
    // сборке KubeJS местами другие, и молчаливый отказ уже стоил нам пропадающих спутников
    // (ровно та же ловушка была со взглядом игрока).
    try {
        if (!SERVER) return
        var at = "execute positioned " + e.getX() + " " + e.getY() + " " + e.getZ() + " run "
        SERVER.runCommandSilent(at + 'data merge entity @e[tag=tfg_companion,distance=..1,limit=1,sort=nearest] {PersistenceRequired:1b}')
        CP_KEPT[u] = 1
    } catch (err) { }
}

// ─── Позвать, отпустить, поселить на базе ────────────────────────────────────

const CP_YES = ["Пойду. С тобой хоть на край света.", "Давно хотел посмотреть мир. Идём.", "Веди. Я рядом."]
const CP_PAY = ["Пойду, но не задаром. Сотню медяков - и я твой спутник.", "Дорога опасна. Заплатишь сотню - пойду."]
const CP_NO = ["С тобой? Не знаю тебя толком. Нет.", "У меня тут дела. Не пойду.", "Сначала заслужи моё доверие."]
const CP_RULER = "Я не могу бросить поселение. Люди на меня смотрят."
const CP_FULL = "У тебя и так попутчиков хватает."
const CP_POOR = "Денег-то у тебя нет. Приходи, когда будут."
const CP_WAIT = ["Хорошо, жду здесь.", "Подожду. Не задерживайся."]
const CP_GO = ["Идём.", "Наконец-то. Пошли."]
const CP_HOME = ["Спасибо за дорогу. Пойду домой.", "Будет нужда - зови. Я дома."]
const CP_BASE_YES = ["Твоя база - мой дом. Только корми как следует.", "Пойду к тебе жить. Посмотрим, как у вас там."]
const CP_NO_BASE = "Куда идти-то? У тебя и базы нет."
const CP_HUNGRY_LEAVE = "Три дня без еды. Я ухожу домой, и не зови меня больше."
const CP_HUNGRY_LEAVE_OATH = "Я терпел, сколько мог, и клятву помню. Но пять дней без еды - это уже не дорога. Ухожу."

function cpIsSettler(ctx) { try { return ctx.trader.getTags().contains("tfg_settler") } catch (e) { return false } }
function cpOf(ctx) {
    var w = tkWho(ctx)
    return w && w.s.comp && w.s.comp.owner === String(ctx.player.uuid) ? w : null
}

function cpRecruit(ctx) {
    var w = tkWho(ctx)
    if (!w) return
    if (w.s.role === "правитель") return dlgSay(ctx, CP_RULER)
    if (cpMine(ctx.player).length >= CP_MAX) return dlgSay(ctx, CP_FULL)
    var tier = rlTier(w.op.value)
    if (tier >= 4) { dlgSay(ctx, cpPick(CP_YES)); return cpStart(ctx, w, "идёт") }
    if (tier === 3) {
        dlgSay(ctx, cpPick(CP_PAY))
        return dlgChoice(ctx, null, [
            { label: "Заплатить " + CP_HIRE_PRICE + " медяков", hint: "Проверенными монетами", run: c => {
                var ok = false
                try { ok = global.TFG_COINS.pay(c.player, CP_HIRE_PRICE) } catch (e) { }
                if (!ok) return dlgSay(c, CP_POOR)
                dlgSay(c, cpPick(CP_YES))
                cpStart(c, w, "идёт")
            } },
        ])
    }
    dlgSay(ctx, cpPick(CP_NO))
}

function cpStart(ctx, w, mode) {
    w.s.away = mode === "база" ? "база" : "спутник"
    // Номер существа запоминаем сразу: по нему спутник находится надёжно, без метк.
    // Так устроены ГОСТИ (guests.js, gsEntity) - у них это работает, у нас на метках не работало.
    w.s.comp = { owner: String(ctx.player.uuid), euuid: String(ctx.trader.uuid), mode: mode,
                 since: Math.floor(Number(ctx.player.level.getTime()) / CP_DAY), ate: 0, eatDay: -1, hungry: 0 }
    cpMark(ctx.trader, true)
    try { ctx.trader.getNavigation().stop() } catch (e) { }
    try { global.TFG_SETTLERS.save() } catch (e) { }
    cpLog(w.s.name + " (" + w.v.id + ") - спутник " + ctx.player.username)
    dlgNote(ctx, w.s.name + " теперь твой спутник. Команды - в разговоре с ним.")
}

function cpRelease(ctx, w, why) {
    var e = ctx.trader
    delete w.s.comp
    delete w.s.away
    cpMark(e, false)
    // домой - к кровати
    try { if (w.s.bed) e.teleportTo(w.s.bed.x + 0.5, w.s.bed.y, w.s.bed.z + 0.5) } catch (err) { }
    try { global.TFG_SETTLERS.save() } catch (err) { }
    cpLog(w.s.name + " отпущен домой (" + why + ")")
}

function cpSettleBase(ctx, w) {
    var base = null
    try { base = global.TFG_SETTLEMENTS.baseFor(ctx.player) } catch (e) { }
    if (!base || typeof base.x !== "number") return dlgSay(ctx, CP_NO_BASE)
    dlgSay(ctx, cpPick(CP_BASE_YES))
    w.s.away = "база"
    w.s.comp.mode = "база"
    w.s.comp.base = { x: Math.floor(base.x), y: Math.floor(base.y || 70), z: Math.floor(base.z) }
    try {
        var ty = stTop(ctx.player.level, base.x, base.z) + 1
        w.s.comp.base.y = ty
        ctx.trader.teleportTo(base.x + 0.5, ty, base.z + 0.5)
    } catch (e) { }
    try { global.TFG_SETTLERS.save() } catch (e) { }
    dlgNote(ctx, w.s.name + " будет жить у твоей базы (" + w.s.comp.base.x + " " + w.s.comp.base.z + "). Кормить - едой в хранилищах базы, дважды в день.")
}

// ─── Ход спутников ───────────────────────────────────────────────────────────

const CP_BASE_BARK_T = 2400            // житель базы заговаривает не чаще раза в две минуты
const CP_BARK_GUARD = ["Тихо пока. Мне такая тишина не нравится.", "Обошёл кругом - чужих нет.", "Ночью смотреть в оба, днём - вдвое.",
    "Если полезут - встречу.", "Стена бы тут не помешала.", "Следы у ручья. Звериные, но я проверю."]
const CP_BARK_FIGHT = ["Держись за мной!", "Ещё один!", "Не стой на виду!", "Сюда, сволочи!"]
const CP_BARK_PEASANT = ["Поспело - значит, жать. Ждать некогда.", "Земля тут хорошая, только руки нужны.",
    "Семя назад в землю - и снова ждать.", "Куда класть-то? Поставь сундук поближе.", "Спина болит, а работы не меньше.", "Урожай в этом году будет."]
const CP_BARK_NOBLE = ["Караваны - это деньги. Только надо уметь торговаться.", "Я продаю дороже, чем ты. Не обижайся.",
    "Казну держи в одном месте - так проще считать.", "Хороший товар сам себе покупателя найдёт.", "Торговец без денег - не торговец."]
const CP_BARK = ["Далеко ещё?", "Хорошая погода для дороги.", "Слышишь? Кажется, кто-то идёт.", "Ноги гудят, но я не жалуюсь.",
    "А ты знаешь, куда мы идём? Я - нет.", "Будь начеку. Тут всякое водится.", "Хорошо идти не одному.", "Привал бы скоро.",
    "Я тебя в обиду не дам.", "Смотри под ноги, тут камни."]

/**
 * Перенести спутника к игроку - ЗА СПИНУ, а не перед лицом: иначе он то и дело возникает прямо
 * перед глазами, и это выглядит сломанным даже когда работает правильно.
 */
/**
 * Смотрит ли игрок на спутника: взгляд в его сторону, недалеко и без препятствий.
 * Нужно для того, чтобы перенос никогда не случался у игрока на глазах.
 */
/**
 * Куда смотрит игрок. Прежде здесь звался getLookAngle(), которого в этой сборке KubeJS НЕТ:
 * вызов падал, падение проглатывалось, и cpSeen возвращал «не смотрит» ВСЕГДА. Из-за этого
 * перенос спутника был разрешён постоянно, и он прыгал на глазах у игрока.
 *
 * Поэтому считаем вектор взгляда сами, из углов поворота, и пробуем все имена, какие бывают.
 * Не вышло ничего - возвращаем null, а зовущий считает, что игрок СМОТРИТ: лучше не перенести,
 * чем перенести у него перед носом.
 */
function cpLook(p) {
    // Только getYRot/getXRot - ими поворачивает игрока подкат (tfg/slide.js), они здесь точно есть.
    // Пробы других имён (getLookAngle, getYaw, yaw...) на игроке в этой сборке роняли ход сервера
    // ошибкой, которую не ловит try (29.10.2026: «Error in ServerEvents.tick: null» при выпуске спутника).
    var yaw = NaN, pitch = 0
    try { yaw = Number(p.getYRot()) } catch (err) { }
    try { pitch = Number(p.getXRot()) } catch (err) { }
    if (!isFinite(yaw)) return null
    if (!isFinite(pitch)) pitch = 0
    // Math.PI в этом Rhino НЕ СУЩЕСТВУЕТ - любое выражение с ним даёт NaN
    var CP_PI = 3.141592653589793
    var ry = yaw * CP_PI / 180, rp = pitch * CP_PI / 180, cp = Math.cos(rp)
    return { x: -Math.sin(ry) * cp, y: -Math.sin(rp), z: Math.cos(ry) * cp }
}

function cpSeen(p, e) {
    var dx = e.getX() - p.getX(), dy = (e.getY() + 1) - (p.getY() + 1.6), dz = e.getZ() - p.getZ()
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > CP_SEEN_R || d < 0.01) return false
    var look = cpLook(p)
    if (!look) return true                       // направление неизвестно - считаем, что смотрит
    var dot = (dx / d) * look.x + (dy / d) * look.y + (dz / d) * look.z
    if (dot < CP_SEEN_DOT) return false
    try { return !!p.hasLineOfSight(e) } catch (err) { return true }
}

/**
 * ДОРОГИ НЕТ. Перенос разрешаем только когда спутник и правда не может прийти: поиск пути
 * (у игры он и есть Дейкстра по узлам проходимости) не находит дорогу CP_NOPATH тиков подряд.
 * Один неудачный расчёт за повод не берём: путь часто теряется на один тик, когда игрок
 * в прыжке, в лодке или за дверью.
 */
const CP_NOPATH_AT = {}
function cpNoPath(e, p, now) {
    var u = String(e.uuid)
    var has = false
    try {
        var nav = e.getNavigation()
        var path = nav.createPath(p.blockPosition(), 1)
        has = !!path && path.canReach()
    } catch (err) {
        // Не смогли спросить дорогу. Раньше считалось «дорога есть» - и перенос не случался
        // НИКОГДА, то есть отставший спутник терялся навсегда. Теперь наоборот: считаем, что
        // дороги нет. Опасности нет - перенос всё равно требует отставания больше 60 блоков
        // и того, чтобы игрок не смотрел 20 секунд.
        if (CP_NOPATH_AT[u] === undefined) { CP_NOPATH_AT[u] = now; return false }
        return now - CP_NOPATH_AT[u] >= CP_NOPATH
    }
    if (has) { delete CP_NOPATH_AT[u]; return false }
    if (CP_NOPATH_AT[u] === undefined) { CP_NOPATH_AT[u] = now; return false }
    return now - CP_NOPATH_AT[u] >= CP_NOPATH
}

/**
 * НЕЛЕПАЯ СМЕРТЬ ИСКЛЮЧЕНА. Спутник не тонет, не горит в лаве насмерть, не каменеет от взгляда
 * гаргоны и не гибнет от падения: всё это случалось, пока он догонял игрока по чужой дороге.
 * Убить его можно только в бою - и даже тогда он восстанавливается, поэтому гибель возможна
 * лишь в пределах одной схватки.
 */
const CP_REGEN_EVERY = 40               // раз во сколько тиков прибавлять здоровье (2 секунды)
const CP_REGEN = 1                      // сколько прибавлять за раз
function cpGuard(e, now) {
    try { e.setAirSupply(300) } catch (err) { }                  // не тонет
    try { if (e.isOnFire()) e.extinguish() } catch (err) { }       // не горит
    try { e.setTicksFrozen(0) } catch (err) { }                    // не замерзает
    try { e.fallDistance = 0 } catch (err) { }                     // не разбивается при догоне
    // взгляд гаргоны: она каменит по метке; снимаем её сразу
    try { if (e.persistentData.getInt("gorgon_stare") !== 0) e.persistentData.putInt("gorgon_stare", 0) } catch (err) { }
    try { e.removeEffect("minecraft:wither") } catch (err) { }
    try { e.removeEffect("minecraft:poison") } catch (err) { }
    if (now % CP_REGEN_EVERY === 0) {
        try {
            var hp = Number(e.getHealth()), max = Number(e.getMaxHealth())
            if (isFinite(hp) && isFinite(max) && hp > 0 && hp < max) e.setHealth(Math.min(max, hp + CP_REGEN))
        } catch (err) { }
    }
}

/** Можно ли переносить: только если игрок давно на него не смотрел. */
function cpMayPort(p, e, now) {
    var u = String(e.uuid)
    if (cpSeen(p, e)) { CP_SEEN_AT[u] = now; return false }
    var seen = CP_SEEN_AT[u]
    return seen === undefined || now - seen > CP_UNSEEN
}

function cpPlaceNear(level, p, e) {
    var back = null;
    try {
        var look = cpLook(p)
        if (look) {
            var l = Math.sqrt(look.x * look.x + look.z * look.z)
            if (l > 0.01) back = { x: -look.x / l, z: -look.z / l }
        }
    } catch (err) { }
    if (!back) { var a = Math.random() * 6.283185307179586; back = { x: Math.cos(a), z: Math.sin(a) } }
    var spread = (Math.random() - 0.5) * 1.5
    var x = Math.floor(p.getX() + back.x * 3 + spread), z = Math.floor(p.getZ() + back.z * 3 - spread)
    var y = Number(p.getY())
    try { var t = stTop(level, x, z); if (Math.abs(t + 1 - y) < 6) y = t + 1 } catch (err) { }
    try { e.teleportTo(x + 0.5, y, z + 0.5) } catch (err) { }
    // навигацию не сбрасываем: пусть сразу идёт следом, а не стоит на месте
}

/**
 * Что делать спутнику: d - до игрока в блоках, stuckFor - сколько тиков не приближается,
 * unseenFor - сколько тиков игрок его не видел. Ответ: "перенос" | "бег" | "идёт" | "шаг" | "стоит".
 */
function cpDecide(d, stuckFor, unseenFor) {
    if (d > CP_RUN_FAR && stuckFor > CP_STUCK_T && unseenFor > CP_UNSEEN) return "перенос"
    if (d > CP_RUN_FAR) return "бег"
    if (d > CP_HOLD) return "идёт"
    if (d > CP_KEEP) return "шаг"
    return "стоит"
}
const CP_SPEED = { "бег": 2.0, "идёт": 1.4, "шаг": 1.0 }

function cpFollowTick(server) {
    var level = server.overworld()
    var now = Number(server.tickCount)
    cpAll(level).forEach(c => {
        var e = c.e, s = c.s
        cpKeep(e)                                   // подтверждаем на каждом ходу: игра не должна его стереть
        cpGuard(e, now)                             // не тонет, не горит, не каменеет, восстанавливается
        // без рыка: список подмены звуков хаска (RAID_HUSKS) обнуляется каждым /reload, а поселение
        // спутников больше не обходит (seEntities их пропускает) - записываем сами
        try { if (typeof gsHuskVoice === "function") gsHuskVoice(e) } catch (err) { }
        // бессмертие (/tfgcomp бессмертие): метка на существе по отметке в записи
        try {
            if (s.comp.immortal) { if (!e.getTags().contains("tfg_immortal")) e.addTag("tfg_immortal") }
            else if (e.getTags().contains("tfg_immortal")) e.removeTag("tfg_immortal")
            if (s.comp.heal) { delete s.comp.heal; e.setHealth(e.getMaxHealth()) }
        } catch (err) { }
        if (s.comp.mode === "база") return cpBaseStep(level, c, now)
        var p = cpOwner(server, s)
        if (!p || s.comp.mode === "ждёт") return
        var u = String(e.uuid)
        // другой мир - за игроком переносом
        if (String(p.level.getDimension()) !== String(e.level.getDimension())) {
            try { e.teleportTo(p.level, p.getX(), p.getY(), p.getZ(), 0, 0) } catch (err) { }
            return
        }
        var dx = p.getX() - e.getX(), dz = p.getZ() - e.getZ(), dy = p.getY() - e.getY()
        var d2 = dx * dx + dz * dz + dy * dy
        // транспорт: сесть к игроку, если есть место; слез игрок - слезть
        try {
            if (p.isPassenger()) {
                var veh = p.getVehicle()
                if (!e.isPassenger() && d2 < 64) e.startRiding(veh, false)
                if (e.isPassenger()) return
                // места не нашлось (конь, одноместный аппарат) - бежит следом, а не переносится
            } else if (e.isPassenger()) e.stopRiding()
        } catch (err) { }
        var d = Math.sqrt(d2)
        // видит ли его игрок - следим на каждом ходу, а не только когда пора переносить
        if (CP_SEEN_AT[u] === undefined || cpSeen(p, e)) CP_SEEN_AT[u] = now
        // застрял: дальше 32 блоков и за 5 секунд не стал ближе хотя бы на 2 блока
        var st = CP_STUCK[u]
        if (d > CP_HOLD) {
            if (!st || d < st.d - 2) { st = { d: d, at: now }; CP_STUCK[u] = st }
        } else { delete CP_STUCK[u]; st = null }
        var act = cpDecide(d, st ? now - st.at : 0, now - CP_SEEN_AT[u])
        if (!CP_SAID[u] || now - CP_SAID[u] > 1200) {
            CP_SAID[u] = now
            cpLog(s.name + ": до " + p.username + " " + Math.round(d) + " бл. (" + Math.round(e.getX()) + " " + Math.round(e.getY()) + " " +
                Math.round(e.getZ()) + "), " + act + ", не приближается " + (st ? Math.round((now - st.at) / 20) : 0) + " с, не виден " +
                Math.round((now - CP_SEEN_AT[u]) / 20) + " с")
        }
        // ПЕРЕНОС - крайняя мера: дальше 64, застрял и игрок не видел его 20 секунд. За спину игрока.
        if (act === "перенос") {
            cpPlaceNear(level, p, e)
            delete CP_STUCK[u]
            cpLog(s.name + ": застрял в " + Math.round(d) + " бл. - перенесён за спину " + p.username)
            return
        }
        // бой: тот, кого ему назначили (ударил хозяина / его бьёт хозяин), иначе враг рядом с хозяином
        var foe2 = CP_FOE[u]
        if (!foe2) { try { var tg = e.getTarget(); if (tg && tg.isAlive()) foe2 = tg } catch (err) { } }
        if (foe2 && d < CP_RUN_FAR) {
            var fd = Math.pow(foe2.getX() - p.getX(), 2) + Math.pow(foe2.getZ() - p.getZ(), 2)
            if (fd > CP_ESCORT_R * CP_ESCORT_R * 4) foe2 = null       // враг ушёл далеко от хозяина - не гонимся
        }
        if (!foe2 && d < CP_HOLD) foe2 = cpFoeNear(level, p.getX(), p.getY(), p.getZ(), CP_ESCORT_R)
        if (foe2 && d < CP_RUN_FAR && cpFight(e, foe2)) { CP_FOE[u] = foe2; return }
        delete CP_FOE[u]
        try {
            // в 32 блоках - подтягивается шагом; дальше 32 - идёт быстрее; дальше 64 - бежит
            if (act !== "стоит") {
                cpWalk(e, p.getX(), p.getY(), p.getZ(), CP_SPEED[act])
                try { e.setSprinting(act === "бег") } catch (err) { }
            } else {
                try { e.setSprinting(false) } catch (err) { }
                e.getNavigation().stop()
            }
        } catch (err) { }
        // разговор в пути
        if (d2 < 100 && (!CP_BARK_AT[u] || now - CP_BARK_AT[u] > 4000) && Math.random() < 0.05) {
            CP_BARK_AT[u] = now
            try { seVoice(e, cpPick(CP_BARK)); server.scheduleInTicks(100, () => { try { seRestoreSettlerName(e) } catch (err2) { } }) } catch (err) { }
        }
    })
}

// ─── Жители базы ─────────────────────────────────────────────────────────────

const CP_FOOD = /^(tfc|firmalife|tfc_gourmet):food\//

/** Самая сытная еда из хранилищ у базы: съесть одну. true - поел. */
function cpEat(level, base) {
    var best = null, bestSlot = -1, bestH = null, bestScore = -1
    for (var x = base.x - 16; x <= base.x + 16; x += 1) {
        for (var z = base.z - 16; z <= base.z + 16; z += 1) {
            for (var y = base.y - 4; y <= base.y + 6; y++) {
                var be = null
                try { be = level.getBlock(x, y, z).getEntity() } catch (e) { continue }
                if (!be) continue
                var h = null
                try { h = be.getCapability(LB_ItemHandler).resolve().get() } catch (e) { continue }
                for (var i = 0; i < h.getSlots(); i++) {
                    var st = h.getStackInSlot(i)
                    if (st.isEmpty() || !CP_FOOD.test(String(st.id))) continue
                    // сытнее - приготовленное и сложное
                    var id = String(st.id), score = 1
                    if (/cooked_|bread|stew|soup|pie|sandwich|pizza|cake/.test(id)) score = 3
                    if (/stew|soup|pie|pizza|sandwich/.test(id)) score = 5
                    if (score > bestScore) { bestScore = score; best = st; bestSlot = i; bestH = h }
                }
            }
        }
    }
    if (!bestH) return false
    bestH.extractItem(bestSlot, 1, false)
    return true
}

// ─── Работа на базе по сословию ──────────────────────────────────────────────
//
// По плану (TFG-NPC-план.md, этап 7): крестьянин относит урожай в контейнер с зерном,
// знать торгует с караванами, военный защищает (защита была написана раньше).
//
// ЖАТВА БЕЗ ПОЛОМКИ. У грядок TFC свой обработчик правого щелчка - тот самый сбор, после
// которого грядка остаётся стоять. Мы вызываем его же через подставного игрока Forge, а не
// ломаем блок. Поэтому зрелость угадывать не нужно: неспелая грядка сама отвечает «ничего
// не произошло», и тогда мы её не трогаем. Испортить урожай этот код не может.

var CP_BlockPos = null, CP_HitResult = null, CP_Vec3 = null, CP_Direction = null,
    CP_Hand = null, CP_FakePlayer = null, CP_javaFailed = false;

function cpJava() {
    if (CP_BlockPos) return true;
    if (CP_javaFailed) return false;
    try {
        CP_BlockPos = Java.loadClass("net.minecraft.core.BlockPos");
        CP_HitResult = Java.loadClass("net.minecraft.world.phys.BlockHitResult");
        CP_Vec3 = Java.loadClass("net.minecraft.world.phys.Vec3");
        CP_Direction = Java.loadClass("net.minecraft.core.Direction");
        CP_Hand = Java.loadClass("net.minecraft.world.InteractionHand");
        CP_FakePlayer = Java.loadClass("net.minecraftforge.common.util.FakePlayerFactory");
        return true;
    } catch (e) {
        CP_javaFailed = true;
        cpLog("работа на базе отключена: не загрузились классы - " + e);
        return false;
    }
}

/** Самое сытное из хранилищ базы, найденных обходом (кроме «Не трогать» и продажи). true - поел. */
function cpEatScan(level, b) {
    var sc = cpScanOf(b);
    var list = cpStoreList(level, sc, b, 32).filter(a => a.tag !== "не трогать" && a.tag !== "продажа");
    var best = null, bestScore = -1;
    list.forEach(a => {
        try {
            for (var i = 0; i < a.h.getSlots(); i++) {
                var st = a.h.getStackInSlot(i);
                if (!st || st.isEmpty() || !CP_FOOD.test(String(st.id))) continue;
                var id = String(st.id), score = 1;
                if (/cooked_|bread|stew|soup|pie|sandwich|pizza|cake/.test(id)) score = 3;
                if (/stew|soup|pie|pizza|sandwich/.test(id)) score = 5;
                if (score > bestScore) { bestScore = score; best = { h: a.h, slot: i } }
            }
        } catch (e) { }
    });
    if (!best) return false;
    best.h.extractItem(best.slot, 1, false);
    return true;
}

// ─── Обход базы: грядки, кусты, плодовые деревья, хранилища ──────────────────
//
// База раскинута от центра на сотни блоков, обходить её поблочно нельзя. Поэтому обходим
// ПРОГРУЖЕННЫЕ чанки и смотрим только их блок-сущности: у посевов TFC, ягодных кустов, плодовых
// деревьев и у всех хранилищ они есть. Обход один на базу (общий для всех её жителей), кусками по
// CP_SCAN_STEP чанков за раз, от центра по кругу наружу - ближнее находится первым.
//
// Хранилища размечаются ИМЕНЕМ (переименовать на наковальне) - первый шаг к складам как в RimWorld:
//   «Зерно», «Урожай», «Амбар» - сюда крестьянин несёт собранное;
//   «Казна»                    - отсюда знать берёт товар и сюда кладёт выручку;
//   «На продажу», «Продажа»    - отсюда знать тоже продаёт;
//   «Не трогать»               - сюда никто из жителей не кладёт и отсюда не берёт.

var CP_WORK_R = 500;           // на сколько блоков от центра базы жители работают
var CP_SCAN_STEP = 100;        // столько чанков за один шаг обхода
var CP_SCAN = {};              // "x,z" базы -> { order, i, plots: { "x,y,z": 1 }, stores: { "x,y,z": { id, name, tag } }, sweeps }
var CP_SPIRAL = null;          // смещения чанков от центра, по возрастанию расстояния
var CP_Regs = null, CP_Block = null, CP_Calendars = null, CP_Integer = null;

function cpRegs() {
    if (CP_Regs) return true;
    try {
        CP_Regs = Java.loadClass("net.minecraft.core.registries.BuiltInRegistries");
        CP_Block = Java.loadClass("net.minecraft.world.level.block.Block");
        CP_Integer = Java.loadClass("java.lang.Integer");
        try { CP_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars"); } catch (e) { CP_Calendars = null }
        return true;
    } catch (e) { cpLog("обход базы: классы не загрузились - " + e); return false }
}

function cpSpiral() {
    if (CP_SPIRAL) return CP_SPIRAL;
    var r = Math.ceil(CP_WORK_R / 16), out = [];
    for (var dx = -r; dx <= r; dx++) for (var dz = -r; dz <= r; dz++) if (dx * dx + dz * dz <= r * r) out.push([dx, dz, dx * dx + dz * dz]);
    out.sort((a, b) => a[2] - b[2]);
    CP_SPIRAL = out;
    return out;
}

/** Метка хранилища по имени: "зерно" | "казна" | "продажа" | "не трогать" | null. */
function cpStoreTag(name) {
    var n = String(name || "").toLowerCase();
    if (!n) return null;
    if (n.indexOf("не трог") >= 0) return "не трогать";
    if (/зерн|урожа|амбар/.test(n)) return "зерно";
    if (n.indexOf("казн") >= 0) return "казна";
    if (n.indexOf("продаж") >= 0) return "продажа";
    return null;
}

/** Что из блок-сущностей нам нужно: "грядка" | "куст" | "хранилище" | null. */
var CP_STORE_BE = /chest|crate|drawer|cabinet|storage|basket|shulker|minecraft:barrel|trunk|vessel|shelf/;
function cpBeKind(beKey, blockKey, beCls) {
    if (/dead|wild/.test(blockKey)) return null;
    if (/crop/.test(beKey) || /CropBlockEntity/.test(beCls || "")) return /pumpkin|melon/.test(blockKey) ? "лоза" : "грядка";
    if (/^tfc:plant\/.*(bush|_leaves)$/.test(blockKey) || /berry_bush|fruit_tree/.test(beKey)) return "куст";
    if (CP_STORE_BE.test(beKey) && !/tfc:barrel|furnace|machine/.test(beKey)) return "хранилище";
    return null;
}

function cpScanOf(b) {
    var key = b.x + "," + b.z;
    if (!CP_SCAN[key]) CP_SCAN[key] = { i: 0, plots: {}, stores: {}, sweeps: 0, chunks: 0, at: 0 };
    return CP_SCAN[key];
}

/**
 * Шаг обхода базы: CP_SCAN_STEP чанков. Зовётся раз в CP_WORK_EVERY тиков на базу.
 * Только проверенные в сборке способы: level.hasChunk / level.getChunk (казна, stashes.js),
 * level.getBlock(...).id (весь код поселений), getCapability(LB_ItemHandler) (еда). Прежний обход
 * через getChunkSource().getChunkNow() и реестры молча не находил ничего (29.10.2026).
 */
function cpScanStep(level, b, now) {
    var sc = cpScanOf(b);
    if (sc.at === now) return;
    sc.at = now;
    var order = cpSpiral();
    var cx0 = b.x >> 4, cz0 = b.z >> 4;
    for (var k = 0; k < CP_SCAN_STEP; k++) {
        var o = order[sc.i];
        sc.i++;
        if (sc.i >= order.length) {
            sc.i = 0; sc.sweeps++;
            if (!Object.keys(sc.plots).length && !Object.keys(sc.stores).length)
                cpLog("обход базы " + b.x + " " + b.z + ": круг " + sc.sweeps + " - ничего не найдено (чанков прогружено " + sc.chunks + ", блок-сущностей " + (sc.bes || 0) + ")");
        }
        var cx = cx0 + o[0], cz = cz0 + o[1];
        var ch = null;
        try { if (level.hasChunk(cx, cz)) ch = level.getChunk(cx, cz) } catch (e) { ch = null; sc.err = String(e) }
        if (!ch) continue;
        sc.chunks++;
        var poses = null;
        try { poses = ch.getBlockEntitiesPos().toArray() } catch (e) { sc.err = String(e); continue }
        for (var j = 0; j < poses.length; j++) {
            var p = poses[j];
            sc.bes = (sc.bes || 0) + 1;
            try {
                var x = p.getX(), y = p.getY(), z = p.getZ();
                var blk = level.getBlock(x, y, z);
                var blockKey = String(blk.id);
                var be = blk.getEntity();
                if (!be) continue;
                var beCls = "";
                try { beCls = String(be.getClass().getSimpleName()) } catch (e3) { }
                var pk = x + "," + y + "," + z;
                // климатическая станция FirmaLife: её комната - погреб (tfg/cellar_freezing.js)
                if (typeof CF_STATION_BLOCK !== "undefined" && blockKey === CF_STATION_BLOCK) { if (!sc.stations) sc.stations = {}; sc.stations[pk] = { x: x, y: y, z: z }; continue }
                var kind = cpBeKind(cpClsKey(beCls), blockKey, beCls);
                if (kind === "лоза") {
                    // тыква и дыня TFC: лоза сама не жнётся (сломать - погибнет), плод растёт блоком рядом
                    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(o2 => {
                        try {
                            var fx = x + o2[0], fz = z + o2[1];
                            if (/^tfc:(pumpkin|melon)$/.test(String(level.getBlock(fx, y, fz).id))) sc.plots[fx + "," + y + "," + fz] = "плод";
                        } catch (e4) { }
                    });
                    continue;
                }
                if (kind === "грядка" || kind === "куст") { sc.plots[pk] = kind; continue }
                // хранилище: есть обработчик вещей и это не машина
                if (/Machine|Furnace|Boiler|Forge|Pot|Barrel|Crucible|Bloomery|Grill|Quern|Anvil/.test(beCls) && !/minecraft:barrel/.test(blockKey)) continue;
                if (!/Chest|Crate|Drawer|Cabinet|Storage|Basket|Shulker|Barrel|Trunk|Vessel|Shelf|Container|Hanger|Jarbnet|Rack/i.test(beCls + " " + blockKey)) continue;
                var h = null;
                try { h = be.getCapability(LB_ItemHandler).resolve().get() } catch (e5) { h = null }
                if (!h) continue;
                var name = "";
                try { var cn = be.getCustomName(); if (cn) name = String(cn.getString()); } catch (e2) { }
                sc.stores[pk] = { id: blockKey, name: name, tag: cpStoreTag(name), x: x, y: y, z: z };
            } catch (e1) { sc.err = String(e1) }
        }
    }
}

/** Класс блок-сущности -> что-то вроде ключа для cpBeKind (посев, куст). */
function cpClsKey(cls) {
    if (/CropBlockEntity/.test(cls)) return "crop";
    if (/BerryBush|FruitTree|Bush/.test(cls)) return "berry_bush";
    return cls.toLowerCase();
}

function cpPosOf(pk) { var a = pk.split(","); return { x: Number(a[0]), y: Number(a[1]), z: Number(a[2]) } }
function cpLoadedAt(level, x, z) { try { return !!level.getChunkSource().getChunkNow(x >> 4, z >> 4) } catch (e) { return false } }

/** Обработчик вещей хранилища или null (разобрали - запись убираем). */
function cpHandlerAt(level, sc, pk) {
    var st = sc.stores[pk];
    if (!st) return null;
    if (!cpLoadedAt(level, st.x, st.z)) return null;
    var be = null;
    try { be = level.getBlock(st.x, st.y, st.z).getEntity(); } catch (e) { be = null }
    var h = null;
    try { h = be ? be.getCapability(LB_ItemHandler).resolve().get() : null; } catch (e) { h = null }
    if (!h) { delete sc.stores[pk]; return null }
    // имя могли сменить на наковальне
    try { var cn = be.getCustomName(); st.name = cn ? String(cn.getString()) : ""; st.tag = cpStoreTag(st.name) } catch (e) { }
    return h;
}

/** Для журнала: сколько хранилищ стоит в погребах и какие (первые три). */
function cpCellarInfo(level, sc) {
    try {
        var cel = cpCellars(level, sc);
        if (!cel.length || !cpJava()) return " (комнаты погребов не читаются)";
        var inside = [];
        for (var pk in sc.stores) {
            var st = sc.stores[pk];
            var bp = new CP_BlockPos(st.x, st.y, st.z);
            for (var i = 0; i < cel.length; i++) if (cel[i].contains(bp)) { inside.push(st.id.replace(/^[a-z_]+:/, "") + "@" + pk); break }
        }
        return ", в погребах хранилищ " + inside.length + (inside.length ? " (" + inside.slice(0, 3).join(", ") + ")" : "");
    } catch (e) { return " (погреба: сбой " + e + ")" }
}

/** Блоки погребов базы (комнаты климатических станций): массив Java-множеств BlockPos. */
function cpCellars(level, sc) {
    var out = [];
    if (!sc.stations || typeof cfCellarPositions !== "function") return out;
    for (var k in sc.stations) {
        var st = sc.stations[k];
        try {
            var be = level.getBlock(st.x, st.y, st.z).getEntity();
            if (!be) { delete sc.stations[k]; continue }
            var pos = cfCellarPositions(be);
            if (pos && !pos.isEmpty()) out.push(pos);
        } catch (e) { }
    }
    return out;
}

/** Хранилища базы с содержимым, ближние к точке первыми: [{ pk, h, x, y, z, tag, name, grain, coins, free, d, cellar }]. */
function cpStoreList(level, sc, from, limit) {
    var all = [];
    for (var pk in sc.stores) {
        var st = sc.stores[pk];
        all.push({ pk: pk, x: st.x, y: st.y, z: st.z, d: Math.pow(st.x - from.x, 2) + Math.pow(st.z - from.z, 2) });
    }
    all.sort((a, b) => a.d - b.d);
    var out = [];
    var cellars = cpCellars(level, sc);
    for (var i = 0; i < all.length && out.length < (limit || 48); i++) {
        var a = all[i];
        var h = cpHandlerAt(level, sc, a.pk);
        if (!h) continue;
        var st2 = sc.stores[a.pk];
        a.h = h; a.tag = st2.tag; a.name = st2.name;
        a.cellar = false;
        if (cellars.length && cpJava()) { try { var bp = new CP_BlockPos(a.x, a.y, a.z); for (var ci = 0; ci < cellars.length && !a.cellar; ci++) a.cellar = !!cellars[ci].contains(bp) } catch (e) { } }
        a.grain = 0; a.free = 0;
        try {
            for (var j = 0; j < h.getSlots(); j++) {
                var s = h.getStackInSlot(j);
                if (!s || s.isEmpty()) { a.free++; continue }
                if (CP_GRAIN.test(String(s.id))) a.grain += s.getCount();
            }
        } catch (e) { continue }
        out.push(a);
    }
    return out;
}

// ─── Мешок жителя ────────────────────────────────────────────────────────────
//
// Собранное житель носит при себе (s.comp.bag), пока не дойдёт до хранилища. Хранилища нет -
// носит, пока не появится: игрок может поставить сундук поближе. Вещи хранятся вместе с NBT
// (у еды TFC в нём дата - от неё зависит порча).

var CP_BAG_MAX = 27;           // стопок в мешке
var CP_BAG_DELIVER = 9;        // с таким числом стопок уже несёт в хранилище

function cpBag(s) { if (!s.comp.bag) s.comp.bag = []; return s.comp.bag }
function cpBagCount(s) { var n = 0; cpBag(s).forEach(x => { n += Number(x.count) || 0 }); return n }

function cpBagAdd(s, stack) {
    if (!stack || stack.isEmpty()) return;
    var bag = cpBag(s);
    var id = String(stack.id), nbt = stack.nbt ? String(stack.nbt) : "";
    for (var i = 0; i < bag.length; i++) if (bag[i].id === id && (bag[i].nbt || "") === nbt && bag[i].count < 64) {
        var add = Math.min(64 - bag[i].count, stack.getCount());
        bag[i].count += add;
        if (add >= stack.getCount()) return;
        stack = stack.copy(); stack.shrink(add);
    }
    bag.push({ id: id, count: stack.getCount(), nbt: nbt });
}

function cpBagStack(x) {
    try { return x.nbt ? Item.of(x.id, x.count, x.nbt) : Item.of(x.id, x.count) } catch (e) { return null }
}

/** Выложить мешок в хранилище. Сколько стопок выложено. */
function cpBagDump(s, h) {
    var bag = cpBag(s), left = [], put = 0;
    bag.forEach(x => {
        var st = cpBagStack(x);
        if (!st) return;
        var rest = st;
        try { for (var i = 0; i < h.getSlots() && !rest.isEmpty(); i++) rest = h.insertItem(i, rest, false) } catch (e) { }
        if (rest.isEmpty()) put++;
        else { if (rest.getCount() < st.getCount()) put++; left.push({ id: x.id, count: rest.getCount(), nbt: x.nbt }) }
    });
    s.comp.bag = left;
    return put;
}

// ─── Крестьянин ──────────────────────────────────────────────────────────────

/** Что считаем зерном: по нему выбирается нужный контейнер. */
var CP_GRAIN = /grain|seeds|food\/(wheat|barley|oat|rye|rice|maize)/;
/** Что крестьянин подбирает с земли (еда, семена, волокно - не инструменты и не руда). */
var CP_HAUL = /food\/|grain|seeds|straw|jute|papyrus|sugarcane|wool|hide|fruit|berry/;
var CP_HAUL_R = 8;             // в каком радиусе подбираем лежащее
var CP_WORK_EVERY = 100;       // как часто знать торгует и идёт обход базы (тиков)
var CP_REACH = 3;              // с какого расстояния жнёт и кладёт
var CP_RIPE_LOOK = 400;        // сколько ближайших грядок проверять на спелость за один ход

function cpMaxAge(state) {
    try { return Number(state.getBlock().getMaxAge()) } catch (e) { }
    try {
        var vals = state.getBlock().getStateDefinition().getProperty("age").getPossibleValues().toArray();
        var m = 0; for (var i = 0; i < vals.length; i++) m = Math.max(m, Number(vals[i]));
        return m;
    } catch (e) { return 99 }
}

/** Рост посева TFC (0..1) из его блок-сущности или null, если не читается. */
function cpGrowth(level, pos) {
    try {
        var be = level.getBlockEntity(new CP_BlockPos(pos.x, pos.y, pos.z));
        if (!be) return null;
        var g = Number(be.getGrowth());
        return isFinite(g) ? g : null;
    } catch (e) { return null }
}

/** Спело ли: посев - рост дошёл до 1; куст и плодовое дерево - в плодах. */
function cpRipe(level, pos, kind) {
    // классы (BlockPos) грузит cpJava; без него проверка падала, и всё считалось неспелым - жатвы не было
    if (!cpJava()) return false;
    try {
        var blk = level.getBlock(pos.x, pos.y, pos.z);
        var id = String(blk.id), props = blk.properties;
        if (kind === "плод") return /^tfc:(pumpkin|melon)$/.test(id) ? true : null;
        if (kind === "грядка") {
            if (/dead|wild/.test(id) || props.get("age") === null || props.get("age") === undefined) return null;   // грядки больше нет
            if (props.get("part") && String(props.get("part")) === "top") return false;   // жнём по нижней части
            // Спелость - как у самой TFC: рост блок-сущности посева дошёл до 1. По стадии в свойстве age
            // считалось неверно: «спелыми» выходили зелёные свёкла и редис (29.10.2026).
            var g = cpGrowth(level, pos);
            if (g !== null) return g >= 1;
            return Number(props.get("age")) >= cpMaxAge(level.getBlockState(new CP_BlockPos(pos.x, pos.y, pos.z)));
        }
        if (!/^tfc:plant\//.test(id)) return null;
        return String(props.get("lifecycle")) === "fruiting";
    } catch (e) { return false }
}

/** Сжать посев: урожай в мешок, одно семя - обратно в землю, рост с нуля от нынешнего дня. */
function cpReapCrop(level, s, pos) {
    if (!cpJava() || !cpRegs()) return false;
    try {
        var bp = new CP_BlockPos(pos.x, pos.y, pos.z);
        var state = level.getBlockState(bp);
        var block = state.getBlock();
        var drops = CP_Block.getDrops(state, level, bp, level.getBlockEntity(bp));
        // высокий посев (кукуруза, джут): верх снимаем вместе
        var top = bp.above(), topState = level.getBlockState(top);
        if (topState.getBlock() === block) {
            try { drops.addAll(CP_Block.getDrops(topState, level, top, level.getBlockEntity(top))) } catch (e) { }
            level.removeBlock(top, false);
        }
        var seed = false;
        for (var i = 0; i < drops.size(); i++) {
            var st = drops.get(i);
            if (!seed && /seeds/.test(String(st.id))) { st.shrink(1); seed = true }
            cpBagAdd(s, st);
        }
        if (seed) {
            var fresh = null;
            try { fresh = block.getStateForAge(0) } catch (e) { fresh = block.defaultBlockState() }
            // старый посев убираем целиком: иначе блок-сущность остаётся с прежним ростом, и TFC тут же
            // возвращает растение к прежней стадии - «сжал, а с ним ничего не случилось» (29.10.2026)
            level.removeBlock(bp, false);
            level.setBlock(bp, fresh, 3);
            var be = level.getBlockEntity(bp);
            var t = 0;
            try { t = Number(CP_Calendars.SERVER.getTicks()) } catch (e) { t = 0 }
            try { be.setGrowth(0); be.setYield(0); be.setExpiry(0) } catch (e) { }
            try { if (t) { be.setLastGrowthTick(t); be.setLastCalendarUpdateTick(t) } } catch (e) { }
        } else level.removeBlock(bp, false);
        return true;
    } catch (e) { cpTickFail("жатва", e, Number(level.getServer().getTickCount())); return false }
}

/** Сорвать плод (тыкву, дыню): блок - в мешок. Лоза остаётся. */
function cpReapFruit(level, s, pos) {
    if (!cpJava() || !cpRegs()) return false;
    try {
        var bp = new CP_BlockPos(pos.x, pos.y, pos.z);
        var state = level.getBlockState(bp);
        var drops = CP_Block.getDrops(state, level, bp, level.getBlockEntity(bp));
        for (var i = 0; i < drops.size(); i++) cpBagAdd(s, drops.get(i));
        level.removeBlock(bp, false);
        return true;
    } catch (e) { return false }
}

/** Обобрать куст или плодовое дерево его же правым щелчком; плоды - из рук подставного в мешок. */
function cpReapBush(level, s, pos) {
    if (!cpJava()) return false;
    try {
        var bp = new CP_BlockPos(pos.x, pos.y, pos.z);
        var fake = CP_FakePlayer.getMinecraft(level);
        if (!fake) return false;
        var hit = new CP_HitResult(new CP_Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5), CP_Direction.UP, bp, false);
        level.getBlockState(bp).use(level, fake, CP_Hand.MAIN_HAND, hit);
        var inv = fake.getInventory(), got = false;
        for (var i = 0; i < inv.getContainerSize(); i++) {
            var st = inv.getItem(i);
            if (!st || st.isEmpty()) continue;
            cpBagAdd(s, st.copy());
            inv.setItem(i, Item.empty);
            got = true;
        }
        return got;
    } catch (e) { return false }
}

/** Подобрать лежащее рядом в мешок. Сколько стопок подобрано. */
function cpPickUp(level, e, s) {
    var taken = 0;
    try {
        var list = level.getEntitiesWithin(new CP_AABB(e.getX() - CP_HAUL_R, e.getY() - 3, e.getZ() - CP_HAUL_R,
            e.getX() + CP_HAUL_R, e.getY() + 3, e.getZ() + CP_HAUL_R));
        for (var i = 0; i < list.size() && taken < 6 && cpBag(s).length < CP_BAG_MAX; i++) {
            var it = list.get(i);
            if (!it || String(it.type) !== "minecraft:item") continue;
            var st = it.getItem();
            if (!st || st.isEmpty() || !CP_HAUL.test(String(st.id))) continue;
            cpBagAdd(s, st.copy());
            it.discard();
            taken++;
        }
    } catch (err) { }
    return taken;
}

/** Куда нести урожай: «Зерно» ближайшее, иначе где больше зерна, иначе где есть место. «Не трогать», казну и продажу не берём. */
function cpGrainTarget(list) {
    var ok = list.filter(a => a.tag !== "не трогать" && a.tag !== "казна" && a.tag !== "продажа" && a.free > 0);
    var cellar = ok.filter(a => a.cellar);                 // погреб - первым делом: там еда не портится
    if (cellar.length) return cellar[0];
    var named = ok.filter(a => a.tag === "зерно");
    if (named.length) return named[0];
    var best = null;
    ok.forEach(a => { if (!best || a.grain > best.grain) best = a });
    return best && best.grain > 0 ? best : (ok[0] || null);
}

/**
 * Идти к точке - как ходят жители поселения (settlers.js, seMove/seStuck/seWatch): открывать двери на
 * пути; стоит две секунды - прыжок или прыжок на уступ; третья неудача подряд - шаг переносом до
 * CP_STEP блоков к цели. Прежде шла одна навигация: путь к соседней грядке не строился, и крестьянин
 * жал только то, до чего дотягивался с места (29.10.2026).
 */
var CP_MV = {};                // uuid -> { gx, gz, px, pz, pt, fails }
var CP_STEP = 3;
function cpGo(e, x, y, z, speed) {
    var u = String(e.uuid), now = Number(e.level.getTime());
    var m = CP_MV[u];
    if (!m || Math.pow(m.gx - x, 2) + Math.pow(m.gz - z, 2) > 9) m = CP_MV[u] = { gx: x, gz: z, fails: 0 };
    m.gx = x; m.gz = z;
    try { if (typeof seOpenDoors === "function") seOpenDoors(e) } catch (err) { }
    try { cpWalk(e, x + 0.5, y, z + 0.5, speed) } catch (err) { }
    var d2 = Math.pow(e.getX() - x - 0.5, 2) + Math.pow(e.getZ() - z - 0.5, 2);
    if (d2 < 6.25) { m.fails = 0; return }
    if (!m.pt || now - m.pt >= 40) {
        var moved = m.pt ? Math.pow(e.getX() - m.px, 2) + Math.pow(e.getZ() - m.pz, 2) : 99;
        m.px = e.getX(); m.pz = e.getZ(); m.pt = now;
        if (moved > 0.6) { m.fails = 0; return }
        try { if (typeof seLeap === "function" && seLeap(e, m)) { m.fails = 0; return } } catch (err) { }
        try { e.getJumpControl().jump() } catch (err) { }
        if (m.fails === 0) { try { if (typeof seOpenDoors === "function") seOpenDoors(e, 5) } catch (err) { } }
        m.fails++;
        if (m.fails >= 3) {
            m.fails = 0;
            var d = Math.sqrt(d2) || 1, len = Math.min(CP_STEP, d);
            var nx = e.getX() + (x + 0.5 - e.getX()) / d * len, nz = e.getZ() + (z + 0.5 - e.getZ()) / d * len;
            var ny = e.getY();
            try { ny = Number(e.level.getHeight(CP_HEIGHT, Math.floor(nx), Math.floor(nz))) } catch (err) { }
            // переносом - только по ровному: не на крышу и не в яму
            if (Math.abs(ny - e.getY()) <= 3) { try { e.teleportTo(nx, ny, nz); cpStepped++ } catch (err) { } }
        }
    }
}
var cpStepped = 0;

// Недостижимые цели (хранилище за стеной, грядка за забором): за CP_STUCK_GOAL тиков не стал ближе
// хотя бы на блок - цель вычёркивается на CP_BAD_TTL тиков. 29.10.2026 крестьянин минуту шёл к
// сундуку, до которого не дойти, и больше ничего не делал.
var CP_STUCK_GOAL = 200, CP_BAD_TTL = 6000;
var CP_BAD = {};               // "uuid|x,y,z" -> до какого тика цель вычеркнута
var CP_GOAL = {};              // uuid -> { key, d, at }
function cpBad(e, key, now) { var t = CP_BAD[String(e.uuid) + "|" + key]; return !!t && now < t }
/** Идёт к цели key: false, если застрял (цель вычеркнута). */
function cpApproach(e, key, d, now) {
    var u = String(e.uuid), g = CP_GOAL[u];
    if (!g || g.key !== key || d < g.d - 1) { CP_GOAL[u] = { key: key, d: d, at: now }; return true }
    if (now - g.at > CP_STUCK_GOAL) { CP_BAD[u + "|" + key] = now + CP_BAD_TTL; delete CP_GOAL[u]; return false }
    return true
}

/**
 * Крестьянин: идёт к ближайшему созревшему (посев, куст, плодовое дерево) в CP_WORK_R блоках от
 * базы, собирает в мешок, подбирает выпавшее. Мешок полон или спелого нет - несёт в хранилище;
 * хранилища нет - носит с собой.
 */
function cpWorkPeasant(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base;
    var sc = cpScanOf(b);
    var here = { x: e.getX(), y: e.getY(), z: e.getZ() };
    var job = s.comp.job || null;
    cpPickUp(level, e, s);
    var bag = cpBag(s);

    // ближайшее спелое (проверяем самые ближние два десятка)
    var near = [];
    for (var pk in sc.plots) {
        if (sc.plots[pk] === "лоза") continue;
        var p = cpPosOf(pk);
        if (Math.pow(p.x - b.x, 2) + Math.pow(p.z - b.z, 2) > CP_WORK_R * CP_WORK_R) continue;
        near.push({ pk: pk, p: p, d: Math.pow(p.x - here.x, 2) + Math.pow(p.z - here.z, 2) });
    }
    near.sort((x, y) => x.d - y.d);
    var ripe = null;
    // проверяем до CP_RIPE_LOOK ближайших: при тысяче грядок спелые часто дальше двух десятков ближних,
    // и он, не найдя их, нёс в хранилище одну-единственную стопку (29.10.2026)
    for (var i = 0; i < near.length && i < CP_RIPE_LOOK && !ripe; i++) {
        if (!cpLoadedAt(level, near[i].p.x, near[i].p.z) || cpBad(e, near[i].pk, now)) continue;
        var r = cpRipe(level, near[i].p, sc.plots[near[i].pk]);
        if (r === null) { delete sc.plots[near[i].pk]; continue }
        if (r) ripe = near[i];
    }
    s.comp.ripeSeen = !!ripe;
    // для журнала: сколько спелого и неспелого среди ближайших, по блокам
    if (!s.comp.seenAt || now - s.comp.seenAt > 1200) {
        s.comp.seenAt = now;
        var tally = {};
        for (var ti = 0; ti < near.length && ti < CP_RIPE_LOOK; ti++) {
            try {
                var tb = level.getBlock(near[ti].p.x, near[ti].p.y, near[ti].p.z);
                var tid = String(tb.id).replace(/^[a-z_]+:/, "");
                var rr = cpRipe(level, near[ti].p, sc.plots[near[ti].pk]);
                var key = tid + (rr ? "+" : rr === false ? "-" : "?");
                if (!tally[tid]) tally[tid] = { ripe: 0, green: 0, age: "" };
                if (rr) tally[tid].ripe++; else tally[tid].green++;
                if (!tally[tid].age) { try { var g9 = cpGrowth(level, near[ti].p); tally[tid].age = "стадия " + String(tb.properties.get("age")) + "/" + cpMaxAge(level.getBlockState(new CP_BlockPos(near[ti].p.x, near[ti].p.y, near[ti].p.z))) + ", рост " + (g9 === null ? "не читается" : g9.toFixed(2)) } catch (e9) { } }
            } catch (e8) { }
        }
        s.comp.seen = Object.keys(tally).sort((x, y) => (tally[y].ripe + tally[y].green) - (tally[x].ripe + tally[x].green)).slice(0, 8)
            .map(k => k + " " + tally[k].ripe + "/" + (tally[k].ripe + tally[k].green) + " (" + tally[k].age + ")").join(", ");
    }

    // нести: мешок полон, либо спелого нет, а в мешке что-то есть
    if (bag.length && (bag.length >= CP_BAG_DELIVER || !ripe)) {
        var list = cpStoreList(level, sc, here, 256).filter(a => !cpBad(e, a.pk, now));
        var tgt = cpGrainTarget(list);
        if (!tgt) { s.comp.job = { what: "некуда класть", at: now }; return }
        var dd = Math.sqrt(Math.pow(tgt.x - here.x, 2) + Math.pow(tgt.z - here.z, 2));
        if (dd > CP_REACH) {
            if (!cpApproach(e, tgt.pk, dd, now)) { s.comp.job = { what: "не дойти до " + (tgt.name || tgt.pk) + " - беру другое", at: now }; return }
            cpGo(e, tgt.x, tgt.y, tgt.z, 0.9); s.comp.job = { what: "несёт в " + (tgt.name || tgt.pk), at: now }; return
        }
        var put = cpBagDump(s, tgt.h);
        s.comp.job = { what: "выложил " + put + " стопок в " + (tgt.name || tgt.pk), at: now };
        try { global.TFG_SETTLERS.save() } catch (err) { }
        return;
    }
    if (!ripe) {
        // свободное время: ходит по базе от поля к полю (к случайной известной грядке), раз в десять секунд новая цель
        if (!s.comp.stroll || now - s.comp.stroll.at > 200) {
            var keys = Object.keys(sc.plots).filter(k => sc.plots[k] !== "лоза");
            var to = keys.length ? cpPosOf(keys[Math.floor(Math.random() * keys.length)]) : { x: b.x + Math.floor((Math.random() - 0.5) * 48), y: b.y, z: b.z + Math.floor((Math.random() - 0.5) * 48) };
            s.comp.stroll = { x: to.x, y: to.y, z: to.z, at: now };
        }
        cpGo(e, s.comp.stroll.x, s.comp.stroll.y, s.comp.stroll.z, 0.8);
        s.comp.job = { what: "спелого нет - обходит поля", at: now };
        return;
    }
    var d = Math.sqrt(ripe.d);
    if (d > CP_REACH) {
        if (!cpApproach(e, ripe.pk, d, now)) { s.comp.job = { what: "не дойти до грядки " + ripe.pk + " - беру другую", at: now }; return }
        cpGo(e, ripe.p.x, ripe.p.y, ripe.p.z, 0.9); s.comp.job = { what: "идёт жать (" + Math.round(d) + " бл.)", at: now }; return
    }
    var kind = sc.plots[ripe.pk];
    var done = kind === "грядка" ? cpReapCrop(level, s, ripe.p) : kind === "плод" ? cpReapFruit(level, s, ripe.p) : cpReapBush(level, s, ripe.p);
    if (done && kind === "плод") delete sc.plots[ripe.pk];
    var rid = "";
    try { rid = String(level.getBlock(ripe.p.x, ripe.p.y, ripe.p.z).id) } catch (e7) { }
    s.comp.job = { what: done ? "собрал: " + kind : "не вышло собрать: " + kind, at: now };
    s.comp.last = (done ? "собрал " : "не собрал ") + ripe.pk + " " + rid;
    if (done) { s.comp.reaped = (s.comp.reaped || 0) + 1; try { global.TFG_SETTLERS.save() } catch (err) { } }
}

// ─── Знать: продажа караванам ────────────────────────────────────────────────
//
// Знатный житель базы ПРОДАЁТ торговцу, пришедшему к базе, вещи из хранилища, где больше всего
// монет (или из «Казны»), и из хранилищ «На продажу». Берёт дороже, чем мог бы игрок: игроку
// торговец платит от 5 до 50% цены по отношениям (trade_menu.js, tmSellFactor), знатному - CP_NOBLE_SHARE.
// Выручка - в то же хранилище. Каким видам торговцев нужен его товар, он запоминает (s.comp.wanted):
// визиты к базе выбираются из них в первую очередь (guests.js, global.TFG_COMPANIONS.wantedKinds).

var CP_NOBLE_SHARE = 0.6;      // какую долю цены торговец платит знатному
var CP_DEAL_EVERY = 200;       // как часто знать продаёт по стопке (тиков)
var CP_TRADER_R = 64;          // в каком радиусе от центра базы ищем торговца
var CP_WANT_EVERY = 6000;      // как часто пересчитывает, кому нужен его товар

var CP_DEAL_SAY = ["Продал. Дороже, чем ты бы сам выручил.", "Торговец кривился, но взял.",
    "Деньги в казне. Пересчитай, если не веришь.", "С караванами надо уметь говорить."];

/** Верифицированные монеты в хранилище: [{ slot, face, count }], сверху крупные. */
function cpCoinsIn(h) {
    var out = [];
    try {
        for (var i = 0; i < h.getSlots(); i++) {
            var st = h.getStackInSlot(i);
            if (!st || st.isEmpty()) continue;
            var face = 0;
            try { face = Number(global.TFG_COINS.faceValue(st)); } catch (e) { face = 0 }
            if (face <= 0) continue;
            var ok = false;
            try { ok = !!global.TFG_COINS.isVerified(st); } catch (e) { ok = false }
            if (ok) out.push({ slot: i, face: face, count: st.getCount() });
        }
    } catch (e) { return [] }
    return out;
}
function cpCoinTotal(h) { var sum = 0; cpCoinsIn(h).forEach(c => { sum += c.face * c.count }); return sum }
function cpIsCoin(st) { try { return !!global.TFG_COINS.isCoin(st) } catch (e) { return false } }

/** Монета этого номинала, верифицированная. */
function cpCoinStack(id, count) {
    try { return coinVerifiedStack(id, count) } catch (e) { }
    return Item.of(id, count, { tfg_verified: true });
}

/** Положить выручку монетами; что не влезло - вернуть суммой. */
function cpPayInto(h, amount) {
    var parts = [];
    try { parts = global.TFG_COINS.split(Math.round(amount)) } catch (e) { return amount }
    var lost = 0;
    parts.forEach(p => {
        var rest = cpCoinStack(p.id, p.count);
        try { for (var i = 0; i < h.getSlots() && !rest.isEmpty(); i++) rest = h.insertItem(i, rest, false) } catch (e) { }
        if (!rest.isEmpty()) lost += rest.getCount() * (p.face || 1);
    });
    return lost;
}

/** Торговец каравана у базы (не житель и не спутник). */
function cpTraderNear(level, b) {
    try {
        var list = level.getEntitiesWithin(new CP_AABB(b.x - CP_TRADER_R, b.y - 32, b.z - CP_TRADER_R, b.x + CP_TRADER_R, b.y + 32, b.z + CP_TRADER_R));
        for (var i = 0; i < list.size(); i++) {
            var t = list.get(i);
            if (!t || !t.isAlive()) continue;
            var tg = t.getTags();
            if (!tg.contains("tfg_trader") || tg.contains("tfg_companion") || tg.contains("tfg_settler")) continue;
            if (!String(t.persistentData.getString("tfg_trader_kind"))) continue;
            return t;
        }
    } catch (err) { }
    return null;
}

/** Откуда продавать: хранилище с наибольшими деньгами (или «Казна») и все «На продажу». */
function cpSaleStores(list) {
    var ok = list.filter(a => a.tag !== "не трогать");
    var purse = ok.filter(a => a.tag === "казна")[0] || null;
    if (!purse) { var best = 0; ok.forEach(a => { var m = cpCoinTotal(a.h); if (m > best) { best = m; purse = a } }) }
    var from = ok.filter(a => a.tag === "продажа");
    if (purse && from.indexOf(purse) < 0) from.unshift(purse);
    return { purse: purse, from: from };
}

/** Каким видам торговцев нужен товар знатного: [kindId], по убыванию выручки. */
function cpWantedKinds(froms) {
    var sum = {};
    var kinds = [];
    try { kinds = global.TFG_TRADE_GOODS.kinds.filter(k => k.goods && !k.special) } catch (e) { return [] }
    froms.forEach(a => {
        try {
            for (var i = 0; i < a.h.getSlots(); i++) {
                var st = a.h.getStackInSlot(i);
                if (!st || st.isEmpty() || cpIsCoin(st)) continue;
                kinds.forEach(k => {
                    var p = 0;
                    try { p = Number(global.TFG_TRADE_GOODS.sellPrice(k.id, st)) } catch (e) { p = 0 }
                    if (p > 0) sum[k.id] = (sum[k.id] || 0) + p * st.getCount();
                });
            }
        } catch (e) { }
    });
    return Object.keys(sum).sort((x, y) => sum[y] - sum[x]).slice(0, 4);
}

/** Знать: продать торговцу у базы стопку из своих хранилищ, выручку - в казну. */
function cpWorkNoble(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base;
    var sc = cpScanOf(b);
    if (now - Number(s.comp.dealAt || 0) < CP_DEAL_EVERY) return;
    var list = cpStoreList(level, sc, b, 48);
    var sale = cpSaleStores(list);
    if (!s.comp.wantedAt || now - s.comp.wantedAt > CP_WANT_EVERY) {
        s.comp.wanted = cpWantedKinds(sale.from);
        s.comp.wantedAt = now;
    }
    if (!sale.purse) { s.comp.job = { what: "нет хранилища с деньгами (или «Казна»)", at: now }; return }
    var trader = cpTraderNear(level, b);
    if (!trader) { s.comp.job = { what: "ждёт караван", at: now }; return }
    var kind = String(trader.persistentData.getString("tfg_trader_kind"));

    // что из товара этому торговцу нужно
    var pick = null;
    for (var fi = 0; fi < sale.from.length && !pick; fi++) {
        var a = sale.from[fi];
        for (var i = 0; i < a.h.getSlots(); i++) {
            var st = a.h.getStackInSlot(i);
            if (!st || st.isEmpty() || cpIsCoin(st)) continue;
            var unit = 0;
            try { unit = Number(global.TFG_TRADE_GOODS.sellPrice(kind, st)) } catch (err) { unit = 0 }
            if (unit > 0) { pick = { a: a, slot: i, unit: unit, count: st.getCount(), id: String(st.id) }; break }
        }
    }
    if (!pick) { s.comp.job = { what: "торговцу (" + kind + ") продать нечего", at: now }; s.comp.dealAt = now; return }

    var dd = Math.pow(trader.getX() - e.getX(), 2) + Math.pow(trader.getZ() - e.getZ(), 2);
    if (dd > 16) { cpGo(e, trader.getX(), trader.getY(), trader.getZ(), 1.0); s.comp.job = { what: "идёт к торговцу", at: now }; return }

    var got = null;
    try { got = pick.a.h.extractItem(pick.slot, pick.count, false) } catch (err) { got = null }
    if (!got || got.isEmpty()) { s.comp.dealAt = now; return }
    var price = Math.max(1, Math.floor(pick.unit * got.getCount() * CP_NOBLE_SHARE));
    var lost = cpPayInto(sale.purse.h, price);
    if (lost > 0) cpPayInto(pick.a.h, lost);
    s.comp.dealAt = now;
    s.comp.sold = (s.comp.sold || 0) + price;
    s.comp.job = { what: "продал " + pick.id + " x" + got.getCount() + " за " + price, at: now };
    try { seVoice(e, cpPick(CP_DEAL_SAY)) } catch (err) { }
    cpLog(s.name + " продал " + kind + " " + pick.id + " x" + got.getCount() + " за " + price + " медяков")
    try { global.TFG_SETTLERS.save() } catch (err) { }
}

/** Виды торговцев, нужные знати этой базы игрока (для выбора визита в guests.js). */
function cpWantedFor(pf) {
    var out = [];
    if (!pf || !pf.base) return out;
    var vs = global.TFG_SETTLERS.list();
    for (var vid in vs) vs[vid].settlers.forEach(s => {
        if (!s.comp || s.dead || s.comp.mode !== "база" || !s.comp.base || !s.comp.wanted) return;
        if (Math.pow(s.comp.base.x - pf.base.x, 2) + Math.pow(s.comp.base.z - pf.base.z, 2) > CP_WORK_R * CP_WORK_R) return;
        s.comp.wanted.forEach(k => { if (out.indexOf(k) < 0) out.push(k) });
    });
    return out;
}

/** Сословие жителя с учётом переназначения командой (/tfgcomp сословие). */
function cpEstate(s) {
    if (s.estate) return s.estate;
    try { return String(global.TFG_SETTLERS.estateOf(s)) } catch (e) { return "простолюдины" }
}

/** Работа по сословию. Военные стерегут базу - это сделано отдельно, в cpBaseStep. */
function cpWork(level, c, now) {
    var s = c.s;
    // раз в минуту - в журнал, что видит и делает (то же, что /tfgcomp работа)
    var wu = String(c.e.uuid);
    if (!CP_SAID["w" + wu] || now - CP_SAID["w" + wu] > 1200) {
        CP_SAID["w" + wu] = now;
        try {
            var sc0 = cpScanOf(s.comp.base), np = 0, nb = 0;
            for (var pk0 in sc0.plots) { if (sc0.plots[pk0] === "лоза") continue; if (sc0.plots[pk0] === "куст") nb++; else np++ }
            cpLog(s.name + " (" + cpEstate(s) + ", база): обход - чанков " + sc0.chunks + ", кругов " + sc0.sweeps + ", грядок и плодов " + np +
                ", кустов " + nb + ", хранилищ " + Object.keys(sc0.stores).length + ", погребов " + Object.keys(sc0.stations || {}).length + cpCellarInfo(level, sc0) + (sc0.err ? " (сбой: " + sc0.err + ")" : "") + "; мешок " + cpBag(s).length + " стопок; шагов переносом " + cpStepped + "; сжато " + (s.comp.reaped || 0) +
                "; сейчас: " + (s.comp.job ? s.comp.job.what : "ещё не начинал") +
                (s.comp.last ? "; последнее: " + s.comp.last : "") + (s.comp.seen ? "; спелое рядом (спелых/всего): " + s.comp.seen : ""));
        } catch (e0) { cpTickFail("журнал работы", e0, now) }
    }
    if (now % CP_WORK_EVERY < 10) { try { cpScanStep(level, s.comp.base, now) } catch (e) { cpTickFail("обход базы", e, now) } }
    var estate = cpEstate(s);
    if (estate === "знать") { if (now % 20 < 10) cpWorkNoble(level, c, now) }
    else if (estate === "простолюдины") { if (now % 20 < 10) cpWorkPeasant(level, c, now) }
}

// ─── Бой ─────────────────────────────────────────────────────────────────────
//
// Своего боевого ИИ у жителей нет: злые цели кадавра с них сняты, и одно setTarget их драться
// не заставляет. Бьются они тем же мозгом, что стража поселения и рейдеры (seFight ->
// raidCombatTick в tfg/raids.js): держат дистанцию по оружию, стреляют из TACZ.
// 29.10.2026 стража базы «ходила у башни и ничего не делала» - именно поэтому.

const CP_GUARD_R = 44                   // стража базы гонит врага в стольких блоках от точки базы (как стража поселения)
const CP_ESCORT_R = 24                  // спутник в дороге сам бьёт врага в стольких блоках от хозяина
var CP_FOE = {}                         // uuid спутника -> враг, с которым он бьётся
// твари Ice and Fire, на которых стража бросается всегда (горгона, василиск-кокатрис и прочие)
const CP_IAF_FOES = /^iceandfire:(gorgon|cockatrice|troll|cyclops|siren|dread_|myrmex_(soldier|sentinel|royal|swarmer)|ghost|hydra)/
// запасной список нечисти, если settlers.js не загружен (основной - SE_MONSTERS там)
const CP_MONSTERS = ["minecraft:zombie", "minecraft:husk", "minecraft:drowned", "minecraft:skeleton", "minecraft:stray",
    "minecraft:spider", "minecraft:cave_spider", "minecraft:creeper", "minecraft:witch", "minecraft:pillager",
    "minecraft:vindicator", "minecraft:ravager"]

/** Враг ли это: рейдер, бандит или нечисть - но не житель, не гость и не спутник. */
function cpIsFoe(m) {
    try {
        if (!m || !m.isAlive()) return false
        var t = m.getTags()
        if (t.contains("tfg_npc") || t.contains("tfg_settler") || t.contains("tfg_companion")) return false
        if (t.contains("tfg_raider") || t.contains("tfg_bandit") || t.contains("tfg_raid")) return true
        var id = String(m.type)
        if (CP_IAF_FOES.test(id) || id.indexOf("primitive_creatures:") === 0) return true
        var mons = typeof SE_MONSTERS !== "undefined" ? SE_MONSTERS : CP_MONSTERS
        return mons.indexOf(id) >= 0
    } catch (err) { return false }
}

/** Ближайший враг в r блоках от точки (x, y, z). */
function cpFoeNear(level, x, y, z, r) {
    var best = null, bestD = r * r
    try {
        // по высоте - на 64 вверх и вниз: воздушный рейд висит на сотне блоков, десант спускается
        var list = level.getEntitiesWithin(new CP_AABB(x - r, y - 64, z - r, x + r, y + 64, z + r))
        for (var i = 0; i < list.size(); i++) {
            var m = list.get(i)
            if (!cpIsFoe(m)) continue
            var d = Math.pow(m.getX() - x, 2) + Math.pow(m.getZ() - z, 2)
            if (d < bestD) { bestD = d; best = m }
        }
    } catch (err) { }
    return best
}

/** Вести бой с врагом: true - бьётся (движение задано). Врага нет или ушёл - false. */
function cpFight(e, foe) {
    // бьём любого живого, кроме своих: и врага с поля, и того, кто ударил хозяина (зверь, игрок)
    try {
        if (!foe || !foe.isAlive()) return false
        var ft = foe.getTags()
        if (ft.contains("tfg_settler") || ft.contains("tfg_companion")) return false
    } catch (err) { return false }
    var fighting = false
    try { fighting = seFight(e, foe) } catch (err) { }
    if (!fighting) {
        try { e.getNavigation().moveTo(foe.getX(), foe.getY(), foe.getZ(), 1.4) } catch (err) { }
    }
    return true
}

function cpBaseStep(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base
    var gu = String(e.uuid)
    if (!b) return
    // работа по сословию
    try { cpWork(level, c, now) } catch (err) { cpTickFail("работа на базе", err, now) }
    var dx = b.x - e.getX(), dz = b.z - e.getZ()
    // далеко от базы - домой; иначе бродит рядом
    var busy = !!CP_FOE[gu]
    var fighter = cpEstate(s) === "военные"
    // стража держится у базы, работники ходят по всей её земле
    var homeR = fighter ? CP_BASE_R * 2 : CP_WORK_R + 16
    if (busy) { }
    else if (dx * dx + dz * dz > homeR * homeR) { try { e.teleportTo(b.x + 0.5, b.y, b.z + 0.5) } catch (err) { } }
    else if (fighter && now % 200 < 10) {
        // дозор: новая точка вокруг базы раз в десять секунд
        try {
            var px = b.x + (Math.random() - 0.5) * 48, pz = b.z + (Math.random() - 0.5) * 48
            var py = b.y
            try { py = Number(level.getHeight(CP_HEIGHT, Math.floor(px), Math.floor(pz))) } catch (err2) { }
            e.getNavigation().moveTo(px, py, pz, 0.9)
        } catch (err) { }
    }
    // Стража: прежде всего хозяин (его обидчик, враг в 24 блоках от него, если он в 64 от спутника),
    // потом база (враг в CP_GUARD_R блоках от её точки). Мирные сословия не дерутся - работают.
    var guard = cpEstate(s) === "военные"
    if (guard) {
        var owner = null
        try { owner = cpOwner(level.getServer(), s) } catch (err) { }
        var od = owner && String(owner.level.getDimension()) === String(e.level.getDimension())
            ? Math.sqrt(Math.pow(owner.getX() - e.getX(), 2) + Math.pow(owner.getZ() - e.getZ(), 2)) : 1e9
        var foe = CP_FOE[gu]
        try { if (foe && !foe.isAlive()) foe = null } catch (err) { foe = null }
        if (foe && od > CP_RUN_FAR && Math.pow(foe.getX() - b.x, 2) + Math.pow(foe.getZ() - b.z, 2) > CP_GUARD_R * CP_GUARD_R * 2) foe = null
        if (!foe && od <= CP_RUN_FAR) foe = cpFoeNear(level, owner.getX(), owner.getY(), owner.getZ(), CP_ESCORT_R)
        if (!foe) foe = cpFoeNear(level, b.x, b.y, b.z, CP_GUARD_R)
        if (foe && cpFight(e, foe)) CP_FOE[gu] = foe
        else { delete CP_FOE[gu]; foe = null }
        if (!CP_SAID[gu] || now - CP_SAID[gu] > 1200) {
            CP_SAID[gu] = now
            cpLog(s.name + " (стража базы): " + (foe ? "бьётся с " + String(foe.type) + " в " +
                Math.round(Math.sqrt(Math.pow(foe.getX() - e.getX(), 2) + Math.pow(foe.getZ() - e.getZ(), 2))) + " бл." : "врагов нет, дозор") +
                ", до базы " + Math.round(Math.sqrt(dx * dx + dz * dz)) + " бл." + (od < 1e8 ? ", до хозяина " + Math.round(od) + " бл." : ""))
        }
    }
    // реплика по делу, когда хозяин рядом: не чаще раза в CP_BASE_BARK_T
    try {
        var ow = cpOwner(level.getServer(), s)
        if (ow && (!CP_BARK_AT[gu] || now - CP_BARK_AT[gu] > CP_BASE_BARK_T) && Math.random() < 0.2 &&
            Math.pow(ow.getX() - e.getX(), 2) + Math.pow(ow.getZ() - e.getZ(), 2) < 16 * 16) {
            CP_BARK_AT[gu] = now
            var est = cpEstate(s)
            var lines = est === "военные" ? (CP_FOE[gu] ? CP_BARK_FIGHT : CP_BARK_GUARD) : est === "знать" ? CP_BARK_NOBLE : CP_BARK_PEASANT
            seVoice(e, cpPick(lines))
            level.getServer().scheduleInTicks(100, () => { try { seRestoreSettlerName(e) } catch (err2) { } })
        }
    } catch (err) { }
    // еда: дважды в сутки (утром и вечером), не поел за сутки - голод; три дня голода - уходит
    var day = Math.floor(Number(level.getTime()) / CP_DAY), tod = Number(level.getDayTime()) % CP_DAY
    var meal = tod < 12000 ? 0 : 1
    if (s.comp.eatDay !== day) { if (s.comp.eatDay >= 0 && (s.comp.ate || 0) === 0) s.comp.hungry = (s.comp.hungry || 0) + 1; s.comp.eatDay = day; s.comp.ate = 0; s.comp.meals = {} }
    s.comp.meals = s.comp.meals || {}
    if (!s.comp.meals[meal] && tod % 12000 > 1000) {
        s.comp.meals[meal] = true
        if (cpEatScan(level, b) || cpEat(level, b)) { s.comp.ate = (s.comp.ate || 0) + 1; s.comp.hungry = 0 }
        try { global.TFG_SETTLERS.save() } catch (err) { }
    }
    if ((s.comp.hungry || 0) >= (s.comp.oath ? CP_OATH_HUNGER : CP_HUNGER_PLAIN)) {
        try { seVoice(e, s.comp.oath ? CP_HUNGRY_LEAVE_OATH : CP_HUNGRY_LEAVE) } catch (err) { }
        try { rlNote(c.v, { uuid: s.comp.owner, username: "?" }, s.id, -25, "голодал на базе") } catch (err) { }
        delete s.comp
        delete s.away
        cpMark(e, false)
        try { if (s.bed) e.teleportTo(s.bed.x + 0.5, s.bed.y, s.bed.z + 0.5) } catch (err) { }
        try { global.TFG_SETTLERS.save() } catch (err) { }
        cpLog(s.name + " ушёл с базы: голод")
    }
}

// ─── Потерявшиеся спутники ───────────────────────────────────────────────────

/** Спутника игрока нет в мире дольше минуты - появиться рядом с игроком (старый, если найдётся, - лишний). */
function cpLostTick(server) {
    var level = server.overworld()
    var now = Number(server.tickCount)
    // Игроков - списком сервера и обычным циклом: server.players.forEach здесь падал с
    // NullPointerException (29.10.2026, каждые 70 секунд), и спутники так и не появлялись.
    var players = []
    try {
        var pl = server.getPlayerList().getPlayers()
        for (var pi = 0; pi < pl.size(); pi++) if (pl.get(pi)) players.push(pl.get(pi))
    } catch (err) { cpTickFail("потерявшиеся: список игроков", err, now); return }
    players.forEach(p => {
        var mine = []
        try { mine = cpMine(p) } catch (err) { cpTickFail("потерявшиеся: записи игрока", err, now); return }
        mine.forEach(c => {
            var stage = "начало"
            try {
                if (c.s.comp.mode !== "идёт") return
                var key = c.v.id + "|" + c.s.id
                stage = "мир игрока"
                if (String(p.level.getDimension()) !== "minecraft:overworld") return
                stage = "поиск рядом"
                var near = cpEntity(level, c.v, c.s)
                if (near) { delete CP_LOST[key]; return }
                // Рядом с игроком нет - но он может быть жив дальше, в прогруженной земле (у поселения).
                // Прежде тут сразу создавался новый, а старый делал его двойником, и новый тут же убирался:
                // «догнал (появился рядом)» каждые 70 секунд. Теперь живого ищем по всему миру.
                stage = "поиск по миру"
                var far = cpAnywhere(level, c.v, c.s)
                if (far) {
                    delete CP_LOST[key]
                    var fu = String(far.uuid)
                    c.s.comp.euuid = fu
                    if (now - (CP_SEEN_AT[fu] || 0) > CP_UNSEEN) {
                        stage = "перенос дальнего"
                        cpPlaceNear(level, p, far)
                        cpLog(c.s.name + " был далеко от " + p.username + " - перенесён за спину")
                    }
                    return
                }
                if (!CP_LOST[key]) { CP_LOST[key] = now; cpLog(c.s.name + ": в мире не найден - через минуту появится за спиной " + p.username); return }
                if (now - CP_LOST[key] < 1200) return
                delete CP_LOST[key]
                stage = "точка за спиной"
                var at = null
                try { at = cpBehind(p, 3) } catch (err2) { at = null }
                if (!at || !isFinite(at.x) || !isFinite(at.z)) at = { x: Math.floor(Number(p.getX())) + 2, z: Math.floor(Number(p.getZ())) + 2 }
                c.s.enterAt = at
                delete c.s.comp.euuid                     // номер нового существа запишет его появление
                stage = "выпуск"
                // отдельной задачей: сбой при появлении не должен ронять ход сервера и остальных спутников
                var cv = c.v, cs = c.s, who = String(p.username)
                server.scheduleInTicks(1, () => {
                    try {
                        seSpawnOne(cv, cs, level)
                        cpLog(cs.name + " догнал " + who + " (появился за спиной, " + at.x + " " + at.z + ")")
                    } catch (err3) { cpTickFail("потерявшиеся: выпуск", err3, now) }
                })
            } catch (err) { cpTickFail("потерявшиеся: " + stage, err, now) }
        })
    })
}

var CP_WARNED = {}

/** Сбой в тике не должен ронять сервер, но и глотать его молча нельзя: пишем раз в минуту на место сбоя. */
function cpTickFail(where, err, tick) {
    if (CP_WARNED[where] && tick - CP_WARNED[where] < 1200) return
    CP_WARNED[where] = tick
    try {
        if (global.tfgLogError) global.tfgLogError("tfg companions", where, err)
        else console.error("[tfg companions/ОШИБКА] " + where + ": " + err)
    } catch (e) { }
}

ServerEvents.tick(event => {
    var t = event.server.tickCount
    if (t % 10 === 3) { try { cpFollowTick(event.server) } catch (e) { cpTickFail("ход спутников", e, t) } }
    if (t % 200 === 77) { try { cpLostTick(event.server) } catch (e) { cpTickFail("потерявшиеся", e, t) } }
})

// метка спутника - и после перезапуска, и у появившегося заново
EntityEvents.spawned(event => {
    try {
        var e = event.entity
        if (!e.getTags || !e.getTags().contains("tfg_settler")) return
        var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
        var v = global.TFG_SETTLERS.list()[vid]
        var s = v ? v.settlers.filter(x => x.id === sid)[0] : null
        if (s && s.comp) {
            try { if (e.isRemoved()) return } catch (err1) { }       // двойник, его только что убрали
            cpMark(e, true)
            try { if (s.comp.immortal) e.addTag("tfg_immortal"); else e.removeTag("tfg_immortal") } catch (err3) { }
            if (s.comp.euuid !== String(e.uuid)) { s.comp.euuid = String(e.uuid); try { global.TFG_SETTLERS.save() } catch (err2) { } }
        }
    } catch (err) { }
})

// ─── Защита и бой ────────────────────────────────────────────────────────────

/**
 * Урон спутнику: true - отменить. Отмену зовём СНАРУЖИ try: event.cancel() бросает EventExit, и
 * перехватчик его съедал - защита от падения, утопления и удара хозяина на деле не работала.
 */
function cpHurtCancel(victim, src) {
    if (!(victim.getTags && victim.getTags().contains("tfg_companion"))) return false
    if (victim.getTags().contains("tfg_immortal")) return true                 // /tfgcomp бессмертие
    var type = String(src.getType ? src.getType() : src.type)
    if (/fall|drown|inWall|in_wall|cramming/.test(type)) return true
    var pl = src.player
    if (pl) {
        var c = cpAll(victim.level).filter(x => String(x.e.uuid) === String(victim.uuid))[0]
        if (c && cpUuid(c.s.comp.owner) === cpUuid(pl.uuid)) return true
    }
    return false
}

EntityEvents.hurt(event => {
    var cancel = false
    try { cancel = cpHurtCancel(event.entity, event.source) } catch (err) { }
    if (cancel) { event.cancel(); return }
    try {
        var victim = event.entity
        var src = event.source
        if (victim.getTags && victim.getTags().contains("tfg_companion")) return
        // хозяина ударили - спутники на обидчика
        var attacker = src.actual || src.immediate
        if (victim.isPlayer && victim.isPlayer() && attacker && attacker.isLiving && attacker.isLiving()) {
            if (attacker.getTags && attacker.getTags().contains("tfg_companion")) return
            cpMine(victim).forEach(c => {
                var e = cpEntity(victim.level, c.v, c.s)
                if (!e) return
                var near = Math.pow(e.getX() - victim.getX(), 2) + Math.pow(e.getZ() - victim.getZ(), 2) < CP_RUN_FAR * CP_RUN_FAR
                if (c.s.comp.mode !== "база" || near) { CP_FOE[String(e.uuid)] = attacker; try { e.setTarget(attacker) } catch (err) { } }
            })
            return
        }
        // хозяин бьёт - спутники помогают (жителей и спутников не трогают)
        var hitter = src.player
        if (hitter && victim.isLiving && victim.isLiving() && !(victim.getTags && (victim.getTags().contains("tfg_settler") || victim.getTags().contains("tfg_companion")))) {
            cpMine(hitter).forEach(c => {
                var e = cpEntity(victim.level, c.v, c.s)
                if (e && c.s.comp.mode !== "база") { CP_FOE[String(e.uuid)] = victim; try { e.setTarget(victim) } catch (err) { } }
            })
        }
    } catch (err) { }
})

// погиб спутник - снять запись
EntityEvents.death(event => {
    try {
        var e = event.entity
        if (!e.getTags || !e.getTags().contains("tfg_companion")) return
        cpLog("спутник погиб: " + String(e.getName().getString()))
    } catch (err) { }
})

// ─── В окно разговора ────────────────────────────────────────────────────────

;(() => {
    if (typeof DLG_NPC_OPTIONS === "undefined") return
    var opts = [
        { id: "cp_recruit", label: () => "Пойдёшь со мной?", hint: () => "Друг пойдёт даром, приятель - за " + CP_HIRE_PRICE + " медяков. Не больше двух спутников.",
            // без записи жителя кнопка не показывается: прежде она была, но молча ничего не делала
            show: ctx => { if (!cpIsSettler(ctx) || cpOf(ctx)) return false; var w = tkWho(ctx); return !!w && !w.s.comp },
            run: ctx => cpRecruit(ctx) },
        { id: "cp_wait", label: () => "Подожди здесь", hint: () => "Останется на месте, пока не позовёшь.",
            show: ctx => { var w = cpOf(ctx); return !!w && w.s.comp.mode === "идёт" },
            run: ctx => { var w = cpOf(ctx); w.s.comp.mode = "ждёт"; try { ctx.trader.getNavigation().stop() } catch (e) { } global.TFG_SETTLERS.save(); dlgSay(ctx, cpPick(CP_WAIT)) } },
        { id: "cp_go", label: () => "Идём дальше", hint: () => "Снова пойдёт следом.",
            show: ctx => { var w = cpOf(ctx); return !!w && w.s.comp.mode !== "идёт" },
            run: ctx => { var w = cpOf(ctx); w.s.comp.mode = "идёт"; w.s.away = "спутник"; delete w.s.comp.base; global.TFG_SETTLERS.save(); dlgSay(ctx, cpPick(CP_GO)) } },
        { id: "cp_base", label: () => "Живи у меня на базе", hint: () => "Будет жить у базы твоей фракции: стеречь, есть из хранилищ дважды в день.",
            show: ctx => { var w = cpOf(ctx); return !!w && w.s.comp.mode !== "база" }, run: ctx => cpSettleBase(ctx, cpOf(ctx)) },
        { id: "cp_home", label: () => "Возвращайся домой", hint: () => "Отпустить в родное поселение.",
            show: ctx => !!cpOf(ctx), run: ctx => { var w = cpOf(ctx); dlgSay(ctx, cpPick(CP_HOME)); cpRelease(ctx, w, "отпустил хозяин"); dlgClose(ctx.player) } },
    ]
    ;[DLG_NPC_OPTIONS, typeof DLG_OPTIONS !== "undefined" ? DLG_OPTIONS : null].forEach(list => {
        if (!list) return
        opts.forEach(opt => {
            if (list.some(x => x.id === opt.id)) return
            var at = list.findIndex(o => o.id === "leave")
            list.splice(at < 0 ? list.length : at, 0, opt)
        })
    })
})()

// /tfgcomp - мои спутники и жители базы
ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal("tfgcomp").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var mine = cpMine(p)
        if (!mine.length) {
            p.tell(Text.of("§7Спутников нет. Позови жителя в разговоре: «Пойдёшь со мной?»"))
            // Разбор: бывает, что запись есть, а хозяин в ней записан иначе
            var all = cpAllRecords()
            p.tell(Text.of("§8твой номер: " + cpUuid(p.uuid)))
            p.tell(Text.of("§8записей со спутниками всего: " + all.length))
            all.slice(0, 4).forEach(r => p.tell(Text.of("§8  " + r.s.name + " - хозяин " + cpUuid(r.s.comp.owner) + ", состояние " + r.s.comp.mode + (r.s.dead ? ", помечен погибшим" : ""))))
            return 1
        }
        mine.forEach(c => {
            var e = null
            try { e = cpEntity(p.level, c.v, c.s) || cpAnywhere(p.level, c.v, c.s) } catch (err) { }
            var where = e ? "в " + Math.round(Math.sqrt(Math.pow(e.getX() - p.getX(), 2) + Math.pow(e.getZ() - p.getZ(), 2))) + " бл. (" +
                Math.round(e.getX()) + " " + Math.round(e.getY()) + " " + Math.round(e.getZ()) + ")" : "в мире не найден (появится за спиной в течение минуты)"
            p.tell(Text.of("§6• §7" + c.s.name + " (" + (c.s.role || "житель") + "): " + c.s.comp.mode + ", " + where +
                (c.s.comp.base ? ", база " + c.s.comp.base.x + " " + c.s.comp.base.z + (c.s.comp.hungry ? ", голодает дней: " + c.s.comp.hungry : "") : "")))
        })
        p.tell(Text.of("§8/tfgcomp сюда - привести их за спину сейчас"))
        return 1
    }).then(event.commands.literal("сюда").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var level = p.level, n = 0
        cpMine(p).forEach(c => {
            if (c.s.comp.mode === "база") return
            var e = null
            try { e = cpEntity(level, c.v, c.s) || cpAnywhere(level, c.v, c.s) } catch (err) { }
            if (e) {
                try { if (String(e.level.getDimension()) !== String(level.getDimension())) e.teleportTo(level, p.getX(), p.getY(), p.getZ(), 0, 0) } catch (err) { }
                cpPlaceNear(level, p, e)
                c.s.comp.euuid = String(e.uuid)
            } else {
                c.s.enterAt = cpBehind(p, 3)
                delete c.s.comp.euuid
                try { seSpawnOne(c.v, c.s, level) } catch (err) { }
            }
            if (c.s.comp.mode === "ждёт") c.s.comp.mode = "идёт"
            n++
        })
        try { global.TFG_SETTLERS.save() } catch (err) { }
        p.tell(Text.of(n ? "§7Спутники рядом: " + n : "§7Спутников нет."))
        cpLog("/tfgcomp сюда: " + p.username + ", приведено " + n)
        return 1
    })).then(cpEstateNode(event)).then(event.commands.literal("работа").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var mine = cpMine(p)
        if (!mine.length) { p.tell(Text.of("§7Спутников нет.")); return 1 }
        mine.forEach(c => cpTellWork(p, c))
        return 1
    })).then(cpNewNode(event)).then(event.commands.literal("база").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var c = cpTargetOf(p)
        if (!c) { p.tell(Text.of("§7Смотри на своего спутника (до 8 блоков).")); return 1 }
        var base = null
        try { base = global.TFG_SETTLEMENTS.baseFor(p) } catch (err) { }
        if (!base || typeof base.x !== "number") { p.tell(Text.of("§7Ты не на базе своей фракции.")); return 1 }
        c.s.away = "база"; c.s.comp.mode = "база"
        c.s.comp.base = { x: Math.floor(base.x), y: Math.floor(base.y || 70), z: Math.floor(base.z) }
        try { c.s.comp.base.y = stTop(p.level, base.x, base.z) + 1 } catch (err) { }
        try { global.TFG_SETTLERS.save() } catch (err) { }
        p.tell(Text.of("§7" + c.s.name + " теперь живёт на базе (" + c.s.comp.base.x + " " + c.s.comp.base.z + ") и работает: " + cpEstate(c.s)))
        return 1
    })).then(event.commands.literal("бессмертие").executes(ctx => {
        // включить или выключить бессмертие всем своим спутникам и жителям базы - для проверки в бою
        var p = ctx.source.getPlayerOrException()
        var mine = cpMine(p)
        if (!mine.length) { p.tell(Text.of("§7Спутников нет.")); return 1 }
        var on = !mine.some(c => !!c.s.comp.immortal)              // хоть один бессмертен - выключаем всем
        // только отметка в записи: метку на само существо ставит ход спутников (cpFollowTick).
        // Поиск существ по всему миру отсюда ронял команду («Произошла непредвиденная ошибка»).
        for (var mi = 0; mi < mine.length; mi++) { mine[mi].s.comp.immortal = on; if (on) mine[mi].s.comp.heal = true }
        try { global.TFG_SETTLERS.save() } catch (err) { }
        p.tell(Text.of("§7Бессмертие спутников " + (on ? "§aвключено" : "§cвыключено") + "§7: " + mine.map(c => c.s.name).join(", ")))
        cpLog("/tfgcomp бессмертие: " + p.username + " -> " + (on ? "вкл" : "выкл"))
        return 1
    })))
})

/**
 * САМОПРОВЕРКА: /tfgcheck
 *
 * Весь день мы теряли часы на том, что способы игры молча отказывали: метки читались пустыми,
 * направление взгляда падало, признак «не исчезать» не ставился, список существ был пуст.
 * Ни один из этих отказов не был виден - ни ошибки, ни следа в журнале.
 *
 * Эта команда берёт ближайшего жителя и проверяет КАЖДУЮ способность по отдельности, печатая
 * годен/не годен. Так неизвестность превращается в список из десяти строк, и уверенность
 * становится проверяемой, а не словесной.
 */
ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal("tfgcheck").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var level = p.level
        var ok = 0, bad = 0
        function say(name, good, extra) {
            if (good) ok++; else bad++
            p.tell(Text.of((good ? "§aгоден  §7" : "§cНЕ ГОДЕН §7") + name + (extra ? " §8" + extra : "")))
        }

        // ближайший житель - на нём и проверяем
        var e = null, best = 1e9
        try {
            var box = new CP_AABB(p.getX() - 48, p.getY() - 32, p.getZ() - 48, p.getX() + 48, p.getY() + 32, p.getZ() + 48)
            var list = level.getEntitiesWithin(box)
            for (var i = 0; i < list.size(); i++) {
                var c = list.get(i)
                if (!c || !c.isAlive()) continue
                if (cpTagValue(c, "tfg_sid_") === null) continue
                var dx = c.getX() - p.getX(), dz = c.getZ() - p.getZ()
                var d = dx * dx + dz * dz
                if (d < best) { best = d; e = c }
            }
        } catch (err) { }

        say("обход существ вокруг игрока", e !== null, e ? "житель найден" : "жителей рядом нет - встань в поселении")
        if (!e) { p.tell(Text.of("§7итог: проверка неполная")); return 1 }

        say("чтение метк", cpTagValue(e, "tfg_sid_") !== null, "номер жителя " + cpTagValue(e, "tfg_sid_"))
        var byId = null
        try { byId = cpByUuid(level, String(e.uuid)) } catch (err) { }
        say("поиск по номеру существа", byId !== null)
        var nav = null
        try { nav = e.getNavigation() } catch (err) { }
        say("ходьба (навигация)", nav !== null && nav !== undefined)
        var path = null
        try { path = nav.createPath(p.blockPosition(), 1) } catch (err) { }
        say("поиск дороги до игрока", path !== null && path !== undefined, path ? "дорога есть: " + path.canReach() : "способ недоступен - считаем, что дороги нет")
        var keep = false
        try { e.setPersistenceRequired(); keep = true } catch (err) { }
        say("признак «не исчезать»", keep, keep ? "" : "ставится командой - запасной путь")
        var look = cpLook(p)
        say("направление взгляда игрока", look !== null)
        var hp = false
        try { hp = isFinite(Number(e.getHealth())) && isFinite(Number(e.getMaxHealth())); } catch (err) { }
        say("здоровье и восстановление", hp)
        var air = false
        try { e.setAirSupply(300); air = true } catch (err) { }
        say("защита от утопления", air)
        // САМОЕ ВАЖНОЕ: опознаёт ли разговор жителя. От этого зависят и реплики, и наём.
        var who = null
        try { who = rlSettlerOf(e) } catch (err) { }
        say("разговор опознаёт жителя", who !== null && who.sid !== null,
            who ? "поселение " + who.v.id + ", номер " + who.sid : "НЕ опознан - реплик и найма не будет")
        var full = null
        try { full = tkWho({ trader: e, player: p }) } catch (err) { }
        say("запись жителя для разговора", full !== null,
            full ? "имя " + full.s.name + ", расположение " + (full.op ? full.op.value : "?") : "записи нет")
        if (full) {
            var tier = -1
            try { tier = rlTier(full.op.value) } catch (err) { }
            say("пойдёт ли в спутники", tier >= 3,
                tier >= 4 ? "пойдёт даром" : tier === 3 ? "пойдёт за " + CP_HIRE_PRICE + " медяков" : "откажет: расположение низкое (ступень " + tier + ")")
        }
        var recs = cpAllRecords()
        say("записи спутников читаются", true, "всего записей со спутниками: " + recs.length)

        p.tell(Text.of((bad === 0 ? "§aитог: всё годно (" : "§cитог: неисправно " + bad + " из ") + (ok + bad) + ")"))
        if (bad > 0) p.tell(Text.of("§7покажи мне эти строки - я починю именно их"))
        return 1
    }))
})
// ─── Отладочные команды: сословие, работа, новый спутник ─────────────────────

var CP_ESTATE_ROLE = { "крестьянин": "крестьянин", "знать": "торговец", "военный": "рыцарь", "стрелок": "стрелок" }

/** Свой спутник или житель базы, на которого смотрит игрок (до 8 блоков); иначе ближайший свой в 8 блоках. */
function cpTargetOf(p) {
    var mine = cpMine(p), best = null, bestDot = 0.9, near = null, nearD = 64
    var look = cpLook(p)
    mine.forEach(c => {
        var e = null
        try { e = cpEntity(p.level, c.v, c.s) } catch (err) { }
        if (!e) return
        var dx = e.getX() - p.getX(), dy = e.getY() + 1 - (p.getY() + 1.6), dz = e.getZ() - p.getZ()
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d > 8) return
        if (d * d < nearD) { nearD = d * d; near = { e: e, v: c.v, s: c.s } }
        if (look && d > 0.01) {
            var dot = (dx * look.x + dy * look.y + dz * look.z) / d
            if (dot > bestDot) { bestDot = dot; best = { e: e, v: c.v, s: c.s } }
        }
    })
    return best || near
}

/** Перевести в сословие: роль, снаряжение по роли (существо выпускается заново на том же месте). null - удалось, иначе причина. */
function cpSetEstate(level, c, what) {
    var role = CP_ESTATE_ROLE[what]
    if (!role) return "сословие: крестьянин, знать, военный или стрелок"
    var s = c.s
    if (s.role === "правитель") return "правителя не трогаем"
    s.role = role
    if (what === "знать") s.estate = "знать"; else delete s.estate
    delete s.trade
    delete s.comp.job
    // снаряжение и подпись - по новой роли: убрать прежнее существо и выпустить заново на его месте
    var e = c.e
    try {
        s.enterAt = { x: Math.floor(e.getX()), z: Math.floor(e.getZ()) }
        delete s.comp.euuid
        e.discard()
        seSpawnOne(c.v, s, level)
    } catch (err) { return "не вышло выпустить заново: " + err }
    try { global.TFG_SETTLERS.save() } catch (err) { }
    cpLog(s.name + ": сословие -> " + what + " (" + role + ")")
    return null
}

/** Что делает житель базы: для /tfgcomp работа. */
function cpTellWork(p, c) {
    var s = c.s, est = cpEstate(s)
    p.tell(Text.of("§6• §7" + s.name + " - " + est + " (" + s.role + "), " + s.comp.mode))
    if (s.comp.mode !== "база" || !s.comp.base) { p.tell(Text.of("§8  не на базе: работы нет")); return }
    var sc = cpScanOf(s.comp.base)
    var plots = 0, bushes = 0
    for (var pk in sc.plots) { if (sc.plots[pk] === "грядка" || sc.plots[pk] === "плод") plots++; else if (sc.plots[pk] !== "лоза") bushes++ }
    var stores = Object.keys(sc.stores), named = stores.filter(k => sc.stores[k].tag).map(k => sc.stores[k].name + " (" + sc.stores[k].tag + ")")
    p.tell(Text.of("§8  обход базы: чанков просмотрено " + sc.chunks + ", кругов " + sc.sweeps + "; грядок " + plots + ", кустов и деревьев " + bushes +
        ", хранилищ " + stores.length + (named.length ? ", размечены: " + named.slice(0, 4).join(", ") : "")))
    if (est === "простолюдины") {
        p.tell(Text.of("§8  мешок: стопок " + cpBag(s).length + "/" + CP_BAG_MAX + ", вещей " + cpBagCount(s) + "; сжато всего " + (s.comp.reaped || 0) +
            "; спелое рядом: " + (s.comp.ripeSeen ? "есть" : "нет")))
    } else if (est === "знать") {
        p.tell(Text.of("§8  выручено всего " + (s.comp.sold || 0) + " медяков; нужно торговцам: " + ((s.comp.wanted || []).join(", ") || "пока не считал")))
    }
    p.tell(Text.of("§8  сейчас: " + (s.comp.job ? s.comp.job.what : "ещё не начинал")))
}

/** Сразу сделать спутником жителя нужного сословия из ближайшего поселения - для проверки, без найма. */
function cpNewCompanion(p, what) {
    var want = what === "военный" || what === "стрелок" ? "военные" : what === "знать" ? "знать" : what === "крестьянин" ? "простолюдины" : null
    if (!want) return "кого: крестьянин, знать, военный"
    var vs = global.TFG_SETTLERS.list(), best = null, bestD = 1e18
    for (var vid in vs) {
        var v = vs[vid]
        var d = Math.pow(v.x - p.getX(), 2) + Math.pow(v.z - p.getZ(), 2)
        if (d >= bestD) continue
        var free = v.settlers.filter(s => !s.dead && !s.away && !s.comp && s.role !== "правитель" && cpEstate(s) === want)
        var pick = (want === "простолюдины" ? free.filter(s => s.role === "крестьянин")[0] : null) || free[0]
        if (!pick && want === "знать") pick = v.settlers.filter(s => !s.dead && !s.away && !s.comp && s.role === "крестьянин")[0]
        if (pick) { bestD = d; best = { v: v, s: pick } }
    }
    if (!best) return "в поселениях нет свободного жителя такого сословия"
    var s = best.s
    // прежнее тело (если стоит в поселении) - убрать: спутник появится у игрока
    try { var old = cpAnywhere(p.level, best.v, s); if (old) old.discard() } catch (err) { }
    s.away = "спутник"
    s.comp = { owner: String(p.uuid), mode: "идёт", since: Math.floor(Number(p.level.getTime()) / CP_DAY), ate: 0, eatDay: -1, hungry: 0 }
    if (want === "знать" && cpEstate(s) !== "знать") { s.role = "торговец"; s.estate = "знать"; delete s.trade }
    if (want === "простолюдины" && s.role !== "крестьянин") { s.role = "крестьянин"; delete s.trade }
    // игрок на базе - сразу житель базы (работать), иначе - спутник в дороге
    var base = null
    try { base = global.TFG_SETTLEMENTS.baseFor(p) } catch (err) { }
    if (base && typeof base.x === "number") {
        s.away = "база"; s.comp.mode = "база"
        s.comp.base = { x: Math.floor(base.x), y: Math.floor(base.y || 70), z: Math.floor(base.z) }
        try { s.comp.base.y = stTop(p.level, base.x, base.z) + 1 } catch (err) { }
    }
    s.enterAt = cpBehind(p, 3)
    try { seSpawnOne(best.v, s, p.level) } catch (err) { return "не вышло выпустить: " + err }
    try { global.TFG_SETTLERS.save() } catch (err) { }
    cpLog("/tfgcomp новый: " + s.name + " (" + s.role + ", " + cpEstate(s) + ") из " + best.v.id + " - спутник " + p.username)
    return s.name + " (" + s.role + ") из ближайшего поселения - " + (s.comp.mode === "база" ? "теперь живёт на твоей базе и работает" : "теперь твой спутник") + ", у тебя за спиной"
}

/** /tfgcomp сословие <крестьянин|знать|военный|стрелок> - словами-узлами: строковый аргумент кириллицу без кавычек не берёт. */
function cpEstateNode(event) {
    var node = event.commands.literal("сословие")
    ;["крестьянин", "знать", "военный", "стрелок"].forEach(w => {
        node = node.then(event.commands.literal(w).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var c = cpTargetOf(p)
            if (!c) { p.tell(Text.of("§7Смотри на своего спутника или жителя базы (до 8 блоков).")); return 1 }
            var res = cpSetEstate(p.level, c, w)
            p.tell(Text.of(res ? "§c" + res : "§7" + c.s.name + " теперь: " + w + " (" + c.s.role + ")"))
            return 1
        }))
    })
    return node
}

/** /tfgcomp новый <крестьянин|знать|военный> */
function cpNewNode(event) {
    var node = event.commands.literal("новый")
    ;["крестьянин", "знать", "военный"].forEach(w => {
        node = node.then(event.commands.literal(w).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            p.tell(Text.of("§7" + cpNewCompanion(p, w)))
            return 1
        }))
    })
    return node
}

global.TFG_COMPANIONS = { mine: player => cpMine(player), wantedKinds: pf => cpWantedFor(pf) }

// ─── Цепочки разговоров со спутником ─────────────────────────────────────────
//
// Движок - factions/talk_chains.js. Здесь не отдельные реплики, а связанные ветки: ответы
// зависят от сословия, от отношения, от того, голодал ли он, и от того, дал ли он клятву.
// Клятва - по канону (нити держат душу): у поклявшегося терпение к голоду с трёх дней до пяти,
// и он об этом прямо говорит.

const CP_OATH_HUNGER = 5;              // сколько дней голода терпит поклявшийся
const CP_HUNGER_PLAIN = 3;             // и сколько - непоклявшийся

function cpOathed(ctx) {
    var w = cpOf(ctx);
    return !!w && !!w.s.comp && !!w.s.comp.oath;
}

function cpModeOf(ctx) {
    var w = cpOf(ctx);
    return w && w.s.comp ? String(w.s.comp.mode || "") : "";
}

function cpHungryOf(ctx) {
    var w = cpOf(ctx);
    return w && w.s.comp ? Number(w.s.comp.hungry || 0) : 0;
}

;(() => {
    if (!global.TFG_TALK_CHAINS || !global.TFG_TALK_CHAINS.add) { cpLog("цепочки разговоров недоступны"); return }
    var add = global.TFG_TALK_CHAINS.add;

    // ─── Как тебе дорога ───
    add({
        id: "cp_tk_road",
        group: null,
        label: () => "Как тебе дорога?",
        hint: () => "О пути, об усталости и о том, что он думает про тебя.",
        show: ctx => !!cpOf(ctx) && cpModeOf(ctx) !== "база",
        start: "a",
        steps: {
            a: {
                say: ctx => {
                    var op = 0;
                    try { op = Number(global.TFG_RELATIONS.opinion(ctx.player, cpOf(ctx).v, cpOf(ctx).s)) } catch (e) { }
                    if (cpHungryOf(ctx) > 0) return ["Дорога-то ничего. Только брюхо пустое, а это портит всякую дорогу."];
                    if (op >= 60) return ["С тобой хорошо идти. Я бы и дальше пошёл, куда скажешь."];
                    if (op >= 20) return ["Идём - и ладно. Ноги держат, и то хлеб."];
                    return ["Иду, потому что сговорились. Не больше."];
                },
                ask: "О чём спросишь?",
                opts: [
                    { label: "Не устал?", go: "tired" },
                    { label: "Зачем ты пошёл со мной?", go: "why" },
                    { label: "Чего ты боишься в пути?", go: "fear" },
                    { label: "Ладно, идём.", go: null },
                ],
            },
            tired: {
                say: ctx => cpHungryOf(ctx) > 0
                    ? ["Устал не от ходьбы, а от голода. Я ел в последний раз сам не помню когда.",
                       "Если хочешь, чтобы я шёл дальше - корми. Это не каприз."]
                    : ["Нет. Я не барин, я ходил и дальше, и хуже.",
                       "Главное - не стоять на мокром. От мокрого потом ломит."],
                opts: [],
            },
            why: {
                say: ctx => {
                    var est = "простолюдины";
                    try { est = String(global.TFG_SETTLERS.estateOf(cpOf(ctx).s)) } catch (e) { }
                    if (est === "знать") return ["Дома я сижу при своём, а тут вижу, как живут другие. Это дороже, чем кажется.",
                        "И не делай вид, что ты меня нанял. Я пошёл сам."];
                    if (est === "военные") return ["Мне платят за то, чтобы стоять. А я хотел посмотреть, за что стою.",
                        "С тобой это видно быстрее."];
                    return ["Сидеть на одном месте всю жизнь - и помереть, не видев ничего. Нет уж.",
                        "Да и в поселении от меня толку меньше, чем кажется."];
                },
                ask: "Ещё?",
                opts: [
                    { label: "А если я тебя заведу на смерть?", go: "risk" },
                    { label: "Хорошо сказал.", do: ctx => { try { global.TFG_RELATIONS.note(cpOf(ctx).v, ctx.player, cpOf(ctx).s.id, 2, "похвалил спутника") } catch (e) { } }, go: null },
                ],
            },
            fear: {
                say: ["В пути боятся трёх вещей: воды, темноты и чужой стрелы.",
                      "Вода хуже всего. Упал - и уже не человек, а поклажа.",
                      "Я, впрочем, не утону: с тобой-то меня вытащит."],
                opts: [],
            },
            risk: {
                say: ctx => cpOathed(ctx)
                    ? ["Заведёшь - значит заведёшь. Мы с тобой связаны клятвой, и на Отмели мне будет с кем поговорить.",
                       "Это, если ты не знал, половина всего дела."]
                    : ["Тогда я лягу там, где лёг, и никто меня не помянёт. У меня с тобой нет узла.",
                       "Можно это поправить, если хочешь. Спроси отдельно."],
                note: ctx => cpOathed(ctx) ? null : "Он намекает на клятву.",
                opts: [],
            },
        },
    });

    // ─── Клятва на крови ───
    add({
        id: "cp_tk_oath",
        group: null,
        label: () => "Поклянёмся на крови",
        hint: () => "Связать себя узлом: по вере это держит душу - и он станет терпеливее.",
        show: ctx => !!cpOf(ctx) && !cpOathed(ctx),
        need: ctx => {
            try { return Number(global.TFG_RELATIONS.opinion(ctx.player, cpOf(ctx).v, cpOf(ctx).s)) >= 40 } catch (e) { return false }
        },
        start: "a",
        steps: {
            a: {
                say: ["Клятва на крови? Это не шутка, и после неё не разойдёшься, как расходятся наёмные.",
                      "Связи держат душу. У кого никого нет, тот на Отмели ждёт один, и ему никто не шепчет.",
                      "Если мы поклянёмся - у меня будет узел. И у тебя тоже, учти это."],
                ask: "Что скажешь?",
                opts: [
                    { label: "Клянусь.", hint: "Он станет терпеть голод до пяти дней вместо трёх.", go: "done" },
                    { label: "А что это даёт тебе?", go: "what" },
                    { label: "Повременим.", go: "later" },
                ],
            },
            what: {
                say: ["Мне - то, что меня помянут. Приношение у алтаря дойдёт, на обряде я смогу шепнуть.",
                      "А ещё я перестану считать дни, когда ты забываешь меня кормить. С узлом терпится дольше.",
                      "Тебе - то же самое, если ляжешь прежде меня."],
                ask: "Так что?",
                opts: [
                    { label: "Клянусь.", go: "done" },
                    { label: "Повременим.", go: "later" },
                ],
            },
            done: {
                say: ["Давай руку. Режь свою, я режу свою.",
                      "Всё. Теперь мы связаны, и развязывать это не вздумай - связь ослабнет, а это хуже, чем не клясться вовсе."],
                note: "Клятва дана: он будет терпеть голод до пяти дней.",
                do: ctx => {
                    var w = cpOf(ctx);
                    if (!w || !w.s.comp) return;
                    w.s.comp.oath = true;
                    try { global.TFG_RELATIONS.note(w.v, ctx.player, w.s.id, 15, "клятва на крови") } catch (e) { }
                    try { global.TFG_SETTLERS.save() } catch (e) { }
                    cpLog(w.s.name + " поклялся на крови с " + String(ctx.player.username));
                },
                opts: [],
            },
            later: {
                say: ["Как хочешь. Я не навязываюсь."],
                opts: [],
            },
        },
    });

    // ─── Что ты делаешь на базе ───
    add({
        id: "cp_tk_work",
        label: () => "Что ты делаешь на базе?",
        hint: () => "Чем он занят, пока тебя нет.",
        show: ctx => !!cpOf(ctx) && cpModeOf(ctx) === "база",
        start: "a",
        steps: {
            a: {
                say: ctx => {
                    var est = "простолюдины";
                    try { est = String(global.TFG_SETTLERS.estateOf(cpOf(ctx).s)) } catch (e) { }
                    if (est === "знать") return ["Я при деле. Когда приходит караван, я торгуюсь: беру самое дорогое, что по карману.",
                        "Монеты - из того сундука, где их больше всего. Из своих я не плачу, не надейся."];
                    if (est === "военные") return ["Стерегу. Хожу по кругу и смотрю, кто лезет.",
                        "Пока я тут, у тебя под стеной чужого не будет."];
                    return ["Жну, что поспело, и отношу в сундук, где зерно.",
                        "Недозрелое не трогаю - его трогать нельзя, пропадёт."];
                },
                ask: "Что уточнишь?",
                opts: [
                    { label: "А еда?", go: "food" },
                    { label: "Куда ты всё складываешь?", go: "where" },
                    { label: "Ясно.", go: null },
                ],
            },
            food: {
                say: ctx => cpHungryOf(ctx) > 0
                    ? ["Вот про еду и разговор. В хранилищах пусто, я " + cpHungryOf(ctx) + " день как не ел.",
                       "Положи чего-нибудь, иначе я уйду домой. " + (cpOathed(ctx) ? "С клятвой подожду до пятого дня." : "На третий день уйду.")]
                    : ["Ем дважды в сутки из хранилищ у базы. Беру самое сытное, что найду: похлёбку прежде сухой корки.",
                       "Пока есть что брать - я тут."],
                opts: [],
            },
            where: {
                say: ["Зерно и прочую снедь - в тот сундук, где зерна больше всего. Так проще искать потом.",
                      "Если зерна нигде нет, кладу туда, где больше места. Купленное у каравана - тоже.",
                      "Инструмент и руду не трогаю: не моё дело."],
                opts: [],
            },
        },
    });

    // ─── Если я тебя не сберегу ───
    add({
        id: "cp_tk_death",
        group: null,
        label: () => "Если я тебя не сберегу",
        hint: () => "Что он просит сделать с его телом.",
        show: ctx => !!cpOf(ctx),
        need: ctx => {
            try { return Number(global.TFG_RELATIONS.opinion(ctx.player, cpOf(ctx).v, cpOf(ctx).s)) >= 15 } catch (e) { return false }
        },
        start: "a",
        steps: {
            a: {
                say: ["Разговор нужный, и я рад, что ты спросил сам.",
                      "Лягу - сожги или зарой. До третьего дня. Больше ничего не надо."],
                ask: "Почему так строго?",
                opts: [
                    { label: "Почему до третьего дня?", go: "why" },
                    { label: "А если не успею?", go: "fail" },
                    { label: "Сделаю.", do: ctx => { try { global.TFG_RELATIONS.note(cpOf(ctx).v, ctx.player, cpOf(ctx).s.id, 3, "обещал упокоить") } catch (e) { } }, go: "promise" },
                ],
            },
            why: {
                say: ["Брошенное тело истлеет само, и душа отделится не так, как надо. Такая возвращается тварью.",
                      "И выйдет она не на чужих, а на тебя - ты ведь рядом будешь."],
                ask: "Ещё?",
                opts: [
                    { label: "А если не успею?", go: "fail" },
                    { label: "Сделаю.", do: ctx => { try { global.TFG_RELATIONS.note(cpOf(ctx).v, ctx.player, cpOf(ctx).s.id, 3, "обещал упокоить") } catch (e) { } }, go: "promise" },
                ],
            },
            fail: {
                say: ctx => cpOathed(ctx)
                    ? ["Тогда плохо, но не до конца. У нас с тобой клятва, а связь держит: меня хоть помянут.",
                       "Говорят, у кого связей много, того иногда и возвращают. Я на это не рассчитываю, но знать приятно."]
                    : ["Тогда совсем плохо. Ни узла, ни обряда - и никто меня не достанет.",
                       "Так что либо приходи за телом, либо давай клясться."],
                opts: [],
            },
            promise: {
                say: ctx => {
                    var est = "простолюдины";
                    try { est = String(global.TFG_SETTLERS.estateOf(cpOf(ctx).s)) } catch (e) { }
                    if (est === "знать") return ["Положи в камень, если будет камень. Если нет - огонь не хуже.",
                        "И не вздумай оставить меня в поле ради поклажи."];
                    if (est === "военные") return ["Я видел, что выходит из брошенных. Потому и говорю не как трус, а как знающий.",
                        "Руку мне разжимать не придётся - я привычный."];
                    return ["Вот и ладно. Мне больше ничего и не надо.",
                        "Дров-то возьми заранее. Их всегда не хватает именно тогда."];
                },
                opts: [],
            },
        },
    });

    cpLog("цепочки разговоров со спутником зарегистрированы: 4");
})()
