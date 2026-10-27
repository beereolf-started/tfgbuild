"use strict";
/**
 * ОСАДЫ: нападения на поселения - настоящие, а не строчкой в летописи.
 *
 * Кто нападает. Разбойники - на любое поселение (SG_BANDIT_DAY в сутки). Враждебная фракция -
 * та, с кем у хозяев поселения отношения ниже SG_ENEMY_REL, чем хуже, тем вероятнее:
 * без игрока SG_ENEMY_DAY в сутки, а если игрок в поселении - SG_ENEMY_PRESENT_DAY (30%).
 * Кубик бросается раз в игровой час, чтобы нападение не приходило ровно на рассвете.
 *
 * Как решается. Игрок рядом - налёт настоящий: отряд выходит к поселению со стороны
 * своего дома, стража и дружина обороняются как обычно. Заранее бросается замысел:
 * в 20% случаев отряд идёт взять поселение (он крупнее гарнизона), в 80% - налёт,
 * который гарнизон должен сдержать. Дальше решает бой: отряд бежит, потеряв 60%,
 * поселение сдаётся, потеряв 65% гарнизона (или правителя и половину стражи - старое
 * правило settlers.js). Вмешательство игрока меняет исход в обе стороны.
 * Игрока нет - исход бросается сразу: 20% захват, 80% отбились.
 *
 * Что после. Разбойники при удаче минуту грабят (лавки пустеют до пополнения) и уходят.
 * Фракция при удаче сутки держит поселение, потом оно переходит к ней: прежние жители
 * уходят, на их койки приходят новые - те же ремёсла, другие люди и цвета.
 * Отбились - кто из игроков помог, тому правитель должен награду (одна на фракцию
 * игрока за каждую оборону): подойти к правителю и нажать на него.
 *
 * Всё, что случилось, ложится в летопись поселения (factions/world.js) и расходится
 * молвой (factions/lore.js).
 */

const SG_BANDIT_DAY = 0.05           // разбойники приходят к поселению раз в ~20 дней
const SG_ENEMY_DAY = 0.04            // враждебная фракция, пока игрока нет
const SG_ENEMY_PRESENT_DAY = 0.30    // и пока игрок в поселении
const SG_ENEMY_REL = -20             // ниже этого отношения фракция считается враждебной
const SG_CAPTURE_SHARE = 0.2         // столько налётов задумано как захват
const SG_NEAR = 256                  // игрок ближе - налёт идёт по-настоящему
const SG_IN = 128                    // игрок ближе - он в поселении
const SG_MAX_TICKS = 9000            // бой дольше семи с половиной минут решается по потерям
const SG_FLEE_AT = 0.4               // отряд бежит, когда в строю осталось столько
const SG_FALL_AT = 0.35              // поселение сдаётся, когда от гарнизона осталось столько
const SG_OWNER_DELAY = 24000         // сутки чужого гарнизона - и поселение переходит к нему
const SG_LOOT_TICKS = 1200           // разбойники грабят минуту
const SG_LEAVE_TICKS = 1800          // отходящих, кого за это время не увели, убираем
const SG_REWARD_UNIT = 30            // награда: медяков за каждого бойца отряда на тир
const SG_REPLACE_DAYS = 3            // раз в столько дней без игрока погибших сменяют новые
const SG_GUNNER_SHARE = 0.3          // доля стрелков у разбойников

var SG_SERVER = null
var SG_DATA = null
var SG_LAST_HOUR = -1

function sgLog(t) { try { console.log("[осады] " + t) } catch (e) { } }
function sgErr(w, e) { try { console.error("[осады] " + w + ": " + e) } catch (err) { } }
function sgRun(cmd) { try { return Number(SG_SERVER.runCommandSilent(cmd)) } catch (e) { sgErr("команда", e); return 0 } }
function sgNow() { try { return Number(SG_SERVER.overworld().getTime()) } catch (e) { return 0 } }
function sgDay() { try { return global.TFG_WORLD.day() } catch (e) { return Math.floor(sgNow() / 24000) } }

function sgLoad() {
    if (SG_DATA) return SG_DATA
    try { SG_DATA = JSON.parse(global.TFG_STORE.read(SG_SERVER.persistentData, "tfg_sieges") || "{}") }
    catch (e) { SG_DATA = {}; sgErr("чтение", e) }
    if (!SG_DATA.active) SG_DATA.active = {}
    if (!SG_DATA.lastDay) SG_DATA.lastDay = {}
    if (!SG_DATA.rewards) SG_DATA.rewards = {}
    return SG_DATA
}

function sgSave() {
    if (!SG_SERVER || !SG_DATA) return
    var bad = global.TFG_STORE.write(SG_SERVER.persistentData, "tfg_sieges", JSON.stringify(SG_DATA))
    if (bad) sgErr("запись", bad)
}

/** Шанс за час из шанса за сутки. */
function sgHourly(pDay) { return 1 - Math.pow(1 - pDay, 1 / 24) }

function sgFacName(id) {
    if (id === "bandits") return "разбойники"
    try { return String(trFaction(id).name) } catch (e) { return id }
}

/** Запись мира, в которой стоит поселение. */
function sgSiteOf(v) {
    try {
        var all = global.TFG_WORLD.all()
        for (var id in all) if (all[id].village === v.id) return all[id]
    } catch (e) { }
    return null
}

