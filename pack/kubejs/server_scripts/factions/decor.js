"use strict";
/**
 * ОБЖИТОСТЬ ПОСЕЛЕНИЯ: заборы вдоль троп, фонари на них, огороды, поле и промышленный квартал.
 *
 * Всё ставится ПОСЛЕ построек и троп, поэтому знает, где уже занято. Блоки идут той же
 * очередью команд, что и тропы, а клетки отдаются наружу - чтобы попасть в зоны отката.
 *
 * Правила:
 *   - забор вдоль тропы - примерно на каждом пятом отрезке, короткими пряслами;
 *   - на некоторых столбах - фонарь, залитый лавой и зажжённый;
 *   - двор огорожен примерно у каждого третьего дома, с проёмом напротив входа;
 *   - у дома грядка не больше десяти вспаханных клеток;
 *   - одно общее поле на поселение;
 *   - промышленный квартал: коксовая печь, бак с креозотом на опорах, куча угля, штабеля брёвен.
 *
 * Культуры выбираются по здешнему климату (TFC знает среднюю температуру точки).
 */

// ─── Что и из чего ───────────────────────────────────────────────────────────

const DC_FENCE_CHANCE = 0.5          // доля отрезков тропы с пряслом
const DC_YARD_CHANCE = 0.9           // доля дворов с оградой
const DC_YARD_PART = 0.4             // и какая доля периметра ею занята
const DC_LAMP_CHANCE = 1.0           // фонарь есть на каждом прясле
const DC_GARDEN_MAX = 10             // предел вспаханных клеток у дома
const DC_IND_R = 6                   // полуширина промквартала (13x13)
const DC_OUT_GAP = 18                // поле и промквартал - сразу за кольцом, а не в чистом поле

// Фонарь вечен только из синей стали: в данных TFC лава горит без расхода именно в нём.
const DC_LAMP = "tfc:metal/lamp/blue_steel"

// Пределы культур сняты с данных TFC (climate_ranges/crop/*.json): температура и
// влажность почвы. Сеем только то, что здесь действительно вырастет.
// Двухчастные стебли (кукуруза, джут, тростник, фасоль, томат) пропускаем: одной
// командой такой блок не поставить.
const DC_CROP_RANGE = {
    barley: [-8, 26, 18, 75], beet: [-5, 20, 18, 85], cabbage: [-10, 27, 15, 65],
    carrot: [3, 30, 25, 100], garlic: [-20, 18, 15, 75], oat: [3, 40, 35, 100],
    onion: [0, 30, 25, 90], potato: [-1, 37, 50, 100], red_bell_pepper: [16, 30, 25, 60],
    rice: [15, 30, 25, 100], rye: [-11, 30, 25, 85], soybean: [8, 30, 40, 100],
    squash: [5, 33, 23, 95], wheat: [-4, 35, 25, 100], yellow_bell_pepper: [16, 30, 25, 60],
}
// предельная стадия роста: выше такого состояния не существует
const DC_CROP_AGE = {
    wheat: 7, rice: 7, oat: 7, rye: 7, barley: 7, squash: 7, potato: 6, onion: 6,
    soybean: 6, red_bell_pepper: 6, yellow_bell_pepper: 6, cabbage: 5, beet: 5,
    garlic: 4, carrot: 4,
}

function dcLog(t) { try { console.log("[обжитость] " + t) } catch (e) { } }
function dcErr(w, e) { try { console.error("[обжитость] " + w + ": " + e) } catch (err) { } }
function dcPick(list) { return list[Math.floor(Math.random() * list.length)] }

/** Средняя температура в точке: по ней и выбираем, что тут растёт. */
var DC_Climate = null
function dcTemperature(level, x, z) {
    try {
        if (!DC_Climate) DC_Climate = Java.loadClass("net.dries007.tfc.util.climate.Climate")
        var BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
        return Number(DC_Climate.getAverageTemperature(level, new BlockPos(Math.round(x), 70, Math.round(z))))
    } catch (e) {
        return 12                                     // климат не спросился - считаем умеренным
    }
}

