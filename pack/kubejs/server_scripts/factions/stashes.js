// priority: -9
"use strict";
/**
 * КЛАДЫ И ТАЙНИКИ (этап 4 плана NPC: Downloads/TFG-NPC-план.md).
 *
 * КАЗНА ПРАВИТЕЛЯ - землянка в 50-90 блоках от поселения: люк под каменной пирамидкой, лестница, опоры TFC,
 * сундуки с монетами, слитками, самоцветами и золочёной книгой. Пока её ставят, в сундук правителя ложатся
 * «Записи о казне» с координатами. Секрет правителя («казна в землянке») получает направление и шаги.
 * Разграбили - через двое суток землянка откатывается (зона), а правитель прячет новую казну в другом месте.
 *
 * ТАЙНИКИ ЖИТЕЛЕЙ - по их секрету «прячет <что> <где>» (talk.js): «под полом своего дома» - сундук под
 * половицей у кровати; прочее - сундук, закопанный под приметой (валун, пень, пирамидка) в 40-140 блоках.
 * Внутри - то, что сказано в секрете: родовой клинок, кольцо матери, самоцветы, монеты, запретная книга.
 * Разграбленный тайник через двое суток зарастает (откат зоны) и больше не появляется.
 *
 * Ставятся, когда участок прогружен (не раньше: в незагруженном чанке setblock молча не работает).
 * У каждого клада - ссылка в поселении: запись с точными координатами в дневнике хозяина, записка у родни,
 * правителя или в любом сундуке; не легла - клад «на слуху» у всех. Снос поселения откатывает его клады.
 * Жители пересказывают слухи о кладах («Слышал про клады?»), реплики озвучены. /findclad - где что лежит.
 */

const SH_DAY = 24000
const SH_ROLLBACK_DAYS = 2
const SH_TREASURY_R = [800, 1200]         // казна далеко: найти её - достижение
const SH_STASH_R = [40, 140]
const SH_CHECK = 1200                 // раз в минуту смотрим, не разграблено ли

function shLog(msg) { try { global.tfgLog("tfg stash", msg) } catch (e) { } }
function shErr(what, e) { try { global.tfgLogError("tfg stash", what, e) } catch (err) { console.error("[tfg stash] " + what + ": " + e) } }
function shPick(a) { return a[Math.floor(Math.random() * a.length)] }
function shOk(id) { try { return global.TFG_STRUCTURES.exists(id) } catch (e) { return false } }
function shFirst(ids) { for (var i = 0; i < ids.length; i++) if (shOk(ids[i])) return ids[i]; return null }

function shSpot(v, r) {
    var a = Math.random() * 3.141592653589793 * 2, d = r[0] + Math.random() * (r[1] - r[0])
    return { x: Math.floor(v.x + Math.cos(a) * d), z: Math.floor(v.z + Math.sin(a) * d) }
}

function shLoaded(level, x, z) {
    try { return level.hasChunk(x >> 4, z >> 4) && level.hasChunk((x + 4) >> 4, (z + 4) >> 4) && level.hasChunk((x - 4) >> 4, (z - 4) >> 4) } catch (e) { return false }
}

function shSet(level, x, y, z, state) {
    try { level.getServer().runCommandSilent("execute in " + String(level.getDimension()) + " run setblock " + x + " " + y + " " + z + " " + state + " replace") } catch (e) { }
}

/** Вода или лёд под ногами - тайник тут не роют. */
function shWet(level, x, y, z) {
    var id = String(level.getBlock(x, y, z).id)
    return id.indexOf("water") >= 0 || id.indexOf("ice") >= 0 || id.indexOf("lava") >= 0
}

// ─── Что кладём ──────────────────────────────────────────────────────────────

function shCoins(amount) {
    try { return global.TFG_COINS.splitRandom(amount).map(c => Item.of(c.id, c.count)) } catch (e) { return [] }
}

function shGems(n) {
    var ids = ["gtceu:ruby_gem", "gtceu:sapphire_gem", "gtceu:emerald_gem", "gtceu:topaz_gem", "gtceu:amethyst_gem", "gtceu:opal_gem"].filter(shOk)
    var out = []
    for (var i = 0; i < n && ids.length; i++) out.push(Item.of(shPick(ids)))
    return out
}

function shIngots(n) {
    var id = shFirst(Math.random() < 0.5 ? ["gtceu:gold_ingot", "minecraft:gold_ingot"] : ["gtceu:silver_ingot", "gtceu:sterling_silver_ingot", "minecraft:gold_ingot"])
    return id ? [Item.of(id, n)] : []
}

function shNuggets(n) {
    var id = shFirst(["gtceu:gold_nugget", "minecraft:gold_nugget"])
    return id ? [Item.of(id, n)] : []
}

/** Памятная гравированная вещь владельца (engraving.js). */
function shMemento(v, s, tool, jewelIds, name, text) {
    var st = null
    if (tool) { try { st = global.TFG_STRUCTURES.tool(tool) } catch (e) { } }
    else { var ids = jewelIds.filter(shOk); if (ids.length) st = Item.of(shPick(ids)) }
    if (!st || st.isEmpty()) return []
    try {
        global.TFG_ENGRAVE.apply(st, { name: name, text: text.replace("{n}", s.name), by: s.name,
            year: 1023 - 1 - Math.floor(Math.random() * 40), owner: s.id, v: v.id, memorial: true })
    } catch (e) { }
    return [st]
}

/** Содержимое тайника по тому, что сказано в секрете (TK_STASH в talk.js). */
function shStashLoot(v, s, si) {
    switch (si) {
        case 0: return shMemento(v, s, "@меч", null, "Старый товарищ", "{n}. Не для чужих рук")
        case 1: return shNuggets(6 + Math.floor(Math.random() * 10))
        case 2: return shMemento(v, s, null, ["tfgui:jewel/ring/silver", "tfgui:jewel/ring/sterling_silver"], "Кольцо матери", "Памяти матери")
        case 3: return shGems(2)
        case 4: return shMemento(v, s, "@нож", null, "Отцовский", "Сыну от отца")
        case 5: return shCoins(60 + Math.floor(Math.random() * 140))
        case 6: {
            try {
                var forbidden = global.TFG_BOOKS.library().filter(b => b.heresy && b.heresy.indexOf(v.faction) >= 0)
                if (forbidden.length) return [global.TFG_BOOKS.make(shPick(forbidden))]
            } catch (e) { }
            return shCoins(40)
        }
    }
    return shCoins(30)
}