function sgEvent(v, kind, text, extra) {
    var site = sgSiteOf(v)
    if (!site) return
    try { global.TFG_WORLD.event(site, kind, text, extra); global.TFG_WORLD.save() } catch (e) { sgErr("летопись", e) }
}

function sgName(v) {
    var site = sgSiteOf(v)
    return site ? site.name : v.id
}

function sgPlayers(v, r) {
    var out = []
    try {
        SG_SERVER.players.forEach(p => {
            if (String(p.level.getDimension()) !== v.dim) return
            var dx = p.getX() - v.x, dz = p.getZ() - v.z
            if (dx * dx + dz * dz < r * r) out.push(p)
        })
    } catch (e) { }
    return out
}

function sgTell(players, text) {
    players.forEach(p => { try { p.tell(Text.of(text)) } catch (e) { } })
}

/** Враг хозяев поселения: чем хуже отношения, тем вероятнее именно он. null - врагов нет. */
function sgEnemyOf(factionId) {
    var cand = [], total = 0
    try {
        global.TFG_FACTIONS.list.forEach(f => {
            if (f.id === "bandits" || f.id === factionId) return
            var rel = Number(global.TFG_FACTIONS.relation(factionId, f.id))
            if (rel >= SG_ENEMY_REL) return
            cand.push({ id: f.id, w: -rel })
            total += -rel
        })
    } catch (e) { }
    if (!cand.length) return null
    var roll = Math.random() * total
    for (var i = 0; i < cand.length; i++) {
        roll -= cand[i].w
        if (roll <= 0) return cand[i].id
    }
    return cand[cand.length - 1].id
}

function sgActiveFor(vid) {
    var act = sgLoad().active
    for (var id in act) if (act[id].vid === vid) return act[id]
    return null
}

// ─── Отряд ───────────────────────────────────────────────────────────────────

/** Разбойник: экипировку, скин и голос по тиру выдаёт primitive_creatures/bandit_roles.js. */
function sgBanditNbt(rec, tier) {
    var pool = null
    try { pool = entityPoolForTier(tier) } catch (e) { }
    if (!pool || !pool.length) pool = global.TFG_BANDIT_WEAK_BASE || ["primitive_creatures:iloger"]
    var ent = pool[Math.floor(Math.random() * pool.length)]
    var gunner = Math.random() < SG_GUNNER_SHARE
    // роль - как у налёта /tfgraid: по тиру игрока и сложности (bandit_roles.js), а не по таблице тиров
    return "{PersistenceRequired:1b,Tags:[\"tfg_npc\",\"tfg_raider\",\"tfg_siege\",\"tfg_siege_" + rec.id + "\"," +
        "\"tfg_bandit\",\"tfg_bandit_type:" + ent + "\",\"tfg_raid_tier:" + tier + "\"," +
        "\"tfg_raid_ptier:" + (rec.ptier || tier) + "\",\"tfg_raid_diff:100\"," +
        "\"tfg_raid_kind:" + (gunner ? "gunner" : "melee") + "\"]}"
}

/** Боец фракции: тот же облик, что у стражи гостей, только имя и метки налётчика. */
function sgFighterNbt(rec, index) {
    var faction = trFaction(rec.by)
    var color = trColor(faction)
    var m = gsMetal(rec.tier)
    var role = gsPickRole(index, rec.tier)
    var main = gsItem(role.main(m)) || gsItem("tfc:metal/javelin/" + m) || "tfc:metal/javelin/copper"
    var off = gsItem(role.off(m))
    var piece = (kind) => gsItem("tfc:metal/" + kind + "/" + m) ? '{id:"tfc:metal/' + kind + '/' + m + '",Count:1b}' : "{}"
    var name = JSON.stringify(JSON.stringify({ text: "Налётчик · " + faction.name, color: color.text }))
    var hp = 20 + 4 * rec.tier
    return "{Tags:[\"tfg_npc\",\"tfg_raider\",\"tfg_siege\",\"tfg_siege_" + rec.id + "\",\"tfg_faction:" + faction.id + "\"]," +
        "PersistenceRequired:1b,CanPickUpLoot:0b,CustomName:" + name + ",Health:" + hp + "f," +
        "Attributes:[{Name:\"minecraft:generic.max_health\",Base:" + hp + "d},{Name:\"minecraft:generic.follow_range\",Base:64d}," +
        "{Name:\"minecraft:zombie.spawn_reinforcements\",Base:0d}]," +
        "ArmorItems:[" + piece("boots") + "," + piece("greaves") + "," + trLeather("leather_chestplate", color.hex) + "," + piece("helmet") + "]," +
        "ArmorDropChances:[0f,0f,0f,0f],HandItems:[{id:\"" + main + "\",Count:1b}," + (off ? "{id:\"" + off + "\",Count:1b}" : "{}") + "]," +
        "HandDropChances:[0f,0f]}"
}

/** Сколько бойцов вести: налёт - меньше гарнизона, захват - заметно больше. */
function sgSquadSize(garrison, plan) {
    var n = plan === "захват" ? Math.round(1.7 * garrison) + 2 : Math.round(0.8 * garrison) + 1
    return Math.max(plan === "захват" ? 5 : 3, Math.min(plan === "захват" ? 16 : 12, n))
}

/**
 * Начать настоящий налёт на поселение v. by - id фракции или "bandits".
 * plan - "захват" или "налёт" (иначе бросается). Текст ошибки или null.
 */
