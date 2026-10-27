// priority: 5
"use strict";

/**
 * ФРАКЦИИ: ЯДРО (этап 1 плана «Фракции TerraFirmaGreg»).
 *
 * 1) Матрица отношений. Каждая пара фракций хранит число от -100 (вражда) до +100 (союз).
 *    Матрица симметрична, и СУММА ПО ВСЕМ ПАРАМ ВСЕГДА НОЛЬ: мир в целом нейтрален.
 *    - Сдвиг пары A-B на d раздаёт -d остальным парам. Больше достаётся «врагу моего врага»:
 *      поссорились A и B - A теплеет к врагам B, B - к врагам A.
 *    - Раз в неделю календаря TFC - дрейф: шум с нулевым средним и 5% возврата к характеру.
 *    - После ограничения ±100 среднее вычитается снова, так ноль держится точно.
 * 2) Репутация команды FTB Teams у каждой фракции (-100..+100). В нулевую сумму не входит,
 *    но расходится по матрице: +d у F даёт d * R(F,G)/100 * FAC_REP_SPREAD у каждой G.
 *    Игрок без команды FTB считается командой из одного себя.
 *
 * Названия и характеры - заготовки, нарратив подставит автор сборки.
 * Хранение - данные сервера (server.persistentData), ключи tfg_fac_*.
 * Отдаёт наружу global.TFG_FACTIONS (для визитов, рейдов, заданий следующих этапов).
 */

const FAC_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
const FAC_FTBTeams = Java.loadClass("dev.ftb.mods.ftbteams.api.FTBTeamsAPI")

// Цвета фракций вместо скинов (на первое время): одежда NPC красится в цвет фракции, имя - тем же цветом.
// Эти же цвета выбирают фракции игроков (factions/settlements.js).
global.TFG_FACTION_COLORS = [
    { id: "blue", name: "синий", chat: "§9", text: "blue", hex: 0x3C44AA, wool: "minecraft:blue_wool", banner: "minecraft:blue_banner" },
    { id: "red", name: "красный", chat: "§c", text: "red", hex: 0xB02E26, wool: "minecraft:red_wool", banner: "minecraft:red_banner" },
    { id: "yellow", name: "жёлтый", chat: "§e", text: "yellow", hex: 0xFED83D, wool: "minecraft:yellow_wool", banner: "minecraft:yellow_banner" },
    { id: "green", name: "зелёный", chat: "§2", text: "dark_green", hex: 0x5E7C16, wool: "minecraft:green_wool", banner: "minecraft:green_banner" },
    { id: "orange", name: "оранжевый", chat: "§6", text: "gold", hex: 0xF9801D, wool: "minecraft:orange_wool", banner: "minecraft:orange_banner" },
    { id: "purple", name: "фиолетовый", chat: "§5", text: "dark_purple", hex: 0x8932B8, wool: "minecraft:purple_wool", banner: "minecraft:purple_banner" },
    { id: "cyan", name: "бирюзовый", chat: "§3", text: "dark_aqua", hex: 0x169C9C, wool: "minecraft:cyan_wool", banner: "minecraft:cyan_banner" },
    { id: "light_blue", name: "голубой", chat: "§b", text: "aqua", hex: 0x3AB3DA, wool: "minecraft:light_blue_wool", banner: "minecraft:light_blue_banner" },
    { id: "lime", name: "салатовый", chat: "§a", text: "green", hex: 0x80C71F, wool: "minecraft:lime_wool", banner: "minecraft:lime_banner" },
    { id: "magenta", name: "пурпурный", chat: "§d", text: "light_purple", hex: 0xC74EBD, wool: "minecraft:magenta_wool", banner: "minecraft:magenta_banner" },
    { id: "white", name: "белый", chat: "§f", text: "white", hex: 0xF9FFFE, wool: "minecraft:white_wool", banner: "minecraft:white_banner" },
    { id: "black", name: "чёрный", chat: "§8", text: "dark_gray", hex: 0x1D1D21, wool: "minecraft:black_wool", banner: "minecraft:black_banner" },
]