// ─── Казна: добыча ───────────────────────────────────────────────────────────
//
// Найти казну - достижение: в двенадцати ящиках слитки драгоценных металлов, самородки, самоцветы
// (простые, безупречные, изысканные), монеты на тысячи медяков и ювелирка tfgui с камнями.

const SH_PRECIOUS = ["Gold", "Silver", "Platinum", "RoseGold", "SterlingSilver"]
const SH_GEM_MATS = ["Ruby", "Sapphire", "Emerald", "Diamond", "Topaz", "Amethyst", "Opal"]
const SH_JEWEL_KINDS = ["ring", "necklace", "bracelet", "brooch", "earrings", "diadem"]
const SH_JEWEL_METALS = ["gold", "silver", "platinum", "rose_gold", "sterling_silver"]
const SH_JEWEL_GRADES = ["regular", "flawless", "exquisite"]
const SH_JEWEL_GEMS = ["ruby", "sapphire", "emerald", "diamond", "topaz", "amethyst", "opal", "garnet", "malachite", "lazurite"]

function shGt(prefix, mat, n) {
    try { var st = stGtMaterial(prefix, mat, n); return st && !st.isEmpty() ? st : null } catch (e) { return null }
}

/** Украшение tfgui с камнем: перебираем сочетания, пока не попадётся существующее. */
function shJewel() {
    for (var t = 0; t < 24; t++) {
        var id = "tfgui:jewel/" + shPick(SH_JEWEL_KINDS) + "/" + shPick(SH_JEWEL_METALS) + "/" + shPick(SH_JEWEL_GRADES) + "/" + shPick(SH_JEWEL_GEMS)
        if (shOk(id)) return Item.of(id)
    }
    var plain = "tfgui:jewel/" + shPick(SH_JEWEL_KINDS) + "/gold"
    return shOk(plain) ? Item.of(plain) : null
}

function shTreasuryLoot(v) {
    var out = []
    var add = st => { if (st && !st.isEmpty()) out.push(st) }
    shCoins(2000 + Math.floor(Math.random() * 3000)).forEach(add)                      // монеты: 2-5 тысяч медяков
    for (var i = 0; i < 10 + Math.floor(Math.random() * 6); i++) add(shGt("ingot", shPick(SH_PRECIOUS), 4 + Math.floor(Math.random() * 13)))
    for (var j = 0; j < 6; j++) add(shGt("nugget", shPick(SH_PRECIOUS), 16 + Math.floor(Math.random() * 48)))
    for (var k = 0; k < 8; k++) add(shGt("gem", shPick(SH_GEM_MATS), 2 + Math.floor(Math.random() * 6)))
    for (var k2 = 0; k2 < 4; k2++) add(shGt("gemFlawless", shPick(SH_GEM_MATS), 1 + Math.floor(Math.random() * 3)))
    for (var k3 = 0; k3 < 2; k3++) add(shGt("gemExquisite", shPick(SH_GEM_MATS), 1))
    for (var m = 0; m < 6 + Math.floor(Math.random() * 7); m++) add(shJewel())
    try {
        var gilded = global.TFG_BOOKS.library().filter(b => b.spine === "gilded" && (!b.faction || b.faction === v.faction) &&
            (!b.heresy || b.heresy.indexOf(v.faction) < 0))
        if (gilded.length) add(global.TFG_BOOKS.make(shPick(gilded)))
    } catch (e) { }
    // вперемешку: в каждом ящике понемногу всего
    return out.sort(() => Math.random() - 0.5)
}

function shChestState() {
    return shOk("tfc:wood/chest/oak") ? "tfc:wood/chest/oak" : "minecraft:chest"
}

function shFill(level, pos, items) {
    var n = 0
    items.forEach(st => { if (st && !st.isEmpty() && lbInsert(level, pos, st)) n++ })
    return n
}

function shCount(level, pos) {
    try {
        var be = level.getBlock(pos.x, pos.y, pos.z).getEntity()
        if (!be) return 0
        var cap = be.getCapability(LB_ItemHandler).resolve()
        if (!cap.isPresent()) return 0
        var h = cap.get(), n = 0
        for (var i = 0; i < h.getSlots(); i++) if (!h.getStackInSlot(i).isEmpty()) n++
        return n
    } catch (e) { return -1 }
}

// ─── Казна: землянка ─────────────────────────────────────────────────────────

/** Порода дерева землянки: любая из пород TFC, у которой есть доски. */
function shWood() {
    var woods = []
    try { woods = global.TFG_STRUCTURES.woods.slice() } catch (e) { }
    woods = woods.filter(w => shOk("tfc:wood/planks/" + w))
    return woods.length ? shPick(woods) : "oak"
}

/**
 * Вырыть землянку и наполнить; вернуть запись или null (место не годится - попробуем другое).
 * Комната 7x3x7 под землёй, стены и пол из досок, опоры TFC по углам. Люк - вровень с землёй над лазом
 * (высоту берём по столбу самого лаза), рядом каменная пирамидка. Внутри: 12 ящиков с добычей, стол Macaw's
 * с горящими свечами, сундук со стволами TACZ и патронами, две книжные полки с книгами мира, фонарь.
 */
