"use strict";
/**
 * СТОЯНКИ КАРАВАНОВ: временный лагерь, который потом бесследно убирается.
 *
 * Лагерь собирается из микроструктур (очаг с сиденьями, палатки с лежанками, поленница, бочки,
 * загон, площадка под аппараты). Каждая микроструктура САМА ищет себе ровное пятно нужного размера
 * и подстраивается под рельеф: под низкие клетки подсыпается тот же грунт, что лежит рядом, срезаются
 * только кусты, трава и одиночные бугры. Землю под лагерем не выкапываем - иначе у TFC поедет опора
 * и постройки осыплются предметами.
 *
 * Перед стройкой снимается слепок коробки (factions/zones.js), по сроку зона откатывается целиком.
 * API: global.TFG_CAMPS - build, remove, at, list, populate.
 * Команды: /tfgcamp [фракция] [минуты] - поставить лагерь с людьми рядом, /tfgcamp remove | removeall | list.
 */

var CP_SERVER = null
var CP_BLOCK_CACHE = {}             // роль -> состояние, которое сервер принял

const CP_RADIUS = 9                 // в каком радиусе от центра расставляем микроструктуры
const CP_MARGIN = 6                 // запас коробки слепка
const CP_UP = 10
const CP_DOWN = 5
const CP_STEP_MAX = 2               // насколько клетка пятна может быть выше выбранного уровня
const CP_FILL_MAX = 3               // и насколько глубоко разрешено подсыпать
const CP_CUT_MAX = 3                // насколько глубоко разрешено срезать при сглаживании
const CP_SMOOTH_PASSES = 4          // проходов усреднения: чем больше, тем мягче переход к рельефу
const CP_FLAT_R = 5                 // ядро лагеря ровняем начисто: очаг и сиденья должны стоять вровень
const CP_FIRE_FUEL = 16000          // на сколько тиков очагу хватает дров
const CP_MOW = 3                    // радиус покоса вокруг очага
// что занимается от огня и может спалить лагерь
const CP_FLAMMABLE = ["plant/", "grass", "leaves", "thatch", "log/", "wood/", "groundcover/", "vine",
    "sapling", "fallen_leaves", "planks", "bamboo", "hay"]
const CP_BASE_KEEP = 100            // ближе этого к границе базы игроков лагерей не ставим
const CP_TTL = 24000
const CP_TTL_MARGIN = 3000

const CP_COLOR = { wind: "blue", ash: "yellow", marvins: "red", alliance: "white", bandits: "black" }
// породы дерева TFC, которые ищем вокруг; на них же берём мебель Macaw
const CP_WOODS = ["oak", "ash", "aspen", "birch", "chestnut", "douglas_fir", "hickory", "kapok", "maple",
    "pine", "rosewood", "sequoia", "spruce", "sycamore", "white_cedar", "willow", "acacia", "blackwood", "palm", "mangrove"]

// Растительность, которую можно снести без раздумий. ВНИМАНИЕ: дёрн TFC (tfc:grass/loam и прочие)
// к ней НЕ относится - это поверхность земли, и если считать её травой, весь лагерь уходит на блок вниз.
const CP_SOFT = ["plant/", "flower", "snow", "vine", "moss_carpet", "sapling", "leaves", "groundcover/",
    "minecraft:grass", "minecraft:tall_grass", "short_grass", "dead_bush", "wood/twig", "sea_pickle"]
const CP_SOLID_GRASS = ["tfc:grass/", "tfc:clay_grass/", "tfc:peat_grass", "minecraft:grass_block", "tfc:mud/"]
// Дерево - не земля: в джунглях карта высот показывает крону, и лагерь оказывался на ветках.
const CP_TREE = ["wood/log/", "wood/wood/", "wood/leaves/", "wood/stripped", "wood/branch", "minecraft:_log",
    "minecraft:_wood", "_leaves", "mangrove_roots", "bamboo", "cocoa", "vine"]
const CP_TREE_LIMIT = 0.05          // доля колонок со стволами, выше которой место считается чащей
const CP_GROUND_SCAN = 48           // на сколько блоков вниз ищем землю под кроной

function cpLog(text) { try { console.log("[стоянка] " + text) } catch (e) { } }
function cpErr(where, e) { try { console.error("[стоянка] " + where + ": " + e) } catch (err) { } }
function cpPick(list) { return list[Math.floor(Math.random() * list.length)] }

function cpId(level, x, y, z) {
    try { return String(level.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)).id) } catch (e) { return "minecraft:air" }
}

function cpIsAir(level, x, y, z) {
    var id = cpId(level, x, y, z)
    return id === "minecraft:air" || id === "minecraft:cave_air"
}

function cpIsSoft(level, x, y, z) {
    var id = cpId(level, x, y, z)
    if (id === "minecraft:air") return true
    for (var g = 0; g < CP_SOLID_GRASS.length; g++) if (id.indexOf(CP_SOLID_GRASS[g]) === 0) return false
    for (var i = 0; i < CP_SOFT.length; i++) if (id.indexOf(CP_SOFT[i]) >= 0) return true
    return false
}

/** Дерево ли это: ствол, ветка, листва, лиана. */
function cpIsTree(level, x, y, z) {
    var id = cpId(level, x, y, z)
    for (var i = 0; i < CP_TREE.length; i++) if (id.indexOf(CP_TREE[i]) >= 0) return true
    return false
}

/**
 * Верхний блок НАСТОЯЩЕЙ земли в столбце. Карта высот в лесу показывает крону,
 * поэтому спускаемся сквозь листву, стволы и кусты, пока не упрёмся в грунт.
 */
function cpTop(level, x, z) {
    var y = 320
    try { y = Number(level.getHeight("WORLD_SURFACE_WG", Math.floor(x), Math.floor(z))) } catch (e) { y = 70 }
    for (var i = 0; i < CP_GROUND_SCAN; i++) {
        var yy = y - 1 - i
        if (!cpIsSoft(level, x, yy, z) && !cpIsTree(level, x, yy, z)) return yy
    }
    return y - 1
}

/** Сколько над землёй дерева: по этому числу отличаем поляну от чащи. */
function cpTreeAbove(level, x, z, top) {
    for (var h = 1; h <= 12; h++) if (cpIsTree(level, x, top + h, z)) return true
    return false
}

