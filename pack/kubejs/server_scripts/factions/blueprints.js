"use strict";
/**
 * ШАБЛОНЫ ПОСТРОЕК: правка прямо в игре (плоский мир, творческий режим).
 *
 * Рабочий порядок:
 *   /tfgbp new 24 12 24        - расчистить площадку и обозначить углы розовым бетоном;
 *   /tfgbp load дом            - положить сохранённый шаблон и обозначить его границы;
 *   /tfgbp grow восток 3       - подвинуть границу (отрицательное число - сузить);
 *   /tfgbp replace             - блок из левой руки заменить на блок из правой по всей области;
 *   /tfgbp void                - выдать маркер пустоты;
 *   /tfgbp save дом            - сохранить область как шаблон;
 *   /tfgbp list | clear | info
 *
 * ТРИ СОСТОЯНИЯ КЛЕТКИ В ШАБЛОНЕ:
 *   блок            - ставится при генерации;
 *   воздух          - НЕ трогаем: при вставке в мир там останется то, что было (земля, склон, вода);
 *   маркер пустоты  - ставится воздух принудительно: комната внутри холма останется комнатой.
 * Поэтому пустоты внутри дома надо закладывать маркером, а не оставлять воздухом.
 *
 * Хранение: данные сервера. ВАЖНО: строка в NBT не может быть длиннее 65535 байт, а один
 * особняк весит под сотню тысяч. Поэтому каждый шаблон пишется кусками по 20 000 символов
 * в свои ключи (tfg_bp_<слот>_<кусок>), а опись лежит в tfg_bp_index. Раньше всё валилось
 * в один ключ tfg_blueprints - при переполнении он молча становился пустым, и пропадали
 * СРАЗУ ВСЕ шаблоны. Старый ключ читается для совместимости и больше не пишется.
 * Готовые шаблоны из внешнего конвейера приезжают отдельным файлом blueprints_data.js.
 */

var BP_SERVER = null
var BP_STORE = null

const BP_CORNER = "minecraft:pink_concrete"          // углы области
const BP_VOID = "minecraft:magenta_stained_glass"    // маркер обязательной пустоты
const BP_MAX = 200000                                // предел размера области, блоков
const BP_PER_TICK = 60                               // команд заливки за тик

const BP_SIDES = {
    "север": [0, 0, -1], "юг": [0, 0, 1], "запад": [-1, 0, 0], "восток": [1, 0, 0],
    "вверх": [0, 1, 0], "вниз": [0, -1, 0],
    "north": [0, 0, -1], "south": [0, 0, 1], "west": [-1, 0, 0], "east": [1, 0, 0],
    "up": [0, 1, 0], "down": [0, -1, 0],
}

var BP_QUEUE = []                                    // отложенные команды: [{cmds, i}]

function bpLog(text) { try { console.log("[шаблоны] " + text) } catch (e) { } }
function bpErr(where, e) { try { console.error("[шаблоны] " + where + ": " + e) } catch (err) { } }

const BP_CHUNK = 20000                               // сколько символов кладём в один ключ NBT