/** Влажность почвы TFC: дождь 0..500 переводится в 0..100. */
function dcHydration(level, x, z) {
    try {
        if (!DC_Climate) DC_Climate = Java.loadClass("net.dries007.tfc.util.climate.Climate")
        var BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
        var rain = Number(DC_Climate.getRainfall(level, new BlockPos(Math.round(x), 70, Math.round(z))))
        return Math.max(0, Math.min(100, rain / 5))
    } catch (e) {
        return 50
    }
}

/** Что здесь вырастет: и по теплу, и по влаге, с запасом от края диапазона. */
function dcCrops(level, x, z) {
    var t = dcTemperature(level, x, z)
    var h = dcHydration(level, x, z)
    var out = []
    for (var name in DC_CROP_RANGE) {
        var r = DC_CROP_RANGE[name]
        if (t < r[0] + 2 || t > r[1] - 2) continue
        if (h < r[2] + 3 || h > r[3] - 3) continue
        out.push(name)
    }
    if (!out.length) out = ["barley", "wheat", "oat"]        // совсем суровое место
    return out
}

/** Верхний блок и что это за грунт. */
function dcTop(level, x, z) {
    try { return global.TFG_STRUCTURES.top(level, Math.round(x), Math.round(z)) } catch (e) { return 70 }
}

function dcSoil(level, x, z) {
    var id = ""
    try { id = String(global.TFG_STRUCTURES.groundState(level, x, z)) } catch (e) { }
    var m = id.match(/tfc:(?:dirt|grass|farmland)\/([a-z_]+)/)
    return m ? m[1] : "loam"
}

/** Свободна ли клетка под украшение: земля, не тропа, не постройка. */
function dcFree(level, x, z, busy) {
    var k = Math.round(x) + "," + Math.round(z)
    if (busy && busy[k]) return false
    var y = dcTop(level, x, z)
    var id = ""
    try { id = String(level.getBlock(Math.round(x), y, Math.round(z)).id) } catch (e) { return false }
    if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0) return false
    if (id.indexOf("grass_path") >= 0) return false
    try { if (!global.TFG_STRUCTURES.natural(id)) return false } catch (e) { }
    return true
}

// ─── Заборы и фонари ─────────────────────────────────────────────────────────

/**
 * Прясло вдоль тропы: короткий участок забора в стороне от полотна.
 * Ставим не подряд, а примерно на каждом пятом отрезке - иначе поселение выглядит загоном.
 */
function dcFenceAlong(level, pts, wood, metal, cmds, busy, dim) {
    var fence = "tfc:wood/planks/" + wood + "_fence"
    var made = 0
    for (var i = 4; i < pts.length - 2; i += 3) {
        if (Math.random() > DC_FENCE_CHANCE) continue
        var a = pts[i], b = pts[i + 1]
        var dx = b.x - a.x, dz = b.z - a.z
        var len = Math.sqrt(dx * dx + dz * dz) || 1
        var nx = -dz / len, nz = dx / len
        var side = Math.random() < 0.5 ? 1 : -1
        var run = 3 + Math.floor(Math.random() * 4)          // прясло в три-шесть столбов
        var withLamp = Math.random() < DC_LAMP_CHANCE
        for (var s = 0; s < run; s++) {
            var p = pts[Math.min(pts.length - 1, i + s)]
            var fx = Math.round(p.x + nx * side * 2.5), fz = Math.round(p.z + nz * side * 2.5)
            if (!dcFree(level, fx, fz, busy)) continue
            var y = dcTop(level, fx, fz)
            cmds.push("execute in " + dim + " run setblock " + fx + " " + (y + 1) + " " + fz + " " + fence + " replace")
            busy[fx + "," + fz] = 1
            made++
            if (withLamp && s === Math.floor(run / 2)) {
                // погашенным: огонь даст заправка, иначе фонарь потухнет навсегда
                var lamp = DC_LAMP + "[hanging=false,lit=false]"
                cmds.push("execute in " + dim + " run setblock " + fx + " " + (y + 2) + " " + fz + " " + lamp + " replace")
                cmds.push({ lamp: true, x: fx, y: y + 2, z: fz })     // залить лавой при укладке
            }
        }
    }
    return made
}

