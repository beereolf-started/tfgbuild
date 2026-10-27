"use strict";
/**
 * ВРЕМЕННЫЕ ПОСТРОЙКИ И ОТКАТ (основа стоянок, будущих поселений и уборки мусора).
 *
 * Зона - помеченный параллелепипед. Перед любой стройкой снимаем слепок всех блоков внутри,
 * а по сроку (или по команде) возвращаем всё как было - включая то, что успел натворить игрок.
 * Слепок хранится палитрой с повторами (RLE), возврат идёт командами fill по одинаковым отрезкам,
 * порциями по несколько тысяч блоков за тик, чтобы сервер не проседал.
 *
 * Хранение: JSON в данных сервера (tfg_zones). Блоки с содержимым (сундуки, бочки) пишутся SNBT и
 * восстанавливаются через data merge block.
 * API: global.TFG_ZONES - snapshot, restore, drop, list, build.
 * Команды: /tfgzone (см. низ файла).
 */

var ZONE_SERVER = null
var ZONES = null
var ZONE_QUEUE = []                 // очередь команд отката: [{ zone, cmds, i }]

const ZONE_MAX_BLOCKS = 200000      // больше одной зоной не берём
const ZONE_CMDS_PER_TICK = 40       // сколько команд fill выполняем за тик
const ZONE_NBT_LIMIT = 400          // сколько блоков с содержимым запоминаем на зону

function zoneLog(text) { try { console.log("[зоны] " + text) } catch (e) { } }
function zoneErr(where, e) { try { console.error("[зоны] " + where + ": " + e) } catch (err) { } }

var ZONE_SEQ = 1                    // счётчик для неповторяющихся имён зон

function zoneLoad() {
    if (ZONES) return ZONES
    if (!ZONE_SERVER) return {}
    var pd = ZONE_SERVER.persistentData
    // слепки крупного поселения весят сотни килобайт - читаем кусками (см. store.js)
    try { ZONES = JSON.parse(global.TFG_STORE.read(pd, "tfg_zones") || "{}") } catch (e) { ZONES = {} }
    return ZONES
}

/**
 * Реестр зон - тысячи слепков, мегабайты текста. Раньше он целиком перезаписывался после КАЖДОЙ зоны:
 * стройка поселения (сотня слепков) шла по слепку в секунду, а забыть или откатить тысячу зон разом -
 * значило тысячу полных записей подряд, и сервер вставал. Теперь изменения копятся, а реестр пишется
 * раз в десять секунд (zoneFlush в тике), если что-то поменялось.
 */
var ZONE_DIRTY = false
const ZONE_FLUSH_EVERY = 200          // тиков

function zoneSave() { ZONE_DIRTY = true }

function zoneFlush() {
    if (!ZONE_DIRTY || !ZONE_SERVER || !ZONES) return
    ZONE_DIRTY = false
    var bad = global.TFG_STORE.write(ZONE_SERVER.persistentData, "tfg_zones", JSON.stringify(ZONES))
    // если слепки не записались, постройки станет нечем убирать - об этом надо знать сразу
    if (bad) zoneErr("запись зон", bad)
}

function zoneLevel(dim) {
    try { return ZONE_SERVER.getLevel(dim) || ZONE_SERVER.overworld() } catch (e) { return ZONE_SERVER.overworld() }
}

function zoneBox(x1, y1, z1, x2, y2, z2) {
    return {
        x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2),
        x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2),
    }
}

function zoneVolume(b) { return (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1) }

/** Состояние блока строкой "id[prop=val,...]" - из toString() состояния, иначе просто id. */
function zoneStateOf(block) {
    try {
        var s = String(block.getBlockState())
        var m = s.match(/Block\{([^}]+)\}(?:\[(.*)\])?/)
        if (m) return m[2] ? m[1] + "[" + m[2] + "]" : m[1]
    } catch (e) { }
    try { return String(block.id) } catch (e) { return "minecraft:air" }
}

