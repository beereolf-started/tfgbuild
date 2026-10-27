// priority: -8
"use strict";
/**
 * ГРАВИРОВКА (этап 5 плана NPC: Downloads/TFG-NPC-план.md). Стол гравёра - блок мода tfgui
 * (tfgui:engraving_table), окно надписи - там же (EngraveScreen); всё остальное здесь.
 *
 *   - Рецепт: любой стол Macaw's + зубило + линза на верстаке.
 *   - Щелчок по столу с металлической вещью в руке - окно: имя (в название: «Меч «Гроза Мортиса»»)
 *     и надпись (в подсказку). Без мода у игрока - команда /tfgengrave имя | надпись у стола.
 *   - Гравировка хранится в NBT tfg_engraving { name, text, by, day, lines, named, owner, v, memorial }.
 *     Гравированная вещь у скупщика дороже (trade_goods.js -> TFG_ENGRAVE.value).
 *   - Памятные вещи жителей (родовой меч правителя, клинки воинов, кольца знати, отцовские ножи) -
 *     в их сундуках, один раз на поселение (settlers.js -> TFG_ENGRAVE.place). На этапе 4 их прячут в тайники.
 *   - Житель узнаёт гравированную вещь в руке игрока: свою - требует вернуть, соседскую - стыдит,
 *     чужую - хвалит работу («Узнаёшь эту вещь?» в окне разговора). Реплики постоянные - озвучены.
 */

const EN_MAX_NAME = 24
const EN_MAX_TEXT = 60
const EN_LORE_WIDTH = 34
const EN_REACH = 6                    // дальше от стола - резец не достаёт
const EN_YEAR = 1023
const EN_METAL = /(copper|bronze|iron|steel|gold|silver|brass|tin|zinc|bismuth|nickel|alumin|titanium|tungsten|platinum|chrome|cobalt|vanadium|lead|invar|electrum|netherite|damascus|osmium|iridium|naquadah|neutronium|sterling)/
const EN_SOFT = /(leather|wool|cloth|straw|gambeson|fur|hood|linen|silk|wood|wooden|stone|flint|bone)/
const EN_ARMORY = ["magistuarmory", "tacz"]           // латы Epic Knights и стволы - металл, хоть в имени его нет

const EN_CompoundTag = Java.loadClass("net.minecraft.nbt.CompoundTag")
const EN_ListTag = Java.loadClass("net.minecraft.nbt.ListTag")
const EN_StringTag = Java.loadClass("net.minecraft.nbt.StringTag")

var EN_SESS = {}                      // uuid игрока -> { x, y, z, dim, slot, id }

function enLog(msg) { try { global.tfgLog("tfg engrave", msg) } catch (e) { } }
function enErr(what, e) { try { global.tfgLogError("tfg engrave", what, e) } catch (err) { console.error("[tfg engrave] " + what + ": " + e) } }

// ─── Что можно гравировать ───────────────────────────────────────────────────

function enEngravable(stack) {
    if (!stack || stack.isEmpty() || stack.getMaxStackSize() > 1) return false
    var id = String(stack.id)
    var ns = id.split(":")[0]
    var tag = stack.getTag()
    var all = id + " " + (tag ? String(tag.toString()) : "")
    if (EN_ARMORY.indexOf(ns) >= 0) return !EN_SOFT.test(id) || EN_METAL.test(id)
    if (!EN_METAL.test(all)) return false
    // кожаное с медной пряжкой и деревянное с железной оковкой - не металл
    return !EN_SOFT.test(id.split(":")[1]) || EN_METAL.test(id)
}

/** Гравировка вещи или null. */
function enInfo(stack) {
    try {
        if (!stack || stack.isEmpty()) return null
        var tag = stack.getTag()
        if (!tag || !tag.contains("tfg_engraving")) return null
        var c = tag.getCompound("tfg_engraving")
        return { name: String(c.getString("name")), text: String(c.getString("text")), by: String(c.getString("by")),
            day: Number(c.getInt("day")), year: Number(c.getInt("year")) || EN_YEAR, lines: Number(c.getInt("lines")),
            named: c.getBoolean("named"), owner: String(c.getString("owner")), v: String(c.getString("v")), memorial: c.getBoolean("memorial") }
    } catch (e) { return null }
}

