// priority: 0
"use strict";

/**
 * КАРАВАНЫ В ПУТИ (шаг 1 плана).
 *
 * Караван - не визит к поселению, а отряд в дороге: идёт по прямой и создаёт ощущение, что у него есть путь.
 * Пеший, с повозками или на дирижаблях; тир случайный; аппараты красятся в цвет фракции (слот красителя Immersive
 * Aircraft). В поселении гости занимаются делами (factions/guests.js), а в дороге у каравана только болтовня и бой.
 *
 * ПОЯВЛЕНИЕ. Событие определяется заранее: раз в CV_ROLL_TICKS разыгрывается новый караван - фракция, тир, транспорт,
 * маршрут и скорость. Дальше караван едет ВИРТУАЛЬНО: позиция считается по времени, сущностей нет. Когда игрок
 * оказывается ближе CV_LOAD блоков, караван появляется в своей расчётной точке уже в движении, а не из воздуха
 * под носом. Когда рядом никого нет (CV_UNLOAD), сущности убираются, а караван продолжает ехать виртуально -
 * и может встретиться снова дальше по маршруту. Живёт CV_LIFE_TICKS, потом считается дошедшим.
 *
 * Хранится в общем списке визитов (tfg_guest_visits, поле caravan), поэтому работают все общие механизмы гостей:
 * голоса, добыча, вражда за удар, посадка только в свой транспорт.
 *
 * Команды (оператор): /tfgcaravan [фракция] [тир] | list | clear.
 */

const CV_ROLL_TICKS = 6000          // как часто разыгрывается новый караван (5 минут)
const CV_ROLL_CHANCE = 0.5
const CV_MAX = 3                    // больше караванов одновременно не держим
const CV_LIFE_TICKS = 72000         // трое суток игры - потом караван "дошёл"
const CV_CAMP_FROM = 12800          // с этого времени суток караван ищет место для ночлега
const CV_CAMP_TO = 22000            // после этого уже поздно вставать - идут дальше
const CV_CAMP_TTL = 11000           // сколько стоит лагерь, если не свернут раньше
const CV_LOAD = 130                 // ближе - караван появляется в мире
const CV_UNLOAD = 200               // дальше - убираем сущности, караван едет виртуально
const CV_MIN_SPAWN = 60             // но не ближе этого к игроку
const CV_SPEED = 0.055              // блоков за тик (примерно шаг пешехода)
const CV_AIR_SPEED = 0.12
const CV_START_MIN = 260            // где начинается маршрут относительно игрока
const CV_START_MAX = 520
const CV_DYE = { blue: "minecraft:blue_dye", red: "minecraft:red_dye", yellow: "minecraft:yellow_dye", white: "minecraft:white_dye",
    black: "minecraft:black_dye", green: "minecraft:green_dye", orange: "minecraft:orange_dye", purple: "minecraft:purple_dye",
    cyan: "minecraft:cyan_dye", light_blue: "minecraft:light_blue_dye", lime: "minecraft:lime_dye", magenta: "minecraft:magenta_dye" }
// чем ходит фракция: вес пеших, повозок и воздуха
const CV_TRANSPORT_WEIGHTS = {
    wind: { foot: 1, cart: 1, air: 6 },
    ash: { foot: 2, cart: 6, air: 0.5 },
    marvins: { foot: 3, cart: 4, air: 1 },
    alliance: { foot: 3, cart: 3, air: 1 },
}

function cvLog(msg) { global.tfgLog("tfg caravans", msg) }

function cvPickWeighted(map) {
    var total = 0
    for (var k in map) total += map[k]
    var roll = Math.random() * total
    for (var k2 in map) {
        roll -= map[k2]
        if (roll <= 0) return k2
    }
    return Object.keys(map)[0]
}

/** Транспорт каравана: пеший, повозки или аппарат по тиру (воздух - только с тира 5). */
function cvTransport(faction, tier) {
    var w = CV_TRANSPORT_WEIGHTS[faction] || { foot: 3, cart: 3, air: 1 }
    var pick = cvPickWeighted({ foot: w.foot, cart: tier >= 3 ? w.cart : 0, air: tier >= 5 ? w.air : 0 })
    if (pick === "air") return tier >= 8 ? "warship" : tier >= 6 ? "cargo_airship" : "airship"
    return pick
}