/** Состояние блока для подсыпки: берём то, что лежит прямо под поверхностью этой же колонки. */
function cpGroundState(level, x, z) {
    var top = cpTop(level, x, z)
    var below = cpId(level, x, top - 1, z)
    if (below && below.indexOf("grass") < 0 && below !== "minecraft:air") return below
    var id = cpId(level, x, top, z)
    return id.indexOf("grass/") === 0 || id.indexOf("tfc:grass") === 0 ? id.replace("grass", "dirt") : (id || "tfc:dirt/loam")
}

// ─── Палитра: только блоки сборки, без ванильных подмен ──────────────────────

var CP_WOOD = "oak"                 // порода, выбранная по окрестностям

function cpPalette(role) {
    var w = CP_WOOD
    switch (role) {
        case "fire": return ["tfc:firepit[lit=true,axis=x]", "tfc:firepit[lit=true,axis=z]"]
        case "logs": return ["tfc:log_pile[axis=x]", "tfc:wood/log/" + w + "[axis=y,natural=false]"]
        case "stool": return ["mcw_tfc_aio:furniture/" + w + "_furniture/" + w + "_stool_chair",
            "mcw_tfc_aio:furniture/oak_furniture/oak_stool_chair"]
        case "chair": return ["mcw_tfc_aio:furniture/" + w + "_furniture/" + w + "_chair",
            "mcw_tfc_aio:furniture/oak_furniture/oak_chair"]
        case "table": return ["mcw_tfc_aio:furniture/" + w + "_furniture/" + w + "_coffee_table",
            "mcw_tfc_aio:furniture/oak_furniture/oak_coffee_table"]
        case "post": return ["tfc:wood/planks/" + w + "_log_fence", "tfc:wood/planks/oak_log_fence"]
        case "fence": return ["tfc:wood/planks/" + w + "_fence", "tfc:wood/planks/oak_fence"]
        case "gate": return ["tfc:wood/planks/" + w + "_fence_gate", "tfc:wood/planks/oak_fence_gate"]
        case "thatch": return ["tfc:thatch"]
        case "barrel": return ["tfc:wood/barrel/" + w + "[facing=up,rack=false,sealed=true]", "tfc:wood/barrel/oak[facing=up,rack=false,sealed=true]"]
        case "torch": return ["tfc:torch"]
        case "lantern": return ["tfc:torch"]      // лампа TFC без масла не горит, так что свет даём факелами
        case "bedHead": return ["tfc:thatch_bed[part=head,facing=north]"]
        case "bedFoot": return ["tfc:thatch_bed[part=foot,facing=north]"]
        case "chest": return ["tfc:wood/chest/" + w + "[facing=north,type=single]", "tfc:wood/chest/oak[facing=north,type=single]"]
        case "pot": return ["tfc:ceramic/large_vessel", "tfc:ceramic/large_vessel/brown"]
        case "crate": return ["gtceu:bronze_crate", "tfc:wood/chest/" + w + "[facing=north,type=single]"]
        case "workbench": return ["tfc:wood/planks/" + w + "_workbench", "tfc:quern"]
        case "loom": return ["tfc:wood/planks/" + w + "_loom", "tfc:quern"]
    }
    return []
}

/** Поставить блок первым принятым вариантом; сервер отвечает нулём, если такого блока нет. */
function cpSet(z, role, x, y, zz, props) {
    var cached = CP_BLOCK_CACHE[role]
    var list = cpPalette(role).filter(v => v !== cached)
    if (cached) list = [cached].concat(list)
    for (var i = 0; i < list.length; i++) {
        var state = list[i]
        if (props) state = state.indexOf("[") < 0 ? state + "[" + props + "]" : state.replace("]", "," + props + "]")
        if (global.TFG_ZONES.set(z, x, y, zz, state)) {
            CP_BLOCK_CACHE[role] = list[i]
            return true
        }
    }
    cpLog("не встал блок роли " + role + " (" + list.join(", ") + ")")
    return false
}

function cpSetState(z, x, y, zz, state) { return global.TFG_ZONES.set(z, x, y, zz, state) }

/**
 * Выкосить всё горючее вокруг очага. Иначе трава занимается от огня и лагерь выгорает -
 * вместе с палатками, товаром и людьми.
 */
function cpMowAround(z, level, fx, fy, fz) {
    var mowed = 0
    for (var dx = -CP_MOW; dx <= CP_MOW; dx++) {
        for (var dz = -CP_MOW; dz <= CP_MOW; dz++) {
            for (var dy = 0; dy <= 2; dy++) {
                var x = fx + dx, y = fy + dy, zz = fz + dz
                if (dx === 0 && dz === 0 && dy === 0) continue
                var id = cpId(level, x, y, zz)
                if (id === "minecraft:air") continue
                var burns = false
                for (var i = 0; i < CP_FLAMMABLE.length; i++) if (id.indexOf(CP_FLAMMABLE[i]) >= 0) { burns = true; break }
                if (!burns) continue
                if (global.TFG_ZONES.set(z, x, y, zz, "minecraft:air")) mowed++
            }
        }
    }
    if (mowed) cpLog("у костра выкошено горючего: " + mowed)
}

/** Заправить очаг дровами и разжечь: без топлива он гаснет и не греет. */
function cpFuelFire(z, x, y, zz) {
    var logs = "tfc:wood/log/" + CP_WOOD
    var items = []
    for (var slot = 0; slot < 4; slot++) items.push('{Slot:' + slot + 'b,id:"' + logs + '",Count:1b}')
    var nbt = "{burnTicks:" + CP_FIRE_FUEL + ",burnTemperature:520.0f,airTicks:0,inventory:{Items:[" + items.join(",") + "]}}"
    try {
        var res = CP_SERVER.runCommandSilent("execute in " + z.dim + " run data merge block " +
            Math.floor(x) + " " + Math.floor(y) + " " + Math.floor(zz) + " " + nbt)
        if (Number(res) <= 0) cpLog("очаг не заправился (data merge вернул " + res + ")")
        return Number(res) > 0
    } catch (e) {
        cpErr("заправка очага", e)
        return false
    }
}

