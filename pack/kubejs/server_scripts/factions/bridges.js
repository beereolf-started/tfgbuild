"use strict";
/**
 * МОСТЫ КАРАВАНОВ. Караван, чей путь упирается в воду, ищет вдоль берега самое узкое место (до BR_SIDE
 * блоков в стороны), снимает слепок местности (global.TFG_ZONES, как стоянки) и кладёт по прямой от
 * берега до берега настил из брёвен шириной 3 блока: пологий - высота плавно идёт от одного берега к
 * другому и не ниже воды; над настилом - проход в 3 блока. Караван идёт строго по середине, друг за
 * другом. Все перешли (или вышло BR_TIME) - местность откатывается к слепку.
 * Вода караванам страшна (cvWaterFear в caravans.js): по ней они не ходят, пока там нет цели для атаки.
 * API: global.TFG_BRIDGES - steer, drop.
 */
const BR_BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
const BR_MAX = 48              // самый длинный пролёт
const BR_SIDE = 16             // насколько в стороны от пути искать узкое место
const BR_LOOK = 24             // насколько вперёд смотреть, нет ли воды
const BR_TIME = 6000           // дольше этого мост не стоит (5 минут), даже если кто-то застрял
const BR_GAP = 2.5             // шаг между идущими друг за другом
const BR_LOG = "tfc:wood/log/oak"

function brLog(msg) { try { global.tfgLog("tfg bridges", msg) } catch (e) { } }

/** Вода ли под ногами в этой точке (верхний блок столбца - жидкость). */
function brWet(level, x, z) {
    var y = gsSurface(level, x, z) - 1
    return !level.getFluidState(new BR_BlockPos(Math.floor(x), y, Math.floor(z))).isEmpty()
}

/** Пролёт по лучу (x,z)+(ux,uz)*t: a - последняя сухая клетка перед водой, b - первая сухая за ней. */
function brSpan(level, x, z, ux, uz) {
    var w = -1
    for (var t = 1; t <= BR_LOOK; t++) if (brWet(level, x + ux * t, z + uz * t)) { w = t; break }
    if (w < 0) return null
    var a = w - 1
    for (var s = w + 1; s <= w + BR_MAX; s++) if (!brWet(level, x + ux * s, z + uz * s)) return { a: a, b: s }
    return null
}

/** Высота, по которой идут, на отметке t моста: от берега к берегу плавно, над водой - не ниже её. */
function brDeckAt(b, t) {
    if (t <= 0) return b.ya
    if (t >= b.len) return b.yb
    return Math.max(b.water, Math.round(b.ya + (b.yb - b.ya) * t / b.len))
}

/** Где на мосту стоит существо: отметка вдоль пролёта (0 - начало, len - конец). */
function brProj(b, e) {
    return (e.getX() - b.ax) * b.ux + (e.getZ() - b.az) * b.uz
}

/** Построить мост для каравана, идущего от leader по (ux,uz). null - негде. */
function brBuild(v, level, now, leader, ux, uz) {
    var px = -uz, pz = ux                       // поперёк пути
    var best = null
    for (var o = -BR_SIDE; o <= BR_SIDE; o += 2) {
        var ox = leader.getX() + px * o, oz = leader.getZ() + pz * o
        var sp = brSpan(level, ox, oz, ux, uz)
        if (!sp) continue
        var len = sp.b - sp.a
        if (!best || len < best.len || len === best.len && Math.abs(o) < Math.abs(best.o)) best = { o: o, ox: ox, oz: oz, a: sp.a, b: sp.b, len: len }
    }
    if (!best) return null
    var ax = best.ox + ux * best.a, az = best.oz + uz * best.a
    var bx = best.ox + ux * best.b, bz = best.oz + uz * best.b
    var b = {
        ax: ax, az: az, ux: ux, uz: uz, len: best.len,
        ya: gsSurface(level, ax, az), yb: gsSurface(level, bx, bz),
        water: gsSurface(level, best.ox + ux * (best.a + 1), best.oz + uz * (best.a + 1)),
        until: now + BR_TIME
    }
    // клетки настила: вдоль - с заходом на оба берега, поперёк - три в ряд
    var cells = {}
    for (var t = -1; t <= b.len + 1; t += 0.5) {
        var y = brDeckAt(b, t) - 1
        for (var w = -1; w <= 1; w++) {
            var cx = Math.floor(ax + ux * t + px * w + 0.5), cz = Math.floor(az + uz * t + pz * w + 0.5)
            cells[cx + "," + cz] = Math.max(cells[cx + "," + cz] === undefined ? -999 : cells[cx + "," + cz], y)
        }
    }
    var x1 = 1e9, z1 = 1e9, x2 = -1e9, z2 = -1e9, y1 = 1e9, y2 = -1e9
    Object.keys(cells).forEach(k => {
        var p = k.split(","), cx = Number(p[0]), cz = Number(p[1]), y = cells[k]
        x1 = Math.min(x1, cx); x2 = Math.max(x2, cx); z1 = Math.min(z1, cz); z2 = Math.max(z2, cz)
        y1 = Math.min(y1, y); y2 = Math.max(y2, y)
    })
    var id = global.TFG_ZONES.snapshot(level, x1, y1 - 1, z1, x2, y2 + 4, z2, { label: "мост каравана " + v.id, ttl: BR_TIME + 600 })
    if (String(id).indexOf("z") !== 0) { brLog(v.id + ": мост не встал - " + id); return null }
    var zone = global.TFG_ZONES.get(id)
    var axis = Math.abs(ux) >= Math.abs(uz) ? "x" : "z"
    Object.keys(cells).forEach(k => {
        var p = k.split(","), cx = Number(p[0]), cz = Number(p[1]), y = cells[k]
        global.TFG_ZONES.set(zone, cx, y, cz, BR_LOG + "[axis=" + axis + "]")
        for (var h = 1; h <= 3; h++) global.TFG_ZONES.set(zone, cx, y + h, cz, "minecraft:air")
    })
    b.zone = id
    brLog(v.id + ": мост " + b.len + " блоков у " + Math.round(ax) + " " + Math.round(az) + " (сдвиг " + best.o + ")")
    return b
}