function bpLoad() {
    if (BP_STORE) return BP_STORE
    if (!BP_SERVER) return { list: {}, boxes: {} }
    var pd = BP_SERVER.persistentData
    BP_STORE = { list: {}, boxes: {} }

    // старое единое хранилище: читаем, если в нём ещё что-то уцелело
    try {
        var old = pd.contains("tfg_blueprints") ? String(pd.getString("tfg_blueprints")) : ""
        if (old.length > 2) {
            var o = JSON.parse(old)
            if (o.list) for (var k in o.list) BP_STORE.list[k] = o.list[k]
            if (o.boxes) BP_STORE.boxes = o.boxes
            bpLog("забрал шаблоны из старого хранилища: " + Object.keys(BP_STORE.list).length)
        }
    } catch (e) { bpErr("старое хранилище", e) }

    // опись и куски
    try {
        var idxRaw = pd.contains("tfg_bp_index") ? String(pd.getString("tfg_bp_index")) : ""
        if (idxRaw) {
            var idx = JSON.parse(idxRaw)
            if (idx.boxes) BP_STORE.boxes = idx.boxes
            ;(idx.names || []).forEach(rec => {
                var text = ""
                for (var i = 0; i < rec.parts; i++) {
                    var key = "tfg_bp_" + rec.slot + "_" + i
                    text += pd.contains(key) ? String(pd.getString(key)) : ""
                }
                if (text.length !== rec.size) {
                    bpErr("шаблон " + rec.name, "ожидалось " + rec.size + " символов, прочитано " + text.length)
                    return
                }
                try { BP_STORE.list[rec.name] = JSON.parse(text) } catch (e2) { bpErr("разбор " + rec.name, e2) }
            })
        }
    } catch (e) { bpErr("опись шаблонов", e) }
    return BP_STORE
}

/**
 * Запись. Каждый шаблон режется на куски: длинная строка в NBT не помещается, а при
 * переполнении пропадает молча. После записи опись перечитывается для проверки.
 */
function bpSave() {
    if (!BP_SERVER || !BP_STORE) return null
    var pd = BP_SERVER.persistentData
    var idx = { boxes: BP_STORE.boxes, names: [] }
    var slot = 0, failed = null
    for (var name in BP_STORE.list) {
        var text = JSON.stringify(BP_STORE.list[name])
        var parts = Math.ceil(text.length / BP_CHUNK) || 1
        for (var i = 0; i < parts; i++) {
            pd.putString("tfg_bp_" + slot + "_" + i, text.substr(i * BP_CHUNK, BP_CHUNK))
        }
        // проверяем, что записанное читается обратно целиком
        var back = ""
        for (var j = 0; j < parts; j++) {
            var k2 = "tfg_bp_" + slot + "_" + j
            back += pd.contains(k2) ? String(pd.getString(k2)) : ""
        }
        if (back.length !== text.length) failed = name + ": записано " + back.length + " из " + text.length
        idx.names.push({ name: name, slot: slot, parts: parts, size: text.length })
        slot++
    }
    // хвосты от удалённых шаблонов подчищаем, чтобы не копились
    for (var extra = slot; extra < slot + 8; extra++) {
        for (var p2 = 0; p2 < 16; p2++) {
            var kk = "tfg_bp_" + extra + "_" + p2
            try { if (pd.contains(kk)) pd.remove(kk) } catch (e) { }
        }
    }
    pd.putString("tfg_bp_index", JSON.stringify(idx))
    try { if (pd.contains("tfg_blueprints")) pd.remove("tfg_blueprints") } catch (e) { }
    if (failed) bpErr("сохранение", failed)
    return failed
}

function bpRun(cmd) {
    try { return Number(BP_SERVER.runCommandSilent(cmd)) } catch (e) { bpErr("команда", e); return 0 }
}

function bpQueue(cmds) { if (cmds.length) BP_QUEUE.push({ cmds: cmds, i: 0 }) }

function bpBox(player) {
    var box = bpLoad().boxes[String(player.uuid)]
    if (!box) return null
    return box
}

function bpSetBox(player, box) {
    bpLoad().boxes[String(player.uuid)] = box
    bpSave()
}

function bpVolume(b) { return (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1) }

/** Розовые кубы по восьми углам - снаружи области, чтобы не попасть в шаблон. */
function bpMarkCorners(box, on) {
    var st = on ? BP_CORNER : "minecraft:air"
    var xs = [box.x1 - 1, box.x2 + 1], ys = [box.y1 - 1, box.y2 + 1], zs = [box.z1 - 1, box.z2 + 1]
    xs.forEach(x => ys.forEach(y => zs.forEach(z => {
        bpRun("execute in " + box.dim + " run setblock " + x + " " + y + " " + z + " " + st + " replace")
    })))
}

