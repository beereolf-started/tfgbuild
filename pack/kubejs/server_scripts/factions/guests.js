// priority: 0
"use strict";

/**
 * ГОСТИ ФРАКЦИЙ: ОТРЯД, ТРАНСПОРТ, ЗАНЯТИЯ В ПОСЕЛЕНИИ, ЗАЩИТА СВОИХ.
 *
 * Визит (global.TFG_GUESTS.visit) - торговец (factions/trader.js) и охрана. Охрана - хаски в металле тира и в
 * крашеной под фракцию куртке; размер отряда - по стоимости товара торговца: от двух медных гоплитов, до 8 человек.
 * Транспорт по тиру игрока: 1-2 пешком, 3-4 повозки TFCAstikorCarts (лошадь идёт за возницей, торговец в повозке),
 * 5 дирижабль, 6-7 грузовой дирижабль, 8+ боевой. Полёт - свой простой ИИ (к площадке и обратно); у бандитов
 * в tfg/air_raiders_debug.js свой, отсюда берутся только его низкоуровневые функции (summon, посадка, ввод, двигатель).
 * Прибывают к ближайшей к центру поселения удобной точке (для аппаратов - ровная площадка).
 *
 * Пока визит идёт (сутки торговца), охрана занята: ест, рыбачит у воды, греется у костров, печей и очагов TFC
 * (разжигает), сидит на стульях Macaw. Первый страж - телохранитель, не отходит от торговца. Из аппаратов выходят все.
 * Места ищутся в кубе 500x500x500 вокруг центра по загруженным чанкам, понемногу за тик (палитра секций, maybeHas).
 * Ударил игрок торговца, стража или лошадь - весь отряд нападает на игроков его фракции (factions/settlements.js)
 * на GS_HOSTILE_TICKS; бой - боевой ИИ рейдеров (raidCombatTick, выстрелы - raidFireTick в tfg/raids.js).
 *
 * Хранение: визиты - JSON в данных сервера (tfg_guest_visits), у сущностей - tfg_guest_visit и роль в persistentData.
 * Стражи разговаривают по двое (реплики над головой, жесты). Сломал или угнал транспорт, убил лошадь - тоже вражда.
 * В свой транспорт садятся только в дорогу, чужой (даже союзный) не трогают; враждебный отряд угоняет аппараты игроков.
 * В непогоду бегут под крышу. Бормочут себе под нос (GS_MONO). Добыча - factions/guest_loot.js.
 * Потери 60% охраны - бегство. Стражи сами нападают на разбойников, монстров и отряды фракций, с которыми вражда (< -75).
 * Раз в неделю TFC у каждого поселения - случайный день визита (шанс GS_WEEKLY_CHANCE); враждебная фракция приходит налётом.
 * Команды (оператор): /tfgguests list | clear | leave | places | who | plan | event | raid <фракция> [тир] |
 * do <sit|warm|fish|eat|wander|talk>. Визит вызывает /tfgtrader.
 */

const GS_UUID = Java.loadClass("java.util.UUID")
const GS_HashMap = Java.loadClass("java.util.HashMap")
const GS_HEIGHT = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types").MOTION_BLOCKING_NO_LEAVES
const GS_RandomStrollGoal = Java.loadClass("net.minecraft.world.entity.ai.goal.RandomStrollGoal")
const GS_MoveThroughVillageGoal = Java.loadClass("net.minecraft.world.entity.ai.goal.MoveThroughVillageGoal")
const GS_CampfireBlock = Java.loadClass("net.minecraft.world.level.block.CampfireBlock")
const GS_FurnaceBlock = Java.loadClass("net.minecraft.world.level.block.AbstractFurnaceBlock")
const GS_FirepitBlock = Java.loadClass("net.dries007.tfc.common.blocks.devices.FirepitBlock")
const GS_ChairBlock = Java.loadClass("com.mcw_tfc_aio.arcwolf.objects.Chair")

const GS_MAX_GUARDS = 8
const GS_GUARD_SPEED = 0.32         // скорость шага (хаск - 0.23, рейдер - 0.26); в опасности - бег (setSprinting, +30%)
const GS_ARRIVE_DIST = 80           // откуда приходят пешие и повозки
const GS_FLY_DIST = 90              // где появляются аппараты
const GS_TRAVEL_TIMEOUT = 6000      // 5 минут в пути - дальше переносим к точке прибытия
const GS_BOARD_TIMEOUT = 1200       // минута на посадку при отъезде
const GS_AWAY_DIST = 600            // точка, к которой уходят (исчезают раньше)
const GS_VANISH_MIN = 40            // ближе к центру не исчезают, даже если не видно
const GS_DEPART_TIMEOUT = 12000     // 10 минут: не видно - исчезают, где бы ни были
const GS_ALWAYS_SEEN = 16           // ближе - видно всегда
const GS_VIEW_DIST = 256
const GS_VIEW_COS = 0.45            // половина поля зрения ~63 градуса, с запасом
const GS_HOSTILE_TICKS = 2400       // 2 минуты мести после удара
const GS_SCAN_HALF = 250            // куб 500x500x500
const GS_SCAN_CHUNKS_PER_TICK = 3
const GS_SCAN_SECTIONS_PER_TICK = 2
const GS_POI_LIMIT = 300
const GS_LEG = 32                   // путь дальше - отрезками (навигация хаска не строит длинных путей)
const GS_FOODS = ["tfc:food/wheat_bread", "tfc:food/cooked_beef", "tfc:food/cooked_pork", "tfc:food/barley_bread", "tfc:food/cheese"]

var GS_SERVER = null
var GS_VISITS = null                // id -> запись (сохраняется)
var GS_RT = {}                      // id -> { crafts: [], scan, pois, guards: { uuid -> занятие } }
var GS_ENT = {}                     // uuid -> сущность
var GS_GUARD_PENDING = null

function gsLog(msg) { global.tfgLog("tfg guests", msg) }
function gsErr(msg, e) { global.tfgLogError("tfg guests", msg, e) }

function gsLoad() {
    if (GS_VISITS) return GS_VISITS
    var pd = GS_SERVER.persistentData
    try { GS_VISITS = pd.contains("tfg_guest_visits") ? JSON.parse(String(pd.getString("tfg_guest_visits"))) : {} } catch (e) { GS_VISITS = {} }
    return GS_VISITS
}
function gsSave() { GS_SERVER.persistentData.putString("tfg_guest_visits", JSON.stringify(GS_VISITS || {})) }
function gsRt(id) { return GS_RT[id] || (GS_RT[id] = { crafts: null, scan: null, pois: { chairs: [], fires: [], waters: [], stats: {} }, acts: {}, topics: {} }) }

function gsLevel(v) { return GS_SERVER.getLevel(v.dim) }

function gsEntity(v, uuid) {
    if (!uuid) return null
    var e = GS_ENT[uuid]
    if (e && !e.isRemoved()) return e.isAlive() ? e : null
    try {
        e = gsLevel(v).getEntity(GS_UUID.fromString(uuid))
    } catch (err) { e = null }
    if (e) GS_ENT[uuid] = e
    return e && e.isAlive() ? e : null
}

function gsDist2(e, x, z) { var dx = e.getX() - x, dz = e.getZ() - z; return dx * dx + dz * dz }
function gsNow(level) { return Number(level.getTime()) }
function gsSurface(level, x, z) { return Number(level.getHeight(GS_HEIGHT, Math.floor(x), Math.floor(z))) }

var GS_MOVE = {}                     // uuid -> { gx, gz, speed, px, pz, pt, stuck, fails, detour, gaveUp }

/**
 * Идти к точке; далеко - отрезками по GS_LEG. Навигация мобов считает столбы, лестницы и опоры Create проходимыми
 * (не полный блок) и упирается в них - gsStuckCheck замечает, что страж стоит, и уводит его в обход (detour).
 */
function gsWalk(e, x, y, z, speed) {
    var nav = e.getNavigation()
    var u = String(e.uuid)
    var m = GS_MOVE[u] || (GS_MOVE[u] = { fails: 0 })
    if (m.gx === undefined || Math.pow(m.gx - x, 2) + Math.pow(m.gz - z, 2) > 9) { m.fails = 0; m.detour = null }
    m.gx = x
    m.gz = z
    m.speed = speed
    var now = Number(e.level.getTime())
    m.at = now
    if (m.detour && now < m.detour.until && gsDist2(e, m.detour.x, m.detour.z) > 2.25) {
        nav.moveTo(m.detour.x, m.detour.y, m.detour.z, speed)
        return
    }
    m.detour = null
    var dx = x - e.getX()
    var dz = z - e.getZ()
    var d = Math.sqrt(dx * dx + dz * dz)
    if (d > GS_LEG + 4) {
        x = e.getX() + dx / d * GS_LEG
        z = e.getZ() + dz / d * GS_LEG
        y = gsSurface(e.level, x, z)
    }
    nav.moveTo(x, y, z, speed)
}

/** Раз в секунду: идёт к цели, но за 2 секунды почти не сдвинулся - прыжок и обход сбоку; 6 неудач подряд - сдаётся. */
function gsStuckCheck(e, now) {
    var u = String(e.uuid)
    var m = GS_MOVE[u]
    if (!m || m.gx === undefined || e.isPassenger()) return
    if (gsDist2(e, m.gx, m.gz) < 6.25) { m.stuck = 0; m.fails = 0; m.gaveUps = 0; return }
    // идёт: путь в работе или идти велели недавно (путь мог не построиться вовсе)
    if (e.getNavigation().isDone() && now - (m.at || 0) > 120) { m.pt = 0; return }
    if (!m.pt || now - m.pt >= 40) {
        var moved = m.pt ? gsDist2(e, m.px, m.pz) : 99
        m.px = e.getX()
        m.pz = e.getZ()
        m.pt = now
        if (moved > 0.6) { m.stuck = 0; return }
        try { e.getJumpControl().jump() } catch (err) { }
        m.fails++
        if (m.fails >= 6) {
            m.gaveUp = now
            m.fails = 0
            m.detour = null
            e.getNavigation().stop()
            // второй раз подряд никуда не дошёл - заперт (башня, лаз ползком, яма): вытаскиваем к цели
            m.gaveUps = (m.gaveUps || 0) + 1
            if (m.gaveUps >= 2 && gsDist2(e, m.gx, m.gz) > 64) {
                m.gaveUps = 0
                var out = gsNearestStand(e.level, Math.floor(m.gx), Math.floor(m.gz), 8)
                if (out) {
                    gsTp(e.level, e, out.x, out.y, out.z)
                    gsLog("вытащил запертого гостя " + u.substring(0, 8) + " к " + Math.floor(out.x) + " " + Math.floor(out.z))
                }
            }
            return
        }
        // обход: вбок от направления на цель (сторона чередуется), чуть назад, дальше с каждой неудачей
        var dx = m.gx - e.getX(), dz = m.gz - e.getZ(), d = Math.sqrt(dx * dx + dz * dz) || 1
        var side = m.fails % 2 === 0 ? 1 : -1
        var off = 3 + m.fails * 1.5
        var px = e.getX() - dz / d * off * side - dx / d * 1.5
        var pz = e.getZ() + dx / d * off * side - dz / d * 1.5
        var s = gsNearestStand(e.level, Math.floor(px), Math.floor(pz), 3)
        m.detour = { x: s.x, y: s.y, z: s.z, until: now + 100 }
        e.getNavigation().moveTo(s.x, s.y, s.z, m.speed || 1)
    }
}

function gsTp(level, e, x, y, z) {
    GS_SERVER.runCommandSilent("execute in " + String(level.getDimension()) + " run tp " + String(e.uuid) + " " + x.toFixed(2) + " " + y + " " + z.toFixed(2))
}

function gsStandable(level, x, z) {
    var y = gsSurface(level, x, z)
    if (y <= Number(level.getMinBuildHeight()) + 1) return null
    var id = String(level.getBlock(Math.floor(x), y - 1, Math.floor(z)).id)
    if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0 || id.indexOf("leaves") >= 0) return null
    try { if (global.TFG_ON_ROOF(level, x, y, z)) return null } catch (e) { }   // на крышах не стоим
    return { x: Math.floor(x) + 0.5, y: y, z: Math.floor(z) + 0.5 }
}

/** Ближайшая к центру точка, где можно стоять (кольца через 2 блока). */
function gsNearestStand(level, cx, cz, maxR) {
    for (var r = 0; r <= maxR; r += 2) {
        for (var i = -r; i <= r; i += 2) {
            for (var j = -r; j <= r; j += 2) {
                if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue
                var s = gsStandable(level, cx + i, cz + j)
                if (s) return s
            }
        }
    }
    return { x: cx + 0.5, y: gsSurface(level, cx, cz), z: cz + 0.5 }
}

// ─── Охрана ──────────────────────────────────────────────────────────────────

const GS_METAL_BY_TIER = ["copper", "copper", "bronze", "wrought_iron", "steel", "black_steel", "blue_steel"]

function gsMetal(tier) {
    if (tier >= 6) return Math.random() < 0.5 ? "blue_steel" : "red_steel"
    return GS_METAL_BY_TIER[Math.max(1, tier)]
}

// роль: с какого тира, чем вооружён
const GS_ROLES = [
    { id: "hoplite", minTier: 1, weight: 4, main: m => "tfc:metal/javelin/" + m, off: m => "tfc:metal/shield/" + m },
    { id: "swordsman", minTier: 2, weight: 3, main: m => "gtceu:" + m + "_sword", off: m => "tfc:metal/shield/" + m },
    { id: "maceman", minTier: 3, weight: 2, main: m => "tfc:metal/mace/" + m, off: m => null },
    { id: "archer", minTier: 2, weight: 2, main: m => "minecraft:bow", off: m => null },
    { id: "crossbowman", minTier: 3, weight: 2, main: m => "minecraft:crossbow", off: m => null },
]

function gsSquadSize(value, tier) {
    var extra = value > 500 ? Math.floor(Math.log(value / 500) / Math.log(2)) + 1 : 0
    return Math.max(2, Math.min(GS_MAX_GUARDS, 2 + tier, 2 + extra))
}

function gsPickRole(index, tier) {
    if (index < 2) return GS_ROLES[0]                        // первыми всегда гоплиты
    var list = GS_ROLES.filter(r => r.minTier <= tier)
    var total = list.reduce((s, r) => s + r.weight, 0)
    var roll = Math.random() * total
    for (var i = 0; i < list.length; i++) { roll -= list[i].weight; if (roll <= 0) return list[i] }
    return list[0]
}

function gsItem(id) { return id && trValidItem(id) ? id : null }

function gsSpawnGuard(v, level, x, y, z, index) {
    var faction = trFaction(v.faction)
    var color = trColor(faction)
    var m = gsMetal(v.tier)
    var role = gsPickRole(index, v.tier)
    var main = gsItem(role.main(m)) || gsItem("tfc:metal/javelin/" + m) || "tfc:metal/javelin/copper"
    var off = gsItem(role.off(m))
    var piece = (kind) => gsItem("tfc:metal/" + kind + "/" + m) ? '{id:"tfc:metal/' + kind + '/' + m + '",Count:1b}' : "{}"
    var name = JSON.stringify(JSON.stringify({ text: "Страж · " + faction.name, color: color.text }))
    var hp = 20 + 4 * v.tier
    var nbt = "{Tags:[\"tfg_npc\",\"tfg_guest\",\"tfg_faction:" + faction.id + "\"],PersistenceRequired:1b,CanPickUpLoot:0b," +
        "CustomName:" + name + ",Health:" + hp + "f," +
        "Attributes:[{Name:\"minecraft:generic.max_health\",Base:" + hp + "d},{Name:\"minecraft:generic.follow_range\",Base:64d}," +
        "{Name:\"minecraft:zombie.spawn_reinforcements\",Base:0d}]," +
        "ArmorItems:[" + piece("boots") + "," + piece("greaves") + "," + trLeather("leather_chestplate", color.hex) + "," + piece("helmet") + "]," +
        "ArmorDropChances:[0f,0f,0f,0f],HandItems:[{id:\"" + main + "\",Count:1b}," + (off ? "{id:\"" + off + "\",Count:1b}" : "{}") + "]," +
        "HandDropChances:[0f,0f]}"
    GS_GUARD_PENDING = { visit: v.id, role: index === 0 ? "bodyguard" : "guard", entity: null }
    try {
        GS_SERVER.runCommandSilent("execute in " + v.dim + " run summon minecraft:husk " + x.toFixed(2) + " " + y + " " + z.toFixed(2) + " " + nbt)
        return GS_GUARD_PENDING.entity
    } finally {
        GS_GUARD_PENDING = null
    }
}

var GS_GOAL_FIELDS = null
function gsGoalFields(e) {
    if (!GS_GOAL_FIELDS) {
        var c = e.getClass()
        while (c && String(c.getName()) !== "net.minecraft.world.entity.Mob") c = c.getSuperclass()
        var gf = c.getDeclaredField("f_21345_")
        var tf = c.getDeclaredField("f_21346_")
        gf.setAccessible(true)
        tf.setAccessible(true)
        GS_GOAL_FIELDS = [gf, tf]
    }
    return GS_GOAL_FIELDS
}

/** Страж: сам никого не выбирает целью и не бродит; нападает, только когда цель ставит скрипт. */
function gsSetupGuard(e) {
    gsHuskVoice(e)
    var f = gsGoalFields(e)
    f[1].get(e).removeAllGoals(g => true)
    f[0].get(e).removeAllGoals(g => g instanceof GS_RandomStrollGoal || g instanceof GS_MoveThroughVillageGoal)
    e.setTarget(null)
    if (typeof raidSetupAi === "function") raidSetupAi(e)     // стрелкам - без рукопашной цели зомби
    try { e.setAttributeBaseValue("minecraft:generic.movement_speed", GS_GUARD_SPEED) } catch (err) { }
}

/** Лошадь повозки: без своих целей, ходит, куда ведёт скрипт. */
function gsSetupHorse(e) {
    var f = gsGoalFields(e)
    f[0].get(e).removeAllGoals(g => true)
    f[1].get(e).removeAllGoals(g => true)
}

EntityEvents.spawned(event => {
    var e = event.entity
    try {
        if (GS_GUARD_PENDING && !GS_GUARD_PENDING.entity && String(e.type) === "minecraft:husk" && e.getTags().contains("tfg_guest")) {
            GS_GUARD_PENDING.entity = e
            e.persistentData.putString("tfg_guest_visit", GS_GUARD_PENDING.visit)
            e.persistentData.putString("tfg_guest_role", GS_GUARD_PENDING.role)
            // одноразовое имя: стражей никто не запоминает, в базу личностей они не попадают
            try { e.persistentData.putString("tfg_npc_name", global.TFG_NPC.guardName()) } catch (err) { }
        }
        var pd = e.persistentData
        if (!pd.contains("tfg_guest_visit")) return
        if (!GS_SERVER) return
        var v = gsLoad()[String(pd.getString("tfg_guest_visit"))]
        if (!v) {
            // визит давно закончился, а сущность лежала в незагруженном чанке
            if (!e.getTags().contains("tfg_trader")) e.discard()
            return
        }
        GS_ENT[String(e.uuid)] = e
        var role = String(pd.getString("tfg_guest_role"))
        if (role === "horse") gsSetupHorse(e)
        else if (String(e.type) === "minecraft:husk" && e.getTags().contains("tfg_guest")) gsSetupGuard(e)
        else if (e.getTags().contains("tfg_trader")) { try { e.setAttributeBaseValue("minecraft:generic.movement_speed", GS_GUARD_SPEED) } catch (err) { } }
    } catch (err) {
        gsErr("появление гостя", err)
    }
})

// ─── Транспорт ───────────────────────────────────────────────────────────────

function gsTransport(tier) {
    if (tier >= 8) return "warship"
    if (tier >= 6) return "cargo_airship"
    if (tier >= 5) return "airship"
    if (tier >= 3) return "cart"
    return "foot"
}

/** summon с NBT; сущность ловит EntityEvents.spawned из tfg/air_raiders_debug.js (AIR_capture). */
function gsSummonNbt(level, type, x, y, z, nbt) {
    AIR_capture = { type: type, entity: null }
    try {
        GS_SERVER.runCommandSilent("execute in " + String(level.getDimension()) + " run summon " + type + " " + x + " " + y + " " + z + " " + nbt)
        return AIR_capture.entity
    } finally {
        AIR_capture = null
    }
}

function gsTag(e, v, role) {
    e.persistentData.putString("tfg_guest_visit", v.id)
    e.persistentData.putString("tfg_guest_role", role)
    GS_ENT[String(e.uuid)] = e
}

function gsCraftRt(vehicle, type) {
    return { vehicle: vehicle, type: type, inputs: [0, 0, 0], ticks: 0, yawSign: -1, vSign: 1, mode: "ai", goal: null, landed: false }
}

/** Свой пилот: к цели на высоте над рельефом; land - сесть на цель, иначе лететь мимо. Считается раз в 2 тика. */
function gsFly(c) {
    var v = c.vehicle
    var g = c.goal
    if (!g) { airApply(c, 0, 0, 0); return }
    var vx = v.getX(), vy = v.getY(), vz = v.getZ()
    var yaw = v.getYaw()
    var hx = g.x - vx
    var hz = g.z - vz
    var d = Math.sqrt(hx * hx + hz * hz)
    if (g.land && d <= 3 && (v.onGround() || vy - g.y < 1.2)) {
        airApply(c, 0, 0, 0)
        c.mode = "idle"
        c.landed = true
        return
    }
    var need = aiTerrainNeed(v.level, vx, vz, yaw)
    var ty, fwd = 0, x = 0
    if (!g.land || d > 3) {
        ty = Math.max(g.land ? g.y + 10 : g.y, need)
        var err = airWrap(Math.atan2(-hx, hz) * 180 / AIR_PI - yaw)
        x = airClamp(err / 25) * c.yawSign
        fwd = Math.abs(err) > 60 ? 0.15 : (g.land ? airClamp(d / 14) * 0.85 : 1)
        if (need > vy + 4) fwd = Math.min(fwd, 0)
        else if (need > vy + 1) fwd = Math.min(fwd, 0.2)
    } else {
        ty = g.y
    }
    var y = airClamp((ty - vy) / 4) * c.vSign
    if (g.land && d <= 3 && y < -0.5) y = -0.5
    airApply(c, x, y, fwd)
}

const GS_LANDING_GAP = 18           // между площадками аппаратов, блоков

/** Ровная площадка не ближе GS_LANDING_GAP к уже занятым: кольцо точек вокруг точки прибытия. */
function gsSeparateLanding(level, v, taken, half) {
    for (var r = GS_LANDING_GAP; r <= GS_LANDING_GAP * 3; r += 6) {
        for (var a = 0; a < 12; a++) {
            var ang = a * 0.5235987755982988
            var s = aiFindLanding(level, v.arrive.x + Math.cos(ang) * r, v.arrive.z + Math.sin(ang) * r, half)
            if (!s) continue
            var ok = taken.every(t => Math.pow(t.x - s.x, 2) + Math.pow(t.z - s.z, 2) >= GS_LANDING_GAP * GS_LANDING_GAP)
            if (ok) return { x: s.x, y: s.y, z: s.z }
        }
    }
    var ang2 = taken.length * 2.1
    var px = v.arrive.x + Math.cos(ang2) * GS_LANDING_GAP * 1.5, pz = v.arrive.z + Math.sin(ang2) * GS_LANDING_GAP * 1.5
    return { x: px, y: gsSurface(level, px, pz), z: pz }
}

/** Все выходят из аппарата (и стрелок, и пилот) и встают вокруг, дальше габарита, чтобы IA не усадил обратно. */
function gsUnload(v, level, c) {
    var gap = v.transport === "warship" ? 9 : 6
    airPassengers(c.vehicle).forEach((p, i) => {
        p.stopRiding()
        var a = i * 6.283185307179586 / 8
        var px = c.vehicle.getX() + Math.cos(a) * gap, pz = c.vehicle.getZ() + Math.sin(a) * gap
        gsTp(level, p, px, gsSurface(level, px, pz), pz)
    })
    c.unloaded = true
}

/** Пустырь для посадки у крепости поселения, к которому летит караван (запись улицы). */
function gsSettlementLanding(v) {
    if (!v.settlement) return null
    try {
        var vill = global.TFG_SETTLERS.list()[v.settlement]
        var st = vill ? global.TFG_STREET.list()[vill.settlement] : null
        return st && st.landing ? st.landing : null
    } catch (e) { return null }
}