/** Убрать блок, только если он там есть. */
function cpClear(z, level, x, y, zz) {
    if (cpIsAir(level, x, y, zz)) return true
    return global.TFG_ZONES.set(z, x, y, zz, "minecraft:air")
}

/** Товар этого торговца: несколько разных стопок из его ассортимента. */
function cpGoods(kindId, tier, count) {
    var out = []
    var offers = []
    try { offers = global.TFG_TRADE_GOODS.offers(kindId, tier) || [] } catch (e) { }
    if (!offers.length) return out
    for (var i = 0; i < count && offers.length; i++) {
        var o = offers[Math.floor(Math.random() * offers.length)]
        if (!o || !o.item) continue
        var n = Math.max(1, Math.min(16, Math.round((o.count || 1) * (0.5 + Math.random() * 1.5))))
        // стволы TACZ не складываются в стопку, а без своего id в NBT они пустышки
        var tag = null
        try { tag = global.TFG_GUN_ITEMS.offerSnbt(o) } catch (e) { }
        if (o.gun) n = 1
        out.push({ id: String(o.item), count: n, price: Number(o.price) || 1, tag: tag })
    }
    return out
}

/** Заполнить ящик товаром; kind - "chest" (Items прямо в блоке) или "inv" (внутри inventory). */
function cpFillContainer(z, x, y, zz, goods, kind) {
    if (!goods.length) return 0
    var items = []
    var value = 0
    goods.forEach((g, i) => {
        items.push('{Slot:' + i + 'b,id:"' + g.id + '",Count:' + g.count + 'b' + (g.tag ? ',tag:' + g.tag : '') + '}')
        value += g.price * g.count
    })
    var body = kind === "chest" ? "{Items:[" + items.join(",") + "]}" : "{inventory:{Items:[" + items.join(",") + "]}}"
    try {
        var res = CP_SERVER.runCommandSilent("execute in " + z.dim + " run data merge block " +
            Math.floor(x) + " " + Math.floor(y) + " " + Math.floor(zz) + " " + body)
        if (Number(res) <= 0) { cpLog("товар не лёг в ящик на " + x + " " + y + " " + zz); return 0 }
    } catch (e) {
        cpErr("наполнение ящика", e)
        return 0
    }
    return Math.round(value)
}

/** Склад лагеря: сундук, бочки и горшки с товаром торговца рядом с палатками. */
function cpStorage(z, level, cx, cz, taken, kindId, tier) {
    var p = cpPatch(level, cx, cz, 3, 2, 6, taken)
    if (!p) return []
    cpFit(z, level, p, 3, 2, 3)
    cpCollar(z, level, p, 3, 2, 2)
    var y = p.y + 1
    var made = []
    var plan = [
        { role: "chest", nbt: "chest", x: p.x, z: p.z, n: 5 },
        { role: tier >= 5 && Math.random() < 0.5 ? "crate" : "pot", nbt: "inv", x: p.x + 1, z: p.z, n: 3 },
        { role: "barrel", nbt: "inv", x: p.x + 2, z: p.z, n: 2 },
        { role: "pot", nbt: "inv", x: p.x, z: p.z + 1, n: 3 },
    ]
    plan.forEach(item => {
        if (Math.random() < 0.15) return
        if (!cpSet(z, item.role, item.x, y, item.z, item.role === "chest" ? null : null)) return
        var goods = cpGoods(kindId, tier, item.n)
        var value = cpFillContainer(z, item.x, y, item.z, goods, item.nbt)
        made.push({ x: item.x, y: y, z: item.z, value: value })
    })
    return made
}

// ─── Поиск ровных пятен под микроструктуры ───────────────────────────────────

/**
 * Найти пятно w x d, которое меньше всего надо трогать.
 * Возвращает { x, z, y, cost } - левый нижний угол, рабочий уровень (верх земли) и цена подгонки.
 */
var CP_BOX = null                   // коробка текущего слепка: за её край строить нельзя

function cpInBox(x0, z0, w, d) {
    if (!CP_BOX) return true
    return x0 >= CP_BOX.x1 + 1 && z0 >= CP_BOX.z1 + 1 && x0 + w - 1 <= CP_BOX.x2 - 1 && z0 + d - 1 <= CP_BOX.z2 - 1
}

function cpPatch(level, cx, cz, w, d, radius, taken) {
    var best = null
    for (var ox = -radius; ox <= radius; ox++) {
        for (var oz = -radius; oz <= radius; oz++) {
            var x0 = cx + ox, z0 = cz + oz
            if (ox * ox + oz * oz > radius * radius) continue
            if (!cpInBox(x0, z0, w, d)) continue
            if (cpOverlaps(taken, x0, z0, w, d)) continue
            var heights = []
            var ok = true
            for (var i = 0; i < w && ok; i++) {
                for (var j = 0; j < d && ok; j++) {
                    var t = cpTop(level, x0 + i, z0 + j)
                    var id = cpId(level, x0 + i, t, z0 + j)
                    if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0 || id.indexOf("ice") >= 0) ok = false
                    heights.push(t)
                }
            }
            if (!ok) continue
            // уровень пятна - самый частый верх; считаем, во что обойдётся подгонка
            var lvl = cpMode(heights)
            var cost = 0
            for (var k = 0; k < heights.length && cost < 999; k++) {
                var diff = heights[k] - lvl
                if (diff > CP_STEP_MAX || -diff > CP_FILL_MAX) { cost = 999; break }
                cost += Math.abs(diff) * (diff > 0 ? 2 : 1)     // срезать дороже, чем подсыпать
            }
            if (cost >= 999) continue
            cost += (ox * ox + oz * oz) * 0.02                   // ближе к центру - лучше
            if (!best || cost < best.cost) best = { x: x0, z: z0, y: lvl, cost: cost }
        }
    }
    return best
}

function cpMode(list) {
    var count = {}, best = list[0], bestN = 0
    list.forEach(v => {
        count[v] = (count[v] || 0) + 1
        if (count[v] > bestN) { bestN = count[v]; best = v }
    })
    return best
}