function shBuildTreasury(level, v, spot, force) {
    var x = spot.x, z = spot.z
    var top = stTop(level, x, z)                 // верхний твёрдый блок
    if (!force) for (var dx = -4; dx <= 4; dx += 4) for (var dz = -4; dz <= 4; dz += 4) {
        var tt = stTop(level, x + dx, z + dz)
        if (shWet(level, x + dx, tt, z + dz)) return null
        if (Math.abs(tt - top) > 3) return null                // круча - не роем
    }
    var hx = x + 3, hz = z + 3                   // лаз в юго-восточном углу
    var ht = stTop(level, hx, hz)                // земля над лазом - люк ровно в неё
    var y = Math.min(top, ht) + 1                // первый воздух над землёй
    var floor = y - 8, ceil = y - 3              // пол и потолок; комната - y-7..y-4
    var zone = global.TFG_ZONES.snapshot(level, x - 5, floor - 1, z - 5, x + 5, Math.max(top, ht) + 3, z + 5,
        { label: "казна " + v.id, owner: "мир" })
    if (String(zone).indexOf("z") !== 0) { shErr("слепок казны", zone); return null }
    var wood = shWood()
    var planks = "tfc:wood/planks/" + wood
    var post = shOk("tfc:wood/vertical_support/" + wood) ? "tfc:wood/vertical_support/" + wood : "tfc:wood/log/" + wood + "[axis=y]"
    var beam = shOk("tfc:wood/horizontal_support/" + wood) ? "tfc:wood/horizontal_support/" + wood : null
    var trap = shOk("tfc:wood/planks/" + wood + "_trapdoor") ? "tfc:wood/planks/" + wood + "_trapdoor" : "minecraft:oak_trapdoor"
    // коробка: пол, потолок, стены из досок; внутри пусто
    for (var ix = -4; ix <= 4; ix++) for (var iz = -4; iz <= 4; iz++) {
        var wall = Math.abs(ix) === 4 || Math.abs(iz) === 4
        shSet(level, x + ix, floor, z + iz, planks)
        shSet(level, x + ix, ceil, z + iz, planks)
        for (var iy = floor + 1; iy < ceil; iy++) shSet(level, x + ix, iy, z + iz, wall ? planks : "minecraft:air")
    }
    // опоры по углам комнаты, балки под потолком
    ;[[-3, -3], [-3, 3], [3, -3]].forEach(c => { for (var iy2 = floor + 1; iy2 < ceil; iy2++) shSet(level, x + c[0], iy2, z + c[1], post) })
    if (beam) { for (var bx = -2; bx <= 2; bx += 2) shSet(level, x + bx, ceil - 1, z - 3, beam) }
    // лаз: от люка вровень с землёй до пола, лестница на южной стене (z+4 - доски и земля над ними)
    shSet(level, hx, ht, hz, trap + "[half=top,facing=north,open=false]")
    for (var ly = floor + 1; ly < ht; ly++) {
        shSet(level, hx, ly, hz + 1, ly < ceil ? planks : "tfc:dirt/loam")
        shSet(level, hx, ly, hz, "minecraft:ladder[facing=north]")
    }
    // примета наверху
    shSet(level, hx + 2, ht + 1, hz + 1, "minecraft:mossy_cobblestone")
    shSet(level, hx + 2, ht + 2, hz + 1, "minecraft:cobblestone_wall")
    var fy = floor + 1                           // уровень пола
    // стол Macaw's со свечами посередине
    var table = "mcw_tfc_aio:furniture/" + wood + "_furniture/" + wood + "_table"
    if (!shOk(table)) table = "mcw_tfc_aio:furniture/oak_furniture/oak_table"
    shSet(level, x, fy, z, table)
    shSet(level, x, fy + 1, z, (shOk("tfc:candle") ? "tfc:candle" : "minecraft:candle") + "[candles=3,lit=true]")
    shSet(level, x + 1, fy, z + 2, "minecraft:lantern")
    // книжные полки у северной стены, сундук со стволами между ними
    var shelves = [{ x: x - 2, y: fy, z: z - 3 }, { x: x + 2, y: fy, z: z - 3 }]
    shelves.forEach(c => shSet(level, c.x, c.y, c.z, "minecraft:chiseled_bookshelf[facing=south]"))
    var gunChest = { x: x, y: fy, z: z - 3 }
    shSet(level, gunChest.x, gunChest.y, gunChest.z, shChestState() + "[facing=south]")
    // ящики: западная стена целиком, восточная - кроме угла с лазом
    var crate = shOk("gtceu:wood_crate") ? "gtceu:wood_crate" : shChestState()
    var crates = []
    for (var cz = -3; cz <= 3; cz++) crates.push({ x: x - 3, y: fy, z: z + cz })
    for (var cz2 = -3; cz2 <= 1; cz2++) crates.push({ x: x + 3, y: fy, z: z + cz2 })
    // в углах стоят опоры
    crates = crates.filter(c => !((c.x === x - 3 && (c.z === z - 3 || c.z === z + 3)) || (c.x === x + 3 && c.z === z - 3)))
    crates.forEach(c => shSet(level, c.x, c.y, c.z, crate))
    var loot = shTreasuryLoot(v), put = 0
    loot.forEach((st, i) => { if (lbInsert(level, crates[i % crates.length], st)) put++ })
    // стволы и патроны
    try {
        for (var g = 0; g < 3; g++) { var gun = stGunItem(Math.random() < 0.4); if (gun && lbInsert(level, gunChest, gun)) put++ }
        for (var a = 0; a < 4; a++) { var am = stAmmoItem(); if (am && lbInsert(level, gunChest, am)) put++ }
    } catch (e) { shErr("стволы казны", e) }
    // книги на полки
    shelves.forEach(c => {
        try {
            var inv = stInventoryOf(level.getBlock(c.x, c.y, c.z))
            if (!inv) return
            for (var s = 0; s < 6; s++) {
                var book = global.TFG_BOOKS.shelfBook(v.faction)
                if (book && Math.random() < 0.8) inv.setStackInSlot(s, book)
            }
        } catch (e) { }
    })
    shLog("поселение " + v.id + ": казна у " + x + " " + fy + " " + z + " (" + wood + "), люк " + hx + " " + ht + " " + hz + ", вещей " + put)
    return { x: x, y: fy, z: z, zone: zone, chests: crates.concat([gunChest]), placed: true, at: Number(level.getTime()), v2: true }
}

/**
 * Дописать страницу в дневник жителя (его сундук, книга tfg_book=diary с ним автором). Дневника нет -
 * кладём записку. Дневники пишутся раньше, чем выбирается место клада, - поэтому о кладах в них молчали.
 */
const SH_ListTag = Java.loadClass("net.minecraft.nbt.ListTag")

/** Страницы подписанной книги (JSON-строки). Читаем сырой список - getList с типом молча отдавал пустой. */
function shPagesOf(st) {
    var out = []
    try {
        var raw = st.nbt ? st.nbt.get("pages") : null
        if (raw) for (var j = 0; j < raw.size(); j++) out.push(String(raw.get(j).getAsString()))
    } catch (e) { }
    return out
}

/** Книга base с теми же подписью и переплётом, но страницами pages. */
function shWithPages(base, pages) {
    var copy = base.copy()
    var tag = copy.getOrCreateTag()
    var list = new SH_ListTag()
    pages.forEach(pg => list.add(EN_StringTag.valueOf(pg)))
    tag.put("pages", list)
    return copy
}