/** Где караван сейчас по расчёту (виртуально), если его никто не видит. */
function cvVirtualPos(v, now) {
    var t = Math.max(0, now - v.route.since)
    var speed = v.crafts.length || v.transport === "airship" || v.transport === "cargo_airship" || v.transport === "warship" ? CV_AIR_SPEED : CV_SPEED
    return { x: v.route.x + v.route.dx * speed * t, z: v.route.z + v.route.dz * speed * t }
}

/** Ближайший игрок к точке в измерении каравана: [игрок, расстояние]. */
function cvNearestPlayer(v, x, z) {
    var best = null, bestD = 1e18
    GS_SERVER.players.forEach(p => {
        if (String(p.level.getDimension()) !== v.dim) return
        var d = Math.pow(p.getX() - x, 2) + Math.pow(p.getZ() - z, 2)
        if (d < bestD) { bestD = d; best = p }
    })
    return [best, Math.sqrt(bestD)]
}

/** Точка впереди по маршруту - туда караван и идёт. */
function cvAhead(v, from, blocks) {
    return { x: from.x + v.route.dx * blocks, z: from.z + v.route.dz * blocks }
}

// ─── Появление и исчезновение ────────────────────────────────────────────────

function cvSpawn(v, level, now) {
    var pos = cvVirtualPos(v, now)
    var stand = gsNearestStand(level, Math.floor(pos.x), Math.floor(pos.z), 24)
    v.center = { x: Math.floor(stand.x), y: stand.y, z: Math.floor(stand.z) }     // общие механизмы гостей ждут центр
    v.arrive = { x: stand.x, y: stand.y, z: stand.z }
    var kinds = global.TFG_TRADE_GOODS.kindsFor(v.tier)
    var kindId = kinds[Math.floor(Math.random() * kinds.length)].id
    var err = trVisit(level, v.center, v.faction, kindId, v.tier, { x: stand.x, y: stand.y, z: stand.z, guest: v.id })
    if (err) {
        cvLog(v.id + ": торговец не вышел - " + err)
        return false
    }
    var trader = TR_LAST_ENTITY
    GS_ENT[String(trader.uuid)] = trader
    v.trader = String(trader.uuid)
    v.kindName = global.TFG_TRADE_GOODS.kind(kindId).name
    try { trader.setAttributeBaseValue("minecraft:generic.movement_speed", GS_GUARD_SPEED) } catch (e) { }
    var size = Math.max(2, Math.min(GS_MAX_GUARDS, 1 + v.tier))
    var guards = []
    for (var i = 0; i < size; i++) {
        var a = i * 6.283185307179586 / size
        var g = gsSpawnGuard(v, level, stand.x + Math.cos(a) * 2.5, stand.y, stand.z + Math.sin(a) * 2.5, i)
        if (g) { guards.push(g); v.guards.push(String(g.uuid)); GS_ENT[String(g.uuid)] = g }
    }
    if (v.transport === "cart") gsSpawnCarts(v, level, trader, guards)
    else if (v.transport !== "foot") {
        gsSpawnAir(v, level, (guards.length ? [guards[0], trader].concat(guards.slice(1)) : [trader]).filter(e => e))
        cvDyeCrafts(v, level)
    }
    v.startGuards = guards.length
    v.spawned = true
    gsSave()
    cvLog(v.id + ": вышел в мир у " + v.center.x + " " + v.center.z + " (" + v.transport + ", охрана " + guards.length + ")")
    return true
}

/** Аппараты каравана красим в цвет фракции - у Immersive Aircraft есть слот красителя. */
function cvDyeCrafts(v, level) {
    var faction = trFaction(v.faction)
    var dye = faction ? CV_DYE[faction.dye] : null
    if (!dye) return
    v.crafts.forEach(u => {
        var c = gsEntity(v, u)
        if (!c) return
        try { airFillSlots(c, "dye", dye) } catch (e) { cvLog("покрасить аппарат не вышло: " + e) }
    })
}