/** Ограда двора: прямоугольник вокруг пятна с проёмом напротив входа. */
function dcYardFence(level, b, wood, cmds, busy, dim) {
    var fence = "tfc:wood/planks/" + wood + "_fence"
    var gate = "tfc:wood/planks/" + wood + "_fence_gate"
    var pad = 3
    var x1 = b.x - pad, x2 = b.x + b.size[0] - 1 + pad
    var z1 = b.z - pad, z2 = b.z + b.size[2] - 1 + pad
    var door = b.door
    var made = 0
    // Ограда неполная: примерно сорок процентов периметра, кусками. Сплошной квадрат
    // вокруг каждого двора выглядит как загон.
    var runLeft = 0, skipLeft = 0
    var put = (x, z) => {
        if (!dcFree(level, x, z, busy)) return
        if (runLeft <= 0 && skipLeft <= 0) {
            if (Math.random() < DC_YARD_PART) runLeft = 3 + Math.floor(Math.random() * 5)
            else skipLeft = 3 + Math.floor(Math.random() * 6)
        }
        if (skipLeft > 0) { skipLeft--; return }
        runLeft--
        // напротив двери оставляем проём с калиткой
        var isGate = false
        if (door) {
            var out = door.out || { dx: 0, dz: 1 }
            var alongX = out.dx !== 0
            var near = alongX ? Math.abs(z - door.z) <= 1 : Math.abs(x - door.x) <= 1
            var ahead = alongX ? (x - door.x) * out.dx > 0 : (z - door.z) * out.dz > 0
            if (near && ahead) isGate = true
        }
        var y = dcTop(level, x, z)
        cmds.push("execute in " + dim + " run setblock " + x + " " + (y + 1) + " " + z + " " +
            (isGate ? gate + "[open=true]" : fence) + " replace")
        // на каждом пятом столбе ограды - фонарь
        if (!isGate && made % 5 === 4) {
            cmds.push("execute in " + dim + " run setblock " + x + " " + (y + 2) + " " + z + " " +
                DC_LAMP + "[hanging=false,lit=false] replace")
            cmds.push({ lamp: true, x: x, y: y + 2, z: z })
        }
        busy[x + "," + z] = 1
        made++
    }
    for (var x = x1; x <= x2; x++) { put(x, z1); put(x, z2) }
    for (var z = z1 + 1; z < z2; z++) { put(x1, z); put(x2, z) }
    return made
}

// ─── Грядки и поле ───────────────────────────────────────────────────────────

/** Вспаханная клетка с посевом: пашня внизу, культура сверху. */
function dcTill(level, x, z, crop, cmds, busy, dim) {
    if (!dcFree(level, x, z, busy)) return false
    var y = dcTop(level, x, z)
    var soil = dcSoil(level, x, z)
    var maxAge = DC_CROP_AGE[crop] === undefined ? 4 : DC_CROP_AGE[crop]
    var age = Math.min(maxAge, 2 + Math.floor(Math.random() * 4))
    cmds.push("execute in " + dim + " run setblock " + x + " " + y + " " + z + " tfc:farmland/" + soil + " replace")
    cmds.push("execute in " + dim + " run setblock " + x + " " + (y + 1) + " " + z +
        " tfc:crop/" + crop + "[age=" + age + "] replace")
    busy[x + "," + z] = 1
    return true
}