/**
 * Фракции мира (названия и характеры - от пользователя, 2026-09-18).
 * Мир суров: поселения разобщены, союзы шатки, всюду упадок и редкие оплоты цивилизации.
 *  - Торговцы ветром: летающие торговцы, механики, авиаконструкторы, укротители тварей; ценят синюю сталь и чёрную бронзу;
 *  - Эшлендеры: скотоводы, шахтёры и оружейники, караваны вьючного скота;
 *  - Марвины: аптекари, мясники и ремесленники; по слухам, живут работорговлей и дурманом;
 *  - Альянс: рыцарский орден, свет и порядок, враг работорговцев.
 * lore - короткая строка для слухов и разговоров (factions/guests.js).
 */
const FAC_LIST = [
    { id: "bandits", name: "Разбойники", dye: "black", color: "§8", lore: "сброд с большой дороги" },
    { id: "wind", name: "Торговцы ветром", dye: "blue", color: "§9", lore: "летают и торгуют" },
    { id: "ash", name: "Эшлендеры", dye: "yellow", color: "§e", lore: "скот, руда и оружие" },
    { id: "marvins", name: "Марвины", dye: "red", color: "§c", lore: "аптеки, мясо и тёмные дела" },
    { id: "alliance", name: "Альянс", dye: "white", color: "§f", lore: "рыцари и порядок" },
]

/**
 * ЧЕГО ХОЧЕТ КАЖДАЯ ФРАКЦИЯ. Это не общая матрица, ачетыре разных взгляда на мир: каждый
 * держит в голове своё «как должно быть». Там, где взгляды расходятся (Эшлендеры хотят
 * -55 с Марвинами, а Марвины всего -40), возникает натяжение - именно оно и рождает
 * события: чья-то сторона тянет отношения к своему числу.
 *
 *   Марвины      - лёгкая неприязнь ко всем: -40 Эшлендеры, -20 Ветер, 0 Альянс.
 *   Альянс       - нейтралитет: -10 Эшлендеры, +10 Ветер, +10 Марвины.
 *   Ветер        - дружелюбие: +10 Марвины, +40 Эшлендеры, +50 Альянс.
 *   Эшлендеры    - поляризованы: -55 Марвины, 0 Ветер, +20 Альянс.
 */
const FAC_WISH = {
    marvins: { ash: -40, wind: -20, alliance: 0 },
    alliance: { ash: -10, wind: 10, marvins: 10 },
    wind: { marvins: 10, ash: 40, alliance: 50 },
    ash: { marvins: -55, wind: 0, alliance: 20 },
}

/** К чему пара придёт, если никто не вмешается: середина между желаниями сторон. */
function facWishPair(key) {
    var parts = String(key).split("|")
    var a = parts[0], b = parts[1]
    if (a === "bandits" || b === "bandits") return FAC_BANDIT_REL
    var wa = FAC_WISH[a] && FAC_WISH[a][b]
    var wb = FAC_WISH[b] && FAC_WISH[b][a]
    if (wa === undefined && wb === undefined) return 0
    if (wa === undefined) return wb
    if (wb === undefined) return wa
    return (wa + wb) / 2
}

/** Насколько стороны расходятся во взглядах на эту пару: отсюда берутся события. */
function facTension(key) {
    var parts = String(key).split("|")
    var wa = FAC_WISH[parts[0]] && FAC_WISH[parts[0]][parts[1]]
    var wb = FAC_WISH[parts[1]] && FAC_WISH[parts[1]][parts[0]]
    if (wa === undefined || wb === undefined) return 0
    return Math.abs(wa - wb)
}

// прежнее имя оставлено: им пользуются старые куски кода
const FAC_TEMPERAMENT = {
    "bandits|wind": -100, "bandits|ash": -100, "bandits|marvins": -100, "bandits|alliance": -100,
    "wind|ash": facWishPair("wind|ash"), "wind|marvins": facWishPair("wind|marvins"),
    "wind|alliance": facWishPair("wind|alliance"), "ash|marvins": facWishPair("ash|marvins"),
    "ash|alliance": facWishPair("ash|alliance"), "marvins|alliance": facWishPair("marvins|alliance"),
}

const FAC_BANDIT_REL = -100         // отношения любой фракции с разбойниками, всегда
const FAC_SPREAD_ALLY = 0.45        // какая доля события достаётся союзникам и врагам участников
const FAC_BANDIT_DAMP = 0.03        // стычка с разбойниками стягивает всю матрицу к нейтралитету