/** Содержимое блока (сундук, бочка, печь) строкой SNBT; пусто - null. */
function zoneNbtOf(block) {
    try {
        var data = block.entityData
        if (!data) return null
        var s = String(data)
        if (!s || s === "{}" || s.length > 20000) return null
        return s
    } catch (e) { return null }
}

// ─── Слепок ──────────────────────────────────────────────────────────────────

/**
 * Снять слепок параллелепипеда. Возвращает id зоны или строку с ошибкой.
 * opts: label - подпись, ttl - через сколько тиков откатить сам, owner - кому принадлежит.
 */
function zoneSnapshot(level, x1, y1, z1, x2, y2, z2, opts) {
    if (!ZONE_SERVER) ZONE_SERVER = level.getServer()
    var b = zoneBox(Math.floor(x1), Math.floor(y1), Math.floor(z1), Math.floor(x2), Math.floor(y2), Math.floor(z2))
    var vol = zoneVolume(b)
    if (vol > ZONE_MAX_BLOCKS) return "зона слишком большая: " + vol + " блоков (предел " + ZONE_MAX_BLOCKS + ")"
    var pal = []
    var palIndex = {}
    var data = []                    // [индекс палитры, сколько подряд]
    var nbt = []
    var last = -1, run = 0
    for (var x = b.x1; x <= b.x2; x++) {
        for (var y = b.y1; y <= b.y2; y++) {
            for (var z = b.z1; z <= b.z2; z++) {
                var block = level.getBlock(x, y, z)
                var state = zoneStateOf(block)
                var idx = palIndex[state]
                if (idx === undefined) {
                    idx = pal.length
                    pal.push(state)
                    palIndex[state] = idx
                }
                if (idx === last) run++
                else {
                    if (run > 0) data.push([last, run])
                    last = idx
                    run = 1
                }
                if (nbt.length < ZONE_NBT_LIMIT) {
                    var tag = zoneNbtOf(block)
                    if (tag) nbt.push([x, y, z, tag])
                }
            }
        }
    }
    if (run > 0) data.push([last, run])
    var now = Number(level.getTime())
    var zones = zoneLoad()
    // Идентификатор должен быть уникальным: поселение создаёт полсотни зон в один тик,
    // и случайного числа мало - совпадение затирало чужой слепок, а постройка оставалась в мире.
    var id = "z" + now + "_" + (ZONE_SEQ++)
    while (zones[id]) id = "z" + now + "_" + (ZONE_SEQ++)
    zones[id] = {
        id: id, dim: String(level.getDimension()), box: b, pal: pal, data: data, nbt: nbt,
        made: now, until: opts && opts.ttl ? now + opts.ttl : 0,
        label: opts && opts.label ? String(opts.label) : "зона", owner: opts && opts.owner ? String(opts.owner) : null,
    }
    zoneSave()
    zoneLog("слепок " + id + " (" + zones[id].label + "): " + vol + " блоков, палитра " + pal.length + ", отрезков " + data.length)
    return id
}

// ─── Откат ───────────────────────────────────────────────────────────────────

/** Разбор слепка в прямоугольные куски: сначала ряды по z, потом склейка по y и по x. */
function zoneBoxes(z) {
    var b = z.box
    var sizeY = b.y2 - b.y1 + 1
    var sizeZ = b.z2 - b.z1 + 1
    var rows = []
    var pos = 0                     // порядковый номер блока в том же обходе, что и при снятии
    z.data.forEach(seg => {
        var state = z.pal[seg[0]]
        var left = seg[1]
        var p = pos
        while (left > 0) {
            var x = b.x1 + Math.floor(p / (sizeY * sizeZ))
            var rest = p % (sizeY * sizeZ)
            var y = b.y1 + Math.floor(rest / sizeZ)
            var z0 = b.z1 + (rest % sizeZ)
            var run = Math.min(left, sizeZ - (rest % sizeZ))
            rows.push({ s: state, x1: x, x2: x, y1: y, y2: y, z1: z0, z2: z0 + run - 1 })
            p += run
            left -= run
        }
        pos += seg[1]
    })
    // склейка по y: обход идёт x -> y -> z, поэтому одинаковые ряды соседних y лежат рядом
    var byY = []
    rows.forEach(r => {
        var last = byY[byY.length - 1]
        if (last && last.s === r.s && last.x1 === r.x1 && last.z1 === r.z1 && last.z2 === r.z2 && last.y2 + 1 === r.y1) {
            last.y2 = r.y2
            return
        }
        byY.push(r)
    })
    // склейка по x: столбец такой же формы у соседнего x
    var out = []
    var open = []                   // куски предыдущего x, к которым ещё можно приклеиться
    byY.forEach(r => {
        var hit = null
        for (var i = 0; i < open.length; i++) {
            var o = open[i]
            if (o.s === r.s && o.y1 === r.y1 && o.y2 === r.y2 && o.z1 === r.z1 && o.z2 === r.z2 && o.x2 + 1 === r.x1) { hit = o; break }
        }
        if (hit) { hit.x2 = r.x1; return }
        open.push(r)
        out.push(r)
        if (open.length > 4096) open.shift()
    })
    return out
}