/** Грядка у дома: не больше десяти клеток, с краю от входа. */
function dcGarden(level, b, cmds, busy, dim) {
    var crops = dcCrops(level, b.x, b.z)
    var crop = dcPick(crops)
    var w = 2 + Math.floor(Math.random() * 2)          // 2-3
    var h = 2 + Math.floor(Math.random() * 2)
    if (w * h > DC_GARDEN_MAX) h = Math.floor(DC_GARDEN_MAX / w)
    var side = Math.random() < 0.5 ? -1 : 1
    var ox = b.x + (side > 0 ? b.size[0] + 2 : -w - 2)
    var oz = b.z + Math.floor(b.size[2] / 2) - Math.floor(h / 2)
    // грядка вплотную к настоящей стене, а не к краю коробки шаблона
    var core = null
    try { core = global.TFG_STRUCTURES.core(b.zone) } catch (e) { }
    if (core) {
        var midZ = b.z + Math.floor(b.size[2] / 2)
        var gx = b.x + Math.floor(b.size[0] / 2)
        for (var gs = 0; gs < b.size[0] && core.near[gx + "," + midZ]; gs++) gx += side
        ox = side > 0 ? gx : gx - w + 1
    }
    var made = 0
    for (var i = 0; i < w; i++) {
        for (var j = 0; j < h; j++) {
            if (made >= DC_GARDEN_MAX) break
            if (dcTill(level, ox + i, oz + j, crop, cmds, busy, dim)) made++
        }
    }
    return made
}

/** Доля свободных клеток в квадрате: место под поле и промквартал ищем по ней. */
function dcSpotFree(level, cx, cz, r, busy) {
    var free = 0, total = 0
    for (var x = cx - r; x <= cx + r; x += 2) {
        for (var z = cz - r; z <= cz + r; z += 2) {
            total++
            if (dcFree(level, x, z, busy)) free++
        }
    }
    return total ? free / total : 0
}

/** Место подальше от дворов: перебираем углы и расстояния, пока не найдём простор. */
function dcFindSpot(level, cx, cz, from, to, r, busy) {
    for (var i = 0; i < 24; i++) {
        var ang = Math.random() * 6.283185307179586
        var rad = from + Math.random() * (to - from)
        var x = Math.round(cx + Math.cos(ang) * rad), z = Math.round(cz + Math.sin(ang) * rad)
        if (dcSpotFree(level, x, z, r, busy) > 0.85) return { x: x, z: z }
    }
    return null
}

/** Общее поле поселения: пашня с посевами и межой. */
function dcField(level, cx, cz, ang, r, wood, cmds, busy, dim) {
    var spot = dcFindSpot(level, cx, cz, r, r + 40, 12, busy)
    if (!spot) return { cells: 0, x: cx, z: cz, crop: "-" }
    var fx = spot.x, fz = spot.z
    var crops = dcCrops(level, fx, fz)
    var crop = dcPick(crops)
    var crop2 = dcPick(crops)
    var w = 14 + Math.floor(Math.random() * 8), h = 12 + Math.floor(Math.random() * 8)
    fx -= Math.floor(w / 2)                           // место искали серединой поля, а не углом
    fz -= Math.floor(h / 2)
    var made = 0
    for (var i = 0; i < w; i++) {
        for (var j = 0; j < h; j++) {
            // межа через каждые шесть борозд: по полю должно быть где пройти
            if (j % 6 === 5) continue
            // поле делится надвое: две культуры рядом смотрятся живее
            var which = i < w / 2 ? crop : crop2
            if (dcTill(level, fx + i, fz + j, which, cmds, busy, dim)) made++
        }
    }
    return { cells: made, x: fx, z: fz, crop: crop }
}

// ─── Промышленный квартал ────────────────────────────────────────────────────

/**
 * Коксовая печь, бак с креозотом на опорах, куча угля и штабеля брёвен.
 * Печь собираем как положено многоблоку: коробка три на три из коксового кирпича,
 * контроллер и люк на разных гранях.
 */
/** Тропа того же вида, что и в поселении: снятый дёрн по местной почве. */
function dcPathMat(level, x, z) {
    var soil = dcSoil(level, x, z)
    var known = ["loam", "silty_loam", "sandy_loam", "silt"]
    return "tfc:grass_path/" + (known.indexOf(soil) >= 0 ? soil : "loam")
}