function sgStart(level, v, by, plan) {
    if (sgActiveFor(v.id)) return sgName(v) + " уже в осаде"
    if (!v.spawned) return sgName(v) + " ещё не заселено"
    if (v.state === "сдалось") return sgName(v) + " уже сдалось"
    if (by === v.faction) return sgName(v) + " - поселение самой фракции «" + sgFacName(by) + "»: своих не грабят"
    var near = sgPlayers(v, SG_NEAR)
    var ptier = 1
    near.forEach(p => { try { ptier = Math.max(ptier, Number(global.TFG_PLAYER_TIER(p)) || 1) } catch (e) { } })
    if (!plan) plan = Math.random() < SG_CAPTURE_SHARE ? "захват" : "налёт"
    var garrison = Math.max(1, seGarrison(v))
    var size = sgSquadSize(garrison, plan)
    var tier = by === "bandits" ? Math.max(1, Math.min(5, ptier)) : Math.max(2, Math.min(7, ptier))
    // Фракция приходит со стороны своего ближайшего поселения, разбойники - откуда угодно
    var ang = Math.random() * 6.283185307179586
    if (by !== "bandits") {
        try {
            var home = global.TFG_LORE.origin(level, by, v.x, v.z)
            if (home) ang = Math.atan2(home.z - v.z, home.x - v.x)
        } catch (e) { }
    }
    var id = "s" + sgNow() + "_" + Math.floor(Math.random() * 1000)
    var rec = {
        id: id, vid: v.id, by: by, plan: plan, tier: tier, dim: v.dim, x: v.x, z: v.z, ang: ang,
        start: 0, killed: 0, garrison0: garrison, at: sgNow(), stage: "идёт", endAt: 0,
        helpers: {}, foes: {}, seen: 0, ptier: ptier,
    }
    // Налёт - настоящий рейд (tfg/raids.js, тот же, что /tfgraid на базу игрока): те же роли,
    // снаряжение, боевой мозг и стрельба, только цель - жители этого поселения. Пока бой идёт,
    // бойцов ведёт рейд; осада следит за потерями и исходом. Запись осады должна быть до
    // призыва: рейд по ней понимает, идёт ли ещё бой.
    if (global.TFG_RAID_VILLAGE) {
        rec.raid = true
        sgLoad().active[id] = rec
        var got = 0
        try {
            got = global.TFG_RAID_VILLAGE(level, {
                sid: id, vid: v.id, dim: v.dim, x: v.x, z: v.z, ring: v.ring || 28, ang: ang, size: size,
                ptier: ptier, players: near.map(p => String(p.username)),
            })
        } catch (e) { sgErr("рейд на поселение", e) }
        if (!got) { delete sgLoad().active[id]; return "отряд не вышел: вокруг " + sgName(v) + " не прогружены чанки" }
        rec.start = got
        return sgLaunched(level, v, rec, near, by, plan, got, tier, garrison, ang)
    }
    // запасной путь (рейдов нет): прежний призыв налётчиков
    var n = 0
    var dists = [(v.ring || 28) + 28, (v.ring || 28) + 18, (v.ring || 28) + 8]
    for (var i = 0; i < size; i++) {
        var a = ang + (i - size / 2) * 0.07
        for (var k = 0; k < dists.length; k++) {
            var x = Math.floor(v.x + Math.cos(a) * dists[k]), z = Math.floor(v.z + Math.sin(a) * dists[k])
            var loaded = true
            try { loaded = !!level.hasChunk(x >> 4, z >> 4) } catch (e) { }
            if (!loaded) continue
            var y = 80
            try { y = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", x, z)) } catch (e) { }
            var gsp = null
            try { gsp = global.TFG_GROUND_SPOT(level, x, z, 8) } catch (e) { }
            if (!gsp) continue                                 // кругом крыши - ищем дальше
            x = Math.floor(gsp.x); z = Math.floor(gsp.z); y = gsp.y
            var nbt = by === "bandits" ? sgBanditNbt(rec, tier) : sgFighterNbt(rec, i)
            if (sgRun("execute in " + v.dim + " run summon minecraft:husk " + (x + 0.5) + " " + y + " " + (z + 0.5) + " " + nbt) > 0) n++
            break
        }
    }
    if (!n) return "отряд не вышел: вокруг " + sgName(v) + " не прогружены чанки"
    rec.start = n
    sgLoad().active[id] = rec
    return sgLaunched(level, v, rec, near, by, plan, n, tier, garrison, ang)
}

/** Отряд вышел: запомнить налёт, поднять тревогу, сказать игрокам, откуда идут. */
function sgLaunched(level, v, rec, near, by, plan, n, tier, garrison, ang) {
    sgLoad().lastDay[v.id] = sgDay()
    sgSave()
    try { seAlarm(v, "налёт " + by) } catch (e) { }
    v.raidBy = by
    seSave()
    var side = sgSide(ang)
    sgTell(near, by === "bandits"
        ? "§c[Поселение] §fНа «" + sgName(v) + "» идут разбойники: " + n + " чел., " + side + "."
        : "§c[Поселение] §fНа «" + sgName(v) + "» идут наёмники фракции " + sgFacName(by) + ": " + n + " чел., " + side + ".")
    sgLog(sgName(v) + ": " + by + ", замысел " + plan + ", отряд " + n + " (тир " + tier + "), гарнизон " + garrison +
        (rec.raid ? ", рейдом" : ""))
    return null
}

// ─── Исход ───────────────────────────────────────────────────────────────────

/** Налёт без игрока: исход бросается сразу. */
function sgAbstract(level, v, by) {
    var captured = Math.random() < SG_CAPTURE_SHARE
    sgLoad().lastDay[v.id] = sgDay()
    sgSave()
    sgApply(level, v, by, captured, null)
    sgLog(sgName(v) + ": налёт " + by + " без игрока - " + (captured ? "взяли" : "отбились"))
}

/**
 * Последствия исхода: летопись, отношения, награды, захват. rec - запись настоящего боя
 * (или null для налёта без игрока).
 */
function sgApply(level, v, by, captured, rec) {
    var who = by === "bandits" ? "разбойников" : "фракции «" + sgFacName(by) + "»"
    var helped = rec ? Object.keys(rec.helpers) : []
    var extra = { by: by }
    if (helped.length) extra.helpers = helped.map(k => rec.helpers[k].name)
    if (!captured) {
        sgEvent(v, "налёт", "отбили налёт " + who + (helped.length ? ", помогли чужаки" : ""), extra)
        if (by !== "bandits") { try { global.TFG_FACTIONS.event(v.faction, by, -3, "налёт на поселение") } catch (e) { } }
        else { try { global.TFG_FACTIONS.banditClash(0.3, "поселение отбилось от разбойников") } catch (e) { } }
        if (rec) sgRewards(v, rec)
        return
    }
    if (by === "bandits") {
        sgEvent(v, "налёт", "разбойники разграбили поселение", extra)
        sgSack(level, v)
        return
    }
    sgEvent(v, "захват", "поселение взял отряд фракции «" + sgFacName(by) + "»", extra)
    try { global.TFG_FACTIONS.event(v.faction, by, -8, "поселение захвачено") } catch (e) { }
    if (!rec) sgChangeOwner(level, v, by)             // без игрока - сразу новый хозяин
}

/** Разграбление: лавки пустеют до следующего пополнения. */
function sgSack(level, v) {
    v.sackedDay = sgDay()
    try {
        seEntities(level, v).forEach(e => {
            if (seRoleOf(e) === "торговец") e.persistentData.putString("tfg_trader_offers", "[]")
        })
    } catch (e) { }
    seSave()
}

/**
 * Смена хозяина: прежние жители уходят, на их койки приходят новые с теми же ремёслами,
 * но другой фракции. Кто сейчас в мире - уберётся при первой встрече (v.purge).
 */
function sgChangeOwner(level, v, by) {
    var old = v.faction
    var fresh = []
    // новые приходят на все койки: и живых прежних хозяев, и павших в бою
    v.settlers.slice().forEach(s => {
        if (s.dead && s.replaced) return
        if (!s.dead) s.gone = true
        s.dead = true
        s.replaced = true
        var female = Math.random() < SE_FEMALE_SHARE
        fresh.push({
            id: "c" + sgDay() + "_" + s.id, role: s.role, female: female, shift: s.shift,
            name: seName(s.role, female), person: null, trade: s.trade || null,
            bed: s.bed, home: s.home, uuid: null, state: "дома", hp: (SE_ROLES[s.role] || SE_ROLES["крестьянин"]).hp,
            newcomer: true,
        })
    })
    fresh.forEach(s => v.settlers.push(s))
    v.faction = by
    v.state = "мир"
    v.threat = {}
    v.purge = true
    v.capturedBy = by
    v.capturedAt = sgDay()
    seSave()
    var site = sgSiteOf(v)
    if (site) {
        site.faction = by
        site.people = {
            ruler: null, traders: [],
            roster: fresh.map(s => ({ id: s.id, role: s.role, female: s.female, name: s.name, trade: s.trade })),
        }
        site.people.ruler = site.people.roster.filter(p => p.role === "правитель")[0] || null
        site.people.traders = site.people.roster.filter(p => p.role === "торговец")
    }
    sgEvent(v, "захват", "поселение перешло к фракции «" + sgFacName(by) + "», прежние хозяева (" + sgFacName(old) + ") ушли")
    sgLog(sgName(v) + ": новый хозяин " + by + " (был " + old + "), новых жителей " + fresh.length)
}

/** Награды помогавшим: одна на фракцию игрока за эту оборону, пропорционально сложности. */
function sgRewards(v, rec) {
    var keys = Object.keys(rec.helpers)
    if (!keys.length) return
    var total = SG_REWARD_UNIT * rec.start * rec.tier * (rec.plan === "захват" ? 1.5 : 1)
    var sum = 0
    keys.forEach(k => { sum += rec.helpers[k].dmg })
    var book = sgLoad().rewards[v.id] || (sgLoad().rewards[v.id] = {})
    var ruler = v.settlers.filter(s => s.role === "правитель" && !s.dead)[0]
    keys.forEach(k => {
        var h = rec.helpers[k]
        var amount = Math.round(total * Math.max(0.5, h.dmg / Math.max(1, sum)))
        book[k] = { amount: amount, siege: rec.id, by: rec.by, day: sgDay(), name: h.name }
        var players = []
        try { SG_SERVER.players.forEach(p => { if (h.players.indexOf(String(p.uuid)) >= 0) players.push(p) }) } catch (e) { }
        sgTell(players, "§6[Поселение] §f«" + sgName(v) + "» отбилось. " +
            (ruler ? "Правитель " + ruler.name + " ждёт вас за наградой." : "Правитель ждёт вас за наградой."))
    })
    sgSave()
}

function sgFinish(level, v, rec, captured, why) {
    rec.endAt = sgNow()
    var near = sgPlayers(v, SG_NEAR)
    if (!captured) {
        rec.stage = "отход"
        sgTell(near, "§a[Поселение] §f«" + sgName(v) + "» отбилось" + (why ? " (" + why + ")" : "") + ".")
    } else if (rec.by === "bandits") {
        rec.stage = "грабёж"
        v.state = "сдалось"
        sgTell(near, "§c[Поселение] §fРазбойники взяли «" + sgName(v) + "» и грабят его.")
    } else {
        rec.stage = "оккупация"
        v.state = "сдалось"
        sgTell(near, "§c[Поселение] §f«" + sgName(v) + "» сдалось фракции " + sgFacName(rec.by) +
            ". Через сутки поселение перейдёт к ней.")
    }
    seSave()
    sgApply(level, v, rec.by, captured, rec)
    sgSave()
    sgLog(sgName(v) + ": " + (captured ? "взяли" : "отбились") + (why ? " - " + why : "") +
        ", отряд " + (rec.start - rec.killed) + "/" + rec.start + ", гарнизон " + seGarrison(v) + "/" + rec.garrison0)
}

/** Проверка исхода идущего боя. */
function sgJudge(level, v, rec) {
    var alive = rec.start - rec.killed
    var g = seGarrison(v)
    var now = sgNow()
    if (alive <= rec.start * SG_FLEE_AT) return sgFinish(level, v, rec, false, "отряд бежал")
    if (v.state === "сдалось" || (g <= rec.garrison0 * SG_FALL_AT && alive >= 2)) return sgFinish(level, v, rec, true, "гарнизон пал")
    if (now - rec.at > SG_MAX_TICKS) {
        var a = alive / rec.start, d = g / rec.garrison0
        return sgFinish(level, v, rec, rec.plan === "захват" ? a > d : a > d + 0.25, "по потерям")
    }
}

// ─── Поведение отряда ────────────────────────────────────────────────────────

function sgDist2(e, x, z) { var dx = e.getX() - x, dz = e.getZ() - z; return dx * dx + dz * dz }

function sgWalk(e, x, z, speed) {
    try {
        var nav = e.getNavigation()
        if (!nav.isDone() && Math.random() < 0.8) return
        var y = e.getY()
        try { y = Number(e.level.getHeight("MOTION_BLOCKING_NO_LEAVES", Math.floor(x), Math.floor(z))) } catch (err) { }
        nav.moveTo(x, y, z, speed)
    } catch (err) { }
}

/** С какой стороны идёт отряд (угол от середины поселения; +z - юг, как в Minecraft). */
function sgSide(ang) {
    var names = ["с востока", "с юго-востока", "с юга", "с юго-запада", "с запада", "с северо-запада", "с севера", "с северо-востока"]
    var i = Math.round(((ang % 6.283185307179586) + 6.283185307179586) % 6.283185307179586 / (3.141592653589793 / 4)) % 8
    return names[i]
}

/**
 * Цель налётчика: ближайший житель поселения - где бы он ни был (задача отряда - перебить
 * всех), а также игрок, который бил отряд; разбойникам - любой игрок рядом.
 */
function sgTarget(e, rec, settlers, players) {
    var best = null, bestD = 1e18
    settlers.forEach(s => {
        if (!s.isAlive()) return
        var d = sgDist2(e, s.getX(), s.getZ())
        if (d < bestD) { bestD = d; best = s }
    })
    players.forEach(p => {
        if (!p.isAlive() || p.isCreative() || p.isSpectator()) return
        if (rec.by !== "bandits" && !rec.foes[String(p.uuid)]) return
        var d = sgDist2(e, p.getX(), p.getZ())
        var limit = rec.foes[String(p.uuid)] ? 48 * 48 : 32 * 32
        if (d < bestD && d < limit) { bestD = d; best = p }
    })
    return best
}

function sgActTick(level, v, rec, ents) {
    var now = sgNow()
    var settlers = []
    try { settlers = seEntities(level, v) } catch (e) { }
    var players = sgPlayers(v, SG_NEAR)
    // пока бой идёт, рейдовых бойцов ведёт сам рейд (tfg/raids.js) - не мешаем ему
    if (rec.raid && rec.stage === "идёт") return
    ents.forEach(e => {
        try {
            if (rec.stage === "идёт") {
                var t = sgTarget(e, rec, settlers, players)
                var fighting = false
                if (t && typeof raidCombatTick === "function") fighting = raidCombatTick(e, t)
                else if (t) { e.setTarget(t); fighting = true }
                // нет цели рядом - идут на поселение быстрым шагом, а не бродят
                if (!fighting) sgWalk(e, v.x + (Math.random() - 0.5) * 12, v.z + (Math.random() - 0.5) * 12, 1.2)
                return
            }
            e.setTarget(null)
            if (rec.stage === "грабёж" || rec.stage === "оккупация") {
                if (Math.random() < 0.2) sgWalk(e, v.x + (Math.random() - 0.5) * 30, v.z + (Math.random() - 0.5) * 30, 0.8)
                return
            }
            // отход: прочь от поселения, скрылся - исчез
            var r = (v.ring || 28) + 70
            sgWalk(e, v.x + Math.cos(rec.ang) * (r + 20), v.z + Math.sin(rec.ang) * (r + 20), 1.2)
            var seen = players.some(p => sgDist2(p, e.getX(), e.getZ()) < 24 * 24)
            if (!seen && (sgDist2(e, v.x, v.z) > r * r || now - rec.endAt > SG_LEAVE_TICKS)) e.discard()
        } catch (err) { sgErr("налётчик", err) }
    })
}

/** Все налётчики мира по номеру осады; чужие (от законченных осад) убираются. */
function sgSiegeEntities(level) {
    var by = {}
    try {
        var list = level.getEntities()
        var act = sgLoad().active
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e || !e.getTags) continue
            var tags = e.getTags()
            if (!tags.contains("tfg_siege")) continue
            var sid = null
            var it = tags.iterator()
            while (it.hasNext()) {
                var t = String(it.next())
                if (t.indexOf("tfg_siege_") === 0) sid = t.substring(10)
            }
            if (!sid || !act[sid]) { e.discard(); continue }
            if (!e.isAlive()) continue
            if (!by[sid]) by[sid] = []
            by[sid].push(e)
        }
    } catch (err) { sgErr("поиск налётчиков", err) }
    return by
}