function gsSpawnAir(v, level, riders) {
    var rt = gsRt(v.id)
    rt.crafts = []
    v.crafts = []
    var half = v.transport === "warship" ? 3 : 2
    // в поселение NPC - на пустырь у крепости (street.js, landing), а не куда придётся
    var pad = gsSettlementLanding(v)
    if (pad) v.arrive = { x: pad.x, y: gsSurface(level, pad.x, pad.z), z: pad.z }
    var landing = aiFindLanding(level, v.arrive.x, v.arrive.z, half) || v.arrive
    v.arrive = { x: landing.x, y: landing.y, z: landing.z }
    var spots = []
    v.spots = spots
    var ang = v.fromAng !== undefined && v.fromAng !== null ? v.fromAng : Math.random() * 6.283185307179586
    var queue = riders.slice()
    for (var k = 0; k < 3 && queue.length > 0; k++) {
        var sx = Math.floor(v.arrive.x + Math.cos(ang + k * 0.3) * GS_FLY_DIST)
        var sz = Math.floor(v.arrive.z + Math.sin(ang + k * 0.3) * GS_FLY_DIST)
        var sy = Math.max(gsSurface(level, sx, sz) + 20, v.arrive.y + 25)
        var craft = airSummon(level, "immersive_aircraft:" + v.transport, sx, sy, sz, ["tfg_npc", "tfg_guest_craft"])
        if (!craft) break
        gsTag(craft, v, "craft")
        try { airRefuel(craft) } catch (e) { }
        var seats = 1
        try { seats = Math.max(1, Number(craft.getPassengerSpace())) } catch (e) { }
        var c = gsCraftRt(craft, v.transport)
        var spot = k === 0 ? v.arrive : gsSeparateLanding(level, v, spots, half)
        spots.push(spot)
        c.goal = { x: spot.x, y: spot.y, z: spot.z, land: true }
        c.spot = k
        for (var s = 0; s < seats && queue.length > 0; s++) {
            var r = queue.shift()
            gsTp(level, r, craft.getX(), Math.floor(craft.getY()) + 1, craft.getZ())
            if (!airMount(r, craft)) { queue.unshift(r); break }
            r.persistentData.putInt("tfg_guest_craft", k)
        }
        rt.crafts.push(c)
        v.crafts.push(String(craft.uuid))
    }
    // не поместились - идут пешком от точки появления
    queue.forEach(r => r.persistentData.putInt("tfg_guest_craft", -1))
    return rt.crafts.length
}

function gsSpawnCarts(v, level, trader, guards) {
    v.carts = []
    v.horses = []
    var n = v.tier >= 4 ? 2 : 1
    for (var i = 0; i < n; i++) {
        var driver = guards[Math.min(guards.length - 1, 1 + i)] || trader
        var x = driver.getX() - 2 - i * 5, z = driver.getZ() - 2
        var y = gsSurface(level, x, z)
        // телега - ровно позади лошади по ходу движения: упрётся в рельеф - Astikor отцепит (shouldRemovePulling)
        var ux = v.arrive.x - x, uz = v.arrive.z - z, ul = Math.sqrt(ux * ux + uz * uz) || 1
        var cx = x - ux / ul * 2.2, cz = z - uz / ul * 2.2
        // Astikor запрягает только осёдланное и приручённое (AbstractDrawnEntity.canPull)
        var horse = gsSummonNbt(level, "tfc:horse", Math.floor(x), y, Math.floor(z),
            '{Tags:["tfg_npc","tfg_guest_horse"],Tame:1b,SaddleItem:{id:"minecraft:saddle",Count:1b},PersistenceRequired:1b}')
        var cart = airSummon(level, "tfcastikorcarts:" + (i === 0 ? "animal_cart" : "supply_cart") + "/oak", cx.toFixed(2), Math.max(y, gsSurface(level, cx, cz)), cz.toFixed(2), ["tfg_npc"])
        if (!horse || !cart) {
            if (horse) horse.discard()
            if (cart) cart.discard()
            gsLog("повозка не появилась - идут пешком")
            break
        }
        gsTag(horse, v, "horse")
        gsTag(cart, v, "cart")
        gsSetupHorse(horse)
        try { horse.equipSaddle(null) } catch (e) { }
        try { horse.setTamed(true) } catch (e) { }
        gsHitch(v, cart, horse)
        horse.persistentData.putString("tfg_guest_driver", String(driver.uuid))
        v.horses.push(String(horse.uuid))
        v.carts.push(String(cart.uuid))
        if (i === 0 && trader) GS_SERVER.runCommandSilent("ride " + String(trader.uuid) + " mount " + String(cart.uuid))
    }
}

/**
 * Запрячь. Astikor отцепляет упряжь, если телега отстала больше чем на pullingDistanceModifier (TFCAstikorCarts, 2 блока)
 * или упёрлась в препятствие. Лошадь поэтому ждёт телегу (gsCartTick), а упряжь восстанавливается каждый тик, пока телега
 * рядом. Звук пристёгивания мод играет только у сущностей старше 20 тиков - на время вызова счётчик тиков занижаем.
 */
function gsHitch(v, cart, horse) {
    if (cart.getPulling()) return true
    var age = cart.tickCount
    try { cart.tickCount = 1 } catch (e) { }
    try { cart.setPulling(horse) } catch (e) { gsErr("упряжка", e) }
    try { cart.tickCount = age } catch (e) { }
    var ok = !!cart.getPulling()
    var rt = gsRt(v.id)
    rt.hitchLog = rt.hitchLog || {}
    var key = String(cart.uuid)
    if (!ok && !rt.hitchLog[key]) {
        rt.hitchLog[key] = true
        gsLog(v.id + ": лошадь не запряглась - осёдлана " + horse.isSaddled() + ", верхом " + horse.isPassenger())
    }
    return ok
}

/** Каждый тик для повозок: запрячь, если телега рядом; отстала - лошадь стоит и ждёт; застряла надолго - подтянуть. */
function gsCartTick(v, rt, tick) {
    rt.horseWait = rt.horseWait || {}
    v.carts.forEach((u, i) => {
        var cart = gsEntity(v, u), horse = gsEntity(v, v.horses[i])
        if (!cart || !horse) return
        var hu = v.horses[i]
        var d2 = Math.pow(cart.getX() - horse.getX(), 2) + Math.pow(cart.getZ() - horse.getZ(), 2)
        if (d2 > 3.2 * 3.2) {
            if (!rt.horseWait[hu]) rt.horseWait[hu] = tick
            horse.getNavigation().stop()
            if (tick - rt.horseWait[hu] > 200) {        // 10 секунд не догоняет - ставим телегу за лошадью
                gsTp(cart.level, cart, horse.getX() - 1.8, Math.floor(horse.getY()), horse.getZ())
                rt.horseWait[hu] = tick
            }
            return
        }
        delete rt.horseWait[hu]
        gsHitch(v, cart, horse)
    })
}

// ─── Визит ───────────────────────────────────────────────────────────────────

// Охотник, лесоруб, шахтёр и камнелом приходят одни: пешком, без охраны и обоза.
const GS_SOLO_KINDS = ["hunter", "lumberjack", "miner", "quarryman"]

function gsVisit(level, center, factionId, kindId, tier, opts) {
    var raid = !!(opts && opts.raid)
    if (!GS_SERVER) GS_SERVER = level.getServer()
    var visits = gsLoad()
    var id = "g" + Number(level.getTime()) + "_" + Math.floor(Math.random() * 1000)
    // ремесленник-одиночка; opts.caravan - тот же товар везёт торговец с охраной и обозом (/tfgtrader ... miner_trader)
    var solo = !raid && GS_SOLO_KINDS.indexOf(kindId) >= 0 && !(opts && (opts.settlement || opts.warband || opts.caravan))
    var transport = solo ? "foot" : gsTransport(tier)
    var arrive = gsNearestStand(level, Math.floor(center.x), Math.floor(center.z), 24)
    // откуда гость (молва, lore.js): ближние поселения фракции присылают людей чаще,
    // и приходят они со стороны дома. Нет поселения - из дальних краёв, с любой стороны.
    var origin = null
    try { origin = global.TFG_LORE.origin(level, factionId, center.x, center.z) } catch (e) { }
    var ang = origin
        ? Math.atan2(origin.z - center.z, origin.x - center.x) + (Math.random() - 0.5) * 0.8
        : Math.random() * 6.283185307179586
    var sx = arrive.x + Math.cos(ang) * GS_ARRIVE_DIST
    var sz = arrive.z + Math.sin(ang) * GS_ARRIVE_DIST
    var start = gsNearestStand(level, Math.floor(sx), Math.floor(sz), 16)
    var trader = null
    var value = 0
    if (!raid) {
        var err = trVisit(level, center, factionId, kindId, tier, { x: start.x, y: start.y, z: start.z, guest: id,
            person: opts && opts.person ? opts.person : null })
        if (err) return err
        trader = TR_LAST_ENTITY
        // оптовая поставка (factions/bulk.js): этот гость везёт заказ игрока
        if (opts && opts.bulk) trader.persistentData.putString("tfg_bulk_order", String(opts.bulk))
        GS_ENT[String(trader.uuid)] = trader
        if (origin) {
            trader.persistentData.putString("tfg_origin", String(origin.id))
            trader.persistentData.putString("tfg_origin_name", String(origin.name))
        }
        try { trader.setAttributeBaseValue("minecraft:generic.movement_speed", GS_GUARD_SPEED) } catch (e) { }
        try {
            JSON.parse(String(trader.persistentData.getString("tfg_trader_offers"))).forEach(o => value += o.price * o.stock)
        } catch (e) { }
    }
    var v = {
        id: id, faction: factionId, tier: tier, dim: String(level.getDimension()), transport: transport,
        center: { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }, arrive: arrive,
        phase: "travel", since: gsNow(level), until: trader ? Number(trader.persistentData.getLong("tfg_trader_until")) : gsNow(level) + GS_RAID_TICKS,
        trader: trader ? String(trader.uuid) : null, guards: [], crafts: [], carts: [], horses: [], hostile: null,
        raid: raid, raidPlayers: raid ? opts.players : null, origin: origin ? origin.id : null, fromAng: ang, kindName: raid ? null : global.TFG_TRADE_GOODS.kind(kindId).name,
    }
    if (raid) v.hostile = { players: opts.players, until: v.until }
    // торг в поселении (factions/fairs.js): гости идут к форту и ведут сцену с жителями
    if (opts && opts.settlement) { v.settlement = opts.settlement; v.settlementName = opts.name || null; v.homecoming = opts.homecoming || null; v.warband = opts.warband || null }
    visits[id] = v
    if (solo) { v.solo = true; v.kindId = kindId }
    if (opts && opts.bulk) v.bulk = String(opts.bulk)
    var size = raid ? Math.min(GS_MAX_GUARDS, 3 + tier) : solo ? 0 : gsSquadSize(value, tier)
    var guards = []
    for (var i = 0; i < size; i++) {
        var a = i * 6.283185307179586 / size
        var g = gsSpawnGuard(v, level, start.x + Math.cos(a) * 2.5, start.y, start.z + Math.sin(a) * 2.5, i)
        if (g) { guards.push(g); v.guards.push(String(g.uuid)); GS_ENT[String(g.uuid)] = g }
    }
    var how = "пешком"
    if (transport === "cart") {
        gsSpawnCarts(v, level, trader, guards)
        how = v.carts.length ? "на повозках (" + v.carts.length + ")" : "пешком (повозки не вышли)"
    } else if (transport !== "foot") {
        // первым садится страж - он пилот и остаётся на борту; торговец - в первый аппарат
        var n = gsSpawnAir(v, level, (guards.length ? [guards[0], trader].concat(guards.slice(1)) : [trader]).filter(e => e))
        how = n > 0 ? transport + " x" + n : "пешком (аппарат не вышел)"
    }
    v.startGuards = guards.length
    // караван родом из построенного поселения - это его люди: имена тех, кто там живёт (этап 0 плана NPC)
    if (!raid && origin && origin.village) {
        try {
            var crew = global.TFG_SETTLERS.crewOut(origin.village, id, guards.length)
            var who = [trader].concat(guards).filter(e => e)
            var ci = 0
            crew.forEach(c => {
                // торговец - на место торговца, остальные - на места стражей по порядку
                var e = c.role === "торговец" ? trader : guards[ci++]
                if (!e) return
                e.persistentData.putString("tfg_npc_name", c.name)
                e.persistentData.putString("tfg_crew_v", String(origin.village))
                e.persistentData.putString("tfg_crew_sid", c.id)
                e.addTag("tfg_crew")
            })
            if (crew.length) v.crewFrom = String(origin.village)
        } catch (e) { gsLog(id + ": караванщики: " + e) }
    }
    gsSave()
    gsLog(id + ": " + factionId + (origin ? " из " + origin.name : "") + " " + (raid ? "НАЛЁТ" : kindId) + ", тир " + tier + ", товар на " + value + ", охрана " + guards.length + ", " + how)
    var fname = gsFactionName(factionId)
    var ride = GS_TRANSPORT_TEXT[v.crafts.length ? transport : v.carts.length ? "cart" : "foot"]
    gsNotify(v, raid
        ? "§c[Налёт] §fВас рейдит фракция " + fname + "! Отряд " + guards.length + " чел., " + ride + " (тир " + tier + ")."
        : v.settlement ? "§6[Караван] §fК поселению «" + (v.settlementName || "?") + "» идёт караван фракции " + fname + ": " +
          v.kindName + ", охрана " + guards.length + " чел., " + ride + "."
        : "§6[Караван] §fК вам идёт караван фракции " + fname + ": " + v.kindName + " (тир " + tier + "), охрана " + guards.length +
          " чел., " + ride + ". Ждите у центра поселения.")
    return null
}

function gsEndVisit(v, why) {
    if (v.crewFrom) try { global.TFG_SETTLERS.crewHome(v.id) } catch (e) { }
    var rt = GS_RT[v.id]
    var all = [v.trader].concat(v.guards, v.crafts, v.carts, v.horses)
    all.forEach(u => {
        var e = gsEntity(v, u)
        if (e) {
            try { e.ejectPassengers() } catch (err) { }
            e.discard()
        }
        delete GS_ENT[u]
    })
    if (rt) Object.keys(rt.acts).forEach(u => delete rt.acts[u])
    delete GS_RT[v.id]
    delete GS_VISITS[v.id]
    gsSave()
    gsLog(v.id + ": визит окончен - " + why)
}

function gsSetPhase(v, phase, now) {
    v.phase = phase
    v.since = now
    gsSave()
    gsLog(v.id + ": " + phase)
}

// ─── Поиск мест: стулья и огонь в кубе 500 ───────────────────────────────────

var GS_KIND_CACHE = {}
const GS_SEAT_WORDS = ["chair", "stool", "bench", "sofa", "couch", "seat", "armchair"]

/**
 * Что это за блок для гостей (кэш по id): poi - "chairs" (сиденье) или "fires" (огонь), stats - что считать в поселении.
 * Слова id сравниваются целиком: "workbench" - не скамья, "oak_chair" - стул.
 */
function gsBlockInfo(state) {
    var b = state.getBlock()
    var key = String(b.getDescriptionId())
    var info = GS_KIND_CACHE[key]
    if (info) return info
    var parts = key.split(".")
    var ns = parts.length > 1 ? parts[1] : ""
    var words = key.split(/[._\/]/)
    var has = w => words.indexOf(w) >= 0
    var any = list => list.some(has)
    info = { poi: null, stats: [] }
    if (b instanceof GS_ChairBlock || (any(GS_SEAT_WORDS) && !any(["table", "desk", "counter", "workbench"]))) info.poi = "chairs"
    else if (b instanceof GS_CampfireBlock || b instanceof GS_FurnaceBlock || b instanceof GS_FirepitBlock) info.poi = "fires"
    if (/roof/.test(key)) info.stats.push("roofs")
    if (ns === "mcw_tfc_aio" && any(["table", "desk", "drawer", "wardrobe", "cupboard", "bookshelf", "counter", "chair", "stool"])) info.stats.push("furniture")
    if (any(["lantern", "lamp", "torch", "candle", "sconce", "chandelier"])) info.stats.push("lamps")
    if (any(["glass", "pane", "window"])) info.stats.push("glass")
    if (any(["brick", "bricks"])) info.stats.push("bricks")
    if ((ns === "gtceu" && any(["machine", "hull", "casing", "hatch", "bus", "generator", "turbine", "boiler"])) || ns === "create" || ns === "createaddition" || ns === "greate") info.stats.push("machines")
    if (has("farmland")) info.stats.push("farmland")
    if (any(["barrel", "chest", "vessel", "crate", "drawer", "shelf"])) info.stats.push("storage")
    GS_KIND_CACHE[key] = info
    return info
}

function gsPoiKind(state) { return gsBlockInfo(state).poi }

const GS_WATER_LIMIT = 400

function gsScanStep(v, level) {
    var rt = gsRt(v.id)
    if (!rt.scan) {
        var cx = v.center.x >> 4, cz = v.center.z >> 4, r = Math.ceil(GS_SCAN_HALF / 16)
        var list = []
        for (var i = -r; i <= r; i++) for (var j = -r; j <= r; j++) list.push([cx + i, cz + j])
        list.sort((a, b) => (Math.abs(a[0] - cx) + Math.abs(a[1] - cz)) - (Math.abs(b[0] - cx) + Math.abs(b[1] - cz)))
        rt.scan = { list: list, idx: 0, sec: 0, found: rt.pois }     // находки доступны сразу, до конца поиска
    }
    var sc = rt.scan
    if (sc.idx >= sc.list.length) return
    var chunks = 0, sections = 0
    while (sc.idx < sc.list.length && chunks < GS_SCAN_CHUNKS_PER_TICK && sections < GS_SCAN_SECTIONS_PER_TICK) {
        var cc = sc.list[sc.idx]
        var chunk = level.getChunkSource().getChunkNow(cc[0], cc[1])
        if (!chunk) { sc.idx++; sc.sec = 0; chunks++; continue }
        var secs = chunk.getSections()
        if (sc.sec === 0 && sc.found.waters.length < GS_WATER_LIMIT) {
            // вода: поверхность через 4 блока
            for (var wx = 2; wx < 16; wx += 4) for (var wz = 2; wz < 16; wz += 4) {
                var ax = cc[0] * 16 + wx, az = cc[1] * 16 + wz
                var h = gsSurface(level, ax, az)
                if (Math.abs(h - v.center.y) > GS_SCAN_HALF) continue
                if (String(level.getBlock(ax, h - 1, az).id).indexOf("water") >= 0) sc.found.waters.push([ax, h, az])
            }
        }
        while (sc.sec < secs.length && sections < GS_SCAN_SECTIONS_PER_TICK) {
            var s = secs[sc.sec]
            var baseY = Number(chunk.getSectionYFromSectionIndex(sc.sec)) * 16
            sc.sec++
            if (s.hasOnlyAir() || Math.abs(baseY + 8 - v.center.y) > GS_SCAN_HALF + 8) continue
            // палитра секции: подсчёт блоков поселения (быстро, в Java), позиции - только если есть сиденья или огонь
            var hasPoi = false
            try {
                s.getStates().count((state, n) => {
                    var info = gsBlockInfo(state)
                    if (info.poi) hasPoi = true
                    info.stats.forEach(k => { sc.found.stats[k] = (sc.found.stats[k] || 0) + Number(n) })
                })
            } catch (err) {
                if (!sc.countWarned) { sc.countWarned = true; gsErr("подсчёт блоков секции", err) }
                hasPoi = s.maybeHas(st => gsPoiKind(st) !== null)
            }
            if (!hasPoi) continue
            sections++
            for (var y = 0; y < 16; y++) for (var z = 0; z < 16; z++) for (var x = 0; x < 16; x++) {
                var kind = gsPoiKind(s.getBlockState(x, y, z))
                if (kind && sc.found[kind].length < GS_POI_LIMIT) sc.found[kind].push([cc[0] * 16 + x, baseY + y, cc[1] * 16 + z])
            }
        }
        if (sc.sec >= secs.length) { sc.idx++; sc.sec = 0; chunks++ }
    }
    if (sc.idx >= sc.list.length) {
        gsLog(v.id + ": найдено сидений " + sc.found.chairs.length + ", очагов " + sc.found.fires.length + ", мест у воды " + sc.found.waters.length +
            ", в поселении " + JSON.stringify(sc.found.stats))
    }
}

// ─── Занятия стражи ──────────────────────────────────────────────────────────

function gsNear(list, e, n) {
    return list.map(p => ({ p: p, d: gsDist2(e, p[0], p[2]) })).sort((a, b) => a.d - b.d).slice(0, n).map(o => o.p)
}

function gsIsNight(level) {
    var t = Number(level.getDayTime()) % 24000
    return isFinite(t) && t >= 13000 && t < 23000
}

function gsFree(e) {
    var sat = e.getVehicle()
    if (sat && String(sat.type) === "mcw_tfc_aio:chair") e.stopRiding()
}

function gsRestoreHands(e, a) {
    if (a && a.hand) {
        try { e.setMainHandItem(Item.of(a.hand)) } catch (err) { }
        a.hand = null
    }
}

function gsFinishAct(e, a) {
    if (a && a.id === "talk") gsQuiet(e, a)
    if (a && a.id === "shelter" && a.useMap && a.useMap[a.key]) { a.useMap[a.key]--; a.key = null }
    gsFree(e)
    try { e.stopUsingItem() } catch (err) { }
    gsRestoreHands(e, a)
}

function gsChooseAct(v, level, e, rt, now) {
    var pois = rt.pois
    var night = gsIsNight(level)
    var wet = !!(rt.weather && rt.weather.bad)
    var opts = [{ id: "wander", w: wet ? 0 : night ? 1 : 2 }, { id: "eat", w: 2 }, { id: "fish", w: night || wet ? 0 : 2 }]
    if (pois.chairs.length) opts.push({ id: "sit", w: 3 })
    if (pois.fires.length) opts.push({ id: "warm", w: night ? 8 : 3 })
    if (gsTalkPartner(v, rt, e, null)) opts.push({ id: "talk", w: 6 })
    var total = opts.reduce((s, o) => s + o.w, 0)
    var roll = Math.random() * total, pick = opts[0]
    for (var i = 0; i < opts.length; i++) { roll -= opts[i].w; if (roll <= 0) { pick = opts[i]; break } }
    var made = gsMakeAct(v, level, e, rt, now, pick.id)
    return made.act || gsMakeAct(v, level, e, rt, now, "eat").act
}

/** Занятие id для стража: { act } или { why } - почему нельзя. */
function gsMakeAct(v, level, e, rt, now, id) {
    var pois = rt.pois
    var a = { id: id, stage: "go", until: now + 2400, next: 0, started: now }
    if (id === "sit" || id === "warm") {
        var list = id === "sit" ? pois.chairs : pois.fires
        if (!list.length) return { why: (id === "sit" ? "стульев Macaw" : "костров, печей и очагов") + " в кубе 500 не найдено" + (rt.scan && rt.scan.idx < rt.scan.list.length ? " (поиск ещё идёт)" : "") }
        var near = gsNear(list, e, 6)
        var p = near[Math.floor(Math.random() * near.length)]
        a.poi = { x: p[0], y: p[1], z: p[2] }
        a.dur = id === "sit" ? 1200 + Math.floor(Math.random() * 2400) : 1800 + Math.floor(Math.random() * 1800)
    } else if (id === "fish") {
        var spot = gsFindWater(level, e, rt)
        if (!spot) return { why: "воды с берегом не найдено" + (rt.scan && rt.scan.idx < rt.scan.list.length ? " (поиск ещё идёт)" : "") }
        a.poi = spot
        a.dur = 2400 + Math.floor(Math.random() * 1200)
    } else if (id === "talk") {
        var partner = gsTalkPartner(v, rt, e, null)
        if (!partner) return { why: "поблизости нет свободного стража для разговора" }
        gsStartTalk(v, level, rt, e, partner, now)
        return { act: rt.acts[String(e.uuid)] }
    } else if (id === "eat") {
        a.dur = 160
        a.poi = null
    } else if (id === "wander") {
        var ang = Math.random() * 6.283185307179586, r = 6 + Math.random() * 30
        a.poi = gsNearestStand(level, Math.floor(v.center.x + Math.cos(ang) * r), Math.floor(v.center.z + Math.sin(ang) * r), 6)
        a.dur = 200 + Math.floor(Math.random() * 400)
    } else {
        return { why: "нет занятия " + id }
    }
    a.until = now + 2400 + (a.poi ? Math.floor(Math.sqrt(gsDist2(e, a.poi.x, a.poi.z)) * 12) : 0)
    return { act: a }
}