const FAC_DRIFT_DAYS = 7            // дрейф раз в неделю календаря TFC
// Дрейф намеренно медленный: отношения должны меняться от дел, а не сами собой.
const FAC_DRIFT_NOISE = 1.2         // шум дрейфа ±1.2 (было ±3)
const FAC_DRIFT_PULL = 0.02         // возврат к желаемому за неделю (было 0.05)
const FAC_SNAP_AT = 25              // отклонение, после которого система сама тянет назад
const FAC_SNAP_PULL = 0.12          // и с какой силой тянет
const FAC_ENEMY_WEIGHT = 2          // сколько лишнего веса «врагу моего врага» при раздаче сдвига
const FAC_REP_SPREAD = 0.5          // доля репутации, расходящаяся по матрице
const FAC_KILL_BANDIT_REP = -1      // рейдер убит игроком: репутация у разбойников

var FAC_SERVER = null
var FAC_REL = null                  // "a|b" -> число, в памяти; пишется в данные сервера при каждом изменении

function facLog(msg) { global.tfgLog("tfg factions", msg) }
function facErr(msg, e) { global.tfgLogError("tfg factions", msg, e) }

function facById(id) {
    for (var i = 0; i < FAC_LIST.length; i++) if (FAC_LIST[i].id === id) return FAC_LIST[i]
    return null
}

/** Ключ пары в порядке FAC_LIST: "bandits|faction_1", а не наоборот. */
function facPair(a, b) {
    var ia = FAC_LIST.indexOf(facById(a))
    var ib = FAC_LIST.indexOf(facById(b))
    return ia < ib ? a + "|" + b : b + "|" + a
}

function facPairs() {
    var out = []
    for (var i = 0; i < FAC_LIST.length; i++)
        for (var j = i + 1; j < FAC_LIST.length; j++) out.push(FAC_LIST[i].id + "|" + FAC_LIST[j].id)
    return out
}

/** Пара с разбойниками: она закреплена и в балансе не участвует. */
function facIsBanditPair(p) { return p.indexOf("bandits") >= 0 }

/** Пары, по которым держится нулевая сумма (все, кроме разбойничьих). */
function facFreePairs() { return facPairs().filter(p => !facIsBanditPair(p)) }

function facClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ─── Матрица ─────────────────────────────────────────────────────────────────

function facLoad() {
    if (FAC_REL) return FAC_REL
    var pd = FAC_SERVER.persistentData
    FAC_REL = {}
    facPairs().forEach(p => {
        var key = "tfg_fac_rel_" + p
        FAC_REL[p] = pd.contains(key) ? Number(pd.getDouble(key)) : FAC_TEMPERAMENT[p]
    })
    facNormalize()
    return FAC_REL
}

function facSave() {
    var pd = FAC_SERVER.persistentData
    for (var p in FAC_REL) pd.putDouble("tfg_fac_rel_" + p, FAC_REL[p])
}

/** Ограничить ±100 и вернуть сумму к нулю; повтор, потому что ограничение снова сдвигает среднее. */
function facNormalize() {
    facPairs().forEach(p => { if (facIsBanditPair(p)) FAC_REL[p] = FAC_BANDIT_REL })
    var pairs = facFreePairs()
    for (var k = 0; k < 20; k++) {
        var sum = 0
        pairs.forEach(p => { FAC_REL[p] = facClamp(FAC_REL[p], -100, 100); sum += FAC_REL[p] })
        if (Math.abs(sum) < 1e-9) return
        pairs.forEach(p => { FAC_REL[p] -= sum / pairs.length })
    }
}

function facRelation(a, b) {
    if (a === b) return 100
    return facLoad()[facPair(a, b)]
}

/**
 * Сдвинуть отношения пары A-B на d; остальные пары вместе получают -d.
 * Вес пары (A,C) растёт, если C - враг B; вес (B,C) - если C - враг A.
 */
function facShiftPair(a, b, d, reason) {
    d = Number(d)
    var rel = facLoad()
    var main = facPair(a, b)
    var weights = {}
    var total = 0
    facPairs().forEach(p => {
        if (p === main) return
        var parts = p.split("|")
        var w = 1
        var other = null
        if (parts.indexOf(a) >= 0) other = { me: a, them: b, c: parts[0] === a ? parts[1] : parts[0] }
        else if (parts.indexOf(b) >= 0) other = { me: b, them: a, c: parts[0] === b ? parts[1] : parts[0] }
        if (other) w += FAC_ENEMY_WEIGHT * Math.max(0, -rel[facPair(other.them, other.c)]) / 100
        weights[p] = w
        total += w
    })
    rel[main] += d
    for (var p in weights) rel[p] -= d * weights[p] / total
    facNormalize()
    facSave()
    facLog("отношения " + main + " " + (d > 0 ? "+" : "") + d.toFixed(1) + " (" + reason + ") -> " + rel[main].toFixed(1))
}