function sgSiegeTick(level) {
    var data = sgLoad()
    var ids = Object.keys(data.active)
    if (!ids.length) return
    var ents = sgSiegeEntities(level)
    var villages = seLoad().villages
    var now = sgNow()
    ids.forEach(id => {
        var rec = data.active[id]
        var v = villages[rec.vid]
        if (!v) { delete data.active[id]; sgSave(); return }
        var mine = ents[id] || []
        if (mine.length) rec.seen = now
        try {
            if (rec.stage === "идёт") {
                // отряд так и не показался (чанки выгрузились) - решаем без боя
                if (!mine.length && now - (rec.seen || rec.at) > 2400) {
                    var captured = Math.random() < (rec.plan === "захват" ? 0.6 : 0.1)
                    sgFinish(level, v, rec, captured, "бой ушёл из виду")
                } else sgJudge(level, v, rec)
            } else if (rec.stage === "грабёж" && now - rec.endAt > SG_LOOT_TICKS) {
                rec.stage = "отход"
                rec.endAt = now
                v.state = "мир"
                seSave()
                sgTell(sgPlayers(v, SG_NEAR), "§7[Поселение] Разбойники уходят из «" + sgName(v) + "» с добычей.")
            } else if (rec.stage === "оккупация" && now - rec.endAt > SG_OWNER_DELAY) {
                sgChangeOwner(level, v, rec.by)
                mine.forEach(e => { try { e.discard() } catch (err) { } })
                delete data.active[id]
                sgSave()
                return
            } else if (rec.stage === "отход" && (!mine.length || now - rec.endAt > SG_LEAVE_TICKS * 2)) {
                mine.forEach(e => { try { e.discard() } catch (err) { } })
                delete data.active[id]
                sgSave()
                return
            }
            if (mine.length) sgActTick(level, v, rec, mine)
        } catch (err) { sgErr("осада " + id, err) }
    })
}