function enBaseName(stack) {
    try { return String(stack.getItem().getName(stack).getString()) } catch (e) { return String(stack.id) }
}

/** Убрать из текста игрока цвета, кавычки-ёлочки и лишние пробелы. */
function enClean(s, max) {
    return String(s || "").replace(/§./g, "").replace(/[«»"\\\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().substring(0, max)
}

function enWrap(text, width) {
    var words = String(text).split(" "), out = [], cur = ""
    words.forEach(w => {
        if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w }
        else cur = cur ? cur + " " + w : w
    })
    if (cur) out.push(cur)
    return out
}

// ─── Нанести гравировку ──────────────────────────────────────────────────────

/** g: { name, text, by, year, owner, v, memorial }. Прежняя гравировка сбивается. */
function enApply(stack, g) {
    var tag = stack.getOrCreateTag()
    var old = enInfo(stack)
    var disp = tag.contains("display") ? tag.getCompound("display") : new EN_CompoundTag()
    // старые строки гравировки - первые в подсказке; имя снимаем, только если его ставила гравировка
    var lore = disp.contains("Lore") ? disp.getList("Lore", 8) : new EN_ListTag()
    if (old) for (var i = 0; i < old.lines && lore.size() > 0; i++) lore.remove(0)
    if (old && old.named) disp.remove("Name")

    var lines = []
    if (g.text) enWrap("«" + g.text + "»", EN_LORE_WIDTH).forEach(l => lines.push(JSON.stringify({ text: l, color: "gold", italic: true })))
    lines.push(JSON.stringify({ text: "резьба: " + g.by + ", " + (g.year || EN_YEAR) + " г.", color: "dark_gray", italic: true }))
    for (var j = lines.length - 1; j >= 0; j--) lore.add(0, EN_StringTag.valueOf(lines[j]))
    disp.put("Lore", lore)
    var named = !!g.name
    if (named) disp.putString("Name", JSON.stringify({ text: enBaseName(stack) + " «" + g.name + "»", color: "gold", italic: false }))
    tag.put("display", disp)

    var c = new EN_CompoundTag()
    c.putString("name", g.name || "")
    c.putString("text", g.text || "")
    c.putString("by", g.by || "")
    c.putInt("year", g.year || EN_YEAR)
    c.putInt("day", g.day || 0)
    c.putInt("lines", lines.length)
    c.putBoolean("named", named)
    if (g.owner) c.putString("owner", g.owner)
    if (g.v) c.putString("v", g.v)
    if (g.memorial) c.putBoolean("memorial", true)
    tag.put("tfg_engraving", c)
    return stack
}

// ─── Стол ────────────────────────────────────────────────────────────────────

function enOpen(player, pos) {
    var st = player.mainHandItem
    if (!st || st.isEmpty()) { player.setStatusMessage(Text.of("§eВозьми в руку металлическую вещь - и к столу.")); return }
    if (!enEngravable(st)) { player.setStatusMessage(Text.of("§eРезец берёт только металл: оружие, латы, инструмент, украшения.")); return }
    EN_SESS[String(player.uuid)] = { x: pos.x, y: pos.y, z: pos.z, dim: String(player.level.getDimension()),
        slot: Number(player.inventory.selected), id: String(st.id) }
    var old = enInfo(st) || {}
    if (global.TFG_UI.has(player)) {
        global.TFG_UI.open(player, { type: "engrave", item: global.TFG_UI.stackNbt(st), base: enBaseName(st),
            name: old.name || "", text: old.text || "", maxName: EN_MAX_NAME, maxText: EN_MAX_TEXT })
        return
    }
    player.tell(Text.of("§6Стол гравёра. §7Напиши: §f/tfgengrave имя | надпись §7(имя - до " + EN_MAX_NAME +
        " знаков, надпись - до " + EN_MAX_TEXT + "; любую часть можно оставить пустой)."))
}

/** Проверить, что игрок у стола и держит ту же вещь; вернуть её или текст ошибки. */
function enCheck(player) {
    var s = EN_SESS[String(player.uuid)]
    if (!s) return "Сначала подойди к столу гравёра."
    if (String(player.level.getDimension()) !== s.dim) return "Стол остался в другом мире."
    var d2 = Math.pow(player.x - s.x - 0.5, 2) + Math.pow(player.y - s.y, 2) + Math.pow(player.z - s.z - 0.5, 2)
    if (d2 > EN_REACH * EN_REACH) return "Слишком далеко от стола."
    if (String(player.level.getBlock(s.x, s.y, s.z).id) !== "tfgui:engraving_table") return "Стола больше нет."
    var st = player.mainHandItem
    if (Number(player.inventory.selected) !== s.slot || !st || String(st.id) !== s.id) return "Вещь надо держать в руке."
    if (!enEngravable(st)) return "Резец эту вещь не берёт."
    return st
}

function enDo(player, rawName, rawText) {
    var st = enCheck(player)
    if (typeof st === "string") return st
    var name = enClean(rawName, EN_MAX_NAME), text = enClean(rawText, EN_MAX_TEXT)
    if (!name && !text) return "Нечего гравировать."
    enApply(st, { name: name, text: text, by: String(player.username), day: Math.floor(Number(player.level.getTime()) / 24000) })
    try { player.inventoryMenu.broadcastChanges() } catch (e) { }
    var s = EN_SESS[String(player.uuid)]
    try {
        player.server.runCommandSilent("execute in " + s.dim + " run playsound minecraft:ui.cartography_table.take_result block @a " +
            (s.x + 0.5) + " " + (s.y + 1) + " " + (s.z + 0.5) + " 1 0.8")
    } catch (e) { }
    delete EN_SESS[String(player.uuid)]
    enLog(player.username + " выгравировал на " + st.id + ": " + name + " / " + text)
    return null
}

BlockEvents.rightClicked("tfgui:engraving_table", event => {
    if (String(event.hand) !== "MAIN_HAND") return
    try { if (!event.player.level.isClientSide()) enOpen(event.player, event.block.pos) } catch (e) { enErr("стол", e) }
    event.cancel()
})

global.TFG_UI.on("engrave", (player, a) => {
    if (a.a === "close") { delete EN_SESS[String(player.uuid)]; return }
    if (a.a !== "do") return
    var err = enDo(player, a.name, a.text)
    if (err) return global.TFG_UI.update(player, { error: err })
    global.TFG_UI.update(player, { close: "engrave" })
    player.setStatusMessage(Text.of("§6Готово. Резьба легла ровно."))
})

ServerEvents.commandRegistry(event => {
    var Commands = event.commands, Arguments = event.arguments
    event.register(Commands.literal("tfgengrave")
        .then(Commands.argument("text", Arguments.GREEDY_STRING.create(event)).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var raw = String(Arguments.GREEDY_STRING.getResult(ctx, "text"))
            var parts = raw.split("|")
            var err = enDo(p, parts[0], parts.slice(1).join("|"))
            if (err) { ctx.source.sendFailure(Text.of(err)); return 0 }
            ctx.source.sendSuccess(Text.of("§6Готово. Резьба легла ровно."), false)
            return 1
        })))
})