/** Записи о кладах, что хранит дневник жителя s (кроме skip) - чтобы переписанный дневник их не потерял. */
function shRefTextsFor(v, s, skip) {
    var out = []
    var mine = r => r && r !== skip && r.ref && r.ref.kind === "дневник" && r.ref.holder === s.name
    if (mine(v.treasury)) out.push(shTreasuryText(v.treasury))
    for (var k in (v.stashes || {})) {
        var r = v.stashes[k], o = v.settlers.filter(x => x.id === k)[0]
        if (mine(r) && o) out.push(shStashText(v, o, r))
    }
    return out
}

/** Полный дневник жителя заново (diaries.js) - страницы и сама книга; null - не вышло. */
function shFreshDiary(level, v, s) {
    try {
        if (typeof dyDiary !== "function") return null
        var b = dyDiary(level, v, s)
        var pg = shPagesOf(b)
        return pg.length > 3 ? { book: b, pages: pg } : null
    } catch (e) { shErr("новый дневник " + s.name, e); return null }
}

/**
 * Дописать страницу в дневник жителя (его сундук, книга tfg_book=diary с ним автором). Дневника нет -
 * кладём записку. Дневники пишутся раньше, чем выбирается место клада, - поэтому о кладах в них молчали.
 * Старые страницы не теряем: прочитать их не вышло или их подозрительно мало (дневник уже испорчен) - пишем
 * дневник заново целиком, с прежними записями о кладах, и дописываем новую. Книгу меняем, только если
 * страниц в ней стало больше.
 */
function shDiaryAppend(level, v, s, text, rec) {
    if (!s || !s.chest) return false
    try {
        var be = level.getBlock(s.chest.x, s.chest.y, s.chest.z).getEntity()
        var h = be ? be.getCapability(LB_ItemHandler).resolve().get() : null
        if (h) for (var i = 0; i < h.getSlots(); i++) {
            var st = h.getStackInSlot(i)
            if (st.isEmpty() || String(st.id) !== "minecraft:written_book" || !st.nbt) continue
            if (String(st.nbt.getString("tfg_book")) !== "diary" || String(st.nbt.getString("author")) !== String(s.name)) continue
            var base = st, old = shPagesOf(st), pages = old.slice()
            if (pages.length <= 3) {
                var fresh = shFreshDiary(level, v, s)
                if (fresh) {
                    base = fresh.book
                    pages = fresh.pages
                    shRefTextsFor(v, s, rec).forEach(t => lbPages(t).forEach(pg => pages.push(JSON.stringify({ text: pg }))))
                    shLog("поселение " + v.id + ": дневник " + s.name + " был без записей (" + old.length + " стр.) - написан заново")
                }
            }
            lbPages(text).forEach(pg => pages.push(JSON.stringify({ text: pg })))
            if (pages.length <= old.length) return false
            var book = shWithPages(base, pages)
            h.extractItem(i, st.getCount(), false)
            h.insertItem(i, book, false)
            return true
        }
    } catch (e) { shErr("дневник " + s.name, e) }
    try {
        return lbInsert(level, s.chest, global.TFG_BOOKS.make({ id: "note", title: "Записка " + s.name, author: s.name, text: text, spine: "plain", value: 5 }))
    } catch (e) { return false }
}

/**
 * Починка: дописывание о казне затирало дневник до одной страницы с координатами. Раз на поселение:
 * у кого в дневнике три страницы и меньше - дневник пишется заново, с записями о его кладах.
 */
function shDiaryRepair(level, v) {
    var n = 0
    v.settlers.forEach(s => {
        if (s.dead || !s.chest) return
        try {
            var be = level.getBlock(s.chest.x, s.chest.y, s.chest.z).getEntity()
            var h = be ? be.getCapability(LB_ItemHandler).resolve().get() : null
            if (!h) return
            for (var i = 0; i < h.getSlots(); i++) {
                var st = h.getStackInSlot(i)
                if (st.isEmpty() || String(st.id) !== "minecraft:written_book" || !st.nbt) continue
                if (String(st.nbt.getString("tfg_book")) !== "diary" || String(st.nbt.getString("author")) !== String(s.name)) continue
                if (shPagesOf(st).length > 3) break
                var fresh = shFreshDiary(level, v, s)
                if (!fresh) break
                var pages = fresh.pages
                shRefTextsFor(v, s, null).forEach(t => lbPages(t).forEach(pg => pages.push(JSON.stringify({ text: pg }))))
                h.extractItem(i, st.getCount(), false)
                h.insertItem(i, shWithPages(fresh.book, pages), false)
                n++
                break
            }
        } catch (e) { shErr("починка дневника " + s.name, e) }
    })
    if (n) shLog("поселение " + v.id + ": починено дневников " + n)
    return n
}

// ─── Ссылка на каждый клад ───────────────────────────────────────────────────
//
// У каждого заложенного клада должна быть ссылка в поселении: запись в дневнике хозяина (точные
// координаты), записка у его родни, у правителя или в любом сундуке поселения. Ни один сундук не
// принял - пробуем снова; после SH_REF_TRIES неудач клад становится «слухом»: о нём расскажет любой
// житель, кто к игроку хотя бы ровно (shRumor). Где лежит ссылка - rec.ref, показывает /findclad.

const SH_REF_TRIES = 5

function shMark(rec) {
    var w = TK_STASH_WHERE[rec.wi] || ""
    return w.indexOf("дуб") >= 0 ? "старый пень" : w.indexOf("камн") >= 0 ? "замшелый валун" : "каменная пирамидка"
}

function shStashText(v, s, rec) {
    if (rec.home) return "Своё добро спрятал под полом, у кровати: " + rec.x + ", " + rec.y + ", " + rec.z + ". Никому не скажу - пусть хоть бумага знает."
    return "Закопал " + TK_STASH[rec.si] + " у " + rec.x + ", " + rec.z + tkStashHint(v, s.id) + " от середины поселения. Над местом - " +
        shMark(rec) + ", сундук под верхним слоем земли."
}

function shTreasuryText(t) {
    return "Казну перенёс в землянку за поселением: " + t.x + ", " + t.z + ". Люк вровень с землёй, рядом каменная пирамидка. Никому."
}