function dcIndustry(level, cx, cz, wood, cmds, busy, dim, rock) {
    // Квартал тесный, 13x13: печь, бак, куча угля и штабеля стоят почти вплотную.
    // Встать он должен на свободное место, иначе печь окажется в чьём-то огороде.
    var R = DC_IND_R
    var spot = dcSpotFree(level, Math.round(cx), Math.round(cz), R, busy) > 0.85
        ? { x: Math.round(cx), z: Math.round(cz) } : null
    if (!spot) spot = dcFindSpot(level, cx, cz, 6, 40, R, busy)
    if (!spot) { dcLog("для промквартала не нашлось места"); return 0 }
    var x0 = spot.x, z0 = spot.z
    var base = dcTop(level, x0, z0)
    var made = 0
    var taken = {}                                    // клетки, где стоит хозяйство: по ним тропу не ведём
    var take = (x1, z1, x2, z2) => {
        for (var x = x1; x <= x2; x++) for (var z = z1; z <= z2; z++) taken[x + "," + z] = 1
    }

    // площадка: ровняем землю под квартал
    for (var px = -R; px <= R; px++) {
        for (var pz = -R; pz <= R; pz++) {
            var tx = x0 + px, tz = z0 + pz
            var ty = dcTop(level, tx, tz)
            if (Math.abs(ty - base) > 3) continue
            if (ty !== base) {
                var soil = "tfc:dirt/" + dcSoil(level, tx, tz)
                if (ty < base) cmds.push("execute in " + dim + " run fill " + tx + " " + (ty + 1) + " " + tz + " " +
                    tx + " " + base + " " + tz + " " + soil + " replace")
                else cmds.push("execute in " + dim + " run fill " + tx + " " + (base + 1) + " " + tz + " " +
                    tx + " " + ty + " " + tz + " minecraft:air replace")
            }
        }
    }

    // коксовая печь: 3x3x3 из коксового кирпича, внутри пусто
    var ox = x0 - 5, oz = z0 - 5
    for (var bx = 0; bx < 3; bx++) {
        for (var by = 0; by < 3; by++) {
            for (var bz = 0; bz < 3; bz++) {
                var inside = bx === 1 && by === 1 && bz === 1
                var id = inside ? "minecraft:air" : "gtceu:coke_oven_bricks"
                cmds.push("execute in " + dim + " run setblock " + (ox + bx) + " " + (base + 1 + by) + " " +
                    (oz + bz) + " " + id + " replace")
                made++
            }
        }
    }
    cmds.push("execute in " + dim + " run setblock " + (ox + 1) + " " + (base + 2) + " " + oz +
        " gtceu:coke_oven replace")                                     // контроллер
    cmds.push("execute in " + dim + " run setblock " + (ox + 1) + " " + (base + 2) + " " + (oz + 2) +
        " gtceu:coke_oven_hatch replace")                               // люк для загрузки
    take(ox, oz, ox + 2, oz + 2)

    // Бак с креозотом - настоящий многоблок GregTech (bronze_multiblock_tank, 500 000 мБ).
    // Схема мода: короб 3x3x3 из бронзовых кирпичных корпусов, пустой центр, контроллер в
    // середине грани лицом наружу, до двух вентилей на клетках корпуса. Прежний короб 4x4x4
    // с пустотой 2x2x2 мод не признавал - бак был просто декором. Стоит на опорах.
    var tx0 = x0 + 2, tz0 = z0 - 5
    dcTank(cmds, dim, tx0, tz0, base, "tfc:wood/planks/" + wood + "_fence")
    take(tx0, tz0, tx0 + 2, tz0 + 2)

    // Куча угля: настоящая гора из угля сборки. Ванильный угольный блок в TFG чужой,
    // поэтому берём уголь в породе поселения - его же и добывают.
    var coal = "tfc:ore/bituminous_coal/" + (rock || "andesite")
    try { if (global.TFG_STRUCTURES.exists && global.TFG_STRUCTURES.exists("gtceu:coal_block")) coal = "gtceu:coal_block" } catch (e) { }
    var kx = x0 - 3, kz = z0 + 3
    for (var cx2 = -3; cx2 <= 3; cx2++) {
        for (var cz2 = -3; cz2 <= 3; cz2++) {
            var d = Math.max(Math.abs(cx2), Math.abs(cz2)) + (Math.abs(cx2) + Math.abs(cz2)) / 3
            var hgt = Math.round(3.5 - d)                     // конус: в середине выше
            if (hgt <= 0) continue
            cmds.push("execute in " + dim + " run fill " + (kx + cx2) + " " + (base + 1) + " " + (kz + cz2) + " " +
                (kx + cx2) + " " + (base + hgt) + " " + (kz + cz2) + " " + coal + " replace")
            taken[(kx + cx2) + "," + (kz + cz2)] = 1
        }
    }

    // штабеля брёвен
    var lx = x0 + 2, lz = z0 + 2
    for (var sx = 0; sx < 3; sx++) {
        for (var sy = 0; sy < 2; sy++) {
            cmds.push("execute in " + dim + " run fill " + (lx + sx * 2) + " " + (base + 1 + sy) + " " + lz + " " +
                (lx + sx * 2) + " " + (base + 1 + sy) + " " + (lz + 2) + " tfc:log_pile[axis=z] replace")
        }
        take(lx + sx * 2, lz, lx + sx * 2, lz + 2)
    }
    // Тропа по кварталу: от печи к баку, куче и штабелям - чтобы ходить, а не лазать.
    // Раньше весь квартал заранее помечался занятым, и тропа не ложилась вовсе.
    var walkw = [[ox + 1, oz + 4], [x0, z0], [tx0 + 1, tz0 + 4], [x0, z0], [kx + 3, kz - 2], [x0, z0], [lx + 2, lz - 1]]
    for (var wi = 0; wi < walkw.length - 1; wi++) {
        var a = walkw[wi], b2 = walkw[wi + 1]
        var steps2 = Math.max(Math.abs(b2[0] - a[0]), Math.abs(b2[1] - a[1]))
        for (var si2 = 0; si2 <= steps2; si2++) {
            var wx2 = Math.round(a[0] + (b2[0] - a[0]) * si2 / Math.max(1, steps2))
            var wz2 = Math.round(a[1] + (b2[1] - a[1]) * si2 / Math.max(1, steps2))
            for (var ww = -1; ww <= 1; ww++) {
                var px3 = wx2 + ww, pz3 = wz2
                if (taken[px3 + "," + pz3] || !dcFree(level, px3, pz3, busy)) continue
                var py3 = dcTop(level, px3, pz3)
                cmds.push("execute in " + dim + " run setblock " + px3 + " " + py3 + " " + pz3 + " " +
                    dcPathMat(level, px3, pz3) + " replace")
                taken[px3 + "," + pz3] = 1
            }
        }
    }
    // весь квартал - занят: зона должна его накрыть, а огороды и заборы сюда не лезут
    for (var qx = -R; qx <= R; qx++) for (var qz = -R; qz <= R; qz++) busy[(x0 + qx) + "," + (z0 + qz)] = 1
    return made
}