/** Очистить область воздухом - крупными кусками, порциями по тикам. */
function bpClear(box) {
    var cmds = []
    for (var y = box.y1; y <= box.y2; y++) {
        cmds.push("execute in " + box.dim + " run fill " + box.x1 + " " + y + " " + box.z1 + " " +
            box.x2 + " " + y + " " + box.z2 + " minecraft:air replace")
    }
    bpQueue(cmds)
}

// ─── Создание площадки и загрузка шаблона ────────────────────────────────────

function bpNew(player, w, h, d) {
    var box = {
        dim: String(player.level.getDimension()),
        x1: Math.floor(player.getX()) + 2, y1: Math.floor(player.getY()), z1: Math.floor(player.getZ()) + 2,
    }
    box.x2 = box.x1 + Math.max(1, w) - 1
    box.y2 = box.y1 + Math.max(1, h) - 1
    box.z2 = box.z1 + Math.max(1, d) - 1
    if (bpVolume(box) > BP_MAX) return "область больше предела (" + BP_MAX + " блоков)"
    bpClear(box)
    bpMarkCorners(box, true)
    bpSetBox(player, box)
    return null
}

function bpTemplate(name) {
    var store = bpLoad()
    // исправленный готовый шаблон (override) главнее одноимённого своего: сохранённый в мире остался кривым
    try { if (typeof BP_PRESETS !== "undefined" && BP_PRESETS[name] && BP_PRESETS[name].override) return BP_PRESETS[name] } catch (e) { }
    if (store.list[name]) return store.list[name]
    try { if (typeof BP_PRESETS !== "undefined" && BP_PRESETS[name]) return BP_PRESETS[name] } catch (e) { }
    return null
}

function bpNames() {
    var out = []
    var store = bpLoad()
    for (var k in store.list) out.push(k + " (свой)")
    try { for (var p in BP_PRESETS) if (!store.list[p]) out.push(p + " (готовый)") } catch (e) { }
    return out
}

/** Выбросить свой шаблон: черновики вроде "1" в поселении не нужны. */
function bpDelete(name) {
    var store = bpLoad()
    if (!store.list[name]) return "шаблона " + name + " нет среди своих"
    delete store.list[name]
    bpSave()
    bpLog("шаблон " + name + " удалён")
    return null
}

/** Положить шаблон: область расчищается, потом блоки ставятся из палитры. */
function bpPlace(player, name) {
    var tpl = bpTemplate(name)
    if (!tpl) return "нет шаблона " + name
    var size = tpl.size
    var box = {
        dim: String(player.level.getDimension()),
        x1: Math.floor(player.getX()) + 2, y1: Math.floor(player.getY()), z1: Math.floor(player.getZ()) + 2,
    }
    box.x2 = box.x1 + size[0] - 1
    box.y2 = box.y1 + size[1] - 1
    box.z2 = box.z1 + size[2] - 1
    if (bpVolume(box) > BP_MAX) return "шаблон больше предела (" + bpVolume(box) + " блоков)"
    bpClear(box)
    var cmds = []
    var pos = 0
    var sy = size[1], sz = size[2]
    tpl.data.forEach(seg => {
        var idx = seg[0], count = seg[1]
        if (idx >= 0 || idx === -2) {
            var state = idx === -2 ? BP_VOID : tpl.palette[idx]
            for (var k = 0; k < count; k++) {
                var p = pos + k
                var x = box.x1 + Math.floor(p / (sy * sz))
                var rest = p % (sy * sz)
                var y = box.y1 + Math.floor(rest / sz)
                var z = box.z1 + (rest % sz)
                cmds.push("execute in " + box.dim + " run setblock " + x + " " + y + " " + z + " " + state + " replace")
            }
        }
        pos += count
    })
    bpQueue(cmds)
    bpMarkCorners(box, true)
    bpSetBox(player, box)
    return null
}