/** Убрать сущности, но не сам караван: он поедет дальше виртуально. */
function cvDespawn(v, now, why) {
    if (v.bridge) try { global.TFG_BRIDGES.drop(v, "караван ушёл: " + why) } catch (e) { }
    if (v.camp) {
        var campZone = v.camp.zone
        v.camp = null
        try { global.TFG_CAMPS.remove(campZone, "караван ушёл: " + why, true) } catch (e) { }
    }
    var lead = null
    var all = [v.trader].concat(v.guards, v.crafts, v.carts, v.horses)
    all.forEach(u => {
        var e = gsEntity(v, u)
        if (e && !lead) lead = { x: e.getX(), z: e.getZ() }
        if (e) {
            try { e.ejectPassengers() } catch (err) { }
            e.discard()
        }
        delete GS_ENT[u]
    })
    if (lead) {
        v.route.x = lead.x
        v.route.z = lead.z
        v.route.since = now
    }
    v.trader = null
    v.guards = []
    v.crafts = []
    v.carts = []
    v.horses = []
    v.spawned = false
    v.hostile = null
    delete GS_RT[v.id]
    gsSave()
    cvLog(v.id + ": " + why + ", едет дальше без сущностей")
}

// ─── Тик каравана (зовётся из gsVisitTick) ───────────────────────────────────

const CV_PathTypes = Java.loadClass("net.minecraft.world.level.pathfinder.BlockPathTypes")

/** Вода каравану страшна: по ней не ходит (путь в обход или мост), пока там нет цели для атаки. */
function cvWaterFear(e) {
    if (!e || !e.isAlive() || !e.getNavigation) return
    var t = null
    try { t = e.getTarget() } catch (err) { }
    var want = t && t.isInWater() ? 8 : -1
    try {
        if (Number(e.getPathfindingMalus(CV_PathTypes.WATER)) !== want) {
            e.setPathfindingMalus(CV_PathTypes.WATER, want)
            e.setPathfindingMalus(CV_PathTypes.WATER_BORDER, want < 0 ? 16 : 8)
        }
    } catch (err) { }
}

function gsCaravanTick(v, level, now, trader, guards, rt, crafts, fighting) {
    if (now - v.route.since > CV_LIFE_TICKS && !v.spawned) {
        delete GS_VISITS[v.id]
        gsSave()
        cvLog(v.id + ": дошёл до места назначения")
        return
    }
    if (!v.spawned) {
        var pos = cvVirtualPos(v, now)
        var near = cvNearestPlayer(v, pos.x, pos.z)
        if (near[0] && near[1] < CV_LOAD && near[1] > CV_MIN_SPAWN) cvSpawn(v, level, now)
        return
    }
    ;[trader].concat(guards).forEach(cvWaterFear)
    if (v.camp) return cvCampTick(v, level, now, trader, guards, rt)
    var leader = v.carts.length ? (guards[1] || guards[0] || trader) : (trader || guards[0])
    if (!leader) {
        // всех перебили или чанк выгрузился
        if (!trader && !guards.length) {
            delete GS_VISITS[v.id]
            gsSave()
            cvLog(v.id + ": каравана больше нет")
        }
        return
    }
    if (leader.isPassenger() && !crafts.length) leader = guards[0] || trader
    var who = cvNearestPlayer(v, leader.getX(), leader.getZ())
    if (!who[0] || who[1] > CV_UNLOAD) {
        cvDespawn(v, now, "рядом никого")
        return
    }
    // идём вперёд по маршруту
    var ahead = cvAhead(v, { x: leader.getX(), z: leader.getZ() }, 48)
    if (crafts.length) {
        crafts.forEach(c => {
            c.mode = "ai"
            c.landed = false
            c.goal = { x: ahead.x, y: Math.max(v.center.y + 30, gsSurface(level, ahead.x, ahead.z) + 25), z: ahead.z, land: false }
        })
    } else {
        // путь упёрся в воду - строят мост и идут по нему гуськом (factions/bridges.js)
        if (!global.TFG_BRIDGES || !global.TFG_BRIDGES.steer(v, level, now, leader, trader, guards, ahead)) {
            if (leader.getNavigation().isDone() || now % 100 === 0) gsWalk(leader, ahead.x, gsSurface(level, ahead.x, ahead.z), ahead.z, 0.85)
            gsFollow(v, level, leader, guards, trader, fighting || {})
        }
    }
    // центр для разговоров и оповещений едет вместе с караваном
    v.center.x = Math.floor(leader.getX())
    v.center.z = Math.floor(leader.getZ())
    cvCampCheck(v, level, now, leader, trader, guards, rt)
}

// ─── Ночлег ──────────────────────────────────────────────────────────────────