/** Бак на опорах: угол (tx0, tz0), опоры base+1..base+2, короб base+3..base+5. */
function dcTank(cmds, dim, tx0, tz0, base, post) {
    ;[[0, 0], [2, 0], [0, 2], [2, 2]].forEach(p => {
        cmds.push("execute in " + dim + " run fill " + (tx0 + p[0]) + " " + (base + 1) + " " + (tz0 + p[1]) + " " +
            (tx0 + p[0]) + " " + (base + 2) + " " + (tz0 + p[1]) + " " + post + " replace")
    })
    var shell = "gtceu:bronze_brick_casing"
    for (var ux = 0; ux <= 2; ux++) {
        for (var uy = 0; uy <= 2; uy++) {
            for (var uz = 0; uz <= 2; uz++) {
                var hollow = ux === 1 && uy === 1 && uz === 1
                cmds.push("execute in " + dim + " run setblock " + (tx0 + ux) + " " + (base + 3 + uy) + " " +
                    (tz0 + uz) + " " + (hollow ? "minecraft:air" : shell) + " replace")
            }
        }
    }
    cmds.push("execute in " + dim + " run setblock " + (tx0 + 1) + " " + (base + 4) + " " + tz0 +
        " gtceu:bronze_multiblock_tank[facing=north] replace")         // контроллер: середина северной грани
    // вентиль - как в собранном баке GregTech (превью мода): середина днища, выходом вниз
    cmds.push("execute in " + dim + " run setblock " + (tx0 + 1) + " " + (base + 3) + " " + (tz0 + 1) +
        " gtceu:bronze_tank_valve[facing=down] replace")
}