// ─── Смена поколений: уход прежних, приход новых ─────────────────────────────

/**
 * Раз в SG_REPLACE_DAYS без игрока рядом погибшим находится замена - та же роль и койка.
 * Раньше заселённое поселение только теряло людей: пополнение было лишь до заселения.
 */
function sgReplaceDead(level, v) {
    if (v.state === "сдалось" || sgActiveFor(v.id)) return
    var day = sgDay()
    if (day - (v.replaceDay === undefined ? day : v.replaceDay) < SG_REPLACE_DAYS) {
        if (v.replaceDay === undefined) { v.replaceDay = day; seSave() }
        return
    }
    if (sgPlayers(v, 128).length) return
    v.replaceDay = day
    var n = 0
    v.settlers.slice().forEach(s => {
        if (!s.dead || s.replaced) return
        s.replaced = true
        var female = Math.random() < SE_FEMALE_SHARE
        v.settlers.push({
            id: "r" + day + "_" + s.id, role: s.role, female: female, shift: s.shift,
            name: seName(s.role, female), person: null, trade: s.trade || null,
            bed: s.bed, home: s.home, uuid: null, state: "дома", hp: (SE_ROLES[s.role] || SE_ROLES["крестьянин"]).hp,
            newcomer: true,
        })
        n++
    })
    seSave()
    // лавки пополняются и после грабежа
    try { seUpkeep(level, v, true) } catch (e) { sgErr("присмотр", e) }
    if (n) sgLog(sgName(v) + ": на место погибших пришли " + n)
}