/** Кто может хранить ссылку: сам хозяин, родня и супруг, правитель, любой житель с сундуком. */
function shHolders(v, owner) {
    var out = [], seen = {}
    var add = x => { if (x && !x.dead && x.chest && !seen[x.id]) { seen[x.id] = 1; out.push(x) } }
    add(owner)
    try {
        rlLinks(v, owner.id).filter(l => l.type === "spouse" || l.type === "kin").forEach(l => add(v.settlers.filter(x => x.id === l.other)[0]))
    } catch (e) { }
    add(v.settlers.filter(x => x.role === "правитель" && !x.dead)[0])
    v.settlers.forEach(add)
    return out
}

/** Положить ссылку на клад: { kind, holder, x, y, z } или null (ни один сундук сейчас не принял). */
function shEnsureRef(level, v, owner, text, rec) {
    var hs = shHolders(v, owner)
    for (var i = 0; i < hs.length; i++) {
        var h = hs[i]
        var ok = false
        if (h.id === owner.id) ok = shDiaryAppend(level, v, h, text, rec)
        else {
            try { ok = lbInsert(level, h.chest, global.TFG_BOOKS.make({ id: "note", title: "Записка " + owner.name, author: owner.name, text: text, spine: "plain", value: 5 })) } catch (e) { ok = false }
        }
        if (ok) return { kind: h.id === owner.id ? "дневник" : "записка", holder: h.name, x: h.chest.x, y: h.chest.y, z: h.chest.z }
    }
    return null
}

/** Поставить ссылку кладу rec (казна или тайник), если её нет. true - что-то изменилось. */
function shRefTick(level, v, owner, rec, text, unplaced) {
    if (!rec || (!rec.placed && !unplaced) || rec.ref || rec.rumor || rec.looted || rec.gone) return false
    if (!owner) { rec.rumor = true; return true }
    var ref = shEnsureRef(level, v, owner, text, rec)
    if (ref) { rec.ref = ref; shLog("поселение " + v.id + ": ссылка на клад - " + ref.kind + " у " + ref.holder + " (" + ref.x + " " + ref.y + " " + ref.z + ")"); return true }
    rec.refTries = (rec.refTries || 0) + 1
    if (rec.refTries >= SH_REF_TRIES) { rec.rumor = true; shLog("поселение " + v.id + ": сундуки не приняли записку - клад стал слухом") }
    return true
}

// ─── Тайники жителей ─────────────────────────────────────────────────────────

/** Записи о тайниках: v.stashes[sid] = { si, wi, home, x, z, placed, ... }. */
function shPlan(v) {
    v.stashes = v.stashes || {}
    v.settlers.forEach(s => {
        if (s.dead || v.stashes[s.id]) return
        var sec = null
        try { sec = tkSecrets(v, s).filter(x => x.kind === "тайник")[0] } catch (e) { }
        if (!sec) return
        var home = TK_STASH_WHERE[sec.wi] === "под полом своего дома"
        var rec = { si: sec.si, wi: sec.wi, home: home, placed: false }
        if (home) { if (!s.bed) return; rec.x = s.bed.x; rec.z = s.bed.z }
        else { var sp = shSpot(v, SH_STASH_R); rec.x = sp.x; rec.z = sp.z }
        v.stashes[s.id] = rec
    })
}

/** Примета над закопанным сундуком - по тому, где сказано: валун, пень или пирамидка. */
function shLandmark(level, x, y, z, wi) {
    var where = TK_STASH_WHERE[wi] || ""
    if (where.indexOf("дуб") >= 0) {
        var log = shOk("tfc:wood/log/oak") ? "tfc:wood/log/oak[axis=y]" : "minecraft:oak_log[axis=y]"
        shSet(level, x, y, z, log); shSet(level, x, y + 1, z, log)
    } else if (where.indexOf("камн") >= 0) {
        shSet(level, x, y, z, "minecraft:mossy_cobblestone"); shSet(level, x + 1, y, z, "minecraft:mossy_cobblestone")
        shSet(level, x, y + 1, z, "minecraft:mossy_cobblestone")
    } else {
        shSet(level, x, y, z, "minecraft:cobblestone"); shSet(level, x, y + 1, z, "minecraft:mossy_cobblestone")
        shSet(level, x, y + 2, z, "minecraft:cobblestone_wall")
    }
}

function shBuildStash(level, v, s, rec) {
    var x = rec.x, z = rec.z, y, zone
    if (rec.home) {
        y = s.bed.y - 2                          // под половицей у кровати
        zone = global.TFG_ZONES.snapshot(level, x, y, z, x, y, z, { label: "тайник " + s.name, owner: "мир" })
    } else {
        var top = stTop(level, x, z)
        if (shWet(level, x, top, z)) { var sp = shSpot(v, SH_STASH_R); rec.x = sp.x; rec.z = sp.z; return false }
        y = top - 1                              // сундук под верхним блоком земли
        zone = global.TFG_ZONES.snapshot(level, x - 1, y, z - 1, x + 1, top + 3, z + 1, { label: "тайник " + s.name, owner: "мир" })
    }
    if (String(zone).indexOf("z") !== 0) { shErr("слепок тайника", zone); return false }
    shSet(level, x, y, z, shChestState())
    if (!rec.home) shLandmark(level, x, y + 2, z, rec.wi)
    var n = shFill(level, { x: x, y: y, z: z }, shStashLoot(v, s, rec.si))
    rec.y = y; rec.zone = zone; rec.placed = true; rec.at = Number(level.getTime())
    shLog("поселение " + v.id + ": тайник " + s.name + " у " + x + " " + y + " " + z + " (" + (TK_STASH_WHERE[rec.wi] || "") + "), вещей " + n)
    return true
}

// ─── Ход: заложить, следить, откатить ────────────────────────────────────────

function shNear(level, x, z, r) {
    return sePlayerNear(level, { dim: String(level.getDimension()), x: x, z: z }, r)
}

/**
 * Казна: нет - выбрать место (800-1200 блоков); место прогружено - вырыть; разграблена - откатить через двое
 * суток. Зовётся и из хода поселения, и отдельно (SH_FAR_TICK): у места казны поселение не прогружено.
 */