// ─── Двигать границы ─────────────────────────────────────────────────────────

function bpGrow(player, side, n) {
    var box = bpBox(player)
    if (!box) return "сначала /tfgbp new или /tfgbp load"
    var d = BP_SIDES[String(side).toLowerCase()]
    if (!d) return "сторона: север, юг, запад, восток, вверх, вниз"
    bpMarkCorners(box, false)
    var before = { x1: box.x1, y1: box.y1, z1: box.z1, x2: box.x2, y2: box.y2, z2: box.z2 }
    if (d[0] > 0) box.x2 += n
    if (d[0] < 0) box.x1 -= n
    if (d[1] > 0) box.y2 += n
    if (d[1] < 0) box.y1 -= n
    if (d[2] > 0) box.z2 += n
    if (d[2] < 0) box.z1 -= n
    if (box.x2 < box.x1 || box.y2 < box.y1 || box.z2 < box.z1) {
        box.x1 = before.x1; box.y1 = before.y1; box.z1 = before.z1
        box.x2 = before.x2; box.y2 = before.y2; box.z2 = before.z2
        bpMarkCorners(box, true)
        return "так область схлопнется"
    }
    if (bpVolume(box) > BP_MAX) {
        box.x1 = before.x1; box.y1 = before.y1; box.z1 = before.z1
        box.x2 = before.x2; box.y2 = before.y2; box.z2 = before.z2
        bpMarkCorners(box, true)
        return "область станет больше предела"
    }
    // расширение расчищаем, сужение просто забывает лишнее
    if (n > 0) {
        var add = { dim: box.dim, x1: box.x1, y1: box.y1, z1: box.z1, x2: box.x2, y2: box.y2, z2: box.z2 }
        if (d[0] > 0) add.x1 = before.x2 + 1
        if (d[0] < 0) add.x2 = before.x1 - 1
        if (d[1] > 0) add.y1 = before.y2 + 1
        if (d[1] < 0) add.y2 = before.y1 - 1
        if (d[2] > 0) add.z1 = before.z2 + 1
        if (d[2] < 0) add.z2 = before.z1 - 1
        bpClear(add)
    }
    bpMarkCorners(box, true)
    bpSetBox(player, box)
    return null
}

// ─── Замена вида блока ───────────────────────────────────────────────────────

function bpHandState(stack) {
    if (!stack || stack.isEmpty()) return null
    var id = String(stack.id)
    if (id.indexOf(":") < 0) return null
    return id
}

function bpReplace(player) {
    var box = bpBox(player)
    if (!box) return "сначала /tfgbp new или /tfgbp load"
    var from = bpHandState(player.getOffHandItem())
    var to = bpHandState(player.getMainHandItem())
    if (!from) return "в левой руке должен быть блок, который меняем"
    if (!to) return "в правой руке должен быть блок, на который меняем"
    var res = bpRun("execute in " + box.dim + " run fill " + box.x1 + " " + box.y1 + " " + box.z1 + " " +
        box.x2 + " " + box.y2 + " " + box.z2 + " " + to + " replace " + from)
    return res > 0 ? null : "заменять нечего (или блок не ставится): " + from
}

// ─── Сохранение ──────────────────────────────────────────────────────────────

/** Состояние блока строкой; пустота и маркер пустоты - особые значения. */
function bpStateAt(level, x, y, z) {
    var block = level.getBlock(x, y, z)
    var id = String(block.id)
    if (id === BP_VOID) return -2                       // обязательная пустота
    if (id === "minecraft:air" || id === "minecraft:cave_air") return -1   // не трогать при вставке
    if (id === BP_CORNER) return -1
    try {
        var s = String(block.getBlockState())
        var m = s.match(/Block\{([^}]+)\}(?:\[(.*)\])?/)
        if (m) return m[2] ? m[1] + "[" + m[2] + "]" : m[1]
    } catch (e) { }
    return id
}