/** Вода с берегом: из найденной в кубе 500 (ближайшая к стражу), иначе - случайный поиск вокруг. */
function gsFindWater(level, e, rt) {
    var near = gsNear(rt.pois.waters, e, 12)
    for (var q = 0; q < near.length; q++) {
        var w = near[Math.floor(Math.random() * near.length)]
        for (var r = 1; r <= 3; r++) for (var i = -r; i <= r; i++) for (var j = -r; j <= r; j++) {
            if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue
            var s = gsStandable(level, w[0] + i, w[2] + j)
            if (s && Math.abs(s.y - w[1]) <= 2) return { x: s.x, y: s.y, z: s.z, wx: w[0] + 0.5, wy: w[1], wz: w[2] + 0.5 }
        }
    }
    for (var n = 0; n < 60; n++) {
        var ang = Math.random() * 6.283185307179586, r = 4 + Math.random() * 44
        var x = Math.floor(e.getX() + Math.cos(ang) * r), z = Math.floor(e.getZ() + Math.sin(ang) * r)
        var h = gsSurface(level, x, z)
        if (String(level.getBlock(x, h - 1, z).id).indexOf("water") < 0) continue
        var sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        for (var k = 0; k < 4; k++) {
            var s = gsStandable(level, x + sides[k][0], z + sides[k][1])
            if (s && Math.abs(s.y - h) <= 2) return { x: s.x, y: s.y, z: s.z, wx: x + 0.5, wy: h, wz: z + 0.5 }
        }
    }
    return null
}

const GS_Boolean = Java.loadClass("java.lang.Boolean")
var GS_FIELDS = {}

/** Приватное поле по имени в классе name или его предках. */
function gsField(obj, className, field) {
    var key = className + "#" + field
    if (!GS_FIELDS[key]) {
        var c = obj.getClass()
        while (c && String(c.getName()) !== className) c = c.getSuperclass()
        if (!c) return null
        var f = c.getDeclaredField(field)
        f.setAccessible(true)
        GS_FIELDS[key] = f
    }
    return GS_FIELDS[key]
}

/**
 * Разжечь: очаг TFC гаснет без топлива - кладём полено и зовём light(); печь - запас горения (litTime),
 * костёр - просто свойство lit. Возвращает текст, что сделано (для лога и команды).
 */
function gsLight(level, p) {
    var pos = new RAID_BlockPosClass(p.x, p.y, p.z)
    var state = level.getBlockState(pos)
    var block = state.getBlock()
    var prop = block.getStateDefinition().getProperty("lit")
    if (!prop) return "нет свойства lit у " + block
    if (state.getValue(prop).booleanValue()) return "уже горит"
    var be = level.getBlockEntity(pos)
    var sound = () => GS_SERVER.runCommandSilent("execute in " + String(level.getDimension()) + " run playsound minecraft:item.flintandsteel.use block @a " + p.x + " " + p.y + " " + p.z)
    if (block instanceof GS_FirepitBlock && be) {
        var inv = gsField(be, "net.dries007.tfc.common.blockentities.InventoryBlockEntity", "inventory").get(be)
        if (inv.getStackInSlot(0).isEmpty()) inv.setStackInSlot(0, Item.of("tfc:wood/log/oak"))
        sound()
        return be.light(state) ? "очаг разожжён" : "очаг не разгорелся"
    }
    if (block instanceof GS_FurnaceBlock && be) {
        gsField(be, "net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity", "f_58316_").setInt(be, 2400)   // litTime
        gsField(be, "net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity", "f_58317_").setInt(be, 2400)   // litDuration
    }
    level.setBlock(pos, state.setValue(prop, GS_Boolean.TRUE), 3)
    sound()
    return "разожжено"
}

function gsSit(level, e, p) {
    if (gsPoiKind(level.getBlockState(new RAID_BlockPosClass(p.x, p.y, p.z))) !== "chairs") return false
    var AABB = RAID_AABBClass
    var list = level.getEntities(e, new AABB(p.x, p.y, p.z, p.x + 1, p.y + 1.5, p.z + 1))
    for (var i = 0; i < list.size(); i++) {
        var t = String(list.get(i).type)
        if (t === "mcw_tfc_aio:chair" || t === "minecraft:player") return false
    }
    var chair = airSummon(level, "mcw_tfc_aio:chair", p.x + 0.5, p.y + 0.3, p.z + 0.5, null)
    if (!chair) return false
    if (!airMount(e, chair)) { chair.discard(); return false }
    return true
}

function gsActTick(v, level, e, rt, now) {
    var key = String(e.uuid)
    var a = rt.acts[key]
    if (!a || now >= a.until) {
        if (a) gsFinishAct(e, a)
        if (String(e.persistentData.getString("tfg_guest_role")) === "bodyguard") {    // после занятия по команде - снова к торговцу
            delete rt.acts[key]
            return
        }
        a = rt.acts[key] = gsChooseAct(v, level, e, rt, now)
    }
    if (a.id === "talk") return gsTalkTick(v, level, e, rt, a, now)
    var nav = e.getNavigation()
    if (a.stage === "go") {
        if (!a.poi) { a.stage = "do"; a.until = now + a.dur; return }
        var mv = GS_MOVE[key]
        if (mv && mv.gaveUp && mv.gaveUp >= (a.started || 0)) {
            gsLog(v.id + ": страж не может пройти к месту (" + a.id + ") - выбирает другое занятие")
            mv.gaveUp = 0
            a.until = now
            return
        }
        var d2 = gsDist2(e, a.poi.x + (a.id === "fish" || a.id === "wander" ? 0 : 0.5), a.poi.z + (a.id === "fish" || a.id === "wander" ? 0 : 0.5))
        var reach = a.id === "warm" ? 9 : a.id === "sit" ? 4 : a.id === "shelter" ? 1.5 : a.id === "listen" ? 16 : 2.5
        if (d2 <= reach) {
            nav.stop()
            a.stage = "do"
            a.until = now + a.dur
            if (a.id === "sit" && !gsSit(level, e, a.poi)) {
                gsLog(v.id + ": сесть на " + a.poi.x + " " + a.poi.y + " " + a.poi.z + " не вышло (занято или стула уже нет)")
                a.until = now
            }
            if (a.id === "warm") {
                if (gsPoiKind(level.getBlockState(new RAID_BlockPosClass(a.poi.x, a.poi.y, a.poi.z))) === null) a.until = now
                else {
                    try { gsLog(v.id + ": греться у " + a.poi.x + " " + a.poi.y + " " + a.poi.z + " - " + gsLight(level, a.poi)) } catch (err) { gsErr("разжечь огонь", err) }
                }
            }
            if (a.id === "fish") { a.hand = String(e.getMainHandItem().id); e.setMainHandItem(Item.of(gsItem("tfc:metal/fishing_rod/copper") || "minecraft:stick")) }
            return
        }
        if (nav.isDone() || now >= (a.next || 0)) {
            var tx = a.poi.x + 0.5, tz = a.poi.z + 0.5
            if (a.id === "warm") { var dd = Math.sqrt(gsDist2(e, tx, tz)) || 1; tx -= (tx - e.getX()) / dd * 2; tz -= (tz - e.getZ()) / dd * 2 }
            if (a.id === "fish" || a.id === "wander" || a.id === "shelter" || a.id === "listen") { tx = a.poi.x; tz = a.poi.z }
            gsWalk(e, tx, a.poi.y, tz, a.id === "shelter" ? 1.3 : 1.0)
            a.next = now + 100
        }
        return
    }
    // на месте
    if (a.id === "listen") {
        // слушают музыканта: стоят и смотрят в его сторону
        e.getLookControl().setLookAt(a.poi.x, a.poi.y + 1.4, a.poi.z)
        return
    }
    if (a.id === "shelter") {
        // непогода кончилась - по своим делам; пока пережидают - оглядываются
        if (!(rt.weather && rt.weather.bad)) { a.until = now; return }
        if (Math.random() < 0.2) e.getLookControl().setLookAt(e.getX() + Math.random() * 10 - 5, e.getEyeY(), e.getZ() + Math.random() * 10 - 5)
        return
    }
    if (a.id === "warm") e.getLookControl().setLookAt(a.poi.x + 0.5, a.poi.y + 0.5, a.poi.z + 0.5)
    else if (a.id === "fish") {
        e.getLookControl().setLookAt(a.poi.wx, a.poi.wy, a.poi.wz)
        if (Math.random() < 0.15) {
            e.swing(RAID_MAIN_HAND)
            GS_SERVER.runCommandSilent("execute in " + v.dim + " run playsound minecraft:entity.fishing_bobber.splash neutral @a " + a.poi.wx + " " + a.poi.wy + " " + a.poi.wz + " 0.5")
        }
    } else if (a.id === "eat") {
        if (!a.hand) { a.hand = String(e.getMainHandItem().id); a.food = gsItem(GS_FOODS[Math.floor(Math.random() * GS_FOODS.length)]) || "minecraft:bread" }
        e.setMainHandItem(Item.of(a.food))
        try { if (!e.isUsingItem()) e.startUsingItem(RAID_MAIN_HAND) } catch (err) { a.until = now }
    }
}

// ─── Бой ─────────────────────────────────────────────────────────────────────

function gsHostileTarget(v, e) {
    var h = v.hostile
    if (!h) return null
    var best = null, bestD = 64 * 64
    GS_SERVER.players.forEach(p => {
        if (h.players.indexOf(String(p.uuid)) < 0 || !p.isAlive() || p.isCreative() || p.isSpectator()) return
        if (String(p.level.getDimension()) !== v.dim) return
        var d = gsDist2(e, p.getX(), p.getZ())
        if (d < bestD) { bestD = d; best = p }
    })
    return best
}

function gsCalm(e) {
    try { e.setTarget(null) } catch (err) { }
    try { e.setAggressive(false) } catch (err) { }
    try { var st = RAID_AI[raidGunKey(e)]; if (st) st.target = null } catch (err) { }
}

/** Удар игрока по гостю (торговец, страж, лошадь): отряд мстит всем игрокам его фракции поблизости. */
EntityEvents.hurt(event => {
    var e = event.entity
    try {
        if (!e.persistentData.contains("tfg_guest_visit") || !GS_SERVER) return
        var player = event.source.player
        if (!player) return
        var v = gsLoad()[String(e.persistentData.getString("tfg_guest_visit"))]
        if (!v) return
        var amount = 0
        try { amount = Number(event.damage) || 0 } catch (err2) { }
        // несильный тычок - обойдётся ворчанием и потерей репутации (factions/social.js)
        if (typeof gsLightHit === "function" && gsLightHit(v, e, player, amount)) return
        gsProvoke(v, player, e.level, GS_HOSTILE_TICKS, String(e.persistentData.getString("tfg_guest_role")) === "horse" ? "вы напали на нашу лошадь" : "вы напали на наших")
    } catch (err) {
        gsErr("удар по гостю", err)
    }
})

// ─── Озвучка ─────────────────────────────────────────────────────────────────
//
// Все реплики озвучены заранее (Piper, русские голоса denis, dmitri, ruslan; по два тембра - 6 голосов) и лежат в
// kubejs/assets/tfg_voice (клиентские ресурсы). Звук ищется по хэшу текста реплики: список есть в
// таблице GS_VOICE_TEXTS ниже (текст -> имя звука). Реплики без звука молчат.
// Голос стража - по его uuid.