// ─── Рецепт стола ────────────────────────────────────────────────────────────

ServerEvents.tags("item", event => {
    event.add("tfg:mcw_tables", /^mcw_tfc_aio:furniture\/.*_table$/)
})

ServerEvents.recipes(event => {
    event.shapeless("tfgui:engraving_table", ["#tfg:mcw_tables", "#tfc:chisels", "tfc:lens"]).id("tfg:engraving_table")
})

// ─── Памятные вещи жителей ───────────────────────────────────────────────────

const EN_BLADE_NAMES = {
    alliance: ["Белый зуб", "Страж стены", "Слово Альвина", "Агнец"],
    ash: ["Пепельный", "Дитя жерла", "Последний жар", "Сын Аша"],
    marvins: ["Тихий", "Шёпот", "Ночная игла", "Жало Марва"],
    wind: ["Попутный", "Ветер Вейи", "Облачный", "Небесный"],
}
const EN_BLADE_COMMON = ["Верный", "Последний довод", "Честь дома", "Гроза разбойников"]
const EN_BLADE_TEXT = ["{n} - за стойкость у Медного брода", "Дан {n} в день присяги", "Умри с ним в руке - сядешь за Пир",
    "{n}. Стоять, когда другие бегут", "Кто поднимет его на своих - тому Отмель"]