/** Команды возврата: крупные fill по кускам, затем содержимое ящиков. */
function zoneRestoreCmds(z) {
    var dim = z.dim
    var cmds = zoneBoxes(z).map(r => "execute in " + dim + " run fill " + r.x1 + " " + r.y1 + " " + r.z1 + " " +
        r.x2 + " " + r.y2 + " " + r.z2 + " " + r.s + " replace")
    ;(z.nbt || []).forEach(n => {
        cmds.push("execute in " + dim + " run data merge block " + n[0] + " " + n[1] + " " + n[2] + " " + n[3])
    })
    return cmds
}

const ZONE_ItemHandlerCap = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").ITEM_HANDLER

/**
 * Перед откатом опустошаем всё, что хранит вещи, и убираем поставленные сущности.
 * Иначе setblock выбрасывает содержимое сундуков на землю, а манекены и рамки остаются висеть.
 */
function zoneSweep(z) {
    var level = zoneLevel(z.dim)
    var b = z.box
    var emptied = 0
    for (var x = b.x1; x <= b.x2; x++) {
        for (var y = b.y1; y <= b.y2; y++) {
            for (var zz = b.z1; zz <= b.z2; zz++) {
                var block, be = null
                try {
                    block = level.getBlock(x, y, zz)
                    if (String(block.id) === "minecraft:air") continue
                    be = block.getEntity()
                } catch (e) { continue }
                if (!be) continue
                var inv = null
                try {
                    var cls = be.getClass()
                    while (cls) {
                        try {
                            var f = cls.getDeclaredField("inventory")
                            f.setAccessible(true)
                            var cand = f.get(be)
                            if (cand && typeof cand.getSlots === "function") { inv = cand; break }
                            break
                        } catch (e2) { cls = cls.getSuperclass() }
                    }
                } catch (e3) { }
                if (!inv) {
                    try {
                        var cap = be.getCapability(ZONE_ItemHandlerCap).resolve()
                        if (cap.isPresent()) inv = cap.get()
                    } catch (e4) { }
                }
                if (!inv) {
                    try {
                        var kinv = block.getInventory()
                        if (kinv && typeof kinv.getSlots === "function") inv = kinv
                    } catch (e5) { }
                }
                if (!inv) continue
                try {
                    var slots = Number(inv.getSlots())
                    for (var i = 0; i < slots; i++) inv.setStackInSlot(i, Item.of("minecraft:air"))
                    be.setChanged()
                    emptied++
                } catch (e6) { }
            }
        }
    }
    // сущности внутри коробки: манекены, рамки, картины и всё, что уже успело выпасть
    ;["minecraft:item", "minecraft:armor_stand", "minecraft:item_frame", "minecraft:glow_item_frame",
        "minecraft:painting", "minecraft:falling_block"].forEach(type => {
            try {
                ZONE_SERVER.runCommandSilent("execute in " + z.dim + " run kill @e[type=" + type +
                    ",x=" + b.x1 + ",y=" + b.y1 + ",z=" + b.z1 +
                    ",dx=" + (b.x2 - b.x1 + 1) + ",dy=" + (b.y2 - b.y1 + 1) + ",dz=" + (b.z2 - b.z1 + 1) + "]")
            } catch (e) { zoneErr("уборка сущностей", e) }
        })
    if (emptied) zoneLog("опустошено хранилищ: " + emptied)
}