/** Ночью караван встаёт лагерем: пеший - обязательно, летящий - только если есть где сесть. */
function cvCampCheck(v, level, now, leader, trader, guards, rt) {
    if (v.camp || v.campDone) return
    var tod = now % 24000
    if (tod < CV_CAMP_FROM || tod > CV_CAMP_TO) return
    if (Math.random() > 0.25) return                       // не в первую же секунду ночи
    var res = cvMakeCamp(v, level, now, leader.getX(), leader.getZ(), CV_CAMP_TTL, trader, guards, rt)
    if (typeof res === "string") {
        v.campTry = (v.campTry || 0) + 1
        if (v.campTry > 6) v.campDone = true               // негде вставать - идут всю ночь
        cvLog(v.id + ": лагерь не встал (" + res + ")")
        return
    }
    gsNotify(v, "§6[Караван] §fКараван фракции " + gsFactionName(v.faction) + " встал на ночлег.")
}

/**
 * Поставить лагерь и расставить в нём караван: люди у костра, скот в загоне,
 * повозки рядом с загоном, аппараты на площадке.
 */
function cvMakeCamp(v, level, now, cx, cz, ttl, trader, guards, rt) {
    var camp = null
    try {
        var kindId = null
        try {
            var tr = gsEntity(v, v.trader)
            if (tr) kindId = String(tr.persistentData.getString("tfg_trader_kind"))
        } catch (e) { }
        camp = global.TFG_CAMPS.build(level, cx, cz, {
            faction: v.faction, ttl: ttl, visit: v.id, kind: kindId, tier: v.tier,
            animals: v.horses.length > 0 || v.carts.length > 0, crafts: v.crafts.length > 0,
        })
    } catch (e) { return String(e) }
    if (!camp || typeof camp === "string") return String(camp || "лагерь не встал")

    v.camp = { zone: camp.zone, x: camp.x, y: camp.y, z: camp.z, until: now + ttl }
    v.center = { x: camp.x, y: camp.y, z: camp.z }
    v.arrive = { x: camp.x, y: camp.y, z: camp.z }
    rt.scan = null                                         // пусть заново найдут костёр и сиденья лагеря
    rt.pois = { chairs: [], fires: [], waters: [], stats: {} }
    rt.acts = {}

    // люди: с бортов на землю и к огню
    var people = [trader].concat(guards).filter(e => e)
    people.forEach((e, i) => {
        if (e.isPassenger()) e.stopRiding()
        var a = i * 6.283185307179586 / Math.max(1, people.length)
        var px = camp.x + Math.cos(a) * 3.5, pz = camp.z + Math.sin(a) * 3.5
        gsTp(level, e, px, gsSurface(level, px, pz), pz)
    })
    // скот - в загон, повозки - рядом с ним
    var pen = camp.pen || { x: camp.x + 6, y: camp.y, z: camp.z + 6 }
    v.horses.forEach((u, i) => {
        var h = gsEntity(v, u)
        if (!h) return
        gsTp(level, h, pen.x + (i % 2) - 0.5, pen.y, pen.z + ((i / 2) | 0) - 0.5)
    })
    v.carts.forEach((u, i) => {
        var c = gsEntity(v, u)
        if (!c) return
        var cxp = pen.x + 3 + i * 2, czp = pen.z
        gsTp(level, c, cxp, gsSurface(level, cxp, czp), czp)
    })
    // аппараты - на площадку, двигатели глушим
    var pad = camp.pad || { x: camp.x - 7, y: camp.y, z: camp.z - 7 }
    var crafts = v.crafts.length ? gsCrafts(v, level) : []
    crafts.forEach((c, i) => {
        var px = pad.x + (i % 2) * 4 - 2, pz = pad.z + ((i / 2) | 0) * 4 - 2
        gsTp(level, c.vehicle, px, gsSurface(level, px, pz), pz)
        c.mode = "idle"
        c.landed = true
        c.goal = null
    })
    gsSave()
    cvLog(v.id + ": лагерь " + camp.zone + " на " + camp.x + " " + camp.z + ", людей " + people.length +
        ", скота " + v.horses.length + ", повозок " + v.carts.length + ", аппаратов " + crafts.length)
    return camp
}