const EN_RULER_TEXT = ["От первого правителя - каждому следующему", "Меч дома {n}. Держит, кто правит"]
const EN_JEWEL_TEXT = ["{r} от {n} - в день свадьбы", "Памяти матери", "Род {n} помнит", "{n}. Нить к нити, узел к узлу"]
const EN_KNIFE_TEXT = ["Отцовский нож. Не продавать", "{n}. Чтобы не потерял", "Сыну от отца", "Режь хлеб, а не людей"]
const EN_JEWELS = ["tfgui:jewel/ring/gold", "tfgui:jewel/ring/silver", "tfgui:jewel/bracelet/gold", "tfgui:jewel/bracelet/sterling_silver",
    "tfgui:jewel/brooch/silver", "tfgui:jewel/ring/rose_gold"]

function enPick(a) { return a[Math.floor(Math.random() * a.length)] }

function enExists(id) { try { return global.TFG_STRUCTURES.exists(id) } catch (e) { return false } }

/** Памятная вещь жителя (ItemStack) или null. */
function enHeirloom(v, s) {
    var estate = global.TFG_SETTLERS.estateOf(s)
    var kin = null
    try {
        var l = rlLinks(v, s.id).filter(x => x.type === "spouse" || x.type === "kin")[0]
        if (l) kin = v.settlers.filter(x => x.id === l.other)[0]
    } catch (e) { }
    var fill = t => t.replace("{n}", s.name).replace("{r}", kin ? kin.name : "Любимой")
    var stack = null, name = "", text = ""
    if (s.role === "правитель" || estate === "военные") {
        if (s.role !== "правитель" && Math.random() > 0.4) return null
        try { stack = global.TFG_STRUCTURES.tool("@меч") } catch (e) { }
        name = s.role === "правитель" ? "Меч основателя" : enPick((EN_BLADE_NAMES[v.faction] || []).concat(EN_BLADE_COMMON))
        text = fill(enPick(s.role === "правитель" ? EN_RULER_TEXT : EN_BLADE_TEXT))
    } else if (estate === "знать") {
        if (Math.random() > 0.5) return null
        var ids = EN_JEWELS.filter(enExists)
        if (ids.length) stack = Item.of(enPick(ids))
        name = kin ? "Обручальное" : "Родовое"
        text = fill(enPick(kin ? EN_JEWEL_TEXT : EN_JEWEL_TEXT.slice(1)))
    } else {
        if (Math.random() > 0.15) return null
        try { stack = global.TFG_STRUCTURES.tool("@нож") } catch (e) { }
        name = "Отцовский"
        text = fill(enPick(EN_KNIFE_TEXT))
    }
    if (!stack || stack.isEmpty()) return null
    return enApply(stack, { name: name, text: text, by: s.name, year: EN_YEAR - 1 - Math.floor(Math.random() * 40),
        owner: s.id, v: v.id, memorial: true })
}

function enPlace(level, v) {
    var n = 0
    v.settlers.forEach(s => {
        if (s.dead || !s.chest) return
        try {
            var st = enHeirloom(v, s)
            if (st && lbInsert(level, s.chest, st)) n++
        } catch (e) { enErr("памятная вещь " + s.name, e) }
    })
    enLog("поселение " + v.id + ": памятных вещей в сундуки " + n)
    return n
}

// ─── Житель узнаёт вещь ──────────────────────────────────────────────────────

const EN_MINE = ["Это же моё! Откуда это у тебя?", "Моя вещь! Ты рылся в моём сундуке?"]
const EN_NEIGHBOUR = ["Я знаю эту вещь. Она не твоя, и ты это знаешь.", "Это вещь нашего соседа. Как она к тебе попала?"]
const EN_FOE = ["Ха, у него и это увели? Поделом.", "Его вещица. Не отдавай ему, пусть помучается."]
const EN_DEAD = ["Это вещь покойного. Береги её - память всё-таки."]
const EN_OWN_WORK = ["Сам резал? Рука твёрдая.", "Твоя работа? Неплохо для чужака."]
const EN_PRAISE = {
    "знать": ["Тонкая работа. Такую и королю не стыдно показать.", "Хорошая резьба. Мастер знал своё дело."],
    "военные": ["Надпись на клинке - в бою вспомнишь, за что дерёшься.", "Именная вещь. С такой не бегут."],
    "простолюдины": ["Красиво вырезано. Мне бы такое и не по карману.", "Ишь ты, с надписью. Богато."],
}
const EN_RETURN_THANKS = "Спасибо, что вернул. Не всякий бы так."
const EN_KEEP = "Вор! Я это запомню."
const EN_BOUGHT = "Купил, говоришь? Ну... раз купил."
const EN_NOTHING = "Так где же она? Нет у тебя ничего в руках."