// ─── Точка входа ─────────────────────────────────────────────────────────────

/**
 * ctx: { level, dim, fx, fz, ringR, wood, metal, placed, paths, cmds, busy, cells }
 * cells - сюда складываем координаты, чтобы улица накрыла их зонами отката.
 */
function dcBuild(ctx) {
    var level = ctx.level, dim = ctx.dim, cmds = ctx.cmds
    var busy = ctx.busy || {}
    var wood = ctx.wood || "oak"
    var metal = "blue_steel"
    var fences = 0, yards = 0, beds = 0

    // Дома стоят тесно, поэтому перед каждой дверью держим проход: пять клеток вперёд и
    // три в ширину. Ни забор, ни грядка соседа не должны запереть вход.
    ;(ctx.placed || []).forEach(b => {
        if (!b.door) return
        var o = b.door.out || { dx: 0, dz: 1 }
        for (var s = 0; s <= 5; s++) for (var w = -1; w <= 1; w++)
            busy[(b.door.x + o.dx * s + (o.dx ? 0 : w)) + "," + (b.door.z + o.dz * s + (o.dz ? 0 : w))] = 1
    })

    ;(ctx.paths || []).forEach(pts => { fences += dcFenceAlong(level, pts, wood, metal, cmds, busy, dim) })

    ;(ctx.placed || []).forEach(b => {
        if (b.type === "форт" || b.type === "башня") return
        if (Math.random() < DC_YARD_CHANCE * 0.5) yards += dcYardFence(level, b, wood, cmds, busy, dim)   // в тесноте оград меньше
        beds += dcGarden(level, b, cmds, busy, dim)
    })

    // промквартал первым: ему нужно меньше места, но в определённой стороне; поле подстроится
    var ind = dcIndustry(level, ctx.fx + Math.cos(ctx.indAng || 2.2) * (ctx.ringR + DC_OUT_GAP),
        ctx.fz + Math.sin(ctx.indAng || 2.2) * (ctx.ringR + DC_OUT_GAP), wood, cmds, busy, dim, ctx.rock)
    var field = dcField(level, ctx.fx, ctx.fz, Math.random() * 6.283185307179586, ctx.ringR + DC_OUT_GAP, wood, cmds, busy, dim)

    // все затронутые клетки отдаём улице - она накроет их зонами
    if (ctx.cells) for (var k in busy) ctx.cells[k] = 1

    dcLog("забора " + fences + " столбов, дворов огорожено " + yards + ", грядок " + beds +
        " клеток, поле " + field.cells + " (" + field.crop + "), промквартал " + ind + " блоков")
    return { fences: fences, yards: yards, beds: beds, field: field }
}

global.TFG_DECOR = {
    build: ctx => dcBuild(ctx),
    crops: (level, x, z) => dcCrops(level, x, z),
    tank: (cmds, dim, tx0, tz0, base, post) => dcTank(cmds, dim, tx0, tz0, base, post),
    temperature: (level, x, z) => dcTemperature(level, x, z),
}