/** Тестовая стоянка: караван выходит рядом с игроком и сразу встаёт лагерем. */
function cvCampHere(player, factionId, ttl) {
    var level = player.level
    if (!GS_SERVER) GS_SERVER = level.getServer()
    var now = gsNow(level)
    var faction = trFaction(factionId)
    if (!faction) return "нет фракции " + factionId
    var tier = 1
    try { tier = Math.max(1, Math.min(10, Number(global.TFG_PLAYER_TIER(player)) || 1)) } catch (e) { }
    var ang = Math.random() * 6.283185307179586
    var sx = player.getX() + Math.cos(ang) * 18
    var sz = player.getZ() + Math.sin(ang) * 18
    var id = "cv" + now + "_" + Math.floor(Math.random() * 1000)
    var v = {
        id: id, caravan: true, faction: faction.id, tier: tier, transport: cvTransport(faction.id, tier),
        dim: String(level.getDimension()), route: { x: sx, z: sz, dx: Math.cos(ang), dz: Math.sin(ang), since: now },
        center: { x: Math.floor(sx), y: 64, z: Math.floor(sz) }, arrive: { x: sx, y: 64, z: sz },
        phase: "stay", since: now, until: now + CV_LIFE_TICKS, spawned: false,
        trader: null, guards: [], crafts: [], carts: [], horses: [], hostile: null, raid: false, kindName: null,
    }
    gsLoad()[id] = v
    gsSave()
    if (!cvSpawn(v, level, now)) {
        delete gsLoad()[id]
        gsSave()
        return "караван не вышел"
    }
    var rt = gsRt(v.id)
    var trader = gsEntity(v, v.trader)
    var guards = v.guards.map(u => gsEntity(v, u)).filter(e => e)
    var camp = cvMakeCamp(v, level, now, v.center.x, v.center.z, ttl || CV_CAMP_TTL, trader, guards, rt)
    if (typeof camp === "string") {
        cvDespawn(v, now, "лагерь не встал")
        return camp
    }
    return camp
}

/** В лагере: стоим до утра, дальше сворачиваемся и идём своей дорогой. */
function cvCampTick(v, level, now, trader, guards, rt) {
    var tod = now % 24000
    var over = now >= v.camp.until || (tod > 500 && tod < CV_CAMP_FROM)
    var who = cvNearestPlayer(v, v.camp.x, v.camp.z)
    if (!over && (!who[0] || who[1] > CV_UNLOAD)) {
        // игроков рядом нет: лагерь убираем вместе с караваном
        cvCampPack(v, "рядом никого")
        cvDespawn(v, now, "рядом никого")
        return
    }
    if (!over) {
        cvCampLife(v, level, now, trader, guards, rt)
        return
    }
    cvCampPack(v, "утро")
    gsNotify(v, "§6[Караван] §fКараван фракции " + gsFactionName(v.faction) + " снялся со стоянки.")
}

/**
 * Жизнь лагеря: один в карауле обходит стоянку, один присматривает за скотом,
 * остальные греются у огня обычными занятиями, торговец держится своего товара.
 * Изредка кто-нибудь ворчит про дорогу.
 */
function cvCampLife(v, level, now, trader, guards, rt) {
    if (now - (rt.campAt || 0) < 40) return
    rt.campAt = now
    var camp = v.camp
    var pen = null, storage = null
    try {
        var rec = global.TFG_CAMPS.at(v.dim, camp.x, camp.z, 24)
        if (rec) { pen = rec.pen; storage = (rec.loot || [])[0] }
    } catch (e) { }

    guards.forEach((g, i) => {
        if (!g || g.isPassenger()) return
        var key = String(g.uuid)
        var act = rt.acts[key]
        if (act && act.id !== "camp_watch" && act.id !== "camp_beasts") return     // занят своим делом - не мешаем
        if (i === 0) {
            // караул: медленный круг по границе лагеря
            var a = (now / 500 + i) % 6.283185307179586
            var wx = camp.x + Math.cos(a) * 7, wz = camp.z + Math.sin(a) * 7
            if (g.getNavigation().isDone()) gsWalk(g, wx, gsSurface(level, wx, wz), wz, 0.7)
            rt.acts[key] = { id: "camp_watch", stage: "do", until: now + 400, started: now }
            gsMono(v, rt, g, "camp_watch", now, 0.05)
            return
        }
        if (i === 1 && pen) {
            if (gsDist2(g, pen.x, pen.z) > 9 && g.getNavigation().isDone()) gsWalk(g, pen.x, pen.y, pen.z, 0.7)
            rt.acts[key] = { id: "camp_beasts", stage: "do", until: now + 400, started: now }
            gsMono(v, rt, g, "camp_beasts", now, 0.05)
            return
        }
        gsMono(v, rt, g, "camp", now, 0.03)
    })

    // торговец у своего добра
    if (trader && !trader.isPassenger() && storage && trader.getNavigation().isDone() &&
        gsDist2(trader, storage.x, storage.z) > 16 && Math.random() < 0.2) {
        gsWalk(trader, storage.x + 1, storage.y, storage.z + 1, 0.6)
    }
    if (trader) gsMono(v, rt, trader, "camp", now, 0.02)
}