function cpOverlaps(taken, x0, z0, w, d) {
    if (!taken) return false
    for (var i = 0; i < taken.length; i++) {
        var t = taken[i]
        if (x0 + w - 1 < t.x1 - 1 || x0 > t.x2 + 1 || z0 + d - 1 < t.z1 - 1 || z0 > t.z2 + 1) continue
        return true
    }
    return false
}

function cpTake(taken, p, w, d) { taken.push({ x1: p.x, z1: p.z, x2: p.x + w - 1, z2: p.z + d - 1 }) }

/** Средняя высота по кругу - на этот уровень и равняем середину лагеря. */
function cpBaseLevel(level, cx, cz, r) {
    var hs = []
    for (var x = cx - r; x <= cx + r; x += 1) {
        for (var z = cz - r; z <= cz + r; z += 1) {
            if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > r * r) continue
            hs.push(cpTop(level, x, z))
        }
    }
    hs.sort((a, b) => a - b)
    return hs.length ? hs[Math.floor(hs.length / 2)] : cpTop(level, cx, cz)
}

/**
 * Плавно выровнять площадку: в середине выходим точно на уровень лагеря, к краю всё мягче
 * возвращаемся к настоящему рельефу. Верхний блок сохраняем такой же, каким он был (дёрн остаётся дёрном).
 */
function cpSmooth(z, level, cx, cz, r, base) {
    var target = {}
    var surf = {}
    var cells = []
    for (var x = cx - r; x <= cx + r; x++) {
        for (var zz = cz - r; zz <= cz + r; zz++) {
            var dx = x - cx, dz = zz - cz
            var d2 = dx * dx + dz * dz
            if (d2 > r * r) continue
            var t = cpTop(level, x, zz)
            var id = cpId(level, x, t, zz)
            if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0) continue
            var k = x + ":" + zz
            surf[k] = id
            var d = Math.sqrt(d2)
            var want, fixed = false
            if (d <= CP_FLAT_R) {
                want = base                                   // ядро - строго вровень
                fixed = true
            } else {
                // дальше плавно возвращаемся к настоящему рельефу
                var w = 1 - (d - CP_FLAT_R) / Math.max(1, r - CP_FLAT_R)
                w = w * w
                want = t + (base - t) * w
                want = Math.max(t - CP_CUT_MAX, Math.min(t + CP_FILL_MAX, want))
            }
            target[k] = want
            cells.push({ x: x, z: zz, k: k, top: t, fixed: fixed })
        }
    }
    // усреднение по соседям - убирает ступеньки
    for (var pass = 0; pass < CP_SMOOTH_PASSES; pass++) {
        var next = {}
        cells.forEach(c => {
            if (c.fixed) { next[c.k] = target[c.k]; return }   // ядро усреднением не портим
            var sum = target[c.k], n = 1
            ;[[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(d => {
                var nk = (c.x + d[0]) + ":" + (c.z + d[1])
                if (target[nk] !== undefined) { sum += target[nk]; n++ }
            })
            next[c.k] = sum / n
        })
        cells.forEach(c => { target[c.k] = next[c.k] })
    }
    var cut = 0, fill = 0
    cells.forEach(c => {
        var want = Math.round(target[c.k])
        if (want === c.top) return
        if (want < c.top) {
            for (var y = c.top; y > want; y--) cpClear(z, level, c.x, y, c.z)
            cpSetState(z, c.x, want, c.z, surf[c.k])          // сверху снова дёрн
            cut++
        } else {
            var ground = cpGroundState(level, c.x, c.z)
            for (var y2 = c.top; y2 < want; y2++) cpSetState(z, c.x, y2, c.z, ground)
            cpSetState(z, c.x, want, c.z, surf[c.k])
            fill++
        }
    })
    cpLog("площадка сглажена: срезано колонок " + cut + ", подсыпано " + fill + ", уровень " + base)
}

/** Обойма вокруг пятна: соседние колонки подтягиваем так, чтобы на границе не было ступеньки выше блока. */
function cpCollar(z, level, p, w, d, rings) {
    for (var ring = 1; ring <= (rings || 2); ring++) {
        for (var x = p.x - ring; x <= p.x + w - 1 + ring; x++) {
            for (var zz = p.z - ring; zz <= p.z + d - 1 + ring; zz++) {
                var inside = x >= p.x - ring + 1 && x <= p.x + w - 2 + ring && zz >= p.z - ring + 1 && zz <= p.z + d - 2 + ring
                if (inside) continue                           // только внешнее кольцо
                if (!cpInBox(x, zz, 1, 1)) continue
                var top = cpTop(level, x, zz)
                var want = Math.max(p.y - ring, Math.min(p.y + ring, top))
                if (want === top) continue
                var surfState = cpId(level, x, top, zz)
                if (surfState.indexOf("water") >= 0 || surfState.indexOf("lava") >= 0) continue
                if (want < top) {
                    for (var y = top; y > want; y--) cpClear(z, level, x, y, zz)
                    cpSetState(z, x, want, zz, surfState)
                } else {
                    var ground = cpGroundState(level, x, zz)
                    for (var y2 = top; y2 < want; y2++) cpSetState(z, x, y2, zz, ground)
                    cpSetState(z, x, want, zz, surfState)
                }
            }
        }
    }
}

/** Подогнать пятно: подсыпать низкие клетки, срезать бугры и кусты, освободить место над землёй. */
function cpFit(z, level, p, w, d, headroom) {
    for (var i = 0; i < w; i++) {
        for (var j = 0; j < d; j++) {
            var x = p.x + i, zz = p.z + j
            var top = cpTop(level, x, zz)
            if (top < p.y) {
                var fillState = cpGroundState(level, x, zz)
                var surfState = cpId(level, x, top, zz)
                for (var y = top + 1; y <= p.y; y++) cpSetState(z, x, y, zz, y === p.y ? surfState : fillState)
            } else if (top > p.y) {
                for (var y2 = p.y + 1; y2 <= top; y2++) cpClear(z, level, x, y2, zz)
            }
            for (var h = 1; h <= (headroom || 3); h++) cpClear(z, level, x, p.y + h, zz)
        }
    }
}

// ─── Микроструктуры ──────────────────────────────────────────────────────────

/** Очаг: костёр, поленница и сиденья вокруг - каждое на своей ровной клетке. */
function cpFireplace(z, level, cx, cz, taken) {
    var p = cpPatch(level, cx, cz, 3, 3, 2, taken)
    if (!p) return null
    cpFit(z, level, p, 3, 3, 4)
    cpCollar(z, level, p, 3, 3, 2)
    cpTake(taken, p, 3, 3)
    var fx = p.x + 1, fz = p.z + 1, fy = p.y + 1
    if (cpSet(z, "fire", fx, fy, fz)) cpFuelFire(z, fx, fy, fz)
    cpMowAround(z, level, fx, fy, fz)
    var seats = 0
    var spots = [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]]
    spots.forEach(s => {
        if (seats >= 5 || Math.random() < 0.25) return
        var sx = fx + s[0], sz = fz + s[1]
        var sp = cpPatch(level, sx, sz, 1, 1, 1, taken)
        if (!sp) return
        cpFit(z, level, sp, 1, 1, 3)
        cpTake(taken, sp, 1, 1)
        var dx = fx - sp.x, dz = fz - sp.z
        var facing = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "east" : "west") : (dz > 0 ? "south" : "north")
        var role = Math.random() < 0.6 ? "stool" : "chair"
        if (cpSet(z, role, sp.x, sp.y + 1, sp.z, role === "chair" ? "facing=" + facing : null)) seats++
    })
    // дрова и утварь рядом с огнём
    var lp = cpPatch(level, fx + 2, fz + 2, 1, 1, 3, taken)
    if (lp) {
        cpFit(z, level, lp, 1, 1, 3)
        cpTake(taken, lp, 1, 1)
        cpSet(z, "logs", lp.x, lp.y + 1, lp.z)
    }
    return { x: fx, y: fy, z: fz, seats: seats }
}

