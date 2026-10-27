// priority: -6
"use strict";
/**
 * КНИГИ И ДНЕВНИКИ (этап 3 плана NPC: Downloads/TFG-NPC-план.md; список книг: Downloads/TFG-книги-список.md;
 * лор: Downloads/TFG-лор.md).
 *
 * Книга - подписанная книга (minecraft:written_book): название, автор, страницы. Корешок - метка модели
 * (CustomModelData, иконки в kubejs/assets/tfg_books): обычный, тесьма, золочёный, кожа с застёжкой,
 * обгорелый. Ценность - в теге tfg_value (медяки); её берёт скупщик (factions/trade_goods.js, tgBuyPrice).
 *
 * БИБЛИОТЕКА - global.TFG_BOOK_LIBRARY (factions/books_data.js): { id, title, author, spine, value,
 * topic, faction (чей канон или null), heresy (у кого ересь), pages[] }.
 *
 * ДНЕВНИКИ собираются из жизни автора в момент, когда книгу кладут в сундук: события графа отношений
 * (relations.js), его секреты (talk.js; не все), вести округи (записи мира), что сделал игрок ему
 * и его близким, и вера его народа. Даты - от Первого Камня (1023 год).
 *
 * РАСКЛАДКА. Когда поселение прогружено и жителям розданы сундуки (settlers.js), один раз: правителю -
 * дневник всегда, остальным - через раз; знати и военным - 1-2 книги библиотеки по теме и вере, у кого
 * секрет «ересь» - запретная книга чужой церкви. API: global.TFG_BOOKS - make, diary, library, place.
 */

const LB_SPINE = { plain: 1, ribbon: 2, gilded: 3, clasp: 4, burnt: 5 }
const LB_SPINE_RU = { plain: "простой переплёт", ribbon: "с тесьмой", gilded: "золочёный", clasp: "кожа с застёжкой", burnt: "обгорелая" }
const LB_PAGE = 240                 // столько знаков на страницу (книга режется по предложениям)
const LB_YEAR = 1023

function lbLog(msg) { try { global.tfgLog("tfg books", msg) } catch (e) { } }

/** Текст - на страницы: по предложениям, не длиннее LB_PAGE. */
function lbPages(text) {
    var out = [], cur = ""
    // по предложениям (знак конца остаётся при предложении) и по пустым строкам
    String(text).replace(/([.!?…])\s+/g, "$1\u0001").split(/\u0001|\n\n+/).forEach(p => {
        if (!p) return
        if ((cur + " " + p).trim().length > LB_PAGE && cur) { out.push(cur.trim()); cur = "" }
        cur += " " + p
    })
    if (cur.trim()) out.push(cur.trim())
    return out.length ? out : [""]
}

/** Подписанная книга: { title, author, pages[] или text, spine, value }. */
function lbMake(b) {
    var pages = b.pages && b.pages.length ? b.pages : lbPages(b.text || "")
    var spine = LB_SPINE[b.spine] ? b.spine : "plain"
    var lore = ['{"text":"' + LB_SPINE_RU[spine] + '","color":"gray","italic":true}']
    if (b.value) lore.push('{"text":"ценность: ' + Math.round(b.value) + ' медяков","color":"dark_gray","italic":true}')
    var nbt = {
        title: String(b.title).substring(0, 64), author: String(b.author || "неизвестный"), generation: 0, resolved: 1,
        pages: pages.map(p => JSON.stringify({ text: String(p) })),
        CustomModelData: LB_SPINE[spine], tfg_book: String(b.id || "diary"), tfg_value: Math.round(b.value || 0),
        display: { Lore: lore },
    }
    return Item.of("minecraft:written_book", nbt)
}

function lbLibrary() { return global.TFG_BOOK_LIBRARY || [] }

// ─── Дневник ─────────────────────────────────────────────────────────────────