/** Караван сам снялся со стоянки: лагерь убираем, людей оставляем - они идут дальше. */
function cvCampPack(v, why) {
    if (!v.camp) return
    var zone = v.camp.zone
    v.camp = null
    v.campDone = true
    gsSave()
    try { global.TFG_CAMPS.remove(zone, "караван снялся: " + why, true) } catch (e) { cvLog("свернуть лагерь: " + e) }
}

/** Лагерь убрали снаружи (срок вышел или команда): обитателей и телеги тоже убираем. */
function cvCampGone(visitId, why) {
    var v = gsLoad()[String(visitId)]
    if (!v) return
    v.camp = null
    v.campDone = true
    if (v.spawned) cvDespawn(v, gsNow(GS_SERVER.overworld()), "лагерь убран: " + why)
    if (v.caravan) {
        delete gsLoad()[String(visitId)]                      // тестовый лагерь уходит целиком
    }
    gsSave()
    cvLog(visitId + ": лагерь убран (" + why + "), обитатели сняты")
}

// ─── Розыгрыш новых караванов ────────────────────────────────────────────────

function cvCount() {
    var n = 0
    var visits = gsLoad()
    for (var id in visits) if (visits[id].caravan) n++
    return n
}

/** Новый караван: маршрут по прямой мимо игрока, чтобы встреча была вероятной. */
function cvCreate(level, player, factionId, tierOverride) {
    var npc = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits")
    var faction = factionId ? trFaction(factionId) : npc[Math.floor(Math.random() * npc.length)]
    if (!faction) return "нет фракции " + factionId
    var tier = tierOverride || (1 + Math.floor(Math.random() * 10))
    var transport = cvTransport(faction.id, tier)
    var now = Number(level.getTime())
    // маршрут: прямая, проходящая в 40-120 блоках от игрока
    var course = Math.random() * 6.283185307179586
    var dx = Math.cos(course), dz = Math.sin(course)
    var side = (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 80)
    var back = CV_START_MIN + Math.random() * (CV_START_MAX - CV_START_MIN)
    var sx = player.getX() - dx * back - dz * side
    var sz = player.getZ() - dz * back + dx * side
    var id = "cv" + now + "_" + Math.floor(Math.random() * 1000)
    var v = {
        id: id, caravan: true, faction: faction.id, tier: tier, transport: transport, dim: String(level.getDimension()),
        route: { x: sx, z: sz, dx: dx, dz: dz, since: now },
        center: { x: Math.floor(sx), y: 64, z: Math.floor(sz) }, arrive: { x: sx, y: 64, z: sz },
        phase: "stay", since: now, until: now + CV_LIFE_TICKS, spawned: false,
        trader: null, guards: [], crafts: [], carts: [], horses: [], hostile: null, raid: false, kindName: null,
    }
    gsLoad()[id] = v
    gsSave()
    cvLog(id + ": запланирован " + faction.name + ", тир " + tier + ", " + transport + ", старт " + Math.floor(sx) + " " + Math.floor(sz) +
        ", курс " + dx.toFixed(2) + " " + dz.toFixed(2))
    return null
}

ServerEvents.tick(event => {
    if (!GS_SERVER) GS_SERVER = event.server
    var tick = Number(event.server.tickCount)
    if (tick % CV_ROLL_TICKS !== 0) return
    try {
        if (cvCount() >= CV_MAX || Math.random() > CV_ROLL_CHANCE) return
        var players = []
        GS_SERVER.players.forEach(p => players.push(p))
        if (!players.length) return
        var player = players[Math.floor(Math.random() * players.length)]
        cvCreate(player.level, player, null, null)
    } catch (err) {
        global.tfgLogError("tfg caravans", "розыгрыш каравана", err)
    }
})