function enHeld(player) {
    try { var st = player.mainHandItem; var g = enInfo(st); return g ? { g: g, stack: st } : null } catch (e) { return null }
}

function enTalk(ctx) {
    var w = tkWho(ctx)
    if (!w) return dlgSay(ctx, "Вещь как вещь.")
    if (rlTier(w.op.value) === 0) return dlgSay(ctx, gsPick(TK_REFUSE))
    var held = enHeld(ctx.player)
    if (!held) return dlgSay(ctx, EN_NOTHING)
    var g = held.g
    if (g.memorial && g.v === w.v.id) {
        var owner = w.v.settlers.filter(x => x.id === g.owner)[0]
        if (owner && owner.id === w.s.id) {
            rlNote(w.v, ctx.player, w.s.id, -8, "держит мою вещь")
            dlgSay(ctx, gsPick(EN_MINE))
            return dlgChoice(ctx, null, [
                { label: "Возвращаю", hint: "Отдать вещь хозяину - он это оценит", run: c => {
                    var now = enHeld(c.player)
                    if (!now || now.g.owner !== g.owner || now.g.v !== g.v) return dlgSay(c, EN_NOTHING)
                    now.stack.shrink(1)
                    rlNote(w.v, c.player, w.s.id, 15, "вернул памятную вещь")
                    dlgSay(c, EN_RETURN_THANKS)
                } },
                { label: "Купил у торговца", hint: "Может, и поверит", run: c => { rlNote(w.v, c.player, w.s.id, 4, "сказал, что купил"); dlgSay(c, EN_BOUGHT) } },
                { label: "Теперь она моя", hint: "Оставить себе. Он этого не простит", run: c => { rlNote(w.v, c.player, w.s.id, -10, "не вернул вещь"); dlgSay(c, EN_KEEP) } },
            ])
        }
        if (owner && owner.dead) return dlgSay(ctx, gsPick(EN_DEAD))
        if (owner) {
            var link = rlLinks(w.v, w.s.id).filter(l => l.other === owner.id)[0]
            if (link && link.mine < -30) return dlgSay(ctx, gsPick(EN_FOE))
            rlNote(w.v, ctx.player, w.s.id, link && link.mine > 30 ? -5 : -2, "держит вещь соседа")
            return dlgSay(ctx, gsPick(EN_NEIGHBOUR))
        }
    }
    if (g.by && g.by === String(ctx.player.username)) return dlgSay(ctx, gsPick(EN_OWN_WORK))
    dlgSay(ctx, gsPick(EN_PRAISE[global.TFG_SETTLERS.estateOf(w.s)] || EN_PRAISE["простолюдины"]))
}

;(() => {
    if (typeof DLG_NPC_OPTIONS === "undefined") return
    var show = ctx => {
        try { return ctx.trader.getTags().contains("tfg_settler") && !!enHeld(ctx.player) } catch (e) { return false }
    }
    var opt = { id: "en_item", label: () => "Узнаёшь эту вещь?", hint: () => "Показать гравированную вещь из руки.", show: show, run: ctx => enTalk(ctx) }
    ;[DLG_NPC_OPTIONS, typeof DLG_OPTIONS !== "undefined" ? DLG_OPTIONS : null].forEach(list => {
        if (!list || list.some(x => x.id === opt.id)) return
        var at = list.findIndex(o => o.id === "tb_books")
        if (at < 0) at = list.findIndex(o => o.id === "leave") - 1
        list.splice(at < 0 ? list.length : at + 1, 0, opt)
    })
})()

global.TFG_ENGRAVE = {
    info: stack => enInfo(stack),
    engravable: stack => enEngravable(stack),
    apply: (stack, g) => enApply(stack, g),
    place: (level, v) => enPlace(level, v),
    /** Наценка скупщика: гравированное вдвое дороже, памятное - втрое; без гравировки - как было. */
    value: (stack, base) => { var g = enInfo(stack); return !g ? base : Math.round(Math.max(base, 8) * (g.memorial ? 3 : 2)) },
}