function shTreasuryTick(level, v) {
    var now = Number(level.getTime())
    var changed = false
    // казна: нет - выбрать место; прогружено - вырыть; разграблена - откатить через двое суток
    var ruler = v.settlers.filter(s => s.role === "правитель" && !s.dead)[0]
    if (ruler && !v.treasury) { var sp = shSpot(v, SH_TREASURY_R); v.treasury = { x: sp.x, z: sp.z, placed: false }; changed = true }
    var t = v.treasury
    // казна старого образца (тесная, под боком у поселения) - откатить; правитель спрячет новую, далеко
    if (t && t.placed && !t.v2 && !t.looted && !shNear(level, t.x, t.z, 48)) {
        try { global.TFG_ZONES.restore(t.zone, "казна переезжает") } catch (e) { shErr("переезд казны", e) }
        shLog("поселение " + v.id + ": казна старого образца убрана - будет новая, в " + SH_TREASURY_R[0] + "-" + SH_TREASURY_R[1] + " блоках")
        v.treasury = null
        t = null
        changed = true
    }
    // Копаем, как только место прогружено, - и при игроке рядом: он пришёл по записи из дневника и стоит тут
    // (раньше ждали, пока отойдёт за 24 блока, и землянка не появлялась). Место не годится (вода, круча) -
    // ищем сухое ровное в 24 блоках от записанной точки; нет такого - копаем прямо в записанной.
    if (t && !t.placed && shLoaded(level, t.x, t.z)) {
        var built = shBuildTreasury(level, v, t, false)
        for (var ring = 8; !built && ring <= 24; ring += 8) {
            for (var ai = 0; ai < 8 && !built; ai++) {
                var aa = ai * 0.7853981633974483
                var cand = { x: Math.floor(t.x + Math.cos(aa) * ring), z: Math.floor(t.z + Math.sin(aa) * ring) }
                if (shLoaded(level, cand.x, cand.z)) built = shBuildTreasury(level, v, cand, false)
            }
        }
        if (!built) built = shBuildTreasury(level, v, t, true)
        if (built) {
            if (t.ref) built.ref = t.ref
            if (t.rumor) built.rumor = t.rumor
            v.treasury = built
            var rl0 = v.settlers.filter(s => s.role === "правитель" && !s.dead)[0]
            if (rl0 && rl0.chest) {
                try {
                    lbInsert(level, rl0.chest, global.TFG_BOOKS.make({ id: "treasury", title: "Записи о казне", author: rl0.name,
                        text: "Записи " + rl0.name + ". Только для того, кто правит после меня.\n\n" + shTreasuryText(built) +
                            "\n\nВ форте держу пустые сундуки - пусть грабители там и ищут.", spine: "clasp", value: 30 }))
                } catch (e) { }
            }
        }
        else t.tries = (t.tries || 0) + 1         // слепок не снялся - попробуем в следующий ход
        changed = true
    } else if (t && t.placed && now % SH_CHECK < 200) {
        if (!t.looted && shLoaded(level, t.x, t.z)) {
            var left = t.chests.reduce((a, c) => a + Math.max(0, shCount(level, c)), 0)
            if (left === 0) { t.looted = true; t.lootedAt = now; changed = true; shLog("поселение " + v.id + ": казна разграблена") }
        }
        if (t.looted && now - t.lootedAt > SH_ROLLBACK_DAYS * SH_DAY && !shNear(level, t.x, t.z, 48)) {
            try { global.TFG_ZONES.restore(t.zone, "казну разграбили") } catch (e) { shErr("откат казны", e) }
            v.treasury = null                    // правитель спрячет новую
            changed = true
        }
    }

    return changed
}

// Отдельный ход для казны: игрок у места казны за тысячу блоков от поселения - поселение не прогружено,
// и его ход не идёт. Раз в десять секунд смотрим все казны, чьё место сейчас прогружено.
ServerEvents.tick(event => {
    if (event.server.tickCount % 200 !== 60) return
    try {
        var level = event.server.overworld()
        var vs = global.TFG_SETTLERS.list(), dirty = false
        for (var id in vs) {
            var v = vs[id], t = v.treasury
            if (!t || typeof t.x !== "number" || typeof t.z !== "number") continue
            if (!shLoaded(level, t.x, t.z)) continue
            if (shTreasuryTick(level, v)) dirty = true
        }
        if (dirty) global.TFG_SETTLERS.save()
    } catch (e) { shErr("ход дальних казён", e) }
})

function shTick(level, v) {
    var now = Number(level.getTime())
    var changed = false
    if (!v.stashesPlanned) { shPlan(v); v.stashesPlanned = true; changed = true }
    if (!v.diaryFix4 && v.booksDone) { shDiaryRepair(level, v); v.diaryFix4 = true; changed = true }
    // Места кладов считались через Math.PI, а в Rhino сервера он не число - координаты выходили NaN (в данных
    // теперь null). Незаложенным кладам с такими координатами выбираем место заново.
    var bad = r => !r || typeof r.x !== "number" || typeof r.z !== "number" || !isFinite(r.x) || !isFinite(r.z)
    if (v.treasury && !v.treasury.placed && bad(v.treasury)) { v.treasury = null; changed = true }
    for (var fk in (v.stashes || {})) {
        var fr = v.stashes[fk]
        if (fr.placed || fr.gone || !bad(fr)) continue
        var fs = v.settlers.filter(x => x.id === fk)[0]
        if (fr.home && fs && fs.bed) { fr.x = fs.bed.x; fr.z = fs.bed.z }
        else { var fsp = shSpot(v, SH_STASH_R); fr.x = fsp.x; fr.z = fsp.z }
        changed = true
    }

    if (shTreasuryTick(level, v)) changed = true

    // ссылка на казну: дневник правителя (или записка у родни, или в любом сундуке)
    // Запись о казне - сразу, как выбрано место: вырыта землянка будет, когда игрок придёт по этим координатам,
    // а без записи он о месте не узнает (раньше ждали вырытой казны - и круг замыкался).
    if (v.treasury && !v.treasury.placed && !v.treasury.refFix && v.treasury.ref) {
        delete v.treasury.ref; v.treasury.refFix = true; v.treasury.recheck = true; changed = true
    }
    if (v.treasury && typeof v.treasury.x === "number" && typeof v.treasury.z === "number") {
        var rl1 = v.settlers.filter(s => s.role === "правитель" && !s.dead)[0] || v.settlers.filter(s => !s.dead)[0]
        var ttext = (v.treasury.recheck ? "Поправка - прежнюю запись не слушай, вот верная. " : v.treasury.moved ? "Перепрятал казну - старое место не годилось. " : "") + shTreasuryText(v.treasury)
        if (shRefTick(level, v, rl1, v.treasury, ttext, true)) changed = true
    }

    // тайники жителей
    var st = v.stashes || {}
    for (var sid in st) {
        var rec = st[sid]
        if (rec.gone) continue
        var s = v.settlers.filter(x => x.id === sid)[0]
        if (!s) { rec.gone = true; changed = true; continue }
        if (!rec.placed) {
            if (shLoaded(level, rec.x, rec.z) && !shNear(level, rec.x, rec.z, 16)) { shBuildStash(level, v, s, rec); changed = true }
            continue
        }
        if (shRefTick(level, v, s, rec, shStashText(v, s, rec))) changed = true
        if (now % SH_CHECK >= 200) continue
        if (!rec.looted && shLoaded(level, rec.x, rec.z) && shCount(level, rec) === 0) { rec.looted = true; rec.lootedAt = now; changed = true }
        if (rec.looted && now - rec.lootedAt > SH_ROLLBACK_DAYS * SH_DAY && !shNear(level, rec.x, rec.z, 32)) {
            try { global.TFG_ZONES.restore(rec.zone, "тайник разорили") } catch (e) { }
            rec.gone = true
            changed = true
        }
    }
    if (changed) { try { global.TFG_SETTLERS.save() } catch (e) { } }
}