/**
 * Палатка: навес Macaw цвета фракции на жердях, задняя и боковые стенки из плетёнки,
 * внутри соломенная лежанка. Размер 3 x (3..4).
 */
function cpTent(z, level, cx, cz, color, taken) {
    var w = 3, d = 3 + Math.floor(Math.random() * 2)
    var p = cpPatch(level, cx, cz, w, d, 6, taken)
    if (!p) return false
    cpFit(z, level, p, w, d, 4)
    cpCollar(z, level, p, w, d, 2)
    cpTake(taken, p, w, d)
    var y = p.y + 1
    var wattle = "tfc:wattle/" + color
    var awning = "mcw_tfc_aio:roofs/awnings/" + color + "_striped_awning"
    // задняя стенка и бока, вход спереди (j = 0)
    for (var i = 0; i < w; i++) {
        for (var j = 0; j < d; j++) {
            var x = p.x + i, zz = p.z + j
            var back = j === d - 1
            var side = i === 0 || i === w - 1
            if (!back && !side) continue
            if (j === 0 && i === 1) continue                     // вход
            for (var h = 0; h < 2; h++) {
                if (!cpSetState(z, x, y + h, zz, wattle)) cpSet(z, "thatch", x, y + h, zz)
            }
        }
    }
    // жерди по передним углам и навес сверху
    cpSet(z, "post", p.x, y, p.z)
    cpSet(z, "post", p.x + w - 1, y, p.z)
    for (var i2 = 0; i2 < w; i2++) {
        for (var j2 = 0; j2 < d; j2++) {
            var ax = p.x + i2, az = p.z + j2
            if (!cpSetState(z, ax, y + 2, az, awning + "[facing=north,shape=straight]")) cpSet(z, "thatch", ax, y + 2, az)
        }
    }
    // лежанка вдоль палатки: голова у задней стенки
    var bx = p.x + 1
    var headZ = p.z + d - 2, footZ = p.z + d - 3
    if (footZ < p.z) footZ = p.z
    cpSet(z, "bedHead", bx, y, headZ)
    cpSet(z, "bedFoot", bx, y, footZ)
    if (Math.random() < 0.5) cpSet(z, "barrel", p.x + (Math.random() < 0.5 ? 0 : w - 1), y, p.z + d - 1)
    return true
}

/** Загон для скота: жерди с воротами; ставим на самое ровное пятно 5x5. */
function cpPen(z, level, cx, cz, taken) {
    var p = cpPatch(level, cx, cz, 5, 5, 7, taken)
    if (!p) return null
    cpFit(z, level, p, 5, 5, 3)
    cpCollar(z, level, p, 5, 5, 2)
    cpTake(taken, p, 5, 5)
    var y = p.y + 1
    for (var i = 0; i < 5; i++) {
        cpSet(z, "fence", p.x + i, y, p.z)
        cpSet(z, "fence", p.x + i, y, p.z + 4)
        cpSet(z, "fence", p.x, y, p.z + i)
        cpSet(z, "fence", p.x + 4, y, p.z + i)
    }
    cpSet(z, "gate", p.x + 2, y, p.z, "facing=north")
    cpSet(z, "barrel", p.x + 1, y, p.z + 1)
    return { x: p.x + 2, y: y, z: p.z + 2 }
}

/** Площадка под аппараты: ровное место, факелы по углам, бочки с горючим. */
function cpParking(z, level, cx, cz, taken) {
    var p = cpPatch(level, cx, cz, 7, 7, 8, taken)
    if (!p) return null
    cpFit(z, level, p, 7, 7, 6)
    cpCollar(z, level, p, 7, 7, 2)
    cpTake(taken, p, 7, 7)
    var y = p.y + 1
    cpSet(z, "torch", p.x, y, p.z)
    cpSet(z, "torch", p.x + 6, y, p.z)
    cpSet(z, "torch", p.x, y, p.z + 6)
    cpSet(z, "torch", p.x + 6, y, p.z + 6)
    cpSet(z, "barrel", p.x + 6, y, p.z + 3)
    cpSet(z, "barrel", p.x + 5, y, p.z + 3)
    return { x: p.x + 3, y: y, z: p.z + 3 }
}