/**
 * Событие между A и B со сдвигом d: союзники участника разделяют его чувства, враги - наоборот.
 * Подрались A и B: союзники A холодеют к B (тем сильнее, чем крепче союз), враги A теплеют к B.
 * Пары с разбойниками не трогаем, нулевую сумму восстанавливает facNormalize.
 */
function facSpreadEvent(a, b, d, reason) {
    d = Number(d)
    if (a === "bandits" || b === "bandits") return facBanditClash(Math.abs(d) / 30, reason)
    var rel = facLoad()
    var main = facPair(a, b)
    rel[main] += d
    FAC_LIST.forEach(f => {
        var c = f.id
        if (c === a || c === b || c === "bandits") return
        // насколько C с кем-то из участников заодно: +1 союз, -1 вражда
        var withA = facRelation(a, c) / 100
        var withB = facRelation(b, c) / 100
        rel[facPair(c, b)] += d * withA * FAC_SPREAD_ALLY
        rel[facPair(c, a)] += d * withB * FAC_SPREAD_ALLY
    })
    facNormalize()
    facSave()
    var text = "отношения " + main + " " + (d > 0 ? "+" : "") + d.toFixed(1) + " (" + reason + ") -> " + rel[main].toFixed(1)
    facLog(text)
    return text
}

/** Стычка с разбойниками: общий враг стягивает матрицу к нейтралитету (сумма остаётся нулевой). */
function facBanditClash(strength, reason) {
    var rel = facLoad()
    var k = facClamp(Number(strength) * FAC_BANDIT_DAMP, 0, 0.25)
    facFreePairs().forEach(p => { rel[p] *= (1 - k) })
    facNormalize()
    facSave()
    var text = "общий враг сближает: вся матрица к нейтралитету на " + Math.round(k * 100) + "% (" + reason + ")"
    facLog(text)
    return text
}

/** Недельный дрейф: шум с нулевым средним + возврат к характеру. */
/**
 * Недельный дрейф. Три силы: слабый шум, постоянная тяга к желаемому и отдельная
 * возвращающая тяга, которая включается только при большом отклонении - так система
 * сама гасит перекосы вместо того, чтобы застревать в войне или во всеобщей любви.
 * Каждый заметный сдвиг записывается событием в ближайшие поселения обеих сторон.
 */
function facDrift() {
    var rel = facLoad()
    var pairs = facFreePairs()
    var noise = pairs.map(() => (Math.random() * 2 - 1) * FAC_DRIFT_NOISE)
    var mean = noise.reduce((s, n) => s + n, 0) / noise.length
    var snapped = []
    pairs.forEach((p, i) => {
        var want = facWishPair(p)
        var before = rel[p]
        rel[p] += noise[i] - mean
        rel[p] += (want - rel[p]) * FAC_DRIFT_PULL
        var off = rel[p] - want
        if (Math.abs(off) > FAC_SNAP_AT) {
            rel[p] -= off * FAC_SNAP_PULL
            snapped.push({ pair: p, off: off, before: before, after: rel[p], want: want })
        }
    })
    facNormalize()
    facSave()
    snapped.forEach(s => facStabilise(s))
    facLog("дрейф отношений: " + pairs.map(p => p + " " + rel[p].toFixed(1) +
        " (хотят " + facWishPair(p).toFixed(0) + ")").join(", "))
}

// Что случилось, когда система потянула отношения обратно. Событие ложится в записи
// ближайших поселений обеих сторон - в чат ничего не пишется.
const FAC_SNAP_UP = ["обменялись пленными", "договорились о проходе караванов", "разошлись без крови",
    "выдали зачинщиков драки", "вернули отбитый скот", "заключили перемирие на месяц"]
const FAC_SNAP_DOWN = ["не поделили брод", "перехватили чужой караван", "переругались на торгу",
    "выставили заставу на спорной меже", "обвинили в краже руды", "отказали в помощи"]