/** Прежних жителей - убрать, новых - вывести к их койкам (когда там прогружено и никто не смотрит). */
function sgPeopleTick(level, v) {
    var ents = []
    try { ents = seEntities(level, v) } catch (e) { return }
    var bySid = {}
    v.settlers.forEach(s => { bySid[s.id] = s })
    if (v.purge) {
        ents.forEach(e => {
            var s = bySid[seSidOf(e)]
            if (s && s.gone) { try { e.discard() } catch (err) { } }
        })
    }
    var players = sgPlayers(v, SG_NEAR)
    var changed = false
    v.settlers.forEach(s => {
        if (!s.newcomer || s.dead) return
        var loaded = false
        try { loaded = !!level.hasChunk(Math.floor(s.bed.x) >> 4, Math.floor(s.bed.z) >> 4) } catch (e) { }
        if (!loaded) return
        if (players.some(p => sgDist2(p, s.bed.x, s.bed.z) < 24 * 24)) return
        try { seSpawnOne(v, s, level); s.newcomer = false; changed = true } catch (e) { sgErr("новый житель", e) }
    })
    if (changed) seSave()
}

// ─── Расписание ──────────────────────────────────────────────────────────────

function sgHourTick(level) {
    var villages = seLoad().villages
    var data = sgLoad()
    var day = sgDay()
    for (var vid in villages) {
        var v = villages[vid]
        try {
            if (!v.spawned || v.state === "сдалось" || sgActiveFor(vid)) continue
            sgReplaceDead(level, v)
            if (data.lastDay[vid] === day) continue                // не больше одного налёта в сутки
            var inside = sgPlayers(v, SG_IN).length > 0
            var by = null
            var enemy = sgEnemyOf(v.faction)
            if (enemy && Math.random() < sgHourly(inside ? SG_ENEMY_PRESENT_DAY : SG_ENEMY_DAY)) by = enemy
            else if (Math.random() < sgHourly(SG_BANDIT_DAY)) by = "bandits"
            if (!by) continue
            if (sgPlayers(v, SG_NEAR).length) {
                var err = sgStart(level, v, by, null)
                if (err) { sgLog("настоящий налёт не вышел (" + err + ") - решаю без боя"); sgAbstract(level, v, by) }
            } else sgAbstract(level, v, by)
        } catch (e) { sgErr("расписание " + vid, e) }
    }
}