/** Рабочий угол: верстак или ткацкий станок, стол и бочки с товаром. */
function cpWorkCorner(z, level, cx, cz, taken) {
    var p = cpPatch(level, cx, cz, 2, 2, 6, taken)
    if (!p) return false
    cpFit(z, level, p, 2, 2, 3)
    cpCollar(z, level, p, 2, 2, 2)
    cpTake(taken, p, 2, 2)
    var y = p.y + 1
    cpSet(z, Math.random() < 0.5 ? "workbench" : "loom", p.x, y, p.z)
    cpSet(z, "table", p.x + 1, y, p.z)
    cpSet(z, "barrel", p.x + 1, y, p.z + 1)
    cpSet(z, "lantern", p.x, y, p.z + 1)
    return true
}

// ─── Выбор породы дерева и места ─────────────────────────────────────────────

/** Порода по ближайшим брёвнам: лагерь из того, что растёт вокруг. */
function cpWoodNear(level, cx, cz) {
    for (var r = 0; r <= 24; r += 6) {
        for (var a = 0; a < 8; a++) {
            var ang = a * 0.7853981633974483
            var x = Math.floor(cx + Math.cos(ang) * r), z = Math.floor(cz + Math.sin(ang) * r)
            var top = cpTop(level, x, z)
            for (var y = top; y < top + 8; y++) {
                var id = cpId(level, x, y, z)
                var m = id.match(/tfc:wood\/(?:log|wood|leaves)\/([a-z_]+)/)
                if (m && CP_WOODS.indexOf(m[1]) >= 0) return m[1]
            }
        }
    }
    return "oak"
}

/** Не подходит ли место вплотную к базе игроков: граница базы плюс запас. */
function cpNearBase(level, cx, cz) {
    var keep = 0
    try { keep = Number(global.TFG_SETTLEMENTS.radius) + CP_BASE_KEEP } catch (e) { keep = 400 }
    var bad = false
    try {
        global.TFG_SETTLEMENTS.all().forEach(f => {
            if (bad || !f || !f.base) return
            var dx = f.base.x - cx, dz = f.base.z - cz
            if (dx * dx + dz * dz < keep * keep) bad = true
        })
    } catch (e) { }
    return bad
}

/** Годится ли место под лагерь: сухо, не слишком круто, нет чужих построек и не под боком у базы. */
function cpSpotOk(level, cx, cz, r) {
    if (cpNearBase(level, cx, cz)) return false
    var base = cpTop(level, cx, cz)
    var bad = 0, total = 0, trees = 0
    for (var x = cx - r; x <= cx + r; x += 2) {
        for (var z = cz - r; z <= cz + r; z += 2) {
            total++
            var t = cpTop(level, x, z)
            if (Math.abs(t - base) > 4) bad++
            if (cpTreeAbove(level, x, z, t)) trees++
            var id = cpId(level, x, t, z)
            var wet = id.indexOf("water") >= 0 || id.indexOf("lava") >= 0 || id.indexOf("ice") >= 0
            if (wet && Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= r - 1) return false
            if (wet) bad += 3
            if (id.indexOf("chest") >= 0 || id.indexOf("barrel") >= 0 || id.indexOf("planks") >= 0 ||
                id.indexOf("brick") >= 0 || id.indexOf("machine") >= 0 || id.indexOf("casing") >= 0) return false
        }
    }
    // в чаще лагерь не ставим - ищем поляну рядом, деревья валить не будем
    if (trees > total * CP_TREE_LIMIT) return false
    // и отдельно: прямо над очагом кроны быть не должно
    for (var ox = -CP_MOW; ox <= CP_MOW; ox++) {
        for (var oz = -CP_MOW; oz <= CP_MOW; oz++) {
            var tt = cpTop(level, cx + ox, cz + oz)
            if (cpTreeAbove(level, cx + ox, cz + oz, tt)) return false
        }
    }
    return bad <= total * 0.3
}

function cpFindSpot(level, cx, cz, r) {
    if (cpSpotOk(level, cx, cz, r)) return { x: Math.floor(cx), z: Math.floor(cz) }
    for (var ring = 6; ring <= 72; ring += 6) {
        for (var a = 0; a < 12; a++) {
            var ang = a * 0.5235987755982988 + Math.random() * 0.3
            var x = Math.floor(cx + Math.cos(ang) * ring), z = Math.floor(cz + Math.sin(ang) * ring)
            if (cpSpotOk(level, x, z, r)) return { x: x, z: z }
        }
    }
    return null
}

// ─── Стройка лагеря ──────────────────────────────────────────────────────────

/**
 * Поставить стоянку. opts: faction, ttl, animals, crafts, visit, owner.
 * Возвращает запись стоянки или строку с ошибкой.
 */