const GS_VOICE_PROFILES = 6
// @generated озвучка: текст реплики -> звук tfg_voice:p<голос>_<звук> (scratchpad/tts/collect.js) - не править руками.
// Звук ищется по самому тексту: хэш текста в Rhino на сервере считался иначе, чем при генерации.
const GS_VOICE_TEXTS = {"Слышал? местные опять рейд отбивали.":"578d3f4f","Слышал. Разбойники совсем страх потеряли.":"270a9700","Хорошо хоть мы с охраной ходим.":"c1d21083","С охраной и помирать веселее.":"589bbdd4","Сколько ещё тут стоять?":"ab74f29e","До завтра, как торговец скажет.":"fab56aac","Ноги гудят после дороги.":"1df73791","Потерпи.":"04ba39b6","Цены на медь опять выросли.":"4ec7e699","Цены на бронзу опять выросли.":"ca95f17e","Цены на железо опять выросли.":"007d6f40","Цены на сталь опять выросли.":"e54719c4","Цены на серебро опять выросли.":"06a280e0","Это всё кузнецы, жулики.":"d873430f","Сам ты жулик, у меня брат кузнец.":"0f8eb15a","Вот я и говорю.":"26534e5f","Ты рыбу когда-нибудь ловил?":"a0bc0de1","Раз сома поймал. На пять кило.":"278b744c","Раз сома поймал. На семь кило.":"35725016","Раз сома поймал. На десять кило.":"f3484081","Раз сома поймал. На двенадцать кило.":"e08573f8","Раз сома поймал. На двадцать кило.":"e9522ab6","Раз сома поймал. На тридцать кило.":"b05f27e2","Врёшь.":"b179ac00","Может, и вру. Но сом был.":"e19a8cd8","Здешние на нас косо смотрят.":"d4b6815b","Нас везде косо смотрят. Мы охрана.":"24261e2a","Зато платят.":"b12e8617","Платят - это громко сказано.":"a85ac61e","Как думаешь, местные с нами дружить будут?":"cc4610e3","Если торговля пойдёт - будут.":"3cff6616","А если не пойдёт?":"3ac5cd76","Тогда придём снова. Но не торговать.":"e0386684","Я вчера пять кругов вокруг лагеря дал.":"dfc99143","Я вчера семь кругов вокруг лагеря дал.":"d052be21","Я вчера десять кругов вокруг лагеря дал.":"c4fce18e","Я вчера двенадцать кругов вокруг лагеря дал.":"3c5ae87f","Я вчера двадцать кругов вокруг лагеря дал.":"ed831595","Я вчера тридцать кругов вокруг лагеря дал.":"5a7c1b35","Зачем?":"731e25eb","Сержант велел.":"48eaaca4","Мудрый у нас сержант.":"02127b90","Что везём-то в этот раз?":"bac3d8f1","Соль, в основном.":"49a95654","Шкуры, в основном.":"996ef5b8","Зерно, в основном.":"99564fb7","Гвозди, в основном.":"9f574d1a","Верёвки, в основном.":"6d5a0bbc","Мука, в основном.":"25ffb8c1","Глина, в основном.":"639156e7","И ради этого мы тащились?":"f4b5d496","Ради жалованья мы тащились.":"ab271e4c","Щит опять треснул.":"40e38bb5","Сдай в кузню, заменят.":"f74534fa","Заменят. И из жалованья вычтут.":"a44e4090","Как всегда.":"9481b3e6","Скучаю по дому.":"cc2458f4","Через пару дней будем.":"3db8b5b5","Жена пирог обещала.":"e8b3e889","С чем?":"e255d4b5","С надеждой, что я вернусь.":"b5802a11","У тебя соли не найдётся?":"6e7f1bb9","У тебя табака не найдётся?":"4b5b9656","У тебя верёвки не найдётся?":"56dce995","У тебя хлеба не найдётся?":"1d5f5321","У тебя огнива не найдётся?":"1025525d","У тебя ниток не найдётся?":"b953a7b8","Найдётся. Но не для тебя.":"92868a78","Жадина.":"91b03984","Бережливый.":"9b8ce665","Говорят, на севере медь прямо под ногами лежит.":"05850b9c","Говорят, на севере бронза прямо под ногами лежит.":"cd7d47e0","Говорят, на севере руда прямо под ногами лежит.":"6f8d2492","Говорят, на севере сталь прямо под ногами лежит.":"bbb79b49","Говорят, на севере соль прямо под ногами лежит.":"0ff6b567","Говорят, и драконы там же.":"65c09930","Драконы - сказки.":"e33a8aba","Скажи это тем, кто не вернулся.":"466dac22","Торговец наш сегодня злой.":"5abb958e","Полдня торговался. местные уступать не любят.":"321cf67f","И как?":"cb58dc08","Ушёл на пять монет беднее.":"3cb84c1c","Ушёл на семь монет беднее.":"c75564d6","Ушёл на десять монет беднее.":"e95e8099","Ушёл на двенадцать монет беднее.":"bd88d170","Ушёл на двадцать монет беднее.":"6af0290a","Ушёл на тридцать монет беднее.":"6cfb626e","Давно ты в охране?":"d79d35b3","Лет пять, если не врать.":"cc4d042a","Лет семь, если не врать.":"e4cc5f64","Лет десять, если не врать.":"f0e9cfc7","Лет двенадцать, если не врать.":"2d86aa26","Лет двадцать, если не врать.":"376ded64","Лет тридцать, если не врать.":"4393f400","А если врать?":"2e0455d5","Тогда с рождения.":"23722b72","Слышишь? Опять что-то рычит вдалеке.":"101a033e","Кабан, наверное.":"77c82d1f","Кабаны так не рычат.":"b540179e","Тогда пусть рычит подальше.":"9e39ec14","Думаешь, нас ещё сюда позовут?":"da8fb209","Позовут, если местные заплатят.":"cc357c6a","А если не заплатят?":"f5c1c499","Значит, не позовут.":"f0ff860b","Опять медь в цене упала.":"a82231ba","Опять бронза в цене упала.":"5854b89e","Опять руда в цене упала.":"2ab11174","Опять сталь в цене упала.":"5515231d","Опять соль в цене упала.":"4d5e0f79","Тебе-то что? У тебя её нет.":"89fd31b5","Вот поэтому и обидно.":"3f52dbdc","Логично.":"87771947","Сапоги жмут.":"59ef0bbd","Разносишь.":"1c9f19fa","За пять дней не разносил.":"acab80d9","За семь дней не разносил.":"7cc20f2f","За десять дней не разносил.":"f1e8dfd8","За двенадцать дней не разносил.":"ba2e676d","За двадцать дней не разносил.":"647d5817","За тридцать дней не разносил.":"bca6fbb7","Значит, сапоги тебя разнашивают.":"7863b1fe","Гроза-то какая.":"305c7b63","Лишь бы молния в нас не ударила.":"93acb8e9","В железе стоим - самое оно.":"a6eebdd5","Слышал, как громыхнуло?":"ebd8b0d4","Небо раскололось, не иначе.":"e905f861","Сиди тихо, авось пронесёт.":"273929b9","Снег валит.":"f96736f8","В такую погоду дома сидеть надо.":"3b9bfa20","С чаем.":"4110e474","И без сержанта.":"1fb887ad","Замело всё.":"b991a8ea","Обратно по сугробам потащимся.":"5a467eb4","Не каркай.":"ca6b9c3c","Опять льёт.":"07b519d3","Хоть пыль прибьёт.":"b06f4e60","И нас заодно.":"7566df93","Промок до нитки.":"ee670219","Под крышу бы.":"67be655c","Под чью? Тут всё чужое.":"233c1a44","Дождь, дождь...":"496953bd","Для посевов хорошо.":"3c9e7fd1","Для моих сапог - нет.":"7c7ec4b6","Холод собачий.":"3cb343f9","Пальцы к копью примерзают.":"f71c71ee","Держи ближе к телу.":"31c9f708","Дыхание паром идёт.":"46a415d7","Зима близко, не иначе.":"bb5daf4e","Или уже пришла.":"860fa19a","Жарища.":"6df12414","В доспехах хоть яичницу жарь.":"79427473","Не подавай идей, я голодный.":"beb3e309","Пить охота.":"a0aba543","Терпи до привала.":"846cbf83","Привал - это когда?":"393a44ed","Погода славная.":"5af80959","Не сглазь.":"93f7d3d9","Небо чистое.":"d1634ddd","Видно далеко. И нас тоже далеко видно.":"e58e0cd8","Вот ты умеешь настроение испортить.":"8609de5a","Темень-то какая.":"a0136c16","Смотри в оба, ночью всякое бродит.":"56602347","Спать охота.":"ea294358","На посту не спят.":"3681ee82","А я и не сплю. Я глаза отдыхаю.":"37535907","Светает.":"8e4da0f6","Самое время для каши.":"9a25186b","Самое время для службы, говорит сержант.":"7c146028","Смеркается.":"d48c070a","Скоро к огню потянемся.":"3de6706e","Зима в разгаре.":"675ad031","Хорошо хоть реки встали - переходить проще.":"f5614dd8","Весна пришла.":"9b96d5e0","Грязи по колено.":"26c67dba","Зато птицы поют.":"5796cc8f","Лето нынче щедрое.":"d52d3229","Если урожай будет - и торговля пойдёт.":"25ae9e28","Осень.":"c7370500","Сейчас бы грибов пожарить.":"cedf46d5","С тобой в лес только за поганками.":"c0a15014","Горы кругом.":"1ec53065","Красиво, но тащиться по ним - мука.":"32b7841e","Море рядом, солью пахнет.":"edaf7b35","Рыба тут, небось, знатная.":"7436d228","Вода под боком - уже хорошо.":"c770383b","И рыбалка, и умыться.":"7e804b68","Ну и овраги тут.":"691a2887","Ногу сломать - раз плюнуть.":"7622d592","Болото. Комары заедят.":"95285f1f","Зато чужие сюда не сунутся.":"99e708b6","Простор какой.":"7251983e","Всё видно на лиги вокруг.":"53de66eb","И нас видно.":"73873ca4","Высоко забрались.":"497bf455","Воздух жидкий, дышать тяжело.":"2bba4fe1","Сколько тут акаций.":"23716e23","Сколько тут ясеней.":"9444889e","Сколько тут осин.":"c1b378dc","Сколько тут берёз.":"f5c0ac80","Сколько тут чёрного дерева.":"a0708446","Сколько тут каштанов.":"ff0013f3","Сколько тут пихт.":"034eba06","Сколько тут гикори.":"b697500b","Сколько тут капков.":"2f7c86df","Сколько тут мангров.":"1927362a","Сколько тут клёнов.":"80f7501d","Сколько тут дубов.":"b5e227b6","Сколько тут пальм.":"2ee85cbe","Сколько тут сосен.":"cc30cbea","Сколько тут палисандра.":"b47ec11e","Сколько тут секвой.":"0e59c4f7","Сколько тут елей.":"29e35ec0","Сколько тут платанов.":"90c402f3","Сколько тут кедров.":"96ff9905","Сколько тут ив.":"8665e428","Хорошая древесина. Дорого бы продали.":"4ef6bade","Гляди, пшеница растёт.":"db1bd06b","Гляди, ячмень растёт.":"3d0714da","Гляди, овёс растёт.":"f41e458c","Гляди, рожь растёт.":"0047bd9a","Гляди, кукуруза растёт.":"eade3478","Гляди, рис растёт.":"47387ac5","Гляди, картошка растёт.":"aedec06a","Гляди, морковь растёт.":"53dd0826","Гляди, лук растёт.":"5c95b69e","Гляди, капуста растёт.":"bca89d8b","Гляди, чеснок растёт.":"84aaff90","Гляди, помидоры растёт.":"0ff1c180","Гляди, свёкла растёт.":"77319dc1","Гляди, соя растёт.":"93d501ba","Гляди, тыква растёт.":"d696008b","Гляди, тростник растёт.":"9193e1d2","Гляди, джут растёт.":"75549439","Гляди, папирус растёт.":"233bdc2a","Гляди, фасоль растёт.":"eda603e6","Гляди, дыня растёт.":"75a313e3","Гляди, перец растёт.":"ff1c0add","Урожай, небось, неплохой будет.":"b8a65df0","Если разбойники не вытопчут.":"38342da2","Ягоды! Набрать бы.":"0e0dbd55","Руки убери, не наше.":"507e6adb","Гляди, корова. Хозяйство держат.":"24e5466a","Гляди, свинья. Хозяйство держат.":"1cddd0a1","Гляди, овца. Хозяйство держат.":"60fd3f2c","Гляди, курица. Хозяйство держат.":"9e92f64d","Гляди, утка. Хозяйство держат.":"12ab745b","Гляди, лошадь. Хозяйство держат.":"e13401b1","Гляди, осёл. Хозяйство держат.":"67d3a375","Гляди, мул. Хозяйство держат.":"5af3ded0","Гляди, коза. Хозяйство держат.":"c96ed82f","Гляди, альпака. Хозяйство держат.":"0c73a230","Гляди, як. Хозяйство держат.":"0b2aae61","Гляди, овцебык. Хозяйство держат.":"95bedd89","Гляди, перепёлка. Хозяйство держат.":"ac91e0c8","Гляди, индюк. Хозяйство держат.":"e79f74e9","Гляди, павлин. Хозяйство держат.":"8528b8db","Гляди, кошка. Хозяйство держат.":"a807df98","Гляди, собака. Хозяйство держат.":"2fdea13e","Сытно живут, значит.":"25c3dbee","Там заяц бродит.":"16604e04","Там лиса бродит.":"295d41f0","Там олень бродит.":"6eb7062b","Там лось бродит.":"5f5e559a","Там карибу бродит.":"2b6c24d0","Там кабан бродит.":"f14eb692","Там волк бродит.":"2b9ac533","Там лютоволк бродит.":"82bcc0a6","Там медведь бродит.":"358ee77c","Там гризли бродит.":"46f5d42f","Там белый медведь бродит.":"881c6077","Там пума бродит.":"c24909b8","Там пантера бродит.":"e289298b","Там лев бродит.":"3ab4594a","Там саблезуб бродит.":"a468c9df","Там тигр бродит.":"e5f1b06b","Там крокодил бродит.":"68a45ff3","Там лягушка бродит.":"eae20266","Там тетерев бродит.":"378bee7f","Там фазан бродит.":"0e6f7f0a","Там черепаха бродит.":"a4410a9f","Там пингвин бродит.":"7e5bd3ec","Держи оружие под рукой.":"eb0aa447","Или ужин добудем.":"06234a19","Крыши-то у них какие.":"3278900d","Богато живут.":"e53a3532","Черепица, не солома.":"947f6845","Крыш почти не видно.":"3f360c5f","В землянках живут, что ли?":"92119dd7","Тут совсем негде сесть.":"4761c4ce","Гостей, видать, не ждали.":"343682f0","Стульев - хоть на пир зови.":"d8cc9c34","Гостей любят, выходит.":"f883b624","Ни одного очага. Как они тут греются?":"29ee161f","Работой, наверное.":"48597163","Печей-то сколько.":"0fb3455b","Дымят, как кузнечный квартал.":"6b7b9b28","Мебель как в городе.":"c2ccf997","Столы, шкафы... Не бедствуют.":"d6210af3","Пусто у них как-то.":"cba40158","Ни стола, ни шкафа.":"8f77fd87","Может, всё продали.":"18ca71d6","Сколько тут машин гудит.":"acb4dd4f","Как в столице мастеров.":"2593a1f4","Не лезь, затянет.":"e20584e4","Механизмы у них крутятся.":"30102bd7","Мастеровые люди, значит.":"674387a3","Фонарей не жалеют.":"873b7022","Ночью тут светло, как днём.":"49e3283d","Стёкла в окнах.":"0acbc4e6","Дорогое удовольствие.":"91ebaa75","Кирпичные дома.":"f051495a","Надолго строили, на века.":"38170d94","Поля большие.":"77b5282d","С голоду не помрут.":"a5031b67","А поля у них где?":"4dc9bcee","Покупают, видать. Нам же лучше.":"bd188100","Бочек и сундуков сколько.":"a9116dfe","Запасливые.":"76429e5f","Хорошо у огня.":"c9fa24b4","Не то слово.":"30655883","Век бы так сидел.":"7de6f3cd","Подкинь ещё полешко.":"8431ba95","Сам подкинь, ты ближе.":"f2d230d4","Ладно, пусть догорает.":"a851cfca","Клюёт?":"ef8656f8","Пока только комары.":"d52a642c","У меня тоже.":"05bcb674","Удобно сидишь?":"b2edd8e2","Лучше, чем в седле.":"eb73728d","Вкусно?":"59d47a73","Сносно. Ещё бы соли.":"32e4c97a","Переждём тут.":"d8d51b0c","Под крышей и дождь не страшен.":"efc3b0e6","Лишь бы не протекало.":"7c3022cd","Ох...":"6feaa0a2","Мда...":"966eb693","#cough":"cough","Кхе-кхе.":"2ea8770c","Эх.":"b40326cb","Хм.":"ea18aace","Ну-ну.":"258d8a62","Так-так.":"6c77198c","Ай, спина...":"5d5afc9b","#sigh":"sigh","Ну и денёк.":"c1877a82","Скорей бы домой.":"dd62ec5d","Где мой кисет...":"1d51580c","Ничего, прорвёмся.":"5d1f6197","Есть охота.":"353ea810","Хорошо...":"dfd21950","Ну что ж.":"60962878","Ну и слякоть.":"82e8f2d8","Льёт и льёт.":"911f3f13","Вымок весь.":"43ed1680","Тьфу, сырость.":"8a9da2e9","Опять за шиворот течёт.":"e058c459","Бр-р, метёт.":"76036c2f","Снегу-то навалило.":"c1b73c0e","Уши отморожу.":"0a6feba9","Бр-р, холодно.":"5d031618","Зуб на зуб не попадает.":"538e6a19","#breath":"breath","Уф, жара.":"7a56dcf2","Пекло.":"e2e6d5ba","Ох, гремит!":"576c1c4f","Ну и гроза.":"9c230cd1","#yawn":"yawn","Темень...":"68f6dc30","Тепло...":"305a0e9a","Ох, отогреваюсь.":"94b36f71","Хорошо горит.":"ec3c8a97","Дорога вымотала.":"4af186a0","Ноги гудят.":"e1753fd0","Тут и заночуем.":"8c6c8e7f","Костёр развели - уже полдела.":"4cd1d0cd","Завтра ещё день пути.":"f40f9fa5","Колесо бы проверить.":"837de528","До темноты успели, и ладно.":"076d83b3","Не май месяц ночевать в поле.":"c89e8f49","Спину бы разогнуть.":"72fae5d5","Дальше дорога хуже будет.":"40b94c3c","Ничего, дойдём.":"67ea2e77","Главное - разбойников не встретить.":"f2bdeebe","Караул выставили?":"1e23f499","Посплю в палатке, кто на вторую стражу?":"93ec440f","Товар пересчитать надо.":"2e9161bf","Стою, смотрю.":"5b313839","Тихо пока.":"27da79d7","Кто там шастает?":"56c48662","Ночь долгая.":"20b0f288","Глаз не сомкну.":"9c02feed","Скотина беспокоится.":"a2dc0d45","Сено бы им.":"ba26252a","Пить хотят.":"0d5420f0","Стоять, родимая.":"2c0598e0","Ну клюй же...":"cc40b6d4","Тихо, рыбу спугнёшь.":"b4433c9b","Опять пусто.":"ed45c636","Ох, ноги...":"bda630e6","Посижу немного.":"3e91ecd4","Ммм.":"c77841ef","Сухарь, а не хлеб.":"da145cfe","Далеко ещё?":"72e7e7c9","Шагай, шагай...":"28259d5d","Скорей под крышу!":"59a20cba","Вот тут сухо.":"16269b81","Пусть льёт, нам не страшно.":"8be5523d","Негде укрыться...":"285d8a63","Хоть бы навес какой.":"8da8ffd0","Скорей бы дойти.":"4666beb1","Не отставай.":"c8ed5597","Смотри по сторонам.":"d1934863","Ну, в путь.":"52d3a3cb","Домой!":"6ca9d047","Прощай, поселение.":"a6b4c0b5","К оружию!":"378e29a9","Бей их!":"51b98890","Держать строй!":"5671f549","За наших!":"c37d93c1","Ну, подходи!":"e613484e","Бежим!":"783d9ce6","Отходим!":"f70ffaf1","Спасайся!":"3726c44c","Товар отличный, берите.":"5e903d4b","Кому что надобно?":"25c43fc5","Цены честные.":"6bb5bb04","Хм, где же покупатели...":"9bc703d4","Проходи мимо.":"93c291fb","Не стой над душой.":"31b3b37c","Чего надо?":"a01ceba8","Ну?":"60bfad6a","Здравствуй.":"98ff91a3","И тебе не хворать.":"45e99cad","Мир тебе.":"126d9340","Доброго пути.":"b08c0327","А, знакомое лицо! Здравствуй.":"37fb82a8","Рад тебя видеть.":"e61d58b7","Здорово, друг.":"238f2d8a","Кого я вижу!":"4190b48d","Друг мой, как я рад встрече!":"2c0b0124","Наконец-то знакомое лицо в этой глуши!":"0b515811","Здравствуй, дорогой!":"aab4868c","Ну здравствуй, родная душа.":"30ecc868","Хм. Ладно.":"47952aba","Приму, так и быть.":"fd28913d","Угу.":"3675c29a","Считай, зачтётся.":"33e86e39","Благодарю.":"6ce0c7ba","Спасибо, это кстати.":"54fb818d","Вот спасибо.":"7ad3433b","Не откажусь, спасибо.":"278973d1","Спасибо, дружище!":"d75a0b55","Вот это по-нашему, спасибо!":"2a1353ac","Щедро, благодарю!":"4eab406d","Ох, спасибо тебе!":"00ad3fbc","Спасибо тебе, друг! Не забуду.":"1698115d","Вот это подарок! Спасибо!":"bd133a31","Ты настоящий друг, спасибо!":"47646488","Сердечно благодарю!":"14c34166","Ещё раз - и пожалеешь.":"0498ed98","Руки убрал.":"e6181ccb","Ты за это ответишь.":"8e2c8801","Напрашиваешься?":"cbc14f3f","Эй! Полегче.":"580c648e","Ты чего дерёшься?":"7d81582e","Не балуй.":"b2f4d9e5","Хватит.":"e6d57bc0","Что я тебе сделал?":"f5a42f73","Я не хотел тебя обидеть.":"4d4cecf8","Давай без этого, а?":"2ad43fb2","Мы же не ссорились.":"70c778cb","Друг, ты чего? Это же я.":"14e5777b","Я думал, мы друзья...":"c0908c4a","Обидно, честное слово.":"3770139a","Не надо так, прошу.":"3e36cfaa","На, не помри с голоду.":"be8fd8eb","Держи, и отойди.":"71e3b595","Бери, раз пришёл.":"6966dd37","Ешь молча.":"87103506","Угощайся.":"7665ef95","На, подкрепись.":"d86e6568","Возьми, у огня положено.":"556fad66","Держи, не побрезгуй.":"f6af1b47","Угощайся, друг!":"9e56a37a","Держи, у нас хватает.":"fab364c9","Бери-бери, не стесняйся.":"3b3b47e8","К огню - и к столу.":"4af4172b","Самое лучшее - гостю!":"cc0e7d8e","Для друга ничего не жалко.":"826c5a20","Держи, отогрейся как следует.":"1cbf4a04","Ешь, пей, всё наше - твоё.":"104075df","Ладно, сыграю. Только не мешайте.":"6ac8acec","Раз просят - сыграю.":"1fce318f","Слушайте, пока настроение есть.":"90b68842","Одна песня, и спать.":"67ba3a71","Хорошо играешь.":"8ff81258","Душевно вышло.":"b54b3d86","Аж мороз по коже.":"203e3c6e","Ещё бы разок такую.":"65e0d4e4","Слышал и хуже.":"63e14e36","Пальцы-то помнят.":"89e83b1e","Сойдёт для дороги.":"0efd042d","В городе за такое монету бросают.":"430c2b84","Вот это дело! Играй ещё.":"cff01a1c","Под такое и шагать легче.":"b01add9f","У нас в лагере так не умеют.":"7bc322fa","Запомню мотив.":"062b7092","Гляди, чужак играет.":"12763686","А ничего так.":"6df79171","Слушай, не мешай.":"1a7fec45","Хорошо играешь, путник!":"643628ea","Редко такое услышишь в дороге.":"b6e33daf","За такое и угостить не жалко.":"16baaf9b","Вот это по-нашему!":"f4e8da40","Сыграй ещё, друг!":"eadf8905","Под такую музыку и зима теплее.":"c7e0bb33","Небо честнее дорог.":"c4d248ad","На дороге грабят, в небе только ветер.":"1f39a2e0","И падать выше.":"87491aca","Синяя сталь держит давление лучше красной.":"ecaf8725","Красная - для тех, кто любит чинить.":"1cb404c7","А я люблю летать.":"8d459a05","Говорят, на востоке нашли поле руды.":"7010198d","Говорят многое.":"509fac40","Зато возить будет чего.":"8fbeb7f9","Эшлендеры обещали шкуры к весне.":"1a82d119","Если доживут.":"1a3d2753","Доживут, они живучие.":"2ff8d5c0","Марвины опять просили возить ящики без описи.":"a0df4a40","И что?":"c77b988b","А ничего. Мы не возим то, что стонет.":"d8fa0195","Скот нынче дорог.":"10bb785a","Корма дороже.":"87bf6b32","А зима ближе.":"ee8a9dff","В шахте на севере вода пошла.":"b7629072","Бросили?":"2b2984e9","Углубились. Мы же эшлендеры.":"ae887afa","Торговцы ветром опять летят мимо.":"df322da1","Пусть летят, лишь бы платили.":"c4bffcd3","Платят исправно, чего уж.":"d387cf85","Альянс зовёт под свои знамёна.":"3468d705","Пусть сперва долги закроют.":"c738515c","И то верно.":"43d18be9","Говорят, руду у нас берут за полцены.":"cf995e3d","Так продавай дороже.":"3030e3a4","Купят у Марвинов, у них дешевле. И грязнее.":"13068c4d","Хорошая настойка лечит всё.":"5bdfbb9d","И память отшибает.":"117b5005","Это как раз главное.":"ed75958b","Альянс опять читал нам мораль.":"d9e4cf4d","У рыцарей всегда чистые руки.":"a09ce7d5","Потому что за них работают другие.":"98a87c59","Живой товар нынче в цене.":"ff987d5a","Тише ты.":"f5964673","А что? Мы же аптекари.":"bfa13b01","На юге спрос на порошки вырос.":"c7c25687","Значит, поедем на юг.":"4f7a9a37","Эшлендеры считают нас падалью.":"cafaada5","Пусть считают. Лечиться всё равно к нам придут.":"931d1189","Это точно.":"2eae582c","Порядок держится на тех, кто встал в строй.":"1971732d","И на тех, кто платит за сталь.":"def90bf9","И на них тоже.":"fd5bec69","Марвины возят людей в ящиках.":"a66a12fb","Докажи.":"fa03a367","Докажу - и повешу.":"ad87ee6c","Тракт до перевала снова чист.":"c855fd75","Надолго ли?":"70fdd81a","Насколько нас хватит.":"3a3f65c7","Говорят, в старых руинах горит свет.":"83ecf34e","Ночью туда не ходят.":"9d4880e0","Значит, пойдём днём.":"69093853","Эшлендеры дали зерно в долг.":"71516257","Вернём с процентом.":"338e3b14","Вернём с честью. Процент - потом.":"8b7ec3f9","Поселения держатся друг за друга всё слабее.":"a9c4eba5","Каждый сам за себя.":"f3ea4d39","Пока не приходят разбойники.":"778012b7","Дороги пустеют.":"213a8d44","Кто уцелел - сидит за стеной.":"b5338171","А мы вот ходим.":"e5e9d02f","Говорят, на севере целый город стоит целым.":"a69b8257","Врут.":"5eca8ad4","Хорошо бы врали не всё.":"44498da3","Эй, руки-то убери.":"d9e0cb9a","Считать, думаешь, не умеем?":"8d12cb9d","Товар не трогай без спроса.":"e5285b81","Ещё раз полезешь - разговор будет другой.":"8ebddbc1","Видел я, что ты взял.":"7cffa15d","Что он тебе дал?":"7af7a650","Неожиданно после всего, что мы видели в пути.":"d1ae75f2","Ну хоть кто-то не бросил камень.":"9d1bc84a","Это напиток. Гостинец от местных.":"9fb401a7","Это еда. Гостинец от местных.":"8dda9758","Это железо. Гостинец от местных.":"77fcd287","Это ткань. Гостинец от местных.":"3186e5aa","Это монеты. Гостинец от местных.":"b0b5d780","Это самоцвет. Гостинец от местных.":"6ea8b7fb","Это порошок. Гостинец от местных.":"fac9be46","Это вещица. Гостинец от местных.":"7a6f9705"}

function gsVoiceKeyCount() { var n = 0; for (var k in GS_VOICE_TEXTS) n++; return n }
// Ремарки в звёздочках - не слова, а звуки: "#имя" - шум, собранный генератором (кашель, вздох, дыхание) своим для
// каждого голоса; "@id" - звук Minecraft; null - без звука. Междометия ("Ох...", "Мда...") озвучены как речь.
const GS_VOICE_ALIAS = {
    "*кашляет*": "#cough", "*вздыхает*": "#sigh", "*дышит на руки*": "#breath", "*греет руки*": "#breath", "*зевает*": "#yawn",
    "*чешет затылок*": "@minecraft:item.armor.equip_leather", "*потягивается*": "@minecraft:item.armor.equip_generic",
    "*жуёт*": "@minecraft:entity.generic.eat", "*пересчитывает монеты*": "@minecraft:block.chain.hit",
    "*вздрагивает*": "@minecraft:item.armor.equip_iron", "*насвистывает*": "@minecraft:block.note_block.flute",
}

/** Что звучит для реплики: текст речи, "#шум", "@звук Minecraft" или null. */
function gsVoiceText(line) {
    var s = String(line).trim()
    if (/^\*.*\*$/.test(s)) return GS_VOICE_ALIAS[s] === undefined ? null : GS_VOICE_ALIAS[s]
    return s
}

/**
 * Имя звука реплики - из готовой таблицы (voice_index.js, собирает make_index.py): хэш в Rhino
 * сервера выходит не таким, как в генераторе, и сервер звал звуки, которых нет.
 * null - реплика не озвучена, undefined - таблица не загрузилась.
 */
function gsVoiceKeyOf(text) {
    var keys = null
    try { keys = global.TFG_VOICE_KEYS } catch (e) { }
    if (!keys) return undefined
    var k = keys[String(text).trim()]
    return k ? String(k) : null
}

/** FNV-1a 32 по символам - тот же в генераторе озвучки (на сервере не совпадает - см. gsVoiceKeyOf). */
function gsVoiceKey(text) {
    var h = 2166136261
    for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
    }
    return ("00000000" + h.toString(16)).slice(-8)
}

/** Номер голоса 0..5 и своя высота по uuid; любое нечисло - голос 0 и высота 1 (в Rhino сервера получался NaN). */
function gsVoiceOf(e) {
    // Голос можно задать заранее: так женщины поселения звучат выше мужчин
    // (женских записей в наборе нет, поэтому поднимаем тон мужских).
    try {
        var pd = e.persistentData
        if (pd.contains("tfg_voice_pitch")) {
            return { profile: Number(pd.getInt("tfg_voice_profile")) % GS_VOICE_PROFILES_N,
                pitch: Number(pd.getString("tfg_voice_pitch")) || 1 }
        }
    } catch (err) { }
    var us = String(e.uuid)
    var h = 7
    for (var i = 0; i < us.length; i++) {
        var c = Number(us.charCodeAt(i))
        if (isFinite(c)) h = (h * 31 + c) % 1000003
    }
    var profile = Math.floor(Number(h)) % GS_VOICE_PROFILES_N
    var pitch = 0.96 + (Math.floor(Number(h) / 7) % 9) / 100
    if (!isFinite(profile) || profile < 0) profile = 0
    if (!isFinite(pitch)) pitch = 1
    return { profile: profile, pitch: pitch }
}

var GS_VOICE_PROFILES_N = 6

// ─── Голоса Silero (сборка 23.0) ─────────────────────────────────────────────
// Каждая реплика записана 15 голосами: kubejs/assets/tfg_voice/sounds/<голос>/<хэш>.ogg.
// m0 - правитель, f0 - правительница; m1..m7 - мужчины, f1..f6 - женщины (разные дикторы,
// высота и темп). У каждого NPC свой голос навсегда: у жителя - в записи поселения
// (settlers.js, seVoiceSetup), у гостя - на нём самом (tfg_voice_id), и в одном караване
// голоса не повторяются. Какие реплики озвучены - global.TFG_VOICE_INDEX (voice_index.js).
const GS_VOICE_MALE = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]
const GS_VOICE_FEMALE = ["f1", "f2", "f3", "f4", "f5", "f6"]
const GS_VOICE_WARRIOR = ["m1", "m2", "m4", "m5", "m7"]
// шумы (кашель, вздох, дыхание, зевок) остались от прежних шести голосов p0..p5
const GS_VOICE_NOISE = { m0: 0, m1: 0, m2: 1, m3: 2, m4: 0, m5: 1, m6: 2, m7: 1, f0: 3, f1: 3, f2: 4, f3: 5, f4: 5, f5: 4, f6: 3 }

/** Настоящий голос из набора (m0..m7, f0..f6)? Испорченный (undefined) - нет. */
function gsVoiceValid(id) {
    return /^[mf][0-7]$/.test(String(id))
}

/** Голос этого NPC: запомненный, а нет - выбрать по роли и запомнить навсегда. */
function gsVoiceIdOf(e) {
    var pd = e.persistentData
    // запомненный голос - только настоящий: у гостей бывал записан "undefined" (NaN в Rhino),
    // и все их реплики звали несуществующие звуки - такой выбираем заново
    try { if (pd.contains("tfg_voice_id") && gsVoiceValid(pd.getString("tfg_voice_id"))) return String(pd.getString("tfg_voice_id")) } catch (err) { }
    // житель - голос ему назначает поселение (settlers.js); до этого пусть возьмёт своё
    try { if (e.getTags().contains("tfg_settler") && typeof seVoiceSetup === "function") { seVoiceSetup(e); if (pd.contains("tfg_voice_id") && gsVoiceValid(pd.getString("tfg_voice_id"))) return String(pd.getString("tfg_voice_id")) } } catch (err) { }
    var pool = GS_VOICE_WARRIOR
    try { if (e.getTags().contains("tfg_trader")) pool = GS_VOICE_MALE } catch (err) { }
    // в одном караване - разные голоса: берём тот, что у его спутников ещё не звучит
    var used = {}
    try {
        var vid = String(pd.getString("tfg_guest_visit") || "")
        var v = vid ? gsLoad()[vid] : null
        if (v) {
            ;[v.trader].concat(v.guards || []).forEach(u => {
                var o = u ? gsEntity(v, u) : null
                if (o && o !== e && o.persistentData.contains("tfg_voice_id") && gsVoiceValid(o.persistentData.getString("tfg_voice_id"))) used[String(o.persistentData.getString("tfg_voice_id"))] = 1
            })
        }
    } catch (err) { }
    var free = pool.filter(x => !used[x])
    var list = free.length ? free : pool
    // по uuid - как в gsVoiceOf: в Rhino сервера тут бывал NaN, отсюда голос "undefined"
    var us = String(e.uuid), h = 7
    for (var i = 0; i < us.length; i++) {
        var c = Number(us.charCodeAt(i))
        if (isFinite(c)) h = (h * 31 + c) % 1000003
    }
    var idx = Math.floor(Number(h)) % list.length
    if (!isFinite(idx) || idx < 0) idx = 0
    var voice = String(list[idx])
    if (!gsVoiceValid(voice)) voice = "m1"
    try { pd.putString("tfg_voice_id", voice) } catch (err) { }
    return voice
}

/** Проиграть звук реплики у сущности: команда от её имени (execute as ... at @s), без подстановки координат. */
// громкость в playsound = радиус слышимости в 16 блоках: 5 - около 80 блоков, караван слышно издалека
const GS_VOICE_RANGE = 5

function gsPlayVoice(e, text) {
    try {
        var t = text === null || text === undefined ? null : gsVoiceText(text)
        if (!t) return "без звука"
        var voice = gsVoiceIdOf(e)
        var sound
        if (t.charAt(0) === "@") {
            sound = t.substring(1) + " neutral @a ~ ~1.6 ~ " + (0.6 * GS_VOICE_RANGE) + " " + (Math.round((0.9 + Math.random() * 0.2) * 100) / 100)
        } else if (t.charAt(0) === "#") {
            // шумы прежних записей Piper (кашель, вздох) на слух - звериный рык: молчим
            return "шумы отключены"
        } else {
            var key = gsVoiceKeyOf(t)
            if (key === undefined) return "voice_index.js не загружен"
            if (!key) { gsVoiceMiss(t); return "нет озвучки для \"" + t + "\"" }
            sound = "tfg_voice:" + voice + "_" + key + " voice @a ~ ~1.6 ~ " + GS_VOICE_RANGE + " 1"
        }
        var cmd = "execute as " + String(e.uuid) + " at @s run playsound " + sound
        var res = GS_SERVER.runCommandSilent(cmd)
        GS_VOICE_DIAG.played++
        GS_VOICE_DIAG.last = cmd + " -> " + res
        if (GS_VOICE_DIAG.logged < 5) {
            GS_VOICE_DIAG.logged++
            gsLog("озвучка: " + cmd + " -> " + res)
        }
        return cmd + " -> " + res
    } catch (err) {
        if (!GS_VOICE_DIAG.error) {
            GS_VOICE_DIAG.error = true
            gsErr("озвучка", err)
        }
        return "ошибка: " + err
    }
}

var GS_VOICE_DIAG = { logged: 0, error: false, played: 0, missed: 0, last: "" }
var GS_VOICE_MISS = {}               // неозвученные реплики, которые звучали в игре: текст -> сколько раз

/** Реплики без записи - копим и раз в сотню сбрасываем в kubejs/voice_missing.json: потом их озвучить. */
function gsVoiceMiss(t) {
    GS_VOICE_DIAG.missed++
    GS_VOICE_MISS[t] = (GS_VOICE_MISS[t] || 0) + 1
    if (GS_VOICE_DIAG.missed % 100 === 1) gsVoiceMissSave()
}
function gsVoiceMissSave() {
    try {
        var old = JsonIO.read("kubejs/voice_missing.json")
        if (old) for (var k in old) if (!GS_VOICE_MISS[k]) GS_VOICE_MISS[k] = Number(old[k]) || 1
    } catch (e) { }
    try { JsonIO.write("kubejs/voice_missing.json", GS_VOICE_MISS) } catch (e) { gsErr("список неозвученных", e) }
}