function facStabilise(s) {
    var parts = String(s.pair).split("|")
    var text = (s.off > 0 ? FAC_SNAP_DOWN : FAC_SNAP_UP)[Math.floor(Math.random() * FAC_SNAP_UP.length)]
    try {
        global.TFG_WORLD.factionEvent(parts[0], "отношения", facName(parts[0]) + " и " + facName(parts[1]) + ": " + text)
        global.TFG_WORLD.factionEvent(parts[1], "отношения", facName(parts[1]) + " и " + facName(parts[0]) + ": " + text)
    } catch (e) { }
    facLog("выравнивание " + s.pair + ": " + s.before.toFixed(1) + " -> " + s.after.toFixed(1) +
        " (желаемое " + s.want.toFixed(0) + ") - " + text)
}

function facName(id) {
    var f = facById(id)
    return f ? f.name : id
}

// ─── Репутация команд ────────────────────────────────────────────────────────

/** Кто копит репутацию: фракция игрока (factions/settlements.js), иначе команда FTB Teams, иначе сам игрок. */
function facTeamOf(player) {
    try {
        var pf = global.TFG_SETTLEMENTS ? global.TFG_SETTLEMENTS.factionOf(player) : null
        if (pf) return { key: "pf_" + pf.id, name: pf.name }
    } catch (e) {
        facErr("фракция игрока " + player.username, e)
    }
    try {
        var api = FAC_FTBTeams.api()
        if (api.isManagerLoaded()) {
            var team = api.getManager().getTeamForPlayer(player)
            if (team.isPresent()) {
                var t = team.get()
                return { key: String(t.getId()).replace(/-/g, ""), name: String(t.getShortName()) }
            }
        }
    } catch (e) {
        facErr("команда FTB для " + player.username, e)
    }
    return { key: String(player.uuid).replace(/-/g, ""), name: String(player.username) }
}

function facRepKey(teamKey, faction) { return "tfg_fac_rep_" + teamKey + "_" + faction }

function facRep(teamKey, faction) {
    var pd = FAC_SERVER.persistentData
    var k = facRepKey(teamKey, faction)
    return pd.contains(k) ? Number(pd.getDouble(k)) : 0
}

/** Изменить репутацию команды у фракции; доля изменения расходится по матрице на остальные фракции. */
function facAddRep(player, faction, d, reason) {
    d = Number(d)
    var team = facTeamOf(player)
    var pd = FAC_SERVER.persistentData
    var changes = []
    FAC_LIST.forEach(f => {
        var delta = f.id === faction ? d : d * facRelation(faction, f.id) / 100 * FAC_REP_SPREAD
        if (Math.abs(delta) < 1e-6) return
        var v = facClamp(facRep(team.key, f.id) + delta, -100, 100)
        pd.putDouble(facRepKey(team.key, f.id), v)
        changes.push(f.id + " " + (delta > 0 ? "+" : "") + delta.toFixed(2))
    })
    facLog("репутация команды " + team.name + ": " + changes.join(", ") + " (" + reason + ")")
}

global.TFG_FACTIONS = {
    list: FAC_LIST,
    relation: (a, b) => facRelation(a, b),
    shiftPair: (a, b, d, reason) => facShiftPair(a, b, d, reason || "скрипт"),
    event: (a, b, d, reason) => facSpreadEvent(a, b, d, reason || "событие"),
    banditClash: (strength, reason) => facBanditClash(strength, reason || "схватка с разбойниками"),
    pairs: () => facFreePairs(),
    wish: (a, b) => facWishPair(facPair(a, b)),
    tension: (a, b) => facTension(facPair(a, b)),
    drift: () => facDrift(),
    teamOf: player => facTeamOf(player),
    rep: (player, faction) => facRep(facTeamOf(player).key, faction),
    addRep: (player, faction, d, reason) => facAddRep(player, faction, d, reason || "скрипт"),
}

// ─── Тик: дрейф по календарю ─────────────────────────────────────────────────

ServerEvents.tick(event => {
    if (!FAC_SERVER) FAC_SERVER = event.server
    if (event.server.tickCount % 200 !== 0) return
    try {
        var today = Number(FAC_Calendars.SERVER.getTotalCalendarDays())
        if (!isFinite(today)) return
        var pd = event.server.persistentData
        if (!pd.contains("tfg_fac_drift_day")) {
            pd.putLong("tfg_fac_drift_day", today)
            return
        }
        if (today - Number(pd.getLong("tfg_fac_drift_day")) < FAC_DRIFT_DAYS) return
        pd.putLong("tfg_fac_drift_day", today)
        facDrift()
    } catch (e) {
        facErr("недельный дрейф", e)
    }
})