/** Манекены и рамки внутри области: их шаблон тоже должен помнить. */
function bpEntities(player, box) {
    var out = []
    try {
        var list = player.level.getEntities(player, new RAID_AABBClass(box.x1, box.y1, box.z1,
            box.x2 + 1, box.y2 + 1, box.z2 + 1))
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            var type = String(e.type)
            if (type !== "minecraft:armor_stand" && type !== "minecraft:item_frame" &&
                type !== "minecraft:glow_item_frame" && type !== "minecraft:painting") continue
            out.push({
                type: type,
                x: Math.round((e.getX() - box.x1) * 100) / 100,
                y: Math.round((e.getY() - box.y1) * 100) / 100,
                z: Math.round((e.getZ() - box.z1) * 100) / 100,
                yaw: Math.round(Number(e.getYaw())),
            })
        }
    } catch (err) { bpErr("поиск манекенов", err) }
    return out
}

function bpSaveTemplate(player, name) {
    var box = bpBox(player)
    if (!box) return "сначала /tfgbp new или /tfgbp load"
    var level = player.level
    var pal = [], index = {}, data = []
    var last = -3, run = 0
    var solid = 0, voids = 0
    for (var x = box.x1; x <= box.x2; x++) {
        for (var y = box.y1; y <= box.y2; y++) {
            for (var z = box.z1; z <= box.z2; z++) {
                var st = bpStateAt(level, x, y, z)
                var v
                if (st === -1) v = -1
                else if (st === -2) { v = -2; voids++ }
                else {
                    if (index[st] === undefined) { index[st] = pal.length; pal.push(st) }
                    v = index[st]
                    solid++
                }
                if (v === last) run++
                else {
                    if (run) data.push([last, run])
                    last = v
                    run = 1
                }
            }
        }
    }
    if (run) data.push([last, run])
    var store = bpLoad()
    var ents = bpEntities(player, box)
    store.list[name] = {
        name: name, size: [box.x2 - box.x1 + 1, box.y2 - box.y1 + 1, box.z2 - box.z1 + 1],
        palette: pal, data: data, blocks: solid, voids: voids, entities: ents, saved: Number(level.getTime()),
    }
    var failed = bpSave()
    bpLog("сохранён " + name + ": " + store.list[name].size.join("x") + ", блоков " + solid +
        ", пустот " + voids + ", манекенов и рамок " + ents.length)
    // если запись не прошла, шаблон из памяти убираем: пусть лучше ошибка, чем пустота при перезаходе
    if (failed) {
        delete store.list[name]
        bpSave()
        return "шаблон не записался (" + failed + ") - слишком крупная постройка"
    }
    return null
}

global.TFG_BLUEPRINTS = {
    get: name => bpTemplate(name),
    names: () => bpNames(),
    place: (player, name) => bpPlace(player, name),
}

// ─── Тик: очередь тяжёлых команд ─────────────────────────────────────────────

ServerEvents.tick(event => {
    if (!BP_SERVER) BP_SERVER = event.server
    if (!BP_QUEUE.length) return
    var job = BP_QUEUE[0]
    var n = 0
    while (job.i < job.cmds.length && n < BP_PER_TICK) {
        bpRun(job.cmds[job.i])
        job.i++
        n++
    }
    if (job.i >= job.cmds.length) BP_QUEUE.shift()
})