ServerEvents.commandRegistry(event => {
  try {
      var Commands = event.commands
      var cmd = Commands.literal("tfgcaravan").requires(src => src.hasPermission(2))
          .executes(ctx => cvCmd(ctx, null, null))
          .then(Commands.literal("river").executes(ctx => cvRiverCmd(ctx)))
          .then(Commands.literal("list").executes(ctx => {
              if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
              var visits = gsLoad()
              var lines = []
              for (var id in visits) {
                  var v = visits[id]
                  if (!v.caravan) continue
                  var pos = v.spawned ? v.center : cvVirtualPos(v, Number(ctx.source.getLevel().getTime()))
                  lines.push(id + ": " + trFaction(v.faction).name + ", тир " + v.tier + ", " + v.transport +
                      (v.spawned ? ", в мире" : ", виртуально") + ", " + Math.floor(pos.x) + " " + Math.floor(pos.z))
              }
              ctx.source.sendSuccess(Text.of(lines.length ? lines.join("\n") : "Караванов нет."), false)
              return 1
          }))
          .then(Commands.literal("clear").executes(ctx => {
              if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
              var visits = gsLoad()
              var n = 0
              Object.keys(visits).forEach(id => {
                  if (!visits[id].caravan) return
                  gsEndVisit(visits[id], "команда /tfgcaravan clear")
                  n++
              })
              ctx.source.sendSuccess(Text.of("Убрано караванов: " + n), false)
              return 1
          }))
      global.TFG_FACTIONS.list.forEach(f => {
          if (f.id === "bandits") return
          var node = Commands.literal(f.id).executes(ctx => cvCmd(ctx, f.id, null))
          ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(tier => node.then(Commands.literal(String(tier)).executes(ctx => cvCmd(ctx, f.id, tier))))
          cmd.then(node)
      })
      event.register(cmd)
  } catch (err) {
    console.error("[caravans] ошибка регистрации команд: " + err)
  }
})

/**
 * /tfgcaravan river - проверка мостов: пеший караван встаёт в 6 блоках перед игроком и идёт туда, куда
 * игрок смотрит (встань у реки лицом к ней). Каждая проверка воды и стройка моста - в лог сервера
 * с пометкой [tfg bridges].
 */
function cvRiverCmd(ctx) {
    if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
    try {
        var player = ctx.source.getPlayerOrException()
        var level = player.level
        var look = player.getLookAngle()
        var l = Math.sqrt(Number(look.x) * Number(look.x) + Number(look.z) * Number(look.z))
        if (l < 0.1) { ctx.source.sendFailure(Text.of("Смотри вдоль земли, в сторону реки.")); return 1 }
        var dx = Number(look.x) / l, dz = Number(look.z) / l
        var npc = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits")
        var faction = npc[Math.floor(Math.random() * npc.length)]
        var now = Number(level.getTime())
        var sx = player.getX() + dx * 6, sz = player.getZ() + dz * 6
        var id = "cv" + now + "_river"
        var v = {
            id: id, caravan: true, faction: faction.id, tier: 2, transport: "foot", dim: String(level.getDimension()),
            route: { x: sx, z: sz, dx: dx, dz: dz, since: now },
            center: { x: Math.floor(sx), y: 64, z: Math.floor(sz) }, arrive: { x: sx, y: 64, z: sz },
            phase: "stay", since: now, until: now + CV_LIFE_TICKS, spawned: false, debugBridge: true,
            trader: null, guards: [], crafts: [], carts: [], horses: [], hostile: null, raid: false, kindName: null,
        }
        gsLoad()[id] = v
        cvSpawn(v, level, now)
        gsSave()
        cvLog(id + ": проверочный караван у реки, курс " + dx.toFixed(2) + " " + dz.toFixed(2))
        ctx.source.sendSuccess(Text.of("Караван " + faction.name + " идёт туда, куда ты смотришь. Лог: [tfg bridges] в консоли сервера."), false)
    } catch (e) {
        ctx.source.sendFailure(Text.of("Ошибка /tfgcaravan river: " + String(e).substring(0, 200)))
    }
    return 1
}

/** /tfgcaravan [фракция] [тир]: караван появится рядом и поедет мимо. */
function cvCmd(ctx, factionId, tier) {
    if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
    try {
        var player = ctx.source.getPlayerOrException()
        var err = cvCreate(player.level, player, factionId, tier)
        if (err) ctx.source.sendFailure(Text.of("Не вышло: " + err))
        else ctx.source.sendSuccess(Text.of("Караван в пути - встретится неподалёку."), false)
    } catch (e) {
        ctx.source.sendFailure(Text.of("Ошибка /tfgcaravan: " + String(e).substring(0, 200)))
    }
    return 1
}