/** Поставить зону в очередь отката; выполняется порциями в тике. */
function zoneRestore(id, why) {
    var zones = zoneLoad()
    var z = zones[String(id)]
    if (!z) return "нет зоны " + id
    if (ZONE_QUEUE.some(q => q.zone.id === z.id)) return "зона уже откатывается"
    // Отметка в данных: очередь живёт в памяти, и /reload или перезапуск посреди отката терял её - зона
    // оставалась числиться (место «занято»), а земля - наполовину прежней. После загрузки откат продолжится.
    if (!z.restoring) { z.restoring = String(why || "срок вышел"); z.restoreOrder = Date.now() * 1000 + (ZONE_SEQ++ % 1000); zoneSave() }
    // команды и уборку готовим, когда до зоны дойдёт очередь: откат тысячи зон разом не встанет в один тик
    ZONE_QUEUE.push({ zone: z, cmds: null, i: 0, why: why || "срок вышел" })
    zoneLog("откат " + z.id + " (" + z.label + "): " + (why || "срок вышел"))
    return null
}

function zoneDrop(id) {
    var zones = zoneLoad()
    if (!zones[String(id)]) return "нет зоны " + id
    delete zones[String(id)]
    zoneSave()
    return null
}

function zoneQueueTick() {
    if (!ZONE_QUEUE.length) return
    var job = ZONE_QUEUE[0]
    if (!job.cmds) {
        var b0 = job.zone.box
        try {
            ZONE_SERVER.runCommandSilent("execute in " + job.zone.dim + " run forceload add " + b0.x1 + " " + b0.z1 + " " + b0.x2 + " " + b0.z2)
        } catch (e) { zoneErr("forceload", e) }
        try { zoneSweep(job.zone) } catch (e) { zoneErr("подготовка отката", e) }
        try { job.cmds = zoneRestoreCmds(job.zone) } catch (e) { zoneErr("команды отката", e); job.cmds = [] }
        return                                     // подготовка - уже работа на этот тик
    }
    var n = 0
    while (job.i < job.cmds.length && n < ZONE_CMDS_PER_TICK) {
        // чанк не загружен - откат в нём молча не сработал бы и оставил куски построек: ждём
        // (factions/structures.js сам заказывает прогрузку), но не дольше пятнадцати секунд
        var ready = true
        try { ready = !global.TFG_CHUNK_READY || global.TFG_CHUNK_READY(job.cmds[job.i]) } catch (e) { }
        if (!ready) {
            job.wait = (job.wait || 0) + 1
            if (job.wait < 300) return
            zoneLog("откат " + job.zone.id + ": чанк не загрузился, команда как есть")
        }
        job.wait = 0
        try { ZONE_SERVER.runCommandSilent(job.cmds[job.i]) } catch (e) { zoneErr("откат", e) }
        job.i++
        n++
    }
    if (job.i < job.cmds.length) return
    var b = job.zone.box
    try {
        ZONE_SERVER.runCommandSilent("execute in " + job.zone.dim + " run forceload remove " + b.x1 + " " + b.z1 + " " + b.x2 + " " + b.z2)
    } catch (e) { zoneErr("forceload remove", e) }
    var bb = job.zone.box
    try {
        ZONE_SERVER.runCommandSilent("execute in " + job.zone.dim + " run kill @e[type=minecraft:item,x=" + bb.x1 +
            ",y=" + bb.y1 + ",z=" + bb.z1 + ",dx=" + (bb.x2 - bb.x1 + 1) + ",dy=" + (bb.y2 - bb.y1 + 1) +
            ",dz=" + (bb.z2 - bb.z1 + 1) + "]")
    } catch (e) { }
    var zones = zoneLoad()
    delete zones[job.zone.id]
    zoneSave()
    zoneLog("зона " + job.zone.id + " возвращена как была (" + job.cmds.length + " команд)")
    ZONE_QUEUE.shift()
}

