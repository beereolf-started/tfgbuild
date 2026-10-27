// priority: 0
"use strict";
/**
 * БОЛЬШИЕ ДЕРЕВЬЯ ИЗ САЖЕНЦЕВ.
 *
 * В TFC у шестнадцати пород есть «вековой» вариант - секвойя-исполин, огромная ель, пихта,
 * кедр и прочие (worldgen tree/<порода>_large), - но вырастает он только при создании мира:
 * саженец всегда даёт обычное дерево (TFCTreeGrower берёт лишь normal_tree).
 *
 * Здесь это исправлено: четыре саженца одной породы, посаженные квадратом 2x2, вырастают
 * в одно вековое дерево. Растут они чуть быстрее одиночных (три четверти срока из настроек
 * TFC), чтобы успеть раньше, чем каждый саженец вырастет сам по себе обычным деревом.
 * Если квадрат разорван (саженец сорван, вырос, сгорел) - он просто забывается.
 */

const BT_KEY = "tfg_big_trees"
const BT_CHECK_EVERY = 400              // раз в двадцать секунд
const BT_SHARE = 0.75                   // доля срока одиночного саженца
// породы с вековым вариантом и дни роста саженца (defaultconfigs/tfc-server.toml)
const BT_DAYS = {
    acacia: 11, ash: 7, aspen: 8, birch: 7, blackwood: 8, chestnut: 7, douglas_fir: 7, hickory: 10,
    maple: 7, pine: 7, rosewood: 8, sequoia: 18, spruce: 7, sycamore: 8, white_cedar: 7, willow: 11,
}
const BT_NAMES = {
    acacia: "акации", ash: "ясеня", aspen: "осины", birch: "берёзы", blackwood: "чернодрева", chestnut: "каштана",
    douglas_fir: "пихты", hickory: "гикори", maple: "клёна", pine: "сосны", rosewood: "розового дерева",
    sequoia: "секвойи", spruce: "ели", sycamore: "платана", white_cedar: "кедра", willow: "ивы",
}

var BT_DATA = null
var BT_SERVER = null
var BT_Calendars = null

function btLog(t) { try { console.log("[большие деревья] " + t) } catch (e) { } }

function btLoad() {
    if (BT_DATA) return BT_DATA
    try { BT_DATA = JSON.parse(String(BT_SERVER.persistentData.getString(BT_KEY) || "{}")) } catch (e) { BT_DATA = {} }
    if (!BT_DATA.groups) BT_DATA.groups = {}
    return BT_DATA
}

function btSave() {
    try { BT_SERVER.persistentData.putString(BT_KEY, JSON.stringify(BT_DATA)) } catch (e) { btLog("сохранение: " + e) }
}

function btDay() {
    try {
        if (!BT_Calendars) BT_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
        return Number(BT_Calendars.SERVER.getTotalCalendarDays())
    } catch (e) {
        try { return Math.floor(Number(BT_SERVER.overworld().getTime()) / 24000) } catch (err) { return 0 }
    }
}

function btWood(id) {
    var m = String(id).match(/^tfc:wood\/sapling\/([a-z_]+)$/)
    return m && BT_DAYS[m[1]] ? m[1] : null
}

function btIdAt(level, x, y, z) {
    try { return String(level.getBlock(x, y, z).id) } catch (e) { return "" }
}

/** Все четыре клетки квадрата с северо-западным углом (x, z) - саженцы этой породы. */
function btSquare(level, x, y, z, wood) {
    var id = "tfc:wood/sapling/" + wood
    return btIdAt(level, x, y, z) === id && btIdAt(level, x + 1, y, z) === id &&
        btIdAt(level, x, y, z + 1) === id && btIdAt(level, x + 1, y, z + 1) === id
}

BlockEvents.placed(event => {
    try {
        var wood = btWood(event.block.id)
        if (!wood) return
        if (!BT_SERVER) BT_SERVER = event.level.getServer()
        var level = event.level
        var bx = event.block.x, by = event.block.y, bz = event.block.z
        var dim = String(level.getDimension())
        // посаженный саженец может быть любым углом квадрата
        for (var dx = -1; dx <= 0; dx++) {
            for (var dz = -1; dz <= 0; dz++) {
                var x = bx + dx, z = bz + dz
                if (!btSquare(level, x, by, z, wood)) continue
                var key = dim + "|" + x + "|" + by + "|" + z
                var data = btLoad()
                if (data.groups[key]) return
                data.groups[key] = { dim: dim, x: x, y: by, z: z, wood: wood, day: btDay() }
                btSave()
                try {
                    event.player.setStatusMessage(Text.of("§2Четыре саженца " + (BT_NAMES[wood] || wood) +
                        " квадратом вырастут в одно вековое дерево"))
                } catch (e) { }
                return
            }
        }
    } catch (e) { btLog("посадка: " + e) }
})

function btGrow(level, g) {
    var dim = g.dim
    var run = c => { try { return Number(BT_SERVER.runCommandSilent(c)) } catch (e) { return 0 } }
    var cells = [[0, 0], [1, 0], [0, 1], [1, 1]]
    cells.forEach(c => run("execute in " + dim + " run setblock " + (g.x + c[0]) + " " + g.y + " " + (g.z + c[1]) + " minecraft:air replace"))
    var ok = run("execute in " + dim + " run place feature tfc:tree/" + g.wood + "_large " + g.x + " " + g.y + " " + g.z) > 0
    if (!ok) {
        // негде встать (тесно, низко, плохая почва) - саженцы возвращаем, попробуем позже
        cells.forEach(c => run("execute in " + dim + " run setblock " + (g.x + c[0]) + " " + g.y + " " + (g.z + c[1]) +
            " tfc:wood/sapling/" + g.wood + " replace"))
    }
    return ok
}

ServerEvents.tick(event => {
    if (event.server.tickCount % BT_CHECK_EVERY !== 0) return
    if (!BT_SERVER) BT_SERVER = event.server
    try {
        var data = btLoad()
        var today = btDay()
        var changed = false
        for (var key in data.groups) {
            var g = data.groups[key]
            var level = null
            try { level = event.server.getLevel(g.dim) } catch (e) { }
            if (!level) continue
            try { if (!level.hasChunk(g.x >> 4, g.z >> 4) || !level.hasChunk((g.x + 1) >> 4, (g.z + 1) >> 4)) continue } catch (e) { continue }
            if (!btSquare(level, g.x, g.y, g.z, g.wood)) {          // квадрат разорван - забыть
                delete data.groups[key]
                changed = true
                continue
            }
            var need = Math.max(1, Math.floor(BT_DAYS[g.wood] * BT_SHARE))
            if (today - g.day < need) continue
            if (btGrow(level, g)) {
                btLog("выросло вековое дерево " + g.wood + " у " + g.x + " " + g.y + " " + g.z)
                delete data.groups[key]
            } else {
                g.day = today - need + 1                             // повтор через сутки
                btLog("вековому " + g.wood + " у " + g.x + " " + g.y + " " + g.z + " негде встать, жду сутки")
            }
            changed = true
        }
        if (changed) btSave()
    } catch (e) { btLog("рост: " + e) }
})