// ─── Команды ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        // имена шаблонов русские, поэтому берём greedy: обычная строка требует кавычек
        var str = name => Commands.argument(name, Arguments.GREEDY_STRING.create(event))
        var int = name => Commands.argument(name, Arguments.INTEGER.create(event))
        var S = (ctx, name) => String(Arguments.GREEDY_STRING.getResult(ctx, name)).trim()
        var I = (ctx, name) => Number(Arguments.INTEGER.getResult(ctx, name))
        var done = (ctx, err, ok) => {
            if (err) ctx.source.sendFailure(Text.of("§c" + err))
            else ctx.source.sendSuccess(Text.of(ok), false)
            return 1
        }

        event.register(Commands.literal("tfgbp").requires(s => s.hasPermission(2))
            .then(Commands.literal("new").then(int("ширина").then(int("высота").then(int("глубина").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                return done(ctx, bpNew(p, I(ctx, "ширина"), I(ctx, "высота"), I(ctx, "глубина")),
                    "Площадка размечена. Углы - розовый бетон.")
            })))))
            .then(Commands.literal("load").then(str("имя").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var name = S(ctx, "имя")
                return done(ctx, bpPlace(p, name), "Шаблон " + name + " разложен, границы размечены.")
            })))
            .then((function () {
                var node = Commands.literal("grow")
                    ;["север", "юг", "запад", "восток", "вверх", "вниз"].forEach(side => {
                        node.then(Commands.literal(side).then(int("блоков").executes(ctx => {
                            if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                            var p = ctx.source.getPlayerOrException()
                            return done(ctx, bpGrow(p, side, I(ctx, "блоков")), "Граница сдвинута.")
                        })))
                    })
                return node
            })())
            .then(Commands.literal("replace").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                return done(ctx, bpReplace(p), "Заменено.")
            }))
            .then(Commands.literal("void").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                bpRun("give " + p.username + " " + BP_VOID + " 64")
                return done(ctx, null, "Маркер пустоты выдан: им отмечают то, что при вставке должно остаться пустым.")
            }))
            .then(Commands.literal("save").then(str("имя").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var name = S(ctx, "имя")
                var err = bpSaveTemplate(p, name)
                if (err) return done(ctx, err, "")
                var store = bpLoad()
                var size = 0
                try { size = JSON.stringify(store.list[name]).length } catch (e) { }
                return done(ctx, null, "Шаблон " + name + " сохранён (" + Math.round(size / 1024) + " КБ, " +
                    Math.ceil(size / BP_CHUNK) + " кусков).")
            })))
            .then(Commands.literal("info").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var box = bpBox(p)
                if (!box) return done(ctx, "область не задана", "")
                ctx.source.sendSuccess(Text.of("Область " + (box.x2 - box.x1 + 1) + "x" + (box.y2 - box.y1 + 1) + "x" +
                    (box.z2 - box.z1 + 1) + " от " + box.x1 + " " + box.y1 + " " + box.z1 +
                    " до " + box.x2 + " " + box.y2 + " " + box.z2 + ", блоков " + bpVolume(box)), false)
                return 1
            }))
            .then(Commands.literal("delete").then(str("имя").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var name = S(ctx, "имя")
                return done(ctx, bpDelete(name), "Шаблон " + name + " удалён.")
            })))
            .then(Commands.literal("rename").then(str("имя").then(str("новое").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var from = S(ctx, "имя"), to = S(ctx, "новое")
                var store = bpLoad()
                if (!store.list[from]) return done(ctx, "шаблона " + from + " нет среди своих", "")
                store.list[to] = store.list[from]
                store.list[to].name = to
                delete store.list[from]
                bpSave()
                return done(ctx, null, "Шаблон " + from + " теперь называется " + to + ".")
            }))))
            .then(Commands.literal("list").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var names = bpNames()
                ctx.source.sendSuccess(Text.of(names.length ? names.join("\n") : "§7шаблонов нет"), false)
                return 1
            }))
            .then(Commands.literal("clear").executes(ctx => {
                if (!BP_SERVER) BP_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var box = bpBox(p)
                if (box) {
                    bpMarkCorners(box, false)
                    delete bpLoad().boxes[String(p.uuid)]
                    bpSave()
                }
                return done(ctx, null, "Разметка снята.")
            })))
    } catch (err) {
        console.error("[blueprints] ошибка регистрации команд: " + err)
    }
})