ServerEvents.tick(event => {
    if (!SG_SERVER) SG_SERVER = event.server
    if (event.server.tickCount % 20 !== 0) return
    var level = event.server.overworld()
    try { sgSiegeTick(level) } catch (e) { sgErr("тик", e) }
    if (event.server.tickCount % 200 === 0) {
        var villages = seLoad().villages
        for (var vid in villages) {
            try { if (villages[vid].spawned) sgPeopleTick(level, villages[vid]) } catch (e) { sgErr("жители " + vid, e) }
        }
    }
    var hour = Math.floor(Number(level.getTime()) / 1000)
    if (hour !== SG_LAST_HOUR) {
        var first = SG_LAST_HOUR < 0
        SG_LAST_HOUR = hour
        if (!first) { try { sgHourTick(level) } catch (e) { sgErr("час", e) } }
    }
})

// ─── Кто бил отряд и кто погиб ───────────────────────────────────────────────

function sgSiegeOf(e) {
    try {
        if (!e || !e.getTags || !e.getTags().contains("tfg_siege")) return null
        var it = e.getTags().iterator()
        while (it.hasNext()) {
            var t = String(it.next())
            if (t.indexOf("tfg_siege_") === 0) return sgLoad().active[t.substring(10)] || null
        }
    } catch (err) { }
    return null
}

function sgNoteHelper(rec, player, dmg) {
    if (!player || rec.stage !== "идёт") return
    rec.foes[String(player.uuid)] = 1
    var team = null
    try { team = global.TFG_FACTIONS.teamOf(player) } catch (e) { }
    var key = team ? team.key : "p_" + String(player.uuid)
    var h = rec.helpers[key] || (rec.helpers[key] = { dmg: 0, name: team ? String(team.name) : String(player.username), players: [] })
    h.dmg += dmg
    if (h.players.indexOf(String(player.uuid)) < 0) h.players.push(String(player.uuid))
}

EntityEvents.hurt(event => {
    try {
        var rec = sgSiegeOf(event.entity)
        if (!rec) return
        var src = null
        try { src = event.source && event.source.player } catch (e) { }
        if (src) sgNoteHelper(rec, src, Number(event.damage) || 1)
    } catch (err) { }
})

EntityEvents.death(event => {
    try {
        var rec = sgSiegeOf(event.entity)
        if (!rec) return
        if (rec.stage === "идёт") rec.killed++
        var src = null
        try { src = event.source && event.source.player } catch (e) { }
        if (src) sgNoteHelper(rec, src, 10)
        sgSave()
    } catch (err) { }
})

// Налётчик фракции - не зомби: своих целей не ищет, бьёт тех, кого укажет осада.
EntityEvents.spawned(event => {
    try {
        var e = event.entity
        if (!e || !e.getTags || !e.getTags().contains("tfg_siege") || e.getTags().contains("tfg_bandit")) return
        var f = gsGoalFields(e)
        f[1].get(e).removeAllGoals(g => true)
        f[0].get(e).removeAllGoals(g => g instanceof GS_RandomStrollGoal || g instanceof GS_MoveThroughVillageGoal)
        if (typeof raidSetupAi === "function") raidSetupAi(e)
        try { gsHuskVoice(e) } catch (err) { }
    } catch (err) { sgErr("налётчик фракции", err) }
})

// ─── Награда у правителя ─────────────────────────────────────────────────────

const SG_THANKS = [
    "Ты стоял с нами у стен. Держи - заслужил.",
    "Без тебя мы бы не выстояли. Вот, как обещано.",
    "Мы помним, кто пришёл на помощь. Бери.",
    "Честная плата за честную драку.",
]