// ─── Слухи о кладах ──────────────────────────────────────────────────────────

const SH_RUMOR_NONE = ["Клады? Сказки для детей.", "Не слыхал ни про какие клады.", "Если б я знал, где клад, - сам бы и выкопал."]
const SH_RUMOR_TREASURY = ["Казну наш правитель в форте не держит, это все знают. А где держит - не все.",
    "Говорят, у правителя есть землянка за поселением. Туда он и носит монету."]
const SH_RUMOR_STASH = ["Тут у каждого второго что-нибудь закопано. Время такое.", "Кто-то из наших прячет добро за поселением, сам видел, как ночью уходил с лопатой."]
const SH_RUMOR_LEAD = ["Знаю я, где она. Только тебе и скажу.", "Есть тут один, кого мне не жалко. Слушай."]
const SH_RUMOR_HINT = ["Только я тебе ничего не говорил.", "Найдёшь - мне долю. Шучу. Или нет."]
const SH_RUMOR_LOOTED = ["Казну-то нашу разорили! Правитель ходит чернее тучи.", "Слыхал? Чей-то тайник за поселением разрыли. Не ты ли?"]

function shRumor(ctx) {
    var w = tkWho(ctx)
    if (!w) return dlgSay(ctx, gsPick(SH_RUMOR_NONE))
    var tier = rlTier(w.op.value)
    if (tier === 0) return dlgSay(ctx, gsPick(TK_REFUSE))
    var v = w.v
    if ((v.treasury && v.treasury.looted) || Object.keys(v.stashes || {}).some(k => v.stashes[k].looted && !v.stashes[k].gone))
        return dlgSay(ctx, gsPick(SH_RUMOR_LOOTED))
    if (tier <= 1) return dlgSay(ctx, gsPick(SH_RUMOR_NONE))
    // клад, на который нет записки, - на слуху у всех: расскажет любой, кто к игроку хотя бы ровно
    var heard = []
    if (v.treasury && v.treasury.rumor && v.treasury.placed && !v.treasury.looted) heard.push("казна правителя - в землянке у " + v.treasury.x + ", " + v.treasury.z + ", люк у каменной пирамидки")
    for (var hk in (v.stashes || {})) {
        var hr = v.stashes[hk]
        if (hr.rumor && hr.placed && !hr.looted && !hr.gone) heard.push(tkName(v, hk) + " закопал добро у " + hr.x + ", " + hr.z + ", под приметой: " + shMark(hr))
    }
    if (heard.length) {
        dlgSay(ctx, gsPick(SH_RUMOR_LEAD))
        dlgNote(ctx, "Шепчет: " + heard[Math.floor(Math.random() * heard.length)] + ".")
        return dlgSay(ctx, gsPick(SH_RUMOR_HINT))
    }
    var loose = tkLoose(v, w.s)
    // о казне: знать и военные знают, что она за поселением; где именно - выдаст лишь тот, кто не любит правителя
    var ruler = v.settlers.filter(s => s.role === "правитель" && !s.dead && s.id !== w.s.id)[0]
    if (ruler && v.treasury && v.treasury.placed && Math.random() < 0.5) {
        dlgSay(ctx, gsPick(SH_RUMOR_TREASURY))
        var link = rlLinks(v, w.s.id).filter(l => l.other === ruler.id)[0]
        if ((link && link.mine < -30 && tier >= 3) || (tier >= 4 && loose > 0.6)) {
            dlgSay(ctx, "Знаю я, где она. Только тебе и скажу.")
            dlgNote(ctx, "Шепчет: ищи" + tkStashHint(v, "treasury").replace(" - ", " ") + ", люк у каменной пирамидки.")
            dlgSay(ctx, gsPick(SH_RUMOR_HINT))
        }
        return
    }
    // о тайниках соседей: выдаёт тайник того, кого недолюбливает, если доверяет игроку
    var foes = rlLinks(v, w.s.id).filter(l => l.mine < -30 && v.stashes && v.stashes[l.other] && v.stashes[l.other].placed &&
        !v.stashes[l.other].looted && !v.stashes[l.other].gone)
    dlgSay(ctx, gsPick(SH_RUMOR_STASH))
    if (foes.length && tier >= 3 && loose > 0.3) {
        var who = v.settlers.filter(s => s.id === foes[0].other)[0]
        var rec = v.stashes[foes[0].other]
        dlgSay(ctx, "Есть тут один, кого мне не жалко. Слушай.")
        dlgNote(ctx, "Шепчет: " + who.name + " " + (rec.home ? "прячет добро под полом у своей кровати." : "закопал что-то" + tkStashHint(v, who.id).replace(" - ", " ") + ", под приметой."))
        dlgSay(ctx, gsPick(SH_RUMOR_HINT))
    }
}

;(() => {
    if (typeof DLG_NPC_OPTIONS === "undefined") return
    var isSettler = ctx => { try { return ctx.trader.getTags().contains("tfg_settler") } catch (e) { return false } }
    var opt = { id: "sh_rumor", label: () => "Слышал про клады?", hint: () => "Слухи о казне и тайниках. Кто не любит соседа - может и выдать.",
        show: isSettler, run: ctx => shRumor(ctx) }
    ;[DLG_NPC_OPTIONS, typeof DLG_OPTIONS !== "undefined" ? DLG_OPTIONS : null].forEach(list => {
        if (!list || list.some(x => x.id === opt.id)) return
        var at = list.findIndex(o => o.id === "tk_place")
        if (at < 0) at = list.findIndex(o => o.id === "leave") - 1
        list.splice(at < 0 ? list.length : at + 1, 0, opt)
    })
})()