function cpBuild(level, cx, cz, opts) {
    if (!CP_SERVER) CP_SERVER = level.getServer()
    opts = opts || {}
    var r = opts.radius || CP_RADIUS
    var spot = cpFindSpot(level, Math.floor(cx), Math.floor(cz), r)
    if (!spot) return "рядом негде встать: криво, мокро или чужая стройка"
    CP_WOOD = cpWoodNear(level, spot.x, spot.z)
    var base = cpBaseLevel(level, spot.x, spot.z, r - 1)
    var ttl = opts.ttl || CP_TTL
    var id = global.TFG_ZONES.snapshot(level, spot.x - r - CP_MARGIN, base - CP_DOWN, spot.z - r - CP_MARGIN,
        spot.x + r + CP_MARGIN, base + CP_UP, spot.z + r + CP_MARGIN,
        { label: "стоянка " + (opts.faction || "?"), ttl: ttl + CP_TTL_MARGIN, owner: opts.owner || null })
    if (String(id).indexOf("z") !== 0) return String(id)
    var z = global.TFG_ZONES.get(id)
    CP_BOX = z.box
    var color = CP_COLOR[opts.faction] || "brown"
    var taken = []

    // сперва мягко ровняем площадку, потом уже расставляем микроструктуры по готовому уровню
    cpSmooth(z, level, spot.x, spot.z, r - 1, base)
    var fire = cpFireplace(z, level, spot.x, spot.z, taken)
    if (!fire) {
        global.TFG_ZONES.drop(id)
        return "не нашлось ровного места даже под очаг"
    }
    var tents = 0
    var want = 2 + Math.floor(Math.random() * 2)
    var start = Math.random() * 6.283185307179586
    for (var i = 0; i < want; i++) {
        var ang = start + i * 6.283185307179586 / want
        var tx = Math.round(spot.x + Math.cos(ang) * (r - 3))
        var tz = Math.round(spot.z + Math.sin(ang) * (r - 3))
        if (cpTent(z, level, tx, tz, color, taken)) tents++
    }
    cpWorkCorner(z, level, spot.x + Math.round(Math.cos(start + 1) * (r - 4)), spot.z + Math.round(Math.sin(start + 1) * (r - 4)), taken)
    var storage = cpStorage(z, level, spot.x + Math.round(Math.cos(start + 2.5) * (r - 4)),
        spot.z + Math.round(Math.sin(start + 2.5) * (r - 4)), taken, opts.kind, opts.tier || 3)
    var pen = opts.animals ? cpPen(z, level, spot.x - r + 4, spot.z + r - 4, taken) : null
    var pad = opts.crafts ? cpParking(z, level, spot.x + r - 4, spot.z - r + 4, taken) : null

    var camp = {
        zone: id, dim: String(level.getDimension()), x: fire.x, y: fire.y, z: fire.z, r: r,
        faction: opts.faction || null, wood: CP_WOOD, made: Number(level.getTime()), until: Number(level.getTime()) + ttl,
        tents: tents, seats: fire.seats, pen: pen, pad: pad, visit: opts.visit || null,
        kind: opts.kind || null, tier: opts.tier || 3,
        loot: storage, lootValue: 0, stolen: 0, angry: false, warned: false, baseline: false, pending: 0,
        watch: storage.length > 0, watchFrom: Number(level.getTime()) + 600,
    }
    var camps = cpLoad()
    camps[id] = camp
    cpSave()
    cpLog("лагерь " + id + " на " + fire.x + " " + fire.z + " (" + CP_WOOD + "): палаток " + tents + ", сидений " + fire.seats +
        (pen ? ", загон" : "") + (pad ? ", площадка" : ""))
    return camp
}

// ─── Учёт стоянок ────────────────────────────────────────────────────────────

var CP_CAMPS = null

function cpLoad() {
    if (CP_CAMPS) return CP_CAMPS
    if (!CP_SERVER) return {}
    var pd = CP_SERVER.persistentData
    try { CP_CAMPS = JSON.parse(global.TFG_STORE.read(pd, "tfg_camps") || "{}") } catch (e) { CP_CAMPS = {} }
    return CP_CAMPS
}

function cpSave() {
    if (!CP_SERVER || !CP_CAMPS) return
    var bad = global.TFG_STORE.write(CP_SERVER.persistentData, "tfg_camps", JSON.stringify(CP_CAMPS))
    if (bad) cpErr("запись лагерей", bad)
}

function cpRemove(zoneId, why, keepPeople) {
    var camps = cpLoad()
    var camp = camps[String(zoneId)]
    if (!camp) return "нет такой стоянки"
    delete camps[String(zoneId)]
    cpSave()
    // обитатели уходят вместе с лагерем: иначе торговец, охрана и телеги остаются стоять в чистом поле
    if (camp.visit && !keepPeople) {
        try { cvCampGone(camp.visit, why || "лагерь свернули") } catch (e) { cpErr("увести обитателей", e) }
    }
    return global.TFG_ZONES.restore(camp.zone, why || "лагерь свернули")
}

function cpList() {
    var camps = cpLoad()
    var out = []
    for (var id in camps) out.push(camps[id])
    return out
}

function cpAt(dim, x, z, maxDist) {
    var best = null
    cpList().forEach(c => {
        if (c.dim !== String(dim)) return
        var d = Math.sqrt(Math.pow(c.x - x, 2) + Math.pow(c.z - z, 2))
        if (d <= (maxDist || c.r + 6) && (!best || d < best.d)) best = { camp: c, d: d }
    })
    return best ? best.camp : null
}

global.TFG_CAMPS = {
    build: (level, x, z, opts) => cpBuild(level, x, z, opts),
    remove: (zoneId, why, keepPeople) => cpRemove(zoneId, why, keepPeople),
    list: () => cpList(),
    at: (dim, x, z, d) => cpAt(dim, x, z, d),
}

/** Что сейчас лежит в ящиках лагеря, по прайсу торговцев. */
/**
 * Что сейчас лежит в ящиках лагеря. Возвращает { value, read } - стоимость и сколько ящиков
 * удалось прочитать. Если прочитать не вышло ни одного (чанк не прогружен, другой формат NBT),
 * это НЕ повод считать лагерь обнесённым.
 */
function cpLootValue(level, camp) {
    var total = 0, read = 0
    ;(camp.loot || []).forEach(c => {
        var text = ""
        try {
            var data = level.getBlock(c.x, c.y, c.z).entityData
            if (!data) return
            text = String(data)
        } catch (e) { return }
        if (!text) return
        read++
        // пробелы в SNBT зависят от версии, поэтому регулярка их допускает
        var re = /id:\s*"([^"]+)"\s*,\s*Count:\s*(\d+)b/g
        var m
        while ((m = re.exec(text)) !== null) {
            var price = 1
            try { price = Number(global.TFG_TRADE_GOODS.itemPrice(m[1])) || 1 } catch (e) { }
            total += price * Number(m[2])
        }
    })
    return { value: Math.round(total), read: read }
}

/** Кто из игроков сейчас в лагере. */
function cpPlayerIn(camp) {
    var found = null
    try {
        CP_SERVER.players.forEach(p => {
            if (found || String(p.level.getDimension()) !== camp.dim) return
            var dx = p.getX() - camp.x, dz = p.getZ() - camp.z
            if (dx * dx + dz * dz < (camp.r + 6) * (camp.r + 6)) found = p
        })
    } catch (e) { }
    return found
}

/**
 * Присмотр за добром: пропало по мелочи - ворчат и теряют к вам расположение,
 * обнесли всерьёз - охрана лагеря берётся за оружие.
 */