const LB_DIARY_EVENT = {
    "сблизились": ["Всё больше времени вместе, {b} и я. Хорошо, когда есть на кого опереться.", "{b} стал мне близок. Не думал, что так выйдет."],
    "поссорились": ["Повздорили. {b} наговорил лишнего, я тоже хорош.", "Опять ругань, и опять {b}. Сколько можно."],
    "помирились": ["Помирились. {b} первым протянул руку. Худой мир лучше доброй ссоры - так и Самуэль учил.", "Наконец мир, {b} больше не дуется. Будто камень с души."],
    "подрались": ["Сцепились до крови, {b} и я. Стыдно, но уступать не стану.", "Подрались. {b} пусть знает своё место."],
    "одолжил денег": ["Деньги в долг ушли - {b} просил. Посмотрим, вернёт ли.", "{b} просил взаймы - не смог отказать."],
    "вернул долг": ["{b} вернул долг до медяка. Честный человек.", "Долг вернули. Не всё в мире прогнило."],
    "сделал подарок": ["Подарок вручил - безделицу. {b} обрадовался, как ребёнок.", "{b} получил от меня подарок. Пусть помнит доброту."],
    "оскорбил": ["Не сдержался при людях. {b} теперь косо смотрит.", "Высказал всё, что думаю. {b} проглотил. Не жалею."],
    "ухаживает": ["Не выходит из головы {b}. Всевышний, дай сил.", "Снова думаю - всё о том же, {b}. Глупо, а сердцу не прикажешь."],
}
const LB_DIARY_SECRET = ["Никому не скажу, а сюда запишу: я {t}.", "Пусть хоть бумага знает: я {t}.", "Если кто прочтёт - сожги. Я {t}."]
const LB_DIARY_PLAYER_BAD = ["{p} поднял руку на наших. Такое не забывают.", "Видел, что сотворил {p}. Пусть Всевышний рассудит."]
const LB_DIARY_PLAYER_GOOD = ["{p} - честный человек, торговали с ним без обмана.", "Заходил {p}. Побольше бы таких."]
const LB_DIARY_START = ["Начинаю эти записи, чтобы не забыть.", "Пишу, пока рука держит перо.", "Кто-то должен записывать, что здесь творится."]

/** Дневник жителя: книга (ItemStack). */
function lbDiary(level, v, s) {
    // дневник по дням (diaries.js); этот, короткий, - запасной
    try { if (typeof dyDiary === "function") return dyDiary(level, v, s) } catch (e) { lbLog("дневник по дням: " + e) }
    var day = Math.floor(Number(level.getTime()) / 24000)
    var site = null
    try { site = lrSiteOfVillage(v.id) } catch (e) { }
    var name = id => { var o = v.settlers.filter(x => x.id === id)[0]; return o ? o.name : "кто-то" }
    var pick = a => a[Math.floor(Math.random() * a.length)]
    var parts = []
    parts.push("Дневник " + s.name + ". " + (site ? site.name + ", " : "") + "год " + LB_YEAR + " от Первого Камня.")
    parts.push(pick(LB_DIARY_START))
    try {
        var faith = (typeof TK_FAITH !== "undefined" && TK_FAITH[v.faction]) || []
        if (faith.length) parts.push(pick(faith))
    } catch (e) { }
    ;(v.relLog || []).filter(x => x.a === s.id || x.b === s.id).slice(-8).forEach(x => {
        var other = x.a === s.id ? x.b : x.a
        var t = LB_DIARY_EVENT[x.kind]
        if (t) parts.push("День " + (x.day % 360 + 1) + ". " + pick(t).replace("{b}", name(other)))
    })
    try {
        var secrets = tkSecrets(v, s)
        if (secrets.length && Math.random() < 0.7) {
            var sec = secrets[Math.floor(Math.random() * secrets.length)]
            parts.push(pick(LB_DIARY_SECRET).replace("{t}", sec.text))
        }
    } catch (e) { }
    if (site && site.events) site.events.slice(-3).forEach(e => parts.push("В округе толкуют: " + String(e.text) + "."))
    var pm = v.pmem || {}
    for (var uuid in pm) {
        var d = pm[uuid][s.id]
        if (!d) continue
        var pname = "чужак"
        try { var pl = level.getServer().getPlayerList().getPlayer(LB_UUID.fromString(uuid)); if (pl) pname = String(pl.username) } catch (e) { }
        parts.push((d < 0 ? pick(LB_DIARY_PLAYER_BAD) : pick(LB_DIARY_PLAYER_GOOD)).replace("{p}", pname))
    }
    var noble = global.TFG_SETTLERS.estateOf(s) === "знать"
    return lbMake({ id: "diary", title: "Дневник " + s.name, author: s.name, text: parts.join("\n\n"),
        spine: noble ? "clasp" : "plain", value: noble ? 40 : 8 })
}