// ─── /findclad - где клады (оператор) ────────────────────────────────────────
//
//   /findclad                  - клады ближайшего поселения (до 500 блоков)
//   /findclad <радиус>         - клады всех поселений в радиусе
//   /findclad all              - сводка по всем поселениям: сколько кладов, лежат, без ссылки
//   /findclad orphans          - ничьи клады: зоны казны и тайников, чьих поселений больше нет
//   /findclad orphans restore  - откатить ничьи клады (землянки и сундуки исчезнут)

function shState(r) {
    return !r.placed ? "§8не заложен" : r.gone ? "§8исчез" : r.looted ? "§cразграблен" : "§aлежит"
}

function shRefLine(r) {
    if (r.ref) return "§7ссылка: " + r.ref.kind + " у " + r.ref.holder + ", сундук " + r.ref.x + " " + r.ref.y + " " + r.ref.z
    if (r.rumor) return "§7ссылка: слух (расскажет любой житель)"
    return r.placed && !r.looted && !r.gone ? "§eссылка ещё не положена" : ""
}

function shDescribe(p, v) {
    var site = null
    try { site = lrSiteOfVillage(v.id) } catch (e) { }
    var d = Math.round(Math.sqrt(Math.pow(v.x - p.x, 2) + Math.pow(v.z - p.z, 2)))
    p.tell(Text.of("§6" + (site ? site.name : v.id) + " §7(" + v.id + ", " + d + " бл.): сундуки " + (v.chestsDone ? "да" : "нет") +
        ", книги " + (v.booksDone ? "да" : "нет") + ", памятные " + (v.heirloomsDone ? "да" : "нет") + ", клады " + (v.stashesPlanned ? "да" : "нет")))
    var rl = v.settlers.filter(x => x.role === "правитель" && !x.dead)[0]
    if (rl) p.tell(Text.of("§7  правитель " + rl.name + ", сундук " + (rl.chest ? rl.chest.x + " " + rl.chest.y + " " + rl.chest.z : "§cнет")))
    var t = v.treasury
    if (t) p.tell(Text.of("§6  Казна§7: " + t.x + " " + (t.y || "?") + " " + t.z + " " + shState(t) + " " + shRefLine(t)))
    else p.tell(Text.of("§7  Казна: ещё не выбрана"))
    var st = v.stashes || {}
    for (var sid in st) {
        var r = st[sid], s = v.settlers.filter(x => x.id === sid)[0]
        p.tell(Text.of("§e  Тайник§7 " + (s ? s.name : sid) + " (" + (TK_STASH_WHERE[r.wi] || "") + "): " + r.x + " " + (r.y || "?") + " " + r.z +
            " " + shState(r) + " " + shRefLine(r)))
    }
}

function shOrphans() {
    var used = {}, vs = global.TFG_SETTLERS.list()
    for (var id in vs) {
        var v = vs[id]
        if (v.treasury && v.treasury.zone) used[v.treasury.zone] = 1
        for (var k in (v.stashes || {})) if (v.stashes[k].zone) used[v.stashes[k].zone] = 1
    }
    return global.TFG_ZONES.list().filter(z => /^(казна |тайник )/.test(String(z.label)) && !used[z.id])
}

ServerEvents.commandRegistry(event => {
    var Commands = event.commands, Arguments = event.arguments
    var near = (ctx, radius) => {
        var p = ctx.source.getPlayerOrException()
        var vs = global.TFG_SETTLERS.list(), list = []
        for (var id in vs) {
            var d = Math.sqrt(Math.pow(vs[id].x - p.x, 2) + Math.pow(vs[id].z - p.z, 2))
            if (d <= radius) list.push({ v: vs[id], d: d })
        }
        list.sort((a, b) => a.d - b.d)
        if (!list.length) { ctx.source.sendFailure(Text.of("В " + radius + " блоках поселений нет")); return 0 }
        ;(radius === 500 ? list.slice(0, 1) : list).forEach(x => shDescribe(p, x.v))
        return 1
    }
    event.register(Commands.literal("findclad").requires(src => src.hasPermission(2))
        .executes(ctx => near(ctx, 500))
        .then(Commands.argument("radius", Arguments.INTEGER.create(event)).executes(ctx => near(ctx, Math.max(1, Number(Arguments.INTEGER.getResult(ctx, "radius"))))))
        .then(Commands.literal("all").executes(ctx => {
            var p = ctx.source.getPlayerOrException(), vs = global.TFG_SETTLERS.list(), tot = { n: 0, lie: 0, noref: 0 }
            for (var id in vs) {
                var v = vs[id], recs = [v.treasury].concat(Object.keys(v.stashes || {}).map(k => v.stashes[k])).filter(r => !!r)
                var lie = recs.filter(r => r.placed && !r.looted && !r.gone)
                var noref = lie.filter(r => !r.ref && !r.rumor)
                tot.n += recs.length; tot.lie += lie.length; tot.noref += noref.length
                if (recs.length) p.tell(Text.of("§7" + id + ": кладов " + recs.length + ", лежат " + lie.length + (noref.length ? ", §eбез ссылки " + noref.length : "")))
            }
            p.tell(Text.of("§6Всего кладов " + tot.n + ", лежат " + tot.lie + ", без ссылки " + tot.noref))
            return 1
        }))
        .then(Commands.literal("orphans")
            .executes(ctx => {
                var o = shOrphans()
                ctx.source.sendSuccess(Text.of("Ничьих кладов: " + o.length + o.slice(0, 20).map(z => "\n " + z.label + " " + z.box.x1 + " " + z.box.y1 + " " + z.box.z1).join("")), false)
                return 1
            })
            .then(Commands.literal("restore").executes(ctx => {
                var o = shOrphans()
                o.forEach(z => { try { global.TFG_ZONES.restore(z.id, "ничей клад") } catch (e) { } })
                ctx.source.sendSuccess(Text.of("Ничьих кладов откатывается: " + o.length), false)
                return 1
            }))))
})

global.TFG_STASH = {
    tick: (level, v) => { try { shTick(level, v) } catch (e) { shErr("ход", e) } },
}