// ─── Событие: рейдер убит игроком ────────────────────────────────────────────

EntityEvents.death(event => {
    var e = event.entity
    try {
        var tags = e.getTags()
        if (!tags.contains("tfg_bandit") && !tags.contains("tfg_raid")) return
        var player = event.source.player
        if (!player || !FAC_SERVER) return
        facAddRep(player, "bandits", FAC_KILL_BANDIT_REP, "убит рейдер")
    } catch (err) {
        facErr("смерть рейдера", err)
    }
})

// ─── Команды: /tfgfaction ... ────────────────────────────────────────────────

function facFmt(v) {
    var s = (v > 0 ? "+" : "") + v.toFixed(0)
    return (v >= 20 ? "§a" : v <= -20 ? "§c" : "§7") + s + "§r"
}

function facMatrixText() {
    var rel = facLoad()
    var lines = ["§lОтношения фракций§r (сумма без разбойников " + facFreePairs().reduce((s, p) => s + rel[p], 0).toFixed(3) + ")"]
    FAC_LIST.forEach(a => {
        lines.push(a.color + a.name + "§r: " + FAC_LIST.filter(b => b.id !== a.id)
            .map(b => b.name + " " + facFmt(facRelation(a.id, b.id))).join(", "))
    })
    return lines.join("\n")
}

function facRepText(player) {
    var team = facTeamOf(player)
    return "§lРепутация команды " + team.name + "§r\n" +
        FAC_LIST.map(f => f.color + f.name + "§r: " + facFmt(facRep(team.key, f.id))).join("\n")
}

ServerEvents.commandRegistry(event => {
  try {
      var Commands = event.commands
      var Arguments = event.arguments
      var say = (ctx, msg) => ctx.source.sendSuccess(Text.of(msg), false)
      var guard = (ctx, fn) => {
          try {
              if (!FAC_SERVER) FAC_SERVER = ctx.source.getServer()
              fn()
          } catch (e) {
              ctx.source.sendFailure(Text.of("Ошибка /tfgfaction: " + String(e).substring(0, 300)))
          }
          return 1
      }

      var shift = Commands.literal("shift")
      FAC_LIST.forEach(a => {
          var nodeA = Commands.literal(a.id)
          FAC_LIST.filter(b => b.id !== a.id).forEach(b => {
              nodeA.then(Commands.literal(b.id).then(Commands.argument("delta", Arguments.INTEGER.create(event))
                  .executes(ctx => guard(ctx, () => {
                      facShiftPair(a.id, b.id, Arguments.INTEGER.getResult(ctx, "delta"), "команда")
                      say(ctx, facMatrixText())
                  }))))
          })
          shift.then(nodeA)
      })

      var repAdd = Commands.literal("add")
      FAC_LIST.forEach(f => {
          repAdd.then(Commands.literal(f.id).then(Commands.argument("delta", Arguments.INTEGER.create(event))
              .executes(ctx => guard(ctx, () => {
                  var player = ctx.source.getPlayerOrException()
                  facAddRep(player, f.id, Arguments.INTEGER.getResult(ctx, "delta"), "команда")
                  say(ctx, facRepText(player))
              }))))
      })

      event.register(Commands.literal("tfgfaction").requires(src => src.hasPermission(2))
          .then(Commands.literal("matrix").executes(ctx => guard(ctx, () => say(ctx, facMatrixText()))))
          .then(shift)
          .then(Commands.literal("drift").executes(ctx => guard(ctx, () => {
              facDrift()
              say(ctx, facMatrixText())
          })))
          .then(Commands.literal("reset").executes(ctx => guard(ctx, () => {
              FAC_REL = {}
              facPairs().forEach(p => { FAC_REL[p] = FAC_TEMPERAMENT[p] })
              facSave()
              say(ctx, "Отношения сброшены к характеру.\n" + facMatrixText())
          })))
          .then(Commands.literal("rep")
              .executes(ctx => guard(ctx, () => say(ctx, facRepText(ctx.source.getPlayerOrException()))))
              .then(repAdd)))
  } catch (err) {
    console.error("[core] ошибка регистрации команд: " + err)
  }
})