ItemEvents.entityInteracted(event => {
    try {
        var e = event.target
        if (!e || String(event.hand) !== "MAIN_HAND" || !e.getTags || !e.getTags().contains("tfg_settler")) return
        if (!e.getTags().contains("tfg_role_ruler")) return
        var vid = seTagValue(e, "tfg_v_")
        var book = sgLoad().rewards[vid]
        if (!book) return
        var player = event.player
        var team = null
        try { team = global.TFG_FACTIONS.teamOf(player) } catch (err) { }
        var key = team ? team.key : "p_" + String(player.uuid)
        var r = book[key]
        if (!r) return
        var v = seLoad().villages[vid]
        delete book[key]
        sgSave()
        var line = SG_THANKS[Math.floor(Math.random() * SG_THANKS.length)]
        try { seVoice(e, line) } catch (err) { }
        player.tell(Text.of("§6" + String(e.getName().getString()).split(" · ")[0] + ": §f" + line))
        global.TFG_COINS.give(player, r.amount)
        player.tell(Text.of("§7Награда за оборону: " + r.amount + " " + global.TFG_COINS.unit + "."))
        if (v) { try { global.TFG_FACTIONS.addRep(player, v.faction, 6, "помощь в обороне поселения") } catch (err) { } }
        sgLog(player.username + " забрал награду " + r.amount + " в " + (v ? sgName(v) : vid))
        event.cancel()
    } catch (err) { sgErr("награда", err) }
})

// ─── Наружу и команды ────────────────────────────────────────────────────────

global.TFG_SIEGES = {
    start: (level, v, by, plan) => sgStart(level, v, by, plan),
    active: () => sgLoad().active,
    rewards: () => sgLoad().rewards,
    changeOwner: (level, v, by) => sgChangeOwner(level, v, by),
}

/**
 * Отменить все налёты: налётчики исчезают, рейды снимаются, поселения возвращаются к миру,
 * враждебность игроков забыта. Возвращает { raids, raiders }.
 */
function sgClearAll() {
    var level = SG_SERVER.overworld()
    var n = 0
    try {
        var list = level.getEntities()
        var gone = []
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            try { if (e && e.getTags && e.getTags().contains("tfg_siege")) gone.push(e) } catch (err) { }
        }
        gone.forEach(e => { try { e.discard(); n++ } catch (err) { } })
    } catch (err) { sgErr("отмена налётов", err) }
    var act = sgLoad().active, vs = seLoad().villages, k = 0
    for (var id in act) {
        var v = vs[act[id].vid]
        if (v && v.state !== "сдалось") { v.state = "мир"; v.hornN = 0; v.threat = {}; delete v.raidBy }
        delete act[id]
        k++
    }
    for (var rid in global.TFG_ACTIVE_RAIDS || {}) if (global.TFG_ACTIVE_RAIDS[rid].village) delete global.TFG_ACTIVE_RAIDS[rid]
    sgSave()
    seSave()
    return { raids: k, raiders: n }
}

global.TFG_SIEGES = {
    start: (level, v, by) => sgStart(level, v, by, null),
    clear: () => sgClearAll(),
    enemyOf: factionId => sgEnemyOf(factionId),
}
global.TFG_SIEGE_STAGE = sid => { try { var r = sgLoad().active[sid]; return r ? r.stage : null } catch (e) { return null } }

function sgNearestVillage(p) {
    var best = null, bestD = 1e18
    var villages = seLoad().villages
    for (var vid in villages) {
        var v = villages[vid]
        if (String(p.level.getDimension()) !== v.dim) continue
        var d = sgDist2(p, v.x, v.z)
        if (d < bestD) { bestD = d; best = v }
    }
    return best
}

ServerEvents.commandRegistry(event => {
    try {
        var Commands = event.commands
        var Arguments = event.arguments
        var who = () => Commands.argument("who", Arguments.STRING.create(event))
        event.register(Commands.literal("tfgsiege").requires(s => s.hasPermission(2))
            .executes(ctx => {
                if (!SG_SERVER) SG_SERVER = ctx.source.getServer()
                var act = sgLoad().active
                var rows = []
                for (var id in act) {
                    var r = act[id], v = seLoad().villages[r.vid]
                    rows.push("§f" + (v ? sgName(v) : r.vid) + " §7- " + sgFacName(r.by) + ", " + r.stage + ", замысел " + r.plan +
                        ", отряд " + (r.start - r.killed) + "/" + r.start + ", гарнизон " + (v ? seGarrison(v) : "?") + "/" + r.garrison0 +
                        ", помогали: " + (Object.keys(r.helpers).map(k => r.helpers[k].name).join(", ") || "никто"))
                }
                var rw = sgLoad().rewards, owed = []
                for (var vid in rw) for (var k in rw[vid]) owed.push(rw[vid][k].name + " " + rw[vid][k].amount)
                ctx.source.sendSuccess(Text.of((rows.length ? rows.join("\n") : "§7Осад нет.") +
                    (owed.length ? "\n§7Ждут награды: " + owed.join(", ") : "")), false)
                return 1
            })
            // запуск и отмена налёта - /tfgvillage raid [фракция] | stop (factions/settlers.js)
            // решить налёт на ближайшее поселение без боя: /tfgsiege roll <bandits|фракция>
            .then(Commands.literal("roll").then(who().executes(ctx => {
                if (!SG_SERVER) SG_SERVER = ctx.source.getServer()
                var v = sgNearestVillage(ctx.source.getPlayerOrException())
                if (!v) return 1
                sgAbstract(SG_SERVER.overworld(), v, String(Arguments.STRING.getResult(ctx, "who")))
                ctx.source.sendSuccess(Text.of("Решено без боя - см. /tfglore и лог."), false)
                return 1
            }))))
    } catch (err) {
        console.error("[осады] ошибка регистрации команд: " + err)
    }
})
