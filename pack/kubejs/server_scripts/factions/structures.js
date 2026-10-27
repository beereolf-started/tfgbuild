"use strict";
/**
 * ПОСТАНОВКА ШАБЛОНОВ В МИР: поворот, посадка на рельеф, сглаживание и наполнение.
 *
 * Порядок работы:
 *   1. ищем ровное место нужного размера (как для стоянок);
 *   2. выбираем поворот: вход смотрит в самую открытую сторону;
 *   3. снимаем слепок зоны (factions/zones.js) - постройку можно убрать без следа;
 *   4. ровняем землю под пятном, площадку перед входом и мягко сводим края с рельефом;
 *   5. ставим блоки с поворотом состояний (facing, axis, повороты вывесок, стороны заборов);
 *   6. наполняем содержимым по этажам: кухня, спальня, арсенал.
 *
 * Клетки шаблона: индекс палитры - блок, -1 «не трогать» (останется рельеф), -2 обязательная пустота.
 * Команды: /tfgstruct place <имя> [градусы] | list | remove
 */

var ST_SERVER = null
var ST_QUEUE = []                       // очередь постановки: [{cmds, i}]

const ST_PER_TICK = 80                  // команд за тик
const ST_SMOOTH = 5                     // ширина полосы сглаживания вокруг пятна
const ST_CUT = 4                        // насколько можно срезать рельеф под самой постройкой
const ST_FILL = 5                       // и насколько подсыпать
const ST_OUT_CUT = 2                    // а снаружи трогаем землю куда осторожнее
const ST_OUT_FILL = 2
const ST_MAX_RANGE = 8                  // предельный перепад под пятном: дальше это обрыв
const ST_BURY = 1                       // на сколько прикапываем фундамент
const ST_DOOR_APRON = 4                 // глубина расчищенной площадки перед входом
const ST_APRON_WIDE = 2                 // половина ширины крыльца: вход должен быть виден

function stLog(t) { try { console.log("[постройки] " + t) } catch (e) { } }
function stErr(w, e) { try { console.error("[постройки] " + w + ": " + e) } catch (err) { } }
function stPick(list) { return list[Math.floor(Math.random() * list.length)] }
function stRun(cmd) { try { return Number(ST_SERVER.runCommandSilent(cmd)) } catch (e) { stErr("команда", e); return 0 } }
function stQueue(cmds) { if (cmds.length) ST_QUEUE.push({ cmds: cmds, i: 0 }) }

// ─── Поворот состояний блоков ────────────────────────────────────────────────

const ST_FACING = ["north", "east", "south", "west"]
const ST_SIDE_PROPS = ["north", "east", "south", "west"]

function stTurn(dir, steps) {
    var i = ST_FACING.indexOf(dir)
    if (i < 0) return dir
    return ST_FACING[(i + steps) % 4]
}

/** Повернуть состояние блока на steps четвертей по часовой стрелке. */
function stRotateState(state, steps) {
    steps = ((steps % 4) + 4) % 4
    if (!steps || state.indexOf("[") < 0) return state
    var base = state.substring(0, state.indexOf("["))
    var body = state.substring(state.indexOf("[") + 1, state.length - 1)
    var parts = body.split(",")
    var props = {}
    parts.forEach(p => {
        var kv = p.split("=")
        props[kv[0]] = kv[1]
    })
    var out = {}
    for (var k in props) out[k] = props[k]
    if (props.facing && ST_FACING.indexOf(props.facing) >= 0) out.facing = stTurn(props.facing, steps)
    if (props.axis === "x" || props.axis === "z") out.axis = steps % 2 ? (props.axis === "x" ? "z" : "x") : props.axis
    // вертикальные плиты additionalplacements держат свою ось отдельно
    // и свою половину: type=top - плита у положительной стороны оси, bottom - у отрицательной.
    // Четверть по часовой: запад (-x) уходит на север (-z) - половина та же; север (-z) уходит
    // на восток (+x) - половина меняется. Без этого стены из плит после поворота шли щелями,
    // и прислонённое к ним (стеллажи, двери) отваливалось.
    if (props.ap_axis === "x" || props.ap_axis === "z") {
        var apAxis = props.ap_axis, apType = props.type
        for (var as = 0; as < steps; as++) {
            if (apAxis === "z" && (apType === "top" || apType === "bottom")) apType = apType === "top" ? "bottom" : "top"
            apAxis = apAxis === "x" ? "z" : "x"
        }
        out.ap_axis = apAxis
        if (apType !== undefined) out.type = apType
    }
    // Любое свойство, чьё ЗНАЧЕНИЕ - сторона света, тоже надо повернуть: ветви брёвен,
    // мебель mcw, всякие orientation. Иначе после поворота в доме бардак.
    for (var pk in props) {
        if (pk === "facing" || ST_SIDE_PROPS.indexOf(pk) >= 0) continue
        if (ST_FACING.indexOf(props[pk]) >= 0) out[pk] = stTurn(props[pk], steps)
    }
    if (props.rotation !== undefined) out.rotation = String((Number(props.rotation) + steps * 4) % 16)
    // заборы, стены, решётки: стороны переезжают по кругу
    var sides = ST_SIDE_PROPS.filter(s => props[s] !== undefined)
    if (sides.length >= 3) {
        ST_SIDE_PROPS.forEach(s => {
            if (props[s] !== undefined) out[stTurn(s, steps)] = props[s]
        })
    }
    var keys = []
    for (var kk in out) keys.push(kk)
    keys.sort()
    return base + "[" + keys.map(k => k + "=" + out[k]).join(",") + "]"
}

/** Координата клетки шаблона после поворота. */
function stRotatePos(x, z, sx, sz, steps) {
    if (steps === 1) return [sz - 1 - z, x]
    if (steps === 2) return [sx - 1 - x, sz - 1 - z]
    if (steps === 3) return [z, sx - 1 - x]
    return [x, z]
}

function stRotatedSize(size, steps) {
    return steps % 2 ? [size[2], size[1], size[0]] : [size[0], size[1], size[2]]
}

// ─── Разбор шаблона ──────────────────────────────────────────────────────────

// металлы, у которых в CreateDeco есть и фасад, и мостки, и лестницы (золотых нет вовсе:
// с ними фасады и лестницы просто не вставали)
const ST_DECO_METALS = ["copper", "zinc", "brass", "iron", "industrial_iron", "andesite"]
const ST_GLASS_COLORS = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
    "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"]

/**
 * Отделка постройки: у CreateDeco меняем металл (медь, цинк, латунь), у витражей - цвет.
 * Так соседние дома на улице не выглядят близнецами.
 */
// породы камня TFC: из одной строится вся улица
const ST_ROCKS = ["andesite", "basalt", "chalk", "chert", "claystone", "conglomerate", "dacite",
    "diorite", "dolomite", "gabbro", "gneiss", "granite", "limestone", "marble", "phyllite",
    "quartzite", "rhyolite", "schist", "shale", "slate"]

const ST_WOODS = ["oak", "pine", "birch", "maple", "spruce", "ash", "douglas_fir", "chestnut",
    "sequoia", "white_cedar", "willow", "acacia", "sycamore", "hickory", "aspen", "blackwood", "rosewood"]

// Породы для подмены в чужих блоках (Macaw: крыши, мебель): длинные первыми, чтобы
// "white_cedar" не распознать как "cedar"
const ST_WOOD_IDS = ["douglas_fir", "white_cedar", "blackwood", "chestnut", "mangrove", "rosewood", "sequoia",
    "sycamore", "hickory", "acacia", "spruce", "willow", "aspen", "birch", "kapok", "maple", "palm", "pine", "ash", "oak"]

/**
 * Замена пород одним проходом: { из: в }. Главная порода шаблона - на породу постройки,
 * вторая (opts.wood2) - на свою. Блоки TFC (wood/<вид>/<порода>) и Macaw TFC
 * (mcw_tfc_aio:roofs/aspen_roofs/aspen_planks_roof) - если такого блока нет, оставляем как было.
 */
function stWoodSwap(state, map) {
    var froms = Object.keys(map).filter(k => map[k] && map[k] !== k)
    if (!froms.length) return state
    froms.sort((a, b) => b.length - a.length)
    var alt = froms.join("|")
    var next = state.replace(new RegExp("(wood/[a-z_]*?/)(" + alt + ")(?![a-z])", "g"), (all, head, w) => head + map[w])
    if (next.indexOf("mcw_tfc_aio:") === 0) {
        var id0 = next.split("[")[0]
        var id1 = id0.replace(new RegExp("(^|[/:_])(" + alt + ")(?=_)", "g"), (all, head, w) => head + map[w])
        if (id1 !== id0 && stExists(id1)) next = id1 + next.slice(id0.length)
    }
    return next
}