// Голос хаска у гостей: рычание - нет (гости говорят сами), удар и смерть - как у игрока, шаги - по блоку.
// Подмену делает слушатель звуков рейдеров (primitive_creatures/bandit_roles.js, RAID_HUSKS).
const GS_HUSK_SOUNDS = ["tfg_no_sound", "entity.player.hurt", "entity.player.death"]

function gsHuskVoice(e) {
    try {
        if (typeof RAID_HUSKS === "undefined" || !e || String(e.type) !== "minecraft:husk") return
        var u = String(e.uuid)
        if (!RAID_HUSKS[u]) RAID_HUSKS[u] = { e: e, sounds: GS_HUSK_SOUNDS }
    } catch (err) { }
}

// ─── Разговоры ───────────────────────────────────────────────────────────────
//
// Темы: общие (GS_DIALOGS) и по обстановке (gsContextTopics): погода и время суток, сезон, края вокруг, достаток
// поселения по найденным при поиске блокам (крыши, мебель, сиденья, очаги, машины, поля...), деревья, посевы и
// животные рядом, текущее занятие. Тема по обстановке - не больше раза за визит. Разговоры бывают двух видов:
// занятие "talk" (встают друг напротив друга) и болтовня на ходу - когда двое рядом, чем бы ни были заняты.

const GS_Pose = Java.loadClass("net.minecraft.world.entity.Pose")
const GS_OFF_HAND = Java.loadClass("net.minecraft.world.InteractionHand").OFF_HAND
var GS_Climate = null
try { GS_Climate = Java.loadClass("net.dries007.tfc.util.climate.Climate") } catch (e) { }

const GS_CHAT_DIST = 6              // болтовня на ходу - если двое ближе
const GS_CHAT_CHANCE = 0.05         // в секунду на пару; у огня - втрое чаще, за одним делом - вдвое
const GS_CHAT_COOLDOWN = 500        // после разговора молчат 25-50 секунд
const GS_CONTEXT_SHARE = 0.7        // доля тем по обстановке, пока они не исчерпаны

// общие темы: {p} - хозяева поселения (им. падеж; в озвучке - "местные"), {m} - металл (вин. п.), {mn} - (им. п.),
// {i} - товар, {ig} - вещь (род. п.), {n} - число словом. Наборы закрытые - всё озвучено заранее.
const GS_DIALOGS = [
    ["Слышал? {p} опять рейд отбивали.", "Слышал. Разбойники совсем страх потеряли.", "Хорошо хоть мы с охраной ходим.", "С охраной и помирать веселее."],
    ["Сколько ещё тут стоять?", "До завтра, как торговец скажет.", "Ноги гудят после дороги.", "Потерпи."],
    ["Цены на {m} опять выросли.", "Это всё кузнецы, жулики.", "Сам ты жулик, у меня брат кузнец.", "Вот я и говорю."],
    ["Ты рыбу когда-нибудь ловил?", "Раз сома поймал. На {n} кило.", "Врёшь.", "Может, и вру. Но сом был."],
    ["Здешние на нас косо смотрят.", "Нас везде косо смотрят. Мы охрана.", "Зато платят.", "Платят - это громко сказано."],
    ["Как думаешь, {p} с нами дружить будут?", "Если торговля пойдёт - будут.", "А если не пойдёт?", "Тогда придём снова. Но не торговать."],
    ["Я вчера {n} кругов вокруг лагеря дал.", "Зачем?", "Сержант велел.", "Мудрый у нас сержант."],
    ["Что везём-то в этот раз?", "{i}, в основном.", "И ради этого мы тащились?", "Ради жалованья мы тащились."],
    ["Щит опять треснул.", "Сдай в кузню, заменят.", "Заменят. И из жалованья вычтут.", "Как всегда."],
    ["Скучаю по дому.", "Через пару дней будем.", "Жена пирог обещала.", "С чем?", "С надеждой, что я вернусь."],
    ["У тебя {ig} не найдётся?", "Найдётся. Но не для тебя.", "Жадина.", "Бережливый."],
    ["Говорят, на севере {mn} прямо под ногами лежит.", "Говорят, и драконы там же.", "Драконы - сказки.", "Скажи это тем, кто не вернулся."],
    ["Торговец наш сегодня злой.", "Полдня торговался. {p} уступать не любят.", "И как?", "Ушёл на {n} монет беднее."],
    ["Давно ты в охране?", "Лет {n}, если не врать.", "А если врать?", "Тогда с рождения."],
    ["Слышишь? Опять что-то рычит вдалеке.", "Кабан, наверное.", "Кабаны так не рычат.", "Тогда пусть рычит подальше."],
    ["Думаешь, нас ещё сюда позовут?", "Позовут, если {p} заплатят.", "А если не заплатят?", "Значит, не позовут."],
    ["Опять {mn} в цене упала.", "Тебе-то что? У тебя её нет.", "Вот поэтому и обидно.", "Логично."],
    ["Сапоги жмут.", "Разносишь.", "За {n} дней не разносил.", "Значит, сапоги тебя разнашивают."],
]
const GS_WORDS = {
    m: ["медь", "бронзу", "железо", "сталь", "серебро"],
    mn: ["медь", "бронза", "руда", "сталь", "соль"],
    i: ["Соль", "Шкуры", "Зерно", "Гвозди", "Верёвки", "Мука", "Глина"],
    ig: ["соли", "табака", "верёвки", "хлеба", "огнива", "ниток"],
    n: ["пять", "семь", "десять", "двенадцать", "двадцать", "тридцать"],
}
const GS_TREE_RU = { acacia: "акаций", ash: "ясеней", aspen: "осин", birch: "берёз", blackwood: "чёрного дерева", chestnut: "каштанов",
    douglas_fir: "пихт", hickory: "гикори", kapok: "капков", mangrove: "мангров", maple: "клёнов", oak: "дубов", palm: "пальм",
    pine: "сосен", rosewood: "палисандра", sequoia: "секвой", spruce: "елей", sycamore: "платанов", white_cedar: "кедров", willow: "ив" }
const GS_CROP_RU = { wheat: "пшеница", barley: "ячмень", oat: "овёс", rye: "рожь", maize: "кукуруза", rice: "рис", potato: "картошка",
    carrot: "морковь", onion: "лук", cabbage: "капуста", garlic: "чеснок", tomato: "помидоры", beet: "свёкла", soybean: "соя",
    squash: "тыква", sugarcane: "тростник", jute: "джут", papyrus: "папирус", green_bean: "фасоль", pumpkin: "тыква", melon: "дыня",
    red_bell_pepper: "перец", yellow_bell_pepper: "перец" }
// животное: [как назвать, домашнее ли]
const GS_ANIMAL_RU = { cow: ["корова", 1], pig: ["свинья", 1], sheep: ["овца", 1], chicken: ["курица", 1], duck: ["утка", 1],
    horse: ["лошадь", 1], donkey: ["осёл", 1], mule: ["мул", 1], goat: ["коза", 1], alpaca: ["альпака", 1], yak: ["як", 1],
    musk_ox: ["овцебык", 1], quail: ["перепёлка", 1], turkey: ["индюк", 1], peafowl: ["павлин", 1], cat: ["кошка", 1], dog: ["собака", 1],
    rabbit: ["заяц", 0], fox: ["лиса", 0], deer: ["олень", 0], moose: ["лось", 0], caribou: ["карибу", 0], boar: ["кабан", 0],
    wolf: ["волк", 0], direwolf: ["лютоволк", 0], black_bear: ["медведь", 0], grizzly_bear: ["гризли", 0], polar_bear: ["белый медведь", 0],
    cougar: ["пума", 0], panther: ["пантера", 0], lion: ["лев", 0], sabertooth: ["саблезуб", 0], tiger: ["тигр", 0], crocodile: ["крокодил", 0],
    frog: ["лягушка", 0], grouse: ["тетерев", 0], pheasant: ["фазан", 0], turtle: ["черепаха", 0], penguin: ["пингвин", 0] }

function gsPick(list) { return list[Math.floor(Math.random() * list.length)] }

/** Подставить слова в реплики; у результата .voice - те же реплики для озвучки (вместо названия хозяев - "местные"). */
function gsFill(v, lines, vars) {
    var host = gsHostFaction(v)
    var words = { p: host ? host.name : "местные" }
    for (var k in GS_WORDS) words[k] = gsPick(GS_WORDS[k])
    for (var k2 in (vars || {})) words[k2] = vars[k2]
    var voiceWords = {}
    for (var k3 in words) voiceWords[k3] = words[k3]
    voiceWords.p = "местные"
    var sub = (line, w) => line.replace(/\{(\w+)\}/g, (s, key) => w[key] !== undefined ? w[key] : s)
    var out = lines.map(l => sub(l, words))
    out.voice = lines.map(l => sub(l, voiceWords))
    return out
}

/** Обстановка у стража e: погода, время, сезон, край, деревья, посевы, животные рядом. */
function gsNearContext(level, e) {
    var pos = new RAID_BlockPosClass(Math.floor(e.getX()), Math.floor(e.getY()) + 1, Math.floor(e.getZ()))
    var c = { rain: false, thunder: false, temp: null, time: 0, season: null, biome: "", trees: {}, crops: {}, bushes: 0, animals: [] }
    try { c.rain = level.isRaining(); c.thunder = level.isThundering() } catch (err) { }
    try { if (GS_Climate) c.temp = Number(GS_Climate.getTemperature(level, pos)) } catch (err) { }
    try { c.time = Number(level.getDayTime()) % 24000 } catch (err) { }
    try { c.season = String(TR_Calendars.SERVER.getCalendarMonthOfYear().getSeason()) } catch (err) { }
    try { c.biome = String(level.getBiome(pos).unwrapKey().get().location().getPath()) } catch (err) { }
    for (var n = 0; n < 28; n++) {
        var a = Math.random() * 6.283185307179586, r = 2 + Math.random() * 14
        var x = Math.floor(e.getX() + Math.cos(a) * r), z = Math.floor(e.getZ() + Math.sin(a) * r)
        var h = gsSurface(level, x, z)
        ;[h - 1, h].forEach(y => {
            var id = String(level.getBlock(x, y, z).id)
            var m = id.match(/^tfc:wood\/log\/(\w+)$/)
            if (m) c.trees[m[1]] = (c.trees[m[1]] || 0) + 1
            m = id.match(/^tfc:crop\/(\w+)$/)
            if (m) c.crops[m[1]] = (c.crops[m[1]] || 0) + 1
            if (/^tfc:plant\/\w+_bush$/.test(id)) c.bushes++
        })
    }
    try {
        var list = level.getEntities(e, new RAID_AABBClass(e.getX() - 24, e.getY() - 8, e.getZ() - 24, e.getX() + 24, e.getY() + 8, e.getZ() + 24))
        for (var i = 0; i < list.size(); i++) {
            var t = String(list.get(i).type)
            var key = t.substring(t.indexOf(":") + 1)
            if (GS_ANIMAL_RU[key] && c.animals.indexOf(key) < 0) c.animals.push(key)
        }
    } catch (err) { }
    return c
}

function gsTopKey(map) {
    var best = null
    for (var k in map) if (!best || map[k] > map[best]) best = k
    return best
}

// Реплики тем по обстановке. Подстановки - только из закрытых наборов ({tree}, {crop}, {animal}, {p}), чтобы их можно
// было озвучить заранее (factions/voice_keys.js, kubejs/assets/tfg_voice).
const GS_CTX_LINES = {
    storm1: ["Гроза-то какая.", "Лишь бы молния в нас не ударила.", "В железе стоим - самое оно."],
    storm2: ["Слышал, как громыхнуло?", "Небо раскололось, не иначе.", "Сиди тихо, авось пронесёт."],
    snow1: ["Снег валит.", "В такую погоду дома сидеть надо.", "С чаем.", "И без сержанта."],
    snow2: ["Замело всё.", "Обратно по сугробам потащимся.", "Не каркай."],
    rain1: ["Опять льёт.", "Хоть пыль прибьёт.", "И нас заодно."],
    rain2: ["Промок до нитки.", "Под крышу бы.", "Под чью? Тут всё чужое."],
    rain3: ["Дождь, дождь...", "Для посевов хорошо.", "Для моих сапог - нет."],
    cold1: ["Холод собачий.", "Пальцы к копью примерзают.", "Держи ближе к телу."],
    cold2: ["Дыхание паром идёт.", "Зима близко, не иначе.", "Или уже пришла."],
    hot1: ["Жарища.", "В доспехах хоть яичницу жарь.", "Не подавай идей, я голодный."],
    hot2: ["Пить охота.", "Терпи до привала.", "Привал - это когда?"],
    clear1: ["Погода славная.", "Не сглазь."],
    clear2: ["Небо чистое.", "Видно далеко. И нас тоже далеко видно.", "Вот ты умеешь настроение испортить."],
    night1: ["Темень-то какая.", "Смотри в оба, ночью всякое бродит."],
    night2: ["Спать охота.", "На посту не спят.", "А я и не сплю. Я глаза отдыхаю."],
    morning: ["Светает.", "Самое время для каши.", "Самое время для службы, говорит сержант."],
    evening: ["Смеркается.", "Скоро к огню потянемся."],
    winter: ["Зима в разгаре.", "Хорошо хоть реки встали - переходить проще."],
    spring: ["Весна пришла.", "Грязи по колено.", "Зато птицы поют."],
    summer: ["Лето нынче щедрое.", "Если урожай будет - и торговля пойдёт."],
    autumn: ["Осень.", "Сейчас бы грибов пожарить.", "С тобой в лес только за поганками."],
    land_mount: ["Горы кругом.", "Красиво, но тащиться по ним - мука."],
    land_sea: ["Море рядом, солью пахнет.", "Рыба тут, небось, знатная."],
    land_water: ["Вода под боком - уже хорошо.", "И рыбалка, и умыться."],
    land_canyon: ["Ну и овраги тут.", "Ногу сломать - раз плюнуть."],
    land_marsh: ["Болото. Комары заедят.", "Зато чужие сюда не сунутся."],
    land_plain: ["Простор какой.", "Всё видно на лиги вокруг.", "И нас видно."],
    land_high: ["Высоко забрались.", "Воздух жидкий, дышать тяжело."],
    tree: ["Сколько тут {tree}.", "Хорошая древесина. Дорого бы продали."],
    crop: ["Гляди, {crop} растёт.", "Урожай, небось, неплохой будет.", "Если разбойники не вытопчут."],
    bushes: ["Ягоды! Набрать бы.", "Руки убери, не наше."],
    animal_home: ["Гляди, {animal}. Хозяйство держат.", "Сытно живут, значит."],
    animal_wild: ["Там {animal} бродит.", "Держи оружие под рукой.", "Или ужин добудем."],
    rich_roofs: ["Крыши-то у них какие.", "Богато живут.", "Черепица, не солома."],
    poor_roofs: ["Крыш почти не видно.", "В землянках живут, что ли?"],
    no_chairs: ["Тут совсем негде сесть.", "Гостей, видать, не ждали."],
    many_chairs: ["Стульев - хоть на пир зови.", "Гостей любят, выходит."],
    no_fires: ["Ни одного очага. Как они тут греются?", "Работой, наверное."],
    many_fires: ["Печей-то сколько.", "Дымят, как кузнечный квартал."],
    rich_furniture: ["Мебель как в городе.", "Столы, шкафы... Не бедствуют."],
    poor_furniture: ["Пусто у них как-то.", "Ни стола, ни шкафа.", "Может, всё продали."],
    machines_big: ["Сколько тут машин гудит.", "Как в столице мастеров.", "Не лезь, затянет."],
    machines: ["Механизмы у них крутятся.", "Мастеровые люди, значит."],
    lamps: ["Фонарей не жалеют.", "Ночью тут светло, как днём."],
    glass: ["Стёкла в окнах.", "Дорогое удовольствие."],
    bricks: ["Кирпичные дома.", "Надолго строили, на века."],
    fields: ["Поля большие.", "С голоду не помрут."],
    no_fields: ["А поля у них где?", "Покупают, видать. Нам же лучше."],
    storage: ["Бочек и сундуков сколько.", "Запасливые."],
    act_warm1: ["Хорошо у огня.", "Не то слово.", "Век бы так сидел."],
    act_warm2: ["Подкинь ещё полешко.", "Сам подкинь, ты ближе.", "Ладно, пусть догорает."],
    act_fish: ["Клюёт?", "Пока только комары.", "У меня тоже."],
    act_sit: ["Удобно сидишь?", "Лучше, чем в седле."],
    act_eat: ["Вкусно?", "Сносно. Ещё бы соли."],
    act_shelter: ["Переждём тут.", "Под крышей и дождь не страшен.", "Лишь бы не протекало."],
}

/** Темы по обстановке: [{ id, lines, vars }]; id - чтобы не повторять тему за визит. */
function gsContextTopics(v, level, rt, a, b) {
    var c = gsNearContext(level, a)
    var st = rt.pois.stats || {}
    var scanned = rt.scan && rt.scan.idx > rt.scan.list.length * 0.5
    var out = []
    var add = (id, key, vars) => { if (!rt.topics[id]) out.push({ id: id, lines: GS_CTX_LINES[key || id], vars: vars || {} }) }
    var cold = c.temp !== null && c.temp < 0, hot = c.temp !== null && c.temp > 25
    if (c.thunder) { add("storm1"); add("storm2") }
    else if (c.rain && cold) { add("snow1"); add("snow2") }
    else if (c.rain) { add("rain1"); add("rain2"); add("rain3") }
    else if (cold) { add("cold1"); add("cold2") }
    else if (hot) { add("hot1"); add("hot2") }
    else { add("clear1"); add("clear2") }
    if (c.time >= 13000 && c.time < 23000) { add("night1"); add("night2") }
    else if (c.time >= 23000 || c.time < 1500) add("morning")
    else if (c.time >= 11000) add("evening")
    if (c.season) {
        var s = c.season.toUpperCase()
        if (s.indexOf("WINTER") >= 0) add("winter")
        else if (s.indexOf("SPRING") >= 0) add("spring")
        else if (s.indexOf("SUMMER") >= 0) add("summer")
        else if (s.indexOf("FALL") >= 0 || s.indexOf("AUTUMN") >= 0) add("autumn")
    }
    var bio = c.biome
    if (/mountain|highland|plateau|volcan/.test(bio)) add("land_mount")
    else if (/ocean|shore|beach|sea/.test(bio)) add("land_sea")
    else if (/lake|river/.test(bio)) add("land_water")
    else if (/canyon|badland/.test(bio)) add("land_canyon")
    else if (/marsh|swamp|bog/.test(bio)) add("land_marsh")
    else if (/plain|lowland|hills/.test(bio)) add("land_plain")
    if (a.getY() > 150) add("land_high")
    var tree = gsTopKey(c.trees)
    if (tree && c.trees[tree] >= 3 && GS_TREE_RU[tree]) add("tree_" + tree, "tree", { tree: GS_TREE_RU[tree] })
    var crop = gsTopKey(c.crops)
    if (crop && GS_CROP_RU[crop]) add("crop_" + crop, "crop", { crop: GS_CROP_RU[crop] })
    if (c.bushes >= 2) add("bushes")
    c.animals.slice(0, 2).forEach(k => {
        var an = GS_ANIMAL_RU[k]
        add("animal_" + k, an[1] ? "animal_home" : "animal_wild", { animal: an[0] })
    })
    if (scanned) {
        if ((st.roofs || 0) >= 300) add("rich_roofs")
        else if ((st.roofs || 0) < 20) add("poor_roofs")
        if (rt.pois.chairs.length === 0) add("no_chairs")
        else if (rt.pois.chairs.length >= 15) add("many_chairs")
        if (rt.pois.fires.length === 0) add("no_fires")
        else if (rt.pois.fires.length >= 12) add("many_fires")
        if ((st.furniture || 0) >= 60) add("rich_furniture")
        else if ((st.furniture || 0) < 5) add("poor_furniture")
        if ((st.machines || 0) >= 300) add("machines_big")
        else if ((st.machines || 0) >= 40) add("machines")
        if ((st.lamps || 0) >= 60) add("lamps")
        if ((st.glass || 0) >= 200) add("glass")
        if ((st.bricks || 0) >= 400) add("bricks")
        if ((st.farmland || 0) >= 150) add("fields")
        else if ((st.farmland || 0) === 0) add("no_fields")
        if ((st.storage || 0) >= 60) add("storage")
    }
    var aa = rt.acts[String(a.uuid)], ab = b ? rt.acts[String(b.uuid)] : null
    var both = id => aa && ab && aa.id === id && ab.id === id
    if (both("warm")) { add("act_warm1"); add("act_warm2") }
    if (both("fish")) add("act_fish")
    if (both("shelter")) add("act_shelter")
    if (aa && aa.id === "sit") add("act_sit")
    if (aa && aa.id === "eat") add("act_eat")
    if (typeof gsSocialTopics === "function") {
        try { gsSocialTopics(v, rt, add) } catch (err) { gsErr("слухи", err) }
    }
    return out
}

/** Реплики разговора двоих: чаще по обстановке (не больше раза за визит на тему), иначе общая тема. */
function gsPickTopic(v, level, rt, a, b) {
    rt.topics = rt.topics || {}
    // свой караван вернулся домой: охрана говорит о доме, а не о чужом поселении (fairs.js)
    if (v.homecoming && typeof frHomeTalk === "function") {
        try { return frHomeTalk(v) } catch (err) { gsErr("домашний разговор", err) }
    }
    // своя дружина прилетела погостить: о доме, жаловании и прошлых боях
    if (v.warband && typeof frWarTalk === "function") {
        try { return frWarTalk(v) } catch (err) { gsErr("разговор дружины", err) }
    }
    var ctx = []
    try { ctx = gsContextTopics(v, level, rt, a, b) } catch (err) { gsErr("темы разговора", err) }
    if (ctx.length && Math.random() < GS_CONTEXT_SHARE) {
        var t = gsPick(ctx)
        rt.topics[t.id] = true
        return gsFill(v, t.lines, t.vars)
    }
    // свежий разговор: не тот, что был в этом визите, и не тот, что звучал на сервере недавно
    var free = GS_DIALOGS.map((d, i) => i).filter(i => !rt.topics["g" + i] &&
        (GS_LINE_USED["dlg" + i] === undefined || gsLineNow() - GS_LINE_USED["dlg" + i] >= GS_LINE_COOLDOWN))
    var idx = free.length ? gsPick(free) : gsPickFreshIndex(GS_DIALOGS.length, "dlg")
    GS_LINE_USED["dlg" + idx] = gsLineNow()
    rt.topics["g" + idx] = true
    return gsFill(v, GS_DIALOGS[idx])
}

/** Свободный напарник для разговора: не телохранитель, не в бою, не сидит, не занят разговором, в maxDist блоках. */
function gsTalkPartner(v, rt, e, fighting, maxDist) {
    var best = null, bestD = Math.pow(maxDist || 40, 2)
    v.guards.forEach(u => {
        var g = gsEntity(v, u)
        if (!g || g === e || (fighting && fighting[u])) return
        if (!maxDist && g.isPassenger()) return
        if (String(g.persistentData.getString("tfg_guest_role")) === "bodyguard" && !maxDist) return
        var act = rt.acts[u]
        if (act && act.id === "talk") return
        if (rt.chatOf && rt.chatOf[u]) return
        var d = gsDist2(g, e.getX(), e.getZ())
        if (d < bestD) { bestD = d; best = g }
    })
    return best
}

/** Разговор двоих лицом к лицу: встают друг напротив друга посередине. */
function gsStartTalk(v, level, rt, a, b, now) {
    var mx = (a.getX() + b.getX()) / 2, mz = (a.getZ() + b.getZ()) / 2
    var spot = gsNearestStand(level, Math.floor(mx), Math.floor(mz), 8)
    var ang = Math.random() * 6.283185307179586
    ;[a, b].forEach(g => gsEndChatOf(v, rt, String(g.uuid)))
    var talk = {
        a: String(a.uuid), b: String(b.uuid), lines: gsPickTopic(v, level, rt, a, b), idx: 0, next: 0, started: false,
        pa: { x: spot.x + Math.cos(ang) * 1.3, y: spot.y, z: spot.z + Math.sin(ang) * 1.3 },
        pb: { x: spot.x - Math.cos(ang) * 1.3, y: spot.y, z: spot.z - Math.sin(ang) * 1.3 },
    }
    ;[a, b].forEach((g, i) => {
        var key = String(g.uuid)
        gsFinishAct(g, rt.acts[key])
        rt.acts[key] = { id: "talk", talk: talk, first: i === 0, stage: "talk", until: now + 3600, started: now }
    })
    return talk
}