// ─── Раскладка по сундукам жителей ───────────────────────────────────────────

const LB_UUID = Java.loadClass("java.util.UUID")
const LB_ItemHandler =Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").ITEM_HANDLER

function lbInsert(level, pos, stack) {
    try {
        var be = level.getBlock(pos.x, pos.y, pos.z).getEntity()
        if (!be) return false
        var cap = be.getCapability(LB_ItemHandler).resolve()
        if (!cap.isPresent()) return false
        var h = cap.get()
        for (var i = 0; i < h.getSlots(); i++) {
            if (!h.getStackInSlot(i).isEmpty()) continue
            h.insertItem(i, stack, false)
            return true
        }
    } catch (e) { }
    return false
}

/** Какие книги библиотеки подходят жителю: по сословию (тема) и вере (канон своей церкви, без чужой ереси). */
function lbFor(v, s) {
    var estate = global.TFG_SETTLERS.estateOf(s)
    var topics = estate === "знать" ? ["писание", "история", "астрономия", "натурфилософия", "мифология", "апокалипсис"]
        : estate === "военные" ? ["военное", "история", "мифология", "писание", "апокалипсис"]
        : ["житейское", "писание", "мифология", "апокалипсис"]
    // книги своего народа и своей церкви - только у своих; общие - у всех; чужая ересь - никогда (кроме тайной книги еретика)
    return lbLibrary().filter(b => topics.indexOf(b.topic) >= 0 && (!b.faction || b.faction === v.faction) &&
        (!b.heresy || b.heresy.indexOf(v.faction) < 0))
}

function lbPlace(level, v) {
    var n = 0, diaries = 0
    v.settlers.forEach(s => {
        if (s.dead || !s.chest) return
        if (s.role === "правитель" || Math.random() < 0.5) {
            if (lbInsert(level, s.chest, lbDiary(level, v, s))) { n++; diaries++ }
        }
        var pool = lbFor(v, s)
        var want = global.TFG_SETTLERS.estateOf(s) === "простолюдины" ? (Math.random() < 0.3 ? 1 : 0) : 1 + Math.floor(Math.random() * 2)
        for (var i = 0; i < want && pool.length; i++) {
            var b = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
            if (lbInsert(level, s.chest, lbMake(b))) n++
        }
        // еретик хранит запретную книгу - ту, что его церковь считает ересью
        try {
            if (tkSecrets(v, s).some(x => x.kind === "ересь")) {
                var forbidden = lbLibrary().filter(b => b.heresy && b.heresy.indexOf(v.faction) >= 0)
                if (forbidden.length && lbInsert(level, s.chest, lbMake(forbidden[Math.floor(Math.random() * forbidden.length)]))) n++
            }
        } catch (e) { }
    })
    lbLog("поселение " + v.id + ": книг в сундуки " + n + ", из них дневников " + diaries)
    return n
}

// ─── Книжные полки и хранилища поселений ─────────────────────────────────────

/** Книга для полки: общая или своего народа, без своей ереси; дешёвые чаще дорогих. */
function lbShelfBook(faction) {
    var pool = lbLibrary().filter(b => (!b.faction || b.faction === faction) && (!faction || !b.heresy || b.heresy.indexOf(faction) < 0) &&
        (faction || !b.heresy || !b.heresy.length))
    if (!pool.length) return null
    var a = pool[Math.floor(Math.random() * pool.length)], b2 = pool[Math.floor(Math.random() * pool.length)]
    return lbMake((a.value || 0) <= (b2.value || 0) ? a : b2)
}