// ─── Стройка внутри зоны ─────────────────────────────────────────────────────

/**
 * Поставить блок в пределах зоны (за границы не пускаем, иначе откат не вернёт).
 * state - "id" или "id[prop=val]".
 */
function zoneSet(z, x, y, z0, state) {
    var b = z.box
    if (x < b.x1 || x > b.x2 || y < b.y1 || y > b.y2 || z0 < b.z1 || z0 > b.z2) return false
    try {
        var res = ZONE_SERVER.runCommandSilent("execute in " + z.dim + " run setblock " + Math.floor(x) + " " + Math.floor(y) + " " +
            Math.floor(z0) + " " + state + " replace")
        return Number(res) > 0            // 0 - блока с таким состоянием нет, пусть зовущий пробует другой
    } catch (e) {
        zoneErr("установка блока", e)
        return false
    }
}

function zoneById(id) { return zoneLoad()[String(id)] || null }

function zoneList() {
    var zones = zoneLoad()
    var out = []
    for (var id in zones) out.push(zones[id])
    return out
}

global.TFG_ZONES = {
    snapshot: (level, x1, y1, z1, x2, y2, z2, opts) => zoneSnapshot(level, x1, y1, z1, x2, y2, z2, opts),
    restore: (id, why) => zoneRestore(id, why),
    drop: id => zoneDrop(id),
    get: id => zoneById(id),
    list: () => zoneList(),
    busy: () => ZONE_QUEUE.length > 0,
    set: (z, x, y, zz, state) => zoneSet(z, x, y, zz, state),
    maxBlocks: ZONE_MAX_BLOCKS,
}

// ─── Тик: сроки и очередь ────────────────────────────────────────────────────

// Очередь откатов живёт только в памяти: перезапуск или /reload посреди отката терял её,
// а прогрузка коробки (forceload) оставалась навсегда. После старта снимаем прогрузку
// со всех зон - откатывать сейчас нечего, держать их загруженными незачем.
var ZONE_RECOVERED = false

function zoneRecover() {
    var zones = zoneLoad()
    var n = 0
    for (var id in zones) {
        var z = zones[id], b = z.box
        if (!b) continue
        try { ZONE_SERVER.runCommandSilent("execute in " + z.dim + " run forceload remove " + b.x1 + " " + b.z1 + " " + b.x2 + " " + b.z2); n++ }
        catch (e) { }
    }
    if (n) zoneLog("после запуска сняты прогрузки зон: " + n)
    // прерванные откаты - в очередь заново, в том же порядке
    var left = []
    for (var id2 in zones) if (zones[id2].restoring) left.push(zones[id2])
    left.sort((a, b) => (a.restoreOrder || 0) - (b.restoreOrder || 0))
    left.forEach(z2 => { try { zoneRestore(z2.id, z2.restoring + " (продолжение после перезагрузки)") } catch (e) { } })
    if (left.length) zoneLog("прерванных откатов продолжено: " + left.length)
}

ServerEvents.tick(event => {
    if (!ZONE_SERVER) ZONE_SERVER = event.server
    if (!ZONE_RECOVERED && !ZONE_QUEUE.length && event.server.tickCount % 20 === 0) {
        ZONE_RECOVERED = true
        try { zoneRecover() } catch (e) { zoneErr("снятие прогрузок", e) }
    }
    try { zoneQueueTick() } catch (e) { zoneErr("очередь", e) }
    if (event.server.tickCount % ZONE_FLUSH_EVERY === 0) { try { zoneFlush() } catch (e) { zoneErr("запись зон", e) } }
    if (event.server.tickCount % 100 !== 0) return
    try {
        var now = Number(event.server.overworld().getTime())
        var zones = zoneLoad()
        for (var id in zones) {
            var z = zones[id]
            if (z.until && now >= z.until) zoneRestore(id, "срок стоянки вышел")
        }
    } catch (e) { zoneErr("сроки", e) }
})