/** Имя стража над головой (восстановить после реплики): "Страж · фракция" цветом фракции. */
function gsRestoreName(e) {
    // житель поселения - не страж гостей: ему возвращает имя factions/settlers.js
    try {
        if (e.getTags().contains("tfg_settler") && typeof seRestoreSettlerName === "function") {
            seRestoreSettlerName(e)
            return
        }
    } catch (err) { }
    var fac = null
    try { fac = raidTagOf(e, "tfg_faction:") } catch (err) { }
    var faction = fac ? trFaction(fac) : null
    var own = null
    try { own = global.TFG_NPC.nameOf(e) } catch (err) { }
    // своё имя-титул (воевода дружины - fairs.js): по нему и скин
    var over = ""
    try { over = String(e.persistentData.getString("tfg_title_override") || "") } catch (err) { }
    var text = Text.of(over ? over : e.getTags().contains("tfg_trader") ? trTitle(e)
        : (own ? own + " · " : "") + "Страж" + (faction ? " · " + faction.name : ""))
    try { if (faction) text = text.color(trColor(faction).text) } catch (err) { }
    e.setCustomName(text)
}

// Слова, по которым ETF выбирает скин (kubejs/assets/.../zombie/husk.properties). Реплика над
// головой заменяла имя целиком - слова не оставалось, и говорящий на время реплики становился
// обычным хаском («кадавром»). Теперь реплика идёт после слова роли: «Кузнец: ...».
const GS_SKIN_RE = /(Налётчик|Страж|Правитель|Рыцарь|Дружинник|Стрелок|Ружейник|Торговец|Торговка|Скупщик|Старьёвщик|Бард|Певунья|Повар|Мясник|Рыбак|Садовник|Кузнец|Оружейник|Бронник|Портной|Химик|Металлург|Электрик|Механик|Оценщик|Строитель|Плотник|Гончар|Шахтёр|Камнелом|Крестьянин|Крестьянка|Охотник|Охотница|Лесоруб|Разбойник|Громила|Головорез|Наёмник)/

/** Слово роли этого NPC (для скина): из нынешнего имени, иначе запомненное. */
function gsSkinWord(e) {
    var pd = null
    try { pd = e.persistentData } catch (err) { }
    var name = ""
    try { var cn = e.getCustomName(); if (cn) name = String(cn.getString()) } catch (err) { }
    var m = name.match(GS_SKIN_RE)
    if (m) { try { pd.putString("tfg_skin_word", m[1]) } catch (err) { } return m[1] }
    try { return String(pd.getString("tfg_skin_word") || "") } catch (err) { return "" }
}

// Слово чужой роли в самой реплике («Правитель, всё распродали») тоже сбило бы скин: правило
// ETF раньше по списку сработает на него. Меняем в нём одну букву на латинскую-двойника -
// на экране то же самое, а для правила это уже другое слово.
const GS_HOMOGLYPH = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x" }
function gsMaskSkinWords(line) {
    return String(line).replace(new RegExp(GS_SKIN_RE.source, "g"), w => {
        for (var i = 1; i < w.length; i++) {
            var lat = GS_HOMOGLYPH[w.charAt(i)]
            if (lat) return w.substring(0, i) + lat + w.substring(i + 1)
        }
        return w
    })
}

function gsSay(e, a, line, voice) {
    if (voice !== undefined) gsPlayVoice(e, voice)
    var word = gsSkinWord(e)
    var text = Text.of(word ? word + ": " + gsMaskSkinWords(line) : line)
    try { text = text.white() } catch (err) { }
    e.setCustomName(text)
    e.setCustomNameVisible(true)
}

function gsQuiet(e, a) {
    try { if (e.isCustomNameVisible() || (a && a.id === "talk")) gsRestoreName(e) } catch (err) { }
    // имя жителя видно всегда: это не безымянный страж
    try { e.setCustomNameVisible(e.getTags().contains("tfg_trader") || e.getTags().contains("tfg_settler")) } catch (err) { }
    try { e.setPose(GS_Pose.STANDING) } catch (err) { }
}

function gsEndTalk(v, rt, talk, now) {
    ;[talk.a, talk.b].forEach(u => {
        var act = rt.acts[u]
        if (act && act.talk === talk) act.until = now
    })
}

/** Показать очередную реплику: говорящий машет руками, слушатель молчит. true - реплики кончились. */
function gsSpeakStep(talk, e1, e2, now) {
    if (talk.idx >= talk.lines.length) return true
    var line = talk.lines[talk.idx]
    var speaker = talk.idx % 2 === 0 ? e1 : e2
    var listener = speaker === e1 ? e2 : e1
    gsSay(speaker, null, line, talk.lines.voice ? talk.lines.voice[talk.idx] : line)
    gsQuiet(listener, null)
    if (speaker.getNavigation().isDone()) speaker.swing(RAID_MAIN_HAND)
    talk.idx++
    talk.next = now + 50 + line.length * 3
    return false
}

function gsTalkTick(v, level, e, rt, a, now) {
    var talk = a.talk
    var mine = a.first ? talk.pa : talk.pb
    var other = gsEntity(v, a.first ? talk.b : talk.a)
    var otherAct = other ? rt.acts[a.first ? talk.b : talk.a] : null
    if (!other || !otherAct || otherAct.talk !== talk) { a.until = now; return }
    try { e.setPose(GS_Pose.STANDING) } catch (err) { }
    var nav = e.getNavigation()
    if (!talk.started) {
        if (gsDist2(e, mine.x, mine.z) > 1.2) {
            if (nav.isDone() || now >= (a.next || 0)) { gsWalk(e, mine.x, mine.y, mine.z, 0.9); a.next = now + 60 }
            return
        }
        nav.stop()
        var theirs = a.first ? talk.pb : talk.pa
        if (gsDist2(other, theirs.x, theirs.z) > 1.2) {
            if (now - (a.waitFrom || (a.waitFrom = now)) > 600) talk.started = true    // напарник застрял - говорят как есть
            return
        }
        talk.started = true
    }
    nav.stop()
    e.getLookControl().setLookAt(other.getX(), other.getEyeY(), other.getZ())
    if (!a.first) {
        if (talk.idx % 2 === 1 && Math.random() < 0.3) { try { e.setPose(GS_Pose.CROUCHING) } catch (err) { } }   // кивает
        return
    }
    if (now < talk.next) {
        var speaker = talk.idx % 2 === 1 ? e : other
        if (Math.random() < 0.35) speaker.swing(Math.random() < 0.5 ? RAID_MAIN_HAND : GS_OFF_HAND)
        return
    }
    if (gsSpeakStep(talk, e, other, now)) gsEndTalk(v, rt, talk, now)
}

// ── болтовня на ходу и за делами ──

function gsEndChatOf(v, rt, u) {
    if (!rt.chatOf || !rt.chatOf[u]) return
    var chat = rt.chatOf[u]
    ;[chat.a, chat.b].forEach(k => {
        var g = gsEntity(v, k)
        if (g) gsQuiet(g, null)
        delete rt.chatOf[k]
        rt.chatCd[k] = (chat.now || 0) + GS_CHAT_COOLDOWN + Math.floor(Math.random() * GS_CHAT_COOLDOWN)
    })
    rt.chats = rt.chats.filter(c => c !== chat)
}

/** Раз в секунду: идущие разговоры и новые - между любыми двумя стражами рядом, чем бы они ни были заняты. */
function gsChatTick(v, level, rt, guards, fighting, now) {
    rt.chats = rt.chats || []
    rt.chatOf = rt.chatOf || {}
    rt.chatCd = rt.chatCd || {}
    rt.chats.slice().forEach(chat => {
        chat.now = now
        var g1 = gsEntity(v, chat.a), g2 = gsEntity(v, chat.b)
        var broken = !g1 || !g2 || fighting[chat.a] || fighting[chat.b] || gsDist2(g1, g2.getX(), g2.getZ()) > 144 ||
            (rt.acts[chat.a] && rt.acts[chat.a].id === "talk") || (rt.acts[chat.b] && rt.acts[chat.b].id === "talk")
        if (broken) return gsEndChatOf(v, rt, chat.a)
        // стоят - смотрят друг на друга
        if (g1.getNavigation().isDone()) g1.getLookControl().setLookAt(g2.getX(), g2.getEyeY(), g2.getZ())
        if (g2.getNavigation().isDone()) g2.getLookControl().setLookAt(g1.getX(), g1.getEyeY(), g1.getZ())
        if (now < chat.next) {
            var sp = chat.idx % 2 === 1 ? g1 : g2
            if (sp.getNavigation().isDone() && !sp.isPassenger() && Math.random() < 0.25) sp.swing(Math.random() < 0.5 ? RAID_MAIN_HAND : GS_OFF_HAND)
            return
        }
        if (gsSpeakStep(chat, g1, g2, now)) gsEndChatOf(v, rt, chat.a)
    })
    guards.forEach(g => {
        var u = String(g.uuid)
        if (fighting[u] || rt.chatOf[u] || (rt.chatCd[u] || 0) > now) return
        var act = rt.acts[u]
        if (act && act.id === "talk") return
        var partner = gsTalkPartner(v, rt, g, fighting, GS_CHAT_DIST)
        if (!partner) return
        var pu = String(partner.uuid)
        if ((rt.chatCd[pu] || 0) > now) return
        var pact = rt.acts[pu]
        var chance = GS_CHAT_CHANCE
        if (act && pact && (act.id === "warm" || act.id === "shelter") && act.id === pact.id) chance *= 3
        else if (act && pact && act.id === pact.id) chance *= 2
        if (Math.random() > chance) return
        var chat = { a: u, b: pu, lines: gsPickTopic(v, level, rt, g, partner), idx: 0, next: now, now: now }
        rt.chats.push(chat)
        rt.chatOf[u] = chat
        rt.chatOf[pu] = chat
    })
}

// ─── Погода, укрытие, монологи ───────────────────────────────────────────────

var GS_EnvHelpers = null
try { GS_EnvHelpers = Java.loadClass("net.dries007.tfc.util.EnvironmentHelpers") } catch (e) { }

const GS_MONO_CHANCE = 0.07         // в секунду на гостя, когда он ни с кем не говорит
const GS_MONO_COOLDOWN = 200        // после реплики - 10-30 секунд тишины
const GS_SHELTER_RADIUS = 40
const GS_SHELTER_RETRY = 200        // не нашёл кров - снова искать через 10 секунд

const GS_MONO = {
    idle: ["Ох...", "Мда...", "*кашляет*", "Кхе-кхе.", "Эх.", "Хм.", "Ну-ну.", "Так-так.", "Ай, спина...", "*чешет затылок*", "*вздыхает*",
        "Ну и денёк.", "Скорей бы домой.", "Где мой кисет...", "*насвистывает*", "Ничего, прорвёмся.", "Есть охота.", "Хорошо...", "Ну что ж.",
        "Да уж.", "Эх, жизнь.", "Что-то я забыл...", "А погода ничего.", "Ну и ну."],
    rain: ["Ну и слякоть.", "Льёт и льёт.", "Вымок весь.", "Тьфу, сырость.", "Опять за шиворот течёт.",
        "Сапоги промокли.", "Грязь по колено.", "Опять дождь."],
    snow: ["Бр-р, метёт.", "Снегу-то навалило.", "Уши отморожу.", "Сугробы по колено.", "Белым-бело.", "Снег за шиворот набился."],
    cold: ["Бр-р, холодно.", "Зуб на зуб не попадает.", "*дышит на руки*", "Руки не гнутся.", "Надо было шубу брать.",
        "Ветер до костей пробирает.", "Костёр бы сейчас.", "Нос отмёрз."],
    hot: ["Уф, жара.", "Пить охота.", "Пекло.", "Солнце печёт.", "Воды бы холодной.", "В тень бы."],
    thunder: ["Ох, гремит!", "Ну и гроза.", "*вздрагивает*"],
    night: ["*зевает*", "Спать охота.", "Темень...", "Глаза слипаются.", "Ничего не видно.", "Тише, люди спят."],
    warm: ["Тепло...", "Ох, отогреваюсь.", "*греет руки*", "Хорошо горит.", "Ох, хорошо у огня.", "Дровишек подкинуть бы."],
    camp: ["Дорога вымотала.", "Ноги гудят.", "Тут и заночуем.", "Костёр развели - уже полдела.",
        "Завтра ещё день пути.", "Колесо бы проверить.", "До темноты успели, и ладно.",
        "Не май месяц ночевать в поле.", "Спину бы разогнуть.", "Дальше дорога хуже будет.",
        "Ничего, дойдём.", "Главное - разбойников не встретить.", "Караул выставили?",
        "Посплю в палатке, кто на вторую стражу?", "Товар пересчитать надо."],
    camp_watch: ["Стою, смотрю.", "Тихо пока.", "Кто там шастает?", "Ночь долгая.", "Глаз не сомкну."],
    camp_beasts: ["Скотина беспокоится.", "Сено бы им.", "Пить хотят.", "Стоять, родимая."],
    fish: ["Ну клюй же...", "Тихо, рыбу спугнёшь.", "Опять пусто."],
    sit: ["Ох, ноги...", "Посижу немного.", "*потягивается*"],
    eat: ["Ммм.", "Сухарь, а не хлеб.", "*жуёт*"],
    walk: ["Далеко ещё?", "Ноги гудят.", "Шагай, шагай..."],
    shelter: ["Скорей под крышу!", "Переждём тут.", "Вот тут сухо.", "Пусть льёт, нам не страшно."],
    noShelter: ["Негде укрыться...", "Хоть бы навес какой."],
    travel: ["Скорей бы дойти.", "Не отставай.", "Смотри по сторонам."],
    depart: ["Ну, в путь.", "Домой!", "Прощай, поселение."],
    battle: ["К оружию!", "Бей их!", "Держать строй!", "За наших!", "Ну, подходи!"],
    flee: ["Бежим!", "Отходим!", "Спасайся!"],
    trader: ["Товар отличный, берите.", "Кому что надобно?", "Цены честные.", "Хм, где же покупатели...", "*пересчитывает монеты*"],
    // одиночки: охотник, лесоруб, шахтёр, камнелом - своё ремесло и дорога без охраны
    solo_hunter: ["Шкуры свежие, сам снимал.", "Волков тут нынче много.", "Один хожу - зверь меня не трогает.", "Олень у ручья пасётся, видел?",
        "Мясо сушёное есть, берите.", "Охрана? Мне лук - охрана."],
    solo_lumberjack: ["Брёвна сухие, отборные.", "Лес у вас знатный.", "Один топор - и весь мой обоз.", "Сосна смолистая, гореть будет жарко.",
        "Саженцы есть, сажайте - внукам пригодится.", "Руки в смоле, не обессудьте."],
    solo_miner: ["Руда добрая, сам колол.", "Под землёй тише, чем у вас.", "Факелы есть, без них в шахту не суйтесь.", "Глаза к свету не привыкнут никак.",
        "Жила там богатая, да глубоко.", "Кирка тупится, а камень не кончается."],
    solo_quarryman: ["Камень ровный, тёсаный.", "Стену сложить - самое то.", "Щебень, булыжник - что надобно?", "Спина от камня не разгибается.",
        "У вас тут порода мягкая, легко колется.", "Один хожу, камень никто не крадёт."],
}

/** Погода у центра визита (раз в 5 секунд): дождь или снег, гроза, холод, жара. */
function gsWeather(v, level, rt, now) {
    if (rt.weather && now - rt.weather.at < 100) return rt.weather
    var pos = new RAID_BlockPosClass(v.center.x, v.center.y + 2, v.center.z)
    var w = { at: now, wet: false, thunder: false, temp: null }
    try { w.wet = GS_EnvHelpers ? GS_EnvHelpers.isRainingOrSnowing(level, pos) : level.isRaining() } catch (e) { w.wet = level.isRaining() }
    try { w.thunder = level.isThundering() } catch (e) { }
    try { if (GS_Climate) w.temp = Number(GS_Climate.getTemperature(level, pos)) } catch (e) { }
    w.bad = w.wet || w.thunder
    rt.weather = w
    return w
}

function gsSkyOver(level, e) {
    try { return level.canSeeSky(new RAID_BlockPosClass(Math.floor(e.getX()), Math.floor(e.getY()) + 1, Math.floor(e.getZ()))) } catch (err) { return false }
}

function gsFreeAt(level, x, y, z) {
    var st = level.getBlockState(new RAID_BlockPosClass(x, y, z))
    return st.getCollisionShape(level, new RAID_BlockPosClass(x, y, z)).isEmpty() && st.getFluidState().isEmpty()
}

/** Сухое место под крышей рядом: из найденных раньше (не больше троих на место) или новый поиск вокруг. */
function gsFindShelter(level, rt, e) {
    rt.shelters = rt.shelters || []
    rt.shelterUse = rt.shelterUse || {}
    var ok = s => (rt.shelterUse[s.key] || 0) < 3 && gsDist2(e, s.x, s.z) < GS_SHELTER_RADIUS * GS_SHELTER_RADIUS
    var best = null, bestD = 1e18
    rt.shelters.forEach(s => { var d = gsDist2(e, s.x, s.z); if (ok(s) && d < bestD) { bestD = d; best = s } })
    if (best && !level.canSeeSky(new RAID_BlockPosClass(Math.floor(best.x), best.y + 1, Math.floor(best.z)))) return best
    var ex = Math.floor(e.getX()), ey = Math.floor(e.getY()), ez = Math.floor(e.getZ())
    for (var n = 0; n < 140; n++) {
        var r = 2 + Math.random() * GS_SHELTER_RADIUS * Math.min(1, (n + 20) / 100)     // сначала ближе
        var a = Math.random() * 6.283185307179586
        var x = Math.floor(ex + Math.cos(a) * r), z = Math.floor(ez + Math.sin(a) * r)
        for (var dy = 4; dy >= -4; dy--) {
            var y = ey + dy
            if (!gsFreeAt(level, x, y, z) || !gsFreeAt(level, x, y + 1, z) || gsFreeAt(level, x, y - 1, z)) continue
            if (level.canSeeSky(new RAID_BlockPosClass(x, y + 1, z))) continue
            var s = { x: x + 0.5, y: y, z: z + 0.5, key: x + "," + y + "," + z }
            if (rt.shelters.length < 60) rt.shelters.push(s)
            return s
        }
    }
    return null
}

/** Непогода и страж под открытым небом - бросает дело и бежит под крышу (раз в GS_SHELTER_RETRY, если не нашёл). */
function gsShelterCheck(v, level, g, rt, now) {
    var key = String(g.uuid)
    var act = rt.acts[key]
    var w = gsWeather(v, level, rt, now)
    if (!w.bad) return
    if (act && (act.id === "shelter" || act.id === "talk")) return
    if (g.isPassenger() || !gsSkyOver(level, g)) return
    rt.shelterTry = rt.shelterTry || {}
    if ((rt.shelterTry[key] || 0) > now) return
    var s = gsFindShelter(level, rt, g)
    if (!s) {
        rt.shelterTry[key] = now + GS_SHELTER_RETRY
        gsMono(v, rt, g, "noShelter", now, 0.5)
        return
    }
    gsFinishAct(g, act)
    rt.shelterUse[s.key] = (rt.shelterUse[s.key] || 0) + 1
    rt.acts[key] = { id: "shelter", stage: "go", poi: { x: s.x, y: s.y, z: s.z }, key: s.key, useMap: rt.shelterUse, until: now + 6000, next: 0, started: now, dur: 6000 }
    gsMono(v, rt, g, "shelter", now, 0.6)
}

/** Выбор реплики с оглядкой на недавно сказанное: одно и то же подряд не повторяем. */
// Одна и та же реплика не звучит снова раньше, чем через GS_LINE_COOLDOWN - на всём сервере, а не
// только в одном визите: «Роса холодная, а день длинный» пятисотый раз выносит мозг. Свежих нет -
// берём ту, что звучала давнее всех.
var GS_LINE_USED = {}                // реплика (или "ключ") -> тик сервера, когда звучала
const GS_LINE_COOLDOWN = 36000       // полчаса

function gsLineNow() { try { return Number(GS_SERVER.getTickCount()) } catch (e) { return 0 } }

function gsPickFresh(list, rt) {
    if (!list || !list.length) return null
    var now = gsLineNow()
    var fresh = list.filter(s => GS_LINE_USED[s] === undefined || now - GS_LINE_USED[s] >= GS_LINE_COOLDOWN)
    var pick = fresh.length ? gsPick(fresh)
        : list.slice().sort((a, b) => (GS_LINE_USED[a] || 0) - (GS_LINE_USED[b] || 0))[0]
    GS_LINE_USED[pick] = now
    return pick
}

/** То же для наборов реплик (разговоров): номер набора, давно не звучавшего. prefix - чей набор. */
function gsPickFreshIndex(n, prefix) {
    var keys = []
    for (var i = 0; i < n; i++) keys.push(prefix + i)
    var k = gsPickFresh(keys, null)
    return Number(String(k).substring(prefix.length))
}

/** Короткая реплика одного гостя над головой: из списка kind (или готовая line) с шансом chance (1 - всегда). */
function gsMono(v, rt, e, kind, now, chance, line) {
    rt.mono = rt.mono || {}
    rt.monoCd = rt.monoCd || {}
    var u = String(e.uuid)
    if (rt.mono[u] || (rt.chatOf && rt.chatOf[u])) return false
    var act = rt.acts[u]
    if (act && act.id === "talk") return false
    if (chance < 1 && Math.random() > chance) return false
    if (!line) line = gsPickFresh(GS_MONO[kind], rt)
    gsSay(e, null, line, line)
    rt.mono[u] = now + 50 + line.length * 3
    rt.monoCd[u] = now + GS_MONO_COOLDOWN + Math.floor(Math.random() * GS_MONO_COOLDOWN * 2)
    return true
}

/** Раз в секунду: снять отзвучавшие реплики, иногда сказать что-то по обстановке или просто вздохнуть. */
function gsMonoTick(v, level, rt, trader, guards, fighting, now) {
    rt.mono = rt.mono || {}
    rt.monoCd = rt.monoCd || {}
    rt.wasFighting = rt.wasFighting || {}
    var w = gsWeather(v, level, rt, now)
    var night = gsIsNight(level)
    ;[trader].concat(guards).forEach(e => {
        if (!e) return
        var u = String(e.uuid)
        if (rt.mono[u] && now >= rt.mono[u]) {
            delete rt.mono[u]
            if (!(rt.chatOf && rt.chatOf[u])) gsQuiet(e, null)
        }
        // боевой клич - когда страж только вступил в бой
        if (fighting[u] && !rt.wasFighting[u]) gsMono(v, rt, e, "battle", now, 0.5)
        rt.wasFighting[u] = !!fighting[u]
        if (fighting[u] || rt.mono[u] || (rt.monoCd[u] || 0) > now) return
        if (e === trader && level.getNearestPlayer(e, 6)) return          // у торговца идёт сделка - имя не заслонять
        if (Math.random() > GS_MONO_CHANCE) return
        var act = rt.acts[u]
        var kinds = []
        if (e === trader) kinds.push(v.solo && GS_MONO["solo_" + v.kindId] ? "solo_" + v.kindId : "trader")
        if (w.thunder) kinds.push("thunder")
        if (w.wet) kinds.push(w.temp !== null && w.temp < 0 ? "snow" : "rain")
        else if (w.temp !== null && w.temp < 0) kinds.push("cold")
        else if (w.temp !== null && w.temp > 25) kinds.push("hot")
        if (night) kinds.push("night")
        if (act && GS_MONO[act.id] && act.stage !== "go") kinds.push(act.id)
        if (act && act.stage === "go" && act.id !== "shelter") kinds.push("walk")
        if (v.phase === "travel") kinds.push("travel")
        if (v.phase === "depart" || v.phase === "board") kinds.push(v.fleeing ? "flee" : "depart")
        var kind = kinds.length && Math.random() < 0.6 ? gsPick(kinds) : "idle"
        gsMono(v, rt, e, kind, now, 1)
    })
}

// ─── Вред транспорту, угон ───────────────────────────────────────────────────

/** Отряд нападает на игрока и его фракцию; ticks - сколько держится вражда (продлевается, не сокращается). */
function gsProvoke(v, player, level, ticks, why) {
    var ids = [String(player.uuid)]
    var pf = global.TFG_SETTLEMENTS ? global.TFG_SETTLEMENTS.factionOf(player) : null
    if (pf) pf.members.forEach(m => { if (ids.indexOf(m) < 0) ids.push(m) })
    var fresh = !v.hostile
    var now = gsNow(level)
    if (v.hostile) v.hostile.players.forEach(u => { if (ids.indexOf(u) < 0) ids.push(u) })
    v.hostile = { players: ids, until: Math.max(v.hostile ? v.hostile.until : 0, now + ticks) }
    if (fresh) {
        gsSave()
        // цена та же, что у такого же события в мире (factions/politics.js)
        try {
            global.TFG_POLITICS.deed(player, v.faction, v.caravan ? "raid" : "ambush",
                "нападение на " + (v.caravan ? "караван" : "гостей") + " фракции")
        } catch (e) { }
        gsLog(v.id + ": " + player.username + " - " + why + " - отряд атакует " + (pf ? "фракцию " + pf.name : "его"))
        var faction = trFaction(v.faction)
        player.tell(Text.of("§c" + (faction ? faction.name : "Гости") + ": " + why + " - охрана атакует " + (pf ? "всю вашу фракцию" : "вас") + "!"))
    }
}