function stSkin(state, opts) {
    if (!opts) return state
    // порода дерева меняется на лету: так одна и та же башня выглядит по-разному на каждой улице
    // Порода камня. Главный камень шаблона становится камнем улицы, а второстепенные
    // сдвигаются по списку на столько же: акценты остаются акцентами, но вся улица из одного
    // семейства пород, а не вразнобой.
    if (opts.rockShift) {
        state = state.replace(/(rock\/[a-z_]+\/)([a-z_]+?)(_stairs|_slab|_wall|_button|_pressure_plate)?(?=\[|$)/g,
            function (all, head, rock, tail) {
                var i = ST_ROCKS.indexOf(rock)
                if (i < 0) return all
                var next = ST_ROCKS[(i + opts.rockShift + ST_ROCKS.length * 4) % ST_ROCKS.length]
                return head + next + (tail || "")
            })
    }
    if (opts.woodMap) state = stWoodSwap(state, opts.woodMap)
    if (opts.metal && state.indexOf("createdeco:") === 0) {
        // Подменяем, только если такой блок есть: у старых поселений в записи бывает "gold",
        // а iron_bars у CreateDeco нет - тогда оставляем металл шаблона, а не дыру.
        var swapped = state.replace(/createdeco:(industrial_iron|andesite|copper|zinc|brass|iron|gold|netherite)_/,
            "createdeco:" + opts.metal + "_")
        if (swapped !== state && stExists(swapped.split("[")[0])) state = swapped
    }
    if (opts.glass) {
        state = state.replace(/minecraft:[a-z_]*stained_glass_pane/, "minecraft:" + opts.glass + "_stained_glass_pane")
        state = state.replace(/minecraft:[a-z_]*stained_glass(?!_)/, "minecraft:" + opts.glass + "_stained_glass")
    }
    return state
}

/**
 * Свет в доме. Ванильных свечей в сборке нет - меняем на свечи TFC того же цвета,
 * а свечи и фонари ставим сразу зажжёнными: дом должен выглядеть жилым.
 */
/**
 * Свет, который не гаснет.
 *
 * Фонарь TFC жжёт топливо, и вечным он бывает только один: синяя сталь с лавой
 * (в данных TFC у лавы burn_rate -1, и годится она лишь для tfc:metal/lamp/blue_steel).
 * Поэтому любой фонарь поселения ставим из синей стали и заливаем лавой.
 *
 * Свеча гаснет по счётчику тиков (TickCounterBlockEntity плюс настройка candleTicks).
 * Счётчику записываем время далеко в будущем - тогда "прошло тиков" остаётся
 * отрицательным и свеча не догорает.
 */
function stFixLight(state) {
    var id = state.split("[")[0]
    if (id.indexOf("tfc:metal/lamp/") === 0 && id !== "tfc:metal/lamp/blue_steel") {
        state = "tfc:metal/lamp/blue_steel" + state.slice(id.length)
        id = "tfc:metal/lamp/blue_steel"
    }
    if (id.indexOf("minecraft:") === 0 && id.indexOf("candle") >= 0) {
        var m = id.match(/^minecraft:([a-z_]+)_candle$/)
        var next = m ? "tfc:candle/" + m[1] : "tfc:candle"
        if (!stExists(next)) next = "tfc:candle"
        state = next + state.slice(id.length)
    }
    // Свечу зажигаем сразу, а фонарь - нет. Горящий фонарь с пустым баком TFC гасит
     // на первом же случайном тике и обратно уже не зажжёт: топливо считается негодным.
     // Поэтому фонарь ставим погашенным, а огонь даёт stLightLamp - после заправки.
    if (state.indexOf("candle") >= 0) state = state.replace("lit=false", "lit=true")
    if (state.indexOf("/lamp/") >= 0) state = state.replace("lit=true", "lit=false")
    return state
}

/**
 * Кладка слитков или листов: блок хранит список предметов в NBT (ключ stacks).
 * Без него в мире стоит пустая кладка, которую нельзя разобрать - как раз то,
 * на что жаловались. Кладём столько слитков, сколько влезает в такую кладку.
 */
function stFillPile(level, x, y, z, id) {
    var count = id.indexOf("sheet") >= 0 ? 4 : (8 + Math.floor(Math.random() * 25))
    var stack = null
    try {
        stack = id.indexOf("sheet") >= 0
            ? stGtMaterial("plate", stPick(stStock()), 1)
            : stGtMaterial("ingot", stPick(stStock()), 1)
    } catch (e) { }
    if (!stack || stack.isEmpty()) return false
    var one = stStackNbt(stack)
    if (!one) return false
    var list = []
    for (var i = 0; i < count; i++) list.push(one)
    try {
        stRun("execute in " + String(level.getDimension()) + " run data merge block " + x + " " + y + " " + z +
            " {stacks:[" + list.join(",") + "]}")
        var be = level.getBlock(x, y, z).getEntity()
        if (be) be.setChanged()
        return true
    } catch (e) { stErr("кладка слитков", e) }
    return false
}

/** Свеча, которая не догорает: счётчик тиков уводим далеко вперёд. */
function stKeepCandle(level, x, y, z) {
    try {
        stRun("execute in " + String(level.getDimension()) + " run data merge block " + x + " " + y + " " + z +
            " {tick:9000000000L}")
        return true
    } catch (e) { stErr("свеча", e) }
    return false
}

/** Развернуть RLE в список клеток: { x, y, z, state | "" (пустота) }. */
function stCells(tpl) {
    var out = []
    var sx = tpl.size[0], sy = tpl.size[1], sz = tpl.size[2]
    var pos = 0
    tpl.data.forEach(seg => {
        var v = seg[0], n = seg[1]
        if (v !== -1) {
            for (var k = 0; k < n; k++) {
                var p = pos + k
                var x = Math.floor(p / (sy * sz))
                var rest = p % (sy * sz)
                var y = Math.floor(rest / sz)
                var z = rest % sz
                out.push({ x: x, y: y, z: z, state: v === -2 ? "" : tpl.palette[v] })
            }
        }
        pos += n
    })
    return out
}

/**
 * Нижний слой шаблона, где есть блоки. Снимок часто захватывает пару пустых слоёв снизу,
 * и если их не убрать, постройка висит в воздухе, а под ней вырастает насыпь.
 */
function stFloorY(cells) {
    var min = null
    cells.forEach(c => { if (c.state && (min === null || c.y < min)) min = c.y })
    return min === null ? 0 : min
}

/** Повернуть вектор выхода на те же четверти, что и саму постройку. */
function stTurnVec(v, steps) {
    var dx = v.dx, dz = v.dz
    for (var i = 0; i < ((steps % 4) + 4) % 4; i++) {
        var ndx = -dz, ndz = dx
        dx = ndx; dz = ndz
    }
    return { dx: dx, dz: dz }
}

/**
 * Где вход. Дверей в доме много, и межкомнатная нам не годится: парадной считаем ту,
 * что на нижнем этаже и ближе всех к краю шаблона - от неё и наружу, и дорожка.
 * Возвращает { x, y, z, facing, out: { dx, dz } } или null.
 */
function stDoor(cells, tpl) {
    var sx = tpl ? tpl.size[0] : 0, sz = tpl ? tpl.size[2] : 0
    var floorY = stFloorY(cells)
    var occ = {}
    cells.forEach(c => { if (c.state) occ[c.x + "," + c.y + "," + c.z] = 1 })
    // сквозь что проходят: двери, калитки, ковры, свет, трава
    var hard = {}
    cells.forEach(c => {
        if (c.state && !/(_door|fence_gate|carpet|torch|lantern|_sign|pressure_plate|button|candle|flower|tfc:plant|grass)/.test(c.state))
            hard[c.x + "," + c.y + "," + c.z] = 1
    })
    var best = null, bestScore = 1e9
    cells.forEach(c => {
        if (!c.state || c.state.indexOf("_door") < 0) return
        if (c.state.indexOf("half=lower") < 0) return
        var edge = 0, out = { dx: 0, dz: 0 }, blockers = 0
        // Выход - туда, где у двери в самом деле проход (свободно в рост) и откуда до края
        // шаблона меньше всего стен. Раньше бралась сторона ближайшего края, и у домов, где
        // дверь стоит в стене вдоль другой оси, «наружу» выходило сквозь стену: крыльцо,
        // тропа и поворот дома к улице - всё было сбоку от двери.
        var bestDir = null, bestDirScore = 1e9
        if (sx && sz) {
            ;[{ dx: -1, dz: 0 }, { dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: 0, dz: 1 }].forEach(dv => {
                var ax = c.x + dv.dx, az = c.z + dv.dz
                if (hard[ax + "," + c.y + "," + az] || hard[ax + "," + (c.y + 1) + "," + az]) return
                var bl = 0, len = 0, wx = c.x, wz = c.z
                while (true) {
                    wx += dv.dx; wz += dv.dz
                    if (wx < 0 || wz < 0 || wx >= sx || wz >= sz) break
                    len++
                    if (hard[wx + "," + (c.y + 1) + "," + wz]) bl++
                }
                var sc = bl * 100 + len
                if (sc < bestDirScore) { bestDirScore = sc; bestDir = { out: dv, bl: bl, len: len } }
            })
        }
        if (bestDir) {
            out = { dx: bestDir.out.dx, dz: bestDir.out.dz }
            blockers = bestDir.bl
            edge = bestDir.len
        } else if (sx && sz) {
            var dW = c.x, dE = sx - 1 - c.x, dN = c.z, dS = sz - 1 - c.z
            edge = Math.min(dW, dE, dN, dS)
            out = edge === dW ? { dx: -1, dz: 0 } : edge === dE ? { dx: 1, dz: 0 }
                : edge === dN ? { dx: 0, dz: -1 } : { dx: 0, dz: 1 }
            // Ведёт ли дверь наружу: идём от неё по выходу до края и считаем стены на
            // уровне головы. Так отсеивается межкомнатная дверь и дверь во внутренний двор.
            var wx = c.x, wz = c.z
            for (var stp = 1; stp <= Math.max(sx, sz); stp++) {
                wx += out.dx; wz += out.dz
                if (wx < 0 || wz < 0 || wx >= sx || wz >= sz) break
                if (occ[wx + "," + c.y + "," + wz]) blockers++
            }
        }
        // сперва свободный выход, потом нижний этаж, потом близость к краю
        var score = blockers * 100 + (c.y - floorY) * 10 + edge
        if (!best || score < bestScore) {
            var m = c.state.match(/facing=([a-z]+)/)
            bestScore = score
            best = { x: c.x, y: c.y, z: c.z, facing: m ? m[1] : "north", out: out, edge: edge, blockers: blockers }
        }
    })
    return best
}

// ─── Рельеф ──────────────────────────────────────────────────────────────────

function stTop(level, x, z) {
    var y = 200
    try { y = Number(level.getHeight("WORLD_SURFACE_WG", Math.floor(x), Math.floor(z))) } catch (e) { y = 70 }
    for (var i = 0; i < 48; i++) {
        var yy = y - 1 - i
        var id = ""
        try { id = String(level.getBlock(Math.floor(x), yy, Math.floor(z)).id) } catch (e) { return yy }
        if (id === "minecraft:air") continue
        if (id.indexOf("plant/") >= 0 || id.indexOf("leaves") >= 0 || id.indexOf("log/") >= 0 ||
            id.indexOf("groundcover") >= 0 || id.indexOf("snow") >= 0 || id.indexOf("wood/") >= 0) continue
        return yy
    }
    return y - 1
}

function stGroundState(level, x, z) {
    var top = stTop(level, x, z)
    var below = ""
    try { below = String(level.getBlock(Math.floor(x), top - 1, Math.floor(z)).id) } catch (e) { }
    if (below && below.indexOf("grass") < 0 && below !== "minecraft:air") return below
    var id = ""
    try { id = String(level.getBlock(Math.floor(x), top, Math.floor(z)).id) } catch (e) { }
    return id.indexOf("grass") >= 0 ? id.replace("grass", "dirt") : (id || "tfc:dirt/loam")
}

/**
 * Не налезаем ли на чужую постройку. Блоки ставятся из очереди, поэтому смотреть на мир мало:
 * соседний дом ещё не встал, но его зона уже есть - по ней и проверяем.
 */
function stZoneClash(level, cx, cz, half, fit) {
    cx = Number(cx); cz = Number(cz); half = Number(half)
    // не числа - не повод считать место занятым первой же зоной реестра (сравнения с NaN все ложны)
    if (!isFinite(cx) || !isFinite(cz) || !isFinite(half)) { stLog("проверка места: не число (" + cx + " " + cz + " " + half + ")"); return true }
    var dim = String(level.getDimension())
    var list = []
    try { list = global.TFG_ZONES.list() } catch (e) { return false }
    for (var i = 0; i < list.length; i++) {
        var z = list[i]
        if (String(z.dim) !== dim) continue
        var lab = String(z.label || "")
        if (lab.indexOf("дорога") >= 0) continue          // с дорогой пересекаться можно
        if (lab.indexOf("рельеф") >= 0) continue          // и с выглаженной землёй (street.js, srSmooth)
        if (lab.indexOf("засыпка воды") >= 0) continue    // и с засыпанной саманом водой (street.js, srFillWater)
        // Тесная застройка: у знакомой постройки сверяем не коробки, а столбы с блоками
        var core = fit ? ST_CORE[z.id] : null
        if (core) {
            var fx1 = cx - Math.floor(fit.size[0] / 2), fz1 = cz - Math.floor(fit.size[2] / 2)
            if (fx1 > core.x2 || fx1 + fit.size[0] - 1 < core.x1 || fz1 > core.z2 || fz1 + fit.size[2] - 1 < core.z1) continue
            for (var ri = 0; ri < fit.rel.length; ri++) {
                if (core.near[(fx1 + fit.rel[ri][0]) + "," + (fz1 + fit.rel[ri][1])]) return true
            }
            continue
        }
        var b = z.box
        if (cx + half < b.x1 - 1 || cx - half > b.x2 + 1) continue
        if (cz + half < b.z1 - 1 || cz - half > b.z2 + 1) continue
        ST_CLASH = lab + " " + z.id + " (" + b.x1 + " " + b.z1 + " - " + b.x2 + " " + b.z2 + ")"
        return true
    }
    return false
}

// ─── Тесная застройка ────────────────────────────────────────────────────────
//
// Зоны соседних построек (коробка с запасом под крыльцо и откат) могут налезать друг на
// друга - не могут только сами блоки. Для построек, поставленных с запуска сервера, помним
// столбы, где стоят их блоки: по ним проверяем место, и земляные работы соседа их не трогают.

const ST_GAP = 1                        // столько пустых клеток между стенами соседей
var ST_CORE = {}                        // id зоны -> { dim, cols, near, x1, z1, x2, z2 }

/** Столбы с блоками шаблона после поворота, от угла коробки. */
function stRelCols(cells, tpl, steps) {
    var seen = {}, list = []
    cells.forEach(c => {
        if (!c.state) return
        var rp = stRotatePos(c.x, c.z, tpl.size[0], tpl.size[2], steps)
        var k = rp[0] + "," + rp[1]
        if (seen[k]) return
        seen[k] = 1
        list.push(rp)
    })
    return list
}

/** mask - пятно постройки в мировых клетках "x,z": стены и замкнутый ими двор. */
function stRegisterCore(zoneId, box, mask) {
    var cols = {}, near = {}
    Object.keys(mask).forEach(k => {
        var p = k.split(","), x = Number(p[0]), z = Number(p[1])
        cols[k] = 1
        for (var dx = -ST_GAP; dx <= ST_GAP; dx++)
            for (var dz = -ST_GAP; dz <= ST_GAP; dz++) near[(x + dx) + "," + (z + dz)] = 1
    })
    ST_CORE[zoneId] = {
        dim: box.dim, cols: cols, near: near,
        x1: box.x1 - ST_GAP, z1: box.z1 - ST_GAP, x2: box.x2 + ST_GAP, z2: box.z2 + ST_GAP,
    }
}

/** Чужие столбы с блоками в прямоугольнике: туда наши команды не лезут. */
function stGuardCols(dim, ownZone, x1, z1, x2, z2) {
    var cols = {}, n = 0
    for (var id in ST_CORE) {
        if (id === ownZone) continue
        // постройки уже нет (снесена, откачена) - её стены больше не берегут: иначе при
        // пересборке поселения новые дома обрезались по контурам старых
        try { if (!global.TFG_ZONES.get(id)) { delete ST_CORE[id]; continue } } catch (e) { }
        var c = ST_CORE[id]
        if (c.dim !== dim || c.x1 > x2 || c.x2 < x1 || c.z1 > z2 || c.z2 < z1) continue
        for (var k in c.cols) { cols[k] = 1; n++ }
    }
    return { cols: cols, n: n }
}

const ST_CMD_XZ = /run (?:setblock|fill) (-?\d+) -?\d+ (-?\d+)(?: (-?\d+) -?\d+ (-?\d+))?/

/** Убрать команды, задевающие чужие столбы: стена соседа остаётся целой. */
function stKeepOff(list, guard) {
    if (!guard.n) return list
    return list.filter(c => {
        if (typeof c !== "string") return true
        var m = c.match(ST_CMD_XZ)
        if (!m) return true
        var ax = Number(m[1]), az = Number(m[2])
        // пустая группа в Rhino бывает и "", и undefined - проверяем на непустую строку
        var bx = m[3] ? Number(m[3]) : ax, bz = m[4] ? Number(m[4]) : az
        for (var x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
            for (var z = Math.min(az, bz); z <= Math.max(az, bz); z++)
                if (guard.cols[x + "," + z]) return false
        return true
    })
}

/** Годится ли место: без воды, без чужих построек, перепад умеренный. */
var ST_WHY = {}                         // почему отвергнуты места (на один поиск)
var ST_CLASH = ""                       // последняя зона, на которую налетело место

function stSpotOk(level, cx, cz, half, maxDrop, fit) {
    var no = w => { ST_WHY[w] = (ST_WHY[w] || 0) + 1; return false }
    if (stZoneClash(level, cx, cz, half, fit)) return no("занято")
    var base = stTop(level, cx, cz)
    var bad = 0, total = 0, lo = 1e9, hi = -1e9
    for (var x = cx - half; x <= cx + half; x += 2) {
        for (var z = cz - half; z <= cz + half; z += 2) {
            total++
            var t = stTop(level, x, z)
            if (t < lo) lo = t
            if (t > hi) hi = t
            if (Math.abs(t - base) > maxDrop) bad++
            var id = ""
            try { id = String(level.getBlock(x, t, z).id) } catch (e) { }
            if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0) return no("вода")
            // саман засыпанной воды (tfc:mud_bricks) - грунт поселения, а не чужая кладка
            if (id.indexOf("planks") >= 0 || (id.indexOf("brick") >= 0 && id.indexOf("mud_bricks") < 0) || id.indexOf("chest") >= 0) return no("кладка")
        }
    }
    // Обрыв, русло или скальный склон: ровнять такое нельзя - дом окажется в котловане
    // или на постаменте, и тропа к нему не ляжет. Лучше не строить здесь вовсе.
    if (hi - lo > ST_MAX_RANGE) return no("обрыв")
    return bad <= total * 0.25 ? true : no("криво")
}

/**
 * veto - проверка вызывающего: например, улица не пускает дом на полотно дороги.
 * Четвёртым аргументом veto получает hits(x, z): стоит ли в этом столбе блок постройки.
 */
function stFindSpot(level, cx, cz, half, maxR, veto, fit, drop) {
    var hitsAt = (x, z) => (wx, wz) => !!(fit && fit.relSet[(Math.round(wx) - (x - Math.floor(fit.size[0] / 2))) + "," +
        (Math.round(wz) - (z - Math.floor(fit.size[2] / 2)))])
    var ok = (x, z) => stSpotOk(level, x, z, half, drop || 3, fit) && !(veto && veto(x, z, half, hitsAt(x, z)))
    ST_WHY = {}
    if (ok(cx, cz)) return { x: cx, z: cz }
    var limit = maxR || 80
    for (var r = 4; r <= limit; r += 4) {
        for (var a = 0; a < 12; a++) {
            var ang = a * 0.5235987755982988 + Math.random() * 0.3
            var x = Math.floor(cx + Math.cos(ang) * r), z = Math.floor(cz + Math.sin(ang) * r)
            if (ok(x, z)) return { x: x, z: z }
        }
    }
    stLog("место не нашлось у " + cx + " " + cz + " (радиус " + limit + "): " + Object.keys(ST_WHY).map(k => k + " " + ST_WHY[k]).join(", "))
    return null
}

/**
 * Пятно постройки: клетки, где стоят её блоки, плюс всё, что ими замкнуто (двор внутри стен).
 * Землю ровняем строго по этому пятну - вокруг рельеф остаётся каким был.
 */
function stFootprint(cells, box, steps, tpl) {
    var mask = {}, solid = {}
    cells.forEach(c => {
        if (!c.state) return
        var rp = stRotatePos(c.x, c.z, tpl.size[0], tpl.size[2], steps)
        var mk = (box.x1 + rp[0]) + "," + (box.z1 + rp[1])
        mask[mk] = 1
        solid[mk] = 1                                  // здесь стоит сама постройка
    })
    // всё, что не достаётся снаружи, считаем внутренним двором постройки
    var outside = {}, stack = []
    for (var x = box.x1 - 1; x <= box.x2 + 1; x++) {
        stack.push([x, box.z1 - 1]); stack.push([x, box.z2 + 1])
    }
    for (var z = box.z1 - 1; z <= box.z2 + 1; z++) {
        stack.push([box.x1 - 1, z]); stack.push([box.x2 + 1, z])
    }
    while (stack.length) {
        var c2 = stack.pop()
        var k = c2[0] + "," + c2[1]
        if (outside[k] || mask[k]) continue
        if (c2[0] < box.x1 - 1 || c2[0] > box.x2 + 1 || c2[1] < box.z1 - 1 || c2[1] > box.z2 + 1) continue
        outside[k] = 1
        stack.push([c2[0] + 1, c2[1]]); stack.push([c2[0] - 1, c2[1]])
        stack.push([c2[0], c2[1] + 1]); stack.push([c2[0], c2[1] - 1])
    }
    for (var bx = box.x1; bx <= box.x2; bx++) {
        for (var bz = box.z1; bz <= box.z2; bz++) {
            var kk = bx + "," + bz
            if (!outside[kk]) mask[kk] = 1             // замкнутый двор тоже часть пятна
        }
    }
    return { mask: mask, solid: solid }
}

/**
 * Ровное основание строго под постройкой: обкапываем её фундамент, а лужайку вокруг не трогаем.
 * Раньше выравнивалась вся коробка с полосой сглаживания - вокруг дома получался стадион.
 */
function stShapeGround(z, level, box, base, mask, solid, flatSet, entryLevel) {
    var cmds = []
    // Воротник снаружи: две клетки вокруг пятна подводим к подошве, иначе у стен
    // остаётся ступень вниз и постройка выглядит стоящей во рву.
    var collar = 2
    for (var cx3 = box.x1 - collar; cx3 <= box.x2 + collar; cx3++) {
        for (var cz3 = box.z1 - collar; cz3 <= box.z2 + collar; cz3++) {
            if (cx3 >= box.x1 && cx3 <= box.x2 && cz3 >= box.z1 && cz3 <= box.z2) continue
            if (mask && !mask[Math.max(box.x1, Math.min(box.x2, cx3)) + "," +
                Math.max(box.z1, Math.min(box.z2, cz3))]) continue        // только у занятых краёв
            var ct = stTop(level, cx3, cz3)
            var want3 = base + 1
            if (Math.abs(ct - want3) > 3) continue                        // настоящий склон не трогаем
            if (ct === want3) continue
            var surf3 = "tfc:dirt/loam"
            try { surf3 = String(level.getBlock(cx3, ct, cz3).id) } catch (e) { }
            if (surf3.indexOf("water") >= 0 || surf3.indexOf("lava") >= 0) continue
            if (ct > want3) {
                cmds.push("execute in " + z.dim + " run fill " + cx3 + " " + (want3 + 1) + " " + cz3 + " " +
                    cx3 + " " + ct + " " + cz3 + " minecraft:air replace")
                cmds.push("execute in " + z.dim + " run setblock " + cx3 + " " + want3 + " " + cz3 + " " + surf3 + " replace")
            } else {
                var g3 = stGroundState(level, cx3, cz3)
                cmds.push("execute in " + z.dim + " run fill " + cx3 + " " + (ct + 1) + " " + cz3 + " " +
                    cx3 + " " + (want3 - 1) + " " + cz3 + " " + g3 + " replace")
                cmds.push("execute in " + z.dim + " run setblock " + cx3 + " " + want3 + " " + cz3 + " " + surf3 + " replace")
            }
        }
    }
    for (var x = box.x1; x <= box.x2; x++) {
        for (var zz = box.z1; zz <= box.z2; zz++) {
            var mk2 = x + "," + zz
            if (mask && !mask[mk2]) continue                 // за пределами пятна рельеф остаётся свой
            var top = stTop(level, x, zz)
            var want = base
            // Двор внутри стен выглаживаем, но не в стекло: лёгкая неровность остаётся.
            // ВАЖНО: не ниже подошвы построек (base + 1), иначе вдоль стен получается ров.
            if (solid && !solid[mk2]) want = Math.max(base + 1, Math.min(base + 2, top))
            // а у самого входа - строго ровно, на уровне порога
            if (flatSet && flatSet[mk2] && !(solid && solid[mk2])) want = entryLevel
            if (want === top) continue
            var surf = "tfc:dirt/loam"
            try { surf = String(level.getBlock(x, top, zz).id) } catch (e) { }
            if (surf.indexOf("water") >= 0 || surf.indexOf("lava") >= 0) continue
            if (want < top) {
                cmds.push("execute in " + z.dim + " run fill " + x + " " + (want + 1) + " " + zz + " " +
                    x + " " + top + " " + zz + " minecraft:air replace")
                cmds.push("execute in " + z.dim + " run setblock " + x + " " + want + " " + zz + " " + surf + " replace")
            } else {
                var ground = stGroundState(level, x, zz)
                cmds.push("execute in " + z.dim + " run fill " + x + " " + (top + 1) + " " + zz + " " +
                    x + " " + (want - 1) + " " + zz + " " + ground + " replace")
                cmds.push("execute in " + z.dim + " run setblock " + x + " " + want + " " + zz + " " + surf + " replace")
            }
        }
    }
    return cmds
}

// ─── Наполнение ──────────────────────────────────────────────────────────────

const ST_JARS = ["firmalife:jar/honey", "firmalife:jar/fig", "firmalife:jar/red_grapes",
    "firmalife:jar/white_grapes", "firmalife:jar/pineapple", "firmalife:empty_jar_with_stainless_steel_lid", "", ""]
const ST_FOOD = ["tfc:food/wheat_bread", "tfc:food/rye_bread", "@сыр", "tfc:food/cooked_beef",
    "tfc:food/cooked_mutton", "tfc:food/carrot", "tfc:food/potato", "tfc:food/dried_seaweed"]
const ST_KITCHEN = ["tfc:ceramic/bowl", "tfc:ceramic/jug", "tfc:ceramic/vessel", "tfc:powder/salt",
    "@нож", "@нож", "tfc:food/wheat_bread", "@сыр"]
// цвета обожжённых сосудов: в постройке они должны быть разными
const ST_VESSEL_COLORS = ["", "black", "blue", "brown", "cyan", "gray", "green", "light_blue", "light_gray",
    "lime", "magenta", "orange", "pink", "purple", "red", "white", "yellow"]
const ST_GT_MATERIALS = ["Bronze", "Steel", "WroughtIron", "Iron"]
// сыр в сборке именной: чеддер, шевр, фета, гауда, шоша, раджья-метокя, творог
const ST_CHEESE = ["firmalife:food/cheddar", "firmalife:food/chevre", "firmalife:food/feta", "firmalife:food/gouda",
    "firmalife:food/shosha", "firmalife:food/rajya_metok", "firmalife:food/goat_curd", "firmalife:food/yak_curd"]
// на винной полке стоят бутылки, а не вёдра
const ST_WINE = ["firmalife:hematitic_wine_bottle", "firmalife:olivine_wine_bottle", "firmalife:volcanic_wine_bottle",
    "firmalife:empty_hematitic_wine_bottle", "firmalife:empty_olivine_wine_bottle", ""]
const ST_TOOLS = ["@кувалда", "@напильник", "@пила", "@топор", "@лопата", "@нож", "@нож_мясника",
    "@кирка", "@ключ", "@отвёртка", "@лом", "@кусачки"]
const ST_METALS = ["bronze", "wrought_iron", "steel", "black_steel"]
// оружие манекенов: меч и топор берём из GregTech, булава и дротик есть только у TFC
const ST_WEAPONS = ["@меч", "@меч", "tfc:metal/mace/{m}", "tfc:metal/javelin/{m}", "@топор"]
// стволы берём из таблицы сборки (guns_data.js): что не стоит ганпаком, того и не кладём
function stGunPool(heavy) {
    var out = []
    try {
        for (var id in global.TFG_GUNS) {
            if (heavy || global.TFG_GUNS[id][1]) out.push(id)
        }
    } catch (e) { }
    return out
}

// хозяйские расходники: прихожая, столовая, мастерская
const ST_HOUSEHOLD = ["gtceu:fertilizer", "tfc:burlap_cloth", "tfc:wool_cloth", "tfc:wool_yarn",
    "tfc:jute_fiber", "tfc:wood/lumber/{w}", "tfc:wood/lumber/oak", "@слиток", "@пластина",
    "@пруток", "tfc:glue", "@болт", "@болт",
    "tfc:ceramic/jug", "tfc:ceramic/bowl", "tfc:torch", "tfc:powder/flux"]
// личные вещи: покои и кабинет
const ST_PERSONAL = ["minecraft:book", "minecraft:paper", "@самоцвет", "@самоцвет", "@слиток",
    "@слиток", "@нож",
    "tfc:candle", "tfc:silk_cloth", "@напильник", "tfc:ceramic/vessel", "@сыр"]
// большой склад особняка, большого дома и форта
const ST_STORE = ["@слиток", "@слиток", "@пластина", "@пруток", "@болт", "@ремнабор",
    "tfc:powder/flux", "tfc:wood/lumber/{w}", "tfc:straw", "tfc:burlap_cloth", "tfc:glue",
    "tfc:ceramic/vessel", "tfc:powder/salt", "@кувалда", "@пила"]

// чем живёт хозяин дома: это видно по содержимому сундуков и полок
const ST_TRADES = {
    "портной": ["tfc:burlap_cloth", "tfc:wool_cloth", "tfc:silk_cloth", "tfc:wool_yarn", "tfc:jute_fiber",
        "tfc:spindle", "tfc:bone_needle", "tfc:wool", "tfc_textile:cotton_shirt", "tfc_textile:linen_shirt",
        "tfc:powder/lapis_lazuli", "tfc:powder/hematite"],
    "мясник": ["@нож_мясника", "@нож_мясника", "tfc:powder/salt", "tfc:food/cooked_beef", "tfc:food/cooked_mutton",
        "tfc:food/cooked_pork", "tfc:large_raw_hide", "tfc:medium_raw_hide", "tfc:ceramic/bowl", "@сыр"],
    "оружейник": ["@слиток", "@слиток", "@пластина",
        "@ремнабор", "tfc:metal/javelin/bronze", "@меч",
        "@нож", "tfc:powder/flux", "@кувалда", "@напильник", "@болт"],
    "крестьянин": ["gtceu:fertilizer", "tfc:seeds/wheat", "tfc:seeds/barley", "tfc:seeds/carrot",
        "tfc:food/wheat_grain", "tfc:food/potato", "tfc:food/carrot", "tfc:jute", "tfc:straw",
        "@мотыга", "@коса", "@лопата", "tfc:wood/lumber/{w}"],
}

// обычная одежда для манекена в жилом доме
/**
 * Комплекты одежды. Собирать идентификатор из частей нельзя: у хлопка и льна обувь
 * называется socks, а шерстяные вещи живут вообще в другом моде.
 * Порядок частей - как в ArmorItems: ноги, штаны, торс, голова.
 */
const ST_OUTFITS = [
    ["tfc_textile:cotton_socks", "tfc_textile:cotton_pants", "tfc_textile:cotton_shirt", "tfc_textile:cotton_hat"],
    ["tfc_textile:linen_socks", "tfc_textile:linen_pants", "tfc_textile:linen_shirt", "tfc_textile:linen_hat"],
    ["tfcambiental:wool_boots", "tfcambiental:wool_pants", "tfcambiental:wool_sweater", "tfcambiental:wool_hat"],
    ["tfc_textile:caribou_boots", "tfc_textile:caribou_pants", "tfc_textile:caribou_shirt", "tfc_textile:caribou_hat"],
    ["tfc_textile:black_bear_boots", "tfc_textile:black_bear_pants", "tfc_textile:black_bear_shirt", "tfc_textile:black_bear_hat"],
]

var ST_GTToolType = null, ST_GTMaterials = null
const ST_GT_MAT_IDS = { Bronze: "bronze", Steel: "steel", WroughtIron: "wrought_iron", Iron: "iron" }

/**
 * Инструменты сборки. Всё, у чего в GregTech есть собственный аналог, кладём именно из GregTech:
 * у TFC свои ножи, пилы и кувалды, и вперемешку они выглядят как мусор из другой сборки.
 * Слева - метка в списках, справа - тип GTToolType и запасной идентификатор предмета.
 */
const ST_GT_TOOLS = {
    "@нож": ["KNIFE", "knife"],
    "@нож_мясника": ["BUTCHERY_KNIFE", "butchery_knife"],
    "@кувалда": ["HARD_HAMMER", "hammer"],
    "@пила": ["SAW", "saw"],
    "@топор": ["AXE", "axe"],
    "@лопата": ["SHOVEL", "shovel"],
    "@кирка": ["PICKAXE", "pickaxe"],
    "@мотыга": ["HOE", "hoe"],
    "@коса": ["SCYTHE", "scythe"],
    "@меч": ["SWORD", "sword"],
    "@напильник": ["FILE", "file"],
    "@отвёртка": ["SCREWDRIVER", "screwdriver"],
    "@ключ": ["WRENCH", "wrench"],
    "@лом": ["CROWBAR", "crowbar"],
    "@ступка": ["MORTAR", "mortar"],
    "@кусачки": ["WIRE_CUTTER", "wire_cutter"],
}
// на что откатываемся, если GregTech почему-то не отдал инструмент
const ST_TFC_FALLBACK = {
    "@нож": "tfc:metal/knife/", "@нож_мясника": "tfc:metal/knife/", "@кувалда": "tfc:metal/hammer/",
    "@пила": "tfc:metal/saw/", "@топор": "tfc:metal/axe/", "@лопата": "tfc:metal/shovel/",
    "@кирка": "tfc:metal/pickaxe/", "@мотыга": "tfc:metal/hoe/", "@коса": "tfc:metal/scythe/",
    "@меч": "tfc:metal/sword/", "@напильник": "tfc:metal/chisel/", "@отвёртка": "tfc:metal/chisel/",
    "@ключ": "tfc:metal/hammer/", "@лом": "tfc:metal/hammer/", "@ступка": "tfc:metal/hammer/",
    "@кусачки": "tfc:metal/knife/",
}

/**
 * Инструмент сборки. У GregTech это один предмет с материалом в NBT (ключ GT.Tool/Material),
 * поэтому пробуем по очереди: штатный ToolHelper, потом прямую сборку предмета.
 */
function stGtTool(kind) {
    var pair = ST_GT_TOOLS[kind] || ST_GT_TOOLS["@нож"]
    var typeName = pair[0], name = pair[1]
    var matKey = stPick(ST_GT_MATERIALS)
    try {
        if (!ST_GTToolType) ST_GTToolType = Java.loadClass("com.gregtechceu.gtceu.api.item.tool.GTToolType")
        if (!ST_GTMaterials) ST_GTMaterials = Java.loadClass("com.gregtechceu.gtceu.common.data.GTMaterials")
        var type = ST_GTToolType[typeName]
        if (type) {
            var stack = ToolHelper.get(type, ST_GTMaterials[matKey])
            if (stack && !stack.isEmpty()) return stack
        }
    } catch (e) { stErr("ToolHelper " + kind, e) }
    var matId = ST_GT_MAT_IDS[matKey] || "steel"
    var nbt = '{"GT.Tool":{Material:"' + matId + '"}}'
    var ids = ["gtceu:tools/" + name, "gtceu:" + name, "gtceu:" + matId + "_" + name]
    for (var i = 0; i < ids.length; i++) {
        try {
            var it = Item.of(ids[i], 1, nbt)
            if (it && !it.isEmpty()) return it
        } catch (e2) { }
    }
    // TFC-инструменты в сборке отключены, подменять ими нечего: лучше пусто, чем чужое
    if (!ST_MISSING["@" + kind]) {
        ST_MISSING["@" + kind] = true
        stLog("инструмент " + kind + " не собрался - оставляю ячейку пустой")
    }
    return null
}

// ─── Что в сборке есть, а чего нет ───────────────────────────────────────────

// На складах лежит то, чем живёт TFG. Достаток поселения решает, что именно:
// у бедных - бронза и сталь, у зажиточных - золото и алюминий.
const ST_WEALTH_METALS = [
    ["Bronze", "Steel", "WroughtIron"],
    ["Steel", "BlackBronze", "Gold"],
    ["Gold", "Aluminium", "BlackBronze", "Steel"],
]
var ST_WEALTH = 1
const ST_STOCK_METALS = ST_WEALTH_METALS[1]

/** Чем богата округа: список материалов для складов этой постройки. */
function stStock() {
    return ST_WEALTH_METALS[Math.max(0, Math.min(2, ST_WEALTH))] || ST_STOCK_METALS
}
// самоцвет TFC -> материал GregTech
const ST_GEM_MATS = {
    amethyst: "Amethyst", diamond: "Diamond", emerald: "Emerald", ruby: "Ruby", sapphire: "Sapphire",
    topaz: "Topaz", opal: "Opal", pyrite: "Pyrite", lapis_lazuli: "Lapis",
}
var ST_TagPrefixCls = null
var ST_EXISTS = {}

/** Отключён ли предмет в сборке (список снят со стартовых скриптов, см. items_data.js). */
function stDisabled(id) {
    try { return !!(global.TFG_DISABLED && global.TFG_DISABLED[id]) } catch (e) { return false }
}

/**
 * Живой ли предмет: не вычеркнут из TFG и вообще зарегистрирован.
 * Ответ кэшируем - проверка идёт на каждый предмет каждой постройки.
 */
function stExists(id) {
    if (ST_EXISTS[id] !== undefined) return ST_EXISTS[id]
    var ok = false
    if (!stDisabled(id)) {
        try {
            var it = Item.of(id)
            ok = !!(it && !it.isEmpty())
        } catch (e) { ok = false }
    }
    ST_EXISTS[id] = ok
    return ok
}

/** Предмет-материал GregTech: слиток, пластина, пруток, самоцвет. */
function stGtMaterial(prefixName, matKey, count) {
    try {
        if (!ST_GTMaterials) ST_GTMaterials = Java.loadClass("com.gregtechceu.gtceu.common.data.GTMaterials")
        if (!ST_TagPrefixCls) ST_TagPrefixCls = Java.loadClass("com.gregtechceu.gtceu.api.data.tag.TagPrefix")
        var mat = ST_GTMaterials[matKey]
        var prefix = ST_TagPrefixCls[prefixName]
        if (!mat || !prefix) return null
        var stack = ChemicalHelper.get(prefix, mat, count || 1)
        if (stack && !stack.isEmpty()) return stack
    } catch (e) { stErr("материал " + prefixName + " " + matKey, e) }
    return null
}

/**
 * Замена вычеркнутому из сборки предмету. В TFG слитки, пластины, прутки, самоцветы и
 * инструменты - гретеховские; TFC-шные остались только как модели и в мир попадать не должны.
 */
function stSwap(id, count) {
    var m
    m = id.match(/^tfc:metal\/(double_)?ingot\/(.+)$/)
    if (m) return stGtMaterial("ingot", stPick(stStock()), (count || 1) * (m[1] ? 2 : 1))
    m = id.match(/^tfc:metal\/(double_)?sheet\/(.+)$/)
    if (m) return stGtMaterial("plate", stPick(stStock()), (count || 1) * (m[1] ? 2 : 1))
    if (/^tfc:metal\/rod\//.test(id)) return stGtMaterial("rod", stPick(stStock()), count || 2)
    m = id.match(/^tfc:gem\/(.+)$/)
    if (m && ST_GEM_MATS[m[1]]) return stGtMaterial("gem", ST_GEM_MATS[m[1]], count || 1)
    m = id.match(/^tfc:metal\/(knife|hammer|saw|axe|shovel|hoe|scythe|sword|pickaxe)\//)
    if (m) {
        var byTool = { knife: "@нож", hammer: "@кувалда", saw: "@пила", axe: "@топор", shovel: "@лопата",
            hoe: "@мотыга", scythe: "@коса", sword: "@меч", pickaxe: "@кирка" }
        return stGtTool(byTool[m[1]])
    }
    return null
}

/** Болт сборки: GregTech отдаёт его через ChemicalHelper. */
function stGtBolt() {
    try {
        if (!ST_GTMaterials) ST_GTMaterials = Java.loadClass("com.gregtechceu.gtceu.common.data.GTMaterials")
        var TagPrefixCls = Java.loadClass("com.gregtechceu.gtceu.api.data.tag.TagPrefix")
        var mat = ST_GTMaterials[stPick(ST_GT_MATERIALS)]
        var stack = ChemicalHelper.get(TagPrefixCls.bolt, mat, 4 + Math.floor(Math.random() * 12))
        if (stack && !stack.isEmpty()) return stack
    } catch (e) { stErr("болт сборки", e) }
    return Item.of("tfc:metal/rod/" + stPick(["bronze", "wrought_iron"]), 2)
}

/**
 * Готовый стек предмета. Метки со собакой разворачиваются в предметы сборки, а обычный
 * идентификатор перед выдачей проверяется: вычеркнутому из TFG ищем замену, ненайденному -
 * отказываем. Иначе в ящиках оказываются вещи, которых в сборке нет.
 */
function stItem(id, count, nbt) {
    if (!id) return null
    try {
        if (id === "@сыр") return stItem(stPick(ST_CHEESE), count || 1)
        // вместо пустой книги - книга библиотеки мира (books.js); народ хозяев при стройке не известен - общая
        if (id === "minecraft:book" && global.TFG_BOOKS) { var lb = global.TFG_BOOKS.shelfBook(null); if (lb) return lb }
        if (id === "@болт") return stGtBolt()
        if (id === "@слиток") return stGtMaterial("ingot", stPick(stStock()), count || 1)
        if (id === "@пластина") return stGtMaterial("plate", stPick(stStock()), count || 1)
        if (id === "@пруток") return stGtMaterial("rod", stPick(stStock()), count || 2)
        if (id === "@самоцвет") return stGtMaterial("gem", stPick(["Amethyst", "Ruby", "Sapphire", "Topaz", "Opal"]), count || 1)
        if (id === "@ремнабор") return stRepairKit(null)
        if (id === "@патроны") return stAmmoItem()
        if (id === "@ствол") return stGunItem()
        if (id.charAt(0) === "@") return stGtTool(id)
        if (id.indexOf("large_vessel") >= 0) {
            var c = stPick(ST_VESSEL_COLORS)
            id = c ? "tfc:ceramic/large_vessel/" + c : "tfc:ceramic/large_vessel"
        }
        if (!stExists(id)) {
            var sub = stSwap(id, count)
            if (sub) return sub
            if (!ST_MISSING[id]) {
                ST_MISSING[id] = true
                stLog("в сборке нет " + id + " и замены не нашлось - пропускаю")
            }
            return null
        }
        return nbt ? Item.of(id, count || 1, nbt) : Item.of(id, count || 1)
    } catch (e) {
        stErr("предмет " + id, e)
        return null
    }
}

const ST_LAMP_FUEL = 250                // столько лавы вливаем в фонарь - ровно бак TFC (lampCapacity)

// ─── Запрещатор угасания ─────────────────────────────────────────────────────
//
// Синестальный фонарь с лавой по правилам TFC горит вечно, но в поселениях они всё равно
// гаснут через несколько секунд - что их гасит, по исходникам не видно. Поэтому каждый
// фонарь, который зажгли постройка или пересветка поселения, берётся под охрану: раз в
// ST_LAMP_GUARD_EVERY тиков охраняемые фонари рядом с игроками проверяются, и погасший
// зажигается и заправляется заново. Сколько раз пришлось - пишем в лог: по этим строкам
// видно, как часто их гасят.

const ST_LAMP_GUARD_EVERY = 100         // раз в пять секунд
const ST_LAMP_GUARD_R = 160             // дальше этого от игрока не проверяем
var ST_LAMP_GUARD = {}                  // "dim|x|y|z" -> { dim, x, y, z }
var ST_LAMP_RELIT = 0                   // сколько раз зажгли заново с запуска
var ST_LAMP_RELIT_TOLD = 0

function stGuardLamp(dim, x, y, z) {
    ST_LAMP_GUARD[dim + "|" + x + "|" + y + "|" + z] = { dim: dim, x: x, y: y, z: z }
}

function stLampGuardTick(server) {
    var near = []
    server.players.forEach(p => near.push({ dim: String(p.level.getDimension()), x: p.getX(), z: p.getZ() }))
    if (!near.length) return
    var relit = 0
    for (var key in ST_LAMP_GUARD) {
        var l = ST_LAMP_GUARD[key]
        if (!near.some(p => p.dim === l.dim && Math.pow(p.x - l.x, 2) + Math.pow(p.z - l.z, 2) < ST_LAMP_GUARD_R * ST_LAMP_GUARD_R)) continue
        var level = null
        try { level = server.getLevel(l.dim) } catch (e) { }
        if (!level) continue
        try { if (!level.hasChunk(l.x >> 4, l.z >> 4)) continue } catch (e) { continue }
        var state = ""
        try { state = String(level.getBlock(l.x, l.y, l.z).getBlockState()) } catch (e) { continue }
        if (state.indexOf("/lamp/") < 0) { delete ST_LAMP_GUARD[key]; continue }      // фонаря больше нет
        // погасший - зажечь; горящий с пустым баком (так бывает после пересборки) - долить
        if (state.indexOf("lit=false") < 0 && stTankAmount(level, l.x, l.y, l.z) > 0) continue
        if (stLightLamp(level, l.x, l.y, l.z)) relit++
    }
    if (relit) {
        ST_LAMP_RELIT += relit
        if (ST_LAMP_RELIT - ST_LAMP_RELIT_TOLD >= 20 || !ST_LAMP_RELIT_TOLD) {
            stLog("запрещатор: зажгли заново фонарей " + relit + " (всего с запуска " + ST_LAMP_RELIT + ")")
            ST_LAMP_RELIT_TOLD = ST_LAMP_RELIT
        }
    }
}

ServerEvents.tick(event => {
    if (event.server.tickCount % ST_LAMP_GUARD_EVERY !== 0) return
    try { stLampGuardTick(event.server) } catch (e) { stErr("запрещатор фонарей", e) }
})

var ST_MISSING = {}

const ST_ItemHandlerCap = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").ITEM_HANDLER
const ST_FluidHandlerCap = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").FLUID_HANDLER

/**
 * Фонарь из синей стали горит только с топливом: внутрь льют лаву и поджигают факелом.
 * Ставим дом уже обжитым - заливаем бак фонаря лавой и зажигаем.
 */
var ST_FluidStack = null
var ST_FluidAction = null
// ST_CompoundTag объявлен ниже, у кладки слитков: второе объявление Rhino считает
// ошибкой и роняет весь файл - из-за этого однажды пропали все шаблоны построек.
var ST_LAMP_TOLD = 0

/**
 * Сколько жидкости в баке блока. Сперва спрашиваем сам бак через способность Forge -
 * это единственный честный ответ; NBT читаем только как запасной путь.
 */
function stTankAmount(level, x, y, z) {
    try {
        var be = level.getBlock(x, y, z).getEntity()
        if (be) {
            var cap = be.getCapability(ST_FluidHandlerCap).resolve()
            if (cap.isPresent()) {
                var tank = cap.get()
                var n = Number(tank.getFluidInTank(0).getAmount())
                if (isFinite(n)) return n
            }
        }
    } catch (e) { }
    try {
        var data = level.getBlock(x, y, z).entityData
        if (!data) return 0
        var m = String(data).match(/Amount:\s*(\d+)/)
        return m ? Number(m[1]) : 0
    } catch (e) { return 0 }
}

/**
 * Бак, залитый через способность Forge, сам чанк изменённым не помечает: при выгрузке
 * чанка лава не сохранялась, и фонарь возвращался пустым. Помечаем явно.
 */
function stLampDirty(level, x, y, z) {
    try {
        var be = level.getBlock(x, y, z).getEntity()
        if (!be) return
        if (typeof be.setChanged === "function") be.setChanged()
        else if (typeof be.m_6596_ === "function") be.m_6596_()
        if (typeof be.markForSync === "function") be.markForSync()
    } catch (e) { }
}

/** Лава как FluidStack. Через NBT, потому что прямой конструктор Rhino выбрать не может. */
function stLava(amount) {
    if (!ST_FluidStack) ST_FluidStack = Java.loadClass("net.minecraftforge.fluids.FluidStack")
    if (!ST_CompoundTag) ST_CompoundTag = Java.loadClass("net.minecraft.nbt.CompoundTag")
    var tag = new ST_CompoundTag()
    tag.putString("FluidName", "minecraft:lava")
    tag.putInt("Amount", amount)
    return ST_FluidStack.loadFluidStackFromNBT(tag)
}

/**
 * Зажечь фонарь навсегда.
 *
 * Порядок здесь важнее всего остального. setblock заводит НОВУЮ блок-сущность, а с ней
 * пустой бак; TFC гасит горящий фонарь с пустым баком на первом же случайном тике и больше
 * не зажигает - топливо считается негодным. Поэтому: сперва лава в бак, потом огонь, и
 * состояние меняем через set (блок тот же - бак уцелеет), а не через setblock.
 * После каждого шага проверяем по NBT, а не по коду возврата команды.
 */
function stLightLamp(level, x, y, z) {
    var dim = String(level.getDimension())
    var block = null, state = ""
    try {
        block = level.getBlock(x, y, z)
        state = String(block.getBlockState())
    } catch (e) { return false }
    if (state.indexOf("/lamp/") < 0) return false
    stGuardLamp(dim, x, y, z)

    // 1. Лава: сперва через способность Forge, если не вышло - командой.
    var amount = stTankAmount(level, x, y, z)
    if (amount <= 0) {
        try {
            if (!ST_FluidAction) ST_FluidAction = Java.loadClass("net.minecraftforge.fluids.capability.IFluidHandler$FluidAction")
            var be = block.getEntity()
            var cap = be.getCapability(ST_FluidHandlerCap).resolve()
            if (cap.isPresent()) cap.get().fill(stLava(ST_LAMP_FUEL), ST_FluidAction.EXECUTE)
        } catch (e) { }
        stLampDirty(level, x, y, z)
        amount = stTankAmount(level, x, y, z)
    }
    if (amount <= 0) {
        stRun("execute in " + dim + " run data merge block " + x + " " + y + " " + z +
            " {tank:{FluidName:\"minecraft:lava\",Amount:" + ST_LAMP_FUEL + "}}")
        amount = stTankAmount(level, x, y, z)
    }

    // 2. Огонь. Заливка могла не пройти (бак чужого мода, запрет на способность) -
    // всё равно зажигаем: тёмный фонарь не станет ярче от нашей осторожности,
    // а поселение потом пересветит себя само (см. присмотр в factions/settlers.js).
    if (state.indexOf("lit=false") >= 0) {
        var id = state.split("{")[1]
        id = id ? id.split("}")[0] : "tfc:metal/lamp/blue_steel"
        var props = { lit: "true" }
        var hang = state.match(/hanging=(true|false)/)
        if (hang) props.hanging = hang[1]
        try { block.set(id, props) } catch (e) { stErr("зажигание фонаря", e) }
        stLampDirty(level, x, y, z)
    }

    // 3. Правду говорим по факту: что в баке и горит ли.
    var after = stTankAmount(level, x, y, z)
    var lit = false
    try { lit = String(level.getBlock(x, y, z).getBlockState()).indexOf("lit=true") >= 0 } catch (e) { }
    if ((!after || !lit) && ST_LAMP_TOLD < 3) {
        ST_LAMP_TOLD++
        var raw = ""
        try { raw = String(level.getBlock(x, y, z).entityData) } catch (e) { }
        stErr("фонарь " + x + " " + y + " " + z, "в баке " + after + ", горит " + lit + ", NBT " + raw)
    }
    return after > 0 && lit
}

/** Инвентарь блока: приватное поле TFC, способность Forge или KubeJS - что первым отзовётся. */
function stInventoryOf(block) {
    var be = null
    try { be = block.getEntity() } catch (e) { }
    if (!be) return null
    try {
        var cls = be.getClass()
        while (cls) {
            try {
                var f = cls.getDeclaredField("inventory")
                f.setAccessible(true)
                var inv = f.get(be)
                if (inv && typeof inv.getSlots === "function") return inv
                break
            } catch (e) { cls = cls.getSuperclass() }
        }
    } catch (e) { }
    try {
        var cap = be.getCapability(ST_ItemHandlerCap).resolve()
        if (cap.isPresent()) return cap.get()
    } catch (e) { }
    try {
        var kinv = block.getInventory()
        if (kinv && typeof kinv.getSlots === "function") return kinv
    } catch (e) { }
    try {
        if (typeof be.getContainerSize === "function") return {
            getSlots: () => be.getContainerSize(), getStackInSlot: i => be.getItem(i),
            setStackInSlot: (i, st) => be.setItem(i, st), insertItem: (i, st, sim) => { if (!sim) be.setItem(i, st); return Item.of("minecraft:air") },
        }
    } catch (e) { }
    return null
}

/** Какое дерево в постройке главное - по палитре. */
function stMainWood(tpl) { return stWoodsRanked(tpl)[0] || "oak" }

/** Породы дерева шаблона по числу блоков, от главной; крыши и мебель Macaw тоже в счёт. */
function stWoodsRanked(tpl) {
    var count = {}
    var use = stPaletteUse(tpl)
    tpl.palette.forEach((st, i) => {
        var s = String(st), w = null
        var m = s.match(/wood\/[a-z_]+\/([a-z_]+)/)
        if (m) w = m[1].replace(/_(stairs|slab|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|log_fence|workbench|loom|tool_rack|bookshelf|ladder)$/, "")
        else {
            var m2 = s.match(/^mcw_tfc_aio:[a-z_]+\/([a-z_]+?)_(roofs|furniture|fences|windows|doors|trapdoors|stairs|bridges|paths)\//)
            if (m2) w = m2[1]
        }
        if (!w || ST_WOOD_IDS.indexOf(w) < 0) return
        count[w] = (count[w] || 0) + use[i]
    })
    return Object.keys(count).sort((a, b) => count[b] - count[a])
}

/**
 * Сколько раз каждый элемент палитры реально встречается в шаблоне. Считать по самой
 * палитре нельзя: у одной ступени два десятка состояний, а стена может быть одним.
 */
function stPaletteUse(tpl) {
    var use = []
    for (var i = 0; i < tpl.palette.length; i++) use.push(0)
    tpl.data.forEach(seg => {
        var v = seg[0]
        if (v >= 0 && v < use.length) use[v] += seg[1]
    })
    return use
}

/** Главная порода камня шаблона: из чего сложено больше всего блоков. */
function stMainRock(tpl) {
    var count = {}
    var use = stPaletteUse(tpl)
    tpl.palette.forEach((st, i) => {
        var m = String(st).match(/tfc:rock\/[a-z_]+\/([a-z_]+)/)
        if (!m) return
        // из "gabbro_stairs" нужен габбро, а не отдельная порода "габбро-ступени"
        var rock = m[1].replace(/_(stairs|slab|wall|button|pressure_plate|bricks|smooth|cracked|mossy|chiseled|road|aqueduct)$/, "")
        count[rock] = (count[rock] || 0) + use[i]
    })
    var best = null, n = 0
    for (var k in count) if (count[k] > n) { n = count[k]; best = k }
    return best
}

/** Сведения о шаблоне для тех, кто из них собирает поселение. */
function stInfo(name) {
    var tpl = null
    try { tpl = global.TFG_BLUEPRINTS.get(name) } catch (e) { }
    if (!tpl) return null
    return {
        name: name, size: tpl.size, rock: stMainRock(tpl), wood: stMainWood(tpl),
        profile: stProfile(tpl.name || name, tpl),
    }
}

/**
 * Назначение постройки. Сначала смотрим на имя шаблона, а если хозяин назвал его черновиком
 * вроде "1" - прикидываем по размеру: узкое и высокое - башня, широкое и большое - особняк.
 */
function stProfile(name, tpl) {
    var n = String(name || "").toLowerCase()
    if (n.indexOf("башня") >= 0 || n.indexOf("башн") >= 0) return "башня"
    if (n.indexOf("форт") >= 0 || n.indexOf("крепост") >= 0) return "форт"
    if (n.indexOf("особняк") >= 0 || n.indexOf("поместь") >= 0) return "особняк"
    if (n.indexOf("больш") >= 0) return "большой"
    if (n.indexOf("трущ") >= 0) return "трущобы"
    if (n.indexOf("мал") >= 0) return "малый"
    if (n.indexOf("дом") >= 0) return "дом"
    if (tpl && tpl.size) {
        var w = Math.max(tpl.size[0], tpl.size[2]), h = tpl.size[1], area = tpl.size[0] * tpl.size[2]
        if (h >= 22 && w <= 18) return "башня"
        if (area >= 1400) return "форт"
        if (area >= 900) return "особняк"
        if (area >= 500) return "большой"
        if (area <= 200) return "малый"
    }
    return "дом"
}

/**
 * Что за комнаты на этаже. Первым идёт основное назначение, дальше - соседние:
 * на одном этаже и кухня, и кладовая, поэтому контейнеры разбираются вразнобой.
 */
const ST_FLOORS = {
    "башня": [["кухня"], ["личное"], ["арсенал"]],
    "дом": [["быт"], ["личное"], ["кухня"]],
    // первый - кухня и хозяйский склад, второй - покои, третий - большой склад и мастерская
    "особняк": [["кухня", "склад_быт"], ["личное"], ["склад", "мастерская", "арсенал"]],
    // прихожая с кухней, гостиная со спальнями, наверху большой склад с оружием и патронами
    "большой": [["быт", "кухня"], ["личное"], ["склад", "арсенал"]],
    // внизу жильё, наверху кладовая
    "малый": [["быт"], ["склад"]],
    // хибара на окраине: всё в одной комнате
    "трущобы": [["быт", "личное"], ["склад"]],
    // в башнях форта - патроны, ремнаборы, инструмент и оружие
    "форт": [["арсенал"], ["арсенал", "склад"]],
}

function stRoom(profile, floor, floors) {
    var plan = ST_FLOORS[profile] || ST_FLOORS["дом"]
    var idx = Math.max(0, Math.min(plan.length - 1, floor))
    // если этажей больше, чем описано, верхние живут по последнему ярусу
    if (floor >= floors - 1 && floors > plan.length) idx = plan.length - 1
    return stPick(plan[idx])
}

/** Носят ли манекены этой постройки доспех (а не рубаху). */
function stWearsArmor(profile) {
    return profile === "форт" || profile === "особняк" || profile === "большой" || profile === "башня"
}

/** Что положить в этот контейнер: смотрим, что это за блок и что за комната. */
function stContents(blockId, room, wood, trade, heavy) {
    var arsenal = room === "арсенал"
    var craft = trade && ST_TRADES[trade] ? ST_TRADES[trade] : null
    var out = []
    var n = 2 + Math.floor(Math.random() * 4)
    if (blockId.indexOf("jar_shelf") >= 0 || blockId.indexOf("jarbnet") >= 0 || blockId === "tfc:jars") {
        for (var i = 0; i < 4; i++) out.push(stItem(stPick(ST_JARS), 1))
        return out
    }
    if (blockId.indexOf("bookshelf") >= 0) {
        // книжная полка (резная, TFC, шкаф Macaw's) - книги, а не самоцветы с бумагой
        for (var ib = 0; ib < 6; ib++) out.push(Math.random() < 0.55 ? stItem("minecraft:book", 1) : null)
        return out
    }
    if (blockId.indexOf("food_shelf") >= 0) {
        for (var i2 = 0; i2 < 4; i2++) out.push(Math.random() < 0.75 ? stItem(stPick(ST_FOOD), 1 + Math.floor(Math.random() * 3)) : null)
        return out
    }
    if (blockId.indexOf("wine_shelf") >= 0) {
        for (var i3 = 0; i3 < 4; i3++) out.push(stItem(stPick(ST_WINE), 1))
        return out
    }
    if (blockId.indexOf("tool_rack") >= 0) {
        for (var i4 = 0; i4 < 4; i4++) {
            // на стойках форта и арсенала висит оружие, в мастерской - инструмент
            if (arsenal && Math.random() < 0.75) out.push(Math.random() < 0.75 ? stGunItem(heavy) : stItem(stPick(ST_WEAPONS).replace("{m}", stPick(ST_METALS)), 1))
            else if (room === "мастерская") out.push(stItem(stPick(ST_TOOLS), 1))
            else if (room === "личное" && Math.random() < 0.4) out.push(stItem(stPick(ST_PERSONAL), 1))
            else if (Math.random() < 0.7) out.push(stItem(stPick(ST_TOOLS), 1))
            else out.push(null)
        }
        return out
    }
    // ящики, бочки, сосуды, шкафы - по назначению комнаты
    for (var k = 0; k < n; k++) {
        if (arsenal) {
            // патроны под те стволы, что тут лежат, и ремнаборы под доспех манекенов
            var roll = Math.random()
            if (roll < 0.45) out.push(stAmmoItem())
            else if (roll < 0.75) out.push(stRepairKit(null))
            else if (roll < 0.9) out.push(stItem("@слиток", 1 + Math.floor(Math.random() * 6)))
            else out.push(stItem(stPick(ST_TOOLS), 1))
        } else if (room === "склад") {
            out.push(stItem(stPick(ST_STORE).replace("{w}", wood || "oak"), 1 + Math.floor(Math.random() * 8)))
        } else if (room === "склад_быт") {
            var mix = Math.random() < 0.5 ? ST_STORE : ST_HOUSEHOLD
            out.push(stItem(stPick(mix).replace("{w}", wood || "oak"), 1 + Math.floor(Math.random() * 6)))
        } else if (room === "мастерская") {
            out.push(Math.random() < 0.5 ? stItem(stPick(ST_TOOLS), 1)
                : stItem(stPick(ST_STORE).replace("{w}", wood || "oak"), 1 + Math.floor(Math.random() * 6)))
        } else if (room === "кухня") {
            out.push(stItem(stPick(ST_KITCHEN), 1 + Math.floor(Math.random() * 3)))
        } else if (room === "быт") {
            // у ремесленника в мастерской прежде всего его припас
            var pool = craft && Math.random() < 0.65 ? craft : ST_HOUSEHOLD
            out.push(stItem(stPick(pool).replace("{w}", wood || "oak"), 1 + Math.floor(Math.random() * 6)))
        } else if (room === "личное") {
            out.push(stItem(stPick(ST_PERSONAL), 1 + Math.floor(Math.random() * 2)))
        } else {
            out.push(stItem(stPick(ST_TOOLS.concat(ST_FOOD)), 1 + Math.floor(Math.random() * 2)))
        }
    }
    return out
}

/**
 * Ствол в стойку или ящик. Заодно запоминаем, какой патрон ему нужен: в этой же постройке
 * потом лягут именно эти патроны, а не случайные.
 */
var ST_HOUSE_GUNS = [], ST_HOUSE_AMMO = [], ST_PLACED_AMMO = []

/**
 * Арсенал постройки выбираем заранее - два-три ствола на дом. Тогда патроны в ящиках
 * гарантированно подходят к оружию на стойках, а не оказываются от чужого калибра.
 */
function stArmory(heavy) {
    ST_HOUSE_GUNS = []
    ST_HOUSE_AMMO = []
    ST_PLACED_AMMO = []
    var pool = stGunPool(heavy)
    if (!pool.length) return
    var want = 2 + Math.floor(Math.random() * 2)
    for (var i = 0; i < want && pool.length; i++) {
        var id = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
        var ammo = null
        try { ammo = global.TFG_GUNS[id][0] } catch (e) { }
        if (!ammo) ammo = stAmmoOf(id)
        ST_HOUSE_GUNS.push(id)
        if (ammo && ST_HOUSE_AMMO.indexOf(ammo) < 0 && global.TFG_GUN_ITEMS.ammoLoaded(ammo)) ST_HOUSE_AMMO.push(ammo)
    }
}

function stGunItem(heavy) {
    if (!ST_HOUSE_GUNS.length) stArmory(heavy)
    if (!ST_HOUSE_GUNS.length) return null
    var gunId = stPick(ST_HOUSE_GUNS)
    // запоминаем калибр именно выложенного ствола: патроны в ящиках будут к нему
    var ammo = null
    try { ammo = global.TFG_GUNS[gunId][0] } catch (e) { }
    if (ammo && ST_PLACED_AMMO.indexOf(ammo) < 0 && global.TFG_GUN_ITEMS.ammoLoaded(ammo)) ST_PLACED_AMMO.push(ammo)
    // собираем сборщиком TACZ (factions/gun_items.js): ствол без GunId - пустышка без текстуры
    return global.TFG_GUN_ITEMS.gun(gunId)
}

/**
 * Ремонтный набор. В TFG чинят не слитками и листами, а наборами gtceu:repair_kit_<металл>,
 * поэтому в арсенале лежат наборы под те доспехи, что стоят на манекенах.
 */
function stRepairKit(metal) {
    var pool = metal ? [metal] : (ST_REPAIR.length ? ST_REPAIR : ST_METALS)
    for (var i = 0; i < 4; i++) {
        var id = "gtceu:repair_kit_" + stPick(pool)
        if (stExists(id)) return Item.of(id, 1)
    }
    var fall = ["wrought_iron", "steel", "black_steel", "bronze", "copper"]
    for (var j = 0; j < fall.length; j++) {
        var fid = "gtceu:repair_kit_" + fall[j]
        if (stExists(fid)) return Item.of(fid, 1)
    }
    return null
}

/** Патроны к тем стволам, что попали в арсенал. */
var ST_AMMO_FOR = {}
var ST_REPAIR = []                      // металлы доспехов в этой постройке - под них и припас
/** Патроны: в первую очередь к тем стволам, что лежат в этой же постройке. */
function stAmmoItem() {
    var ammo = null
    if (ST_PLACED_AMMO.length) ammo = stPick(ST_PLACED_AMMO)       // к тому, что реально лежит на стойках
    else if (ST_HOUSE_AMMO.length) ammo = stPick(ST_HOUSE_AMMO)
    if (!ammo) {
        var pool = stGunPool(true)
        if (pool.length) {
            try { ammo = global.TFG_GUNS[stPick(pool)][0] } catch (e) { }
        }
    }
    // патрон "melee" у холодного оружия ганпаков не настоящий - вместо пустышки кладём стрелы
    var stack = ammo ? global.TFG_GUN_ITEMS.ammo(ammo, 8 + Math.floor(Math.random() * 24)) : null
    return stack || stItem("minecraft:arrow", 8 + Math.floor(Math.random() * 16))
}

/** Спросить у TACZ, какой патрон нужен стволу: таблица собрана заранее, но мод - истина. */
function stAmmoOf(gunId) {
    if (ST_AMMO_FOR[gunId] !== undefined) return ST_AMMO_FOR[gunId]
    ST_AMMO_FOR[gunId] = null
    try {
        var TimelessAPI = Java.loadClass("com.tacz.guns.api.TimelessAPI")
        var index = TimelessAPI.getCommonGunIndex(Java.loadClass("net.minecraft.resources.ResourceLocation").tryParse(gunId))
        if (index && index.isPresent()) ST_AMMO_FOR[gunId] = String(index.get().getGunData().getAmmoId())
    } catch (e) { stErr("патрон для " + gunId, e) }
    return ST_AMMO_FOR[gunId]
}

/** Разложить вещи по слотам настоящего инвентаря блока. Возвращает, сколько легло. */
function stFill(level, x, y, z, blockId, items) {
    var block = null
    try { block = level.getBlock(x, y, z) } catch (e) { return 0 }
    var inv = stInventoryOf(block)
    if (!inv) {
        if (!ST_NO_INV[blockId]) {
            ST_NO_INV[blockId] = true
            stLog("у блока " + blockId + " не открылся инвентарь - такие не наполняем")
        }
        return 0
    }
    var slots = 0
    try { slots = Number(inv.getSlots()) } catch (e) { return 0 }
    var put = 0
    for (var i = 0; i < items.length && i < slots; i++) {
        var it = items[i]
        if (!it) continue
        try {
            inv.setStackInSlot(i, it)
            put++
        } catch (e) {
            try { inv.insertItem(i, it, false); put++ } catch (e2) { }
        }
    }
    // блок пометить изменённым мало: без обновления клиент не покажет вещи на полке или стойке
    try {
        var be = block.getEntity()
        if (be) be.setChanged()
    } catch (e) { }
    try {
        var dim = String(level.getDimension())
        stRun("execute in " + dim + " run data merge block " + x + " " + y + " " + z + " {}")
    } catch (e) { }
    return put
}

var ST_NO_INV = {}

const ST_CONTAINERS = ["jar_shelf", "jarbnet", "food_shelf", "wine_shelf", "tool_rack", "crate", "barrel",
    "large_vessel", "chest", "cupboard", "shelf",
    // мебель mcw и рабочие столы тоже держат вещи, а раньше проходили мимо списка
    "wardrobe", "drawer", "cabinet", "desk", "counter", "workbench", "sewing_table", "scribing_table",
    "artisan_table", "nightstand", "bedside"]

function stIsContainer(id) {
    // каштан (chestnut) содержит "chest", но сундуком от этого не становится
    if (id === "tfc:jars") return true                  // банки на столах: без наполнения блок пуст
    var clean = id.replace(/chestnut/g, "wood")
    for (var i = 0; i < ST_CONTAINERS.length; i++) if (clean.indexOf(ST_CONTAINERS[i]) >= 0) return true
    return false
}

/**
 * Предмет в виде SNBT для призыва сущности. Раньше в руку манекену писался голый
 * идентификатор, и метка вроде "@меч" уезжала в команду как есть.
 */
var ST_CompoundTag = null
function stStackNbt(stack) {
    if (!stack) return null
    try {
        if (!ST_CompoundTag) ST_CompoundTag = Java.loadClass("net.minecraft.nbt.CompoundTag")
        var tag = stack.save(new ST_CompoundTag())
        return String(tag)
    } catch (e) { stErr("запись предмета", e) }
    return null
}

/** Обычная одежда: рубаха, штаны, шапка, сапоги одного набора. */
function stClothes() {
    return {
        metal: null,
        items: stPick(ST_OUTFITS).slice(),
        weapon: Math.random() < 0.4 ? "@нож" : null,
    }
}

/** Полный комплект доспехов одного металла плюс оружие: во что одеваем манекен. */
function stArmorSet() {
    var metal = stPick(ST_METALS)
    var weapon = stPick(ST_WEAPONS).replace("{m}", metal)
    return {
        metal: metal,
        items: [
            "tfc:metal/boots/" + metal,
            "tfc:metal/greaves/" + metal,
            "tfc:metal/chestplate/" + metal,
            "tfc:metal/helmet/" + metal,
        ],
        weapon: weapon,
    }
}

/** Внутри ли точка: с трёх сторон из четырёх в пределах пятна есть стена, и есть крыша. */
function stIndoors(level, box, x, y, z, own) {
    var walls = 0
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    for (var i = 0; i < dirs.length; i++) {
        var hit = false
        for (var d = 1; d <= 20; d++) {        // в просторных залах форта стены дальше, чем в доме
            var nx = x + dirs[i][0] * d, nz = z + dirs[i][1] * d
            if (nx < box.x1 || nx > box.x2 || nz < box.z1 || nz > box.z2) break
            if (own && !own[nx + "," + nz]) break       // дальше - соседний дом, его стены не наши
            var id = ""
            try { id = String(level.getBlock(nx, y, nz).id) } catch (e) { break }
            if (id !== "minecraft:air") { hit = true; break }
        }
        if (hit) walls++
    }
    if (walls < 3) return false
    for (var up = 1; up <= 8; up++) {                 // крыша над головой
        var idu = ""
        try { idu = String(level.getBlock(x, y + up, z).id) } catch (e) { return false }
        if (idu !== "minecraft:air") return true
    }
    return false
}

/** Клетка, где можно встать: под ногами пол, над головой два блока воздуха. */
function stStandable(level, x, y, z) {
    try {
        if (String(level.getBlock(x, y - 1, z).id) === "minecraft:air") return false
        if (String(level.getBlock(x, y, z).id) !== "minecraft:air") return false
        if (String(level.getBlock(x, y + 1, z).id) !== "minecraft:air") return false
    } catch (e) { return false }
    return true
}

/** Этажи постройки: уровни, где есть где стоять. Возвращает список y снизу вверх. */
/** own - клетки самой постройки: коробки соседей в тесной застройке налезают друг на друга. */
function stFloors(level, box, base, height, own) {
    var out = []
    for (var h = 1; h < height - 1; h++) {
        var y = base + 1 + h
        var n = 0
        for (var x = box.x1 + 1; x < box.x2 && n < 6; x++) {
            for (var z = box.z1 + 1; z < box.z2 && n < 6; z++) {
                if (own && !own[x + "," + z]) continue
                if (stStandable(level, x, y, z) && stIndoors(level, box, x, y, z, own)) n++
            }
        }
        if (n >= 6) {
            var prev = out.length ? out[out.length - 1] : -99
            if (y - prev >= 3) out.push(y)                   // соседние уровни одного этажа не считаем дважды
        }
    }
    return out
}

/** Свободные клетки верхнего этажа - туда и ставим манекены. */
function stFreeSpots(level, box, base, height, floorIndex, own) {

    var floors = stFloors(level, box, base, height, own)

    if (!floors.length) return []

    var y = floorIndex === undefined || floorIndex < 0 ? floors[floors.length - 1]

        : floors[Math.min(floors.length - 1, floorIndex)]

    // Манекен посреди комнаты выглядит потеряшкой. Собираем все годные клетки, а потом

    // выбираем те, что стоят у стены, и разносим их друг от друга.

    var cand = []

    for (var x = box.x1 + 1; x < box.x2; x++) {

        for (var z = box.z1 + 1; z < box.z2; z++) {

            if (own && !own[x + "," + z]) continue        // только в своём доме, не у соседа

            if (!stStandable(level, x, y, z)) continue

            if (!stIndoors(level, box, x, y, z, own)) continue      // во дворе манекенам не место

            var walls = 0

            var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]

            for (var i = 0; i < dirs.length; i++) {

                var id = ""

                try { id = String(level.getBlock(x + dirs[i][0], y, z + dirs[i][1]).id) } catch (e) { }

                if (id && id !== "minecraft:air") walls++

            }

            // место у стены лучше, но и середина комнаты сойдёт - пустой этаж хуже

            cand.push({ x: x, y: y, z: z, walls: walls })

        }

    }

    cand.sort((a, b) => b.walls - a.walls)

    var out = []

    for (var ci = 0; ci < cand.length && out.length < 8; ci++) {

        var c = cand[ci]

        var close = out.some(o => Math.abs(o.x - c.x) < 4 && Math.abs(o.z - c.z) < 4)

        if (!close) out.push({ x: c.x, y: c.y, z: c.z })

    }

    return out

}



/** Манекены: стойка с полным комплектом и оружием в руке. */
function stSpawnStands(tpl, box, base, steps, sx, sz, level, profile, own) {
    var metals = {}
    var ents = (tpl.entities || []).slice()
    // в шаблоне манекенов нет - расставим сами, три-четыре штуки на верхнем этаже
    if (!ents.length && level) {
        // в жилом доме манекены внизу, в арсенале и форте - на верхнем этаже, рядом с оружием
        var spots = stFreeSpots(level, box, base, tpl.size[1], stWearsArmor(profile) ? -1 : 0, own)
        var want = 3 + Math.floor(Math.random() * 2)
        spots.slice(0, want).forEach(sp => {
            ents.push({ type: "minecraft:armor_stand", x: sp.x - box.x1, y: sp.y - base - 1, z: sp.z - box.z1,
                yaw: Math.floor(Math.random() * 4) * 90, ready: true })
        })
    }
    ents.forEach(e => {
        var rp = e.ready ? [Math.floor(e.x), Math.floor(e.z)] : stRotatePos(Math.floor(e.x), Math.floor(e.z), sx, sz, steps)
        var wx = box.x1 + rp[0] + 0.5
        var wy = base + 1 + e.y - (e.ready ? 0 : (box.floorY || 0))
        var wz = box.z1 + rp[1] + 0.5
        if (e.type !== "minecraft:armor_stand") {
            stRun("execute in " + box.dim + " run summon " + e.type + " " + wx.toFixed(2) + " " + wy.toFixed(2) + " " +
                wz.toFixed(2) + " {Rotation:[" + ((Number(e.yaw) + steps * 90) % 360) + "f,0f]}")
            return
        }
        var set = stWearsArmor(profile) ? stArmorSet() : stClothes()
        if (set.metal) metals[set.metal] = (metals[set.metal] || 0) + 1
        var armor = set.items.map(id => stStackNbt(stItem(id, 1)) || "{}").join(",")
        var wstack = set.weapon ? stItem(set.weapon, 1) : null
        var wnbt = wstack ? stStackNbt(wstack) : null
        var hands = wnbt ? "[" + wnbt + ",{}]" : "[{},{}]"
        var nbt = "{ShowArms:1b,Rotation:[" + ((Number(e.yaw) + steps * 90) % 360) + "f,0f]," +
            "ArmorItems:[" + armor + "]," +
            "HandItems:" + hands + "}"
        stRun("execute in " + box.dim + " run summon minecraft:armor_stand " + wx.toFixed(2) + " " +
            wy.toFixed(2) + " " + wz.toFixed(2) + " " + nbt)
    })
    return metals
}

// ─── Снос без слепка ─────────────────────────────────────────────────────────

/**
 * Что считаем рукотворным. Нужно для сноса построек, у которых потерялся слепок зоны
 * (старые зоны пропали из-за переполнения строки NBT - см. store.js).
 */
// Природа: всё остальное считаем постройкой. Перечислять рукотворное поимённо
// бесполезно - в сборке тысячи блоков, и снос оставлял половину стен стоять.
const ST_TERRAIN = ["tfc:dirt/", "tfc:grass/", "tfc:clay/", "tfc:clay_grass/", "tfc:sand/", "tfc:mud/",
    "tfc:mud_bricks/", "tfc:rock/raw/", "tfc:rock/hardened/", "tfc:rock/gravel/", "tfc:rock/loose/",
    "tfc:rock/mossy_loose/", "tfc:ore/", "tfc:plant/", "tfc:wild_crop/", "tfc:groundcover/",
    "tfc:wood/leaves/", "tfc:wood/sapling/", "tfc:wood/fallen_leaves/", "tfc:peat", "tfc:snow",
    "minecraft:dirt", "minecraft:grass_block", "minecraft:sand", "minecraft:gravel", "minecraft:stone",
    "minecraft:deepslate", "minecraft:water", "minecraft:lava", "minecraft:snow", "minecraft:ice",
    "minecraft:bedrock", "minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern",
    "afc:wood/leaves/", "afc:plant/", "firmalife:plant/"]

// ─── Никто не появляется на крышах ───────────────────────────────────────────
//
// Рейдеры, налётчики осад, торговцы, караваны и охрана появлялись по высоте столба - а в
// тесной застройке это крыша дома или надвратная башня. Теперь у всех одно правило: под
// ногами должна быть земля (протоптанная тропа и пашня тоже земля), а не постройка.

const ST_GROUND_OK = /(grass_path|farmland|rooted_dirt|muddy_roots|snow)/

/** Стоит ли точка (ноги на y) на постройке - на крыше, стене, настиле. */
function stOnRoof(level, x, y, z) {
    var id = ""
    try { id = String(level.getBlock(Math.floor(x), Math.floor(y) - 1, Math.floor(z)).id) } catch (e) { return false }
    return stIsBuilt(id) && !ST_GROUND_OK.test(id)
}

/** Ближайшая к (x, z) точка на земле: не крыша, не вода. { x, y, z } (центр клетки) или null. */
function stGroundSpot(level, x, z, maxR) {
    var bx = Math.floor(x), bz = Math.floor(z)
    var lim = maxR === undefined ? 12 : maxR
    for (var r = 0; r <= lim; r++) {
        for (var i = -r; i <= r; i++) {
            for (var j = -r; j <= r; j++) {
                if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue
                var cx = bx + i, cz = bz + j
                try { if (!level.hasChunk(cx >> 4, cz >> 4)) continue } catch (e) { }
                var h = null
                try { h = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", cx, cz)) } catch (e) { continue }
                var below = ""
                try { below = String(level.getBlock(cx, h - 1, cz).id) } catch (e) { continue }
                if (below.indexOf("water") >= 0 || below.indexOf("lava") >= 0 || below.indexOf("leaves") >= 0 || below.indexOf("ice") >= 0) continue
                if (stIsBuilt(below) && !ST_GROUND_OK.test(below)) continue
                return { x: cx + 0.5, y: h, z: cz + 0.5 }
            }
        }
    }
    return null
}

global.TFG_ON_ROOF = (level, x, y, z) => stOnRoof(level, x, y, z)
global.TFG_GROUND_SPOT = (level, x, z, maxR) => stGroundSpot(level, x, z, maxR)

function stIsBuilt(id) {
    if (!id || id === "minecraft:air" || id === "minecraft:cave_air") return false
    for (var i = 0; i < ST_TERRAIN.length; i++) if (id.indexOf(ST_TERRAIN[i]) === 0) return false
    return true
}

/**
 * Снести рукотворное вокруг точки и вернуть землю. Грубо, зато работает там,
 * где слепка уже нет: природные блоки не трогаем, ямы под снесённым засыпаем грунтом.
 */
function stWipe(level, cx, cz, r, owner) {
    if (!ST_SERVER) ST_SERVER = level.getServer()
    var dim = String(level.getDimension())
    var cmds = []
    var removed = 0
    for (var x = cx - r; x <= cx + r; x++) {
        for (var z = cz - r; z <= cz + r; z++) {
            if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > r * r) continue
            var top = 0
            try { top = Number(level.getHeight("WORLD_SURFACE_WG", x, z)) } catch (e) { continue }
            if (!isFinite(top)) continue
            // Идём всю колонну сверху вниз и сносим ВСЁ рукотворное. Раньше проход
            // останавливался на первом природном блоке, и нижние этажи оставались стоять.
            var ground = null, holes = []
            for (var y = top + 2; y > top - 48; y--) {
                var id = ""
                try { id = String(level.getBlock(x, y, z).id) } catch (e) { break }
                if (id === "minecraft:air" || id === "minecraft:cave_air") continue
                if (stIsBuilt(id)) {
                    cmds.push("execute in " + dim + " run setblock " + x + " " + y + " " + z + " minecraft:air replace")
                    removed++
                    holes.push(y)
                    continue
                }
                if (ground === null) ground = y                  // самый высокий природный блок
            }
            // ямы под снесённым засыпаем: только то, что ниже уровня земли вокруг
            if (ground !== null) {
                var fill = stGroundState(level, x, z)
                var low = null, high = null
                holes.forEach(hy => {
                    if (hy >= ground) return
                    if (low === null || hy < low) low = hy
                    if (high === null || hy > high) high = hy
                })
                if (low !== null) {
                    cmds.push("execute in " + dim + " run fill " + x + " " + low + " " + z + " " +
                        x + " " + high + " " + z + " " + fill + " replace")
                }
            }
        }
    }
    // манекены, рамки и выпавшие вещи в том же круге
    ;["minecraft:armor_stand", "minecraft:item_frame", "minecraft:glow_item_frame", "minecraft:painting",
        "minecraft:item"].forEach(type => {
            cmds.push("execute in " + dim + " run kill @e[type=" + type + ",x=" + cx + ",y=-64,z=" + cz +
                ",distance=.." + r + "]")
        })
    stQueue(cmds)
    stLog("снос в радиусе " + r + " у " + cx + " " + cz + ": рукотворных блоков " + removed)
    return removed
}

// ─── Постановка ──────────────────────────────────────────────────────────────

/**
 * Шаблон по имени. Если точного нет, имя считается началом группы: "башня" - любая из башен
 * (порода и зеркальность выбираются случайно).
 */
function stTemplate(name) {
    try {
        var exact = global.TFG_BLUEPRINTS.get(name)
        if (exact) return exact
        var all = global.TFG_BLUEPRINTS.names().map(n => String(n).replace(/ \(.*\)$/, ""))
        var group = all.filter(n => n.indexOf(name) === 0)
        if (group.length) {
            var chosen = group[Math.floor(Math.random() * group.length)]
            var tpl = global.TFG_BLUEPRINTS.get(chosen)
            if (tpl) {
                stLog("из группы " + name + " выбран " + chosen)
                return tpl
            }
        }
    } catch (e) { stErr("поиск шаблона", e) }
    return null
}

/**
 * Куда развернуть: из четырёх вариантов берём тот, где перед дверью просторнее всего -
 * ровно, без скалы и деревьев в упор.
 */
function stBestRotation(level, cx, cz, tpl, cells) {
    var door = stDoor(cells, tpl)
    if (!door) return Math.floor(Math.random() * 4)
    var base = stTop(level, Math.floor(cx), Math.floor(cz))
    var best = 0, bestScore = -1e9
    for (var steps = 0; steps < 4; steps++) {
        var dir = stTurn(door.facing, steps)
        var dx = dir === "east" ? 1 : dir === "west" ? -1 : 0
        var dz = dir === "south" ? 1 : dir === "north" ? -1 : 0
        var score = 0
        for (var d = 2; d <= 16; d += 2) {
            for (var w = -2; w <= 2; w++) {
                var x = Math.floor(cx) + dx * d + (dx ? 0 : w)
                var z = Math.floor(cz) + dz * d + (dz ? 0 : w)
                var t = stTop(level, x, z)
                score -= Math.abs(t - base)                   // ровное дороже
                var id = ""
                try { id = String(level.getBlock(x, t + 1, z).id) } catch (e) { }
                if (id.indexOf("log/") >= 0 || id.indexOf("leaves") >= 0) score -= 3   // дерево в упор мешает
                if (id.indexOf("water") >= 0) score -= 2
            }
        }
        if (score > bestScore) { bestScore = score; best = steps }
    }
    return best
}

/**
 * Поставить шаблон рядом с точкой. steps - четверти поворота (0..3) или null (выбрать самому).
 * Возвращает запись постройки или строку с ошибкой.
 */
/**
 * Ворота: проём в наружной стене. У форта вход - это арка, а не дверь, и поиск по дверям
 * уводил тропу в стену. Поэтому ищем в кольце стен сплошной участок пустоты на высоте
 * прохода и берём самый широкий.
 */
function stGate(cells, tpl) {

    if (!tpl || !tpl.size) return null

    var sx = tpl.size[0], sz = tpl.size[2]

    var floorY = stFloorY(cells)

    var occ = {}

    cells.forEach(c => { if (c.state) occ[c.x + "," + c.y + "," + c.z] = 1 })

    var y1 = floorY + 1, y2 = floorY + 2

    var full = (x, z) => occ[x + "," + y1 + "," + z] || occ[x + "," + y2 + "," + z]

    var roofed = (x, z) => {

        for (var up = 3; up <= 8; up++) if (occ[x + "," + (floorY + up) + "," + z]) return true

        return false

    }



    var best = null

    // Стена может стоять не по самому краю шаблона, поэтому для каждой стороны ищем

    // первую линию, которая действительно похожа на стену, и уже в ней ищем проём.

    var sides = [

        { out: { dx: 0, dz: -1 }, axis: "z", dir: 1, len: sx, span: sz },

        { out: { dx: 0, dz: 1 }, axis: "z", dir: -1, len: sx, span: sz },

        { out: { dx: -1, dz: 0 }, axis: "x", dir: 1, len: sz, span: sx },

        { out: { dx: 1, dz: 0 }, axis: "x", dir: -1, len: sz, span: sx },

    ]

    sides.forEach(side => {

        // стена - самая плотная линия у края: у форта первыми идут угловые башни
        var line = -1, bestFill = 0
        for (var step = 0; step < Math.min(8, side.span); step++) {
            var at = side.dir > 0 ? step : side.span - 1 - step
            var filled = 0

            for (var i = 0; i < side.len; i++) {

                var cx = side.axis === "x" ? at : i

                var cz = side.axis === "x" ? i : at

                if (full(cx, cz)) filled++

            }

            if (filled > bestFill) { bestFill = filled; line = at }
        }

        if (line < 0 || bestFill < side.len * 0.4) return
        var run = 0, start2 = 0

        for (var j = 0; j <= side.len; j++) {

            var gx = side.axis === "x" ? line : j

            var gz = side.axis === "x" ? j : line

            var open = j < side.len && !full(gx, gz) && roofed(gx, gz)

            if (open) {

                if (!run) start2 = j

                run++

                continue

            }

            if (run >= 2 && run <= 8) {

                var mid = start2 + Math.floor(run / 2)

                var mx = side.axis === "x" ? line : mid

                var mz = side.axis === "x" ? mid : line

                if (!best || run > best.width) {

                    best = { x: mx, y: y1, z: mz, out: side.out, width: run, facing: "north", blockers: 0, edge: 0 }

                }

            }

            run = 0

        }

    })

    return best

}



// сторона света -> вектор
const ST_DIR_VEC = { north: { dx: 0, dz: -1 }, south: { dx: 0, dz: 1 }, east: { dx: 1, dz: 0 }, west: { dx: -1, dz: 0 } }

/** Сколько четвертей повернуть, чтобы крыльцо смотрело в нужную сторону. */
function stStepsForFacing(cells, tpl, want) {
    var door = stDoor(cells, tpl)
    var w = ST_DIR_VEC[want]
    if (!door || !door.out || !w) return 0
    for (var st = 0; st < 4; st++) {
        var v = stTurnVec(door.out, st)
        if (v.dx === w.dx && v.dz === w.dz) return st
    }
    return 0
}

// ─── Крыльцо: пологий сход от порога к земле ─────────────────────────────────

const ST_RAMP_MAX = 16                  // столько клеток самое большее идёт сход до земли

/**
 * Крыльцо перед входом.
 *
 * 1. Где кончается сама постройка. Идём от двери наружу по блокам шаблона и следим, по чему
 *    ступает человек: пол под дверью, ступени, настил веранды. Первая клетка без настила у
 *    ног - это земля перед домом, а уровень последнего настила - высота схода. Раньше сход
 *    считался по уровню двери, и у домов со ступенями на краю веранды была яма или уступ.
 * 2. От схода - три клетки вровень, а дальше пологий спуск или подъём не круче блока на
 *    клетку, пока не встретится земля (до ST_RAMP_MAX клеток): обрыва в конце больше нет.
 * 3. По бокам - откосы в две клетки: склон подводится к дорожке, траншеи со стенками нет.
 * Верх дорожки - тропа, под ней местный грунт.
 */
function stApron(level, box, base, cells, tpl, steps, door, foot0) {
    var out = []
    var floorY = stFloorY(cells)
    var occ = {}
    cells.forEach(c => { if (c.state) occ[c.x + "," + c.y + "," + c.z] = c.state })
    var passable = s => !s || /(_door|fence_gate|carpet|torch|lantern|_sign|pressure_plate|button|lamp|candle|flower|grass)/.test(s)
    var floorAt = (x, y, z) => { var s = occ[x + "," + y + "," + z]; return !!s && !passable(s) }
    var o = door.out || { dx: 0, dz: 0 }
    if (!o.dx && !o.dz) return out
    // 1. сход: идём по шаблону, пока под ногами есть настил
    var ty = door.y - 1
    var sx = door.x, sz = door.z
    for (var s = 1; s <= 12; s++) {
        var cx = door.x + o.dx * s, cz = door.z + o.dz * s
        sx = cx; sz = cz
        if (cx < 0 || cz < 0 || cx >= tpl.size[0] || cz >= tpl.size[2]) break
        var ny = null
        // ступень вверх на блок или вниз до двух: верхний настил со свободой над головой
        for (var y = ty + 1; y >= ty - 2; y--) {
            if (floorAt(cx, y, cz) && !floorAt(cx, y + 1, cz) && !floorAt(cx, y + 2, cz)) { ny = y; break }
        }
        if (ny === null) break                              // настила нет - здесь уже земля
        ty = ny
    }
    var L = base + 1 + ty - floorY                          // мировой уровень схода (верх грунта)
    var p0 = stRotatePos(sx, sz, tpl.size[0], tpl.size[2], steps)
    var ov = stTurnVec(o, steps)
    var x0 = box.x1 + p0[0], z0 = box.z1 + p0[1]
    var solidAt = (x, z) => !!foot0.solid[x + "," + z]
    // 2. профиль по оси: вровень три клетки, потом к земле не круче блока на клетку
    var prof = []
    var prev = L
    for (var k = 0; k < ST_RAMP_MAX; k++) {
        var ax = x0 + ov.dx * k, az = z0 + ov.dz * k
        var g = stTop(level, ax, az)
        var h = k < 3 ? L : Math.max(prev - 1, Math.min(prev + 1, g))
        prof.push(h)
        prev = h
        if (k >= 3 && h === g) break                        // встретили землю
    }
    // 3. клетки: дорожка (шире у самого порога) и откосы по бокам
    var setCol = (x, z, h, top, surf, keepAbove) => {
        var ground = stGroundState(level, x, z)
        // под навесом самой постройки (столб её, но настила у ног нет) верх не расчищаем
        if (!keepAbove) out.push("execute in " + box.dim + " run fill " + x + " " + (h + 1) + " " + z + " " + x + " " +
            Math.max(h + 5, top) + " " + z + " minecraft:air replace")
        if (top < h - 1)
            out.push("execute in " + box.dim + " run fill " + x + " " + (top + 1) + " " + z + " " + x + " " +
                (h - 1) + " " + z + " " + ground + " replace")
        out.push("execute in " + box.dim + " run setblock " + x + " " + h + " " + z + " " + (surf || ground) + " replace")
    }
    prof.forEach((h, k) => {
        var hw = k < 3 ? 2 : 1
        for (var w = -(hw + 2); w <= hw + 2; w++) {
            var cx2 = x0 + ov.dx * k + (ov.dx ? 0 : w)
            var cz2 = z0 + ov.dz * k + (ov.dz ? 0 : w)
            var aw = Math.abs(w)
            var own = solidAt(cx2, cz2)
            if (own && (aw > hw || k > 0)) continue          // стены и крыльцо самого дома не трогаем
            var top = stTop(level, cx2, cz2)
            if (aw <= hw) {
                var path = "tfc:grass_path/loam"
                try { path = dcPathMat(level, cx2, cz2) } catch (e) { }
                setCol(cx2, cz2, h, top, path, own)
            } else {
                // откос: не дальше блока (у второй клетки - двух) от дорожки, поверхность родная
                var d = aw - hw
                var hh = Math.max(h - d, Math.min(h + d, top))
                if (hh === top) continue
                var surf = ""
                try { surf = String(level.getBlock(cx2, top, cz2).id) } catch (e) { }
                if (surf.indexOf("grass") < 0 && surf.indexOf("dirt") < 0) surf = ""
                setCol(cx2, cz2, hh, top, surf)
            }
        }
    })
    return out
}

/**
 * opts: { search: false - не искать место, ставить здесь; faceDir - куда смотрит дверь;
 *         trade - ремесло хозяина; label - подпись зоны; metal/glass - разнообразие отделки;
 *         baseY - уровень пола (пересборка на старом месте); reuseZone - зона отката прежней
 *         постройки, новый снимок не снимаем }
 */
function stPlace(level, cx, cz, name, steps, owner, opts) {
    if (!ST_SERVER) ST_SERVER = level.getServer()
    var tpl = stTemplate(name)
    if (!tpl) return "нет шаблона " + name
    var cells = stCells(tpl)
    if (!cells.length) return "шаблон пустой"
    if (opts && opts.faceDir) steps = stStepsForFacing(cells, tpl, opts.faceDir)
    if (steps === null || steps === undefined) steps = stBestRotation(level, cx, cz, tpl, cells)
    steps = ((steps % 4) + 4) % 4
    var size = stRotatedSize(tpl.size, steps)
    var half = Math.ceil(Math.max(size[0], size[2]) / 2)
    var rel = stRelCols(cells, tpl, steps)
    var fit = { rel: rel, size: size, relSet: {} }
    rel.forEach(rp => { fit.relSet[rp[0] + "," + rp[1]] = 1 })

    var spot = (opts && opts.search === false)
        ? { x: Math.floor(cx), z: Math.floor(cz) }
        : stFindSpot(level, Math.floor(cx), Math.floor(cz), half, opts && opts.searchR, opts && opts.veto, fit, opts && opts.maxDrop)
    if (!spot) return "рядом негде поставить: криво или занято"

    var box = {
        dim: String(level.getDimension()),
        x1: spot.x - Math.floor(size[0] / 2), z1: spot.z - Math.floor(size[2] / 2),
    }
    box.x2 = box.x1 + size[0] - 1
    box.z2 = box.z1 + size[2] - 1

    // уровень пола: середина по высотам под пятном
    var hs = []
    for (var x = box.x1; x <= box.x2; x += 1) for (var zz = box.z1; zz <= box.z2; zz += 1) hs.push(stTop(level, x, zz))
    hs.sort((a, b) => a - b)
    // пересборка на старом месте (opts.baseY): рельеф там - сама постройка, пол берём прежний
    var base = (opts && opts.baseY !== undefined) ? Number(opts.baseY) : hs[Math.floor(hs.length / 2)] - ST_BURY
    box.y1 = base
    box.y2 = base + size[1] + 1

    // фундамент на склоне уходит до самой земли, и зона обязана доставать туда же,
    // иначе откат оставит после себя каменную ногу постройки
    var deepest = base
    for (var mx = box.x1; mx <= box.x2; mx++) {
        for (var mz = box.z1; mz <= box.z2; mz++) {
            var mt = stTop(level, mx, mz)
            if (mt < deepest) deepest = mt
        }
    }
    var floorBottom = Math.min(base - ST_CUT - 3, deepest - 2, base - 16)
    // запас по бокам должен накрыть и крыльцо с обкопом, иначе после отката у входа
    // остаётся срезанная земля
    var pad = Math.max(ST_SMOOTH + 1, ST_DOOR_APRON + 5)
    // Пересборка (opts.reuseZone): снимок «как было до стройки» уже есть - пишем в ту же зону,
    // иначе новым снимком станет сама постройка, и откат к дикой природе перестанет работать.
    var zoneId = (opts && opts.reuseZone && global.TFG_ZONES.get(opts.reuseZone)) ? opts.reuseZone
        : global.TFG_ZONES.snapshot(level, box.x1 - pad, floorBottom, box.z1 - pad,
        box.x2 + pad, base + size[1] + 3, box.z2 + pad,
        { label: (opts && opts.label) || ("постройка " + name), owner: owner || null })
    if (String(zoneId).indexOf("z") !== 0) return String(zoneId)
    var zone = global.TFG_ZONES.get(zoneId)
    // соседи уже стоят (или в очереди): их столбы с блоками наши работы не трогают
    var guard = stGuardCols(box.dim, String(zoneId), box.x1 - pad, box.z1 - pad, box.x2 + pad, box.z2 + pad)

    // если просят другую породу дерева, подставляем её вместо главной породы шаблона
    ST_WEALTH = (opts && opts.wealth !== undefined) ? Number(opts.wealth) : 1
    if (opts && (opts.wood || opts.wood2)) {
        var ranked = stWoodsRanked(tpl)
        opts.woodMap = {}
        if (opts.wood && ranked[0]) opts.woodMap[ranked[0]] = opts.wood
        if (opts.wood2 && ranked[1]) opts.woodMap[ranked[1]] = opts.wood2
    }
    if (opts && opts.rock) {
        var fromRock = stMainRock(tpl)
        var fi = ST_ROCKS.indexOf(fromRock), ti = ST_ROCKS.indexOf(opts.rock)
        opts.rockShift = (fi >= 0 && ti >= 0) ? ti - fi : 0
    }
    var foot0 = stFootprint(cells, box, steps, tpl)
    stRegisterCore(String(zoneId), box, foot0.mask)        // стены и двор: сюда соседи не встанут

    // Порог. Вход и три клетки от него держим на одном уровне - на уровне пола под дверью.
    var doorPre = stDoor(cells, tpl)
    // дверь с перекрытым выходом - это межкомнатная: у крупных построек вход бывает аркой
    if (!doorPre || (doorPre.blockers && doorPre.blockers > 0) || (doorPre.edge && doorPre.edge > 4)) {
        var gatePre = stGate(cells, tpl)
        if (gatePre) doorPre = gatePre
    }
    var flatSet = null, entryLevel = base + 1
    if (doorPre) {
        var dpp = stRotatePos(doorPre.x, doorPre.z, tpl.size[0], tpl.size[2], steps)
        var ovp = stTurnVec(doorPre.out || { dx: 0, dz: 0 }, steps)
        entryLevel = base + doorPre.y - stFloorY(cells)
        flatSet = {}
        for (var fs1 = -3; fs1 <= 4; fs1++) {
            for (var fs2 = -2; fs2 <= 2; fs2++) {
                var fxx = box.x1 + dpp[0] + ovp.dx * fs1 + (ovp.dx ? 0 : fs2)
                var fzz = box.z1 + dpp[1] + ovp.dz * fs1 + (ovp.dz ? 0 : fs2)
                flatSet[fxx + "," + fzz] = 1
            }
        }
    }
    var cmds = stShapeGround(zone, level, box, base, foot0.mask, foot0.solid, flatSet, entryLevel)

    /**
     * Площадка перед входом. ВАЖНО: чистим только то, что СНАРУЖИ пятна - иначе, если дверь
     * не на самом краю, расчистка выгрызает дыру в полу самой постройки (так и было).
     */
    var apron = []
    // Крыльцо - перед тем же входом, по которому считали высоту (doorPre: у крепости это
    // ворота, а не первая попавшаяся дверь). Раньше высоту брали у ворот, а подсыпку делали
    // у внутренней двери: перед воротами оставался неприсыпанный порог, а у дверей -
    // крыльцо не на своей высоте.
    var door = doorPre || stDoor(cells, tpl)
    if (door) apron = stApron(level, box, base, cells, tpl, steps, door, foot0)
    // блоки шаблона: пустые слои снизу отбрасываем, чтобы подошва легла на выровненную землю
    var floorY = stFloorY(cells)
    box.floorY = floorY
    var sx = tpl.size[0], sz = tpl.size[2]
    var containers = [], lamps = [], candles = [], piles = []
    cells.forEach(c => {
        var rp = stRotatePos(c.x, c.z, sx, sz, steps)
        var wx = box.x1 + rp[0], wy = base + 1 + c.y - floorY, wz = box.z1 + rp[1]
        if (!c.state) {
            cmds.push("execute in " + box.dim + " run setblock " + wx + " " + wy + " " + wz + " minecraft:air replace")
            return
        }
        var state = stSkin(stRotateState(c.state, steps), opts)
        state = stFixLight(state)
        var id = state.split("[")[0]
        if (id.indexOf("tfc:metal/lamp/") === 0) lamps.push({ x: wx, y: wy, z: wz })
        if (id.indexOf("candle") >= 0) candles.push({ x: wx, y: wy, z: wz })
        cmds.push("execute in " + box.dim + " run setblock " + wx + " " + wy + " " + wz + " " + state + " replace")
        if (stIsContainer(id)) containers.push({ x: wx, y: wy, z: wz, id: id, floor: Math.floor(c.y / 6) })
        if (id.indexOf("ingot_pile") >= 0 || id.indexOf("sheet_pile") >= 0) piles.push({ x: wx, y: wy, z: wz, id: id })
    })

    // ФУНДАМЕНТ. Шаблон снизу бывает дырявым (клетки «не трогать»), и тогда стены висят
    // над землёй. Поэтому под каждой колонной, где есть блок, добиваем грунт до основания.
    var lowest = {}
    cells.forEach(c => {
        if (!c.state) return
        var rp = stRotatePos(c.x, c.z, tpl.size[0], tpl.size[2], steps)
        var k = rp[0] + "," + rp[1]
        if (lowest[k] === undefined || c.y < lowest[k]) lowest[k] = c.y
    })
    var found = []
    for (var k2 in lowest) {
        var parts = k2.split(",")
        var fx = box.x1 + Number(parts[0]), fz = box.z1 + Number(parts[1])
        if (lowest[k2] - floorY > 1) continue         // под навесом и балконом земляных столбов не надо
        var fromY = base + lowest[k2] - floorY        // сразу под нижним блоком постройки
        if (fromY < base) continue
        // на склоне земля под низовой стеной ниже основания - фундамент доводим до неё,
        // иначе дом с одной стороны висит над обрывом
        var terrain = stTop(level, fx, fz)
        var down = Math.min(base - ST_BURY, terrain)
        if (base - down > 14) down = base - 14
        var ground = stGroundState(level, fx, fz)
        found.push("execute in " + box.dim + " run fill " + fx + " " + down + " " + fz + " " +
            fx + " " + fromY + " " + fz + " " + ground + " replace")
    }

    stQueue(stKeepOff(cmds, guard))
    stQueue(stKeepOff(found, guard))
    stQueue(stKeepOff(apron, guard))

    // наполнение - после того, как блоки встанут
    ST_QUEUE.push({
        cmds: [], i: 0, after: () => {
            var profile = stProfile(tpl.name || name, tpl)          // назначение постройки нужно ДО манекенов
            var metals = stSpawnStands(tpl, box, base, steps, sx, sz, level, profile, foot0.mask)
            var metalList = []
            for (var m in metals) metalList.push(m)
            if (metalList.length) ST_REPAIR = metalList          // в ящики пойдёт металл здешних доспехов

            var levels = stFloors(level, box, base, tpl.size[1], foot0.mask)
            var wood = stMainWood(tpl)
            var filled = 0
            stArmory(profile === "форт" || profile === "башня")   // свой арсенал у каждой постройки
            containers.sort((a, b) => (b.id.indexOf("tool_rack") >= 0 ? 1 : 0) - (a.id.indexOf("tool_rack") >= 0 ? 1 : 0))
            containers.forEach(c => {
                var floor = 0
                for (var i = 0; i < levels.length; i++) if (c.y >= levels[i] - 1) floor = i
                var room = stRoom(profile, floor, Math.max(1, levels.length))
                var items = stContents(c.id, room, wood, opts && opts.trade, profile === "форт" || profile === "башня")
                if (stFill(level, c.x, c.y, c.z, c.id, items) > 0) filled++
            })
            stLog(name + ": наполнено контейнеров " + filled + " из " + containers.length)
            var lit = 0
            lamps.forEach(l => { if (stLightLamp(level, l.x, l.y, l.z)) lit++ })
            if (lamps.length) stLog(name + ": заправлено фонарей " + lit + " из " + lamps.length)
            candles.forEach(c => stKeepCandle(level, c.x, c.y, c.z))
            var filledPiles = 0
            piles.forEach(p => { if (stFillPile(level, p.x, p.y, p.z, p.id)) filledPiles++ })
            if (piles.length) stLog(name + ": наполнено кладок " + filledPiles + " из " + piles.length)
        }
    })

    // где вход в мировых координатах: улица тянет дорожку именно к двери, а не к случайной стене
    var doorRec = null
    if (doorPre) door = doorPre                       // наружу ведут ворота, а не межкомнатная дверь
    if (door) {
        var dpr = stRotatePos(door.x, door.z, tpl.size[0], tpl.size[2], steps)
        var ovr = stTurnVec(door.out || { dx: 0, dz: 0 }, steps)
        doorRec = {
            x: box.x1 + dpr[0], y: base + 1 + door.y - floorY, z: box.z1 + dpr[1],
            facing: stTurn(door.facing, steps), out: ovr,
        }
    }

    var rec = {
        zone: zoneId, dim: box.dim, name: name, x: box.x1, y: base, z: box.z1,
        size: size, steps: steps, containers: containers.length, door: doorRec,
    }
    stLog(name + ": поставлено на " + box.x1 + " " + base + " " + box.z1 + ", поворот " + (steps * 90) +
        "°, контейнеров " + containers.length + ", зона " + zoneId)
    return rec
}

global.TFG_STRUCTURES = {
    place: (level, x, z, name, steps, owner, opts) => stPlace(level, x, z, name, steps, owner, opts),
    busy: () => ST_QUEUE.length > 0,          // улица ждёт, пока постройки не встанут
    decoMetals: ST_DECO_METALS,
    woods: ST_WOODS,
    rocks: ST_ROCKS,
    glassColors: ST_GLASS_COLORS,
    trades: ST_TRADES,
    top: (level, x, z) => stTop(level, x, z),
    // столбы с блоками постройки (по id её зоны): { cols: {"x,z": 1}, ... } или null
    core: zoneId => ST_CORE[String(zoneId)] || null,
    groundState: (level, x, z) => stGroundState(level, x, z),
    spotOk: (level, x, z, half, drop) => stSpotOk(level, x, z, half, drop),
    rotateState: (state, steps) => stRotateState(state, steps),
    info: name => stInfo(name),
    natural: id => !stIsBuilt(id),
    exists: id => stExists(id),                       // есть ли такой блок/предмет в сборке
    tool: kind => stGtTool(kind),                     // инструмент сборки по метке ("@меч")
    stackNbt: stack => stStackNbt(stack),             // предмет в виде SNBT для summon                    // для украшений: можно ли тут копать
    lightLamp: (level, x, y, z) => stLightLamp(level, x, y, z),                       // размер, камень, дерево и назначение шаблона
    profile: (name, tpl) => stProfile(name, tpl),
}

// ─── Чанки под командами ─────────────────────────────────────────────────────
//
// setblock и fill в незагруженном чанке молча ничего не делают. Очереди стройки, отката зон
// и троп идут десятки секунд, а прогрузка вокруг игрока держится не везде - и дома обрывались
// ровно по границам чанков, а откат оставлял куски старых построек. Теперь перед каждой
// командой проверяем её чанк: не загружен - ставим принудительную прогрузку и ждём. Когда
// все очереди пусты, прогрузку снимаем.

var ST_FORCED = {}                      // "dim|cx|cz" -> тик, когда ставили прогрузку
var ST_FORCE_LAST = 0
const ST_CMD_DIM = /^execute in ([a-z0-9_:\/.-]+) run /
const ST_CMD_POS = /run (?:setblock|fill|data merge block|summon [a-z0-9_:\/]+|place feature [a-z0-9_:\/]+) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?: (-?\d+) (-?\d+) (-?\d+))?/

/** Загружен ли чанк; нет - заказать прогрузку (не чаще раза в две секунды на чанк). */
function stChunkReady(dim, x, z) {
    if (!ST_SERVER) return true
    var level = null
    try { level = ST_SERVER.getLevel(dim) } catch (e) { }
    if (!level) return true
    var cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4
    var loaded = true
    try { loaded = !!level.hasChunk(cx, cz) } catch (e) { loaded = true }
    if (loaded) return true
    var key = dim + "|" + cx + "|" + cz
    var now = Number(ST_SERVER.getTickCount())
    if (!ST_FORCED[key] || now - ST_FORCED[key] > 40) {
        ST_FORCED[key] = now
        try { ST_SERVER.runCommandSilent("execute in " + dim + " run forceload add " + (cx * 16) + " " + (cz * 16)) } catch (e) { }
    }
    ST_FORCE_LAST = now
    return false
}

/** Можно ли выполнять команду: все чанки, которых она касается, загружены. */
function stCmdReady(cmd) {
    if (typeof cmd !== "string") return true
    var m = cmd.match(ST_CMD_POS)
    if (!m) {
        // по верхнему блоку клетки (street.js, srOnTop): "positioned x 0 z positioned over ..."
        var mp = cmd.match(/ positioned (-?\d+) -?\d+ (-?\d+) /)
        if (!mp) return true
        m = [null, mp[1], "0", mp[2]]
    }
    var dm = cmd.match(ST_CMD_DIM)
    var dim = dm ? dm[1] : "minecraft:overworld"
    var ax = Math.floor(Number(m[1])), az = Math.floor(Number(m[3]))
    var bx = m[4] ? Number(m[4]) : ax, bz = m[6] ? Number(m[6]) : az
    var ok = true
    for (var cx = Math.min(ax, bx) >> 4; cx <= Math.max(ax, bx) >> 4; cx++) {
        for (var cz = Math.min(az, bz) >> 4; cz <= Math.max(az, bz) >> 4; cz++) {
            if (!stChunkReady(dim, cx * 16, cz * 16)) ok = false
        }
    }
    return ok
}

/** Все очереди пусты уже двадцать секунд - снять свою прогрузку. */
function stForceRelease() {
    var keys = Object.keys(ST_FORCED)
    if (!keys.length || ST_QUEUE.length) return
    try { if (global.TFG_STREET.busy()) return } catch (e) { }
    try { if (global.TFG_ZONES.busy && global.TFG_ZONES.busy()) return } catch (e) { }
    if (Number(ST_SERVER.getTickCount()) - ST_FORCE_LAST < 400) return
    keys.forEach(k => {
        var p = k.split("|")
        try { ST_SERVER.runCommandSilent("execute in " + p[0] + " run forceload remove " + (Number(p[1]) * 16) + " " + (Number(p[2]) * 16)) } catch (e) { }
    })
    ST_FORCED = {}
    stLog("стройка закончена: принудительная прогрузка снята с чанков " + keys.length)
}

global.TFG_CHUNK_READY = cmd => stCmdReady(cmd)
global.TFG_CHUNK_READY_AT = (dim, x, z) => stChunkReady(dim, x, z)

// ─── Тик ─────────────────────────────────────────────────────────────────────

ServerEvents.tick(event => {
    if (!ST_SERVER) ST_SERVER = event.server
    if (!ST_QUEUE.length) {
        if (event.server.tickCount % 100 === 0) { try { stForceRelease() } catch (e) { stErr("снятие прогрузки", e) } }
        return
    }
    var job = ST_QUEUE[0]
    var n = 0
    while (job.i < job.cmds.length && n < ST_PER_TICK) {
        // чанк команды не загружен - ждём его (не дольше пятнадцати секунд на команду)
        if (!stCmdReady(job.cmds[job.i])) {
            job.wait = (job.wait || 0) + 1
            if (job.wait < 300) return
            stLog("чанк так и не загрузился - команда выполняется как есть: " + String(job.cmds[job.i]).substring(0, 90))
        }
        job.wait = 0
        stRun(job.cmds[job.i])
        job.i++
        n++
    }
    if (job.i >= job.cmds.length) {
        if (job.after) {
            try { job.after() } catch (e) { stErr("наполнение", e) }
        }
        ST_QUEUE.shift()
    }
})

// ─── Команды ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgstruct").requires(s => s.hasPermission(2))
            .then(Commands.literal("list").executes(ctx => {
                var names = []
                try { names = global.TFG_BLUEPRINTS.names() } catch (e) { }
                var rows = []
                names.forEach(n => {
                    var info = stInfo(String(n).replace(/ \(.*\)$/, ""))
                    rows.push(info ? (info.name + " - " + info.profile + ", " + info.size.join("x") +
                        ", камень " + (info.rock || "?") + ", дерево " + info.wood) : String(n))
                })
                rows.sort()
                ctx.source.sendSuccess(Text.of(names.length ? names.join("\n") : "§7шаблонов нет"), false)
                return 1
            }))
            // снос без слепка: для построек, у которых зона потерялась
            .then(Commands.literal("wipe").then(Commands.argument("радиус", Arguments.INTEGER.create(event)).executes(ctx => {
                if (!ST_SERVER) ST_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var r = Math.max(4, Math.min(80, Number(Arguments.INTEGER.getResult(ctx, "радиус"))))
                var n = stWipe(p.level, Math.floor(p.getX()), Math.floor(p.getZ()), r, String(p.uuid))
                ctx.source.sendSuccess(Text.of("Сношу рукотворное в радиусе " + r + ": блоков " + n +
                    ". Природу не трогаю, ямы засыпаю."), false)
                return 1
            })))
            .then(Commands.literal("remove").executes(ctx => {
                if (!ST_SERVER) ST_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var best = null, bestD = 1e18
                global.TFG_ZONES.list().forEach(zn => {
                    if (String(zn.label).indexOf("постройка") !== 0) return
                    var d = Math.pow(zn.box.x1 - p.getX(), 2) + Math.pow(zn.box.z1 - p.getZ(), 2)
                    if (d < bestD) { bestD = d; best = zn }
                })
                if (!best) { ctx.source.sendFailure(Text.of("Рядом нет поставленных построек.")); return 1 }
                var err = global.TFG_ZONES.restore(best.id, "команда")
                ctx.source.sendSuccess(Text.of(err ? "§c" + err : "Убираю постройку, рельеф вернётся как был."), false)
                return 1
            }))
            // имя можно указать сразу: /tfgstruct place особняк (поворот подберётся сам),
            // а если первым словом стоит число - это градусы: /tfgstruct place 90 особняк
            .then(Commands.literal("place").then(Commands.argument("имя", Arguments.GREEDY_STRING.create(event)).executes(ctx => {
                if (!ST_SERVER) ST_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var raw = String(Arguments.GREEDY_STRING.getResult(ctx, "имя")).trim()
                var deg = null, nm = raw
                var m = raw.match(/^(-?\d+)\s+(.+)$/)
                if (m) { deg = Number(m[1]); nm = m[2] }
                var res = stPlace(p.level, Math.floor(p.getX()) + 8, Math.floor(p.getZ()) + 8, nm,
                    (deg === null || deg < 0) ? null : Math.round(deg / 90), String(p.uuid))
                if (typeof res === "string") ctx.source.sendFailure(Text.of("§c" + res))
                else ctx.source.sendSuccess(Text.of("Поставлено: " + nm + " на " + res.x + " " + res.y + " " + res.z +
                    ", поворот " + (res.steps * 90) + "°, контейнеров " + res.containers), false)
                return 1
            })))
            .then(Commands.literal("ставить").then(Commands.argument("градусы", Arguments.INTEGER.create(event))
                .then(Commands.argument("имя", Arguments.GREEDY_STRING.create(event)).executes(ctx => {
                    if (!ST_SERVER) ST_SERVER = ctx.source.getServer()
                    var p = ctx.source.getPlayerOrException()
                    var deg = Number(Arguments.INTEGER.getResult(ctx, "градусы"))   // -1 - развернуть самому
                    var name = String(Arguments.GREEDY_STRING.getResult(ctx, "имя")).trim()
                    var res = stPlace(p.level, Math.floor(p.getX()) + 8, Math.floor(p.getZ()) + 8, name,
                        deg < 0 ? null : Math.round(deg / 90), String(p.uuid))
                    if (typeof res === "string") ctx.source.sendFailure(Text.of("§c" + res))
                    else ctx.source.sendSuccess(Text.of("Поставлено: " + name + " на " + res.x + " " + res.y + " " + res.z +
                        ", поворот " + (res.steps * 90) + "°, контейнеров " + res.containers), false)
                    return 1
                })))))
    } catch (err) {
        console.error("[structures] ошибка регистрации команд: " + err)
    }
})