/** Поселение, в черте которого точка (или null): там пустые книги меняем на книги мира. */
function lbVillageAt(level, x, z) {
    try {
        var dim = String(level.getDimension()), vs = global.TFG_SETTLERS.list()
        for (var id in vs) {
            var v = vs[id]
            if (v.dim && v.dim !== dim) continue
            if (Math.pow(v.x - x, 2) + Math.pow(v.z - z, 2) < 130 * 130) return v
        }
    } catch (e) { }
    return null
}

/**
 * Старые поселения строились, когда в полки и шкафы клали пустые книги. Когда игрок открывает
 * хранилище в черте поселения, пустые книги в нём становятся книгами мира (по вере хозяев).
 * Вне поселений (база игрока) ничего не трогаем.
 */
BlockEvents.rightClicked(event => {
    try {
        if (String(event.hand) !== "MAIN_HAND") return
        var block = event.block
        if (!block.getEntity()) return
        var level = event.player.level
        var v = lbVillageAt(level, block.x, block.z)
        if (!v) return
        var inv = typeof stInventoryOf === "function" ? stInventoryOf(block) : null
        if (!inv) return
        var n = 0
        for (var i = 0; i < Number(inv.getSlots()); i++) {
            var st = inv.getStackInSlot(i)
            if (!st || st.isEmpty() || String(st.id) !== "minecraft:book") continue
            var book = lbShelfBook(v.faction)
            if (!book) return
            inv.setStackInSlot(i, book)
            n++
        }
        if (n) { try { block.getEntity().setChanged() } catch (e) { } }
    } catch (e) { }
})

global.TFG_BOOKS = {
    shelfBook: faction => lbShelfBook(faction),
    make: b => lbMake(b),
    diary: (level, v, s) => lbDiary(level, v, s),
    library: () => lbLibrary(),
    place: (level, v) => lbPlace(level, v),
    /** Ценность книги из её тегов (0 - не наша книга). */
    valueOf: stack => {
        try { return String(stack.id) === "minecraft:written_book" && stack.nbt && stack.nbt.contains("tfg_value") ? Number(stack.nbt.getInt("tfg_value")) : 0 } catch (e) { return 0 }
    },
}

// Проверка: /tfgbook diary - дневник жителя под прицелом в руки; /tfgbook <номер> - книга библиотеки
ServerEvents.commandRegistry(event => {
    var Commands = event.commands, Arguments = event.arguments
    event.register(Commands.literal("tfgbook").requires(src => src.hasPermission(2))
        .then(Commands.literal("diary").executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var look = p.getLookAngle(), eye = p.getEyePosition()
            var who = null, best = 0.9
            var list = p.level.getEntities(p, p.getBoundingBox().inflate(6))
            for (var i = 0; i < list.size(); i++) {
                var cand = rlSettlerOf(list.get(i))
                if (!cand) continue
                var ce = list.get(i)
                var dx = ce.getX() - Number(eye.x), dy = ce.getY() + 1 - Number(eye.y), dz = ce.getZ() - Number(eye.z)
                var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
                var dot = (dx * Number(look.x) + dy * Number(look.y) + dz * Number(look.z)) / d
                if (dot > best) { best = dot; who = cand }
            }
            if (!who) { ctx.source.sendFailure(Text.of("Наведи прицел на жителя.")); return 1 }
            var s = who.v.settlers.filter(x => x.id === who.sid)[0]
            p.give(lbDiary(p.level, who.v, s))
            return 1
        }))
        .then(Commands.argument("номер", Arguments.INTEGER.create(event)).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var n = Number(Arguments.INTEGER.getResult(ctx, "номер"))
            var b = lbLibrary()[n - 1]
            if (!b) { ctx.source.sendFailure(Text.of("Нет книги №" + n + " (всего " + lbLibrary().length + ").")); return 1 }
            p.give(lbMake(b))
            return 1
        })))
})