/** Виноватый в поломке: ближайший игрок в выживании в 48 блоках. */
function gsBlame(level, e) {
    var best = null, bestD = 48 * 48
    var dim = String(level.getDimension())
    GS_SERVER.players.forEach(p => {
        if (String(p.level.getDimension()) !== dim || p.isCreative() || p.isSpectator()) return
        var d = gsDist2(p, e.getX(), e.getZ())
        if (d < bestD) { bestD = d; best = p }
    })
    return best
}

/** Раз в секунду: урон и гибель аппаратов и повозок, игроки на транспорте гостей. */
function gsGuardProperty(v, level, rt) {
    if (!rt.property) rt.property = {}
    var list = v.crafts.map(u => ({ u: u, kind: "craft" })).concat(v.carts.map(u => ({ u: u, kind: "cart" })), v.horses.map(u => ({ u: u, kind: "horse" })))
    list.forEach(o => {
        var e = GS_ENT[o.u] || gsEntity(v, o.u)
        if (!e) return
        GS_ENT[o.u] = e
        var st = rt.property[o.u] || (rt.property[o.u] = { hp: null })
        if (st.done) return
        if (!e.isAlive()) {
            st.done = true
            var reason = ""
            try { reason = String(e.getRemovalReason()) } catch (err) { }
            if (reason.indexOf("KILLED") >= 0) {
                var killer = gsBlame(level, e)
                if (killer) gsProvoke(v, killer, level, GS_HOSTILE_TICKS, o.kind === "craft" ? "вы уничтожили наш аппарат" : o.kind === "cart" ? "вы сломали нашу повозку" : "вы убили нашу лошадь")
            }
            return
        }
        // урон: у аппаратов - прочность, у повозок - накопленный урон (у лошади - EntityEvents.hurt)
        var hp = null
        try { hp = o.kind === "craft" ? Number(e.getHealth()) : o.kind === "cart" ? -Number(e.getDamageTaken()) : null } catch (err) { }
        if (hp !== null && st.hp !== null && hp < st.hp - 0.001) {
            var hitter = gsBlame(level, e)
            if (hitter) gsProvoke(v, hitter, level, GS_HOSTILE_TICKS, o.kind === "craft" ? "вы ломаете наш аппарат" : "вы ломаете нашу повозку")
        }
        if (hp !== null) st.hp = hp
        // угон: вражда, пока игрок на нашем транспорте
        try {
            var ps = e.getPassengers()
            for (var i = 0; i < ps.size(); i++) {
                var p = ps.get(i)
                if (p.isPlayer()) gsProvoke(v, p, level, 100, o.kind === "horse" ? "вы угоняете нашу лошадь" : "вы угоняете наш транспорт")
            }
        } catch (err) { }
    })
}

// ─── Оповещения, враги на виду, бегство, налёты ──────────────────────────────

const GS_Enemy = Java.loadClass("net.minecraft.world.entity.monster.Enemy")
const GS_FLEE_SHARE = 0.4           // осталось 40% охраны и меньше - бегство
const GS_HOSTILE_RELATION = -75     // отношения фракций ниже - вражда: нападают друг на друга при встрече
const GS_RAID_TICKS = 12000         // налёт враждебной фракции длится до 10 минут
const GS_WEEKLY_CHANCE = 0.75       // шанс, что на неделе кто-то придёт
const GS_TRANSPORT_TEXT = { foot: "пешком", cart: "на повозках", airship: "на дирижабле", cargo_airship: "на грузовом дирижабле", warship: "на боевом дирижабле" }

function gsFactionName(id) {
    var f = trFaction(id)
    return f ? f.name : id
}

/** Фракция игроков, чей центр базы в 64 блоках от центра визита. */
function gsHostFaction(v) {
    var best = null, bestD = 64 * 64
    try {
        global.TFG_SETTLEMENTS.all().forEach(f => {
            if (!f.base || f.base.dim !== v.dim) return
            var d = Math.pow(f.base.x - v.center.x, 2) + Math.pow(f.base.z - v.center.z, 2)
            if (d <= bestD) { bestD = d; best = f }
        })
    } catch (e) { }
    return best
}

/** Сообщение хозяевам поселения (онлайн); поселения нет - игрокам в 300 блоках от центра. */
function gsNotify(v, msg) {
    var host = gsHostFaction(v)
    GS_SERVER.players.forEach(p => {
        var to = host ? host.members.indexOf(String(p.uuid)) >= 0
            : String(p.level.getDimension()) === v.dim && gsDist2(p, v.center.x, v.center.z) < 300 * 300
        if (to) p.tell(Text.of(msg))
    })
}

function gsFactionsHostile(a, b) {
    if (!a || !b || a === b) return false
    if (a === "bandits" || b === "bandits") return true
    try { return Number(global.TFG_FACTIONS.relation(a, b)) < GS_HOSTILE_RELATION } catch (e) { return false }
}

/** Враг для отряда v: разбойники, гости и торговцы враждебной фракции, монстры. */
function gsIsEnemy(v, e) {
    if (!e.isAlive() || e.isPlayer()) return false
    var tags = e.getTags()
    if (tags.contains("tfg_bandit") || tags.contains("tfg_raid")) return true
    var pd = e.persistentData
    if (pd.contains("tfg_guest_visit") && String(pd.getString("tfg_guest_visit")) === v.id) return false
    var fac = raidTagOf(e, "tfg_faction:")
    if (fac) return gsFactionsHostile(v.faction, fac)
    if (tags.contains("tfg_npc")) return false
    return e instanceof GS_Enemy
}

/** Враги рядом со стражами (раз в секунду на визит). */
function gsEnemiesNear(v, level, guards) {
    var seen = {}
    var out = []
    guards.forEach(g => {
        var list = level.getEntities(g, new RAID_AABBClass(g.getX() - 40, g.getY() - 16, g.getZ() - 40, g.getX() + 40, g.getY() + 16, g.getZ() + 40))
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            var key = String(e.uuid)
            if (seen[key]) continue
            seen[key] = true
            try { if (gsIsEnemy(v, e)) out.push(e) } catch (err) { }
        }
    })
    return out
}

/** Цель стража: ближайший из врагов на виду (монстры - до 16 блоков) или игрок, с которым вражда. */
function gsPickTarget(v, g, enemies) {
    var best = gsHostileTarget(v, g)
    var bestD = best ? gsDist2(g, best.getX(), best.getZ()) : 1e18
    enemies.forEach(e => {
        if (!e.isAlive()) return
        var d = gsDist2(g, e.getX(), e.getZ())
        var limit = e instanceof GS_Enemy && !e.getTags().contains("tfg_bandit") ? 16 : 40
        if (d >= bestD || d > limit * limit || !g.hasLineOfSight(e)) return
        bestD = d
        best = e
    })
    return best
}

/** Налётчики без дела: к ближайшему игроку фракции-цели в 300 блоках, иначе рыщут у центра. */
function gsRaidHunt(v, level, g, now) {
    var best = null, bestD = 300 * 300
    GS_SERVER.players.forEach(p => {
        if (v.raidPlayers.indexOf(String(p.uuid)) < 0 || !p.isAlive() || String(p.level.getDimension()) !== v.dim) return
        var d = gsDist2(p, v.center.x, v.center.z)
        if (d < bestD) { bestD = d; best = p }
    })
    var nav = g.getNavigation()
    if (best) {
        if (nav.isDone() || now % 100 === 0) gsWalk(g, best.getX(), best.getY(), best.getZ(), 1.0)
    } else if (nav.isDone() && Math.random() < 0.3) {
        var a = Math.random() * 6.283185307179586, r = 5 + Math.random() * 25
        gsWalk(g, v.center.x + Math.cos(a) * r, v.center.y, v.center.z + Math.sin(a) * r, 0.8)
    }
}

// ─── Еженедельные караваны и налёты ──────────────────────────────────────────

/** Прибытие каравана случайной фракции к поселению pf (или налёт, если отношения враждебные). Текст ошибки или null. */
function gsCaravanEvent(pf, raidFaction, tierOverride) {
    if (!pf.base) return "у фракции " + pf.name + " не отмечен центр базы"
    var level = GS_SERVER.getLevel(pf.base.dim)
    var home = []
    GS_SERVER.players.forEach(p => {
        var b = global.TFG_SETTLEMENTS.baseFor(p)
        if (b && b.faction.id === pf.id) home.push(p)
    })
    if (!level || home.length === 0) return "никого из фракции " + pf.name + " нет на базе"
    var tier = tierOverride || Math.max.apply(null, home.map(p => global.TFG_PLAYER_TIER ? global.TFG_PLAYER_TIER(p) : 1))
    var npc = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits")
    var fac = raidFaction ? trFaction(raidFaction) : npc[Math.floor(Math.random() * npc.length)]
    if (!fac) return "нет фракции " + raidFaction
    var rep = facRep("pf_" + pf.id, fac.id)
    var center = { x: pf.base.x, y: pf.base.y, z: pf.base.z }
    if (raidFaction || rep < GS_HOSTILE_RELATION) {
        return gsVisit(level, center, fac.id, null, tier, { raid: true, players: pf.members.slice() })
    }
    var kinds = global.TFG_TRADE_GOODS.kindsFor(tier).map(k => k.id)
    // знать на базе продаёт хозяйское добро: те, кому оно нужно, прилетают в первую очередь (companions.js)
    var wanted = []
    try { wanted = (global.TFG_COMPANIONS.wantedKinds(pf) || []).filter(k => kinds.indexOf(k) >= 0) } catch (e) { }
    var roll = Math.random()
    var kind = wanted.length && roll < 0.7 ? wanted[Math.floor(Math.random() * wanted.length)]
        : rep >= 75 && roll < 0.1 ? "appraiser" : roll < 0.2 ? "buyer" : roll < 0.3 ? "junk"
        : kinds[Math.floor(Math.random() * kinds.length)]
    return gsVisit(level, center, fac.id, kind, tier, null)
}

/** Раз в неделю календаря TFC у каждого поселения - случайный день и час визита (или никого). */
function gsWeeklyTick() {
    var today = trToday()
    var week = Math.floor(today / 7)
    var pd = GS_SERVER.persistentData
    global.TFG_SETTLEMENTS.all().forEach(pf => {
        if (!pf.base) return
        var key = "tfg_caravan_plan_" + pf.id
        var plan = null
        try { plan = pd.contains(key) ? JSON.parse(String(pd.getString(key))) : null } catch (e) { }
        if (!plan || plan.week !== week) {
            plan = { week: week, day: Math.random() < GS_WEEKLY_CHANCE ? week * 7 + Math.floor(Math.random() * 7) : -1, at: Math.floor(Math.random() * 20000), done: false }
            pd.putString(key, JSON.stringify(plan))
            gsLog("неделя " + week + ", " + pf.name + ": " + (plan.day < 0 ? "никто не придёт" : "визит в день " + plan.day + " (" + plan.at + " тиков суток)"))
        }
        if (plan.done || plan.day !== today) return
        var level = GS_SERVER.getLevel(pf.base.dim)
        var t = level ? Number(level.getDayTime()) % 24000 : 0
        if (!isFinite(t) || t < plan.at) return
        var err = gsCaravanEvent(pf, null, null)
        if (err && err.indexOf("нет на базе") >= 0) return          // ждём до конца дня - может, кто-то вернётся
        plan.done = true
        pd.putString(key, JSON.stringify(plan))
        if (err) gsLog(pf.name + ": визит не состоялся - " + err)
    })
}

EntityEvents.death(event => {
    var e = event.entity
    try {
        if (!e.getTags().contains("tfg_guest") || typeof brDropItem !== "function") return
        var id = String(e.getMainHandItem().id)
        if (id === "minecraft:bow" || id === "minecraft:crossbow") brDropItem(e, "minecraft:arrow", 1 + Math.floor(Math.random() * 4), null)
    } catch (err) {
        gsErr("добыча стража", err)
    }
})

PlayerEvents.respawned(event => {
    // после смерти игрока боевое состояние стражей, целившихся в его прежнюю сущность, сбрасывается
    try {
        if (!GS_SERVER) return
        var visits = gsLoad()
        for (var id in visits) {
            var v = visits[id]
            v.guards.forEach(u => {
                var g = gsEntity(v, u)
                if (!g) return
                var st = null
                try { st = RAID_AI[raidGunKey(g)] } catch (err) { }
                var t = g.getTarget()
                if ((t && (t.isRemoved() || !t.isAlive())) || (st && st.target && st.target.isRemoved())) {
                    gsCalm(g)
                    g.getNavigation().stop()
                }
            })
        }
    } catch (err) {
        gsErr("возрождение игрока", err)
    }
})

// ─── Транспорт: свой только в дорогу, чужой - угоняем ────────────────────────
//
// Гости садятся в аппарат или повозку только когда уезжают (фазы board и depart) и только в свой - назначенный им при
// прибытии. В поселении Immersive Aircraft сам усаживает мобов, которые касаются аппарата, поэтому стражей ссаживаем
// и держим от своего транспорта подальше. Чужой транспорт союзников не трогают вовсе.
// Враждебный отряд (налёт) наоборот: увидел аппарат игроков - угоняет его и улетает.

const GS_KEEP_OFF = 4               // ближе к своему аппарату стража не подпускаем (в поселении)
const GS_STEAL_RANGE = 40           // с какого расстояния налётчики видят чужой аппарат
const GS_STEAL_RETRY = 200

function gsIsAircraft(e) {
    try { return String(e.type).indexOf("immersive_aircraft:") === 0 } catch (err) { return false }
}

function gsVehicleVisit(e) {
    try { return e.persistentData.contains("tfg_guest_visit") ? String(e.persistentData.getString("tfg_guest_visit")) : null } catch (err) { return null }
}

/** Можно ли гостю ехать в этой сущности сейчас: только свой транспорт и только в дорогу. */
function gsMayRide(v, e, vehicle) {
    if (!vehicle) return true
    var type = String(vehicle.type)
    if (type === "mcw_tfc_aio:chair") return true                 // стул - не транспорт
    var owner = gsVehicleVisit(vehicle)
    if (v.raid && rtStealVehicle(v) === String(vehicle.uuid)) return true   // угнанный - можно
    if (owner !== v.id) return false                              // чужой (в том числе союзный) - нельзя
    if (v.caravan) return true                                    // караван всегда в пути: ссаживать в воздухе нельзя
    if (v.phase !== "board" && v.phase !== "depart" && v.phase !== "travel") return false
    var k = Number(e.persistentData.getInt("tfg_guest_craft"))
    if (v.crafts.length && isFinite(k) && k >= 0 && v.crafts[k] && String(vehicle.uuid) !== v.crafts[k]) return false
    return true
}

/** Посторонние в транспорте каравана (игрок, житель, чужой моб) - ссадить, пока борт у земли. */
function gsCraftStrangers(v, level, own) {
    var mine = {}
    own.forEach(e => { if (e) mine[String(e.uuid)] = 1 })
    v.crafts.concat(v.carts).forEach(u => {
        var c = gsEntity(v, u)
        if (!c) return
        var list = []
        try { list = c.getPassengers().toArray() } catch (err) { return }
        list.forEach(p => {
            if (!p || mine[String(p.uuid)]) return
            try { if (c.getY() - gsSurface(level, c.getX(), c.getZ()) > 4) return } catch (err) { }
            try { p.stopRiding() } catch (err) { return }
            try { if (p.isPlayer && p.isPlayer()) p.tell(Text.of("§7Это транспорт каравана - посторонним нельзя.")) } catch (err) { }
        })
    })
}

/** Игрок не садится в чужой караванный транспорт: правый клик по нему не проходит. */
ItemEvents.entityInteracted(event => {
    try {
        var t = event.target
        var vid = t ? gsVehicleVisit(t) : null
        if (!vid || String(t.type) === "minecraft:husk" || !gsLoad()[vid]) return      // люди каравана - не транспорт
        event.cancel()
        if (String(event.hand) === "MAIN_HAND") event.player.tell(Text.of("§7Это транспорт каравана - посторонним нельзя."))
    } catch (err) { }
})

function rtStealVehicle(v) {
    var rt = GS_RT[v.id]
    return rt && rt.steal ? rt.steal.vehicle : null
}

/** Ссадить гостя с того, на чём ему сейчас ехать нельзя, и отвести в сторону. */
function gsRideCheck(v, level, e) {
    if (!e || !e.isPassenger()) return
    var vehicle = e.getVehicle()
    if (gsMayRide(v, e, vehicle)) return
    // высоко над землёй ссаживать нельзя: пассажиры разобьются, а пустой аппарат сорвётся в штопор
    try { if (vehicle.getY() - gsSurface(level, vehicle.getX(), vehicle.getZ()) > 4) return } catch (err) { }
    e.stopRiding()
    var a = Math.random() * 6.283185307179586
    var px = vehicle.getX() + Math.cos(a) * (GS_KEEP_OFF + 2), pz = vehicle.getZ() + Math.sin(a) * (GS_KEEP_OFF + 2)
    gsTp(level, e, px, gsSurface(level, px, pz), pz)
}

/** В поселении стража не толчётся у своего транспорта - иначе аппарат сам её усаживает. */
function gsKeepOffCraft(v, level, rt, g, now) {
    var near = null
    v.crafts.concat(v.carts).forEach(u => {
        var c = gsEntity(v, u)
        if (c && gsDist2(g, c.getX(), c.getZ()) < GS_KEEP_OFF * GS_KEEP_OFF) near = c
    })
    if (!near) return false
    rt.keepOff = rt.keepOff || {}
    var key = String(g.uuid)
    if ((rt.keepOff[key] || 0) > now) return true
    rt.keepOff[key] = now + 60
    var a = Math.atan2(g.getZ() - near.getZ(), g.getX() - near.getX())
    var px = near.getX() + Math.cos(a) * (GS_KEEP_OFF + 4), pz = near.getZ() + Math.sin(a) * (GS_KEEP_OFF + 4)
    var s = gsNearestStand(level, Math.floor(px), Math.floor(pz), 4)
    gsWalk(g, s.x, s.y, s.z, 1.0)
    return true
}

/** Налёт: угнать чужой аппарат (не гостевой). Возвращает true, если страж занят угоном. */
function gsStealTick(v, level, rt, guards, now) {
    if (!v.raid || v.fleeing) return false
    var steal = rt.steal
    if (steal) {
        var vehicle = gsEntity(v, steal.vehicle)
        var thief = gsEntity(v, steal.thief)
        if (!vehicle || !thief) {
            rt.steal = null
            return false
        }
        if (!thief.isPassenger()) {
            if (gsDist2(thief, vehicle.getX(), vehicle.getZ()) < 9) {
                if (!airMount(thief, vehicle)) gsTp(level, thief, vehicle.getX(), Math.floor(vehicle.getY()) + 1, vehicle.getZ())
            } else if (thief.getNavigation().isDone() || now % 100 === 0) {
                gsWalk(thief, vehicle.getX(), vehicle.getY(), vehicle.getZ(), 1.2)
            }
            return true
        }
        // на борту: взлетаем и уходим, потом аппарат пропадает вместе с угонщиком
        if (!steal.c) {
            steal.c = gsCraftRt(vehicle, "stolen")
            steal.c.goal = gsAway(v)
            try { airRefuel(vehicle) } catch (err) { }
            gsNotify(v, "§c[Налёт] §fНалётчики угоняют ваш аппарат!")
            gsLog(v.id + ": угон аппарата " + String(vehicle.type))
        }
        if (gsDist2(vehicle, v.center.x, v.center.z) > GS_VANISH_MIN * GS_VANISH_MIN && !gsSeen(level, vehicle)) {
            gsVanish(vehicle)
            rt.steal = null
        }
        return true
    }
    if ((rt.stealTry || 0) > now || !guards.length) return false
    rt.stealTry = now + GS_STEAL_RETRY
    var found = null, thiefFound = null
    guards.forEach(g => {
        if (found || g.isPassenger()) return
        var list = level.getEntities(g, new RAID_AABBClass(g.getX() - GS_STEAL_RANGE, g.getY() - 16, g.getZ() - GS_STEAL_RANGE,
            g.getX() + GS_STEAL_RANGE, g.getY() + 16, g.getZ() + GS_STEAL_RANGE))
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!gsIsAircraft(e) || gsVehicleVisit(e)) continue          // чужой гостевой транспорт не трогаем
            if (airPassengers(e).length > 0) continue
            found = e
            thiefFound = g
            break
        }
    })
    if (!found) return false
    rt.steal = { vehicle: String(found.uuid), thief: String(thiefFound.uuid), c: null }
    GS_ENT[String(found.uuid)] = found
    return true
}

// ─── Тик визита ──────────────────────────────────────────────────────────────

function gsCrafts(v, level) {
    var rt = gsRt(v.id)
    if (rt.crafts) return rt.crafts
    rt.crafts = []
    v.crafts.forEach((u, i) => {
        var e = gsEntity(v, u)
        if (!e) return
        var c = gsCraftRt(e, v.transport)
        var spot = (v.spots && v.spots[i]) || v.arrive
        c.mode = (v.phase === "stay" || v.phase === "board") ? "idle" : "ai"
        c.landed = c.mode === "idle"
        c.unloaded = v.phase !== "travel"
        c.goal = v.phase === "depart" ? gsAway(v) : { x: spot.x, y: spot.y, z: spot.z, land: true }
        rt.crafts.push(c)
    })
    return rt.crafts
}

/** Куда уходят: далеко по направлению от центра (исчезают раньше - как только их не видно). */
function gsAway(v) {
    var ang = v.awayAng || 0
    return { x: v.center.x + Math.cos(ang) * GS_AWAY_DIST, y: v.arrive.y + 40, z: v.center.z + Math.sin(ang) * GS_AWAY_DIST, land: false }
}

/** Видит ли сущность хоть один игрок: рядом - всегда; дальше - в конусе взгляда и (до 128 блоков) без преград. */
function gsSeen(level, e) {
    var seen = false
    var dim = String(level.getDimension())
    GS_SERVER.players.forEach(p => {
        if (seen || String(p.level.getDimension()) !== dim) return
        var dx = e.getX() - p.getX(), dy = e.getY() + 1 - p.getEyeY(), dz = e.getZ() - p.getZ()
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < GS_ALWAYS_SEEN) { seen = true; return }
        if (d > GS_VIEW_DIST) return
        var yaw = p.getYaw() * 0.017453292519943295, pitch = p.getPitch() * 0.017453292519943295
        var look = (-Math.sin(yaw) * Math.cos(pitch) * dx - Math.sin(pitch) * dy + Math.cos(yaw) * Math.cos(pitch) * dz) / d
        if (look < GS_VIEW_COS) return
        if (d > 128 || p.hasLineOfSight(e)) seen = true
    })
    return seen
}

/** Исчезнуть вместе с пассажирами. */
function gsVanish(e) {
    try { airPassengers(e).forEach(p => p.discard()) } catch (err) { }
    e.discard()
}