/**
 * Каждый тик каравана в пути. true - мост ведёт караван сам (обычную ходьбу не звать).
 * Нет моста - раз в секунду смотрит, не упирается ли путь в воду, и строит.
 */
function brSteer(v, level, now, leader, trader, guards, ahead) {
    var b = v.bridge
    if (!b) {
        if (now % 20 !== 0 || v.bridgeRest && now < v.bridgeRest) return false
        var dx = ahead.x - leader.getX(), dz = ahead.z - leader.getZ(), d = Math.sqrt(dx * dx + dz * dz)
        if (d < 4) return false
        var ux = dx / d, uz = dz / d
        var span = brSpan(level, leader.getX(), leader.getZ(), ux, uz)
        if (v.debugBridge) brLog(v.id + ": у " + Math.round(leader.getX()) + " " + Math.round(leader.getZ()) + " курс " +
            ux.toFixed(2) + " " + uz.toFixed(2) + " - " + (span ? "вода через " + (span.a + 1) + " бл., пролёт " + (span.b - span.a) : "воды впереди нет (или пролёт длиннее " + BR_MAX + ")"))
        if (!span) return false
        b = brBuild(v, level, now, leader, ux, uz)
        if (!b) { v.bridgeRest = now + 1200; if (v.debugBridge) brLog(v.id + ": мост построить не вышло"); return false }
        v.bridge = b
        gsSave()
    }
    // строго по середине, друг за другом: каждый следующий - на BR_GAP позади предыдущего по оси моста
    var people = [leader].concat([trader].concat(guards).filter(e => e && e !== leader && !e.isPassenger() && e.isAlive()))
    var lead = brProj(b, leader)
    people.forEach((e, i) => {
        var t = i === 0 ? b.len + 3 : Math.max(-6, Math.min(b.len + 3, lead - BR_GAP * i))
        var x = b.ax + b.ux * t, z = b.az + b.uz * t
        if (e.getNavigation().isDone() || now % 20 === 0) gsWalk(e, x, brDeckAt(b, t), z, i === 0 ? 0.7 : 0.9)
    })
    if (v.debugBridge && now % 100 === 0) brLog(v.id + ": на мосту, ведущий на отметке " + lead.toFixed(1) + " из " + b.len)
    var over = people.every(e => brProj(b, e) > b.len + 1)
    if (over || now > b.until) {
        brDrop(v, over ? "караван перешёл" : "время вышло")
        v.bridgeRest = now + 200
        return false
    }
    return true
}

/** Убрать мост каравана: местность - к слепку. */
function brDrop(v, why) {
    if (!v.bridge) return
    var zone = v.bridge.zone
    v.bridge = null
    gsSave()
    try { global.TFG_ZONES.restore(zone, "мост: " + why) } catch (e) { brLog("откат моста: " + e) }
    brLog(v.id + ": мост убран (" + why + ")")
}

global.TFG_BRIDGES = {
    steer: (v, level, now, leader, trader, guards, ahead) => brSteer(v, level, now, leader, trader, guards, ahead),
    drop: (v, why) => brDrop(v, why),
}