function cpWatchLoot(level, camp) {
    if (!camp.loot || !camp.loot.length || camp.watch === false) return
    var now = Number(level.getTime())
    if (now < (camp.watchFrom || 0)) return                       // после стройки даём людям осмотреться
    var snap = cpLootValue(level, camp)
    if (!snap.read) return                                        // ящики не читаются - молчим, а не обвиняем
    // первая удачная опись и есть точка отсчёта: цены при стройке и содержимое ящиков могут не совпасть
    if (camp.baseline !== true) {
        camp.baseline = true
        camp.lootValue = snap.value
        camp.stolen = 0
        cpSave()
        cpLog(camp.zone + ": опись добра - " + snap.value)
        return
    }
    var thief = cpPlayerIn(camp)
    if (!thief) return
    var gone = camp.lootValue - snap.value
    if (gone <= 0) {
        camp.lootValue = Math.max(camp.lootValue, snap.value)
        camp.pending = 0
        return
    }
    // ждём второго подтверждения: одиночная осечка чтения не должна поднимать лагерь
    if ((camp.pending || 0) < gone * 0.5) {
        camp.pending = gone
        cpSave()
        return
    }
    camp.pending = 0
    camp.lootValue = snap.value
    camp.stolen = (camp.stolen || 0) + gone
    cpSave()
    var big = camp.warned === true && (camp.stolen > Math.max(120, snap.value * 0.4) || gone > 200)
    var v = null
    try { v = camp.visit ? gsLoad()[camp.visit] : null } catch (e) { }
    if (!big) {
        camp.warned = true
        cpSave()
        try {
            global.TFG_POLITICS.deed(thief, camp.faction, "theft", "мелкая кража в лагере")
        } catch (e) { }
        if (v) {
            var rt = gsRt(v.id)
            var g = gsEntity(v, v.trader) || gsEntity(v, v.guards[0])
            if (g) gsMono(v, rt, g, null, gsNow(level), 1, cpPick(CP_THEFT_WORDS))
        }
        cpLog(camp.zone + ": " + thief.username + " утащил мелочь на " + gone)
        return
    }
    if (camp.angry) return
    camp.angry = true
    cpSave()
    try { global.TFG_POLITICS.deed(thief, camp.faction, "raid", "разграбление лагеря") } catch (e) { }
    if (v) {
        try { gsProvoke(v, thief, level, 12000, "вы обнесли наш лагерь") } catch (e) { cpErr("поднять лагерь", e) }
    }
    cpLog(camp.zone + ": " + thief.username + " обнёс лагерь на " + camp.stolen + " - охрана в бой")
}

const CP_THEFT_WORDS = ["Эй, руки-то убери.", "Считать, думаешь, не умеем?", "Товар не трогай без спроса.",
    "Ещё раз полезешь - разговор будет другой.", "Видел я, что ты взял."]

ServerEvents.tick(event => {
    if (!CP_SERVER) CP_SERVER = event.server
    if (event.server.tickCount % 40 === 0) {
        try {
            cpList().forEach(c => {
                var lvl = null
                try { lvl = CP_SERVER.getLevel(c.dim) } catch (e) { }
                if (lvl) cpWatchLoot(lvl, c)
            })
        } catch (e) { cpErr("присмотр за добром", e) }
    }
    if (event.server.tickCount % 100 !== 0) return
    try {
        var now = Number(event.server.overworld().getTime())
        cpList().forEach(c => { if (now >= c.until) cpRemove(c.zone, "стоянку свернули по сроку") })
    } catch (e) { cpErr("сроки", e) }
})

// ─── Команды ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgcamp").requires(s => s.hasPermission(2))
            .executes(ctx => cpCmdBuild(ctx, null, null))
            .then(Commands.literal("list").executes(ctx => {
                if (!CP_SERVER) CP_SERVER = ctx.source.getServer()
                var now = Number(ctx.source.getServer().overworld().getTime())
                var rows = cpList().map(c => "§f" + c.zone + " §7" + (c.faction || "?") + " " + c.x + " " + c.z +
                    ", палаток " + c.tents + ", сидений " + c.seats +
                    ", свернётся через " + Math.max(0, Math.round((c.until - now) / 20)) + " с")
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7стоянок нет"), false)
                return 1
            }))
            .then(Commands.literal("remove").executes(ctx => {
                if (!CP_SERVER) CP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var near = cpAt(String(p.level.getDimension()), p.getX(), p.getZ(), 80)
                if (!near) { ctx.source.sendFailure(Text.of("Рядом нет стоянки.")); return 1 }
                var err = cpRemove(near.zone, "команда")
                ctx.source.sendSuccess(Text.of(err ? "§c" + err : "Сворачиваю стоянку, всё вернётся как было."), false)
                return 1
            }))
            .then(Commands.literal("removeall").executes(ctx => {
                if (!CP_SERVER) CP_SERVER = ctx.source.getServer()
                var n = 0
                cpList().forEach(c => { if (!cpRemove(c.zone, "команда")) n++ })
                ctx.source.sendSuccess(Text.of("Сворачиваю стоянок: " + n), false)
                return 1
            }))
            .then(Commands.argument("faction", Arguments.STRING.create(event))
                .executes(ctx => cpCmdBuild(ctx, String(Arguments.STRING.getResult(ctx, "faction")), null))
                .then(Commands.argument("minutes", Arguments.INTEGER.create(event)).executes(ctx =>
                    cpCmdBuild(ctx, String(Arguments.STRING.getResult(ctx, "faction")),
                        Number(Arguments.INTEGER.getResult(ctx, "minutes")))))))
    } catch (err) {
        console.error("[camps] ошибка регистрации команд: " + err)
    }
})

/** Тестовая стоянка с людьми: караван встаёт лагерем прямо здесь (factions/caravans.js). */
function cpCmdBuild(ctx, faction, minutes) {
    if (!CP_SERVER) CP_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var fac = faction || cpPick(global.TFG_FACTIONS.list.filter(f => f.id !== "bandits").map(f => f.id))
    var ttl = minutes ? Math.max(1, Math.min(120, minutes)) * 1200 : CP_TTL
    var res = "нет каравана"
    try { res = cvCampHere(p, fac, ttl) } catch (e) { res = String(e) }
    if (typeof res === "string") ctx.source.sendFailure(Text.of("Стоянка не встала: " + res))
    else ctx.source.sendSuccess(Text.of("Стоянка фракции " + fac + " на " + res.x + " " + res.z +
        ": палаток " + res.tents + ", сидений " + res.seats + ", зона " + res.zone), false)
    return 1
}