function gsVisitTick(v, level, now) {
    var trader = gsEntity(v, v.trader)
    var guards = v.guards.map(u => gsEntity(v, u)).filter(e => e)
    var anyone = trader || guards[0]
    var rt = gsRt(v.id)
    var crafts = v.crafts.length ? gsCrafts(v, level).filter(c => c.vehicle.isAlive()) : []
    if (v.caravan && !v.spawned) return gsCaravanTick(v, level, now, null, [], rt, [], {})     // едет виртуально
    if (!anyone) {
        if (v.caravan) return
        if (v.phase === "depart" || v.raid || now > v.until + 24000) gsEndVisit(v, v.phase === "depart" ? "ушли из виду" : "никого нет - визит просрочен")
        return
    }
    gsGuardProperty(v, level, rt)
    ;[trader].concat(guards).forEach(e => { gsHuskVoice(e); gsRideCheck(v, level, e) })
    gsCraftStrangers(v, level, [trader].concat(guards))          // и после /reload, когда список звуков рейдеров обнулился
    if (v.hostile && now >= v.hostile.until) {
        v.hostile = null
        guards.forEach(gsCalm)
        gsSave()
    }
    var leader = trader || guards[0]
    var fname = gsFactionName(v.faction)

    // большие потери - бегство: бросают занятия и бой, садятся в транспорт или уходят
    if (!v.fleeing && (v.phase === "travel" || v.phase === "stay") && (v.startGuards || 0) >= 2 &&
        guards.length <= Math.floor(v.startGuards * GS_FLEE_SHARE)) {
        v.fleeing = true
        v.hostile = null
        v.awayAng = Math.atan2(leader.getZ() - v.center.z, leader.getX() - v.center.x) + (Math.random() - 0.5)
        guards.forEach(g => { gsCalm(g); gsFinishAct(g, rt.acts[String(g.uuid)]); delete rt.acts[String(g.uuid)]; gsMono(v, rt, g, "flee", now, 0.5) })
        gsNotify(v, v.raid ? "§c[Налёт] §fОтряд фракции " + fname + " потерял людей и отступает!" : "§6[Караван] §fКараван фракции " + fname + " потерял охрану и бежит.")
        gsSetPhase(v, "board", now)
    }
    if (v.raid && !v.fleeing && now < v.until && (!v.hostile || now >= v.hostile.until)) v.hostile = { players: v.raidPlayers, until: v.until }

    // бой - поверх любой фазы: враждебные игроки, разбойники, враждебные фракции и монстры на виду
    var fighting = {}
    var enemies = []
    if (!v.fleeing && guards.length) {
        enemies = gsEnemiesNear(v, level, guards)
        guards.forEach(g => {
            if (g.isPassenger() && v.phase !== "stay") return
            var t = gsPickTarget(v, g, enemies)
            if (!t) return
            gsFinishAct(g, rt.acts[String(g.uuid)])
            delete rt.acts[String(g.uuid)]
            if (typeof raidCombatTick === "function" && raidCombatTick(g, t)) fighting[String(g.uuid)] = true
        })
    }

    // опасность (вражда, враги на виду, бегство) - все бегут, а не идут; спокойно - болтают
    var danger = !!(v.fleeing || v.hostile || enemies.length)
    ;[trader].concat(guards).forEach(e => {
        if (!e) return
        if (fighting[String(e.uuid)]) { delete GS_MOVE[String(e.uuid)]; return }      // в бою ходит боевой ИИ - не мешать обходом
        gsStuckCheck(e, now)
        var ea = rt.acts[String(e.uuid)]
        var hurry = danger || (ea && ea.id === "shelter" && ea.stage === "go")
        try { e.setSprinting(hurry && !e.getNavigation().isDone()) } catch (err) { }
    })
    if (!danger && guards.length > 1) {
        try { gsChatTick(v, level, rt, guards, fighting, now) } catch (err) { gsErr("болтовня", err) }
    } else if (rt.chats && rt.chats.length) {
        rt.chats.slice().forEach(c => gsEndChatOf(v, rt, c.a))
    }
    try { gsMonoTick(v, level, rt, trader, guards, fighting, now) } catch (err) { gsErr("монологи", err) }
    if (!danger && typeof gsSocialTick === "function") {
        try { gsSocialTick(v, level, rt, trader, guards, now) } catch (err) { gsErr("общение", err) }
    }
    // караван в дороге: только идти, болтать и драться - занятий, костров и мебели у него нет
    if (v.caravan) return gsCaravanTick(v, level, now, trader, guards, rt, crafts, fighting)
    // наёмники: патруль вокруг базы вместо обычного визита (factions/services.js)
    if (v.merc) return svcMercTick(v, level, now, guards, rt, fighting, enemies)

    if ((v.phase === "travel" || v.phase === "stay") && (now >= v.until || (!trader && !v.raid))) {
        v.awayAng = Math.atan2(leader.getZ() - v.center.z, leader.getX() - v.center.x) + (Math.random() - 0.5)
        guards.forEach(g => { gsCalm(g); gsFinishAct(g, rt.acts[String(g.uuid)]); delete rt.acts[String(g.uuid)] })
        v.hostile = null
        gsNotify(v, v.raid ? "§c[Налёт] §fОтряд фракции " + fname + " уходит." : "§6[Караван] §fКараван фракции " + fname + " собирается в путь.")
        gsSetPhase(v, "board", now)
    }

    if (v.phase === "travel") {
        var arrived = false
        if (crafts.length) {
            // каждый аппарат высаживает своих сам, как только сел
            crafts.forEach(c => { if (c.landed && !c.unloaded) gsUnload(v, level, c) })
            arrived = crafts.every(c => c.landed)
        } else {
            var walker = v.carts.length ? (guards[1] || guards[0] || trader) : leader
            if (walker.isPassenger()) walker = guards[0] || trader
            arrived = gsDist2(walker, v.arrive.x, v.arrive.z) < 36
            if (!arrived && walker.getNavigation().isDone()) gsWalk(walker, v.arrive.x, v.arrive.y, v.arrive.z, 0.75)
            gsFollow(v, level, walker, guards, trader, fighting)
        }
        if (!arrived && now - v.since > GS_TRAVEL_TIMEOUT) {
            gsLog(v.id + ": долго в пути - переношу к точке прибытия")
            crafts.forEach(c => {
                if (c.landed) return
                c.mode = "idle"
                c.landed = true
                gsTp(level, c.vehicle, c.goal.x, c.goal.y, c.goal.z)
                gsUnload(v, level, c)
            })
            ;[trader].concat(guards).forEach((e, i) => { if (e && !e.isPassenger()) gsTp(level, e, v.arrive.x + (i % 3) - 1, v.arrive.y, v.arrive.z + ((i / 3) | 0) - 1) })
            v.horses.forEach(u => { var h = gsEntity(v, u); if (h) gsTp(level, h, v.arrive.x + 3, v.arrive.y, v.arrive.z + 3) })
            arrived = true
        }
        if (arrived) {
            if (trader && trader.isPassenger()) trader.stopRiding()
            gsNotify(v, v.raid ? "§c[Налёт] §fОтряд фракции " + fname + " у центра поселения!" : "§6[Караван] §fКараван фракции " + fname + " прибыл к центру поселения.")
            gsSetPhase(v, "stay", now)
        }
        return
    }

    if (v.phase === "stay") {
        if (v.settlement && typeof frStayTick === "function") {
            try { if (frStayTick(v, level, now, trader, guards, rt, fighting)) return } catch (err) { gsErr("торг в поселении", err) }
        }
        // IA сам усаживает касающихся мобов - высаживаем; игрок на борту - угон, за это вражда (gsGuardProperty)
        crafts.forEach(c => airPassengers(c.vehicle).forEach(p => {
            if (p.isPlayer()) return
            p.stopRiding()
            var px = c.vehicle.getX() + 7, pz = c.vehicle.getZ()
            gsTp(level, p, px, gsSurface(level, px, pz), pz)
        }))
        if (v.raid) { try { gsStealTick(v, level, rt, guards, now) } catch (err) { gsErr("угон", err) } }
        guards.forEach(g => {
            var key = String(g.uuid)
            if (fighting[key]) return
            if (g.isPassenger() && String(g.getVehicle().type) !== "mcw_tfc_aio:chair") return
            if (v.raid) {
                if (rt.steal && rt.steal.thief === key) return
                return gsRaidHunt(v, level, g, now)
            }
            if (gsKeepOffCraft(v, level, rt, g, now)) return
            // свой караван дома: телохранитель стережёт ворота форта снаружи (fairs.js), в форт не идёт
            if ((v.homecoming || v.warband) && v.fair && (v.fair.stage === "торг" || v.fair.stage === "отдых") &&
                String(g.persistentData.getString("tfg_guest_role")) === "bodyguard") return
            if (String(g.persistentData.getString("tfg_guest_role")) !== "bodyguard") gsShelterCheck(v, level, g, rt, now)
            if (String(g.persistentData.getString("tfg_guest_role")) === "bodyguard" && !rt.acts[key]) {
                if (!trader) return
                if (gsDist2(g, trader.getX(), trader.getZ()) > 25) gsWalk(g, trader.getX() + 1.5, trader.getY(), trader.getZ() + 1.5, 0.9)
                else g.getLookControl().setLookAt(trader.getX(), trader.getEyeY(), trader.getZ())
                return
            }
            gsActTick(v, level, g, rt, now)
        })
        return
    }

    if (v.phase === "board") {
        var aboardAll = true
        var timeout = now - v.since > (v.fleeing ? 200 : GS_BOARD_TIMEOUT)
        ;[trader].concat(guards).forEach(e => {
            if (!e) return
            gsFree(e)
            var vehicle = null
            if (crafts.length) {
                var k = Number(e.persistentData.getInt("tfg_guest_craft"))
                if (k < 0) return
                vehicle = (crafts[k] || crafts[0]).vehicle
            } else if (e === trader && v.carts.length) {
                vehicle = gsEntity(v, v.carts[0])
            }
            if (!vehicle || e.isPassenger()) return
            aboardAll = false
            if (timeout || gsDist2(e, vehicle.getX(), vehicle.getZ()) < (v.transport === "warship" ? 64 : 25)) {
                if (!airMount(e, vehicle)) gsTp(level, e, vehicle.getX() + 1, Math.floor(vehicle.getY()), vehicle.getZ())
            } else if (e.getNavigation().isDone() || now % 100 === 0) {
                gsWalk(e, vehicle.getX(), vehicle.getY(), vehicle.getZ(), v.fleeing ? 1.3 : 0.9)
            }
        })
        if (aboardAll || timeout) {
            crafts.forEach(c => { c.mode = "ai"; c.landed = false; c.goal = gsAway(v); c.ticks = 0 })
            gsSetPhase(v, "depart", now)
        }
        return
    }

    if (v.phase === "depart") {
        // уходят и исчезают, как только их никто не видит; ближе GS_VANISH_MIN к центру - не исчезают, идут дальше
        var away = gsAway(v)
        var far = e => gsDist2(e, v.center.x, v.center.z) > GS_VANISH_MIN * GS_VANISH_MIN
        crafts.forEach(c => { if (far(c.vehicle) && !gsSeen(level, c.vehicle)) gsVanish(c.vehicle) })
        var walker2 = v.carts.length ? (guards[1] || guards[0] || trader) : leader
        if (walker2 && walker2.isPassenger()) walker2 = v.carts.length ? (guards[0] || null) : null
        if (walker2 && !crafts.length) {
            if (walker2.getNavigation().isDone() || now % 100 === 0) gsWalk(walker2, away.x, walker2.getY(), away.z, v.fleeing ? 1.2 : 0.8)
            gsFollow(v, level, walker2, guards, trader, fighting)
        }
        ;[trader].concat(guards).forEach(e => {
            if (!e || e.isPassenger() || fighting[String(e.uuid)]) return
            if ((crafts.length || v.fleeing) && e.getNavigation().isDone()) gsWalk(e, away.x, e.getY(), away.z, v.fleeing ? 1.3 : 0.9)   // без места в аппарате - пешком
            if (v.carts.length && e === walker2) return        // возница исчезает вместе с повозками
            if (far(e) && !gsSeen(level, e)) e.discard()
        })
        if (v.carts.length && walker2 && far(walker2) && !gsSeen(level, walker2)) {
            var wagon = v.horses.concat(v.carts).map(u => gsEntity(v, u)).filter(x => x)
            if (wagon.every(x => !gsSeen(level, x))) {
                wagon.forEach(gsVanish)
                walker2.discard()
            }
        }
        var left = [v.trader].concat(v.guards, v.crafts, v.horses).some(u => gsEntity(v, u))
        if (!left) gsEndVisit(v, "ушли из виду")
        else if (now - v.since > GS_DEPART_TIMEOUT && !gsSeen(level, anyone)) gsEndVisit(v, "ушли из виду (долго уходили)")
    }
}

/** Отряд идёт строем за ведущим; лошади - за своими возницами. */
function gsFollow(v, level, walker, guards, trader, fighting) {
    var n = guards.length + 1
    ;[trader].concat(guards).forEach((e, i) => {
        if (!e || e === walker || e.isPassenger() || fighting[String(e.uuid)]) return
        var a = i * 6.283185307179586 / n
        var tx = walker.getX() + Math.cos(a) * 3, tz = walker.getZ() + Math.sin(a) * 3
        if (gsDist2(e, tx, tz) > 9 && (e.getNavigation().isDone() || gsDist2(e, tx, tz) > 100)) gsWalk(e, tx, walker.getY(), tz, 1.0)
    })
    var rtH = gsRt(v.id)
    v.horses.forEach(u => {
        var h = gsEntity(v, u)
        if (!h || (rtH.horseWait && rtH.horseWait[u])) return
        var d = gsEntity(v, String(h.persistentData.getString("tfg_guest_driver"))) || walker
        if (gsDist2(h, d.getX(), d.getZ()) > 16) gsWalk(h, d.getX(), d.getY(), d.getZ(), 0.8)
    })
}

ServerEvents.tick(event => {
    if (!GS_SERVER) GS_SERVER = event.server
    var tick = Number(event.server.tickCount)
    if (tick % 200 === 0) {
        try { gsWeeklyTick() } catch (err) { gsErr("еженедельные визиты", err) }
    }
    var visits = gsLoad()
    for (var id in visits) {
        var v = visits[id]
        try {
            var level = gsLevel(v)
            if (!level) continue
            var rt = GS_RT[id]
            // полёт: ввод - каждый тик, расчёт - раз в 2
            var flying = v.crafts.length && (v.caravan || v.phase === "travel" || v.phase === "depart") ? gsCrafts(v, level) : []
            if (rt && rt.steal && rt.steal.c) flying = flying.concat([rt.steal.c])
            if (flying.length) {
                flying.forEach(c => {
                    if (!c.vehicle.isAlive() || c.mode === "idle") {
                        if (c.vehicle.isAlive() && tick % 20 === 0) airEngine(c)
                        return
                    }
                    if (tick % 2 === 0) {
                        c.ticks += 2
                        if (airPassengers(c.vehicle).length === 0) return
                        gsFly(c)
                        airEngine(c)
                        airKickEngine(c)
                    }
                    airPush(c)
                })
            } else if (rt && rt.crafts && tick % 20 === 0) {
                rt.crafts.forEach(c => { if (c.vehicle.isAlive()) { airApply(c, 0, 0, 0); airEngine(c) } })
            }
            if (v.phase === "stay") gsScanStep(v, level)
            if (v.carts.length) gsCartTick(v, gsRt(id), tick)
            if (tick % 20 === 0) gsVisitTick(v, level, gsNow(level))
        } catch (err) {
            var rtE = gsRt(id)
            if (rtE.lastErr !== String(err)) {
                rtE.lastErr = String(err)
                gsErr("визит " + id, err)
            }
        }
    }
})

global.TFG_GUESTS = {
    visit: (level, center, factionId, kindId, tier, opts) => gsVisit(level, center, factionId, kindId, tier || 1, opts || null),
    /** true - торговцем сейчас управляет визит (в пути, посадка, отъезд), а не factions/trader.js. */
    controls: e => {
        if (!GS_SERVER) return false
        var v = gsLoad()[String(e.persistentData.getString("tfg_guest_visit"))]
        return !!v && (v.phase !== "stay" || !!(v.fair && v.fair.stage !== "свободно"))
    },
}

/** /tfgguests event | raid <фракция> [тир]: визит к поселению вашей фракции прямо сейчас. */
function gsCmdEvent(ctx, raidFaction, tier) {
    if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
    var player = ctx.source.getPlayerOrException()
    var pf = global.TFG_SETTLEMENTS.factionOf(player)
    if (!pf) { ctx.source.sendFailure(Text.of("Вы не в фракции игроков (/faction).")); return 1 }
    var err = gsCaravanEvent(pf, raidFaction, tier)
    if (err) ctx.source.sendFailure(Text.of("Не вышло: " + err))
    else ctx.source.sendSuccess(Text.of(raidFaction ? "Налёт вызван." : "Визит вызван."), false)
    return 1
}

/** Ближайший к игроку визит. */
function gsNearestVisit(player) {
    var best = null, bestD = 1e18
    var visits = gsLoad()
    Object.keys(visits).forEach(k => {
        var v = visits[k]
        if (v.dim !== String(player.level.getDimension())) return
        var d = gsDist2(player, v.center.x, v.center.z)
        if (d < bestD) { bestD = d; best = v }
    })
    return best
}

/** /tfgguests do <занятие>: случайный страж ближайшего визита бросает всё и идёт заниматься этим. */
function gsForceAct(ctx, id) {
    if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
    var player = ctx.source.getPlayerOrException()
    var v = gsNearestVisit(player)
    if (!v) { ctx.source.sendFailure(Text.of("Гостей нет.")); return 1 }
    if (v.phase !== "stay") { ctx.source.sendFailure(Text.of("Гости сейчас не в поселении (фаза " + v.phase + ").")); return 1 }
    var level = gsLevel(v)
    var rt = gsRt(v.id)
    var list = v.guards.map(u => gsEntity(v, u)).filter(e => e)
    if (!list.length) { ctx.source.sendFailure(Text.of("Охраны не осталось.")); return 1 }
    var g = list[Math.floor(Math.random() * list.length)]
    var now = gsNow(level)
    var made = gsMakeAct(v, level, g, rt, now, id)
    if (!made.act) { ctx.source.sendFailure(Text.of("Не выйдет: " + made.why)); return 1 }
    gsFinishAct(g, rt.acts[String(g.uuid)])
    rt.acts[String(g.uuid)] = made.act
    var p = made.act.poi
    ctx.source.sendSuccess(Text.of("Страж у " + Math.floor(g.getX()) + " " + Math.floor(g.getY()) + " " + Math.floor(g.getZ()) + " идёт: " + id +
        (p ? " -> " + Math.floor(p.x) + " " + Math.floor(p.y) + " " + Math.floor(p.z) : "")), false)
    return 1
}

ServerEvents.commandRegistry(event => {
  try {
      var Commands = event.commands
      var cmd = Commands.literal("tfgguests").requires(src => src.hasPermission(2))
          .then(Commands.literal("list").executes(ctx => {
              if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
              var visits = gsLoad()
              var lines = Object.keys(visits).map(k => {
                  var v = visits[k]
                  return k + ": " + v.faction + ", " + v.transport + ", фаза " + v.phase + ", охрана " + v.guards.length +
                      (v.hostile ? ", ВРАЖДА" : "") + ", центр " + v.center.x + " " + v.center.z
              })
              ctx.source.sendSuccess(Text.of(lines.length ? lines.join("\n") : "Гостей нет."), false)
              return 1
          }))
          .then(Commands.literal("clear").executes(ctx => {
              if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
              var visits = gsLoad()
              var n = 0
              Object.keys(visits).forEach(k => { gsEndVisit(visits[k], "команда /tfgguests clear"); n++ })
              // и всё, что осталось от гостей в загруженных чанках (записи визита могло уже не быть)
              var extra = 0
              GS_SERVER.getAllLevels().forEach(lvl => {
                  var list = []
                  lvl.getAllEntities().forEach(e => {
                      if (e.persistentData.contains("tfg_guest_visit") || e.getTags().contains("tfg_guest") || e.getTags().contains("tfg_guest_horse")) list.push(e)
                  })
                  list.forEach(e => { try { e.ejectPassengers() } catch (err) { } e.discard(); extra++ })
              })
              ctx.source.sendSuccess(Text.of("Убрано визитов: " + n + ", сущностей гостей: " + extra), false)
              return 1
          }))
          // /tfgguests leave - ближайшие гости сразу собираются уезжать
          .then(Commands.literal("leave").executes(ctx => {
              if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
              var v = gsNearestVisit(ctx.source.getPlayerOrException())
              if (!v) { ctx.source.sendFailure(Text.of("Гостей нет.")); return 1 }
              v.until = gsNow(gsLevel(v))
              gsSave()
              ctx.source.sendSuccess(Text.of("Гости " + v.id + " собираются уезжать."), false)
              return 1
          }))
          // /tfgguests places - что найдено для занятий
          .then(Commands.literal("places").executes(ctx => {
              if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
              var v = gsNearestVisit(ctx.source.getPlayerOrException())
              if (!v) { ctx.source.sendFailure(Text.of("Гостей нет.")); return 1 }
              var rt = gsRt(v.id)
              var sc = rt.scan
              ctx.source.sendSuccess(Text.of("Сидений: " + rt.pois.chairs.length + ", костров/печей/очагов: " + rt.pois.fires.length + ", мест у воды: " + rt.pois.waters.length +
                  (sc ? ", просмотрено чанков " + sc.idx + " из " + sc.list.length : ", поиск начнётся, когда гости будут на месте")), false)
              return 1
          }))
      // /tfgguests raid <фракция> [тир] - налёт на ваше поселение; event - караван или налёт сейчас (как по расписанию)
      var raidNode = Commands.literal("raid")
      global.TFG_FACTIONS.list.forEach(f => {
          var fn = Commands.literal(f.id).executes(ctx => gsCmdEvent(ctx, f.id, null))
          ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(tier => fn.then(Commands.literal(String(tier)).executes(ctx => gsCmdEvent(ctx, f.id, tier))))
          raidNode.then(fn)
      })
      cmd.then(raidNode)
      cmd.then(Commands.literal("event").executes(ctx => gsCmdEvent(ctx, null, null)))
      cmd.then(Commands.literal("plan").executes(ctx => {
          if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
          var lines = global.TFG_SETTLEMENTS.all().map(pf => {
              var raw = GS_SERVER.persistentData.getString("tfg_caravan_plan_" + pf.id)
              var plan = null
              try { plan = raw ? JSON.parse(String(raw)) : null } catch (e) { }
              return pf.name + ": " + (!plan ? "плана ещё нет" : plan.day < 0 ? "на этой неделе никто не придёт" :
                  "день " + plan.day + " (сегодня " + trToday() + "), с " + plan.at + " тика суток" + (plan.done ? ", уже был" : ""))
          })
          ctx.source.sendSuccess(Text.of(lines.length ? lines.join("\n") : "Поселений нет."), false)
          return 1
      }))
      cmd.then(Commands.literal("who").executes(ctx => {
          if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
          var v = gsNearestVisit(ctx.source.getPlayerOrException())
          if (!v) { ctx.source.sendFailure(Text.of("Гостей нет.")); return 1 }
          var rt = gsRt(v.id)
          var lines = v.guards.map((u, i) => {
              var g = gsEntity(v, u)
              if (!g) return (i + 1) + ": нет (погиб или выгружен)"
              var act = rt.acts[u]
              var t = g.getTarget()
              return (i + 1) + ": " + Math.floor(g.getX()) + " " + Math.floor(g.getY()) + " " + Math.floor(g.getZ()) + ", здоровье " + Math.round(g.getHealth()) +
                  ", занятие " + (act ? act.id : "-") + ", цель " + (t ? String(t.type) + (t.isAlive() ? "" : " (мертва)") : "-") + (g.isPassenger() ? ", сидит" : "")
          })
          ctx.source.sendSuccess(Text.of(v.id + " (" + v.phase + (v.fleeing ? ", бегство" : "") + (v.hostile ? ", вражда" : "") + "):\n" + lines.join("\n")), false)
          return 1
      }))
      // /tfgguests voice - проверка озвучки: сколько озвученных реплик знает сервер и звук "Ох..." у игрока
      // Проверка озвучки: сыграть игроку заведомо записанную реплику голосом m1 и показать, что ответил сервер.
      // "-> 1" - звук ушёл игроку (не слышно - дело в клиенте), "-> 0" - playsound не сработал.
      cmd.then(Commands.literal("voice").executes(ctx => {
          if (!GS_SERVER) GS_SERVER = ctx.source.getServer()
          var player = ctx.source.getPlayerOrException()
          var index = null
          try { index = global.TFG_VOICE_KEYS } catch (e) { }
          var n = 0
          if (index) for (var k in index) n++
          var line = "Слышал? местные опять рейд отбивали."
          var key = gsVoiceKeyOf(line) || ("хэш " + gsVoiceKey(line))
          var cmdText = "execute as " + String(player.uuid) + " at @s run playsound tfg_voice:m1_" + key + " voice @s ~ ~ ~ 1 1"
          var res = GS_SERVER.runCommandSilent(cmdText)
          gsVoiceMissSave()
          var miss = Object.keys(GS_VOICE_MISS)
          ctx.source.sendSuccess(Text.of(
              "§fИндекс озвучки: " + (index ? n + " реплик" : "§cНЕ ЗАГРУЖЕН (нет voice_index.js)") +
              "\n§fКлюч тестовой реплики: " + key + " (должен быть 578d3f4f), в таблице: " + (gsVoiceKeyOf(line) ? "да" : "§cнет") +
              " §7(хэш сервера " + gsVoiceKey(line) + ")" +
              "\n§fТест: playsound -> " + res + (Number(res) > 0 ? " §a(звук ушёл тебе)" : " §c(не сработал)") +
              "\n§fС перезапуска: сыграно " + GS_VOICE_DIAG.played + ", без записи " + GS_VOICE_DIAG.missed +
              (GS_VOICE_DIAG.error ? " §c(была ошибка - см. лог)" : "") +
              "\n§7Последняя: " + (GS_VOICE_DIAG.last || "-") +
              "\n§fНеозвученных реплик собрано: " + miss.length + " (kubejs/voice_missing.json)" +
              (miss.length ? "\n§7  " + miss.slice(-5).join("\n§7  ") : "")), false)
          return 1
      }))
      var doNode = Commands.literal("do")
      ;["sit", "warm", "fish", "eat", "wander", "talk"].forEach(id => doNode.then(Commands.literal(id).executes(ctx => gsForceAct(ctx, id))))
      event.register(cmd.then(doNode))
  } catch (err) {
    console.error("[guests] ошибка регистрации команд: " + err)
  }
})