// ─── Команды ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        var intArg = name => Commands.argument(name, Arguments.INTEGER.create(event))
        var num = (ctx, name) => Number(Arguments.INTEGER.getResult(ctx, name))
        var strArg = name => Commands.argument(name, Arguments.STRING.create(event))

        event.register(Commands.literal("tfgzone").requires(s => s.hasPermission(2))
            // /tfgzone here <радиус> <высота> - слепок вокруг себя
            .then(Commands.literal("here").then(intArg("r").then(intArg("h").executes(ctx => {
                if (!ZONE_SERVER) ZONE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var r = Math.max(1, Math.min(64, num(ctx, "r")))
                var h = Math.max(1, Math.min(64, num(ctx, "h")))
                var x = Math.floor(p.getX()), y = Math.floor(p.getY()), z = Math.floor(p.getZ())
                var res = zoneSnapshot(p.level, x - r, y - 2, z - r, x + r, y + h, z + r, { label: "ручная", owner: String(p.uuid) })
                ctx.source.sendSuccess(Text.of(String(res).indexOf("z") === 0 ? "Слепок снят: " + res : "§c" + res), false)
                return 1
            }))))
            // /tfgzone list
            .then(Commands.literal("list").executes(ctx => {
                if (!ZONE_SERVER) ZONE_SERVER = ctx.source.getServer()
                var now = Number(ctx.source.getServer().overworld().getTime())
                var rows = zoneList().map(z => "§f" + z.id + " §7" + z.label + " " + z.box.x1 + " " + z.box.y1 + " " + z.box.z1 +
                    " .. " + z.box.x2 + " " + z.box.y2 + " " + z.box.z2 +
                    (z.until ? ", откат через " + Math.max(0, Math.round((z.until - now) / 20)) + " с" : ", без срока"))
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7зон нет"), false)
                return 1
            }))
            // /tfgzone restore <id> | all
            .then(Commands.literal("restore")
                .then(Commands.literal("all").executes(ctx => {
                    if (!ZONE_SERVER) ZONE_SERVER = ctx.source.getServer()
                    var n = 0
                    zoneList().forEach(z => { if (!zoneRestore(z.id, "команда")) n++ })
                    ctx.source.sendSuccess(Text.of("Откатываю зон: " + n), false)
                    return 1
                }))
                .then(strArg("id").executes(ctx => {
                    if (!ZONE_SERVER) ZONE_SERVER = ctx.source.getServer()
                    var err = zoneRestore(String(Arguments.STRING.getResult(ctx, "id")), "команда")
                    ctx.source.sendSuccess(Text.of(err ? "§c" + err : "Откатываю."), false)
                    return 1
                })))
            // /tfgzone drop <id> - забыть слепок, ничего не возвращая
            .then(Commands.literal("drop").then(strArg("id").executes(ctx => {
                if (!ZONE_SERVER) ZONE_SERVER = ctx.source.getServer()
                var err = zoneDrop(String(Arguments.STRING.getResult(ctx, "id")))
                ctx.source.sendSuccess(Text.of(err ? "§c" + err : "Слепок забыт (постройка останется)."), false)
                return 1
            })))
            // /tfgzone box <x1 y1 z1 x2 y2 z2>
            .then(Commands.literal("box").then(intArg("x1").then(intArg("y1").then(intArg("z1")
                .then(intArg("x2").then(intArg("y2").then(intArg("z2").executes(ctx => {
                    if (!ZONE_SERVER) ZONE_SERVER = ctx.source.getServer()
                    var p = ctx.source.getPlayerOrException()
                    var res = zoneSnapshot(p.level, num(ctx, "x1"), num(ctx, "y1"), num(ctx, "z1"),
                        num(ctx, "x2"), num(ctx, "y2"), num(ctx, "z2"), { label: "ручная", owner: String(p.uuid) })
                    ctx.source.sendSuccess(Text.of(String(res).indexOf("z") === 0 ? "Слепок снят: " + res : "§c" + res), false)
                    return 1
                })))))))))
    } catch (err) {
        console.error("[zones] ошибка регистрации команд: " + err)
    }
})
